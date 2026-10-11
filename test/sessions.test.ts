import assert from 'node:assert/strict';
import { test } from 'node:test';

import { descendantsOf, discoverSessions, isClaudeProcess, parsePpidFromStat, parsePsOutput } from '../src/core/sessions';

const EXTENSION_BINARY =
  '/home/dev/.vscode/extensions/anthropic.claude-code-2.1.296-linux-x64/resources/native-binary/claude --output-format stream-json';

test('the Claude Code binary is recognised however it was installed', () => {
  assert.equal(isClaudeProcess(EXTENSION_BINARY), true);
  assert.equal(isClaudeProcess('/Users/x/.claude/local/node_modules/.bin/claude'), true);
  assert.equal(
    isClaudeProcess('/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'),
    true,
  );
  assert.equal(isClaudeProcess('/home/dev/.local/bin/claude --continue'), true);
});

test('things that merely mention claude are left alone', () => {
  assert.equal(isClaudeProcess(''), false);
  assert.equal(isClaudeProcess('tail -f /home/dev/.claude/logs/app.log'), false);
  assert.equal(isClaudeProcess('node /srv/app/server.js --name claudette'), false);
  assert.equal(isClaudeProcess('grep claude /etc/hosts'), false);
});

test('a process name containing brackets does not break ppid parsing', () => {
  assert.equal(parsePpidFromStat('123 (claude) S 99 123 99 0 -1 4194304 0'), 99);
  assert.equal(parsePpidFromStat('123 (my (odd) name) S 42 123 42 0'), 42);
  assert.equal(parsePpidFromStat('nonsense'), 1);
});

test('descendants are found through intermediate processes', () => {
  const table = [
    { pid: 1, ppid: 0, command: 'init' },
    { pid: 10, ppid: 1, command: 'code' },
    { pid: 20, ppid: 10, command: 'extension-host' },
    { pid: 30, ppid: 20, command: 'claude' },
    { pid: 40, ppid: 1, command: 'other-window' },
    { pid: 50, ppid: 40, command: 'claude' },
  ];
  const mine = descendantsOf(20, table);
  assert.equal(mine.has(30), true);
  assert.equal(mine.has(50), false);
});

test('sessions are split into this window and the rest', async () => {
  const table = [
    { pid: 20, ppid: 1, command: 'extension-host' },
    { pid: 30, ppid: 20, command: EXTENSION_BINARY },
    { pid: 50, ppid: 99, command: EXTENSION_BINARY },
    { pid: 60, ppid: 1, command: 'bash' },
  ];
  const sessions = await discoverSessions({ selfPid: 20, readTable: async () => table });
  assert.deepEqual(
    sessions.map((session) => [session.pid, session.ownWindow]),
    [
      [30, true],
      [50, false],
    ],
  );
});

test('ps output is parsed including commands with spaces', () => {
  const parsed = parsePsOutput(
    [' 1234  1 /path/to/claude --flag value', '   7  1 /sbin/launchd', 'garbage line'].join('\n'),
  );
  assert.deepEqual(parsed, [
    { pid: 1234, ppid: 1, command: '/path/to/claude --flag value' },
    { pid: 7, ppid: 1, command: '/sbin/launchd' },
  ]);
});
