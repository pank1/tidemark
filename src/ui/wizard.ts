import * as vscode from 'vscode';

import { Tidemark } from '../controller';
import { StoredCredentials } from '../core/types';

const LOGOUT_COMMAND = 'claude-vscode.logout';
const SIGN_IN_HINTS = [
  'claude-vscode.newConversation',
  'claude-vscode.editor.open',
  'claude-vscode.sidebar.open',
];

/**
 * Adding a second account.
 *
 * Tidemark never performs the sign-in itself (D-02): Claude Code's own login
 * does that, and this wizard only saves what comes out of it. The steps are
 * explicit because the middle of the flow is the one moment the user is signed
 * out, and they should know why.
 */
export async function runAddAccountWizard(tidemark: Tidemark): Promise<void> {
  const existing = tidemark.store.list();
  const start = await vscode.window.showInformationMessage(
    'Add another Claude account',
    {
      modal: true,
      detail: [
        'Tidemark will:',
        '',
        `1. Save the account you are using now${existing.length > 0 ? ' (if it is not saved already)' : ''}.`,
        '2. Sign Claude Code out.',
        '3. Wait while you sign in with the other account.',
        '4. Save that one too, so you can move between them from the status bar.',
        '',
        'You can stop at any point. Nothing is sent anywhere.',
      ].join('\n'),
    },
    'Start',
  );
  if (start !== 'Start') return;

  const saved = await tidemark.captureCurrent({ silent: true });
  const known = new Set(
    tidemark.store.list().map((profile) => profile.credentials.claudeAiOauth.refreshToken),
  );

  const commands = await vscode.commands.getCommands(true);
  if (commands.includes(LOGOUT_COMMAND)) {
    try {
      await vscode.commands.executeCommand(LOGOUT_COMMAND);
    } catch (error) {
      tidemark.log.warn(`Claude Code's logout command failed: ${String(error)}`);
    }
  } else {
    const manual = await vscode.window.showInformationMessage(
      'Sign out of Claude Code yourself',
      {
        modal: true,
        detail:
          'Run “Claude Code: Logout” from the Command Palette, or /logout in a Claude session, then come back here and choose Continue.',
      },
      'Continue',
    );
    if (manual !== 'Continue') return;
  }

  const fresh = await waitForNewLogin(tidemark, known);
  if (!fresh) {
    const retry = await vscode.window.showWarningMessage(
      saved
        ? `No new sign-in was detected. “${saved.label}” is still saved — switch back to it from the status bar whenever you like.`
        : 'No new sign-in was detected.',
      'Open Claude Code',
    );
    if (retry === 'Open Claude Code') {
      for (const command of SIGN_IN_HINTS) {
        if (commands.includes(command)) {
          await vscode.commands.executeCommand(command);
          break;
        }
      }
    }
    return;
  }

  const profile = await tidemark.captureCurrent({ silent: true });
  if (!profile) {
    void vscode.window.showWarningMessage('The new sign-in could not be saved. Run Tidemark: Doctor for detail.');
    return;
  }

  const label = await vscode.window.showInputBox({
    title: 'Name this account',
    value: profile.label,
    prompt: 'Only you see this. The email address works well.',
    ignoreFocusOut: true,
  });
  if (label && label.trim() && label.trim() !== profile.label) {
    await tidemark.renameAccount(profile.id, label.trim());
  }

  const total = tidemark.store.list().length;
  const next = await vscode.window.showInformationMessage(
    `Saved. You now have ${total} account${total === 1 ? '' : 's'}; click the status bar to move between them.`,
    ...(tidemark.settings().sync.enabled ? ['Push to sync'] : ['Set up sync']),
  );
  if (next === 'Push to sync') await vscode.commands.executeCommand('tidemark.syncPush');
  if (next === 'Set up sync') await vscode.commands.executeCommand('tidemark.syncSetup');
}

/**
 * Watches the credential store for a sign-in we have not seen before. Polling
 * is deliberate: a file watcher misses the macOS keychain, and two seconds is
 * imperceptible next to typing a password.
 */
async function waitForNewLogin(
  tidemark: Tidemark,
  known: Set<string>,
): Promise<StoredCredentials | undefined> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Waiting for the next Claude sign-in…',
      cancellable: true,
    },
    async (progress, token) => {
      progress.report({ message: 'Sign in with the other account in Claude Code.' });
      const deadline = Date.now() + 10 * 60_000;
      while (Date.now() < deadline && !token.isCancellationRequested) {
        const current = await tidemark.credentials.read();
        const refresh = current?.claudeAiOauth.refreshToken;
        if (current && refresh && !known.has(refresh)) return current;
        await delay(2000);
      }
      return undefined;
    },
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
