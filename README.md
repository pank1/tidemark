# Tidemark

**See how much Claude quota you have left, and move between your Claude accounts from the status bar.**

Tidemark puts your 5-hour window, your week and a countdown to the next reset in the VS Code
status bar, and — if you have more than one Claude subscription — lets you switch between them
without a terminal.

```
⚡ you   75%  wk 28%  🕐 2h41m
```

It is not made by Anthropic. It reads the sign-in Claude Code already uses and asks Anthropic
for the same figures the `/usage` panel shows.

---

## It works the moment it is installed

No configuration, no account, no sign-up. If Claude Code is signed in on this machine, the
status bar fills in within a few seconds. Hover it for the detail:

- **5-hour window** and **this week**, each as a bar, a percentage left and a reset time
- per-model limits when your plan has them
- what has been spending your week — Claude Code, chats, and so on
- how old the figures are

If Anthropic cannot be reached, the last figures stay on screen with a clock icon instead of
disappearing. A `~` in front of a number means it is an estimate from your local session logs
rather than a measurement.

## More than one account

Claude Code does the signing in; Tidemark keeps a copy of each sign-in so you can move
between them.

- **Tidemark: Add Another Account…** walks through it: save the current account, sign out,
  sign in with the next one, save that too.
- **Tidemark: Save Current Login** captures whatever Claude Code is signed in to right now.

Click the status bar for the switcher. Every account is listed with its own figures, so you can
see which one has room before choosing it. Switching swaps the sign-in and restarts your Claude
Code sessions so they come back on the new account.

## The same accounts on every machine

Optional. Your accounts go into one file, encrypted with a passphrase, in a **private git
repository you own**:

| File | What it is |
| --- | --- |
| `accounts.tdmk` | every account, scrypt + AES-256-GCM, opened only by your passphrase |
| `presence/*.json` | which machine is on which account — a machine name, an opaque id, a timestamp |

On the next machine, point Tidemark at the same repository and enter the same passphrase.

The passphrase is held in memory for the window by default, and never written to disk unless
you turn on `tidemark.sync.rememberPassphrase`, which puts it in your operating system's
keychain. **There is no recovery if you lose it.**

## Auto-failover (off by default)

With several accounts you can let Tidemark move for you when the one in use runs out. It
picks the account **whose weekly window resets soonest** among those that still have quota —
the quota that is about to expire gets spent first. After a 5-hour window finishes it prefers
an account with real room left in its week, relaxing that only if nothing qualifies.

Every automatic switch is announced, with the reason, and can be undone in one click.

This manages subscriptions you already have. It does not raise, pool or work around any limit,
and nothing here creates accounts.

## Commands

| Command | What it does |
| --- | --- |
| Tidemark: Switch Account… | The switcher, with live figures for every account |
| Tidemark: Add Another Account… | Guided flow for adding a second (or sixth) account |
| Tidemark: Save Current Login | Store the sign-in Claude Code is holding now |
| Tidemark: Refresh Usage | Ask Anthropic again, immediately |
| Tidemark: Set Up Sync Across Machines… | Create or join the encrypted repository |
| Tidemark: Pull / Push Accounts | Sync by hand |
| Tidemark: Unlock / Lock | Enter or forget the passphrase |
| Tidemark: Doctor | One page explaining everything it can currently see |
| Tidemark: Copy Usage Summary | All accounts as plain text, for a message to someone |

## Settings worth knowing

| Setting | Default | |
| --- | --- | --- |
| `tidemark.pollIntervalMinutes` | 5 | How often the account in use is checked |
| `tidemark.idlePollIntervalMinutes` | 15 | How often the others are |
| `tidemark.restartStrategy` | `reload` | `reload`, `kill` or `none` — what happens to running sessions on a switch |
| `tidemark.failover.enabled` | `false` | Auto-failover |
| `tidemark.failover.weeklyExhaustedPercent` | 95 | Past this, an account is not a candidate |
| `tidemark.failover.preferredWeeklyLeftPercent` | 50 | Cushion preferred after a window finishes |
| `tidemark.refreshPolicy` | `auto` | Whether idle accounts' tokens may be refreshed here |
| `tidemark.estimate.enabled` | `true` | Local estimate when the API is unreachable |

## What leaves your machine

- **`api.anthropic.com`** — usage and profile lookups for your own accounts, and token
  refreshes. The same host Claude Code already talks to.
- **Your sync repository**, if you turn sync on — the encrypted bundle and the presence note.

There is no telemetry, no analytics and no third-party service. `Tidemark: Doctor` prints
this list from the live configuration so you can check rather than take it on faith.

Accounts are stored at `~/.tidemark/profiles.json`, mode `0600` — the same posture as
Claude Code's own `~/.claude/.credentials.json`, which already sits beside it. Encryption
applies to the copy that leaves the machine.

## When something looks wrong

Run **Tidemark: Doctor**. It reports which credential store was found, whether the token is
valid, whether the usage lookup works right now, what each account last reported, how many
sessions are running, and the state of sync. It blurs email addresses, so it is safe to paste
into an issue.

## Platform notes

- **Linux and Windows** read `~/.claude/.credentials.json`.
- **macOS** reads the login keychain (`Claude Code-credentials`), falling back to the file.
- `CLAUDE_CONFIG_DIR` is honoured if you have moved Claude Code's configuration.

## Building it yourself

```bash
npm install
npm run check      # types + unit tests
npm run build      # bundle to dist/
npm run package    # produces tidemark.vsix
```

`src/core/` is plain Node with no VS Code imports, so the policy, crypto, parsing and timing
are covered by `node --test` without an editor harness.

## Licence

MIT. Claude and Claude Code are trademarks of Anthropic; this project is unaffiliated and
refers to them only to say what it works with.
