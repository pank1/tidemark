import * as os from 'node:os';
import * as vscode from 'vscode';

import { Tidemark } from '../controller';
import { ApiError } from '../core/api';
import { accessTokenExpired, refreshTokenExpired } from '../core/credstore';
import { measureLocalUsage } from '../core/estimate';
import { blurEmail } from '../core/log';
import { claudeDir, tidemarkDir } from '../core/paths';
import { discoverSessions } from '../core/sessions';
import { formatRelative } from '../core/time';

/**
 * One page that answers "why is it showing me that?". Everything here is read
 * from the live system rather than from what we believe we configured, and it
 * blurs email addresses so the report can be pasted into an issue.
 */
export async function showDoctor(tidemark: Tidemark, version: string): Promise<void> {
  const lines: string[] = [];
  const settings = tidemark.settings();
  const now = new Date();

  lines.push('# Tidemark — Doctor', '');
  lines.push(`Generated ${now.toISOString()}`, '');
  lines.push('## This machine', '');
  lines.push(`- Tidemark ${version}, VS Code ${vscode.version}`);
  lines.push(`- ${process.platform} ${os.release()}, node ${process.versions.node}`);
  lines.push(`- Machine name used for sync: \`${settings.machineName}\``);
  lines.push(`- Claude config directory: \`${claudeDir()}\``);
  lines.push(`- Tidemark directory: \`${tidemarkDir()}\``);
  lines.push('');

  lines.push('## Sign-in Claude Code is using', '');
  try {
    const where = await tidemark.credentials.describe();
    lines.push(`- Store: **${where.kind}** — \`${where.location}\``);
    const current = await tidemark.credentials.read();
    if (!current) {
      lines.push('- No credentials found. Sign in with Claude Code, then run Save Current Login.');
    } else {
      const matched = tidemark.store.findByLogin(current);
      lines.push(`- Access token expired: **${accessTokenExpired(current) ? 'yes' : 'no'}**`);
      lines.push(`- Sign-in itself expired: **${refreshTokenExpired(current) ? 'yes' : 'no'}**`);
      lines.push(`- Plan reported in the file: ${current.claudeAiOauth.subscriptionType ?? 'unknown'}`);
      lines.push(`- Rate-limit tier: ${current.claudeAiOauth.rateLimitTier ?? 'unknown'}`);
      lines.push(`- Matches saved account: ${matched ? `**${matched.label}**` : '_not saved yet_'}`);
    }
  } catch (error) {
    lines.push(`- Could not read the credential store: ${describe(error)}`);
  }
  lines.push('');

  lines.push('## Accounts', '');
  const views = tidemark.views();
  if (views.length === 0) {
    lines.push('No accounts saved yet.');
  } else {
    lines.push('| Account | In use | Window left | Week left | Week resets | Figures | Note |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const view of views) {
      const snapshot = view.snapshot;
      lines.push(
        `| ${view.profile.label} | ${view.isActive ? 'yes' : ''} | ${
          snapshot ? `${Math.round(snapshot.session.percentLeft)}%` : '—'
        } | ${snapshot ? `${Math.round(snapshot.week.percentLeft)}%` : '—'} | ${
          snapshot?.week.resetsAt ?? '—'
        } | ${snapshot ? `${snapshot.source}, ${formatRelative(snapshot.fetchedAt, now)}` : 'none'} | ${
          view.profile.needsSignIn ? 'needs sign-in' : (view.lastError ?? '')
        } |`,
      );
    }
    lines.push('');
    for (const view of views) {
      lines.push(
        `- ${view.profile.label}: ${blurEmail(view.profile.identity?.email)} · ${
          view.profile.identity?.plan ?? 'plan unknown'
        } · added ${view.profile.addedAt}`,
      );
    }
  }
  lines.push('');

  lines.push('## Usage lookup', '');
  const active = tidemark.store.active;
  if (!active) {
    lines.push('No account in use, so nothing was tried.');
  } else {
    const startedAt = Date.now();
    try {
      await tidemark.api.usage(active.credentials.claudeAiOauth.accessToken);
      lines.push(`- \`GET /api/oauth/usage\` for **${active.label}**: ok in ${Date.now() - startedAt} ms`);
    } catch (error) {
      lines.push(`- \`GET /api/oauth/usage\` for **${active.label}**: ${describe(error)}`);
      if (error instanceof ApiError && error.requestId) lines.push(`  - request id \`${error.requestId}\``);
    }
  }
  lines.push('');

  lines.push('## Local estimate (fallback)', '');
  const calibration = tidemark.store.state.calibration;
  lines.push(`- Enabled: ${settings.estimateEnabled ? 'yes' : 'no'}`);
  lines.push(
    `- Calibration: ${
      calibration?.weeklyWeightedPerPercent
        ? `learned from ${calibration.samples ?? 1} reading(s), updated ${formatRelative(calibration.updatedAt, now)}`
        : 'not learned yet — the estimate will stay hidden until it is'
    }`,
  );
  if (settings.estimateEnabled) {
    try {
      const windows = await measureLocalUsage({ logger: tidemark.log, maxMillis: 2500 });
      lines.push(
        `- Local logs: ${windows.filesScanned} file(s), ${windows.linesScanned} entries${
          windows.truncated ? ' (scan stopped early)' : ''
        }`,
      );
    } catch (error) {
      lines.push(`- Local logs could not be read: ${describe(error)}`);
    }
  }
  lines.push('');

  lines.push('## Sessions on this machine', '');
  try {
    const sessions = await discoverSessions({ logger: tidemark.log });
    const own = sessions.filter((session) => session.ownWindow).length;
    lines.push(`- ${sessions.length} Claude Code session(s): ${own} in this window, ${sessions.length - own} elsewhere`);
    lines.push(`- On switch: **${settings.restartStrategy}**, ${settings.restartGraceSeconds}s grace, this window's sessions ${
      settings.protectInvokingSession ? 'protected' : 'not protected'
    }`);
  } catch (error) {
    lines.push(`- Could not list processes: ${describe(error)}`);
  }
  lines.push('');

  lines.push('## Sync', '');
  const syncStatus = await tidemark.sync.status();
  lines.push(`- Enabled: ${syncStatus.enabled ? 'yes' : 'no'}`);
  if (syncStatus.enabled) {
    lines.push(`- Repository: \`${syncStatus.repository}\` branch \`${syncStatus.branch}\``);
    lines.push(`- Cloned locally: ${syncStatus.cloned ? 'yes' : 'no'}`);
    if (syncStatus.lastCommit) {
      lines.push(`- Last commit: ${syncStatus.lastCommit} (${formatRelative(syncStatus.lastCommitAt, now)})`);
    }
    if (syncStatus.error) lines.push(`- Problem: ${syncStatus.error}`);
    lines.push(`- Locked: ${tidemark.passphrase.locked ? 'yes — the passphrase has not been entered' : 'no'}`);
  }
  lines.push('');

  lines.push('## Settings in force', '');
  lines.push(`- Poll: every ${settings.pollIntervalMinutes}m in use, ${settings.idlePollIntervalMinutes}m idle`);
  lines.push(`- Figures go stale after ${settings.staleAfterMinutes}m`);
  lines.push(`- Refresh idle accounts: ${settings.refreshIdle ? 'yes' : 'no'}`);
  lines.push(
    `- Auto-failover: ${settings.failoverEnabled ? 'on' : 'off'} — trigger at ${
      settings.policy.sessionTriggerPercent
    }% of the window, candidates under ${settings.policy.weeklyExhaustedPercent}% of the week, prefer over ${
      settings.policy.preferredWeeklyLeftPercent
    }% left, cooldown ${settings.failoverCooldownMinutes}m`,
  );
  lines.push('');

  lines.push('## What leaves this machine', '');
  lines.push('- `api.anthropic.com` — usage and profile lookups for your own accounts, and token refreshes.');
  lines.push(
    syncStatus.enabled
      ? `- \`${syncStatus.repository}\` — the encrypted bundle and a presence note.`
      : '- Nothing else. Sync is off.',
  );
  lines.push('- No telemetry, no analytics, no third-party services.');
  lines.push('');

  const document = await vscode.workspace.openTextDocument({
    content: lines.join('\n'),
    language: 'markdown',
  });
  await vscode.window.showTextDocument(document, { preview: true });
  try {
    await vscode.commands.executeCommand('markdown.showPreview');
  } catch {
    /* plain text is fine */
  }
}

function describe(error: unknown): string {
  if (error instanceof ApiError) return `${error.kind} — ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
