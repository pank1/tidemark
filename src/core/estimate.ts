import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as readline from 'node:readline';

import { Logger, nullLogger, redact } from './log';
import { claudeProjectsDir } from './paths';
import { Calibration, UsageSnapshot } from './types';

const SESSION_WINDOW_MS = 5 * 60 * 60 * 1000;
const WEEK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Rough cost weighting so a million cached reads does not look like a million
 * fresh output tokens. These are ratios, not prices — the absolute scale comes
 * from calibration against the real figures, so only their relative size
 * matters.
 */
const WEIGHTS = {
  input: 1,
  cacheCreation: 1.25,
  cacheRead: 0.1,
  output: 5,
} as const;

export interface LocalUsageWindows {
  sessionWeighted: number;
  weeklyWeighted: number;
  filesScanned: number;
  linesScanned: number;
  truncated: boolean;
}

export interface MeasureOptions {
  env?: NodeJS.ProcessEnv;
  now?: Date;
  logger?: Logger;
  /** Anchor for the 5-hour window, if a previous API reading told us one. */
  sessionStartedAt?: string;
  weekStartedAt?: string;
  /** Guard rails so a huge history cannot stall the extension host. */
  maxBytes?: number;
  maxMillis?: number;
}

/**
 * Adds up weighted token volume from the local session logs. Only files touched
 * inside the week window are opened, and the scan abandons itself if it grows
 * expensive — a rough number now beats an exact number in ten seconds.
 */
export async function measureLocalUsage(options: MeasureOptions = {}): Promise<LocalUsageWindows> {
  const env = options.env ?? process.env;
  const log = options.logger ?? nullLogger;
  const now = options.now ?? new Date();
  const maxBytes = options.maxBytes ?? 256 * 1024 * 1024;
  const maxMillis = options.maxMillis ?? 4000;
  const startedAt = Date.now();

  const sessionFrom = options.sessionStartedAt
    ? Date.parse(options.sessionStartedAt)
    : now.getTime() - SESSION_WINDOW_MS;
  const weekFrom = options.weekStartedAt
    ? Date.parse(options.weekStartedAt)
    : now.getTime() - WEEK_WINDOW_MS;

  const result: LocalUsageWindows = {
    sessionWeighted: 0,
    weeklyWeighted: 0,
    filesScanned: 0,
    linesScanned: 0,
    truncated: false,
  };

  let bytes = 0;
  for (const file of await transcriptFiles(claudeProjectsDir(env), weekFrom, log)) {
    if (bytes > maxBytes || Date.now() - startedAt > maxMillis) {
      result.truncated = true;
      break;
    }
    bytes += file.size;
    result.filesScanned += 1;
    try {
      await scanFile(file.path, (timestamp, weighted) => {
        result.linesScanned += 1;
        if (timestamp >= weekFrom) result.weeklyWeighted += weighted;
        if (timestamp >= sessionFrom) result.sessionWeighted += weighted;
      });
    } catch (error) {
      log.debug(`skipped ${file.path}: ${redact(error)}`);
    }
  }

  return result;
}

interface TranscriptFile {
  path: string;
  size: number;
  mtimeMs: number;
}

async function transcriptFiles(root: string, since: number, log: Logger): Promise<TranscriptFile[]> {
  const found: TranscriptFile[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4) return;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (error) {
      log.debug(`cannot list ${dir}: ${redact(error)}`);
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      try {
        const stat = await fsp.stat(full);
        if (stat.mtimeMs < since) continue;
        found.push({ path: full, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        /* vanished between readdir and stat */
      }
    }
  };
  await walk(root, 0);
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function scanFile(
  file: string,
  onEntry: (timestampMs: number, weighted: number) => void,
): Promise<void> {
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of lines) {
      if (!line || line.length < 2 || !line.includes('"usage"')) continue;
      let entry: TranscriptEntry;
      try {
        entry = JSON.parse(line) as TranscriptEntry;
      } catch {
        continue;
      }
      const usage = entry.message?.usage;
      if (!usage) continue;
      const timestamp = Date.parse(entry.timestamp ?? '');
      if (Number.isNaN(timestamp)) continue;
      onEntry(timestamp, weigh(usage));
    }
  } finally {
    lines.close();
    stream.close();
  }
}

interface TranscriptEntry {
  timestamp?: string;
  message?: {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

function weigh(usage: NonNullable<NonNullable<TranscriptEntry['message']>['usage']>): number {
  return (
    (usage.input_tokens ?? 0) * WEIGHTS.input +
    (usage.cache_creation_input_tokens ?? 0) * WEIGHTS.cacheCreation +
    (usage.cache_read_input_tokens ?? 0) * WEIGHTS.cacheRead +
    (usage.output_tokens ?? 0) * WEIGHTS.output
  );
}

/**
 * Learns how much weighted volume one percent of each window costs, from a
 * moment when both the real figures and the local logs were in hand. Averaged
 * over samples so one odd reading cannot skew it.
 */
export function updateCalibration(
  previous: Calibration | undefined,
  windows: LocalUsageWindows,
  truth: UsageSnapshot,
  now: Date = new Date(),
): Calibration {
  const next: Calibration = { ...previous, updatedAt: now.toISOString() };
  const samples = (previous?.samples ?? 0) + 1;
  next.samples = Math.min(samples, 20);

  if (truth.session.percentUsed >= 5 && windows.sessionWeighted > 0) {
    const observed = windows.sessionWeighted / truth.session.percentUsed;
    next.sessionWeightedPerPercent = blend(previous?.sessionWeightedPerPercent, observed, samples);
  }
  if (truth.week.percentUsed >= 5 && windows.weeklyWeighted > 0) {
    const observed = windows.weeklyWeighted / truth.week.percentUsed;
    next.weeklyWeightedPerPercent = blend(previous?.weeklyWeightedPerPercent, observed, samples);
  }
  return next;
}

function blend(previous: number | undefined, observed: number, samples: number): number {
  if (!previous || !Number.isFinite(previous)) return observed;
  const weight = Math.min(samples, 10);
  return (previous * (weight - 1) + observed) / weight;
}

/**
 * Builds a snapshot from local logs alone. Returns undefined when there is no
 * calibration yet — a percentage with nothing behind it would be a lie, and the
 * UI says "figures unavailable" instead.
 */
export function estimateSnapshot(
  accountId: string,
  windows: LocalUsageWindows,
  calibration: Calibration | undefined,
  options: { now?: Date; sessionResetsAt?: string | null; weekResetsAt?: string | null } = {},
): UsageSnapshot | undefined {
  const perSession = calibration?.sessionWeightedPerPercent;
  const perWeek = calibration?.weeklyWeightedPerPercent;
  if (!perSession && !perWeek) return undefined;
  const now = options.now ?? new Date();

  const sessionUsed = perSession ? clamp(windows.sessionWeighted / perSession) : 0;
  const weekUsed = perWeek ? clamp(windows.weeklyWeighted / perWeek) : 0;

  return {
    accountId,
    fetchedAt: now.toISOString(),
    source: 'estimate',
    session: {
      percentUsed: sessionUsed,
      percentLeft: clamp(100 - sessionUsed),
      resetsAt: options.sessionResetsAt ?? null,
      severity: sessionUsed >= 95 ? 'critical' : sessionUsed >= 75 ? 'warning' : 'normal',
      locked: false,
      lockedReason: null,
    },
    week: {
      percentUsed: weekUsed,
      percentLeft: clamp(100 - weekUsed),
      resetsAt: options.weekResetsAt ?? null,
      severity: weekUsed >= 95 ? 'critical' : weekUsed >= 75 ? 'warning' : 'normal',
      locked: false,
      lockedReason: null,
    },
    scoped: [],
    breakdown: [],
  };
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value * 10) / 10));
}
