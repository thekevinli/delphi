#!/usr/bin/env bash
# The pinned, checksum-verified python-build-standalone archive, shared by the
# runtime that ships (`desktop/build/python-runtime.sh`) and the development
# environment the core's tests run in (`scripts/core-env.sh`), so both use the
# same interpreter build. The archive is cached in the root `.delphi-build/cache`.
# Sourced; defines `standalone_archive`, which prints the verified archive's path.

PBS_RELEASE="20260901"
PBS_PYTHON="3.12.14"

standalone_archive() (
  set -euo pipefail
  local root asset url cache sha actual
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  case "$(uname -m)" in
    arm64|aarch64) arch="aarch64"; sha="81a359f1cfadd4da11766534c5913791cea55f26e1bb902cacd2a531bb1e4b2b" ;;
    x86_64) arch="x86_64"; sha="${DELPHI_PBS_SHA256_X86_64:-}" ;;
    *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
  esac
  [[ -n "$sha" ]] || { echo "No pinned checksum for $(uname -m); refusing an unverified interpreter." >&2; exit 1; }
  asset="cpython-${PBS_PYTHON}+${PBS_RELEASE}-${arch}-apple-darwin-install_only_stripped.tar.gz"
  url="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_RELEASE}/${asset}"
  cache="$root/.delphi-build/cache"
  mkdir -p "$cache"
  if [[ ! -f "$cache/$asset" ]]; then
    echo "Downloading $asset..." >&2
    curl -fL --retry 2 -o "$cache/$asset.part" "$url" >&2
    mv "$cache/$asset.part" "$cache/$asset"
  fi
  actual="$(shasum -a 256 "$cache/$asset" | awk '{print $1}')"
  if [[ "$actual" != "$sha" ]]; then
    echo "Checksum mismatch for $asset: expected $sha, got $actual" >&2
    rm -f "$cache/$asset"
    exit 1
  fi
  printf '%s\n' "$cache/$asset"
)
