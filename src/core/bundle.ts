import { assertCredentials } from './credstore';
import { Profile } from './types';

export const BUNDLE_PAYLOAD_VERSION = 1;

export interface BundlePayload {
  version: number;
  updatedAt: string;
  /** Machine name that last wrote it, for the "last written by" line. */
  updatedBy: string;
  profiles: Profile[];
}

export function serializeBundle(payload: BundlePayload): string {
  return JSON.stringify(payload, null, 2);
}

export function parseBundle(json: string): BundlePayload {
  const parsed = JSON.parse(json) as BundlePayload;
  if (typeof parsed !== 'object' || parsed === null) throw new Error('Bundle is not an object.');
  if (parsed.version > BUNDLE_PAYLOAD_VERSION) {
    throw new Error(`Bundle version ${parsed.version} is newer than this extension understands.`);
  }
  if (!Array.isArray(parsed.profiles)) throw new Error('Bundle has no profiles array.');
  for (const profile of parsed.profiles) {
    if (!profile.id || !profile.label) throw new Error('Bundle contains a profile with no id or label.');
    assertCredentials(profile.credentials);
  }
  return {
    version: parsed.version ?? BUNDLE_PAYLOAD_VERSION,
    updatedAt: parsed.updatedAt ?? new Date(0).toISOString(),
    updatedBy: parsed.updatedBy ?? 'unknown',
    profiles: parsed.profiles,
  };
}

export interface MergeResult {
  profiles: Profile[];
  added: string[];
  updated: string[];
  kept: string[];
}

/**
 * Union by profile id. When both sides have the same account, the copy whose
 * access token expires later is the one that was refreshed most recently, so it
 * is the copy that still works — that wins regardless of which side it came
 * from. This is what keeps six machines from reviving each other's dead tokens.
 */
export function mergeProfiles(local: Profile[], remote: Profile[]): MergeResult {
  const byId = new Map<string, Profile>();
  for (const profile of local) byId.set(profile.id, profile);

  const added: string[] = [];
  const updated: string[] = [];
  const kept: string[] = [];

  for (const incoming of remote) {
    const existing = byId.get(incoming.id);
    if (!existing) {
      byId.set(incoming.id, incoming);
      added.push(incoming.label);
      continue;
    }
    const winner = freshest(existing, incoming);
    if (winner === incoming) {
      byId.set(incoming.id, mergeOne(incoming, existing));
      updated.push(incoming.label);
    } else {
      byId.set(existing.id, mergeOne(existing, incoming));
      kept.push(existing.label);
    }
  }

  return {
    profiles: [...byId.values()].sort((a, b) => a.label.localeCompare(b.label)),
    added,
    updated,
    kept,
  };
}

function freshest(a: Profile, b: Profile): Profile {
  const left = a.credentials.claudeAiOauth.expiresAt ?? 0;
  const right = b.credentials.claudeAiOauth.expiresAt ?? 0;
  if (right > left) return b;
  if (left > right) return a;
  // Equal tokens: prefer the one not flagged as needing a sign-in, then the one
  // used more recently, so labels and identities settle rather than flap.
  if (Boolean(a.needsSignIn) !== Boolean(b.needsSignIn)) return a.needsSignIn ? b : a;
  return (b.lastUsedAt ?? '') > (a.lastUsedAt ?? '') ? b : a;
}

/** Winner's credentials, best available metadata from either side. */
function mergeOne(winner: Profile, loser: Profile): Profile {
  return {
    ...winner,
    identity: winner.identity ?? loser.identity,
    lastUsedAt: maxIso(winner.lastUsedAt, loser.lastUsedAt),
    addedAt: minIso(winner.addedAt, loser.addedAt) ?? winner.addedAt,
  };
}

function maxIso(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

function minIso(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}
