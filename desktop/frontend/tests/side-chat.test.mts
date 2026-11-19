import assert from "node:assert/strict";
import test from "node:test";

import { SIDE_CHARS_SENT, SIDE_TURNS_SENT, closeSideChat, openSideChat, sideBounds, sideColumnWidth, sideCommand, sideRequestBody, sideSplit, sideTurnsForRequest } from "../app/lib/side-chat.ts";
import { sessionCell, sessionFor } from "../app/lib/conversation-session.ts";

test("only /side, alone or with a question, is the command; the menu shows while it is being typed", () => {
  assert.deepEqual(sideCommand("/"), { menu: true, open: null });
  assert.deepEqual(sideCommand("/si"), { menu: true, open: null });
  assert.deepEqual(sideCommand("/side"), { menu: true, open: { question: "" } });
  assert.deepEqual(sideCommand("/side  Why a quintic?\n"), { menu: false, open: { question: "Why a quintic?" } });
  assert.deepEqual(sideCommand("/usr/bin is missing"), { menu: false, open: null });
  assert.deepEqual(sideCommand("/x"), { menu: false, open: null });
  assert.deepEqual(sideCommand("/sidecar"), { menu: false, open: null });
  assert.deepEqual(sideCommand("ask /side"), { menu: false, open: null });
});

test("a laptop's docked column grows by 360 and keeps the reader's room; a large display scales it", () => {
  const laptop = { column: 460, dragged: null, ceiling: 770, room: 1512 - 64 - 68 - 372, floor: 320, viewport: 1512 };
  assert.equal(sideColumnWidth(laptop), 820);
  // A dragged width holds, under the ceiling plus the side's width, inside the room.
  assert.equal(sideColumnWidth({ ...laptop, dragged: 900 }), 900);
  assert.equal(sideColumnWidth({ ...laptop, dragged: 2000 }), 1008);
  assert.equal(sideColumnWidth({ ...laptop, room: 700 }), 700);
  const large = sideColumnWidth({ column: 640, dragged: null, ceiling: 1069, room: 2000, floor: 320, viewport: 2560 });
  assert.equal(large, 640 + Math.round(360 * 2560 * 0.38 / 700));
});

test("the side takes its opening width beside a main chat of at least 340, and lies over one too narrow", () => {
  assert.deepEqual(sideSplit(820, null, 1512, "docked"), { side: 360, overlay: false });
  assert.deepEqual(sideSplit(820, 300, 1512, "docked"), { side: 300, overlay: false });
  assert.deepEqual(sideSplit(820, 200, 1512, "docked"), { side: 280, overlay: false });
  assert.deepEqual(sideSplit(820, 700, 1512, "docked"), { side: 480, overlay: false });
  assert.deepEqual(sideSplit(1464, null, 1512, "expanded"), { side: 420, overlay: false });
  assert.deepEqual(sideSplit(460, null, 1512, "docked"), { side: 360, overlay: true });
  assert.deepEqual(sideSplit(320, null, 1512, "docked"), { side: 280, overlay: true });
  assert.deepEqual(sideBounds(820, 1512), { min: 280, max: 480 });
});

test("a side question carries the finished side exchanges, at most twenty, and the composer's picks", () => {
  const turns = Array.from({ length: 24 }, (_, index) => ({ question: `q${index}`, answer: `a${index}` }));
  const sent = sideTurnsForRequest([...turns, { question: "failed", answer: "", error: "x" }, { question: "stopped", answer: "half", cancelled: true }, { question: "now", answer: "", pending: true }]);
  assert.equal(sent.length, SIDE_TURNS_SENT);
  assert.deepEqual(sent.at(-1), { question: "q23", answer: "a23" });
  // Long exchanges: the oldest go first, so the server never refuses the question.
  const long = Array.from({ length: 5 }, (_, i) => ({ question: `q${i}`, answer: "a".repeat(SIDE_CHARS_SENT / 3) }));
  assert.deepEqual(sideTurnsForRequest(long).map(turn => turn.question), ["q3", "q4"]);
  assert.deepEqual(sideRequestBody({
    scope: { scope: "document", project_id: "p", paper_id: "d" }, conversation: { id: "c".repeat(32), generation: 2 },
    prompt: "Why?", turns: turns.slice(0, 1), model: "gpt", effort: "high", personaId: null,
  }), {
    scope: "document", project_id: "p", paper_id: "d", conversation_id: "c".repeat(32), generation: 2,
    prompt: "Why?", side_turns: [{ question: "q0", answer: "a0" }], model: "gpt", reasoning_effort: "high",
  });
});

test("closing a side chat stops its answer and forgets every turn", () => {
  const session = sessionFor("side-test:0");
  openSideChat(session, "Why?");
  assert.equal(session.values.get("sideOpen"), true);
  assert.equal(session.values.get("sideQueued"), "Why?");
  const controller = new AbortController();
  sessionCell(session, "sideController", null as AbortController | null).current = controller;
  session.values.set("sideTurns", [{ question: "Why?", answer: "Because", pending: true }]);
  closeSideChat(session);
  assert.equal(controller.signal.aborted, true);
  assert.equal(session.values.get("sideOpen"), false);
  assert.deepEqual(session.values.get("sideTurns"), []);
});
