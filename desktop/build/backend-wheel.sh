#!/usr/bin/env bash
# The backend the app bundles is built from this checkout, never downloaded: the
# desktop, its core and its own layer over core come from the same commit (Plan 4,
# rule 10). Two wheels: `delphi-core` from `core/`, and `delphi-desktop`, the app
# the shell launches, from `desktop/backend/`.
# Sourced; defines
#   core_content_hash   a hash of exactly what goes into the two wheels
#                       (`core/delphi_core`, `core/pyproject.toml`,
#                       `desktop/backend/delphi_desktop`, `desktop/backend/pyproject.toml`
#                       and the root LICENSE and NOTICE, tracked and
#                       untracked-but-not-ignored), so a runtime built before an
#                       edit to either is caught even without a commit
#   core_commit         HEAD, marked when `core/` or `desktop/backend/` has
#                       uncommitted changes
#   repository_tree     `git rev-parse HEAD^{tree}`, the tree the whole checkout
#                       was committed as, marked when any tracked file has
#                       uncommitted changes (Plan 4 A7: Stage 10 compares it with
#                       the published repository's)
#   backend_wheel PY    builds core's wheel with interpreter PY and prints its path
#                       (CONTENT_HASH, when set, is the hash to cache under)
#   desktop_wheel PY    the same for the desktop layer's wheel
# Both are cached in one directory per content hash; a wheel already built from
# the same content is reused. Kept separate from interpreter extraction so
# failures leave the runtime intact.

# The repository root (core/ is there) and the desktop directory (its build outputs).
core_root() { cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd; }
desktop_root() { cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd; }

# What the wheels are built from, as paths from the repository root.
WHEEL_INPUTS=(core/delphi_core core/pyproject.toml desktop/backend/delphi_desktop desktop/backend/pyproject.toml LICENSE NOTICE)
# The directories whose uncommitted changes mark the commit: the two projects.
WHEEL_PROJECTS=(core desktop/backend)

core_content_hash() (
  set -euo pipefail
  cd "$(core_root)"
  git ls-files -co --exclude-standard -z -- "${WHEEL_INPUTS[@]}" \
    | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | awk '{print $1}'
)

core_commit() (
  set -euo pipefail
  local root head project dirty=""
  root="$(core_root)"
  head="$(git -C "$root" rev-parse --verify --quiet HEAD 2>/dev/null || echo unknown)"
  if [[ "$head" != unknown ]]; then
    for project in "${WHEEL_PROJECTS[@]}"; do
      [[ -z "$(git -C "$root" status --porcelain -- "$project" 2>/dev/null)" ]] || dirty="${dirty:+$dirty and }$project/"
    done
  fi
  [[ -z "$dirty" ]] || head="$head, with uncommitted changes in $dirty"
  printf '%s\n' "$head"
)

repository_tree() (
  set -euo pipefail
  local root tree
  root="$(core_root)"
  tree="$(git -C "$root" rev-parse --verify --quiet 'HEAD^{tree}' 2>/dev/null || echo unknown)"
  if [[ "$tree" != unknown && -n "$(git -C "$root" status --porcelain --untracked-files=no 2>/dev/null)" ]]; then
    tree="$tree, with uncommitted changes"
  fi
  printf '%s\n' "$tree"
)

# project_wheel PY DIST PROJECT PACKAGE: the wheel named DIST-*.whl, built from
# PROJECT/pyproject.toml and PROJECT/PACKAGE, from a copy holding only what the
# wheel contains (as the release script builds core's), so the build never
# writes into the checkout. The licence files sit at the root; each pyproject's
# `license-files` names them beside it.
project_wheel() (
  set -euo pipefail
  local python="$1" dist="$2" project="$3" package="$4" root out staging
  root="$(core_root)"
  out="$(desktop_root)/.delphi-build/cache/core-wheel/${CONTENT_HASH:-$(core_content_hash)}"
  if compgen -G "$out/$dist-*.whl" >/dev/null; then
    ls "$out"/"$dist"-*.whl | head -1
    exit 0
  fi
  staging="$(mktemp -d)"
  trap 'rm -rf "$staging"' EXIT
  mkdir "$staging/src" "$staging/wheel"
  cp "$root/$project/pyproject.toml" "$root/LICENSE" "$root/NOTICE" "$staging/src/"
  rsync -a --exclude '__pycache__' "$root/$project/$package" "$staging/src/"
  "$python" -m pip wheel --quiet --no-deps --wheel-dir "$staging/wheel" "$staging/src" >&2
  # One file put in place, so the other wheel of the same content stays: copied
  # beside it under a name the lookup above never matches, then renamed within
  # the directory, so an interrupted build leaves no truncated wheel to reuse.
  mkdir -p "$out"
  local built name
  built="$(ls "$staging"/wheel/"$dist"-*.whl | head -1)"
  name="$(basename "$built")"
  cp "$built" "$out/.$name.part"
  mv "$out/.$name.part" "$out/$name"
  printf '%s\n' "$out/$name"
)

backend_wheel() { project_wheel "$1" delphi_core core delphi_core; }
desktop_wheel() { project_wheel "$1" delphi_desktop desktop/backend delphi_desktop; }
