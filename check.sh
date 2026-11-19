#!/usr/bin/env bash
#
# Everything that has to be green, in one command.
#
#   bash check.sh            # core + core alone (A2) + parity gate + our own tests
#   bash check.sh --core     # only the core: pyflakes, vocabulary, layering (A1, A3, A4, A6-A8), its suite
#                            # (A5), the desktop layer's suite, the scripts' tests, JavaScript contracts
#   bash check.sh --parity   # only installed backend consumer contracts
#   bash check.sh --ours     # local frontend, browser (Chromium + WebKit) and shell tests
#
# core/ is the backend, built into the app from this checkout, and it is local:
# its suite needs no database. The desktop frontend evolves locally; parity
# checks the installed backend through public HTTP contracts.
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The desktop app: shell, frontend, their tests and build outputs.
DESKTOP="$ROOT_DIR/desktop"

run_core=1
run_parity=1
run_ours=1
# A2 builds both wheels and runs core's suite again in a clean venv: the full run only.
run_alone=0
case "${1:-}" in
  --core) run_parity=0; run_ours=0 ;;
  --parity) run_core=0; run_ours=0 ;;
  --ours) run_core=0; run_parity=0 ;;
  "") run_alone=1 ;;
  *) echo "usage: check.sh [--core|--parity|--ours]" >&2; exit 2 ;;
esac

# Parity and our own tests run against the built runtime; a stale one stops them first.
if [[ $run_parity == 1 || $run_ours == 1 ]]; then
  bash "$DESKTOP/build/check-backend-runtime.sh" || exit 1
fi

failures=()
step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

if [[ $run_core == 1 ]]; then
  # pyflakes reads every line whether or not a test reaches it (scripts/check_pyflakes.py).
  step "core: pyflakes"
  if CORE_PY="$(bash "$ROOT_DIR/scripts/core-env.sh")"; then
    "$CORE_PY" "$ROOT_DIR/scripts/check_pyflakes.py" || failures+=("core pyflakes")
    # Memory's former name, anywhere in the tracked tree, fails unless its allowlist says why.
    step "core: vocabulary"
    "$CORE_PY" "$ROOT_DIR/scripts/check_vocabulary.py" || failures+=("core vocabulary")
    # Plan 4's layering checks, from the test kit: A1, A3, A4, A6, A7, and A8 when
    # DELPHI_PRIVATE_NAMES names the private list (scripts/layering.sh).
    step "core: layering"
    bash "$ROOT_DIR/scripts/layering.sh" "$CORE_PY" || failures+=("core layering")
    # A5: the run fails unless it ran every kit store test on the local store, skipping none.
    step "core: suite"
    ( cd "$ROOT_DIR/core" && DELPHI_REQUIRE_CONFORMANCE=local "$CORE_PY" -m pytest -q -p no:cacheprovider ) || failures+=("core suite")
    # The desktop's own Python layer over that core: its app, settings and contracts.
    step "desktop layer: suite"
    ( cd "$DESKTOP/backend" && "$CORE_PY" -m pytest -q -p no:cacheprovider ) || failures+=("desktop layer suite")
    # The release, wheel and gate scripts' own tests, which read this checkout.
    step "scripts: suite"
    ( cd "$ROOT_DIR/scripts" && "$CORE_PY" -m pytest -q -p no:cacheprovider ) || failures+=("scripts suite")
    if [[ $run_alone == 1 ]]; then
      # A2: the core and kit wheels alone, in a venv outside the repository (scripts/core_alone.sh).
      step "core alone: the two wheels and nothing else (A2)"
      # The wheels alone, from an empty catalog so compared with no release, offline: ci_core.sh compares them.
      wheels="$(mktemp -d "${TMPDIR:-/tmp}/delphi-core-wheels.XXXXXX")"
      printf '[[]]\n' > "$wheels/releases.json"
      { "$CORE_PY" "$ROOT_DIR/scripts/backend_release.py" build --releases-json "$wheels/releases.json" \
          --output "$wheels/dist" >/dev/null \
        && CORE_ALONE_PY="$CORE_PY" bash "$ROOT_DIR/scripts/core_alone.sh" "$wheels/dist"; } || failures+=("core alone")
      rm -rf "$wheels"
    fi
  else
    failures+=("core environment")
  fi
  step "core: JavaScript contracts"
  ( source "$DESKTOP/build/runtime.sh"; ensure_frontend_runtime
    node --test "$ROOT_DIR/core/tests/web-annotations.test.mjs" "$ROOT_DIR/core/tests/artifact-inspector.test.mjs" ) || failures+=("core JavaScript contracts")
fi

if [[ $run_parity == 1 ]]; then
  step "installed backend consumer contracts (desktop-owned)"
  ( source "$DESKTOP/build/runtime.sh"; ensure_frontend_runtime
    cd "$DESKTOP" && DELPHI_REQUIRE_INTEGRATION=1 node --test --experimental-strip-types tests/integration.test.mts ) \
    || failures+=("installed backend consumer contracts")
fi

if [[ $run_ours == 1 ]]; then
  # The frontend's own type check, which also compiles the shell files its tests
  # import. `next build` checks only what the app bundles.
  step "macOS frontend types"
  ( source "$DESKTOP/build/runtime.sh"; ensure_frontend_runtime
    cd "$DESKTOP/frontend" && node node_modules/typescript/bin/tsc --noEmit ) || failures+=("macOS frontend types")
  step "macOS frontend suite"
  ( source "$DESKTOP/build/runtime.sh"; ensure_frontend_runtime
    cd "$DESKTOP/frontend" && "$DELPHI_PNPM" test ) || failures+=("macOS frontend suite")
  # The reader's frame, its annotation worker and pointer events are out of
  # node --test's reach; the shipped viewers run in Chromium and WebKit
  # against the frame scripts of the bundled backend.
  step "reader in Chromium and WebKit"
  ( source "$DESKTOP/build/runtime.sh"; ensure_frontend_runtime
    cd "$DESKTOP/frontend" && "$DELPHI_PNPM" exec playwright install chromium webkit >/dev/null \
      && "$DELPHI_PNPM" test:browser --reporter=line ) || failures+=("reader in Chromium and WebKit")
  step "desktop tests"
  if [[ ! -f "$DESKTOP/.delphi-build/dist/server/index.js" || ! -x "$DESKTOP/.delphi-build/python/bin/python3" || ! -x "$DESKTOP/.delphi-build/native/delphi-mcp" ]]; then
    echo "Required integration payloads are missing; run npm run build first." >&2
    failures+=("integration payloads missing")
  fi
  # Shell tests use the same local pinned Node as the frontend.
  ( source "$DESKTOP/build/runtime.sh"; ensure_frontend_runtime
    cd "$DESKTOP"
    node node_modules/typescript/bin/tsc --noEmit || exit $?
    shell_tests=()
    for path in tests/*.test.mts; do
      [[ "$path" == tests/integration.test.mts && $run_parity == 1 ]] || shell_tests+=("$path")
    done
    DELPHI_REQUIRE_INTEGRATION=1 node --test --experimental-strip-types "${shell_tests[@]}" ) \
    || failures+=("desktop tests")
fi

if [[ ${#failures[@]} -gt 0 ]]; then
  printf '\n\033[1mFAILED:\033[0m\n'; printf '  - %s\n' "${failures[@]}"; exit 1
fi
printf '\n\033[1mAll checks passed.\033[0m\n'
