#!/usr/bin/env bash
#
# The development interpreter the core's tests and release checks run in: the
# same pinned python-build-standalone build the app ships, unstripped, with
# core/ installed editable with its dev and release extras, and the
# desktop layer (desktop/backend/) and the test kit (core/testkit/) editable on
# it. Rebuilt only when one of their pyproject.toml files changes. Prints the
# interpreter's path.
#
#   bash scripts/core-env.sh          # ensure it exists; print .delphi-build/core-env/bin/python3
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT_DIR/.delphi-build/core-env"
PY="$OUT_DIR/bin/python3"
source "$ROOT_DIR/scripts/python-standalone.sh"

want="$(cat "$ROOT_DIR/core/pyproject.toml" "$ROOT_DIR/desktop/backend/pyproject.toml" "$ROOT_DIR/core/testkit/pyproject.toml" <(printf '%s\n' "$PBS_PYTHON+$PBS_RELEASE") | shasum -a 256 | awk '{print $1}')"
if [[ -x "$PY" && "$(cat "$OUT_DIR/.core-env" 2>/dev/null)" == "$want" ]]; then
  printf '%s\n' "$PY"
  exit 0
fi

archive="$(standalone_archive)"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
tar -xzf "$archive" --strip-components=1 -C "$OUT_DIR"
"$PY" -m pip install --quiet --upgrade pip >&2
"$PY" -m pip install --quiet -e "$ROOT_DIR/core[dev,release]" >&2
# The desktop layer, on this core and nothing else: its only dependency is the core above.
"$PY" -m pip install --quiet --no-deps -e "$ROOT_DIR/desktop/backend" >&2
# The test kit core's own tests consume, as a product would (its dependencies are core's [dev]).
"$PY" -m pip install --quiet --no-deps -e "$ROOT_DIR/core/testkit" >&2
"$PY" -m pip check >&2
printf '%s\n' "$want" > "$OUT_DIR/.core-env"
printf '%s\n' "$PY"
