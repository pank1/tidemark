import * as vscode from 'vscode';

import { Tidemark } from './controller';
import { ApiClient } from './core/api';
import { CredentialStore, ensureTidemarkDir } from './core/credstore';
import { LogLevel, Logger } from './core/log';
import { ProfileStore } from './core/profiles';
import { showDoctor } from './ui/doctor';
import { oneLine } from './ui/format';
import { PassphraseHolder } from './ui/passphrase';
import { showAccountSwitcher } from './ui/quickpick';
import { StatusBar } from './ui/statusbar';
import { runSyncSetup } from './ui/syncSetup';
import { AccountsTree } from './ui/tree';
import { runAddAccountWizard } from './ui/wizard';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('Tidemark', { log: true });
  const log = makeLogger(output);
  const version = (context.extension.packageJSON as { version?: string }).version ?? '0.0.0';

  await ensureTidemarkDir();

  const store = new ProfileStore(process.env, log);
  const credentials = new CredentialStore({ logger: log });
  const api = new ApiClient({ logger: log });
  const passphrase = new PassphraseHolder(context.secrets, log);
  const tidemark = new Tidemark(context, log, store, credentials, api, passphrase);

  const statusBar = new StatusBar(tidemark);
  const tree = new AccountsTree(tidemark);
  const treeView = vscode.window.createTreeView('tidemark.accounts', {
    treeDataProvider: tree,
    showCollapseAll: true,
  });

  context.subscriptions.push(
    output,
    tidemark,
    statusBar,
    tree,
    treeView,
    passphrase.onDidChange(() => tidemark.notifyChanged()),
  );

  const register = (command: string, handler: (...args: never[]) => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(command, handler));
  };

  register('tidemark.switch', () => showAccountSwitcher(tidemark));

  register('tidemark.switchToAccount', async (accountId: string) => {
    const result = await tidemark.switchTo(accountId);
    if (result.ok) void vscode.window.showInformationMessage(result.message);
    else void vscode.window.showWarningMessage(result.message);
  });

  register('tidemark.refresh', async () => {
    await vscode.window.withProgress(
      { location: { viewId: 'tidemark.accounts' }, title: 'Refreshing usage' },
      () => tidemark.refresh({ force: true }),
    );
    const active = tidemark.activeView();
    if (active) void vscode.window.setStatusBarMessage(`Tidemark: ${oneLine(active)}`, 6000);
  });

  register('tidemark.captureCurrent', async () => {
    await tidemark.captureCurrent();
  });

  register('tidemark.addAccount', () => runAddAccountWizard(tidemark));

  register('tidemark.renameAccount', async (argument?: unknown) => {
    const accountId = await resolveAccountId(tidemark, argument, 'Rename which account?');
    if (!accountId) return;
    const profile = tidemark.store.get(accountId);
    if (!profile) return;
    const label = await vscode.window.showInputBox({
      title: 'Rename account',
      value: profile.label,
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? undefined : 'A name is required.'),
    });
    if (!label) return;
    await tidemark.renameAccount(accountId, label.trim());
  });

  register('tidemark.removeAccount', async (argument?: unknown) => {
    const accountId = await resolveAccountId(tidemark, argument, 'Remove which account?');
    if (!accountId) return;
    const profile = tidemark.store.get(accountId);
    if (!profile) return;
    const isActive = tidemark.store.state.activeAccountId === accountId;
    const choice = await vscode.window.showWarningMessage(
      `Remove “${profile.label}” from Tidemark?`,
      {
        modal: true,
        detail: isActive
          ? 'This is the account in use. Claude Code stays signed in to it, but Tidemark will no longer hold a copy of the sign-in, so you could not switch back to it without signing in again.'
          : 'Claude Code is not using this account. Tidemark will forget its sign-in; you would need to sign in again to use it.',
      },
      'Remove',
    );
    if (choice !== 'Remove') return;
    await tidemark.removeAccount(accountId);
  });

  register('tidemark.doctor', () => showDoctor(tidemark, version));

  register('tidemark.copySummary', async () => {
    const views = tidemark.views();
    if (views.length === 0) {
      void vscode.window.showInformationMessage('No accounts to summarise yet.');
      return;
    }
    const text = views
      .map((view) => `${view.isActive ? '*' : '-'} ${view.profile.label}: ${oneLine(view)}`)
      .join('\n');
    await vscode.env.clipboard.writeText(text);
    void vscode.window.showInformationMessage('Usage summary copied.');
  });

  register('tidemark.syncSetup', () => runSyncSetup(tidemark));

  register('tidemark.syncPull', async () => {
    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Pulling accounts' },
        () => tidemark.sync.pull({ purpose: 'read your synced accounts' }),
      );
      void vscode.window.showInformationMessage(result.message);
      await tidemark.refresh({ force: true });
    } catch (error) {
      tidemark.reportQuietly('sync pull', error);
    }
  });

  register('tidemark.syncPush', async () => {
    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Pushing accounts' },
        () => tidemark.sync.push('manual push'),
      );
      void vscode.window.showInformationMessage(result.message);
    } catch (error) {
      tidemark.reportQuietly('sync push', error);
    }
  });

  register('tidemark.unlock', async () => {
    const passphraseValue = await passphrase.get('unlock your synced accounts');
    if (!passphraseValue) return;
    await vscode.commands.executeCommand('tidemark.syncPull');
  });

  register('tidemark.lock', async () => {
    await passphrase.lock();
    void vscode.window.showInformationMessage('Tidemark locked. The passphrase will be asked for again when needed.');
  });

  register('tidemark.toggleFailover', async () => {
    const configuration = vscode.workspace.getConfiguration();
    const next = !configuration.get<boolean>('tidemark.failover.enabled', false);
    await configuration.update('tidemark.failover.enabled', next, vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage(
      next
        ? 'Auto-failover is on. When the account in use runs out, Tidemark will move to the account whose weekly quota expires soonest.'
        : 'Auto-failover is off.',
    );
  });

  register('tidemark.showLogs', () => output.show(true));

  register('tidemark.openWalkthrough', () =>
    vscode.commands.executeCommand(
      'workbench.action.openWalkthrough',
      `${context.extension.id}#tidemark.gettingStarted`,
      false,
    ),
  );

  await tidemark.initialize();
  void maybeGreet(tidemark);
}

export function deactivate(): void {
  /* disposables handle everything */
}

async function maybeGreet(tidemark: Tidemark): Promise<void> {
  if (tidemark.store.state.firstRunShown) return;
  await tidemark.store.patchState({ firstRunShown: true });

  const hasAccount = tidemark.store.list().length > 0;
  const choice = await vscode.window.showInformationMessage(
    hasAccount
      ? 'Tidemark is showing your Claude quota in the status bar. Click it to see both windows and to switch accounts.'
      : 'Tidemark is installed. Sign in with Claude Code and it will start showing how much quota you have left.',
    'Open walkthrough',
    'Add another account',
  );
  if (choice === 'Open walkthrough') await vscode.commands.executeCommand('tidemark.openWalkthrough');
  if (choice === 'Add another account') await vscode.commands.executeCommand('tidemark.addAccount');
}

async function resolveAccountId(
  tidemark: Tidemark,
  argument: unknown,
  title: string,
): Promise<string | undefined> {
  if (typeof argument === 'string') return argument;
  const fromTree = (argument as { view?: { profile?: { id?: string } } } | undefined)?.view?.profile?.id;
  if (fromTree) return fromTree;

  const views = tidemark.views();
  if (views.length === 0) {
    void vscode.window.showInformationMessage('No accounts are saved.');
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    views.map((view) => ({
      label: view.profile.label,
      description: view.isActive ? 'in use' : '',
      detail: oneLine(view),
      id: view.profile.id,
    })),
    { title, ignoreFocusOut: true },
  );
  return picked?.id;
}

function makeLogger(output: vscode.LogOutputChannel): Logger {
  const enabled = (level: LogLevel): boolean => {
    const configured = vscode.workspace
      .getConfiguration()
      .get<LogLevel>('tidemark.logLevel', 'info');
    const order: LogLevel[] = ['error', 'warn', 'info', 'debug'];
    return order.indexOf(level) <= order.indexOf(configured);
  };
  return {
    error: (message) => output.error(message),
    warn: (message) => {
      if (enabled('warn')) output.warn(message);
    },
    info: (message) => {
      if (enabled('info')) output.info(message);
    },
    debug: (message) => {
      if (enabled('debug')) output.debug(message);
    },
  };
}
