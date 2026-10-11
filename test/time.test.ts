import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compareResetSoonest, formatCountdown, formatRelative, minutesSince, msUntil } from '../src/core/time';

const NOW = new Date('2026-10-10T09:00:00Z');

test('countdowns are compact and never negative', () => {
  assert.equal(formatCountdown(undefined), '—');
  assert.equal(formatCountdown(-5_000), 'now', 'clock skew must not print a negative');
  assert.equal(formatCountdown(38_000), '38s');
  assert.equal(formatCountdown(41 * 60_000), '41m');
  assert.equal(formatCountdown(2 * 3_600_000 + 41 * 60_000), '2h41m');
  assert.equal(formatCountdown(3 * 86_400_000 + 4 * 3_600_000), '3d 4h');
  assert.equal(formatCountdown(3 * 86_400_000), '3d');
});

test('relative times read like speech', () => {
  assert.equal(formatRelative(undefined, NOW), 'never');
  assert.equal(formatRelative('2026-10-10T08:59:30Z', NOW), 'just now');
  assert.equal(formatRelative('2026-10-10T08:56:00Z', NOW), '4m ago');
  assert.equal(formatRelative('2026-10-10T07:00:00Z', NOW), '2h ago');
  assert.equal(formatRelative('2026-10-07T09:00:00Z', NOW), '3d ago');
  assert.equal(formatRelative('not a date', NOW), 'unknown');
});

test('msUntil copes with nothing and with nonsense', () => {
  assert.equal(msUntil(undefined, NOW), undefined);
  assert.equal(msUntil('nonsense', NOW), undefined);
  assert.equal(msUntil('2026-10-10T10:00:00Z', NOW), 3_600_000);
});

test('unparseable reset times sort last so they cannot win a failover', () => {
  const ordered = ['2026-10-12T00:00:00Z', undefined, '2026-10-11T00:00:00Z', 'rubbish'].sort(
    compareResetSoonest,
  );
  assert.deepEqual(ordered.slice(0, 2), ['2026-10-11T00:00:00Z', '2026-10-12T00:00:00Z']);
});

test('a missing timestamp is infinitely stale', () => {
  assert.equal(minutesSince(undefined, NOW), Number.POSITIVE_INFINITY);
  assert.equal(minutesSince('2026-10-10T08:30:00Z', NOW), 30);
});
