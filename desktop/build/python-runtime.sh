#!/usr/bin/env bash
#
# Build the Python runtime that ships inside Delphi.app.
#
# A *real* interpreter, from python-build-standalone -- deliberately not
# PyInstaller or py2app. The application isolates some PDF work by spawning
# `[sys.executable, "-m", "delphi_core.pdf_worker", ...]`, and that is not optional: a
# PDF whose Type 1 font needs substituting makes PDFium corrupt its own heap and
# `abort()`, which no Python `except` can catch, so the call has to happen in a
# child process. Under a frozen binary `sys.executable` re-launches the app
# instead of running the module, and the isolation silently disappears.
#
# Pinned and checksum-verified (scripts/python-standalone.sh). The backend it runs
# is built here from the repository's core/ and desktop/backend/
# (build/backend-wheel.sh): core's wheel, and the desktop's layer over it, whose
# `delphi_desktop.main:app` the shell launches.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT_DIR/.delphi-build/python"
source "$ROOT_DIR/../scripts/python-standalone.sh"
source "$ROOT_DIR/build/backend-wheel.sh"
ARCHIVE="$(standalone_archive)"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
tar -xzf "$ARCHIVE" --strip-components=1 -C "$OUT_DIR"
PY="$OUT_DIR/bin/python3"
[[ -x "$PY" ]] || { echo "Extraction produced no interpreter at $PY" >&2; exit 1; }

# Build the backend from core/ and desktop/backend/ with this interpreter while it
# still has pip, then install it as ordinary files. Runtime dependencies,
# including HTTP/2 support, belong to core's wheel metadata.
echo "Building the backend wheels from core/ and desktop/backend/..."
# One hash for the build: both wheels are cached under it and the receipt records
# it, so an edit made while the build runs cannot split them.
CONTENT_HASH="$(core_content_hash)"
export CONTENT_HASH
CORE_WHEEL="$(backend_wheel "$PY")"
DESKTOP_WHEEL="$(desktop_wheel "$PY")"
# Both by path, core first. The desktop wheel requires `delphi-core`, and a
# package of that name on an index is not ours: installing the desktop wheel
# with --no-deps --no-index resolves nothing anywhere, and `pip check` then
# proves its exact pin is met by the core just installed from this checkout.
"$PY" -m pip install --quiet "$CORE_WHEEL"
"$PY" -m pip install --quiet --no-deps --no-index "$DESKTOP_WHEEL"
"$PY" -m pip check

# What the backend never runs, removed before the self-check below proves it
# was not needed: pip (installing is done, and the bundle is read-only), the
# standard library's GUI, IDE, 2to3 and teaching modules, and Tcl/Tk under
# them. About 30 MB of a 180 MB interpreter. Nothing here is imported by the
# application or its dependencies (Pillow's Tk bridge is imported only by Tk code).
STDLIB="$(ls -d "$OUT_DIR"/lib/python3.*/ | head -1)"
rm -rf "$STDLIB"site-packages/pip "$STDLIB"site-packages/pip-*.dist-info "$OUT_DIR"/bin/pip* \
  "$STDLIB"{ensurepip,idlelib,tkinter,turtledemo,lib2to3,pydoc_data,turtle.py} \
  "$STDLIB"lib-dynload/_tkinter.*.so \
  "$OUT_DIR"/lib/{tcl9,tcl9.0,tk9.0,itcl*,thread*,libtcl9.0.dylib,libtcl9tk9.0.dylib}

# Precompile now, so no launch pays the compile cost, as bytecode Python uses
# without checking it against its source. Packaging copies the sources with new
# modification times, which leaves timestamp-checked bytecode stale in every
# build. The backend then recompiles at each launch, and an interpreter started
# with -I, which ignores PYTHONDONTWRITEBYTECODE (the backend's clean_exec.py),
# writes the bytecode back into the signed bundle and breaks its seal.
# -f rewrites the bytecode pip already compiled.
"$PY" -m compileall -q -f --invalidation-mode unchecked-hash "$OUT_DIR/lib" >/dev/null 2>&1 || true

# The assertions that matter, run against the interpreter that will actually
# ship rather than a dev venv. Each one covers a `__file__`-relative read that
# a packaging mistake breaks silently.
echo "Verifying the bundled runtime..."
# Isolated (-I): neither PYTHONPATH nor the working directory can supply a module
# the wheels left out, and each package must be the runtime's own.
RUNTIME_DIR="$OUT_DIR" "$PY" -I - <<'CHECK'
from importlib.metadata import version
from importlib.util import find_spec
import os
import pathlib
import sys

# Each import covers a file the package must carry alongside its code. A
# packaging mistake here is silent at build time and fatal at launch.
import h2                       # the HTTP/2 client raises at startup without it
import delphi_core
import delphi_core.main         # the reference application assembles
import delphi_core.pdf_worker   # must be importable as `-m delphi_core.pdf_worker`
import delphi_core.artifacts.worker  # the isolated visualization worker must ship
import delphi_desktop
import delphi_desktop.main      # the application the shell launches assembles
from delphi_core.web_proxy import bridge_source

runtime = pathlib.Path(os.environ["RUNTIME_DIR"]).resolve()
for package in (delphi_core, delphi_desktop):
    assert pathlib.Path(package.__file__).resolve().is_relative_to(runtime), \
        f"{package.__name__} came from {package.__file__}, not the runtime"

# One commit's two wheels, and no test code: the conformance kit is a
# development dependency, never part of the app.
assert version("delphi-desktop") == version("delphi-core"), \
    f"delphi-desktop {version('delphi-desktop')} beside delphi-core {version('delphi-core')}"
assert find_spec("delphi_core_testkit") is None, "the test kit was installed into the app's runtime"

bridge = bridge_source()
assert bridge.strip(), "the packaged frame script came back empty"
inspector = pathlib.Path(delphi_core.artifacts.worker.__file__).with_name("inspect.js")
assert inspector.is_file() and inspector.read_text().strip(), "the packaged artifact inspector is missing or empty"
# The application reads packaged text files at import; a wheel built without
# its package data imports on a developer's machine and fails here.
data = sorted(pathlib.Path(delphi_core.__file__).parent.rglob("*.md"))
assert data and all(path.read_text().strip() for path in data), "a packaged data file is missing or empty"
print(f"  python {sys.version.split()[0]}")
print(f"  backend       delphi-core and delphi-desktop {version('delphi-desktop')}")
print(f"  frame script  {len(bridge)} chars")
print(f"  artifact inspector  {inspector.stat().st_size} bytes")
print(f"  data files    {len(data)}")
CHECK

# Write provenance only after installation and every runtime self-check succeeds,
# one fact per line. Lines keep their places, because readers take them by
# position (main/diagnostics.ts, build/check-backend-runtime.sh):
#   1 core's version   2 core's wheel   3 its SHA-256
#   4 the commit       5 the content hash of the two wheels' inputs, which
#                        build/check-backend-runtime.sh compares with the checkout
#   6 the desktop layer's wheel        7 its SHA-256
#   8 the repository's tree (`git rev-parse HEAD^{tree}`), which a release must
#     equal (Plan 4 A7)
installed_version="$("$PY" -I -c 'from importlib.metadata import version; print(version("delphi-core"))')"
core_sha="$(shasum -a 256 "$CORE_WHEEL" | awk '{print $1}')"
desktop_sha="$(shasum -a 256 "$DESKTOP_WHEEL" | awk '{print $1}')"
printf '%s\n' "$installed_version" "$(basename "$CORE_WHEEL")" "$core_sha" \
  "$(core_commit)" "$CONTENT_HASH" \
  "$(basename "$DESKTOP_WHEEL")" "$desktop_sha" "$(repository_tree)" > "$OUT_DIR/backend-wheel.receipt"
bash "$ROOT_DIR/build/check-backend-runtime.sh"

echo "python runtime -> $OUT_DIR ($(du -sh "$OUT_DIR" | cut -f1))"
