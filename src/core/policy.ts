import { compareResetSoonest, formatResetClock, minutesSince } from './time';
import { PolicySettings, UsageSnapshot } from './types';

export const DEFAULT_POLICY: PolicySettings = {
  weeklyExhaustedPercent: 95,
  preferredWeeklyLeftPercent: 50,
  sessionTriggerPercent: 95,
  staleAfterMinutes: 30,
};

export type FailoverTrigger = 'session-finished' | 'weekly-finished' | 'locked';

export interface Candidate {
  accountId: string;
  label: string;
  snapshot?: UsageSnapshot;
  needsSignIn?: boolean;
}

export interface PickOptions extends PolicySettings {
  /**
   * True when the hop is caused by a 5-hour window finishing. In that case
   * prefer an account with real cushion left in its week, not merely one that
   * is not yet exhausted (D-07).
   */
  preferCushion: boolean;
  excludeAccountIds?: string[];
  now?: Date;
}

export interface Rejection {
  accountId: string;
  label: string;
  why: string;
}

export interface PickResult {
  chosen?: Candidate;
  /** One sentence naming the account and why it won. Shown to the user. */
  reason: string;
  rejected: Rejection[];
  /** True when the cushion requirement had to be dropped to find anyone. */
  usedFallback: boolean;
}

/**
 * Chooses the account to move to.
 *
 * Among accounts that still have weekly quota and a usable 5-hour window, the
 * one whose **weekly window resets soonest** wins, because that is the quota
 * about to disappear. Ties break on lower weekly use, then label, so six
 * machines looking at the same data make the same choice.
 */
export function pickAccount(candidates: Candidate[], options: PickOptions): PickResult {
  const now = options.now ?? new Date();
  const excluded = new Set(options.excludeAccountIds ?? []);
  const rejected: Rejection[] = [];
  const eligible: Candidate[] = [];

  for (const candidate of candidates) {
    if (excluded.has(candidate.accountId)) continue;
    const why = disqualify(candidate, options, now);
    if (why) {
      rejected.push({ accountId: candidate.accountId, label: candidate.label, why });
      continue;
    }
    eligible.push(candidate);
  }

  if (eligible.length === 0) {
    return { chosen: undefined, reason: 'No account has quota available right now.', rejected, usedFallback: false };
  }

  const ordered = [...eligible].sort(byWeeklyResetThenHeadroom);
  let pool = ordered;
  let usedFallback = false;

  if (options.preferCushion) {
    const cushioned = ordered.filter(
      (candidate) => weeklyLeft(candidate) > options.preferredWeeklyLeftPercent,
    );
    if (cushioned.length > 0) {
      pool = cushioned;
    } else {
      usedFallback = true;
    }
  }

  const chosen = pool[0];
  return { chosen, reason: explain(chosen, { ...options, now }, usedFallback), rejected, usedFallback };
}

/** Whether the account in use has run out, and on which limit. */
export function shouldFailover(
  snapshot: UsageSnapshot | undefined,
  settings: PolicySettings,
): FailoverTrigger | undefined {
  if (!snapshot) return undefined;
  if (snapshot.session.locked || snapshot.week.locked) return 'locked';
  if (snapshot.week.percentUsed >= settings.weeklyExhaustedPercent) return 'weekly-finished';
  if (snapshot.session.percentUsed >= settings.sessionTriggerPercent) return 'session-finished';
  return undefined;
}

export function describeTrigger(trigger: FailoverTrigger): string {
  switch (trigger) {
    case 'session-finished':
      return 'the 5-hour window is spent';
    case 'weekly-finished':
      return 'the weekly limit is spent';
    case 'locked':
      return 'the account is locked out';
  }
}

/** A trigger that prefers cushion is one caused by the short window finishing. */
export function prefersCushion(trigger: FailoverTrigger): boolean {
  return trigger === 'session-finished';
}

function disqualify(candidate: Candidate, settings: PolicySettings, now: Date): string | undefined {
  if (candidate.needsSignIn) return 'needs signing in again';
  const snapshot = candidate.snapshot;
  if (!snapshot) return 'no usage figures yet';
  if (minutesSince(snapshot.fetchedAt, now) > settings.staleAfterMinutes) {
    return `usage figures are stale (${Math.round(minutesSince(snapshot.fetchedAt, now))}m old)`;
  }
  if (snapshot.week.locked) return 'weekly limit is locked';
  if (snapshot.week.percentUsed >= settings.weeklyExhaustedPercent) {
    return `week is ${snapshot.week.percentUsed}% used`;
  }
  if (snapshot.session.locked) return '5-hour window is locked';
  if (snapshot.session.percentUsed >= 100) return '5-hour window is spent';
  return undefined;
}

function byWeeklyResetThenHeadroom(a: Candidate, b: Candidate): number {
  const byReset = compareResetSoonest(a.snapshot?.week.resetsAt, b.snapshot?.week.resetsAt);
  if (byReset !== 0) return byReset;
  const byUse = (a.snapshot?.week.percentUsed ?? 100) - (b.snapshot?.week.percentUsed ?? 100);
  if (byUse !== 0) return byUse;
  return a.label.localeCompare(b.label);
}

function weeklyLeft(candidate: Candidate): number {
  return candidate.snapshot?.week.percentLeft ?? 0;
}

function explain(candidate: Candidate, options: PickOptions, usedFallback: boolean): string {
  const left = Math.round(weeklyLeft(candidate));
  const resets = formatResetClock(candidate.snapshot?.week.resetsAt, options.now);
  const base = `${candidate.label} — ${left}% of its week left, resetting ${resets} (soonest of the accounts with quota)`;
  if (!usedFallback) return base;
  return `${base}. No account had more than ${options.preferredWeeklyLeftPercent}% of its week left, so that requirement was relaxed.`;
}
