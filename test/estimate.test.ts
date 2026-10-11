import assert from 'node:assert/strict';
import { test } from 'node:test';

import { estimateSnapshot, updateCalibration } from '../src/core/estimate';
import { LocalUsageWindows } from '../src/core/estimate';
import { UsageSnapshot } from '../src/core/types';

const NOW = new Date('2026-10-10T09:00:00Z');

function windows(session: number, weekly: number): LocalUsageWindows {
  return { sessionWeighted: session, weeklyWeighted: weekly, filesScanned: 1, linesScanned: 10, truncated: false };
}

function truth(sessionPercent: number, weekPercent: number): UsageSnapshot {
  return {
    accountId: 'a',
    fetchedAt: NOW.toISOString(),
    source: 'api',
    session: { percentUsed: sessionPercent, percentLeft: 100 - sessionPercent, resetsAt: null, severity: 'normal', locked: false },
    week: { percentUsed: weekPercent, percentLeft: 100 - weekPercent, resetsAt: null, severity: 'normal', locked: false },
    scoped: [],
    breakdown: [],
  };
}

test('an estimate is withheld until there is something to scale against', () => {
  assert.equal(estimateSnapshot('a', windows(1000, 5000), undefined, { now: NOW }), undefined);
  assert.equal(estimateSnapshot('a', windows(1000, 5000), { samples: 0 }, { now: NOW }), undefined);
});

test('calibration turns token volume into a percentage', () => {
  const calibration = updateCalibration(undefined, windows(2000, 14_000), truth(20, 70), NOW);
  assert.equal(calibration.sessionWeightedPerPercent, 100);
  assert.equal(calibration.weeklyWeightedPerPercent, 200);

  const snapshot = estimateSnapshot('a', windows(3000, 10_000), calibration, { now: NOW });
  assert.equal(snapshot?.source, 'estimate');
  assert.equal(snapshot?.session.percentUsed, 30);
  assert.equal(snapshot?.week.percentUsed, 50);
  assert.equal(snapshot?.week.percentLeft, 50);
});

test('readings below five percent are ignored, being mostly noise', () => {
  const calibration = updateCalibration(undefined, windows(50, 50), truth(2, 3), NOW);
  assert.equal(calibration.sessionWeightedPerPercent, undefined);
  assert.equal(calibration.weeklyWeightedPerPercent, undefined);
});

test('later readings are blended in rather than replacing the old one', () => {
  let calibration = updateCalibration(undefined, windows(1000, 1000), truth(10, 10), NOW);
  assert.equal(calibration.sessionWeightedPerPercent, 100);
  calibration = updateCalibration(calibration, windows(3000, 3000), truth(10, 10), NOW);
  assert.equal(calibration.sessionWeightedPerPercent, 200, 'the average of 100 and 300');
  assert.equal(calibration.samples, 2);
});

test('an estimate cannot exceed a hundred percent', () => {
  const snapshot = estimateSnapshot(
    'a',
    windows(1_000_000, 1_000_000),
    { sessionWeightedPerPercent: 10, weeklyWeightedPerPercent: 10 },
    { now: NOW },
  );
  assert.equal(snapshot?.session.percentUsed, 100);
  assert.equal(snapshot?.session.percentLeft, 0);
});

test('reset times from the last real reading are carried over', () => {
  const snapshot = estimateSnapshot(
    'a',
    windows(100, 100),
    { sessionWeightedPerPercent: 10, weeklyWeightedPerPercent: 10 },
    { now: NOW, sessionResetsAt: '2026-10-10T12:00:00Z', weekResetsAt: '2026-10-15T07:00:00Z' },
  );
  assert.equal(snapshot?.session.resetsAt, '2026-10-10T12:00:00Z');
  assert.equal(snapshot?.week.resetsAt, '2026-10-15T07:00:00Z');
});
