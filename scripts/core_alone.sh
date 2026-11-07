#!/usr/bin/env bash
# scripts/core_alone.sh DIST
#
# A2 (Plan 4 §3.2): core stands alone. A fresh virtualenv holds only the core and
# test-kit wheels in DIST (scripts/backend_release.py build): no extras, no
# product. Everything runs in a temporary directory outside the repository, so
# nothing there can reach this checkout, by path or through git:
#
#   probe    every delphi_core module imports without the kit's help, the reference
#            app builds and answers, `-m delphi_core.pdf_worker` runs (core_alone.py)
#   surface  the installed core renders exactly core/public-surface.txt (A3)
#   suite    the core suite passes from a copy of core/tests, every kit store test
#            included (A5), and every delphi_core and delphi_core_testkit module it
#            imported came from the venv
#
# A core test that reads a file outside core/tests (scripts/, desktop/, the
# package's own checkout) fails here; tests of scripts live in scripts/tests.
# Run by the full `check.sh` and by `scripts/ci_core.sh`. The venv is made from
# $CORE_ALONE_PY when set, else core-env's interpreter.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ $# -eq 1 && -d "$1" ]] || { echo "usage: scripts/core_alone.sh DIST" >&2; exit 2; }
DIST="$(cd "$1" && pwd)"
BASE="${CORE_ALONE_PY:-$(bash "$ROOT/scripts/core-env.sh")}"
shopt -s nullglob
core=("$DIST"/delphi_core-*.whl) kit=("$DIST"/delphi_core_testkit-*.whl)
[[ ${#core[@]} == 1 && ${#kit[@]} == 1 ]] || { echo "Expected one core wheel and one test-kit wheel in $DIST" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/delphi-core-alone.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
if git -C "$WORK" rev-parse --show-toplevel >/dev/null 2>&1; then
  echo "core alone: $WORK lies inside a git checkout; set TMPDIR to a directory outside every repository" >&2; exit 1
fi
mkdir "$WORK/run"
"$BASE" -m venv "$WORK/venv"
PY="$WORK/venv/bin/python"
# By path: delphi-core can only come from this build, never from an index.
"$PY" -m pip install --quiet --disable-pip-version-check "${core[0]}" "${kit[0]}"
"$PY" -m pip check

# The copy: the suite, pytest's configuration, the committed surface and the probe. Nothing else.
cp -R "$ROOT/core/tests" "$WORK/run/tests"
cp "$ROOT/core/pyproject.toml" "$ROOT/core/public-surface.txt" "$WORK/run/"
cp "$ROOT/scripts/core_alone.py" "$WORK/"
find "$WORK/run" -name __pycache__ -type d -prune -exec rm -rf {} +
export OPENAI_API_KEY="" SESSION_SECRET="${SESSION_SECRET:-core-alone-test-secret}"
export DELPHI_REQUIRE_CONFORMANCE="${DELPHI_REQUIRE_CONFORMANCE:-local}"
cd "$WORK/run"
printf '\n-- core alone: probe\n'
"$PY" -I "$WORK/core_alone.py" probe
printf '\n-- core alone: the installed surface is the committed one\n'
"$PY" -I -m delphi_core_testkit.abstraction surface check --snapshot public-surface.txt
printf '\n-- core alone: the suite, from a copy of core/tests\n'
"$PY" -I "$WORK/core_alone.py" suite -q -p no:cacheprovider
