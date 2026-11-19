#!/usr/bin/env bash
#
# Third-party notices for what this build ships (build/notices.mjs says how).
# Last in `npm run build`: it reads the interpreter, the interface build and
# both npm trees the other steps leave behind, and stops the build if any of
# them holds something it cannot account for.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/build/runtime.sh"
ensure_frontend_runtime
node "$ROOT_DIR/build/notices.mjs"
