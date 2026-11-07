import assert from "node:assert/strict";
import test from "node:test";
import { HISTORY_MESSAGE_MAX_BYTES, rewriteChatHistory } from "../main/research/chat-history.ts";

function chunks(source: string, width = 1) {
  const bytes = new TextEncoder().encode(source);
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset === bytes.length) return controller.close();
    controller.enqueue(bytes.slice(offset, offset = Math.min(bytes.length, offset + width)));
  } }), { headers: { "content-type": "application/json", "content-length": String(bytes.length), "x-metadata": "kept" } });
}

test("message restoration survives byte splits, escaped JSON and nesting", async () => {
  const data = { title: "quoted \"messages\": [ is metadata", active: true, generation: 12,
    messages: [{ role: "user", content: "original\ncapability" }, { role: "assistant", content: 'HTML 🎉 \\ \" } ] ,\nend',
      trace: [{ entries: [{ nested: [1, null, { value: '[{"content":"not the envelope"}]' }] }] }] }],
    images: [{ nested: [true, false, null, -2.5e4] }], tail: "end" };
  const response = chunks(JSON.stringify(data));
  for (const header of ["content-encoding", "etag", "content-md5", "digest"])
    response.headers.set(header, "original-bytes");
  const restored = rewriteChatHistory(response, message => ({ ...(message as object), reviewed: true }), []);
  for (const header of ["content-length", "content-encoding", "etag", "content-md5", "digest"])
    assert.equal(restored.headers.get(header), null);
  assert.ok(response.headers.has("content-length"));
  assert.equal(restored.headers.get("x-metadata"), "kept");
  assert.deepEqual(await restored.json(), { ...data, messages: data.messages.map(message => ({ ...message, reviewed: true })) });
  assert.equal(response.body!.locked, false);
});

test("local replies keep their backend positions, ties and end placement", async () => {
  const messages = [{ role: "user", content: "one" }, { role: "assistant", content: "two" }];
  const replies = [{ id: "before", at: 0, prompt: "a", answer: "b" }, { id: "middle", at: 1, prompt: "c", answer: "d" },
    { id: "tie", at: 1, prompt: "e", answer: "f" }, { id: "beyond", at: 100, prompt: "g", answer: "h" },
    { id: "append", prompt: "i", answer: "j" }];
  const result = await rewriteChatHistory(chunks(JSON.stringify({ messages })), message => message, replies).json();
  assert.deepEqual(result.messages.map((message: any) => message.content), ["a", "b", "one", "c", "d", "e", "f", "two", "g", "h", "i", "j"]);
  const empty = await rewriteChatHistory(chunks('{"messages":[]}'), message => message, replies.slice(0, 1)).json();
  assert.deepEqual(empty.messages.map((message: any) => message.content), ["a", "b"]);
});

for (const source of ['{"messages":[{"content":"unfinished', '{"messages":[]', '{"messages":[{"content":"done"}],"tail":[1,', '{"messages":[],}', '{"messages":[]}garbage']) {
  test(`incomplete or invalid history is not reported as a complete document (${source.slice(-15)})`, async () => {
    await assert.rejects(rewriteChatHistory(chunks(source), message => message, []).text());
  });
}

test("total history may exceed the old whole-response bound without changing artifact source", async () => {
  const source = '<svg><text>diagram</text></svg>' + 'x'.repeat(127_900);
  const content = '```delphi-artifact One\n' + source + '\n```\n\n```delphi-artifact Two\n' + source + '\n```';
  const messages = Array.from({ length: 12 }, (_, index) => ({ role: "assistant", content, requestId: String(index) }));
  const serialized = JSON.stringify({ messages, generation: 0 });
  assert.ok(Buffer.byteLength(serialized) > 3_000_000);
  const result = await rewriteChatHistory(chunks(serialized, 32_768), message => message, []).json();
  assert.deepEqual(result.messages, messages);
});

test("an oversized individual message is refused and upstream is cancelled", async () => {
  let cancelled = false;
  let sent = false;
  const response = new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    if (sent) return;
    sent = true;
    controller.enqueue(new TextEncoder().encode('{"messages":[{"content":"' + 'x'.repeat(HISTORY_MESSAGE_MAX_BYTES + 1)));
  }, cancel() { cancelled = true; } }));
  await assert.rejects(rewriteChatHistory(response, message => message, []).text(), /bounded rewrite limit/);
  assert.equal(cancelled, true);
  assert.equal(response.body!.locked, false);
});

test("cancelling a rewritten history cancels the waiting upstream reader", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"messages":['));
  }, cancel() { cancelled = true; } }));
  const reader = rewriteChatHistory(response, message => message, []).body!.getReader();
  await reader.read(); await reader.read(); await reader.read();
  const waiting = reader.read();
  await Promise.resolve();
  await reader.cancel();
  assert.deepEqual(await waiting, { value: undefined, done: true });
  assert.equal(cancelled, true);
  assert.equal(response.body!.locked, false);
});
