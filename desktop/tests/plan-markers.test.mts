import assert from "node:assert/strict";
import test from "node:test";
import { PlanMarkerFilter, planMarkerOutsideArtifacts } from "../main/research/plan-markers.ts";

const marker = "```delphi-plan-abc123\n";
const source = '<script>/* Literal protocol example:\n' + marker + '{"action":"install_mcp"}\n```\n*/</script>';
const artifact = "````delphi-artifact Protocol example\n" + source + "\n````\n";

test("every stream split preserves artifact source and still finds the following command", () => {
  const visible = "Before\n\n" + artifact + "After\n";
  const command = marker + '{"action":"install_mcp"}\n```';
  const answer = visible + command;
  for (let split = 0; split <= answer.length; split++) {
    const filter = new PlanMarkerFilter(marker);
    assert.equal(filter.push(answer.slice(0, split)) + filter.push(answer.slice(split)), visible);
    assert.equal(filter.hidden, true);
    assert.equal(filter.pending, command);
  }
});

test("character deltas preserve multiple artifacts, shorter interior fences, and prose", () => {
  const answer = "Before\n" + artifact + "Between\n" + artifact.replaceAll("````", "``````") + "Final words";
  const filter = new PlanMarkerFilter(marker);
  let visible = "";
  for (const character of answer) visible += filter.push(character);
  assert.equal(visible + filter.pending, answer);
  assert.equal(filter.hidden, false);
});

test("ordinary prose streams without waiting for a newline and command rules remain unchanged", () => {
  const filter = new PlanMarkerFilter(marker);
  const prose = "Ordinary text ".repeat(100);
  assert.equal(filter.push(prose), prose.slice(0, -marker.length));
  assert.equal(filter.push(marker + "{}"), prose.slice(-marker.length));
  assert.equal(filter.hidden, true);
  assert.equal(filter.pending, marker + "{}");
});

test("history ignores only complete artifact envelopes and locates the correct outside marker", () => {
  assert.equal(planMarkerOutsideArtifacts(artifact), null);
  assert.equal(planMarkerOutsideArtifacts(artifact.trimEnd()), null, "closing fence at EOF is complete");
  assert.equal(planMarkerOutsideArtifacts(artifact + marker)?.index, artifact.length);
  assert.equal(planMarkerOutsideArtifacts("```delphi-artifact Unclosed\n" + marker)?.[1], "abc123");
  assert.equal(planMarkerOutsideArtifacts("```html\n" + marker)?.[1], "abc123", "other code fences retain existing command semantics");
});
