import assert from "node:assert/strict";
import test from "node:test";

import { LAYOUT_CACHE_PREFIX, rememberLayout } from "../app/lib/layout-cache.ts";

/** A `localStorage` holding `entries`, enough of the interface for the cache. */
function heldStorage(entries: [string, string][]): Storage {
  const held = new Map(entries);
  return {
    get length() { return held.size; },
    key: (index: number) => [...held.keys()][index] ?? null,
    getItem: (key: string) => held.get(key) ?? null,
    setItem: (key: string, value: string) => { held.set(key, value); },
    removeItem: (key: string) => { held.delete(key); },
    clear: () => held.clear(),
  };
}

function withStorage(storage: Storage, run: () => void): void {
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
  try {
    run();
  } finally {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  }
}

test("remembering a layout sweeps older revisions' layouts, under either prefix", () => {
  // Written by every build so far, and still in readers' browsers: the sweep
  // must keep finding these under the spelling they were stored with.
  const storage = heldStorage([
    ["delphi:knowledge-layout:revision-1", "[0,0]"],
    ["delphi:knowledge-layout:revision-2", "[1,1]"],
    [`${LAYOUT_CACHE_PREFIX}revision-2`, "[1,1]"],
    ["delphi:conversation:kept", "not a layout"],
  ]);
  withStorage(storage, () => rememberLayout("revision-3", Float32Array.from([2, 3])));

  assert.equal(storage.getItem("delphi:knowledge-layout:revision-1"), null);
  assert.equal(storage.getItem("delphi:knowledge-layout:revision-2"), null);
  assert.equal(storage.getItem(`${LAYOUT_CACHE_PREFIX}revision-2`), null);
  assert.equal(storage.getItem("delphi:conversation:kept"), "not a layout");
  assert.equal(storage.getItem(`${LAYOUT_CACHE_PREFIX}revision-3`), "[2,3]");
  assert.equal(storage.length, 2);
});

test("a layout is not remembered where storage refuses it, and nothing throws", () => {
  const refusing = { ...heldStorage([]), setItem: () => { throw new Error("QuotaExceededError"); } };
  assert.doesNotThrow(() => withStorage(refusing, () => rememberLayout("revision-1", Float32Array.from([1]))));
});
