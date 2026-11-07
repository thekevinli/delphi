import assert from "node:assert/strict";
import test from "node:test";
import { artifactFrameWatch, artifactNavigationGuard } from "../main/artifacts/navigation.ts";

const main = { name: "", url: "http://localhost:8317/", parent: null };
const artifact = { name: "delphi-artifact-a", url: "about:srcdoc", parent: main };
const blocksArtifactNavigation = artifactNavigationGuard().blocks;

test("generated frames cannot navigate to network, local files, or another document", () => {
  for (const url of ["https://example.org/leak", "http://localhost:8317/api/chat", "file:///tmp/private", "data:text/html,hello", "about:blank"]) {
    assert.equal(blocksArtifactNavigation({ url, frame: artifact }), true);
    assert.equal(blocksArtifactNavigation({ url, frame: { ...artifact, name: "renamed" } }), true);
    assert.equal(blocksArtifactNavigation({ url, frame: main, initiator: artifact }), true);
    assert.equal(blocksArtifactNavigation({ url, frame: { name: "child", url: "about:blank", parent: artifact } }), true);
  }
});

test("a reset can replace srcdoc without changing reader or main-frame navigation", () => {
  assert.equal(blocksArtifactNavigation({ url: "about:srcdoc", frame: artifact, initiator: main }), false);
  assert.equal(blocksArtifactNavigation({ url: "https://example.org/paper", frame: { name: "delphi-frame-paper", url: "http://127.0.0.1:8318/page", parent: main } }), false);
  assert.equal(blocksArtifactNavigation({ url: "http://localhost:8317/library", frame: main }), false);
  assert.equal(blocksArtifactNavigation({ url: "http://localhost:8317/library", frame: null }), false);
});

test("a frame cannot shed the navigation guard by renaming itself and visiting blank", () => {
  const guard = artifactNavigationGuard();
  guard.observe({ ...artifact, frameTreeNodeId: 37 });
  const renamed = { ...artifact, name: "renamed", url: "about:blank", frameTreeNodeId: 37 };
  assert.equal(guard.blocks({ url: "https://example.org/escape", frame: renamed }), true);
  assert.equal(guard.blocks({ url: "https://example.org/escape", frame: { ...renamed, frameTreeNodeId: 38 } }), false);
});

test("an artifact cannot navigate a frame of its own, or start a navigation, even to srcdoc", () => {
  const guard = artifactNavigationGuard();
  const child = { name: "child", url: "about:blank", parent: artifact };
  for (const url of ["about:srcdoc", "about:blank"]) {
    assert.equal(guard.blocks({ url, frame: child, initiator: main }), true);
    assert.equal(guard.blocks({ url, frame: artifact, initiator: artifact }), true);
  }
  guard.observe({ ...artifact, frameTreeNodeId: 91 });
  const renamed = { ...artifact, name: "renamed", url: "about:blank", frameTreeNodeId: 91 };
  assert.equal(guard.blocks({ url: "about:srcdoc", frame: { ...child, parent: renamed } }), true);
});

const frameTree = () => {
  const reader = { name: "", url: "http://localhost:8317/", parent: null, frameTreeNodeId: 1, osProcessId: 10 };
  const visual = { name: "delphi-artifact-r1", url: "", parent: reader, frameTreeNodeId: 2, osProcessId: 20 };
  const web = { name: "delphi-frame-paper", url: "http://127.0.0.1:8318/page", parent: reader, frameTreeNodeId: 3, osProcessId: 30 };
  return { reader, visual, web };
};

test("a frame created inside an artifact ends the artifact's process, whatever it is called", () => {
  const killed: number[] = [], logged: string[] = [];
  const watch = artifactFrameWatch(pid => killed.push(pid), message => logged.push(message));
  const { reader, visual } = frameTree();
  watch(visual);
  assert.deepEqual(killed, []);
  // The script renamed its window and moved into the sandbox's process.
  const running = { ...visual, name: "renamed", url: "about:srcdoc", osProcessId: 21 };
  watch({ name: "", url: "", parent: running, frameTreeNodeId: 4, osProcessId: 21 });
  assert.deepEqual(killed, [21]);
  assert.match(logged[0], /nested frame/);
  watch({ name: "", url: "", parent: reader, frameTreeNodeId: 5, osProcessId: 10 });
  assert.deepEqual(killed, [21]);
  // A frame not yet given a process: never a signal to Delphi's own group.
  watch({ name: "", url: "", parent: { ...running, osProcessId: 0 }, frameTreeNodeId: 9, osProcessId: 0 });
  watch({ name: "", url: "", parent: { ...running, osProcessId: process.pid }, frameTreeNodeId: 10, osProcessId: process.pid });
  assert.deepEqual(killed, [21]);
  assert.match(logged.at(-1)!, /cannot be ended/);
});

test("pages in the web frame keep their own frames, even ones named like an artifact", () => {
  const killed: number[] = [];
  const watch = artifactFrameWatch(pid => killed.push(pid), () => {});
  const { web } = frameTree();
  watch(web);
  const named = { name: "delphi-artifact-forged", url: "about:srcdoc", parent: web, frameTreeNodeId: 6, osProcessId: 30 };
  watch(named);
  watch({ name: "", url: "about:srcdoc", parent: named, frameTreeNodeId: 7, osProcessId: 30 });
  watch({ name: "ad", url: "about:srcdoc", parent: web, frameTreeNodeId: 8, osProcessId: 30 });
  assert.deepEqual(killed, []);
});
