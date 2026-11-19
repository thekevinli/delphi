#!/usr/bin/env bash
# A runtime built before `core/` or `desktop/backend/` changed must not be tested
# or shipped as if it were current. The receipt's fifth line is the content hash
# of what went into the two wheels; it must equal what the checkout holds now.
# Its sixth and seventh name the desktop layer's wheel, which a runtime built
# before the shell launched that layer does not have, and its eighth the
# repository's tree (Plan 4 A7), which a runtime built before 0.7.0 lacks.
#   --release   also refuses uncommitted changes in core/ or desktop/backend/, any
#               tracked file with uncommitted changes anywhere, and a receipt from
#               another commit or tree, so a DMG names exactly one commit and tree
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/build/backend-wheel.sh"
receipt="$ROOT_DIR/.delphi-build/python/backend-wheel.receipt"
stale() {
  echo "Backend runtime is missing or was built from other core/ content or another desktop/backend/. Run npm run build before checking or packaging." >&2
  exit 1
}
[[ -x "$ROOT_DIR/.delphi-build/python/bin/python3" && -f "$receipt" ]] || stale
[[ "$(sed -n 5p "$receipt")" == "$(core_content_hash)" ]] || stale
[[ "$(sed -n 6p "$receipt")" == delphi_desktop-*.whl && "$(sed -n 7p "$receipt")" =~ ^[0-9a-f]{64}$ ]] || stale
[[ "$(sed -n 8p "$receipt")" =~ ^[0-9a-f]{40,64}(,\ with\ uncommitted\ changes)?$ ]] || stale
if [[ "${1:-}" == "--release" ]]; then
  commit="$(core_commit)"
  if [[ "$commit" == *uncommitted* || "$commit" == unknown ]]; then
    echo "A release is built from a committed core/ and desktop/backend/: $commit" >&2; exit 1
  fi
  # Not only the wheels' inputs: whatever else is packaged comes from this tree too.
  dirty="$(git -C "$(core_root)" status --porcelain --untracked-files=no)"
  if [[ -n "$dirty" ]]; then
    printf 'A release is built from a clean checkout; tracked files with uncommitted changes:\n%s\n' "$dirty" >&2; exit 1
  fi
  [[ "$(sed -n 4p "$receipt")" == "$commit" ]] || {
    echo "The runtime was built at $(sed -n 4p "$receipt"), not $commit. Run npm run build." >&2; exit 1
  }
  tree="$(repository_tree)"
  [[ "$(sed -n 8p "$receipt")" == "$tree" ]] || {
    echo "The runtime was built from the tree $(sed -n 8p "$receipt"), not $tree. Run npm run build." >&2; exit 1
  }
fi
