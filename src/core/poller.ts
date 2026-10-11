import { ApiClient, ApiError } from './api';
import { CredentialStore, accessTokenExpired, refreshTokenExpired } from './credstore';
import { estimateSnapshot, measureLocalUsage, updateCalibration } from './estimate';
import { Logger, nullLogger, blurEmail, redact } from './log';
import { ProfileStore } from './profiles';
import { minutesSince } from './time';
import { Profile, UsageSnapshot } from './types';
import { snapshotFromUsage } from './usage';

export interface PollerSettings {
  pollIntervalMinutes: number;
  idlePollIntervalMinutes: number;
  /** Whether this machine may refresh expired tokens of accounts it is not using. */
  refreshIdle: boolean;
  estimateEnabled: boolean;
  staleAfterMinutes: number;
}

export interface PollerDeps {
  api: ApiClient;
  store: ProfileStore;
  credentials: CredentialStore;
  settings: () => PollerSettings;
  logger?: Logger;
  /** Pull the bundle, used before retrying a refresh another machine won. */
  pullSync?: () => Promise<void>;
  /** Push rotated credentials so other machines do not try the dead token. */
  pushSync?: (reason: string) => Promise<void>;
}

export interface PollReport {
  polled: string[];
  failed: { accountId: string; error: string }[];
  skipped: string[];
}

/**
 * Keeps usage figures current for every stored account.
 *
 * Who refreshes what (D-06, revised): the **active** account's token belongs to
 * Claude Code — it refreshes and rewrites it on its own schedule, so we only
 * ever re-read it. Idle accounts are ours to refresh, because nothing else on
 * this machine will, and without that the failover picker would have no figures
 * for them. Rotated tokens are pushed to sync immediately so other machines do
 * not go on using a dead one.
 */
export class UsagePoller {
  private readonly log: Logger;
  private lastPolled = new Map<string, number>();
  private errors = new Map<string, ApiError | Error>();
  private lastCalibrationAt = 0;
  private inFlight = false;

  constructor(private readonly deps: PollerDeps) {
    this.log = deps.logger ?? nullLogger;
  }

  errorFor(accountId: string): ApiError | Error | undefined {
    return this.errors.get(accountId);
  }

  isStale(snapshot: UsageSnapshot | undefined, now: Date = new Date()): boolean {
    if (!snapshot) return true;
    return minutesSince(snapshot.fetchedAt, now) > this.deps.settings().staleAfterMinutes;
  }

  /** One pass over every account, respecting per-account intervals. */
  async pollAll(options: { force?: boolean } = {}): Promise<PollReport> {
    const report: PollReport = { polled: [], failed: [], skipped: [] };
    if (this.inFlight) return report;
    this.inFlight = true;
    try {
      const settings = this.deps.settings();
      const activeId = this.deps.store.state.activeAccountId;
      for (const profile of this.deps.store.list()) {
        const isActive = profile.id === activeId;
        const dueAfter = isActive ? settings.pollIntervalMinutes : settings.idlePollIntervalMinutes;
        const last = this.lastPolled.get(profile.id) ?? 0;
        if (!options.force && Date.now() - last < dueAfter * 60_000) {
          report.skipped.push(profile.id);
          continue;
        }
        const outcome = await this.pollProfile(profile, { isActive });
        if (outcome.ok) report.polled.push(profile.id);
        else report.failed.push({ accountId: profile.id, error: outcome.error });
      }
    } finally {
      this.inFlight = false;
    }
    return report;
  }

  async pollProfile(
    profile: Profile,
    options: { isActive: boolean; retried?: boolean },
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    this.lastPolled.set(profile.id, Date.now());
    // The active account's stored credentials are kept current by the
    // controller's reconcile step, which is the only place allowed to decide
    // that a changed credential file is still the same account.
    let credentials = profile.credentials;

    if (accessTokenExpired(credentials)) {
      const mayRefresh = !options.isActive && this.deps.settings().refreshIdle;
      if (!mayRefresh) {
        const why = options.isActive
          ? 'waiting for Claude Code to refresh this account'
          : 'token expired and refreshing idle accounts is turned off';
        this.errors.set(profile.id, new Error(why));
        return { ok: false, error: why };
      }
      if (refreshTokenExpired(credentials)) {
        await this.deps.store.update(profile.id, { needsSignIn: true });
        const why = 'sign-in has expired for this account';
        this.errors.set(profile.id, new Error(why));
        return { ok: false, error: why };
      }
      try {
        const refreshed = await this.deps.api.refresh(credentials);
        credentials = {
          ...credentials,
          claudeAiOauth: {
            ...credentials.claudeAiOauth,
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
            expiresAt: refreshed.expiresAt,
          },
        };
        await this.deps.store.update(profile.id, { credentials, needsSignIn: false });
        this.log.info(
          `refreshed token for ${profile.identity?.email ? blurEmail(profile.identity.email) : profile.label}`,
        );
        if (this.deps.pushSync) {
          try {
            await this.deps.pushSync('rotated an access token');
          } catch (pushError) {
            this.log.debug(`could not push rotated token: ${redact(pushError)}`);
          }
        }
      } catch (error) {
        // Another machine may have refreshed first and rotated the token out
        // from under us. Pull and try once more before blaming the account.
        if (error instanceof ApiError && error.kind === 'unauthorized' && !options.retried) {
          this.log.info('refresh was rejected; pulling sync and retrying once');
          try {
            await this.deps.pullSync?.();
          } catch (pullError) {
            this.log.debug(`sync pull before retry failed: ${redact(pullError)}`);
          }
          const reloaded = this.deps.store.get(profile.id);
          if (reloaded && reloaded.credentials.claudeAiOauth.refreshToken !== credentials.claudeAiOauth.refreshToken) {
            return this.pollProfile(reloaded, { ...options, retried: true });
          }
        }
        if (error instanceof ApiError && error.kind === 'unauthorized') {
          await this.deps.store.update(profile.id, { needsSignIn: true });
        }
        this.errors.set(profile.id, error as Error);
        return { ok: false, error: describe(error) };
      }
    }

    try {
      const raw = await this.deps.api.usage(credentials.claudeAiOauth.accessToken);
      const snapshot = snapshotFromUsage(profile.id, raw);
      await this.deps.store.putSnapshot(snapshot);
      this.errors.delete(profile.id);
      if (!profile.identity?.email) await this.fillIdentity(profile, credentials.claudeAiOauth.accessToken);
      if (options.isActive) await this.maybeCalibrate(snapshot);
      return { ok: true };
    } catch (error) {
      if (error instanceof ApiError && error.kind === 'unauthorized') {
        await this.deps.store.update(profile.id, { needsSignIn: true });
      }
      this.errors.set(profile.id, error as Error);
      if (options.isActive && this.deps.settings().estimateEnabled) {
        await this.fallbackToEstimate(profile);
      }
      return { ok: false, error: describe(error) };
    }
  }

  private async fillIdentity(profile: Profile, accessToken: string): Promise<void> {
    try {
      const identity = await this.deps.api.profile(accessToken);
      await this.deps.store.update(profile.id, { identity });
    } catch (error) {
      this.log.debug(`identity lookup failed: ${redact(error)}`);
    }
  }

  /** Learn the local-log-to-percentage ratio at most once an hour. */
  private async maybeCalibrate(truth: UsageSnapshot): Promise<void> {
    if (!this.deps.settings().estimateEnabled) return;
    if (Date.now() - this.lastCalibrationAt < 60 * 60 * 1000) return;
    this.lastCalibrationAt = Date.now();
    try {
      const windows = await measureLocalUsage({ logger: this.log });
      const calibration = updateCalibration(this.deps.store.state.calibration, windows, truth);
      await this.deps.store.patchState({ calibration });
    } catch (error) {
      this.log.debug(`calibration skipped: ${redact(error)}`);
    }
  }

  private async fallbackToEstimate(profile: Profile): Promise<void> {
    const previous = this.deps.store.snapshot(profile.id);
    try {
      const windows = await measureLocalUsage({ logger: this.log });
      const estimated = estimateSnapshot(profile.id, windows, this.deps.store.state.calibration, {
        sessionResetsAt: previous?.session.resetsAt ?? null,
        weekResetsAt: previous?.week.resetsAt ?? null,
      });
      if (estimated) await this.deps.store.putSnapshot(estimated);
    } catch (error) {
      this.log.debug(`estimate skipped: ${redact(error)}`);
    }
  }
}

function describe(error: unknown): string {
  if (error instanceof ApiError) return error.display;
  if (error instanceof Error) return error.message;
  return redact(error);
}
