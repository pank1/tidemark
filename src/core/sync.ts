import { BUNDLE_PAYLOAD_VERSION, BundlePayload, mergeProfiles, parseBundle, serializeBundle } from './bundle';
import { BundleError, decryptBundle, encryptBundle } from './crypto';
import { GitError, GitSync } from './git';
import { Logger, nullLogger, redact } from './log';
import { files } from './paths';
import { Presence, describePresence } from './presence';
import { ProfileStore } from './profiles';
import { PresenceEntry } from './types';

export const BUNDLE_FILE = 'accounts.tdmk';

export class LockedError extends Error {
  constructor() {
    super('Tidemark is locked. Enter your sync passphrase to continue.');
    this.name = 'LockedError';
  }
}

export interface SyncSettings {
  enabled: boolean;
  repository: string;
  branch: string;
  autoPush: boolean;
  pullIntervalMinutes: number;
}

export interface SyncDeps {
  store: ProfileStore;
  settings: () => SyncSettings;
  /** Resolves to undefined when the user declines to unlock. */
  getPassphrase: (purpose: string) => Promise<string | undefined>;
  machineLabel: string;
  logger?: Logger;
  env?: NodeJS.ProcessEnv;
}

export interface PullOutcome {
  added: string[];
  updated: string[];
  unchanged: boolean;
  message: string;
}

export interface PushOutcome {
  pushed: boolean;
  message: string;
}

export class SyncManager {
  private readonly log: Logger;
  private readonly env: NodeJS.ProcessEnv;
  private lastPullAt = 0;
  private busy = false;

  constructor(private readonly deps: SyncDeps) {
    this.log = deps.logger ?? nullLogger;
    this.env = deps.env ?? process.env;
  }

  get enabled(): boolean {
    const settings = this.deps.settings();
    return settings.enabled && Boolean(settings.repository.trim());
  }

  private git(): GitSync {
    const settings = this.deps.settings();
    return new GitSync({
      dir: files.syncRepo(this.env),
      remote: settings.repository.trim(),
      branch: settings.branch || 'main',
      logger: this.log,
    });
  }

  private presence(git: GitSync): Presence {
    return new Presence(git, this.deps.store.state.machineId, this.deps.machineLabel, this.log);
  }

  /** Pulls the bundle and folds it into the local accounts. */
  async pull(options: { purpose?: string } = {}): Promise<PullOutcome> {
    if (!this.enabled) return { added: [], updated: [], unchanged: true, message: 'Sync is off.' };
    if (this.busy) return { added: [], updated: [], unchanged: true, message: 'Sync is already running.' };
    this.busy = true;
    try {
      const git = this.git();
      await git.ensureRepo();
      await git.fetch();
      const armoured = await git.showRemote(BUNDLE_FILE);
      if (!armoured) {
        return {
          added: [],
          updated: [],
          unchanged: true,
          message: 'The sync repository has no accounts in it yet.',
        };
      }
      const passphrase = await this.deps.getPassphrase(options.purpose ?? 'read your synced accounts');
      if (!passphrase) throw new LockedError();

      const payload = parseBundle(await decryptBundle(armoured, passphrase));
      const localBefore = this.deps.store.list();
      const remoteIds = new Set(payload.profiles.map((profile) => profile.id));
      const localOnly = localBefore.filter((profile) => !remoteIds.has(profile.id));
      const merged = mergeProfiles(localBefore, payload.profiles);
      await this.deps.store.replaceAll(merged.profiles);
      this.lastPullAt = Date.now();

      // Either we hold a newer credential for something the remote has, or an
      // account the remote has never seen. Both mean the remote is behind.
      const changedHere = merged.kept.length > 0 || localOnly.length > 0;
      const message = summarise(merged.added, merged.updated, payload);
      if (changedHere) {
        // We hold newer credentials for something the remote has; publish them
        // so the other machines stop using a token that has been rotated.
        await this.writeBundle(git, passphrase, 'publish newer credentials held locally');
      }
      return {
        added: merged.added,
        updated: merged.updated,
        unchanged: merged.added.length === 0 && merged.updated.length === 0,
        message,
      };
    } finally {
      this.busy = false;
    }
  }

  /** Merges the remote copy, then writes and pushes the combined bundle. */
  async push(reason: string): Promise<PushOutcome> {
    if (!this.enabled) return { pushed: false, message: 'Sync is off.' };
    if (this.busy) return { pushed: false, message: 'Sync is already running.' };
    this.busy = true;
    try {
      const git = this.git();
      await git.ensureRepo();
      await git.fetch().catch((error: unknown) => {
        // A brand new repository has no branch yet; that is not a failure.
        if (error instanceof GitError && error.kind === 'offline') throw error;
        this.log.debug(`fetch before push: ${redact(error)}`);
      });

      const passphrase = await this.deps.getPassphrase('write your synced accounts');
      if (!passphrase) throw new LockedError();

      const armoured = await git.showRemote(BUNDLE_FILE);
      if (armoured) {
        try {
          const payload = parseBundle(await decryptBundle(armoured, passphrase));
          const merged = mergeProfiles(this.deps.store.list(), payload.profiles);
          await this.deps.store.replaceAll(merged.profiles);
        } catch (error) {
          if (error instanceof BundleError && error.kind === 'passphrase') throw error;
          this.log.warn(`could not read the remote bundle before pushing: ${redact(error)}`);
        }
      }

      await this.presence(git).announce(this.deps.store.state.activeAccountId);
      return await this.writeBundle(git, passphrase, reason);
    } finally {
      this.busy = false;
    }
  }

  private async writeBundle(git: GitSync, passphrase: string, reason: string): Promise<PushOutcome> {
    const payload: BundlePayload = {
      version: BUNDLE_PAYLOAD_VERSION,
      updatedAt: new Date().toISOString(),
      updatedBy: this.deps.machineLabel,
      profiles: this.deps.store.list(),
    };
    await git.writeLocal(BUNDLE_FILE, await encryptBundle(serializeBundle(payload), passphrase));
    await git.writeLocal(
      'README.md',
      [
        '# Claude accounts (encrypted)',
        '',
        '`accounts.tdmk` holds Claude sign-ins encrypted with a passphrase using',
        'scrypt + AES-256-GCM. Keep this repository private.',
        '',
        'Format: see docs/BUNDLE-FORMAT.md in the Tidemark extension repository.',
        '',
        `Last written by: ${this.deps.machineLabel}`,
        '',
      ].join('\n'),
    );
    const result = await git.commitAndPush(`tidemark: ${reason}`);
    return {
      pushed: result.pushed,
      message: result.pushed ? `Pushed — ${reason}.` : 'Nothing to push.',
    };
  }

  async heartbeat(): Promise<void> {
    if (!this.enabled) return;
    try {
      const git = this.git();
      if (!(await git.status()).present) return;
      await this.presence(git).announce(this.deps.store.state.activeAccountId);
    } catch (error) {
      this.log.debug(`presence heartbeat skipped: ${redact(error)}`);
    }
  }

  /**
   * Every machine's current account in one pass. Asking per account would spawn
   * a git process per account per refresh, which with six accounts is thirty-six
   * subprocesses every few minutes for a line of grey text.
   */
  async presenceByAccount(): Promise<Map<string, PresenceEntry[]>> {
    const grouped = new Map<string, PresenceEntry[]>();
    if (!this.enabled) return grouped;
    try {
      for (const entry of await this.presence(this.git()).others()) {
        const list = grouped.get(entry.accountId) ?? [];
        list.push(entry);
        grouped.set(entry.accountId, list);
      }
    } catch (error) {
      this.log.debug(`presence read skipped: ${redact(error)}`);
    }
    return grouped;
  }

  describePresenceFor(entries: PresenceEntry[]): string {
    return describePresence(entries);
  }

  dueForPull(): boolean {
    const settings = this.deps.settings();
    if (!this.enabled || settings.pullIntervalMinutes <= 0) return false;
    return Date.now() - this.lastPullAt > settings.pullIntervalMinutes * 60_000;
  }

  async status(): Promise<{
    enabled: boolean;
    repository: string;
    branch: string;
    cloned: boolean;
    lastCommit?: string;
    lastCommitAt?: string;
    error?: string;
  }> {
    const settings = this.deps.settings();
    const base = {
      enabled: this.enabled,
      repository: settings.repository,
      branch: settings.branch || 'main',
      cloned: false,
    };
    if (!this.enabled) return base;
    try {
      const status = await this.git().status();
      return {
        ...base,
        cloned: status.present,
        lastCommit: status.lastCommit,
        lastCommitAt: status.lastCommitAt,
      };
    } catch (error) {
      return { ...base, error: error instanceof GitError ? error.display : redact(error) };
    }
  }
}

function summarise(added: string[], updated: string[], payload: BundlePayload): string {
  const parts: string[] = [];
  if (added.length > 0) parts.push(`added ${added.length} account${added.length === 1 ? '' : 's'}`);
  if (updated.length > 0) parts.push(`updated ${updated.length}`);
  if (parts.length === 0) parts.push('already up to date');
  return `Sync: ${parts.join(', ')} (bundle written by ${payload.updatedBy}).`;
}
