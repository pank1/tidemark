import * as vscode from 'vscode';

import { Tidemark } from '../controller';
import { describePresence } from '../core/presence';
import { Candidate, pickAccount } from '../core/policy';
import { AccountView } from '../core/types';
import { oneLine, shortLabel } from './format';

interface Item extends vscode.QuickPickItem {
  accountId?: string;
  action?: 'add' | 'capture' | 'sync-setup' | 'sync-pull' | 'doctor' | 'failover';
}

/**
 * The switcher. Every account carries its own figures, so the choice is made in
 * the list rather than by opening something else first, and the account the
 * policy would pick is marked so the recommendation is visible without
 * auto-failover being on.
 */
export async function showAccountSwitcher(tidemark: Tidemark): Promise<void> {
  const quickPick = vscode.window.createQuickPick<Item>();
  quickPick.title = 'Claude accounts';
  quickPick.placeholder = 'Choose an account to use';
  quickPick.matchOnDescription = true;
  quickPick.matchOnDetail = true;
  quickPick.ignoreFocusOut = false;

  const refreshButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('refresh'),
    tooltip: 'Refresh usage figures',
  };
  quickPick.buttons = [refreshButton];

  const render = (): void => {
    quickPick.items = buildItems(tidemark);
  };
  render();

  const subscription = tidemark.onDidChange(render);

  quickPick.onDidTriggerButton(async (button) => {
    if (button !== refreshButton) return;
    quickPick.busy = true;
    await tidemark.refresh({ force: true });
    render();
    quickPick.busy = false;
  });

  const chosen = await new Promise<Item | undefined>((resolve) => {
    quickPick.onDidAccept(() => resolve(quickPick.selectedItems[0]));
    quickPick.onDidHide(() => resolve(undefined));
    quickPick.show();
  });

  subscription.dispose();
  quickPick.hide();
  quickPick.dispose();

  if (!chosen) return;

  if (chosen.action) {
    await vscode.commands.executeCommand(commandFor(chosen.action));
    return;
  }

  if (chosen.accountId) {
    const result = await tidemark.switchTo(chosen.accountId);
    if (result.ok) void vscode.window.showInformationMessage(result.message);
    else void vscode.window.showWarningMessage(result.message);
  }
}

function commandFor(action: NonNullable<Item['action']>): string {
  switch (action) {
    case 'add':
      return 'tidemark.addAccount';
    case 'capture':
      return 'tidemark.captureCurrent';
    case 'sync-setup':
      return 'tidemark.syncSetup';
    case 'sync-pull':
      return 'tidemark.syncPull';
    case 'doctor':
      return 'tidemark.doctor';
    case 'failover':
      return 'tidemark.toggleFailover';
  }
}

function buildItems(tidemark: Tidemark): Item[] {
  const views = tidemark.views();
  const settings = tidemark.settings();
  const now = new Date();

  const candidates: Candidate[] = views.map((view) => ({
    accountId: view.profile.id,
    label: view.profile.label,
    snapshot: view.snapshot,
    needsSignIn: view.profile.needsSignIn,
  }));
  const activeId = views.find((view) => view.isActive)?.profile.id;
  const recommended = pickAccount(candidates, {
    ...settings.policy,
    preferCushion: false,
    excludeAccountIds: activeId ? [activeId] : [],
    now,
  }).chosen?.accountId;

  const items: Item[] = [];
  const ordered = [...views].sort(orderForList);

  for (const view of ordered) {
    items.push({
      label: `${view.isActive ? '$(check) ' : '$(circle-outline) '}${view.profile.label}`,
      description: describeRight(view, view.profile.id === recommended),
      detail: detailFor(view, now),
      accountId: view.profile.id,
    });
  }

  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  items.push({
    label: '$(add) Add another account…',
    detail: 'Walks you through signing in to a second Claude account',
    action: 'add',
  });
  items.push({
    label: '$(save) Save the current login',
    detail: 'Store whatever Claude Code is signed in to right now as an account',
    action: 'capture',
  });
  if (settings.sync.enabled) {
    items.push({
      label: '$(cloud-download) Pull accounts from sync',
      detail: settings.sync.repository,
      action: 'sync-pull',
    });
  } else {
    items.push({
      label: '$(cloud) Set up sync across machines…',
      detail: 'Keep these accounts in your own private, encrypted repository',
      action: 'sync-setup',
    });
  }
  items.push({
    label: `$(${settings.failoverEnabled ? 'circle-filled' : 'circle-outline'}) Auto-failover: ${
      settings.failoverEnabled ? 'on' : 'off'
    }`,
    detail: settings.failoverEnabled
      ? 'Switches to the account whose weekly quota expires soonest when this one runs out'
      : 'Turn on to switch automatically when the account in use runs out',
    action: 'failover',
  });
  items.push({ label: '$(stethoscope) Doctor', detail: 'Check what Tidemark can see', action: 'doctor' });

  return items;
}

function orderForList(a: AccountView, b: AccountView): number {
  if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
  const left = a.snapshot?.week.percentLeft ?? -1;
  const right = b.snapshot?.week.percentLeft ?? -1;
  if (left !== right) return right - left;
  return a.profile.label.localeCompare(b.profile.label);
}

function describeRight(view: AccountView, recommended: boolean): string {
  const bits: string[] = [];
  if (view.isActive) bits.push('in use');
  if (recommended) bits.push('recommended next');
  if (view.profile.identity?.plan) bits.push(view.profile.identity.plan);
  if (view.stale && view.snapshot) bits.push('figures stale');
  return bits.join(' · ');
}

function detailFor(view: AccountView, now: Date): string {
  const presence = describePresence(view.presence ?? [], now);
  const base = oneLine(view, now);
  return presence ? `${base} · ${presence}` : `${base}${view.profile.identity?.email ? ` · ${shortLabel(view, 40)}` : ''}`;
}
