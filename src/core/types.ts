/**
 * Shared shapes. Nothing in `src/core` may import `vscode` (D-13) so that this
 * file and its neighbours are testable with plain `node --test`.
 */

/** The on-disk shape Claude Code itself uses. Confirmed against client 2.1.296. */
export interface StoredCredentials {
  claudeAiOauth: {
    accessToken: string;
    refreshToken: string;
    /** Epoch milliseconds. */
    expiresAt: number;
    refreshTokenExpiresAt?: number;
    scopes?: string[];
    subscriptionType?: string;
    rateLimitTier?: string;
  };
  [extra: string]: unknown;
}

export interface AccountIdentity {
  accountUuid?: string;
  email?: string;
  fullName?: string;
  organizationUuid?: string;
  organizationName?: string;
  /** e.g. default_claude_max_20x */
  rateLimitTier?: string;
  /** Short plan word for display: Max, Pro, Team, … */
  plan?: string;
}

export interface Profile {
  /** Local, opaque, safe to put in plaintext presence files. */
  id: string;
  label: string;
  identity?: AccountIdentity;
  credentials: StoredCredentials;
  addedAt: string;
  lastUsedAt?: string;
  /** Set when a refresh failed; the stored credentials are kept regardless. */
  needsSignIn?: boolean;
}

export type Severity = 'normal' | 'warning' | 'critical' | 'exhausted';

export interface WindowUsage {
  /** 0–100, as reported. */
  percentUsed: number;
  /** 100 − percentUsed, clamped. */
  percentLeft: number;
  /** ISO timestamp, or null when the API did not give one. */
  resetsAt: string | null;
  severity: Severity;
  locked: boolean;
  lockedReason?: string | null;
}

export interface ScopedLimit {
  kind: string;
  group: string;
  label: string;
  percentUsed: number;
  resetsAt: string | null;
  severity: Severity;
  isActive: boolean;
}

export interface BreakdownRow {
  key: string;
  label: string;
  percent: number;
}

export type SnapshotSource = 'api' | 'estimate';

export interface UsageSnapshot {
  accountId: string;
  /** ISO timestamp of the moment this was produced. */
  fetchedAt: string;
  source: SnapshotSource;
  session: WindowUsage;
  week: WindowUsage;
  scoped: ScopedLimit[];
  breakdown: BreakdownRow[];
  extraUsage?: { enabled: boolean; percentUsed: number | null };
}

/** A snapshot plus why it might not be trustworthy right now. */
export interface AccountView {
  profile: Profile;
  snapshot?: UsageSnapshot;
  /** Last failure, for the tooltip. Never shown as a toast. */
  lastError?: string;
  stale: boolean;
  presence?: PresenceEntry[];
  isActive: boolean;
}

export interface TidemarkState {
  version: number;
  machineId: string;
  activeAccountId?: string;
  lastFailoverAt?: string;
  /** Shown once, then never again. */
  firstRunShown?: boolean;
  /**
   * A switch that ends in a window reload loses its notification, so the text
   * is parked here and shown when the window comes back.
   */
  pendingAnnouncement?: {
    message: string;
    previousAccountId?: string;
    at: string;
  };
  /**
   * Learned from times when both the API figures and the local logs were
   * available, so the offline estimate has something real to scale against.
   */
  calibration?: Calibration;
}

export interface Calibration {
  sessionWeightedPerPercent?: number;
  weeklyWeightedPerPercent?: number;
  samples?: number;
  updatedAt?: string;
}

export interface PresenceEntry {
  machine: string;
  accountId: string;
  updatedAt: string;
}

export interface PolicySettings {
  weeklyExhaustedPercent: number;
  preferredWeeklyLeftPercent: number;
  sessionTriggerPercent: number;
  staleAfterMinutes: number;
}

export const STATE_VERSION = 1;
export const PROFILES_VERSION = 1;
