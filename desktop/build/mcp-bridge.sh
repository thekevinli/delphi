#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$ROOT_DIR/.delphi-build/native"
# The app's own floor: macOS 13, Electron's minimum and the LSMinimumSystemVersion
# the packaged Info.plist carries. Without -target, swiftc builds for the machine it
# runs on, and an older macOS then refuses to load the bridge.
/usr/bin/swiftc -O -target arm64-apple-macos13.0 "$ROOT_DIR/native/mcp-bridge.swift" -o "$ROOT_DIR/.delphi-build/native/delphi-mcp"
echo 'Native read-only MCP bridge built.'
