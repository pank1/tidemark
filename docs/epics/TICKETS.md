# Tickets — Tidemark

Build order is top to bottom. Per standing rule: build every ticket, then one review pass at
the end — no review/fix rounds in between.

| # | Ticket | Lands in | Done |
|---|---|---|---|
| **Foundation** | | | |
| SB-001 | Repo scaffold: package.json contributions, tsconfig, esbuild bundle, CI, ignores | `package.json`, `esbuild.mjs`, `tsconfig.json` | ☑ |
| SB-002 | Types + paths: profile/snapshot/state schemas, `~/.tidemark` layout, platform paths | `src/core/types.ts`, `paths.ts` | ☑ |
| SB-003 | Credential store: read/write Claude credentials on linux/win (file) and darwin (keychain), atomic, backed up | `src/core/credstore.ts` | ☑ |
| SB-004 | API client: usage, profile, token refresh; timeouts, error taxonomy, no telemetry | `src/core/api.ts` | ☑ |
| SB-005 | Profile store: add/remove/rename/label, active pointer, schema version + migration | `src/core/profiles.ts` | ☑ |
| **Status** | | | |
| SB-006 | Usage parsing: response → snapshot (5h, week, scoped limits, breakdown, severity) | `src/core/usage.ts` | ☑ |
| SB-007 | Time helpers: countdown formatting, relative "as of", reset-soonest ordering | `src/core/time.ts` | ☑ |
| SB-008 | Local estimator fallback from `~/.claude/projects/**.jsonl` | `src/core/estimate.ts` | ☑ |
| SB-009 | Poller: schedule, per-account snapshots, disk cache, staleness, backoff | `src/core/poller.ts` | ☑ |
| SB-010 | Status bar: active account, % left both windows, countdown, severity colour, click → switcher | `src/ui/statusbar.ts` | ☑ |
| SB-011 | Quick-pick switcher: every account with live numbers, presence note, inline actions | `src/ui/quickpick.ts` | ☑ |
| SB-012 | Tree panel: per-account window/week bars, resets, surface breakdown, sync + presence rows | `src/ui/tree.ts` | ☑ |
| **Switching** | | | |
| SB-013 | Capture current login → profile, auto-labelled from the profile endpoint | `src/core/profiles.ts`, `controller.ts` | ☑ |
| SB-014 | Switch: atomic swap, verify, re-label, update state | `src/controller.ts` | ☑ |
| SB-015 | Session discovery: claude processes (via `/proc` or `ps`) + IDE lock files, busy/idle, protected PIDs | `src/core/sessions.ts` | ☑ |
| SB-016 | Restart: SIGTERM → grace → SIGKILL, then window reload; `reload`/`kill`/`none` strategies | `src/core/sessions.ts`, `controller.ts` | ☑ |
| SB-017 | Add-account wizard: capture → logout → wait for login → capture, with a cancel at every step | `src/ui/wizard.ts` | ☑ |
| **Failover** | | | |
| SB-018 | Policy engine implementing D-07, pure + unit-tested | `src/core/policy.ts` | ☑ |
| SB-019 | Failover trigger: threshold/lock/window-complete detection, cooldown, announcement | `src/controller.ts` | ☑ |
| SB-020 | Locked-passphrase deferral: notify + one-click unlock instead of a silent stall | `src/controller.ts`, `ui/notify.ts` | ☑ |
| **Sync** | | | |
| SB-021 | Crypto: scrypt + AES-256-GCM, versioned header, tamper detection, unit-tested | `src/core/crypto.ts` | ☑ |
| SB-022 | Bundle: profiles + meta → ciphertext and back, schema version, format doc | `src/core/bundle.ts`, `docs/BUNDLE-FORMAT.md` | ☑ |
| SB-023 | Passphrase: prompt, in-memory session cache, lock/unlock commands, never written to disk | `src/ui/passphrase.ts` | ☑ |
| SB-024 | Git transport: init/clone/pull/commit/push, identity, conflict = last-writer-wins + backup | `src/core/git.ts` | ☑ |
| SB-025 | Presence: machine id, heartbeat, read others, advisory rendering | `src/core/presence.ts` | ☑ |
| SB-026 | Sync commands: setup wizard, pull, push, auto-sync on switch/capture | `src/ui/syncSetup.ts`, `controller.ts` | ☑ |
| **Install UX** | | | |
| SB-027 | Walkthrough (3 steps), first-run nudge once, no modals | `package.json` walkthrough | ☑ |
| SB-028 | Settings schema with plain-English descriptions and safe defaults | `package.json` configuration | ☑ |
| SB-029 | Doctor: credential store, token, API, sync, passphrase, sessions — one readable report | `src/ui/doctor.ts` | ☑ |
| SB-030 | README, privacy note, CHANGELOG, LICENSE, icon, Marketplace metadata | repo root, `media/` | ☑ |
| SB-031 | Unit tests (policy, crypto, usage, time, estimate) + `npm run check` | `test/**` | ☑ |
| SB-032 | Publisher/packaging runbook: what the maintainer must do by hand to list it | `docs/PUBLISHING.md` | ☑ |

## Review pass (after all of the above) — done, see `REVIEW.md`

| | Area | Outcome |
|---|---|---|
| R1 | Secrets in logs, errors, git | **3 fixed** — `redact()` was corrupting lines and re-emitting the token it was redacting; git remotes with embedded tokens; a cosmetic blur bug |
| R2 | Atomicity of credential writes | clean |
| R3 | Degradation with nothing configured | **1 fixed** — the panel's welcome content could never appear |
| R4 | The failover rule | clean (18 tests) |
| R5 | Cross-machine | **4 fixed** — one account's record could be overwritten with another's tokens; a switch could write a stale token over a fresh one; a local-only account was never published; presence spawned a git process per account per refresh |
| — | Found outside the five | **3 fixed** — the failover announcement died with the window reload; `kill` said nothing about protected sessions; enabling "remember passphrase" re-prompted |

Verification at the end of the pass: `npm run check` 57 tests green, `npm run smoke` activates
the built bundle against a stub editor with 17/17 commands registered and no error dialogs on a
dead token, `npm run package` produces a 42 KB VSIX.
