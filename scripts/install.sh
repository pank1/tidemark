#!/usr/bin/env bash
# Install or update Tidemark on this machine from the repository.
#
# On a build machine:   scripts/install.sh --release   # build, stage the VSIX, install
# On every other box:   git pull && scripts/install.sh # install the staged VSIX, no node needed
#
# The staged VSIX lives in releases/ and is committed, so a machine with nothing
# but git and VS Code can update. 42 KB a release is not worth a build toolchain
# on six machines.
set -euo pipefail

cd "$(dirname "$0")/.."
RELEASE_DIR="releases"
DRY_RUN=0
DO_RELEASE=0

for arg in "$@"; do
  case "$arg" in
    --release) DO_RELEASE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

version="$(node -p "require('./package.json').version" 2>/dev/null || grep -m1 '"version"' package.json | cut -d'"' -f4)"

if [ "$DO_RELEASE" = 1 ]; then
  echo "==> checking and building $version"
  npm run check
  npm run build
  npx @vscode/vsce package --out "$RELEASE_DIR/tidemark-$version.vsix"
  echo "==> staged $RELEASE_DIR/tidemark-$version.vsix"
  echo "    commit it and pull on the other machines:"
  echo "    git add $RELEASE_DIR && git commit -m \"release $version\" && git push"
fi

vsix="$(ls -t "$RELEASE_DIR"/tidemark-*.vsix 2>/dev/null | head -1 || true)"
if [ -z "$vsix" ]; then
  echo "No VSIX in $RELEASE_DIR. Run with --release on a machine that has node." >&2
  exit 1
fi

# VS Code, VS Code Insiders, VSCodium — whichever is on PATH.
cli=""
for candidate in code code-insiders codium; do
  if command -v "$candidate" >/dev/null 2>&1; then cli="$candidate"; break; fi
done
if [ -z "$cli" ]; then
  echo "No VS Code CLI on PATH (tried code, code-insiders, codium)." >&2
  echo "In VS Code: Command Palette > 'Shell Command: Install code command in PATH'." >&2
  exit 1
fi

if [ "$DRY_RUN" = 1 ]; then
  echo "would run: $cli --install-extension $vsix --force"
  exit 0
fi

echo "==> installing $vsix with $cli"
"$cli" --install-extension "$vsix" --force
echo "==> done. Reload the window (Developer: Reload Window) to pick it up."
