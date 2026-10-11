# EPIC — Tidemark

**One line:** a VS Code extension that shows how much Claude quota you have left, when it
resets, and lets you move between several Claude accounts without touching a terminal.

**Status:** build in progress (single iteration, review at the end)
**Owner:** the maintainer · **Opened:** 2026-10-10

---

## Problem

Six Max 20x accounts across six machines. Today, knowing which account has headroom means
opening a session and running `/usage`; moving to another account means `/logout`, `/login`,
and re-authenticating on whichever machine you happen to be at. Quota that expires unused is
invisible until it is gone.

## Outcome

1. **Status is always visible.** Status bar shows the active account, % left on the 5-hour
   window and the week, and a live countdown to the next reset.
2. **Switching is one click.** A quick-pick lists every known account with its real numbers;
   choosing one swaps credentials and brings sessions back on the new account.
3. **Accounts follow you.** All accounts live in one passphrase-encrypted bundle in a private
   git repo; any machine that can decrypt it has every account.
4. **Nothing is wasted.** When the active account is spent, Tidemark moves to the account
   whose weekly window resets soonest — use-it-or-lose-it quota goes first.

## Audience, in priority order

1. **A stranger who installs it from the Marketplace with one account.** Must be useful in five
   seconds with zero configuration and zero external binaries: install → status bar shows their
   usage. Everything else is optional and discoverable.
2. **Someone with two accounts on one machine.** Switching works without sync ever being set up.
3. **The maintainer: six accounts, six machines.** Sync, presence and auto-failover.

A feature that only works for audience 3 must degrade silently for 1 and 2 — never an error,
never a modal, never a red status bar.

## In scope

- Live usage for the active account and for every stored account (official API).
- Local-transcript estimate as a labelled fallback when the API is unreachable.
- Account capture, labelling, switching, removal; guided add-account wizard.
- Session discovery + restart on switch.
- Auto-failover on the agreed policy, off by default for new installs.
- Passphrase-encrypted bundle, git transport, presence advisory.
- Walkthrough, doctor command, README, privacy note, packaging.

## Out of scope

- Reimplementing Claude's OAuth login (see D-02).
- Any coordination that *blocks* a machine from using an account (soft advisory only, D-09).
- Non-VS-Code surfaces: CLI, JetBrains, claude.ai/desktop (scoped out in round 3).
- API-key / Bedrock / Vertex auth. Subscription OAuth accounts only.
- Spend/credit management beyond displaying what the API reports.

## Acceptance

| # | Check |
|---|---|
| A1 | Fresh install, one signed-in account, no settings touched → status bar shows 5h %, week %, countdown within 10s. |
| A2 | No credentials present → status bar reads "Not signed in", no error toast. |
| A3 | Second account captured → quick-pick lists both with live numbers; switching changes the active account and sessions come back on it. |
| A4 | Airplane mode → last snapshot shown with a staleness marker, no error toast. |
| A5 | Expired access token → refreshed transparently; a refresh failure marks that one account "needs sign-in" and leaves its stored credentials intact. |
| A6 | Sync set up on machine B from the same repo + passphrase → all accounts appear, no re-login. |
| A7 | Wrong passphrase → clear message, no partial writes, no profile loss. |
| A8 | Active account crosses the failover threshold with failover on → picks per policy, announces what it did and why. |
| A9 | Failover with a locked passphrase → notification offering unlock, no silent stall. |
| A10 | `Tidemark: Doctor` reports credential store, token validity, API reachability, sync state and passphrase state in one panel. |
| A11 | `npm run check` (types + unit tests) green; `npm run package` produces an installable VSIX. |
| A12 | Nothing leaves the machine except (a) the usage/profile calls to api.anthropic.com and (b) the encrypted bundle to the user's own git remote. Asserted in the privacy note and verifiable in `src/core/api.ts`. |

## Known hazards (addressed in build, not deferred)

- **H1 Refresh-token rotation across machines.** Refreshing an account's token on machine A can
  invalidate the copy machine B holds. Mitigated by D-06: only the machine that owns an account
  refreshes it.
- **H2 Killing the session that ordered the switch.** Mitigated by a protected-PID list and by
  preferring a window reload over a kill where it suffices.
- **H3 Undocumented endpoint.** `/api/oauth/usage` is a client-internal endpoint. Mitigated by
  the estimator fallback and a degraded, non-alarming UI (D-03).
- **H4 Trademark.** Brand is "Tidemark"; Claude is referenced only descriptively (D-11).
- **H5 Reading it as limit circumvention.** Failover ships off by default, is documented as
  "spend the quota that expires soonest", and the extension never creates accounts or bypasses
  any limit (D-12).
