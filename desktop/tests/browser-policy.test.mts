import assert from "node:assert/strict";
import test from "node:test";
import { sameOrigin, parseSetup } from "../main/browser-policy.ts";

test("navigation compares origins instead of a string prefix", () => {
  const origin = "http://localhost:1234";
  assert.equal(sameOrigin(`${origin}/reader`, origin), true);
  for (const url of ["http://localhost:12345", "http://localhost:1234@evil.test", "http://127.0.0.1:1234", "file:///tmp/page", "garbage"]) assert.equal(sameOrigin(url, origin), false);
});

test("setup names whose key it is, refuses one pasted under the wrong provider, and takes no base URL yet", () => {
  assert.deepEqual(parseSetup({ provider: "openai", apiKey: " sk-key " }), { provider: "openai", apiKey: "sk-key" });
  assert.deepEqual(parseSetup({ provider: "claude", apiKey: "sk-ant-key" }), { provider: "claude", apiKey: "sk-ant-key" });
  for (const input of [null, [], { apiKey: "key" }, { provider: "other", apiKey: "key" }, { provider: "openai", apiKey: 4 }, { provider: "openai", apiKey: "" }, { provider: "openai", apiKey: "key", unexpected: true }]) assert.throws(() => parseSetup(input));
  // Other providers will come through an OpenAI-compatible base URL; until then none is accepted.
  assert.throws(() => parseSetup({ provider: "openai", apiKey: "key", apiBaseUrl: "http://localhost:8000/v1" }), /Unknown setup field/);
  assert.throws(() => parseSetup({ provider: "openai", apiKey: "sk-ant-key" }), /Claude API key/);
  assert.throws(() => parseSetup({ provider: "claude", apiKey: "sk-key" }), /starts with sk-ant-/);
});
