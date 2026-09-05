#!/bin/bash
# Stage the proof driver: the real @abloh dist trees, plus the three third-party packages they
# import at runtime. Nothing is built here - these are the bytes `pnpm build` produced on the branch.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
D=${1:-$RUNNER_TEMP/overlay-proof}
rm -rf "$D"; mkdir -p "$D"
cp "$HERE/driver.mjs" "$HERE/package.json" "$D/"
cd "$D"
npm install --no-audit --no-fund --loglevel=error
# AFTER the install, because npm prunes what package.json does not name and these are not named:
# they are the branch's own build output, dropped in by path rather than resolved from a registry.
cp -R "$HERE/vendor/@abloh" "$D/node_modules/@abloh"
echo "staged $D"
