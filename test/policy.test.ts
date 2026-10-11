import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_POLICY, pickAccount, prefersCushion, shouldFailover } from '../src/core/policy';
import { UsageSnapshot } from '../src/core/types';

const NOW = new Date('2026-10-10T09:00:00Z');

function snapshot(options: {
  session?: number;
  week?: number;
  weekResetsAt?: string;
  sessionResetsAt?: string;
  fetchedAt?: string;
  lockedSession?: boolean;
}): UsageSnapshot {
  const sessionUsed = options.session ?? 0;
  const weekUsed = options.week ?? 0;
  return {
    accountId: 'x',
    fetchedAt: options.fetchedAt ?? NOW.toISOString(),
    source: 'api',
    session: {
      percentUsed: sessionUsed,
      percentLeft: 100 - sessionUsed,
      resetsAt: options.sessionResetsAt ?? '2026-10-10T12:00:00Z',
      severity: 'normal',
      locked: options.lockedSession ?? false,
      lockedReason: options.lockedSession ? 'limit reached' : null,
    },
    week: {
      percentUsed: weekUsed,
      percentLeft: 100 - weekUsed,
      resetsAt: options.weekResetsAt ?? '2026-10-15T07:00:00Z',
      severity: 'normal',
      locked: false,
      lockedReason: null,
    },
    scoped: [],
    breakdown: [],
  };
}

const base = { ...DEFAULT_POLICY, preferCushion: false, now: NOW };

test('the soonest weekly reset wins among accounts with quota', () => {
  const result = pickAccount(
    [
      { accountId: 'a', label: 'A', snapshot: snapshot({ week: 10, weekResetsAt: '2026-10-16T07:00:00Z' }) },
      { accountId: 'b', label: 'B', snapshot: snapshot({ week: 60, weekResetsAt: '2026-10-11T07:00:00Z' }) },
      { accountId: 'c', label: 'C', snapshot: snapshot({ week: 5, weekResetsAt: '2026-10-20T07:00:00Z' }) },
    ],
    base,
  );
  assert.equal(result.chosen?.accountId, 'b', 'use-it-or-lose-it quota goes first');
  assert.match(result.reason, /40% of its week left/);
});

test('an account at or past the weekly ceiling is not a candidate', () => {
  const result = pickAccount(
    [
      { accountId: 'spent', label: 'Spent', snapshot: snapshot({ week: 95, weekResetsAt: '2026-10-11T07:00:00Z' }) },
      { accountId: 'ok', label: 'Ok', snapshot: snapshot({ week: 94, weekResetsAt: '2026-10-19T07:00:00Z' }) },
    ],
    base,
  );
  assert.equal(result.chosen?.accountId, 'ok');
  assert.deepEqual(
    result.rejected.map((entry) => entry.accountId),
    ['spent'],
  );
  assert.match(result.rejected[0]!.why, /95% used/);
});

test('an account whose 5-hour window is spent or locked is not a candidate', () => {
  const result = pickAccount(
    [
      { accountId: 'full', label: 'Full', snapshot: snapshot({ session: 100, week: 10 }) },
      { accountId: 'locked', label: 'Locked', snapshot: snapshot({ lockedSession: true, week: 10 }) },
    ],
    base,
  );
  assert.equal(result.chosen, undefined);
  assert.equal(result.rejected.length, 2);
});

test('stale figures and accounts needing sign-in are skipped', () => {
  const result = pickAccount(
    [
      {
        accountId: 'stale',
        label: 'Stale',
        snapshot: snapshot({ week: 5, fetchedAt: '2026-10-10T07:00:00Z' }),
      },
      { accountId: 'signin', label: 'Sign-in', snapshot: snapshot({ week: 5 }), needsSignIn: true },
      { accountId: 'none', label: 'None' },
    ],
    base,
  );
  assert.equal(result.chosen, undefined);
  assert.deepEqual(result.rejected.map((entry) => entry.accountId).sort(), ['none', 'signin', 'stale']);
});

test('after a 5-hour window finishes, cushion beats a sooner reset', () => {
  const candidates = [
    { accountId: 'thin', label: 'Thin', snapshot: snapshot({ week: 80, weekResetsAt: '2026-10-11T07:00:00Z' }) },
    { accountId: 'fat', label: 'Fat', snapshot: snapshot({ week: 20, weekResetsAt: '2026-10-14T07:00:00Z' }) },
  ];
  const withCushion = pickAccount(candidates, { ...base, preferCushion: true });
  assert.equal(withCushion.chosen?.accountId, 'fat');
  assert.equal(withCushion.usedFallback, false);

  const withoutCushion = pickAccount(candidates, { ...base, preferCushion: false });
  assert.equal(withoutCushion.chosen?.accountId, 'thin', 'the base rule still prefers the soonest reset');
});

test('the cushion requirement is relaxed rather than leaving you stuck', () => {
  const result = pickAccount(
    [
      { accountId: 'a', label: 'A', snapshot: snapshot({ week: 70, weekResetsAt: '2026-10-12T07:00:00Z' }) },
      { accountId: 'b', label: 'B', snapshot: snapshot({ week: 60, weekResetsAt: '2026-10-13T07:00:00Z' }) },
    ],
    { ...base, preferCushion: true },
  );
  assert.equal(result.chosen?.accountId, 'a');
  assert.equal(result.usedFallback, true);
  assert.match(result.reason, /relaxed/);
});

test('ties break deterministically on weekly use then label', () => {
  const candidates = [
    { accountId: 'z', label: 'Zeta', snapshot: snapshot({ week: 30, weekResetsAt: '2026-10-12T07:00:00Z' }) },
    { accountId: 'a', label: 'Alpha', snapshot: snapshot({ week: 30, weekResetsAt: '2026-10-12T07:00:00Z' }) },
    { accountId: 'm', label: 'Mid', snapshot: snapshot({ week: 20, weekResetsAt: '2026-10-12T07:00:00Z' }) },
  ];
  assert.equal(pickAccount(candidates, base).chosen?.accountId, 'm');
  assert.equal(
    pickAccount(candidates.slice(0, 2), base).chosen?.accountId,
    'a',
    'equal use falls back to the label',
  );
});

test('the account in use is never offered back to itself', () => {
  const result = pickAccount(
    [{ accountId: 'only', label: 'Only', snapshot: snapshot({ week: 10 }) }],
    { ...base, excludeAccountIds: ['only'] },
  );
  assert.equal(result.chosen, undefined);
  assert.match(result.reason, /No account has quota/);
});

test('failover triggers on the window, the week and a lockout', () => {
  assert.equal(shouldFailover(snapshot({ session: 94 }), DEFAULT_POLICY), undefined);
  assert.equal(shouldFailover(snapshot({ session: 95 }), DEFAULT_POLICY), 'session-finished');
  assert.equal(shouldFailover(snapshot({ week: 96 }), DEFAULT_POLICY), 'weekly-finished');
  assert.equal(shouldFailover(snapshot({ lockedSession: true }), DEFAULT_POLICY), 'locked');
  assert.equal(shouldFailover(undefined, DEFAULT_POLICY), undefined);
});

test('only a finished 5-hour window asks for cushion', () => {
  assert.equal(prefersCushion('session-finished'), true);
  assert.equal(prefersCushion('weekly-finished'), false);
  assert.equal(prefersCushion('locked'), false);
});
