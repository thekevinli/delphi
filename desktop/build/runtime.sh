#!/usr/bin/env bash

# Shared project-local JavaScript runtime setup. This file is sourced by
# bootstrap.sh and run.sh; it should not be executed directly.

DELPHI_NODE_VERSION="${DELPHI_NODE_VERSION:-22.14.0}"
DELPHI_PNPM_VERSION="${DELPHI_PNPM_VERSION:-11.9.0}"
# desktop/.runtime, wherever the caller sits (check.sh calls from the repository root).
DELPHI_RUNTIME_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.runtime"
# Playwright's browsers live beside Node, never in the user's cache.
export PLAYWRIGHT_BROWSERS_PATH="$DELPHI_RUNTIME_ROOT/ms-playwright"

runtime_platform() {
  case "$(uname -s)" in
    Darwin) printf '%s' "darwin" ;;
    Linux) printf '%s' "linux" ;;
    *)
      echo "Unsupported operating system: $(uname -s)" >&2
      return 1
      ;;
  esac
}

runtime_architecture() {
  case "$(uname -m)" in
    arm64 | aarch64) printf '%s' "arm64" ;;
    x86_64 | amd64) printf '%s' "x64" ;;
    *)
      echo "Unsupported processor architecture: $(uname -m)" >&2
      return 1
      ;;
  esac
}

file_sha256() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    echo "A SHA-256 utility (shasum or sha256sum) is required." >&2
    return 1
  fi
}

ensure_frontend_runtime() {
  local platform architecture archive_name node_dir download_dir
  local archive_path checksums_path expected_checksum actual_checksum

  platform="$(runtime_platform)"
  architecture="$(runtime_architecture)"
  archive_name="node-v${DELPHI_NODE_VERSION}-${platform}-${architecture}.tar.gz"
  node_dir="$DELPHI_RUNTIME_ROOT/node-v${DELPHI_NODE_VERSION}-${platform}-${architecture}"
  DELPHI_NODE_DIR="$node_dir"
  DELPHI_PNPM_DIR="$DELPHI_RUNTIME_ROOT/pnpm-v${DELPHI_PNPM_VERSION}"

  if [[ ! -x "$node_dir/bin/node" ]]; then
    command -v curl >/dev/null 2>&1 || {
      echo "curl is required to install Delphi's local Node runtime." >&2
      return 1
    }

    echo "Installing project-local Node ${DELPHI_NODE_VERSION}..."
    mkdir -p "$DELPHI_RUNTIME_ROOT"
    download_dir="$(mktemp -d "${TMPDIR:-/tmp}/delphi-node.XXXXXX")"
    archive_path="$download_dir/$archive_name"
    checksums_path="$download_dir/SHASUMS256.txt"

    curl --fail --location --silent --show-error \
      "https://nodejs.org/dist/v${DELPHI_NODE_VERSION}/${archive_name}" \
      --output "$archive_path"
    curl --fail --location --silent --show-error \
      "https://nodejs.org/dist/v${DELPHI_NODE_VERSION}/SHASUMS256.txt" \
      --output "$checksums_path"

    expected_checksum="$(
      awk -v archive="$archive_name" '$2 == archive { print $1 }' "$checksums_path"
    )"
    actual_checksum="$(file_sha256 "$archive_path")"
    if [[ -z "$expected_checksum" || "$actual_checksum" != "$expected_checksum" ]]; then
      echo "Node download checksum verification failed." >&2
      return 1
    fi

    mkdir -p "$node_dir"
    tar -xzf "$archive_path" --strip-components=1 -C "$node_dir"
    rm -rf "$download_dir"
  fi

  export PATH="$node_dir/bin:$DELPHI_PNPM_DIR/bin:$PATH"

  if [[ ! -x "$DELPHI_PNPM_DIR/bin/pnpm" ]]; then
    echo "Installing project-local pnpm ${DELPHI_PNPM_VERSION}..."
    "$node_dir/bin/npm" install --global \
      --prefix "$DELPHI_PNPM_DIR" \
      --cache "$DELPHI_RUNTIME_ROOT/npm-cache" \
      --no-audit \
      --no-fund \
      "pnpm@${DELPHI_PNPM_VERSION}"
  fi

  DELPHI_PNPM="$DELPHI_PNPM_DIR/bin/pnpm"
}
