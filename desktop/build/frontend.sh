#!/usr/bin/env bash
#
# Build the independently maintained macOS frontend.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT_DIR/.delphi-build/dist"
source "$ROOT_DIR/build/runtime.sh"
ensure_frontend_runtime
cd "$ROOT_DIR/frontend"
# Dependency versions and their build scripts are fixed by the local lockfile.
"$DELPHI_PNPM" install --frozen-lockfile --dangerously-allow-all-builds

# Not done by vite: `bootstrap.sh` and `deploy.sh` each carry this line, and
# without it the PDF viewer silently breaks (PdfViewer.tsx sets
# `workerSrc = "/pdf.worker.min.mjs"`).
cp node_modules/pdfjs-dist/build/pdf.worker.min.mjs public/pdf.worker.min.mjs

# `rm -rf dist` is required, not tidiness. Vite does not fully clean the output
# directory, and a stale chunk from a previous build with different environment
# survives and is served: an incremental rebuild kept a `routes-*.js` that had
# `http://localhost:8000` inlined, so the desktop app bypassed its own proxy and
# every API call went to a port nothing was listening on.
rm -rf dist

# Empty means same-origin: every request becomes a relative `/api/...` that the
# host's Worker proxies to FastAPI, exactly as the Cloudflare Worker does in
# production. This is the *deployed* configuration, which is the best-tested one.
NEXT_PUBLIC_API_BASE_URL="" "$DELPHI_PNPM" run build

# The backend validates drafts in the exact component/styles shipped above.
# No provider credentials or application server are present in this host.
"$DELPHI_NODE_DIR/bin/node" "$ROOT_DIR/build/artifact-validator.mjs"

rm -rf "$OUT_DIR"
mkdir -p "$(dirname "$OUT_DIR")"
cp -R dist "$OUT_DIR"

# A build whose HTML names a chunk the client directory does not contain is
# broken in a way that only shows up as a blank screen in the renderer, so it is
# checked here rather than discovered later.
missing=0
while read -r asset; do
  [ -f "$OUT_DIR/client$asset" ] || { echo "MISSING ASSET: $asset" >&2; missing=1; }
done < <(grep -rho '/assets/[A-Za-z0-9_.-]*\.js' "$OUT_DIR/server/index.js" | sort -u)
[ "$missing" -eq 0 ] || { echo "Build is internally inconsistent." >&2; exit 1; }

echo "frontend build -> $OUT_DIR"
