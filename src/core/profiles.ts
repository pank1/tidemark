import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';

import { writeFileAtomic } from './credstore';
import { Logger, nullLogger, redact } from './log';
import { files } from './paths';
import {
  AccountIdentity,
  PROFILES_VERSION,
  Profile,
  STATE_VERSION,
  StoredCredentials,
  TidemarkState,
  UsageSnapshot,
} from './types';

interface ProfilesFile {
  version: number;
  profiles: Profile[];
}

interface SnapshotsFile {
  version: number;
  snapshots: Record<string, UsageSnapshot>;
}

/**
 * Everything Tidemark knows, on disk under `~/.tidemark` at mode 0600:
 * accounts, which one is active, and the last usage figures seen for each.
 *
 * Credentials are stored in the clear here, exactly as Claude Code stores its
 * own (D-14). Encryption applies to the copy that leaves the machine.
 */
export class ProfileStore {
  private profiles: Profile[] = [];
  private snapshotsById = new Map<string, UsageSnapshot>();
  private stateValue: TidemarkState = {
    version: STATE_VERSION,
    machineId: crypto.randomUUID(),
  };
  private loaded = false;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly log: Logger = nullLogger,
  ) {}

  async load(): Promise<void> {
    this.profiles = await this.readProfiles();
    this.stateValue = await this.readState();
    this.snapshotsById = await this.readSnapshots();
    this.loaded = true;
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  get state(): TidemarkState {
    return this.stateValue;
  }

  list(): Profile[] {
    return [...this.profiles].sort((a, b) => a.label.localeCompare(b.label));
  }

  get(id: string | undefined): Profile | undefined {
    if (!id) return undefined;
    return this.profiles.find((profile) => profile.id === id);
  }

  get active(): Profile | undefined {
    return this.get(this.stateValue.activeAccountId);
  }

  findByLogin(credentials: StoredCredentials): Profile | undefined {
    const refresh = credentials.claudeAiOauth.refreshToken;
    const access = credentials.claudeAiOauth.accessToken;
    return this.profiles.find(
      (profile) =>
        (refresh && profile.credentials.claudeAiOauth.refreshToken === refresh) ||
        (access && profile.credentials.claudeAiOauth.accessToken === access),
    );
  }

  findByIdentity(identity: AccountIdentity | undefined): Profile | undefined {
    if (!identity) return undefined;
    return this.profiles.find(
      (profile) =>
        (identity.accountUuid && profile.identity?.accountUuid === identity.accountUuid) ||
        (identity.email && profile.identity?.email === identity.email),
    );
  }

  async add(input: {
    label: string;
    credentials: StoredCredentials;
    identity?: AccountIdentity;
  }): Promise<Profile> {
    const profile: Profile = {
      id: crypto.randomUUID(),
      label: this.uniqueLabel(input.label),
      credentials: input.credentials,
      identity: input.identity,
      addedAt: new Date().toISOString(),
    };
    this.profiles.push(profile);
    await this.saveProfiles();
    return profile;
  }

  async update(id: string, patch: Partial<Omit<Profile, 'id'>>): Promise<Profile | undefined> {
    const index = this.profiles.findIndex((profile) => profile.id === id);
    if (index < 0) return undefined;
    const current = this.profiles[index]!;
    const next: Profile = { ...current, ...patch, id: current.id };
    if (patch.label && patch.label !== current.label) next.label = this.uniqueLabel(patch.label, id);
    this.profiles[index] = next;
    await this.saveProfiles();
    return next;
  }

  async remove(id: string): Promise<void> {
    this.profiles = this.profiles.filter((profile) => profile.id !== id);
    this.snapshotsById.delete(id);
    if (this.stateValue.activeAccountId === id) delete this.stateValue.activeAccountId;
    await this.saveProfiles();
    await this.saveState();
    await this.saveSnapshots();
  }

  async replaceAll(profiles: Profile[]): Promise<void> {
    this.profiles = profiles;
    await this.saveProfiles();
  }

  async setActive(id: string | undefined): Promise<void> {
    if (id) {
      this.stateValue.activeAccountId = id;
      await this.update(id, { lastUsedAt: new Date().toISOString() });
    } else {
      delete this.stateValue.activeAccountId;
    }
    await this.saveState();
  }

  async patchState(patch: Partial<TidemarkState>): Promise<void> {
    this.stateValue = { ...this.stateValue, ...patch, version: STATE_VERSION };
    await this.saveState();
  }

  snapshot(id: string): UsageSnapshot | undefined {
    return this.snapshotsById.get(id);
  }

  allSnapshots(): Map<string, UsageSnapshot> {
    return new Map(this.snapshotsById);
  }

  async putSnapshot(snapshot: UsageSnapshot): Promise<void> {
    this.snapshotsById.set(snapshot.accountId, snapshot);
    await this.saveSnapshots();
  }

  private uniqueLabel(label: string, ignoreId?: string): string {
    const trimmed = label.trim() || 'Account';
    const taken = new Set(
      this.profiles.filter((profile) => profile.id !== ignoreId).map((profile) => profile.label),
    );
    if (!taken.has(trimmed)) return trimmed;
    for (let suffix = 2; suffix < 100; suffix += 1) {
      const candidate = `${trimmed} (${suffix})`;
      if (!taken.has(candidate)) return candidate;
    }
    return `${trimmed} (${Date.now()})`;
  }

  private async readProfiles(): Promise<Profile[]> {
    const parsed = await this.readJson<ProfilesFile>(files.profiles(this.env));
    if (!parsed?.profiles) return [];
    if (parsed.version > PROFILES_VERSION) {
      this.log.warn(
        `profiles.json was written by a newer Tidemark (v${parsed.version}); leaving it alone.`,
      );
      return [];
    }
    return parsed.profiles.filter((profile) => Boolean(profile?.id && profile.credentials));
  }

  private async readState(): Promise<TidemarkState> {
    const parsed = await this.readJson<TidemarkState>(files.state(this.env));
    if (!parsed?.machineId) {
      return { version: STATE_VERSION, machineId: crypto.randomUUID(), ...(parsed ?? {}) };
    }
    return { ...parsed, version: STATE_VERSION };
  }

  private async readSnapshots(): Promise<Map<string, UsageSnapshot>> {
    const parsed = await this.readJson<SnapshotsFile>(files.snapshots(this.env));
    const map = new Map<string, UsageSnapshot>();
    for (const [id, snapshot] of Object.entries(parsed?.snapshots ?? {})) {
      if (snapshot?.fetchedAt) map.set(id, snapshot);
    }
    return map;
  }

  private async readJson<T>(path: string): Promise<T | undefined> {
    try {
      return JSON.parse(await fs.readFile(path, 'utf8')) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        this.log.warn(`could not read ${path}: ${redact(error)}`);
      }
      return undefined;
    }
  }

  private async saveProfiles(): Promise<void> {
    const payload: ProfilesFile = { version: PROFILES_VERSION, profiles: this.profiles };
    await writeFileAtomic(files.profiles(this.env), JSON.stringify(payload, null, 2));
  }

  async saveState(): Promise<void> {
    await writeFileAtomic(files.state(this.env), JSON.stringify(this.stateValue, null, 2));
  }

  private async saveSnapshots(): Promise<void> {
    const payload: SnapshotsFile = {
      version: 1,
      snapshots: Object.fromEntries(this.snapshotsById),
    };
    await writeFileAtomic(files.snapshots(this.env), JSON.stringify(payload, null, 2));
  }
}

/** Label used when an account is captured: the email, else the plan, else a number. */
export function suggestLabel(identity: AccountIdentity | undefined, fallbackIndex: number): string {
  if (identity?.email) return identity.email;
  if (identity?.fullName) return identity.fullName;
  if (identity?.plan) return `${identity.plan} account`;
  return `Account ${fallbackIndex}`;
}

export function machineName(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.TIDEMARK_MACHINE_NAME?.trim();
  if (configured) return configured;
  return os.hostname().split('.')[0] || 'this machine';
}
