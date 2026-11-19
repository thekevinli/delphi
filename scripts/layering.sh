#!/usr/bin/env bash
# scripts/layering.sh PY
#
# Plan 4 §3.2's layering checks over this checkout, run from the test kit
# (`python -m delphi_core_testkit.abstraction`) with interpreter PY, which must
# import delphi_core, delphi_desktop and the kit (scripts/core-env.sh's does).
# Run by `check.sh --core` and `scripts/ci_core.sh`; each check's own exit
# status is its verdict, and any failure fails this script.
#
#   A1  imports        core and the desktop layer import in the allowed direction;
#                      core/abstraction-exceptions.txt is empty
#   A3  surface        core/public-surface.txt is what core renders now
#   A4  http           the desktop app's API is the reference app's, plus /api/desktop/
#   A6  settings       DesktopSettings keeps every core key as core declares it
#   A7  versions       desktop/package.json and its lockfile, core's, the kit's and
#                      the layer's pyproject.toml, and the two delphi-core pins name
#                      one version
#   A8  private-names  no tracked file names the private deployment; the list is
#                      private, so this runs only when DELPHI_PRIVATE_NAMES names it
#
# A2 is scripts/core_alone.sh, A5 the core suite under DELPHI_REQUIRE_CONFORMANCE,
# A9 scripts/check_vocabulary.py.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="${1:?usage: scripts/layering.sh PY}"
cd "$ROOT"
failed=()
check() {
  local name="$1"; shift
  printf -- '-- %s\n' "$name"
  "$PY" -m delphi_core_testkit.abstraction "$@" || failed+=("$name")
}

check "A1 imports" imports --package core/delphi_core --package desktop/backend/delphi_desktop \
  --exceptions core/abstraction-exceptions.txt --require-empty
check "A3 surface" surface check --snapshot core/public-surface.txt
check "A4 http" http --reference delphi_core.main:app --product delphi_desktop.main:app
check "A6 settings" settings --discover delphi_desktop
check "A7 versions" versions --package-json desktop/package.json --package-lock desktop/package-lock.json \
  --pyproject core/pyproject.toml --pyproject core/testkit/pyproject.toml --pyproject desktop/backend/pyproject.toml
if [[ -n "${DELPHI_PRIVATE_NAMES:-}" ]]; then
  check "A8 private names" private-names --names "$DELPHI_PRIVATE_NAMES" --root "$ROOT"
else
  printf -- '-- A8 private names\nA8 private names: skipped: no list (set DELPHI_PRIVATE_NAMES to the private list kept outside this repository).\n'
fi

if [[ ${#failed[@]} -gt 0 ]]; then
  printf 'layering: FAILED: %s\n' "${failed[@]}" >&2
  exit 1
fi
if [[ -n "${DELPHI_PRIVATE_NAMES:-}" ]]; then echo "layering: A1, A3, A4, A6, A7 and A8 passed."
else echo "layering: A1, A3, A4, A6 and A7 passed; A8 skipped."; fi
