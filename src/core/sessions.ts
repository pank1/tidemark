import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { promisify } from 'node:util';

import { Logger, nullLogger, redact } from './log';

const run = promisify(execFile);

export interface ProcessInfo {
  pid: number;
  ppid: number;
  command: string;
}

export interface ClaudeSession {
  pid: number;
  ppid: number;
  command: string;
  /**
   * True when this process descends from our own extension host, i.e. it is a
   * session in *this* VS Code window. Reloading the window restarts these
   * cleanly, so they never need killing (D-10, hazard H2).
   */
  ownWindow: boolean;
}

export interface DiscoverOptions {
  platform?: NodeJS.Platform;
  logger?: Logger;
  /** Our own pid; descendants of it are treated as this window's sessions. */
  selfPid?: number;
  readTable?: () => Promise<ProcessInfo[]>;
}

/** Locates the Claude Code sessions running on this machine. */
export async function discoverSessions(options: DiscoverOptions = {}): Promise<ClaudeSession[]> {
  const log = options.logger ?? nullLogger;
  const platform = options.platform ?? process.platform;
  const selfPid = options.selfPid ?? process.pid;
  const read = options.readTable ?? (() => readProcessTable(platform, log));

  const table = await read();
  const byPid = new Map(table.map((info) => [info.pid, info]));
  const ours = descendantsOf(selfPid, table);

  return table
    .filter((info) => isClaudeProcess(info.command))
    .map((info) => ({
      pid: info.pid,
      ppid: info.ppid,
      command: info.command,
      ownWindow: ours.has(info.pid) || ours.has(info.ppid) || byPid.get(info.ppid)?.pid === selfPid,
    }));
}

/**
 * Matches the Claude Code binary, however it was installed: the VS Code
 * extension's bundled binary, the native installer under `~/.local`, or a
 * global npm install. Deliberately narrow — killing the wrong `claude` would be
 * unforgivable, so a bare word match is not enough.
 */
export function isClaudeProcess(command: string): boolean {
  if (!command) return false;
  if (/node(\.exe)?\s/.test(command) && !/claude/.test(command)) return false;
  return (
    /resources[\\/]native-binary[\\/]claude/.test(command) ||
    /[\\/]\.claude[\\/]local[\\/].*claude/.test(command) ||
    /[\\/]@anthropic-ai[\\/]claude-code[\\/]/.test(command) ||
    /[\\/]claude(\.exe)?(\s|$)/.test(command)
  );
}

export function descendantsOf(root: number, table: ProcessInfo[]): Set<number> {
  const children = new Map<number, number[]>();
  for (const info of table) {
    const list = children.get(info.ppid) ?? [];
    list.push(info.pid);
    children.set(info.ppid, list);
  }
  const seen = new Set<number>();
  const queue = [root];
  while (queue.length > 0) {
    const pid = queue.pop()!;
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  return seen;
}

export async function readProcessTable(
  platform: NodeJS.Platform = process.platform,
  log: Logger = nullLogger,
): Promise<ProcessInfo[]> {
  if (platform === 'linux') {
    const fromProc = await readLinuxProc(log);
    if (fromProc.length > 0) return fromProc;
  }
  if (platform === 'win32') return readWindowsTable(log);
  return readPosixPs(log);
}

async function readLinuxProc(log: Logger): Promise<ProcessInfo[]> {
  const table: ProcessInfo[] = [];
  let entries: string[];
  try {
    entries = await fs.readdir('/proc');
  } catch (error) {
    log.debug(`/proc unavailable: ${redact(error)}`);
    return table;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    try {
      const [cmdlineRaw, statRaw] = await Promise.all([
        fs.readFile(`/proc/${pid}/cmdline`, 'utf8'),
        fs.readFile(`/proc/${pid}/stat`, 'utf8'),
      ]);
      const command = cmdlineRaw.replace(/\0+$/, '').split('\0').join(' ').trim();
      if (!command) continue;
      table.push({ pid, ppid: parsePpidFromStat(statRaw), command });
    } catch {
      /* process exited while we were reading it */
    }
  }
  return table;
}

/**
 * `/proc/<pid>/stat` puts the executable name in parentheses and it may itself
 * contain spaces or brackets, so fields are counted from the last `)`.
 */
export function parsePpidFromStat(stat: string): number {
  const close = stat.lastIndexOf(')');
  const rest = stat.slice(close + 2).trim().split(/\s+/);
  const ppid = Number(rest[1]);
  return Number.isFinite(ppid) ? ppid : 1;
}

async function readPosixPs(log: Logger): Promise<ProcessInfo[]> {
  try {
    const { stdout } = await run('/bin/ps', ['-axo', 'pid=,ppid=,command='], {
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return parsePsOutput(stdout);
  } catch (error) {
    log.debug(`ps failed: ${redact(error)}`);
    return [];
  }
}

export function parsePsOutput(stdout: string): ProcessInfo[] {
  const table: ProcessInfo[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    table.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]!.trim() });
  }
  return table;
}

async function readWindowsTable(log: Logger): Promise<ProcessInfo[]> {
  try {
    const { stdout } = await run(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress',
      ],
      { timeout: 20_000, maxBuffer: 16 * 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout) as
      | { ProcessId: number; ParentProcessId: number; CommandLine?: string }[]
      | { ProcessId: number; ParentProcessId: number; CommandLine?: string };
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.map((row) => ({
      pid: row.ProcessId,
      ppid: row.ParentProcessId,
      command: row.CommandLine ?? '',
    }));
  } catch (error) {
    log.debug(`windows process listing failed: ${redact(error)}`);
    return [];
  }
}

export interface TerminateResult {
  asked: number[];
  forced: number[];
  survived: number[];
}

/**
 * Asks each session to exit, then insists. The grace period exists so a session
 * mid-write gets to finish; after it, a stuck process must not block the switch.
 */
export async function terminate(
  pids: number[],
  options: { graceSeconds?: number; logger?: Logger; signal?: (pid: number, sig: NodeJS.Signals) => void } = {},
): Promise<TerminateResult> {
  const log = options.logger ?? nullLogger;
  const grace = Math.max(0, options.graceSeconds ?? 3) * 1000;
  const send =
    options.signal ??
    ((pid: number, sig: NodeJS.Signals) => {
      process.kill(pid, sig);
    });

  const asked: number[] = [];
  for (const pid of pids) {
    try {
      send(pid, 'SIGTERM');
      asked.push(pid);
    } catch (error) {
      log.debug(`SIGTERM to ${pid} failed: ${redact(error)}`);
    }
  }

  if (asked.length === 0) return { asked, forced: [], survived: [] };

  const deadline = Date.now() + grace;
  let alive = asked.filter(isAlive);
  while (alive.length > 0 && Date.now() < deadline) {
    await delay(200);
    alive = alive.filter(isAlive);
  }

  const forced: number[] = [];
  for (const pid of alive) {
    try {
      send(pid, 'SIGKILL');
      forced.push(pid);
    } catch (error) {
      log.debug(`SIGKILL to ${pid} failed: ${redact(error)}`);
    }
  }

  await delay(forced.length > 0 ? 300 : 0);
  return { asked, forced, survived: asked.filter(isAlive) };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
