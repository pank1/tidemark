import { execFile } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { Logger, nullLogger, redact } from './log';
import { credentialsFile, files, tidemarkDir } from './paths';
import { StoredCredentials } from './types';

const run = promisify(execFile);

/** Service name the macOS client stores its credentials under. */
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

export type CredStoreKind = 'file' | 'keychain' | 'none';

export interface CredStoreInfo {
  kind: CredStoreKind;
  /** Human-readable location, safe to show in Doctor. */
  location: string;
}

export interface CredentialStoreOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  logger?: Logger;
}

/**
 * Reads and writes the credentials Claude Code itself uses. Every write is
 * atomic and preceded by a backup (D-05) because a half-written credentials
 * file signs the user out of a tool they were mid-task in.
 */
export class CredentialStore {
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly log: Logger;

  constructor(options: CredentialStoreOptions = {}) {
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.log = options.logger ?? nullLogger;
  }

  get file(): string {
    return credentialsFile(this.env);
  }

  async describe(): Promise<CredStoreInfo> {
    if (await exists(this.file)) return { kind: 'file', location: this.file };
    if (this.platform === 'darwin' && (await this.keychainRead()) !== undefined) {
      return { kind: 'keychain', location: `login keychain · ${KEYCHAIN_SERVICE}` };
    }
    return { kind: 'none', location: this.file };
  }

  async read(): Promise<StoredCredentials | undefined> {
    const fromFile = await this.fileRead();
    if (fromFile) return fromFile;
    if (this.platform === 'darwin') return this.keychainRead();
    return undefined;
  }

  async write(credentials: StoredCredentials): Promise<void> {
    assertCredentials(credentials);
    const where = await this.describe();
    await this.backup();
    if (where.kind === 'keychain') {
      await this.keychainWrite(credentials);
      return;
    }
    await this.fileWrite(credentials);
  }

  /**
   * Copies the current credentials aside. Returns the backup path, or undefined
   * when there was nothing to copy.
   */
  async backup(): Promise<string | undefined> {
    const current = await this.read();
    if (!current) return undefined;
    const dir = files.backups(this.env);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(dir, `credentials-${stamp}.json`);
    await writeFileAtomic(target, JSON.stringify(current, null, 2));
    await this.pruneBackups(dir);
    return target;
  }

  private async pruneBackups(dir: string, keep = 10): Promise<void> {
    try {
      const entries = (await fs.readdir(dir))
        .filter((name) => name.startsWith('credentials-'))
        .sort()
        .reverse();
      for (const stale of entries.slice(keep)) {
        await fs.rm(path.join(dir, stale), { force: true });
      }
    } catch (error) {
      this.log.debug(`backup prune skipped: ${redact(error)}`);
    }
  }

  private async fileRead(): Promise<StoredCredentials | undefined> {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as StoredCredentials;
      assertCredentials(parsed);
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        this.log.debug(`credentials file unreadable: ${redact(error)}`);
      }
      return undefined;
    }
  }

  private async fileWrite(credentials: StoredCredentials): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await writeFileAtomic(this.file, JSON.stringify(credentials, null, 2));
  }

  private async keychainRead(): Promise<StoredCredentials | undefined> {
    try {
      const { stdout } = await run(
        '/usr/bin/security',
        ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', os.userInfo().username, '-w'],
        { timeout: 10_000 },
      );
      const parsed = JSON.parse(stdout.trim()) as StoredCredentials;
      assertCredentials(parsed);
      return parsed;
    } catch {
      return undefined;
    }
  }

  private async keychainWrite(credentials: StoredCredentials): Promise<void> {
    // `security` has no way to take a secret on stdin, so the JSON is passed as
    // an argument. It is visible to `ps` on this machine for the lifetime of the
    // call; there is no alternative short of a native keychain binding, and the
    // official client does the same thing.
    await run(
      '/usr/bin/security',
      [
        'add-generic-password',
        '-U',
        '-s',
        KEYCHAIN_SERVICE,
        '-a',
        os.userInfo().username,
        '-w',
        JSON.stringify(credentials),
      ],
      { timeout: 10_000 },
    );
  }
}

export function assertCredentials(value: unknown): asserts value is StoredCredentials {
  const oauth = (value as StoredCredentials | undefined)?.claudeAiOauth;
  if (!oauth || typeof oauth !== 'object') {
    throw new Error('Not a Claude credentials object: missing claudeAiOauth.');
  }
  if (typeof oauth.accessToken !== 'string' || oauth.accessToken.length < 8) {
    throw new Error('Not a Claude credentials object: missing accessToken.');
  }
}

export function accessTokenExpired(credentials: StoredCredentials, skewMs = 60_000): boolean {
  const expiresAt = credentials.claudeAiOauth.expiresAt;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return false;
  return Date.now() + skewMs >= expiresAt;
}

export function refreshTokenExpired(credentials: StoredCredentials): boolean {
  const expiresAt = credentials.claudeAiOauth.refreshTokenExpiresAt;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return false;
  return Date.now() >= expiresAt;
}

/** True when two credential blobs name the same login. */
export function sameLogin(a: StoredCredentials, b: StoredCredentials): boolean {
  return a.claudeAiOauth.refreshToken === b.claudeAiOauth.refreshToken;
}

export async function writeFileAtomic(target: string, contents: string): Promise<void> {
  const dir = path.dirname(target);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const temporary = path.join(dir, `.${path.basename(target)}.${crypto.randomUUID()}.tmp`);
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, target);
  await fs.chmod(target, 0o600).catch(() => undefined);
}

export async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export function ensureTidemarkDir(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const dir = tidemarkDir(env);
  return fs.mkdir(dir, { recursive: true, mode: 0o700 }).then(() => dir);
}
