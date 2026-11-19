#!/usr/bin/env bash
#
# Bundle the main process. Electron cannot strip TypeScript types the way
# `node --test --experimental-strip-types` can, so the one compile step in this
# repo lives here.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT_DIR/.delphi-build/app"
mkdir -p "$OUT"
"$ROOT_DIR/node_modules/.bin/tsc" --noEmit -p "$ROOT_DIR/tsconfig.json"

# The commit Help → Copy Diagnostics reports: a local DMG carries the same
# version as a release, and only this tells them apart. Without git (or outside
# a checkout) it says "unknown"; it never fails the build.
commit="$(git -C "$ROOT_DIR" rev-parse --verify --quiet HEAD 2>/dev/null || echo unknown)"
if [[ "$commit" != unknown ]] && ! git -C "$ROOT_DIR" diff --quiet HEAD 2>/dev/null; then
  commit="$commit, with uncommitted changes"
fi

# ESM, because `worker-host.ts` imports delphi's Worker bundle with a dynamic
# `import()` of a file URL. `electron` is external: it is provided by the runtime.
"$ROOT_DIR/node_modules/.bin/esbuild" "$ROOT_DIR/main/index.ts" \
  --bundle --platform=node --format=esm --target=node20 \
  --packages=external --external:electron --outfile="$OUT/main.js" --log-level=warning \
  --define:DELPHI_BUILD_COMMIT="\"$commit\""

# CJS, because a preload script is loaded before ESM is available in that world.
"$ROOT_DIR/node_modules/.bin/esbuild" "$ROOT_DIR/preload/index.cjs" \
  --bundle --platform=node --format=cjs --target=node20 \
  --external:electron --outfile="$OUT/preload.cjs" --log-level=warning

echo "main process -> $OUT/main.js"
