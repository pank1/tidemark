import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { Logger, nullLogger, redact } from './log';

const run = promisify(execFile);

export type GitErrorKind = 'no-git' | 'no-remote' | 'offline' | 'auth' | 'conflict' | 'other';

export class GitError extends Error {
  constructor(
    readonly kind: GitErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'GitError';
  }

  get display(): string {
    switch (this.kind) {
      case 'no-git':
        return 'git is not installed, so sync is unavailable.';
      case 'no-remote':
        return 'No sync repository is configured.';
      case 'offline':
        return 'Could not reach the sync repository.';
      case 'auth':
        return 'The sync repository refused these credentials. Check your SSH key or token.';
      case 'conflict':
        return 'The sync repository moved while writing; it will retry.';
      default:
        return this.message;
    }
  }
}

export interface GitSyncOptions {
  dir: string;
  remote: string;
  branch: string;
  logger?: Logger;
  timeoutMs?: number;
}

export interface GitStatus {
  present: boolean;
  remote: string;
  branch: string;
  lastCommit?: string;
  lastCommitAt?: string;
  dirty: boolean;
}

/**
 * A tiny git wrapper over a private clone that holds one encrypted bundle plus
 * per-machine presence files.
 *
 * Conflicts are never resolved by git: before writing we read the remote copy
 * and merge at the payload level, so the only git-level retries are races on
 * push (D-24 in TICKETS, hazard R5).
 */
export class GitSync {
  private readonly log: Logger;
  private readonly timeoutMs: number;

  constructor(private readonly options: GitSyncOptions) {
    this.log = options.logger ?? nullLogger;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  get dir(): string {
    return this.options.dir;
  }

  get branch(): string {
    return this.options.branch || 'main';
  }

  async ensureAvailable(): Promise<void> {
    if (!this.options.remote?.trim()) {
      throw new GitError('no-remote', 'No sync repository configured.');
    }
    try {
      await run('git', ['--version'], { timeout: 10_000 });
    } catch {
      throw new GitError('no-git', 'git was not found on PATH.');
    }
  }

  /** Clones if the directory is empty, otherwise makes sure the remote matches. */
  async ensureRepo(): Promise<void> {
    await this.ensureAvailable();
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const isRepo = await this.isRepo();
    if (!isRepo) {
      const entries = await fs.readdir(this.dir);
      if (entries.length === 0) {
        try {
          await this.git(['clone', '--branch', this.branch, this.options.remote, '.'], {
            allowFailure: true,
          });
        } catch {
          /* falls through to init below for an empty remote */
        }
      }
      if (!(await this.isRepo())) {
        await this.git(['init', '-b', this.branch]);
        await this.git(['remote', 'add', 'origin', this.options.remote], { allowFailure: true });
      }
    }
    await this.git(['remote', 'set-url', 'origin', this.options.remote], { allowFailure: true });
    await this.git(['config', 'user.name', 'Tidemark'], { allowFailure: true });
    await this.git(['config', 'user.email', 'tidemark@localhost'], { allowFailure: true });
    await this.git(['config', 'commit.gpgsign', 'false'], { allowFailure: true });
  }

  async fetch(): Promise<boolean> {
    try {
      await this.git(['fetch', '--prune', 'origin', this.branch]);
      return true;
    } catch (error) {
      throw this.classify(error);
    }
  }

  /** Contents of a file on the remote branch, or undefined when it is absent. */
  async showRemote(relativePath: string): Promise<string | undefined> {
    try {
      const { stdout } = await this.git(['show', `origin/${this.branch}:${relativePath}`]);
      return stdout;
    } catch {
      return undefined;
    }
  }

  async readLocal(relativePath: string): Promise<string | undefined> {
    try {
      return await fs.readFile(path.join(this.dir, relativePath), 'utf8');
    } catch {
      return undefined;
    }
  }

  async writeLocal(relativePath: string, contents: string): Promise<void> {
    const target = path.join(this.dir, relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, contents, { encoding: 'utf8', mode: 0o600 });
  }

  /**
   * Commits whatever is staged-worthy and pushes, rebasing onto the remote once
   * if someone else pushed in between.
   */
  async commitAndPush(message: string, attempts = 2): Promise<{ pushed: boolean; detail: string }> {
    await this.git(['add', '-A']);
    const status = await this.git(['status', '--porcelain']);
    if (!status.stdout.trim()) return { pushed: false, detail: 'nothing to push' };
    await this.git(['commit', '-m', message]);

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await this.git(['push', 'origin', `HEAD:${this.branch}`]);
        return { pushed: true, detail: message };
      } catch (error) {
        const classified = this.classify(error);
        if (classified.kind === 'auth' || classified.kind === 'offline' || attempt === attempts) {
          throw classified;
        }
        this.log.info('push rejected; rebasing onto the remote and retrying');
        await this.git(['fetch', 'origin', this.branch], { allowFailure: true });
        await this.git(['rebase', `origin/${this.branch}`], { allowFailure: true });
      }
    }
    return { pushed: false, detail: 'push failed' };
  }

  /** Moves the working tree onto the remote tip, keeping a copy of local work. */
  async hardSyncToRemote(): Promise<void> {
    await this.fetch();
    await this.git(['reset', '--hard', `origin/${this.branch}`], { allowFailure: true });
  }

  async status(): Promise<GitStatus> {
    const base: GitStatus = {
      present: await this.isRepo(),
      remote: this.options.remote,
      branch: this.branch,
      dirty: false,
    };
    if (!base.present) return base;
    const [log, dirty] = await Promise.all([
      this.git(['log', '-1', '--format=%h|%cI'], { allowFailure: true }),
      this.git(['status', '--porcelain'], { allowFailure: true }),
    ]);
    const [hash, when] = (log.stdout || '').trim().split('|');
    return {
      ...base,
      lastCommit: hash || undefined,
      lastCommitAt: when || undefined,
      dirty: Boolean(dirty.stdout.trim()),
    };
  }

  private async isRepo(): Promise<boolean> {
    try {
      await fs.access(path.join(this.dir, '.git'));
      return true;
    } catch {
      return false;
    }
  }

  private async git(
    args: string[],
    options: { allowFailure?: boolean } = {},
  ): Promise<{ stdout: string; stderr: string }> {
    try {
      const result = await run('git', args, {
        cwd: this.dir,
        timeout: this.timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_ASKPASS: 'echo',
          // Keep an interactive SSH passphrase prompt from hanging the host.
          SSH_ASKPASS: 'echo',
          GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
        },
      });
      return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    } catch (error) {
      if (options.allowFailure) {
        this.log.debug(`git ${args[0]} failed (ignored): ${redact(error)}`);
        return { stdout: '', stderr: '' };
      }
      throw error;
    }
  }

  private classify(error: unknown): GitError {
    const text = redact(error).toLowerCase();
    if (/could not resolve host|network is unreachable|connection timed out|timed out/.test(text)) {
      return new GitError('offline', redact(error));
    }
    if (/permission denied|authentication failed|access denied|publickey/.test(text)) {
      return new GitError('auth', redact(error));
    }
    if (/non-fast-forward|rejected|failed to push/.test(text)) {
      return new GitError('conflict', redact(error));
    }
    if (/not a git repository/.test(text)) {
      return new GitError('other', redact(error));
    }
    return new GitError('other', redact(error));
  }
}
