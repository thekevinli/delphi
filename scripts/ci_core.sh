#!/usr/bin/env bash
# scripts/ci_core.sh [--release vX.Y.Z]
#
# The core's CI, run on this machine (GitHub Actions stays off: the owner's rule is
# never to be charged on GitHub). The backend workflow's jobs, in its order, after
# the release identity, which comes first so that a wrong cut fails in seconds:
#
#   identity         the catalog, the previous release's assets checked against its
#                    SHA256SUMS, and this build's policy (backend_release.py context):
#                    the tag names this clean checkout, the version moves forward,
#                    and a published release is never rebuilt
#   source-tests     the whole suite, on the core environment's Python 3.12 and
#                    a throwaway 3.11, each running every kit store test (A5),
#                    the scripts' own tests, the JavaScript contracts, and the
#                    layering checks (scripts/layering.sh: A1, A3, A4, A6, A7,
#                    and A8 when DELPHI_PRIVATE_NAMES names the private list).
#                    Core is local: no database, no cloud extra (a product's store
#                    runs the test kit's conformance suite in that product's CI)
#   build            the wheels through scripts/backend_release.py, installed and
#                    checked without the checkout, its OpenAPI exported, and a store
#                    written by the previous release reopened
#   core-alone       A2: only the two wheels in a fresh venv; every module, the
#                    reference app, the PDF worker, the surface, and the suite from
#                    a copy of core/tests (scripts/core_alone.sh)
#   installed-wheel  scripts/check_backend_wheel.py under Python 3.11 and 3.12
#   compatibility    oasdiff breaking against the previous release's openapi.json
#                    (its report kept as oasdiff-breaking.txt, for the notes), and
#                    its public surface classified against this one's (A3)
#
# Untagged, it checks the checkout as a development build. `--release vX.Y.Z`
# builds that release: the tag must name this clean checkout, the version must be
# its X.Y.Z, and DELPHI_PRIVATE_NAMES must name the private list (A8). Publishing
# is not wired here: the release is attached by hand from .delphi-build/ci-core/dist.
#
# The previous release is the latest vX.Y.Z on this repository's releases. The first
# release has none: nothing is downloaded, and there is no library to reopen and no
# API or surface to diff, which the run says rather than skipping in silence.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/.delphi-build/ci-core"
RELEASES_REPO=thekevinli/delphi
TAG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --release) [[ $# -ge 2 && -n "$2" ]] || { echo "ci_core.sh: --release needs a tag, vX.Y.Z" >&2; exit 2; }
               TAG="$2"; shift 2 ;;
    *) echo "usage: scripts/ci_core.sh [--release vX.Y.Z]" >&2; exit 2 ;;
  esac
done
# A release does not start without the private list: A8 runs in source-tests, and the build refuses.
if [[ -n "$TAG" && ! -f "${DELPHI_PRIVATE_NAMES:-}" ]]; then
  echo "ci_core.sh: a release scans the tree for private names (A8): set DELPHI_PRIVATE_NAMES to the private list" >&2
  exit 2
fi
# macOS's bash 3.2 expands an empty array under `set -u` only as ${A[@]+"${A[@]}"}.
TAG_ARGS=(); [[ -z "$TAG" ]] || TAG_ARGS=(--tag "$TAG")
rm -rf "$OUT"; mkdir -p "$OUT"
PY312="$(bash "$ROOT/scripts/core-env.sh")"
PY311="${DELPHI_PY311:-$(command -v python3.11 || echo "$HOME/miniconda3/bin/python3.11")}"
export SESSION_SECRET=core-ci-test-secret OPENAI_API_KEY="" DELPHI_REQUIRE_CONFORMANCE=local
step() { printf '\n== %s\n' "$*"; }
cd "$ROOT"

step "identity: the catalog, the previous release, this build's policy"
# One snapshot of the catalog: context, build and the surface check cannot see it move.
gh api --paginate --slurp "repos/$RELEASES_REPO/releases?per_page=100" > "$OUT/releases.json"
PREVIOUS_V="$("$PY312" scripts/backend_release.py previous --releases-json "$OUT/releases.json" ${TAG_ARGS[@]+"${TAG_ARGS[@]}"})"
if [[ -n "$PREVIOUS_V" ]]; then
  # The previous release's assets, in one directory for the reopen, oasdiff and the surface.
  gh release download "$PREVIOUS_V" -R "$RELEASES_REPO" --pattern '*.whl' --pattern release.json \
    --pattern openapi.json --pattern SHA256SUMS --pattern public-surface.txt --dir "$OUT/baseline"
  # A pattern that matches nothing is not an error to gh: a missing asset fails here.
  (cd "$OUT/baseline" && shasum -a 256 -c SHA256SUMS)
else
  echo "No earlier vX.Y.Z release on $RELEASES_REPO: a first release, compared with nothing."
fi
IDENTITY=(--releases-json "$OUT/releases.json" ${TAG_ARGS[@]+"${TAG_ARGS[@]}"})
"$PY312" scripts/backend_release.py context "${IDENTITY[@]}" --github-output "$OUT/context.env"
cat "$OUT/context.env"

step "source-tests: JavaScript contracts"
(source desktop/build/runtime.sh; ensure_frontend_runtime; node --test core/tests/web-annotations.test.mjs core/tests/artifact-inspector.test.mjs | tail -3)
step "source-tests: full suite, Python 3.12"
(cd core && "$PY312" -m pytest -q -p no:cacheprovider | tail -2)
step "source-tests: full suite, Python 3.11"
"$PY311" -m venv "$OUT/venv311" && "$OUT/venv311/bin/pip" install -q "./core[dev]" "./core/testkit"
"$OUT/venv311/bin/pip" install -q --no-deps ./desktop/backend
(cd core && "$OUT/venv311/bin/python" -m pytest -q -p no:cacheprovider | tail -2)
step "source-tests: the scripts' tests, Python 3.12 and 3.11"
(cd scripts && "$PY312" -m pytest -q -p no:cacheprovider | tail -1)
(cd scripts && "$OUT/venv311/bin/python" -m pytest -q -p no:cacheprovider | tail -1)
step "source-tests: layering (A1, A3, A4, A6, A7, A8)"
bash scripts/layering.sh "$PY312"

step "build: the wheels, from the tag's tree for a release, and their checksums"
"$PY312" scripts/backend_release.py build "${IDENTITY[@]}" --output "$OUT/dist"
"$PY312" scripts/check_backend_wheel.py "$OUT/dist" --openapi "$OUT/dist/openapi.json"
PREVIOUS_TAG="$(sed -n 's/^previous_tag=//p' "$OUT/context.env")"
FAIL_ON="$(sed -n 's/^compatibility_fail_on=//p' "$OUT/context.env")"
if [[ -n "$PREVIOUS_TAG" ]]; then
  step "build: reopen a library written by $PREVIOUS_TAG"
  "$PY312" scripts/check_backend_wheel.py "$OUT/dist" --previous-artifacts "$OUT/baseline"
fi
"$PY312" scripts/backend_release.py checksums "$OUT/dist"

step "core-alone: the two wheels and nothing else (A2)"
CORE_ALONE_PY="$PY312" bash scripts/core_alone.sh "$OUT/dist"

step "installed-wheel: Python 3.11 and 3.12"
"$OUT/venv311/bin/python" scripts/check_backend_wheel.py "$OUT/dist"
"$PY312" scripts/check_backend_wheel.py "$OUT/dist"

if [[ -n "$PREVIOUS_TAG" ]]; then
  # Across a compatibility boundary (a new minor version during 0.x) a break is reported, not fatal.
  step "compatibility: oasdiff breaking against $PREVIOUS_TAG, failing on ${FAIL_ON:-nothing}"
  FAIL_ARGS=(); [[ -z "$FAIL_ON" ]] || FAIL_ARGS=(--fail-on "$FAIL_ON")
  oasdiff breaking "$OUT/baseline/openapi.json" "$OUT/dist/openapi.json" ${FAIL_ARGS[@]+"${FAIL_ARGS[@]}"} \
    | tee "$OUT/oasdiff-breaking.txt"
  step "compatibility: the public surface against $PREVIOUS_TAG (A3)"
  "$PY312" scripts/backend_release.py surface "${IDENTITY[@]}" \
    --current "$OUT/dist/public-surface.txt" --previous-surface "$OUT/baseline/public-surface.txt"
else
  step "compatibility: no previous release, so no API or surface diff to compare"
fi

printf '\nCore CI passed at %s%s.\n' "$(git rev-parse --short HEAD)" "${TAG:+, for $TAG}"
