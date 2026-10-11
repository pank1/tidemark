import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RawUsageResponse } from '../src/core/api';
import { bindingWindow, nextReset, severityFor, snapshotFromUsage, worstSeverity } from '../src/core/usage';

const NOW = new Date('2026-10-10T09:00:00Z');

/** Trimmed from a real response of the installed client (2026-10-10). */
const REAL: RawUsageResponse = {
  five_hour: { utilization: 25, resets_at: '2026-10-10T11:59:59.908331+00:00', locked_reason: null },
  seven_day: { utilization: 72, resets_at: '2026-10-15T06:59:59.908349+00:00', locked_reason: null },
  limits: [
    { kind: 'session', group: 'session', percent: 25, severity: 'normal', resets_at: '2026-10-10T11:59:59.908331+00:00', is_active: false },
    { kind: 'weekly_all', group: 'weekly', percent: 72, severity: 'normal', resets_at: '2026-10-15T06:59:59.908349+00:00', is_active: true },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 12,
      severity: 'normal',
      resets_at: '2026-10-15T07:00:00+00:00',
      is_active: false,
      scope: { model: { id: null, display_name: 'Fable' }, surface: null },
    },
  ],
  extra_usage: { is_enabled: false, utilization: null },
  seven_day_breakdown: {
    as_of: '2026-10-10T09:01:09Z',
    rows: [
      { key: 'claude_code', display_name: 'Claude Code', percent: 100 },
      { key: 'chat', display_name: 'Chats', percent: 0 },
    ],
  },
};

test('a real response becomes a snapshot', () => {
  const snapshot = snapshotFromUsage('acct', REAL, NOW);
  assert.equal(snapshot.session.percentUsed, 25);
  assert.equal(snapshot.session.percentLeft, 75);
  assert.equal(snapshot.week.percentUsed, 72);
  assert.equal(snapshot.week.percentLeft, 28);
  assert.equal(snapshot.source, 'api');
  assert.equal(snapshot.scoped.length, 1);
  assert.equal(snapshot.scoped[0]!.label, 'Fable');
  assert.deepEqual(
    snapshot.breakdown.map((row) => row.label),
    ['Claude Code'],
    'rows at zero are not worth the space',
  );
});

test('the limits array is enough on its own', () => {
  const snapshot = snapshotFromUsage('acct', { limits: REAL.limits }, NOW);
  assert.equal(snapshot.session.percentUsed, 25);
  assert.equal(snapshot.week.percentUsed, 72);
  assert.equal(snapshot.week.resetsAt, '2026-10-15T06:59:59.908349+00:00');
});

test('an empty response does not pretend to know anything', () => {
  const snapshot = snapshotFromUsage('acct', {}, NOW);
  assert.equal(snapshot.session.percentUsed, 0);
  assert.equal(snapshot.session.resetsAt, null);
  assert.equal(snapshot.week.resetsAt, null);
  assert.equal(nextReset(snapshot, NOW), null);
});

test('a lockout is exhausted whatever the percentage says', () => {
  const snapshot = snapshotFromUsage(
    'acct',
    { five_hour: { utilization: 40, resets_at: null, locked_reason: 'usage limit reached' } },
    NOW,
  );
  assert.equal(snapshot.session.locked, true);
  assert.equal(snapshot.session.severity, 'exhausted');
  assert.equal(worstSeverity(snapshot), 'exhausted');
});

test('severity is taken from the server when it sends one, derived when it does not', () => {
  assert.equal(severityFor(10, 'critical', false), 'critical');
  assert.equal(severityFor(10, 'nonsense', false), 'normal');
  assert.equal(severityFor(80, null, false), 'warning');
  assert.equal(severityFor(92, undefined, false), 'critical');
  assert.equal(severityFor(100, 'normal', false), 'exhausted');
});

test('the binding window is whichever has less left', () => {
  const snapshot = snapshotFromUsage('acct', REAL, NOW);
  assert.equal(bindingWindow(snapshot).which, 'week');
  const fresh = snapshotFromUsage(
    'acct',
    { five_hour: { utilization: 90 }, seven_day: { utilization: 10 } },
    NOW,
  );
  assert.equal(bindingWindow(fresh).which, 'session');
});

test('the countdown uses the soonest reset still ahead', () => {
  const snapshot = snapshotFromUsage('acct', REAL, NOW);
  assert.equal(nextReset(snapshot, NOW), '2026-10-10T11:59:59.908331+00:00');
  const afterSession = new Date('2026-10-10T13:00:00Z');
  assert.equal(nextReset(snapshot, afterSession), '2026-10-15T06:59:59.908349+00:00');
});

test('percentages are clamped and rounded, never NaN', () => {
  const snapshot = snapshotFromUsage(
    'acct',
    { five_hour: { utilization: 120.46 }, seven_day: { utilization: Number.NaN } },
    NOW,
  );
  assert.equal(snapshot.session.percentUsed, 100);
  assert.equal(snapshot.session.percentLeft, 0);
  assert.equal(snapshot.week.percentUsed, 0);
});
