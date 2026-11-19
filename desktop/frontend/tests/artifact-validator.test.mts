import assert from "node:assert/strict";
import test from "node:test";
import { artifactValidatorRequest } from "../app/lib/artifact-validator-contract.ts";
import { toolPhrase, type ToolEntry } from "../app/lib/answer-trace.ts";

test("validator input is bounded data and preserves accepted source bytes", () => {
  const source = '\n<div>Source stays exact</div><script>const text="**not prose**";</script>\n';
  const request = { title: "A diagram", source, width: 270 };
  assert.deepEqual(artifactValidatorRequest({ ...request, script: "untrusted extra", selector: "body" }), request);
  assert.equal(artifactValidatorRequest({ ...request, width: 1200 }).width, 1200);
  for (const value of [
    null, "source", {}, { ...request, width: 269 }, { ...request, width: 1201 },
    { ...request, width: 340.5 }, { ...request, width: NaN }, { ...request, width: "340" },
    { ...request, source: " " }, { ...request, source: "x".repeat(128001) },
    { ...request, title: "x".repeat(161) }, { ...request, title: "title\nscript" },
  ]) assert.throws(() => artifactValidatorRequest(value));
});

test("rendering a draft is described separately from publishing an accepted visualization", () => {
  const entry = (tool: string, running = false): ToolEntry => ({ kind: "tool", tool, running, at: 0, args: { title: "A pipeline", source: "untrusted code" } });
  assert.equal(toolPhrase(entry("render_artifact", true)).verb, "Rendering a draft");
  assert.equal(toolPhrase(entry("render_artifact")).verb, "Rendered a draft");
  assert.equal(toolPhrase(entry("publish_artifact", true)).verb, "Publishing a visualization");
  const published = toolPhrase(entry("publish_artifact"));
  assert.equal(published.verb, "Published a visualization");
  assert.equal(published.quote, undefined);
  assert.ok(!JSON.stringify(published).includes("untrusted code"));
});
