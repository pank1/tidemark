import { GitSync } from './git';
import { Logger, nullLogger, redact } from './log';
import { PresenceEntry } from './types';

const PRESENCE_DIR = 'presence';
const FORGET_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Advisory only (D-09). Presence files sit *outside* the encrypted bundle so a
 * heartbeat does not rewrite the ciphertext every few minutes, and they carry
 * only a machine name and an opaque local account id — never an email.
 */
export class Presence {
  constructor(
    private readonly git: GitSync,
    private readonly machineId: string,
    private readonly machineLabel: string,
    private readonly log: Logger = nullLogger,
  ) {}

  private get file(): string {
    return `${PRESENCE_DIR}/${safeName(this.machineId)}.json`;
  }

  async announce(accountId: string | undefined): Promise<void> {
    if (!accountId) return;
    const entry: PresenceEntry = {
      machine: this.machineLabel,
      accountId,
      updatedAt: new Date().toISOString(),
    };
    await this.git.writeLocal(this.file, `${JSON.stringify(entry, null, 2)}\n`);
  }

  /** Everyone else's current account, newest first, stale entries dropped. */
  async others(now: Date = new Date()): Promise<PresenceEntry[]> {
    const entries: PresenceEntry[] = [];
    const mine = this.file;
    for (const relativePath of await this.listRemoteFiles()) {
      if (relativePath === mine) continue;
      const raw = (await this.git.showRemote(relativePath)) ?? (await this.git.readLocal(relativePath));
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as PresenceEntry;
        if (!parsed?.accountId || !parsed.updatedAt) continue;
        if (now.getTime() - Date.parse(parsed.updatedAt) > FORGET_AFTER_MS) continue;
        entries.push(parsed);
      } catch (error) {
        this.log.debug(`unreadable presence file ${relativePath}: ${redact(error)}`);
      }
    }
    return entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private async listRemoteFiles(): Promise<string[]> {
    const listing = await this.git.showRemote(`${PRESENCE_DIR}`);
    if (!listing) return [];
    // `git show <rev>:<dir>` prints a tree listing; take the file names from it.
    return listing
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.endsWith('.json'))
      .map((name) => `${PRESENCE_DIR}/${name}`);
  }
}

export function describePresence(entries: PresenceEntry[], now: Date = new Date()): string {
  if (entries.length === 0) return '';
  const names = entries.map((entry) => entry.machine);
  const age = Math.max(0, Math.round((now.getTime() - Date.parse(entries[0]!.updatedAt)) / 60_000));
  const who = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `in use on ${who} · ${age}m ago`;
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64) || 'machine';
}
