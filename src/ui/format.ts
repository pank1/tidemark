import { bindingWindow, nextReset } from '../core/usage';
import { describePresence } from '../core/presence';
import { formatCountdown, formatRelative, formatResetClock, msUntil } from '../core/time';
import { AccountView, Severity, WindowUsage } from '../core/types';

/** `████████░░` — a bar that reads the same in every font and theme. */
export function percentBar(percentUsed: number, width = 10): string {
  const filled = Math.round((Math.min(100, Math.max(0, percentUsed)) / 100) * width);
  return `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))}`;
}

export function severityIcon(severity: Severity): string {
  switch (severity) {
    case 'exhausted':
      return '$(circle-slash)';
    case 'critical':
      return '$(error)';
    case 'warning':
      return '$(warning)';
    default:
      return '$(pulse)';
  }
}

/** Short name for the status bar: the email's local part, or the label. */
export function shortLabel(view: AccountView, max = 16): string {
  const email = view.profile.identity?.email;
  const base = email ? email.split('@')[0]! : view.profile.label;
  return base.length > max ? `${base.slice(0, max - 1)}…` : base;
}

export function sourceMark(view: AccountView): string {
  return view.snapshot?.source === 'estimate' ? '~' : '';
}

export function windowLine(name: string, usage: WindowUsage, now = new Date()): string {
  const left = Math.round(usage.percentLeft);
  const reset = usage.resetsAt
    ? `resets ${formatResetClock(usage.resetsAt, now)} (${formatCountdown(msUntil(usage.resetsAt, now))})`
    : 'no reset time reported';
  const locked = usage.locked ? ` · locked: ${usage.lockedReason}` : '';
  return `${name} \`${percentBar(usage.percentUsed)}\` **${left}% left** · ${reset}${locked}`;
}

/** The single most useful sentence about an account, for lists. */
export function oneLine(view: AccountView, now = new Date()): string {
  if (view.profile.needsSignIn) return 'needs signing in again';
  const snapshot = view.snapshot;
  if (!snapshot) return view.lastError ?? 'no figures yet';
  const mark = sourceMark(view);
  const session = Math.round(snapshot.session.percentLeft);
  const week = Math.round(snapshot.week.percentLeft);
  const reset = nextReset(snapshot, now);
  const countdown = reset ? ` · resets in ${formatCountdown(msUntil(reset, now))}` : '';
  const stale = view.stale ? ` · figures ${formatRelative(snapshot.fetchedAt, now)}` : '';
  return `${mark}${session}% of this window, ${mark}${week}% of the week${countdown}${stale}`;
}

export function statusBarText(view: AccountView | undefined, options: { showWeekly: boolean; showAccountName: boolean; locked: boolean }): string {
  if (!view) return '$(account) No Claude account';
  if (view.profile.needsSignIn) return `$(alert) ${shortLabel(view)} · sign in`;
  const snapshot = view.snapshot;
  if (!snapshot) return `$(sync~spin) ${options.showAccountName ? shortLabel(view) : 'Claude'} · reading usage`;

  const binding = bindingWindow(snapshot);
  const mark = sourceMark(view);
  const parts: string[] = [];
  parts.push(view.stale ? '$(history)' : severityIcon(binding.usage.severity));
  if (options.showAccountName) parts.push(shortLabel(view));
  parts.push(`${mark}${Math.round(snapshot.session.percentLeft)}%`);
  if (options.showWeekly) parts.push(`wk ${mark}${Math.round(snapshot.week.percentLeft)}%`);
  const reset = nextReset(snapshot);
  if (reset) parts.push(`$(clock)${formatCountdown(msUntil(reset))}`);
  if (options.locked) parts.push('$(lock)');
  return parts.join(' ');
}

export function tooltipMarkdown(views: AccountView[], now = new Date()): string {
  const active = views.find((view) => view.isActive);
  const lines: string[] = [];

  if (!active) {
    lines.push('**No Claude account in use**', '', 'Sign in with Claude Code, then save it as an account.');
    return lines.join('\n');
  }

  const identity = active.profile.identity;
  lines.push(`**${active.profile.label}**${identity?.plan ? ` · ${identity.plan}` : ''}`);
  if (identity?.email && identity.email !== active.profile.label) lines.push(`${identity.email}`);
  lines.push('');

  const snapshot = active.snapshot;
  if (snapshot) {
    lines.push(windowLine('5-hour window', snapshot.session, now));
    lines.push('');
    lines.push(windowLine('This week', snapshot.week, now));
    if (snapshot.scoped.length > 0) {
      lines.push('');
      for (const limit of snapshot.scoped.filter((entry) => entry.percentUsed > 0)) {
        lines.push(`${limit.label}: ${Math.round(100 - limit.percentUsed)}% left`);
      }
    }
    if (snapshot.breakdown.length > 0) {
      lines.push('');
      lines.push(`Week so far: ${snapshot.breakdown.map((row) => `${row.label} ${row.percent}%`).join(' · ')}`);
    }
    lines.push('');
    lines.push(
      snapshot.source === 'estimate'
        ? `_Estimated from local session logs — Anthropic's figures were unavailable ${formatRelative(snapshot.fetchedAt, now)}._`
        : `_Figures from ${formatRelative(snapshot.fetchedAt, now)}._`,
    );
  } else {
    lines.push(active.lastError ?? 'No figures yet.');
  }

  if (active.lastError && snapshot) lines.push(`_${active.lastError}._`);

  const presence = describePresence(active.presence ?? [], now);
  if (presence) lines.push(`_Also ${presence}._`);

  const others = views.filter((view) => !view.isActive);
  if (others.length > 0) {
    lines.push('', '---', '**Other accounts**');
    for (const view of others.slice(0, 8)) {
      lines.push(`- ${view.profile.label} — ${oneLine(view, now)}`);
    }
  }

  lines.push('', '[Switch account](command:tidemark.switch) · [Refresh](command:tidemark.refresh)');
  return lines.join('\n');
}
