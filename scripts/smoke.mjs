/**
 * Starts the built extension against a stub of the VS Code API, with a throwaway
 * Claude config directory, and reports what it did.
 *
 * It proves the things a unit test cannot: that `activate` runs to completion,
 * that every contributed command is registered, that a fresh install with one
 * sign-in adopts it, and that an unusable token degrades quietly instead of
 * throwing. No editor, no network credentials, nothing of yours is touched.
 *
 *   node scripts/smoke.mjs
 */
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const root = mkdtempSync(join(tmpdir(), 'tidemark-smoke-'));
const claudeDir = join(root, 'claude');
const stateDir = join(root, 'state');
mkdirSync(claudeDir, { recursive: true });
mkdirSync(stateDir, { recursive: true });
writeFileSync(
  join(claudeDir, '.credentials.json'),
  JSON.stringify({
    claudeAiOauth: {
      accessToken: 'sk-ant-oat01-smoke-test-not-a-real-token',
      refreshToken: 'sk-ant-ort01-smoke-test-not-a-real-token',
      expiresAt: Date.now() + 3_600_000,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max',
    },
  }),
  { mode: 0o600 },
);
process.env.CLAUDE_CONFIG_DIR = claudeDir;
process.env.TIDEMARK_DIR = stateDir;

const registered = new Set();
const shown = [];
const contextKeys = new Map();
let statusText = '';

class Emitter {
  constructor() {
    this.listeners = new Set();
  }
  get event() {
    return (listener) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
  }
  fire(value) {
    for (const listener of this.listeners) listener(value);
  }
  dispose() {
    this.listeners.clear();
  }
}

const settings = {
  'tidemark.sync.enabled': false,
  'tidemark.failover.enabled': false,
  'tidemark.statusBar.enabled': true,
};

const vscode = {
  version: '1.94.0-smoke',
  EventEmitter: Emitter,
  Disposable: class {
    constructor(fn) {
      this.dispose = fn ?? (() => {});
    }
  },
  ThemeIcon: class {
    constructor(id, color) {
      this.id = id;
      this.color = color;
    }
  },
  ThemeColor: class {
    constructor(id) {
      this.id = id;
    }
  },
  MarkdownString: class {
    constructor(value) {
      this.value = value;
    }
  },
  TreeItem: class {
    constructor(label, collapsibleState) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  QuickPickItemKind: { Separator: -1, Default: 0 },
  ProgressLocation: { Notification: 15 },
  ConfigurationTarget: { Global: 1 },
  Uri: { parse: (value) => ({ toString: () => value }) },
  env: { clipboard: { writeText: async () => {} } },
  commands: {
    registerCommand: (id) => {
      registered.add(id);
      return { dispose() {} };
    },
    executeCommand: async (id, ...args) => {
      if (id === 'setContext') contextKeys.set(args[0], args[1]);
      return undefined;
    },
    getCommands: async () => [...registered],
  },
  window: {
    createOutputChannel: () => ({
      error: () => {},
      warn: () => {},
      info: () => {},
      debug: () => {},
      show: () => {},
      dispose: () => {},
    }),
    createStatusBarItem: () => ({
      show: () => {},
      hide: () => {},
      dispose: () => {},
      set text(value) {
        statusText = value;
      },
      get text() {
        return statusText;
      },
    }),
    createTreeView: () => ({ dispose: () => {} }),
    showInformationMessage: async (message) => {
      shown.push(['info', message]);
      return undefined;
    },
    showWarningMessage: async (message) => {
      shown.push(['warn', message]);
      return undefined;
    },
    showErrorMessage: async (message) => {
      shown.push(['error', message]);
      return undefined;
    },
    setStatusBarMessage: () => ({ dispose: () => {} }),
    withProgress: async (_options, task) => task({ report: () => {} }, { isCancellationRequested: false }),
    showInputBox: async () => undefined,
    showQuickPick: async () => undefined,
    createQuickPick: () => ({ onDidAccept() {}, onDidHide() {}, onDidTriggerButton() {}, show() {}, hide() {}, dispose() {} }),
  },
  workspace: {
    getConfiguration: () => ({
      get: (key, fallback) => (key in settings ? settings[key] : fallback),
      update: async (key, value) => {
        settings[key] = value;
      },
    }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    openTextDocument: async () => ({}),
  },
};

const load = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'vscode') return vscode;
  return load.call(this, request, parent, isMain);
};

const extension = require('../dist/extension.js');
const context = {
  subscriptions: [],
  secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
  extension: { id: 'smoke.tidemark', packageJSON: { version: '0.1.0' } },
};

const declared = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  .contributes.commands.map((command) => command.command);

await extension.activate(context);
await new Promise((resolve) => setTimeout(resolve, 2500));

const missing = declared.filter((command) => !registered.has(command));
const profilesPath = join(stateDir, 'profiles.json');
const profiles = existsSync(profilesPath) ? JSON.parse(readFileSync(profilesPath, 'utf8')).profiles : [];

console.log('registered commands :', registered.size, missing.length ? `MISSING ${missing}` : '(all declared ones present)');
console.log('status bar          :', JSON.stringify(statusText));
console.log('accounts adopted    :', profiles.length, profiles.map((p) => p.label).join(', '));
console.log('messages shown      :', shown.length === 0 ? '(none — quiet, as it should be with a dead token)' : shown);
console.log('disposables         :', context.subscriptions.length);

for (const disposable of context.subscriptions) disposable.dispose?.();
extension.deactivate();

const problems = [];
if (missing.length > 0) problems.push(`commands not registered: ${missing.join(', ')}`);
if (profiles.length !== 1) problems.push(`expected the existing sign-in to be adopted once, got ${profiles.length}`);
if (shown.some(([kind]) => kind === 'error')) problems.push('an error dialog was shown for an unreachable account');
if (!statusText) problems.push('the status bar was never given any text');

if (problems.length > 0) {
  console.error('\nFAILED:\n - ' + problems.join('\n - '));
  process.exit(1);
}
console.log('\nOK — activates cleanly, adopts the existing sign-in, degrades quietly.');
