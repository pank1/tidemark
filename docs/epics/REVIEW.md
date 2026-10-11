# Review pass — Tidemark

One pass over the finished build, against the five items in `TICKETS.md`. Eight defects found,
all fixed in the same pass; no second round.

---

## R1 — Secrets

**R1-a (serious). `redact()` corrupted every line it touched and leaked the token it was
redacting.** The replacer took `(_match, ...groups)` and kept anything string-shaped, but
`String.replace` passes the offset *and the whole input string* after the capture groups. The
full original line — token included — was spliced back in, repeatedly. A log line meant to read
`{"accessToken":"<redacted>"}` came out as four concatenated copies of itself with the raw
token still in it. Replaced the callback with explicit `$1<redacted>$2` replacement strings,
and added `test/log.test.ts` (7 tests) so the thing that guards every log line is itself
guarded.

**R1-b. Git remotes carry tokens.** `https://user:ghp_xxx@host/repo` appears verbatim in git's
own error text, which `GitError` passes to the log. Added a userinfo pattern; `git@github.com:…`
remotes stay legible.

**R1-c.** `blurEmail('a@example.com')` added a star for a character that was not there. Cosmetic,
fixed.

## R2 — Atomicity

No defect. Credential writes go through `writeFileAtomic` (write to a temp file in the same
directory, `fsync`, rename) and are preceded by a timestamped backup, so an interrupted switch
leaves either the old file or the new one. Verified the failure ordering in `switchTo`: the
credential write happens before any state change, and a throw leaves the store untouched.

## R3 — Degradation with nothing configured

**R3-a. The welcome content could never appear.** `getChildren()` always returned the sync row,
so the panel was never empty, so VS Code never showed `viewsWelcome` — the one place a new user
with no accounts is told what to do. Now returns nothing when there are no accounts and sync is
off.

Everything else held: no credentials gives "No Claude account" rather than an error; a failing
usage lookup never produces a dialog; sync, failover and the estimate are all inert until asked
for. Confirmed end to end by `npm run smoke`, which runs the built bundle against a stub editor
with a throwaway config directory and asserts that a dead token produces no error dialog.

## R4 — The failover rule

No defect. 18 tests in `test/policy.test.ts` cover the rule itself and the cases that have no
good answer: every account exhausted, every account stale, one account only, ties. Unparseable
reset times sort last, so a malformed timestamp can never win a race.

## R5 — Cross-machine

**R5-a (serious). The active account's record could be overwritten with another account's
tokens.** The poller re-read the credential file for the active account and wrote whatever it
found into that profile. If the user had signed in elsewhere with a different account in the
meantime, account A's record silently acquired account B's tokens — losing A, and leaving two
profiles pointing at B.

The cause was trying to answer "are these the same account?" by comparing tokens, which cannot
work: Claude Code's own refresh rotates *both* tokens, so a legitimate refresh looks exactly
like a different account. Moved the decision into one place, `Tidemark.reconcileCurrentLogin()`,
which settles the common case with a string comparison and only pays for an identity lookup when
the credentials are genuinely unfamiliar — and when that lookup fails, changes nothing at all.

**R5-b. A switch could write a stale token over a fresh one.** `switchTo` compared the live
credentials with the stored copy by refresh token. After Claude Code rotated its own token the
two no longer matched, so switching "to the account you are already on" would write the older,
now-invalid credentials back — signing the user out of the account they were using. Fixed by
reconciling first.

**R5-c. An account could be stranded on one machine.** `pull` only pushed back when it held a
*newer* copy of something the remote already had. An account that existed only locally was
merged in memory and never published. Now local-only accounts also mark the remote as behind.

**R5-d. Presence cost one git subprocess per account per refresh.** `presenceFor(id)` listed and
read every presence file, and was called once per account — with six accounts and six machines,
thirty-six subprocesses every few minutes for one line of grey text. Replaced with
`presenceByAccount()`, a single pass.

## Also fixed, outside the five

- **The announcement died with the window.** With the default `reload` strategy the switch
  reloads the window, which tears down the extension host and takes the "switched to X, Undo"
  notification with it — so an automatic failover would have been silent, which is the one thing
  it must never be. The message is now parked in state and shown, with its undo, by the window
  that comes back.
- **`kill` with this window protected said nothing about it.** Sessions in the current window
  stay on the previous account and nothing will restart them; the result message now says so.
- **Turning on "remember the passphrase" asked for it again** immediately after it had been
  typed. Added `PassphraseHolder.persist()`.

## State at the end of the pass

```
npm run check   57 tests, all passing; types clean
npm run smoke   activates, registers 17/17 commands, adopts the existing sign-in, no dialogs
npm run package tidemark.vsix, 14 files, 42 KB
```
