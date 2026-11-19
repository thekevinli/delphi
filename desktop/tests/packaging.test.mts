import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const BRIDGE = fileURLToPath(new URL("../.delphi-build/native/delphi-mcp", import.meta.url));
const RUNTIME_LIB = fileURLToPath(new URL("../.delphi-build/python/lib", import.meta.url));

/** The minimum macOS in a Mach-O file's LC_BUILD_VERSION load command. */
function minimumMacOS(path: string): string | undefined {
  const commands = execFileSync("/usr/bin/otool", ["-l", path], { encoding: "utf8" });
  return commands.match(/cmd LC_BUILD_VERSION[\s\S]*?\n\s*minos (\S+)/)?.[1];
}

test("the MCP bridge is compiled for the app's minimum macOS, not the build machine's", () => {
  // Electron's own floor, and the LSMinimumSystemVersion of the packaged app.
  assert.match(read("build/mcp-bridge.sh"), /\/usr\/bin\/swiftc [^\n]*-target arm64-apple-macos13\.0 /);
  if (!existsSync(BRIDGE)) {
    assert.notEqual(process.env.DELPHI_REQUIRE_INTEGRATION, "1", `${BRIDGE} is missing; run npm run build`);
    return;
  }
  assert.equal(minimumMacOS(BRIDGE), "13.0", `${BRIDGE} was built for another macOS; rebuild it with npm run build`);
});

test("the packaged app is signed ad hoc, so a download is unidentified rather than damaged", () => {
  const mac = JSON.parse(read("package.json")).build.mac;
  // "-" is electron-builder's ad-hoc identity: every nested binary and the bundle are
  // sealed, and the build verifies the result with codesign --verify --deep --strict.
  // null signs nothing, and the linker's signature alone reads as a damaged app.
  assert.equal(mac.identity, "-");
  assert.notEqual(mac.strictVerify, false);
  // Hardened runtime belongs with notarisation. Without it the bundled interpreter
  // loads its ad-hoc signed extensions with no library validation.
  assert.equal(mac.hardenedRuntime, false);
  for (const key of ["notarize", "entitlements", "entitlementsInherit", "sign", "signIgnore"]) {
    assert.equal(mac[key], undefined, `mac.${key} is not part of ad-hoc signing`);
  }
});

test("the bundled interpreter never rewrites its bytecode inside the signed bundle", () => {
  // Packaging resets the sources' modification times, so timestamp-checked
  // bytecode would be stale and rewritten by any interpreter started with -I.
  assert.match(read("build/python-runtime.sh"), /-m compileall [^\n]*-f --invalidation-mode unchecked-hash /);
  if (!existsSync(RUNTIME_LIB)) {
    assert.notEqual(process.env.DELPHI_REQUIRE_INTEGRATION, "1", `${RUNTIME_LIB} is missing; run npm run build`);
    return;
  }
  const name = readdirSync(RUNTIME_LIB).find(entry => /^python3\.\d+$/.test(entry))!;
  const stdlib = join(RUNTIME_LIB, name);
  const tag = `cpython-${name.slice("python".length).replace(".", "")}`;
  // What clean_exec.py imports under -I, and the backend's own package.
  for (const pyc of [`encodings/__pycache__/aliases.${tag}.pyc`, `__pycache__/signal.${tag}.pyc`, `site-packages/delphi_core/__pycache__/main.${tag}.pyc`]) {
    // The pyc header's flags word: bit 0 is hash-based, bit 1 is check-source.
    assert.equal(readFileSync(join(stdlib, pyc)).readUInt32LE(4), 0b01, `${pyc} is not unchecked-hash bytecode; rebuild with npm run build`);
  }
});
