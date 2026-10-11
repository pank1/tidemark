import * as vscode from 'vscode';

import { Tidemark } from '../controller';
import { describePresence } from '../core/presence';
import { formatCountdown, formatRelative, formatResetClock, msUntil } from '../core/time';
import { AccountView, WindowUsage } from '../core/types';
import { percentBar, severityIcon } from './format';

type Node =
  | { kind: 'account'; view: AccountView }
  | { kind: 'window'; title: string; usage: WindowUsage; estimate: boolean }
  | { kind: 'info'; title: string; description?: string; icon?: string; command?: vscode.Command }
  | { kind: 'sync' };

/** The panel view: every account, both windows, resets, and sync state. */
export class AccountsTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];
  private syncLine = 'Sync: off';

  constructor(private readonly tidemark: Tidemark) {
    this.disposables.push(
      tidemark.onDidChange(() => {
        void this.refreshSyncLine();
        this.emitter.fire(undefined);
      }),
    );
    void this.refreshSyncLine();
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'account':
        return this.accountItem(node.view);
      case 'window':
        return this.windowItem(node);
      case 'sync': {
        const item = new vscode.TreeItem(this.syncLine, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon(this.tidemark.sync.enabled ? 'cloud' : 'cloud-offline');
        item.contextValue = 'sync';
        item.command = {
          command: this.tidemark.sync.enabled ? 'tidemark.syncPull' : 'tidemark.syncSetup',
          title: this.tidemark.sync.enabled ? 'Pull accounts from sync' : 'Set up sync',
        };
        return item;
      }
      case 'info': {
        const item = new vscode.TreeItem(node.title, vscode.TreeItemCollapsibleState.None);
        item.description = node.description;
        if (node.icon) item.iconPath = new vscode.ThemeIcon(node.icon);
        if (node.command) item.command = node.command;
        return item;
      }
    }
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      const views = this.tidemark.views();
      // Returning nothing lets the welcome content show, which is the only
      // guidance a first-time user gets in this panel.
      if (views.length === 0 && !this.tidemark.sync.enabled) return [];
      const nodes: Node[] = views.map((view) => ({ kind: 'account' as const, view }));
      nodes.push({ kind: 'sync' });
      return nodes;
    }
    if (node.kind !== 'account') return [];

    const view = node.view;
    const children: Node[] = [];
    const now = new Date();

    if (view.profile.needsSignIn) {
      children.push({
        kind: 'info',
        title: 'Needs signing in again',
        description: 'run Add Another Account to replace it',
        icon: 'alert',
        command: { command: 'tidemark.addAccount', title: 'Add another account' },
      });
    }

    const snapshot = view.snapshot;
    if (snapshot) {
      const estimate = snapshot.source === 'estimate';
      children.push({ kind: 'window', title: '5-hour window', usage: snapshot.session, estimate });
      children.push({ kind: 'window', title: 'This week', usage: snapshot.week, estimate });

      for (const limit of snapshot.scoped.filter((entry) => entry.percentUsed > 0)) {
        children.push({
          kind: 'info',
          title: limit.label,
          description: `${Math.round(100 - limit.percentUsed)}% left · resets ${formatResetClock(limit.resetsAt, now)}`,
          icon: 'circle-small',
        });
      }

      if (snapshot.breakdown.length > 0) {
        children.push({
          kind: 'info',
          title: 'Week so far',
          description: snapshot.breakdown.map((row) => `${row.label} ${row.percent}%`).join(' · '),
          icon: 'pie-chart',
        });
      }

      children.push({
        kind: 'info',
        title: estimate ? 'Estimated from local logs' : 'Figures from Anthropic',
        description: formatRelative(snapshot.fetchedAt, now),
        icon: estimate ? 'beaker' : 'cloud',
      });
    } else {
      children.push({
        kind: 'info',
        title: view.lastError ?? 'No figures yet',
        icon: 'circle-outline',
      });
    }

    const presence = describePresence(view.presence ?? [], now);
    if (presence) children.push({ kind: 'info', title: presence, icon: 'vm-active' });

    if (view.profile.identity?.email) {
      children.push({
        kind: 'info',
        title: view.profile.identity.email,
        description: view.profile.identity.plan,
        icon: 'account',
      });
    }

    return children;
  }

  private accountItem(view: AccountView): vscode.TreeItem {
    const item = new vscode.TreeItem(view.profile.label, vscode.TreeItemCollapsibleState.Collapsed);
    item.contextValue = 'account';
    item.id = `account:${view.profile.id}`;

    const snapshot = view.snapshot;
    if (view.profile.needsSignIn) {
      item.description = 'sign-in needed';
      item.iconPath = new vscode.ThemeIcon('alert', new vscode.ThemeColor('list.warningForeground'));
    } else if (snapshot) {
      const mark = snapshot.source === 'estimate' ? '~' : '';
      item.description = `${mark}${Math.round(snapshot.session.percentLeft)}% window · ${mark}${Math.round(
        snapshot.week.percentLeft,
      )}% week${view.stale ? ' · stale' : ''}`;
      item.iconPath = view.isActive
        ? new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'))
        : new vscode.ThemeIcon(severityIcon(snapshot.week.severity).replace(/[$()]/g, ''));
    } else {
      item.description = view.lastError ?? 'reading usage…';
      item.iconPath = new vscode.ThemeIcon(view.isActive ? 'check' : 'circle-outline');
    }

    item.tooltip = new vscode.MarkdownString(
      [
        `**${view.profile.label}**`,
        view.profile.identity?.email ?? '',
        view.isActive ? '\nIn use on this machine.' : '',
        '',
        '[Use this account](command:tidemark.switch)',
      ].join('\n'),
    );
    (item.tooltip as vscode.MarkdownString).isTrusted = true;

    if (!view.isActive) {
      item.command = {
        command: 'tidemark.switchToAccount',
        title: 'Use this account',
        arguments: [view.profile.id],
      };
    }
    return item;
  }

  private windowItem(node: Extract<Node, { kind: 'window' }>): vscode.TreeItem {
    const now = new Date();
    const left = Math.round(node.usage.percentLeft);
    const item = new vscode.TreeItem(
      `${node.estimate ? '~' : ''}${left}% left  ${percentBar(node.usage.percentUsed, 12)}`,
      vscode.TreeItemCollapsibleState.None,
    );
    item.description = node.usage.resetsAt
      ? `${node.title} · resets ${formatResetClock(node.usage.resetsAt, now)} (${formatCountdown(
          msUntil(node.usage.resetsAt, now),
        )})`
      : node.title;
    item.iconPath = new vscode.ThemeIcon(
      node.usage.locked ? 'circle-slash' : node.title.startsWith('5') ? 'clock' : 'calendar',
    );
    if (node.usage.locked && node.usage.lockedReason) item.tooltip = node.usage.lockedReason;
    return item;
  }

  private async refreshSyncLine(): Promise<void> {
    try {
      const status = await this.tidemark.sync.status();
      if (!status.enabled) {
        this.syncLine = 'Sync: off';
        return;
      }
      const locked = this.tidemark.passphrase.locked ? ' · locked' : '';
      const when = status.lastCommitAt ? ` · ${formatRelative(status.lastCommitAt)}` : '';
      this.syncLine = status.error
        ? `Sync: ${status.error}`
        : `Sync: ${status.cloned ? 'ready' : 'not cloned yet'}${when}${locked}`;
    } catch {
      this.syncLine = 'Sync: unavailable';
    }
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
    this.emitter.dispose();
  }
}
