# Getting it onto machines

Two routes. **Route A** needs no accounts and no decisions; **route B** is the Marketplace.
Nothing in the code differs between them — route B is route A plus a publisher id.

---

# Route A — internal only

No publisher, no Marketplace review, no public framing question. The one thing the Marketplace
would have given you is automatic updates on six machines, so that is the only gap to close.

The VSIX is committed to `releases/`, so a machine needs nothing but git and VS Code:

```bash
# on whichever machine you build from
scripts/install.sh --release
git add releases && git commit -m "release 0.1.0" && git push

# on each of the others
git pull && scripts/install.sh
```

`scripts/install.sh` finds the newest VSIX in `releases/`, picks whichever of `code`,
`code-insiders` or `codium` is on PATH, and installs with `--force` so it replaces the previous
build. `--dry-run` prints what it would do. A 42 KB file per release is cheaper than keeping a
node toolchain on six boxes.

For this to work the repository needs a remote — a private GitHub repo is enough, and it can be
the same account that holds the encrypted sync bundle or a separate one. Nothing in `releases/`
is sensitive: it is the extension, not your accounts.

**What internal-only lets you skip:** registering a publisher, `vsce login`, Marketplace
verification, semver discipline, and the question of how a public listing of a multi-account
switcher reads. **What it does not change:** any of the code. Going public later is a one-line
edit to `publisher` plus route B.

---

# Route B — the Marketplace

Everything in the repository is ready to package. These steps need a human with accounts.

## 1. Register the publisher — the only step nobody else can do

`package.json` already says `"publisher": "tidemark"`. That id was checked as free on
2026-10-11 and **must be registered under exactly that spelling**, or the id in `package.json`
has to change to match what you get.

Go to <https://marketplace.visualstudio.com/manage>, sign in with a Microsoft account, and
create a publisher:

| Field | Value |
| --- | --- |
| ID | `tidemark` |
| Display name | Tidemark |

Creating a publisher silently creates an Azure DevOps organisation behind it. That is normal.

## 2. Personal access token

In Azure DevOps (<https://dev.azure.com>), **User settings → Personal access tokens → New**:

| Field | Value |
| --- | --- |
| Organization | **All accessible organizations** (not a single one — this is the usual cause of a 401 at publish) |
| Scopes | Custom defined → **Marketplace → Manage** |
| Expiry | as long as you are willing to re-do this |

Then either keep it local:

```bash
npx @vscode/vsce login tidemark     # paste the PAT
```

…or put it in the repository as a secret named `VSCE_PAT`, which is what the release workflow
uses:

```bash
gh secret set VSCE_PAT --repo pank1/tidemark      # paste the PAT
```

## 3. Package and check it before anyone else sees it

```bash
npm run check          # types + 57 unit tests
npm run smoke          # starts the built bundle against a stub editor
npm run package        # writes tidemark.vsix
code --install-extension tidemark.vsix
```

Install it on one machine first and work through the acceptance list in
`docs/epics/EPIC-TIDEMARK.md` — particularly A1 (fresh install, one account, nothing
configured) and A4 (offline), because those are what a stranger sees.

## 4. Publish

Either by hand:

```bash
npx @vscode/vsce publish            # or: publish minor / patch
```

…or by pushing a tag, which is what `.github/workflows/release.yml` is for:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

The workflow checks types, runs the tests, packages, attaches the VSIX to a GitHub release,
and publishes to the Marketplace **only if the `VSCE_PAT` secret is set** — without it the
release still happens and the Marketplace step is skipped with a note, so a missing token
cannot break a release.

The first publish takes a few minutes to verify. Afterwards anyone can install it, so the
README's framing matters: lead with quota visibility, keep failover described as spending the
quota that expires soonest, and keep the "not affiliated with Anthropic" line.

## Known at the time of the first release

- **`/api/oauth/usage` is a client-internal endpoint.** Undocumented, needs no special header,
  only ever returns the caller's own figures — and can change without notice. The estimate
  fallback and the non-alarming degraded UI exist for that day, and the README says plainly
  that the figures come from an undocumented source.
- **macOS keychain writing is unverified.** The read/write path uses `/usr/bin/security` with
  the service name `Claude Code-credentials`; no Mac was available to test it. `Tidemark:
  Doctor` reports which store it found. Treat the first macOS issue as expected, not
  surprising.
- **The niche is not empty.** `ShivaKrishnaKokkula.claude-usage-meter` and
  `Mehrshad.claude-code-meter` already show Claude usage. What is not already there is several
  accounts, switching between them, and carrying them between machines — the README leads on
  that.

## Releasing an update

1. Update `CHANGELOG.md`.
2. `npm version patch|minor` (bumps `package.json`, creates the tag).
3. `scripts/install.sh --release` and use it locally for a day.
4. `git push --follow-tags`, and the workflow does the rest.
