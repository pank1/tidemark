import * as vscode from 'vscode';

import { Tidemark } from '../controller';

/**
 * Sets up the encrypted bundle in the user's own private repository. Two paths:
 * this is the first machine, or another machine already created the bundle.
 */
export async function runSyncSetup(tidemark: Tidemark): Promise<void> {
  const intro = await vscode.window.showInformationMessage(
    'Carry your accounts between machines',
    {
      modal: true,
      detail: [
        'Your accounts are put into a single file, encrypted with a passphrase you choose, and committed to a private git repository that you own.',
        '',
        'Any machine with that repository and the passphrase has every account, with no further signing in.',
        '',
        'Use a private repository. Only the encrypted file and a small "which machine is on which account" note are written to it.',
      ].join('\n'),
    },
    'Continue',
  );
  if (intro !== 'Continue') return;

  const configuration = vscode.workspace.getConfiguration();
  const repository = await vscode.window.showInputBox({
    title: 'Sync repository',
    prompt: 'The git remote for your private accounts repository.',
    placeHolder: 'git@github.com:you/claude-accounts.git',
    value: configuration.get<string>('tidemark.sync.repository', ''),
    ignoreFocusOut: true,
    validateInput: (value) => {
      const trimmed = value.trim();
      if (!trimmed) return 'A git remote is required.';
      if (!/^(git@|ssh:\/\/|https:\/\/|file:\/\/|\/)/.test(trimmed)) {
        return 'That does not look like a git remote.';
      }
      return undefined;
    },
  });
  if (!repository) return;

  const branch =
    (await vscode.window.showInputBox({
      title: 'Branch',
      value: configuration.get<string>('tidemark.sync.branch', 'main'),
      ignoreFocusOut: true,
    })) ?? 'main';

  const role = await vscode.window.showQuickPick(
    [
      {
        label: '$(cloud-upload) This is the first machine',
        detail: 'Create the encrypted bundle from the accounts saved here and push it',
        value: 'create' as const,
      },
      {
        label: '$(cloud-download) Another machine already set this up',
        detail: 'Pull the existing bundle and add its accounts to this machine',
        value: 'join' as const,
      },
    ],
    { title: 'Which is it?', ignoreFocusOut: true },
  );
  if (!role) return;

  const passphrase =
    role.value === 'create'
      ? await tidemark.passphrase.createNew()
      : await tidemark.passphrase.get('open the synced accounts');
  if (!passphrase) return;

  await configuration.update('tidemark.sync.repository', repository.trim(), vscode.ConfigurationTarget.Global);
  await configuration.update('tidemark.sync.branch', branch.trim() || 'main', vscode.ConfigurationTarget.Global);
  await configuration.update('tidemark.sync.enabled', true, vscode.ConfigurationTarget.Global);

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Tidemark sync', cancellable: false },
    async (progress) => {
      try {
        if (role.value === 'create') {
          progress.report({ message: 'encrypting and pushing your accounts…' });
          const result = await tidemark.sync.push('first push from this machine');
          void vscode.window.showInformationMessage(
            result.pushed
              ? `Sync is on. ${tidemark.store.list().length} account(s) are now in ${repository.trim()}.`
              : 'Sync is on, but there was nothing new to push.',
          );
        } else {
          progress.report({ message: 'pulling and decrypting…' });
          const result = await tidemark.sync.pull({ purpose: 'open the synced accounts' });
          void vscode.window.showInformationMessage(result.message);
        }
      } catch (error) {
        tidemark.reportQuietly('sync setup', error);
        void vscode.window.showErrorMessage(
          `Sync could not be set up: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
      await tidemark.refresh({ force: true });
    },
  );

  if (!configuration.get<boolean>('tidemark.sync.rememberPassphrase', false)) {
    const remember = await vscode.window.showInformationMessage(
      'Should this machine remember the passphrase in its keychain? Needed if you want auto-failover to work while you are away.',
      'Remember it',
      'Ask me each time',
    );
    if (remember === 'Remember it') {
      await configuration.update('tidemark.sync.rememberPassphrase', true, vscode.ConfigurationTarget.Global);
      // It is already in memory; put it in the keychain without asking again.
      await tidemark.passphrase.persist();
    }
  }
}
