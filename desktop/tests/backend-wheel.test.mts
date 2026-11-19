import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/** A throwaway checkout in the repository's layout: desktop/build, check.sh, a tiny core/ and a tiny desktop/backend/. */
function checkout(prefix: string) {
  // Real path: macOS reports /private/var for the same directory tmpdir() calls /var.
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  mkdirSync(join(root, "desktop/build"), { recursive: true });
  mkdirSync(join(root, "core/delphi_core"), { recursive: true });
  mkdirSync(join(root, "desktop/backend/delphi_desktop"), { recursive: true });
  mkdirSync(join(root, "desktop/backend/tests"), { recursive: true });
  for (const path of ["build/backend-wheel.sh", "build/check-backend-runtime.sh"]) {
    copyFileSync(new URL(`../${path}`, import.meta.url), join(root, "desktop", path));
  }
  copyFileSync(new URL("../../check.sh", import.meta.url), join(root, "check.sh"));
  writeFileSync(join(root, "core/pyproject.toml"), [
    "[build-system]", 'requires = ["setuptools"]', 'build-backend = "setuptools.build_meta"',
    "[project]", 'name = "delphi-core"', 'version = "0.0.1"', 'license-files = ["LICENSE", "NOTICE"]',
    "[tool.setuptools.packages.find]", 'include = ["delphi_core", "delphi_core.*"]', "",
  ].join("\n"));
  writeFileSync(join(root, "core/delphi_core/__init__.py"), "VERSION = 1\n");
  writeFileSync(join(root, "desktop/backend/pyproject.toml"), [
    "[build-system]", 'requires = ["setuptools"]', 'build-backend = "setuptools.build_meta"',
    "[project]", 'name = "delphi-desktop"', 'version = "0.0.1"', 'license-files = ["LICENSE", "NOTICE"]',
    'dependencies = ["delphi-core==0.0.1"]',
    "[tool.setuptools.packages.find]", 'include = ["delphi_desktop", "delphi_desktop.*"]', "",
  ].join("\n"));
  writeFileSync(join(root, "desktop/backend/delphi_desktop/__init__.py"), "LAYER = 1\n");
  writeFileSync(join(root, "desktop/backend/tests/test_layer.py"), "def test_layer():\n    pass\n");
  writeFileSync(join(root, "LICENSE"), "licence\n");
  writeFileSync(join(root, "NOTICE"), "notice\n");
  writeFileSync(join(root, ".gitignore"), "__pycache__/\n.delphi-build/\n");
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", env: {
      ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
    } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  const sourced = (fn: string) => spawnSync("bash", ["-c", `source desktop/build/backend-wheel.sh; ${fn}`], { cwd: root, encoding: "utf8" });
  const run = (command: string) => spawnSync("bash", ["-c", command], { cwd: root, encoding: "utf8" });
  return { root, git, sourced, run };
}

/**
 * A built runtime in the checkout: an interpreter, and a receipt stamped from
 * the checkout as it is when `stamp` is called, in python-runtime.sh's layout.
 * `desktop: false` stamps a runtime from before the desktop layer (five lines),
 * `tree: false` one from before the tree was recorded (seven), and a string
 * names another tree on line 8.
 */
function runtime({ root, sourced }: ReturnType<typeof checkout>) {
  mkdirSync(join(root, "desktop/.delphi-build/python/bin"), { recursive: true });
  writeFileSync(join(root, "desktop/.delphi-build/python/bin/python3"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const receipt = join(root, "desktop/.delphi-build/python/backend-wheel.receipt");
  return (options: { desktop?: boolean; tree?: boolean | string } = {}) => {
    const hash = sourced("core_content_hash").stdout.trim();
    const commit = sourced("core_commit").stdout.trim();
    const tree = typeof options.tree === "string" ? options.tree : sourced("repository_tree").stdout.trim();
    assert.match(hash, /^[0-9a-f]{64}$/);
    const desktop = options.desktop === false ? [] : ["delphi_desktop-0.0.1-py3-none-any.whl", "b".repeat(64)];
    const recorded = options.desktop === false || options.tree === false ? [] : [tree];
    writeFileSync(receipt, ["0.0.1", "delphi_core-0.0.1-py3-none-any.whl", "a".repeat(64), commit, hash, ...desktop, ...recorded, ""].join("\n"));
  };
}

const CHECK = "bash desktop/build/check-backend-runtime.sh";
const RELEASE = `${CHECK} --release`;

/** The check fails as stale, and a gate that runs it stops before any test. */
function refusedAsStale(run: ReturnType<typeof checkout>["run"], command: string) {
  const result = run(command);
  assert.notEqual(result.status, 0, command);
  assert.match(result.stderr, /built from other core\/ content.*Run npm run build/);
  assert.doesNotMatch(result.stdout, /All checks passed/);
  assert.doesNotMatch(result.stderr, /No such file|command not found/, "must stop before attempting tests");
}

test("gates refuse a runtime built from other core/ content, before tests or packaging", () => {
  const fixture = checkout("delphi-wheel-receipt-");
  const { root, git, run } = fixture;
  try {
    const stamp = runtime(fixture);
    const refused = (command: string) => refusedAsStale(run, command);

    refused(CHECK);          // no receipt at all
    stamp();
    assert.equal(run(CHECK).status, 0);
    assert.equal(run(RELEASE).status, 0, "committed and current");

    // An uncommitted edit, a new untracked module and a new committed one each
    // make the runtime stale; an ignored cache file does not.
    writeFileSync(join(root, "core/delphi_core/__init__.py"), "VERSION = 2\n");
    for (const command of [CHECK, "bash check.sh", "bash check.sh --parity"]) refused(command);
    stamp();
    assert.equal(run(CHECK).status, 0);
    const release = run(RELEASE);
    assert.notEqual(release.status, 0);
    assert.match(release.stderr, /built from a committed core\/ and desktop\/backend\/: .*, with uncommitted changes in core\/$/m);
    git("commit", "-q", "-am", "edit");
    assert.notEqual(run(RELEASE).status, 0, "a receipt from before the commit");
    stamp();
    assert.equal(run(RELEASE).status, 0);

    writeFileSync(join(root, "core/delphi_core/added.py"), "x = 1\n");
    refused(CHECK);
    rmSync(join(root, "core/delphi_core/added.py"));
    mkdirSync(join(root, "core/delphi_core/__pycache__"));
    writeFileSync(join(root, "core/delphi_core/__pycache__/x.pyc"), "cache");
    assert.equal(run(CHECK).status, 0, "ignored files are not wheel content");

    const dist: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts.dist;
    assert.ok(dist.indexOf("check-backend-runtime.sh --release") > dist.indexOf("npm run build"));
    assert.ok(dist.indexOf("check-backend-runtime.sh --release") < dist.indexOf("electron-builder"), "packaging comes after the release check");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an edit to the desktop layer makes the runtime stale, and a release refuses it", () => {
  const fixture = checkout("delphi-wheel-desktop-");
  const { root, git, run } = fixture;
  try {
    const stamp = runtime(fixture);
    const refused = (command: string) => refusedAsStale(run, command);
    const unreleasable = (dirty: string) => {
      const release = run(RELEASE);
      assert.notEqual(release.status, 0);
      assert.match(release.stderr, new RegExp(`built from a committed core/ and desktop/backend/: .*, with uncommitted changes in ${dirty}$`, "m"));
    };

    // A runtime from before the shell launched the desktop layer names no desktop wheel.
    stamp({ desktop: false });
    refused(CHECK);
    stamp();
    assert.equal(run(RELEASE).status, 0, "committed and current");

    // The layer's code, a new module in it, and its pyproject are each wheel content.
    writeFileSync(join(root, "desktop/backend/delphi_desktop/__init__.py"), "LAYER = 2\n");
    for (const command of [CHECK, "bash check.sh", "bash check.sh --parity"]) refused(command);
    stamp();
    assert.equal(run(CHECK).status, 0);
    unreleasable("desktop/backend/");
    writeFileSync(join(root, "core/delphi_core/__init__.py"), "VERSION = 2\n");
    stamp();
    unreleasable("core/ and desktop/backend/");
    git("commit", "-q", "-am", "edit both");
    assert.notEqual(run(RELEASE).status, 0, "a receipt from before the commit");
    stamp();
    assert.equal(run(RELEASE).status, 0);

    writeFileSync(join(root, "desktop/backend/delphi_desktop/added.py"), "x = 1\n");
    refused(CHECK);
    rmSync(join(root, "desktop/backend/delphi_desktop/added.py"));
    writeFileSync(join(root, "desktop/backend/pyproject.toml"), readFileSync(join(root, "desktop/backend/pyproject.toml"), "utf8").replace('version = "0.0.1"', 'version = "0.0.2"'));
    refused(CHECK);
    git("checkout", "--", "desktop/backend/pyproject.toml");
    assert.equal(run(CHECK).status, 0);

    // The layer's tests are not wheel content, but a release still names a clean commit.
    writeFileSync(join(root, "desktop/backend/tests/test_layer.py"), "def test_layer():\n    assert True\n");
    assert.equal(run(CHECK).status, 0, "the layer's tests are not in its wheel");
    unreleasable("desktop/backend/");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the receipt names the repository's tree, and a release refuses any uncommitted tracked file", () => {
  const fixture = checkout("delphi-wheel-tree-");
  const { root, git, run } = fixture;
  try {
    const stamp = runtime(fixture);
    // A runtime from before the tree was recorded is stale.
    stamp({ tree: false });
    refusedAsStale(run, CHECK);
    stamp();
    assert.equal(run(RELEASE).status, 0, "committed and current");
    const receipt = readFileSync(join(root, "desktop/.delphi-build/python/backend-wheel.receipt"), "utf8").split("\n");
    assert.equal(receipt[7], git("rev-parse", "HEAD^{tree}"), "line 8 is `git rev-parse HEAD^{tree}`");

    // A tracked file outside the wheels' inputs is not wheel content, but a
    // release names a clean tree: the packaged app is built from all of it.
    writeFileSync(join(root, "check.sh"), readFileSync(join(root, "check.sh"), "utf8") + "\n# edited\n");
    assert.equal(run(CHECK).status, 0, "check.sh is not wheel content");
    stamp();
    assert.match(readFileSync(join(root, "desktop/.delphi-build/python/backend-wheel.receipt"), "utf8").split("\n")[7],
      /^[0-9a-f]{40}, with uncommitted changes$/, "a dirty tree is marked on line 8");
    const dirty = run(RELEASE);
    assert.notEqual(dirty.status, 0);
    assert.match(dirty.stderr, /clean checkout; tracked files with uncommitted changes:\n M check\.sh$/m);
    git("checkout", "--", "check.sh");
    assert.notEqual(run(RELEASE).status, 0, "a receipt stamped from the dirty tree");

    // A receipt naming another tree is refused, though it names this commit.
    stamp({ tree: "0".repeat(40) });
    const other = run(RELEASE);
    assert.notEqual(other.status, 0);
    assert.match(other.stderr, /built from the tree 0{40}, not [0-9a-f]{40}\. Run npm run build/);
    stamp();
    assert.equal(run(RELEASE).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const CORE_ENV = fileURLToPath(new URL("../../.delphi-build/core-env/bin/python3", import.meta.url));
const needsCoreEnv = { skip: !existsSync(CORE_ENV) && "scripts/core-env.sh has not been run" };

test("the wheel is built from core/, and reused only for the same content", needsCoreEnv, () => {
  const { root, sourced } = checkout("delphi-wheel-build-");
  try {
    const build = () => {
      const result = sourced(`backend_wheel ${JSON.stringify(CORE_ENV)}`);
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    const hash = sourced("core_content_hash").stdout.trim();
    const wheel = build();
    assert.equal(wheel, join(root, `desktop/.delphi-build/cache/core-wheel/${hash}/delphi_core-0.0.1-py3-none-any.whl`));
    const built = statSync(wheel).mtimeMs;
    assert.equal(build(), wheel, "same content, same wheel");
    assert.equal(statSync(wheel).mtimeMs, built, "and not rebuilt");
    assert.equal(spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout, "", "the build writes nothing into the checkout");
    const listing = spawnSync("unzip", ["-l", wheel], { encoding: "utf8" }).stdout;
    for (const name of ["LICENSE", "NOTICE"]) {
      assert.match(listing, new RegExp(`delphi_core-0\\.0\\.1\\.dist-info/licenses/${name}\\n`), `the wheel carries the root ${name}`);
    }
    writeFileSync(join(root, "core/delphi_core/__init__.py"), "VERSION = 3\n");
    const changed = build();
    assert.notEqual(changed, wheel, "new content, new wheel");
    writeFileSync(join(root, "NOTICE"), "notice, revised\n");
    assert.notEqual(build(), changed, "a new NOTICE is new wheel content");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the desktop layer's wheel is built from desktop/backend/ beside core's, and reused only for the same content", needsCoreEnv, () => {
  const { root, sourced } = checkout("delphi-wheel-desktop-build-");
  try {
    const build = (fn: "backend_wheel" | "desktop_wheel") => {
      const result = sourced(`${fn} ${JSON.stringify(CORE_ENV)}`);
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    const hash = sourced("core_content_hash").stdout.trim();
    const cache = join(root, `desktop/.delphi-build/cache/core-wheel/${hash}`);
    const desktop = build("desktop_wheel");
    assert.equal(desktop, join(cache, "delphi_desktop-0.0.1-py3-none-any.whl"));
    // Either order leaves both wheels of one content in its directory.
    const core = build("backend_wheel");
    assert.equal(core, join(cache, "delphi_core-0.0.1-py3-none-any.whl"));
    assert.ok(existsSync(desktop), "building core's wheel kept the desktop's");
    const built = statSync(desktop).mtimeMs;
    assert.equal(build("desktop_wheel"), desktop, "same content, same wheel");
    assert.equal(statSync(desktop).mtimeMs, built, "and not rebuilt");
    assert.equal(spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout, "", "the build writes nothing into the checkout");
    const listing = spawnSync("unzip", ["-l", desktop], { encoding: "utf8" }).stdout;
    assert.match(listing, /delphi_desktop\/__init__\.py\n/);
    assert.doesNotMatch(listing, /tests\/|delphi_core\//, "the layer's wheel holds the layer alone");
    for (const name of ["LICENSE", "NOTICE"]) {
      assert.match(listing, new RegExp(`delphi_desktop-0\\.0\\.1\\.dist-info/licenses/${name}\\n`), `the wheel carries the root ${name}`);
    }
    const metadata = spawnSync("unzip", ["-p", desktop, "delphi_desktop-0.0.1.dist-info/METADATA"], { encoding: "utf8" }).stdout;
    assert.match(metadata, /^Requires-Dist: delphi-core==0\.0\.1$/m);

    writeFileSync(join(root, "desktop/backend/delphi_desktop/__init__.py"), "LAYER = 3\n");
    const changed = build("desktop_wheel");
    assert.notEqual(changed, desktop, "new content, new wheel");
    assert.notEqual(build("backend_wheel"), core, "and core's is built again under the new content's hash");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
