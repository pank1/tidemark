import { RawLimit, RawUsageResponse, RawWindow } from './api';
import { compareResetSoonest } from './time';
import { BreakdownRow, ScopedLimit, Severity, UsageSnapshot, WindowUsage } from './types';

const EMPTY_WINDOW: WindowUsage = {
  percentUsed: 0,
  percentLeft: 100,
  resetsAt: null,
  severity: 'normal',
  locked: false,
  lockedReason: null,
};

/**
 * Turns the `/api/oauth/usage` body into something the UI can render. The API
 * reports the same numbers twice — once as `five_hour`/`seven_day` and once in
 * `limits[]` — so we read the typed fields first and fall back to the array,
 * which keeps working if either representation is dropped.
 */
export function snapshotFromUsage(
  accountId: string,
  raw: RawUsageResponse,
  now: Date = new Date(),
): UsageSnapshot {
  const limits = Array.isArray(raw.limits) ? raw.limits : [];
  const session = windowFrom(raw.five_hour, findLimit(limits, 'session'));
  const week = windowFrom(raw.seven_day, findLimit(limits, 'weekly_all'));

  return {
    accountId,
    fetchedAt: now.toISOString(),
    source: 'api',
    session,
    week,
    scoped: scopedFrom(limits),
    breakdown: breakdownFrom(raw),
    extraUsage: raw.extra_usage
      ? {
          enabled: Boolean(raw.extra_usage.is_enabled),
          percentUsed: numberOrNull(raw.extra_usage.utilization),
        }
      : undefined,
  };
}

function findLimit(limits: RawLimit[], kind: string): RawLimit | undefined {
  return limits.find((limit) => limit.kind === kind);
}

function windowFrom(primary: RawWindow | null | undefined, fallback: RawLimit | undefined): WindowUsage {
  const used = numberOrNull(primary?.utilization) ?? numberOrNull(fallback?.percent);
  const resetsAt = nonEmpty(primary?.resets_at) ?? nonEmpty(fallback?.resets_at) ?? null;
  const lockedReason = nonEmpty(primary?.locked_reason) ?? null;
  if (used === null && !resetsAt && !lockedReason) return { ...EMPTY_WINDOW };
  const percentUsed = clampPercent(used ?? 0);
  return {
    percentUsed,
    percentLeft: clampPercent(100 - percentUsed),
    resetsAt,
    severity: severityFor(percentUsed, fallback?.severity, Boolean(lockedReason)),
    locked: Boolean(lockedReason),
    lockedReason,
  };
}

function scopedFrom(limits: RawLimit[]): ScopedLimit[] {
  return limits
    .filter((limit) => limit.kind !== 'session' && limit.kind !== 'weekly_all')
    .map((limit) => {
      const percentUsed = clampPercent(numberOrNull(limit.percent) ?? 0);
      return {
        kind: limit.kind ?? 'unknown',
        group: limit.group ?? 'other',
        label: scopeLabel(limit),
        percentUsed,
        resetsAt: nonEmpty(limit.resets_at) ?? null,
        severity: severityFor(percentUsed, limit.severity, false),
        isActive: Boolean(limit.is_active),
      };
    })
    .sort((a, b) => compareResetSoonest(a.resetsAt, b.resetsAt) || a.label.localeCompare(b.label));
}

function scopeLabel(limit: RawLimit): string {
  const model = nonEmpty(limit.scope?.model?.display_name);
  const surface = nonEmpty(limit.scope?.surface);
  if (model && surface) return `${model} · ${surface}`;
  if (model) return model;
  if (surface) return surface;
  if (limit.group === 'weekly') return 'Weekly (scoped)';
  return limit.kind ?? 'Limit';
}

function breakdownFrom(raw: RawUsageResponse): BreakdownRow[] {
  const rows = raw.seven_day_breakdown?.rows;
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => ({
      key: row.key ?? 'other',
      label: row.display_name ?? row.key ?? 'Other',
      percent: clampPercent(numberOrNull(row.percent) ?? 0),
    }))
    .filter((row) => row.percent > 0)
    .sort((a, b) => b.percent - a.percent);
}

export function severityFor(
  percentUsed: number,
  reported: string | null | undefined,
  locked: boolean,
): Severity {
  if (locked || percentUsed >= 100) return 'exhausted';
  const normalised = (reported ?? '').toLowerCase();
  if (normalised === 'critical' || normalised === 'warning' || normalised === 'normal') {
    return normalised as Severity;
  }
  if (percentUsed >= 90) return 'critical';
  if (percentUsed >= 75) return 'warning';
  return 'normal';
}

/** The window the user is actually up against — the one with less left. */
export function bindingWindow(snapshot: UsageSnapshot): { which: 'session' | 'week'; usage: WindowUsage } {
  return snapshot.week.percentUsed > snapshot.session.percentUsed
    ? { which: 'week', usage: snapshot.week }
    : { which: 'session', usage: snapshot.session };
}

/** Soonest reset still ahead of us, used for the status-bar countdown. */
export function nextReset(snapshot: UsageSnapshot, now: Date = new Date()): string | null {
  const candidates = [snapshot.session.resetsAt, snapshot.week.resetsAt]
    .filter((iso): iso is string => Boolean(iso))
    .filter((iso) => {
      const parsed = Date.parse(iso);
      return !Number.isNaN(parsed) && parsed > now.getTime();
    })
    .sort(compareResetSoonest);
  return candidates[0] ?? snapshot.session.resetsAt ?? snapshot.week.resetsAt ?? null;
}

export function worstSeverity(snapshot: UsageSnapshot): Severity {
  const order: Severity[] = ['normal', 'warning', 'critical', 'exhausted'];
  const session = order.indexOf(snapshot.session.severity);
  const week = order.indexOf(snapshot.week.severity);
  return order[Math.max(session, week)] ?? 'normal';
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value * 10) / 10));
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonEmpty(value: string | null | undefined): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > 0 ? text : undefined;
}
