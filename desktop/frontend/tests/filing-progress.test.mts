import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  FILING_STEPS,
  documentsAhead,
  filingStepIndex,
  formatElapsed,
  isCapacityWait,
  isJobFor,
  outdatedFiling,
  queueLine,
  unfiledFiling,
} from "../app/lib/filing-progress.ts";

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("filing steps are data, folded from the stages the pass streams", () => {
  assert.deepEqual(FILING_STEPS.map((step) => step.id), ["read", "plan", "write", "check"]);
  assert.equal(filingStepIndex("Reading the document"), 0);
  assert.equal(filingStepIndex("Preparing research digest"), 0);
  assert.equal(filingStepIndex("Planning how to teach it"), 1);
  assert.equal(filingStepIndex("Deciding which pages to write, and what …"), 1);
  assert.equal(filingStepIndex("Writing the pages"), 2);
  assert.equal(filingStepIndex("Binding equations to source evidence…"), 2);
  assert.equal(filingStepIndex("Checking the tables"), 3);
  assert.equal(filingStepIndex("Correcting the filing"), 3);
});

test("a step never moves backwards, and an unfamiliar stage keeps the one it was on", () => {
  assert.equal(filingStepIndex("Reading page 7", 2), 2);
  assert.equal(filingStepIndex("Something the pass has never said", 1), 1);
  // A stage that names its step is taken at its word; an unknown name is ignored.
  assert.equal(filingStepIndex("anything", 0, "check"), 3);
  assert.equal(filingStepIndex("Writing the pages", 0, "link-graph"), 2);
});

test("the stage an event names decides its step before its wording does", () => {
  // The digest phase opens every filing and speaks like the last two steps.
  assert.equal(filingStepIndex("Checking Adam (1412.6980)", 0, null, "digest_check"), 0);
  assert.equal(filingStepIndex("Summarizing Adam (1412.6980)", 0, null, "digest_check"), 0);
  assert.equal(filingStepIndex("Writing the digest · 4,120 characters", 0, null, "model_stream"), 0);
  assert.equal(filingStepIndex("Reading what there is to file", 0, null, "memory_gather"), 0);
  assert.equal(filingStepIndex("Deciding where Adam belongs in Memory", 0, null, "memory_select"), 1);
  // The author's stage opens with "Reading", which by wording is the first step.
  assert.equal(filingStepIndex("Reading Memory and writing what belongs in it", 1, null, "memory_maintain"), 2);
  assert.equal(filingStepIndex("Checking what was written against its sources", 2, null, "memory_verify"), 3);
  // A page rewrite is the same author and the same check under its own names.
  assert.equal(filingStepIndex("Writing the page again", 0, null, "memory_author"), 2);
  assert.equal(filingStepIndex("Checking the page", 2, null, "memory_verify"), 3);
  // Looking outside is reading, before the choice or after it.
  assert.equal(filingStepIndex("Checking the web pages the answers cited", 0, null, "memory_outside"), 0);
  assert.equal(filingStepIndex("Looking outside the library for what this leaves open", 1, null, "memory_outside"), 1);
  // A domain job composes its page with no choice before it: the write step.
  assert.equal(filingStepIndex("Writing how the pages of Optimizers connect", 0, null, "memory_domain"), 2);
  // The commit follows whichever step ran last: the check, or a choice to file nothing.
  assert.equal(filingStepIndex("Filing", 3, null, "memory_commit"), 3);
  assert.equal(filingStepIndex("Recording that nothing was filed", 1, null, "memory_commit"), 1);
  // A stage no step claims keeps the step, whatever it says.
  assert.equal(filingStepIndex("Waiting for Flex capacity", 2, null, "model_wait"), 2);
  assert.equal(filingStepIndex("Checking something", 1, null, "a_stage_added_later"), 1);
  // Still never backwards: a render redone after a check stays on the check.
  assert.equal(filingStepIndex("Reading Memory and writing what belongs in it", 3, null, "memory_maintain"), 3);
});

test("waiting for capacity is a pause, and the clock reads minutes and seconds", () => {
  assert.equal(isCapacityWait("Waiting for flex capacity"), true);
  assert.equal(isCapacityWait("Writing the pages"), false);
  assert.equal(formatElapsed(102_000), "1:42");
  assert.equal(formatElapsed(5_000), "0:05");
});

test("the line is running documents first, then the rest in order, failures left to Health", () => {
  const now = "2026-10-05T12:00:00.000Z";
  const later = "2026-10-05T12:10:00.000Z";
  const earlier = "2026-10-05T11:00:00.000Z";
  const paper = { id: "p-3", title: "Mine" };
  const jobs: Parameters<typeof queueLine>[0] = [
    { id: "a", kind: "document", status: "pending", label: "Waiting one", leaseExpiresAt: null, marker: "paper:p-1" },
    { id: "b", kind: "document", status: "leased", label: "Running", leaseExpiresAt: later, marker: "paper:p-2" },
    { id: "c", kind: "document", status: "pending", label: "Mine", leaseExpiresAt: null, marker: "paper:p-3" },
    { id: "d", kind: "document", status: "leased", label: "Lapsed lease", leaseExpiresAt: earlier, marker: "paper:p-4" },
    { id: "e", kind: "document", status: "failed", label: "Failed", leaseExpiresAt: null, marker: "paper:p-5" },
    { id: "f", kind: "domain", status: "pending", label: "A domain", leaseExpiresAt: null, marker: "domain:x" },
    // The session beside the same document carries its title and its id, and
    // is not a place in the line of documents.
    { id: "g", kind: "session", status: "pending", label: "Mine", leaseExpiresAt: null, marker: "session:paper:p-3" },
  ];
  const line = queueLine(jobs, paper, now);
  assert.deepEqual(line.map((row) => row.title), ["Running", "Waiting one", "Mine", "Lapsed lease"]);
  assert.deepEqual(line.map((row) => row.position), [0, 1, 2, 3]);
  assert.equal(line[2].self, true);
  assert.equal(documentsAhead(line), 2);
  // The paper's id decides, from the payload or the marker family; a shared title never does.
  assert.equal(isJobFor({ ...jobs[0], label: "Other" }, { id: "p-1" }), true);
  assert.equal(isJobFor({ ...jobs[0], marker: "paper:p-1:part:1" }, { id: "p-1" }), true);
  assert.equal(isJobFor({ ...jobs[0], marker: "paper:p-10" }, { id: "p-1" }), false);
  assert.equal(isJobFor({ ...jobs[0], payload: { paperId: "p-9" } }, { id: "p-1" }), false);
  assert.equal(isJobFor({ ...jobs[0], marker: undefined }, { id: "zzz" }), false);
  assert.equal(isJobFor(jobs[5], { id: "x" }), false);
  assert.equal(isJobFor(jobs[6], paper), false);
});

test("the rail shows filing as steps or as the line, never as a single sentence", async () => {
  const [documentFiling, card, css] = await Promise.all([
    read("../app/components/DocumentFiling.tsx"),
    read("../app/components/FilingProgress.tsx"),
    read("../app/globals.css"),
  ]);
  // Both rail cards hand work in flight to the one component.
  assert.match(documentFiling, /<FilingProgress paper=\{filing\.paper\} \/>/);
  assert.match(documentFiling, /"Updating this document in Memory"/);
  // The old one-line status and the message it carried are gone.
  assert.doesNotMatch(documentFiling, /Queued\. Delphi will file it in the background\.|filing\.message|setMessage\(/);
  // Steps come from the list; only the current one carries what the pass said.
  assert.match(card, /FILING_STEPS\.map\(\(item, index\)/);
  assert.match(card, /state === "current" && live \?/);
  assert.match(card, /Waiting for model capacity · Delphi retries on its own/);
  assert.match(card, /Queued · \$\{ahead\} document/);
  // A failed pass awaiting its retry is not shown as a place in line.
  assert.match(card, /isJobFor\(item, paper\) && isRetrying\(item\)/);
  assert.match(card, /Did not finish · trying again soon/);
  // "File it now" has to start the queue, not only add to it.
  assert.match(documentFiling, /requestMemoryMaintenance\(enabled\);/);
  // One line per queued document, ellipsised.
  assert.match(css, /\.filing-progress-title \{[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/);
  assert.match(css, /\.filing-progress \{[^}]*border-radius: var\(--notice-radius\);[^}]*background: var\(--notice-surface\);/);
  // Every settled state is the same card, drawn from data, with one notice-sized verb.
  assert.match(documentFiling, /<SettledFilingCard card=\{card\} onAction=\{filing\.start\} \/>/);
  assert.match(documentFiling, /<SettledFilingCard card=\{unfiledFiling\(current, filing\.filedHere\)\}/);
  assert.match(card, /className=\{card\.primary \? "primary-button" : "secondary-button"\}/);
  assert.match(css, /\.filing-progress-actions \.primary-button,/);
  assert.doesNotMatch(documentFiling, /reader-unfiled-action|filing-dropped-why/);
});

const record = { filed: true, stuck: false, stale: false, dropped: [] as { slug: string; title: string; reason: string }[] };

test("a refused page is listed with its reason, and outranks an older pass", () => {
  const dropped = [
    { slug: "muon", title: "Muon optimizer", reason: "The update rule is not in the passage it cites." },
    { slug: "newton-schulz", title: "", reason: "Cites a figure the document does not have." },
  ];
  const card = outdatedFiling({ ...record, stale: true, dropped });
  assert.equal(card?.title, "2 pages weren’t written");
  assert.equal(card?.tone, "attention");
  assert.deepEqual(card?.pages?.map((page) => page.title), ["Muon optimizer", "newton-schulz"]);
  assert.equal(card?.action, "Retry document");
  assert.equal(outdatedFiling({ ...record, dropped: dropped.slice(0, 1) })?.title, "A page wasn’t written");
});

test("a job that gave up after its page was written still offers Try again", () => {
  const card = outdatedFiling({ ...record, filed: false, stuck: true });
  assert.equal(card?.action, "Try again");
  assert.equal(card?.tone, "attention");
  assert.match(card?.subtitle ?? "", /Only its own page/);
  assert.match(outdatedFiling({ ...record, stuck: true })?.subtitle ?? "", /still in Memory/);
  // A dropped page is the more useful thing to say when both are true.
  assert.equal(outdatedFiling({ ...record, stuck: true, dropped: [{ slug: "a", title: "A", reason: "r" }] })?.action, "Retry document");
});

test("an older pass is optional, and a current filing owes nothing", () => {
  const card = outdatedFiling({ ...record, stale: true });
  assert.equal(card?.tone, "info");
  assert.equal(card?.primary, false);
  assert.equal(card?.action, "Update document");
  assert.equal(outdatedFiling(record), null);
});

test("a document with no page says which of three things is true, a past outcome first", () => {
  assert.equal(unfiledFiling({ ...record, filed: false, stuck: true }, false).action, "Try again");
  assert.equal(unfiledFiling({ ...record, filed: false, stuck: true }, false).tone, "attention");
  assert.equal(unfiledFiling(record, false).action, "File it again");
  assert.equal(unfiledFiling({ ...record, filed: false }, true).action, "File it again");
  assert.equal(unfiledFiling(null, false).action, "File it now");
  assert.equal(unfiledFiling(null, false).tone, "info");
});
