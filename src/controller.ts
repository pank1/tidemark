import * as vscode from 'vscode';

import { ApiClient, ApiError } from './core/api';
import { BundleError } from './core/crypto';
import { CredentialStore, sameLogin } from './core/credstore';
import { GitError } from './core/git';
import { Logger } from './core/log';
import { UsagePoller } from './core/poller';
import {
  Candidate,
  DEFAULT_POLICY,
  describeTrigger,
  pickAccount,
  prefersCushion,
  shouldFailover,
} from './core/policy';
import { ProfileStore, machineName, suggestLabel } from './core/profiles';
import { ClaudeSession, discoverSessions, terminate } from './core/sessions';
import { LockedError, SyncManager } from './core/sync';
import { AccountView, PolicySettings, PresenceEntry, Profile } from './core/types';
import { PassphraseHolder } from './ui/passphrase';

export interface TidemarkSettings {
  pollIntervalMinutes: number;
  idlePollIntervalMinutes: number;
  refreshIdle: boolean;
  estimateEnabled: boolean;
  staleAfterMinutes: number;
  policy: PolicySettings;
  failoverEnabled: boolean;
  failoverCooldownMinutes: number;
  restartStrategy: 'reload' | 'kill' | 'none';
  restartGraceSeconds: number;
  protectInvokingSession: boolean;
  machineName: string;
  sync: {
    enabled: boolean;
    repository: string;
    branch: string;
    autoPush: boolean;
    pullIntervalMinutes: number;
  };
}

export interface SwitchResult {
  ok: boolean;
  message: string;
  endedSessions?: number;
}

/**
 * Everything that is not drawing: timers, account switching, failover, sync.
 * The UI subscribes to `onDidChange` and re-reads `views()`.
 */
export class Tidemark implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;

  readonly poller: UsagePoller;
  readonly sync: SyncManager;

  private readonly disposables: vscode.Disposable[] = [];
  private presenceCache = new Map<string, PresenceEntry[]>();
  private pollTimer?: ReturnType<typeof setInterval>;
  private tickTimer?: ReturnType<typeof setInterval>;
  private switching = false;
  private noCandidateNoticeAt = 0;
  private lockedNoticeAt = 0;

  constructor(
    readonly context: vscode.ExtensionContext,
    readonly log: Logger,
    readonly store: ProfileStore,
    readonly credentials: CredentialStore,
    readonly api: ApiClient,
    readonly passphrase: PassphraseHolder,
  ) {
    this.sync = new SyncManager({
      store,
      logger: log,
      machineLabel: this.settings().machineName,
      settings: () => this.settings().sync,
      getPassphrase: (purpose) => this.passphrase.get(purpose),
    });

    this.poller = new UsagePoller({
      api,
      store,
      credentials,
      logger: log,
      settings: () => {
        const settings = this.settings();
        return {
          pollIntervalMinutes: settings.pollIntervalMinutes,
          idlePollIntervalMinutes: settings.idlePollIntervalMinutes,
          refreshIdle: settings.refreshIdle,
          estimateEnabled: settings.estimateEnabled,
          staleAfterMinutes: settings.staleAfterMinutes,
        };
      },
      pullSync: async () => {
        await this.sync.pull({ purpose: 'fetch the newest sign-in for an account' });
      },
      pushSync: async (reason) => {
        if (this.settings().sync.autoPush) await this.sync.push(reason);
      },
    });

    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration('tidemark')) return;
        this.restartTimers();
        this.changeEmitter.fire();
      }),
    );
  }

  // ---------------------------------------------------------------- settings

  settings(): TidemarkSettings {
    const c = vscode.workspace.getConfiguration();
    const policy: PolicySettings = {
      weeklyExhaustedPercent: c.get('tidemark.failover.weeklyExhaustedPercent', DEFAULT_POLICY.weeklyExhaustedPercent),
      preferredWeeklyLeftPercent: c.get(
        'tidemark.failover.preferredWeeklyLeftPercent',
        DEFAULT_POLICY.preferredWeeklyLeftPercent,
      ),
      sessionTriggerPercent: c.get('tidemark.failover.sessionTriggerPercent', DEFAULT_POLICY.sessionTriggerPercent),
      staleAfterMinutes: c.get('tidemark.staleAfterMinutes', DEFAULT_POLICY.staleAfterMinutes),
    };
    return {
      pollIntervalMinutes: c.get('tidemark.pollIntervalMinutes', 5),
      idlePollIntervalMinutes: c.get('tidemark.idlePollIntervalMinutes', 15),
      refreshIdle: c.get('tidemark.refreshPolicy', 'auto') === 'auto',
      estimateEnabled: c.get('tidemark.estimate.enabled', true),
      staleAfterMinutes: policy.staleAfterMinutes,
      policy,
      failoverEnabled: c.get('tidemark.failover.enabled', false),
      failoverCooldownMinutes: c.get('tidemark.failover.cooldownMinutes', 10),
      restartStrategy: c.get<'reload' | 'kill' | 'none'>('tidemark.restartStrategy', 'reload'),
      restartGraceSeconds: c.get('tidemark.restartGraceSeconds', 3),
      protectInvokingSession: c.get('tidemark.protectInvokingSession', true),
      machineName: c.get('tidemark.machineName', '')?.trim() || machineName(),
      sync: {
        enabled: c.get('tidemark.sync.enabled', false),
        repository: c.get('tidemark.sync.repository', ''),
        branch: c.get('tidemark.sync.branch', 'main'),
        autoPush: c.get('tidemark.sync.autoPushOnChange', true),
        pullIntervalMinutes: c.get('tidemark.sync.pullIntervalMinutes', 15),
      },
    };
  }

  // -------------------------------------------------------------- lifecycle

  async initialize(): Promise<void> {
    await this.store.load();
    await this.passphrase.restore();
    await this.reconcileCurrentLogin();
    this.restartTimers();
    void this.showPendingAnnouncement();
    void this.refresh({ force: true });
    void this.updateContextKeys();
  }

  /**
   * Keeps the saved accounts honest about what Claude Code is actually signed
   * in to. Three things can have happened since we last looked:
   *
   * - nothing — the common case, settled by one string comparison;
   * - Claude Code refreshed its own token, which rotates *both* tokens, so the
   *   credentials look unfamiliar although the account has not changed;
   * - the user signed in somewhere else entirely.
   *
   * Telling the last two apart needs the account's identity, so that is the
   * only case that costs a request. Getting this wrong would write one
   * account's tokens over another's record, so when the identity cannot be
   * read nothing is changed at all.
   */
  private async reconcileCurrentLogin(): Promise<void> {
    const live = await this.credentials.read();
    if (!live) return;

    const active = this.store.active;
    if (active && live.claudeAiOauth.accessToken === active.credentials.claudeAiOauth.accessToken) {
      return;
    }

    const byLogin = this.store.findByLogin(live);
    if (byLogin) {
      if (this.store.state.activeAccountId !== byLogin.id) {
        this.log.info(`Claude Code is signed in to ${byLogin.label}; following it`);
        await this.store.setActive(byLogin.id);
        this.changeEmitter.fire();
      }
      return;
    }

    if (this.store.list().length === 0) {
      const profile = await this.store.add({
        label: suggestLabel(undefined, 1),
        credentials: live,
      });
      await this.store.setActive(profile.id);
      this.log.info('adopted the current Claude Code login as the first account');
      this.changeEmitter.fire();
      return;
    }

    let identity;
    try {
      identity = await this.api.profile(live.claudeAiOauth.accessToken);
    } catch (error) {
      this.log.debug(`could not identify a changed sign-in, leaving accounts alone: ${String(error)}`);
      return;
    }

    const owner =
      this.store.findByIdentity(identity) ??
      // One account with no identity yet: a rotation can only belong to it.
      (this.store.list().length === 1 && !this.store.list()[0]!.identity ? this.store.list()[0] : undefined);

    if (owner) {
      await this.store.update(owner.id, { credentials: live, identity, needsSignIn: false });
      if (this.store.state.activeAccountId !== owner.id) await this.store.setActive(owner.id);
      this.log.info(`picked up a rotated sign-in for ${owner.label}`);
      await this.pushIfAuto('picked up a rotated sign-in');
      this.changeEmitter.fire();
      return;
    }

    const profile = await this.store.add({
      label: suggestLabel(identity, this.store.list().length + 1),
      credentials: live,
      identity,
    });
    await this.store.setActive(profile.id);
    this.log.info(`a new sign-in appeared and was saved as ${profile.label}`);
    await this.pushIfAuto(`saved ${profile.label}`);
    this.changeEmitter.fire();
  }

  /** Shows the message a reload interrupted, if it is still relevant. */
  private async showPendingAnnouncement(): Promise<void> {
    const pending = this.store.state.pendingAnnouncement;
    if (!pending) return;
    await this.store.patchState({ pendingAnnouncement: undefined });
    if (Date.now() - Date.parse(pending.at) > 5 * 60_000) return;

    const previous = pending.previousAccountId ? this.store.get(pending.previousAccountId) : undefined;
    const choice = await vscode.window.showInformationMessage(
      pending.message,
      ...(previous ? [`Back to ${previous.label}`] : []),
    );
    if (previous && choice === `Back to ${previous.label}`) {
      const result = await this.switchTo(previous.id, { reason: 'undo' });
      if (!result.ok) void vscode.window.showWarningMessage(result.message);
    }
  }

  private restartTimers(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    const settings = this.settings();
    const everyMs = Math.max(60_000, settings.pollIntervalMinutes * 60_000);
    this.pollTimer = setInterval(() => void this.refresh(), everyMs);
    // Keeps the countdown honest without re-querying anything.
    this.tickTimer = setInterval(() => this.changeEmitter.fire(), 20_000);
  }

  dispose(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    for (const disposable of this.disposables) disposable.dispose();
    this.changeEmitter.dispose();
  }

  // ------------------------------------------------------------------ views

  views(): AccountView[] {
    const activeId = this.store.state.activeAccountId;
    const now = new Date();
    return this.store.list().map((profile) => {
      const snapshot = this.store.snapshot(profile.id);
      const error = this.poller.errorFor(profile.id);
      return {
        profile,
        snapshot,
        lastError: error instanceof ApiError ? error.display : error?.message,
        stale: this.poller.isStale(snapshot, now),
        presence: this.presenceCache.get(profile.id) ?? [],
        isActive: profile.id === activeId,
      };
    });
  }

  activeView(): AccountView | undefined {
    return this.views().find((view) => view.isActive);
  }

  notifyChanged(): void {
    this.changeEmitter.fire();
  }

  // --------------------------------------------------------------- refresh

  async refresh(options: { force?: boolean } = {}): Promise<void> {
    try {
      await this.reconcileCurrentLogin();
      if (this.sync.enabled && this.sync.dueForPull() && !this.passphrase.locked) {
        try {
          await this.sync.pull();
        } catch (error) {
          this.reportQuietly('sync pull', error);
        }
      }
      await this.poller.pollAll({ force: options.force });
      await this.refreshPresence();
      await this.maybeFailover();
    } catch (error) {
      this.reportQuietly('refresh', error);
    } finally {
      this.changeEmitter.fire();
      void this.updateContextKeys();
    }
  }

  private async refreshPresence(): Promise<void> {
    if (!this.sync.enabled) {
      if (this.presenceCache.size > 0) this.presenceCache = new Map();
      return;
    }
    try {
      await this.sync.heartbeat();
      this.presenceCache = await this.sync.presenceByAccount();
    } catch (error) {
      this.reportQuietly('presence', error);
    }
  }

  private async updateContextKeys(): Promise<void> {
    const settings = this.settings();
    await vscode.commands.executeCommand('setContext', 'tidemark.syncEnabled', settings.sync.enabled);
    await vscode.commands.executeCommand('setContext', 'tidemark.hasAccounts', this.store.list().length > 0);
    await vscode.commands.executeCommand('setContext', 'tidemark.locked', this.passphrase.locked);
  }

  // --------------------------------------------------------------- capture

  /** Saves whatever login Claude Code is holding right now as an account. */
  async captureCurrent(options: { silent?: boolean } = {}): Promise<Profile | undefined> {
    const current = await this.credentials.read();
    if (!current) {
      if (!options.silent) {
        void vscode.window.showWarningMessage(
          'No Claude sign-in found on this machine. Sign in with Claude Code first, then try again.',
        );
      }
      return undefined;
    }

    const existing = this.store.findByLogin(current);
    if (existing) {
      await this.store.update(existing.id, { credentials: current, needsSignIn: false });
      await this.store.setActive(existing.id);
      if (!options.silent) {
        void vscode.window.showInformationMessage(`Already saved as “${existing.label}”. Set as the account in use.`);
      }
      this.changeEmitter.fire();
      return existing;
    }

    let identity;
    try {
      identity = await this.api.profile(current.claudeAiOauth.accessToken);
    } catch (error) {
      this.log.debug(`could not read the account profile while capturing: ${String(error)}`);
    }

    const byIdentity = this.store.findByIdentity(identity);
    if (byIdentity) {
      await this.store.update(byIdentity.id, { credentials: current, identity, needsSignIn: false });
      await this.store.setActive(byIdentity.id);
      this.changeEmitter.fire();
      if (!options.silent) {
        void vscode.window.showInformationMessage(`Updated the saved sign-in for “${byIdentity.label}”.`);
      }
      return byIdentity;
    }

    const profile = await this.store.add({
      label: suggestLabel(identity, this.store.list().length + 1),
      credentials: current,
      identity,
    });
    await this.store.setActive(profile.id);
    this.changeEmitter.fire();
    void this.pushIfAuto(`saved ${profile.label}`);
    if (!options.silent) {
      void vscode.window.showInformationMessage(`Saved “${profile.label}”.`);
    }
    void this.poller.pollProfile(profile, { isActive: true }).then(() => this.changeEmitter.fire());
    return profile;
  }

  // ---------------------------------------------------------------- switch

  async switchTo(
    accountId: string,
    options: { reason?: string; automatic?: boolean } = {},
  ): Promise<SwitchResult> {
    if (this.switching) return { ok: false, message: 'A switch is already in progress.' };
    const profile = this.store.get(accountId);
    if (!profile) return { ok: false, message: 'That account is no longer saved.' };

    this.log.info(
      `${options.automatic ? 'automatic' : 'requested'} switch to ${profile.label}${
        options.reason ? ` — ${options.reason}` : ''
      }`,
    );

    if (profile.needsSignIn) {
      return {
        ok: false,
        message: `“${profile.label}” needs signing in again before it can be used.`,
      };
    }

    this.switching = true;
    try {
      // Makes sure `current` is attributed to the right account before we
      // compare or overwrite it; without this, a token Claude Code rotated a
      // minute ago looks like a different account and we would write a stale
      // one back over it.
      await this.reconcileCurrentLogin();
      const previousId = this.store.state.activeAccountId;
      const current = await this.credentials.read();

      if (current && sameLogin(current, profile.credentials)) {
        await this.store.setActive(profile.id);
        this.changeEmitter.fire();
        return { ok: true, message: `Already using “${profile.label}”.` };
      }

      await this.credentials.write(profile.credentials);
      await this.store.setActive(profile.id);
      const ended = await this.restartSessions();
      await this.pushIfAuto(`switched to ${profile.label}`);
      this.changeEmitter.fire();

      void this.poller
        .pollProfile(profile, { isActive: true })
        .then(() => this.changeEmitter.fire());

      const pieces: string[] = [];
      if (ended.endedOtherWindows > 0) {
        pieces.push(
          ` ${ended.endedOtherWindows} session${ended.endedOtherWindows === 1 ? '' : 's'} in other windows ${
            ended.endedOtherWindows === 1 ? 'was' : 'were'
          } ended — reopen with the Claude Code shortcut.`,
        );
      }
      if (ended.protectedOwnWindow > 0) {
        pieces.push(
          ` Sessions in this window were left alone, so they stay on the previous account until you reopen them.`,
        );
      }
      const detail = pieces.join('');

      const message = `${options.reason ? `${options.reason.charAt(0).toUpperCase()}${options.reason.slice(1)}. ` : ''}Now using “${profile.label}”.${detail}`;
      if (ended.reload) {
        // The reload tears this extension host down, taking any notification
        // with it, so the message is parked for the window that comes back.
        await this.store.patchState({
          pendingAnnouncement: { message, previousAccountId: previousId, at: new Date().toISOString() },
        });
        void vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
      return { ok: true, message, endedSessions: ended.endedOtherWindows + ended.endedOwnWindow };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log.error(`switch failed: ${message}`);
      return { ok: false, message: `Could not switch: ${message}` };
    } finally {
      this.switching = false;
    }
  }

  private async restartSessions(): Promise<{
    reload: boolean;
    endedOtherWindows: number;
    endedOwnWindow: number;
    protectedOwnWindow: number;
  }> {
    const settings = this.settings();
    if (settings.restartStrategy === 'none') {
      return { reload: false, endedOtherWindows: 0, endedOwnWindow: 0, protectedOwnWindow: 0 };
    }

    let sessions: ClaudeSession[] = [];
    try {
      sessions = await discoverSessions({ logger: this.log });
    } catch (error) {
      this.reportQuietly('session discovery', error);
      return {
        reload: settings.restartStrategy === 'reload',
        endedOtherWindows: 0,
        endedOwnWindow: 0,
        protectedOwnWindow: 0,
      };
    }

    const others = sessions.filter((session) => !session.ownWindow);
    const mine = sessions.filter((session) => session.ownWindow);

    // Sessions in this window are restarted by the reload itself, so they are
    // only killed when the strategy is `kill` and protection is off (H2).
    const killOwn =
      settings.restartStrategy === 'kill' && !settings.protectInvokingSession ? mine : [];
    const targets = [...others, ...killOwn];

    if (targets.length > 0) {
      const result = await terminate(
        targets.map((session) => session.pid),
        { graceSeconds: settings.restartGraceSeconds, logger: this.log },
      );
      this.log.info(
        `ended ${result.asked.length} session(s), forced ${result.forced.length}, ${result.survived.length} would not exit`,
      );
    }

    return {
      reload: settings.restartStrategy === 'reload',
      endedOtherWindows: others.length,
      endedOwnWindow: killOwn.length,
      // Only worth mentioning when nothing else will bring them back.
      protectedOwnWindow: settings.restartStrategy === 'kill' ? mine.length - killOwn.length : 0,
    };
  }

  // -------------------------------------------------------------- failover

  async maybeFailover(): Promise<void> {
    const settings = this.settings();
    if (!settings.failoverEnabled) return;
    const active = this.store.active;
    if (!active) return;
    const snapshot = this.store.snapshot(active.id);
    if (!snapshot || this.poller.isStale(snapshot)) return;

    const trigger = shouldFailover(snapshot, settings.policy);
    if (!trigger) return;

    const since = this.store.state.lastFailoverAt
      ? Date.now() - Date.parse(this.store.state.lastFailoverAt)
      : Number.POSITIVE_INFINITY;
    if (since < settings.failoverCooldownMinutes * 60_000) return;

    const candidates: Candidate[] = this.store.list().map((profile) => ({
      accountId: profile.id,
      label: profile.label,
      snapshot: this.store.snapshot(profile.id),
      needsSignIn: profile.needsSignIn,
    }));

    const pick = pickAccount(candidates, {
      ...settings.policy,
      preferCushion: prefersCushion(trigger),
      excludeAccountIds: [active.id],
    });

    if (!pick.chosen) {
      await this.announceNoCandidate(pick.rejected.map((r) => `${r.label}: ${r.why}`), trigger);
      return;
    }

    const why = `${describeTrigger(trigger)} on ${active.label}, so: ${pick.reason}`;
    this.log.info(`auto-failover: ${why}`);
    await this.store.patchState({ lastFailoverAt: new Date().toISOString() });
    const previousId = active.id;
    const result = await this.switchTo(pick.chosen.accountId, { reason: why, automatic: true });

    if (!result.ok) {
      void vscode.window.showWarningMessage(`Auto-failover could not switch: ${result.message}`);
      return;
    }

    // With the reloading strategy the window is already on its way down and the
    // message has been parked for when it returns, with its own undo.
    if (settings.restartStrategy === 'reload') return;

    const choice = await vscode.window.showInformationMessage(
      `Switched to ${pick.chosen.label}: ${why}`,
      'Undo',
      'Turn off auto-failover',
    );
    if (choice === 'Undo') {
      const back = await this.switchTo(previousId, { reason: 'undo' });
      void vscode.window.showInformationMessage(back.message);
    } else if (choice === 'Turn off auto-failover') {
      await vscode.workspace
        .getConfiguration()
        .update('tidemark.failover.enabled', false, vscode.ConfigurationTarget.Global);
    }
  }

  private async announceNoCandidate(reasons: string[], trigger: ReturnType<typeof shouldFailover>): Promise<void> {
    if (Date.now() - this.noCandidateNoticeAt < 30 * 60_000) return;
    this.noCandidateNoticeAt = Date.now();
    this.log.warn(`no failover candidate (${trigger}): ${reasons.join('; ')}`);

    const lockedAndSyncing = this.sync.enabled && this.passphrase.locked;
    if (lockedAndSyncing && Date.now() - this.lockedNoticeAt > 30 * 60_000) {
      this.lockedNoticeAt = Date.now();
      const choice = await vscode.window.showWarningMessage(
        'Your account is out of quota and Tidemark is locked, so it cannot fetch current sign-ins for the others.',
        'Unlock',
      );
      if (choice === 'Unlock') {
        await this.passphrase.get('fetch the current sign-ins for your other accounts');
        await this.refresh({ force: true });
      }
      return;
    }

    void vscode.window.showWarningMessage(
      'No other account has quota available right now. Open Tidemark to see when each one resets.',
      'Show accounts',
    ).then((choice) => {
      if (choice === 'Show accounts') void vscode.commands.executeCommand('tidemark.accounts.focus');
    });
  }

  // ------------------------------------------------------------ edit, sync

  async renameAccount(accountId: string, label: string): Promise<void> {
    await this.store.update(accountId, { label });
    this.changeEmitter.fire();
    void this.pushIfAuto('renamed an account');
  }

  async removeAccount(accountId: string): Promise<void> {
    const profile = this.store.get(accountId);
    await this.store.remove(accountId);
    this.changeEmitter.fire();
    void this.pushIfAuto(`removed ${profile?.label ?? 'an account'}`);
  }

  private async pushIfAuto(reason: string): Promise<void> {
    const settings = this.settings();
    if (!settings.sync.enabled || !settings.sync.autoPush) return;
    if (this.passphrase.locked) {
      this.log.info(`not pushing (${reason}): Tidemark is locked`);
      return;
    }
    try {
      await this.sync.push(reason);
    } catch (error) {
      this.reportQuietly('sync push', error);
    }
  }

  /**
   * Logs, and only surfaces something the user can act on. A failing usage
   * lookup must never produce a toast (acceptance A4).
   */
  reportQuietly(what: string, error: unknown): void {
    if (error instanceof LockedError) {
      this.log.info(`${what}: locked, skipped`);
      return;
    }
    if (error instanceof BundleError && error.kind === 'passphrase') {
      void this.passphrase.forget();
      void vscode.window
        .showWarningMessage('That passphrase did not open the synced accounts.', 'Try again')
        .then((choice) => {
          if (choice === 'Try again') void this.sync.pull().catch(() => undefined);
        });
      return;
    }
    if (error instanceof GitError) {
      this.log.warn(`${what}: ${error.display}`);
      if (error.kind === 'auth' || error.kind === 'no-git') {
        void vscode.window.showWarningMessage(`Tidemark sync: ${error.display}`);
      }
      return;
    }
    this.log.warn(`${what}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
