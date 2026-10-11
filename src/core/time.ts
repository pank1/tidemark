/** Milliseconds from `now` until `iso`. Negative once it has passed. */
export function msUntil(iso: string | null | undefined, now: Date = new Date()): number | undefined {
  if (!iso) return undefined;
  const target = Date.parse(iso);
  if (Number.isNaN(target)) return undefined;
  return target - now.getTime();
}

/**
 * Compact countdown for the status bar: `3d 4h`, `2h41m`, `41m`, `38s`, `now`.
 * Clock skew between the machine and Anthropic can make a reset look a minute
 * out; anything already past reads `now` rather than a negative number.
 */
export function formatCountdown(ms: number | undefined): string {
  if (ms === undefined) return '—';
  if (ms <= 0) return 'now';
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

/** `just now`, `4m ago`, `2h ago`, `3d ago`. */
export function formatRelative(iso: string | undefined, now: Date = new Date()): string {
  if (!iso) return 'never';
  const elapsed = now.getTime() - Date.parse(iso);
  if (Number.isNaN(elapsed)) return 'unknown';
  if (elapsed < 45_000) return 'just now';
  const minutes = Math.round(elapsed / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Local wall-clock for a reset, e.g. `Fri 07:59`. */
export function formatResetClock(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return 'unknown';
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return 'unknown';
  const time = when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const sameDay = when.toDateString() === now.toDateString();
  if (sameDay) return time;
  const day = when.toLocaleDateString(undefined, { weekday: 'short' });
  const withinWeek = when.getTime() - now.getTime() < 6 * 86_400_000;
  if (withinWeek) return `${day} ${time}`;
  return `${when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`;
}

/**
 * Orders ISO timestamps soonest first; anything missing or unparseable sorts
 * last so a broken reset time can never win a failover race (D-07).
 */
export function compareResetSoonest(a: string | null | undefined, b: string | null | undefined): number {
  const left = a ? Date.parse(a) : Number.NaN;
  const right = b ? Date.parse(b) : Number.NaN;
  const leftBad = Number.isNaN(left);
  const rightBad = Number.isNaN(right);
  if (leftBad && rightBad) return 0;
  if (leftBad) return 1;
  if (rightBad) return -1;
  return left - right;
}

export function minutesSince(iso: string | undefined, now: Date = new Date()): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return Number.POSITIVE_INFINITY;
  return (now.getTime() - then) / 60_000;
}
