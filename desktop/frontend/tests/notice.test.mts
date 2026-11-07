import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("every notice shares one surface, and its state lives in the mark's tile", async () => {
  const css = await read("../app/globals.css");
  assert.match(css, /--notice-surface: var\(--paper\);/);
  assert.match(css, /\.processing-document-banner,\s*\.kb-notice-card,\s*\.kb-backfill \{[^}]*border-radius: var\(--notice-radius\);[^}]*background: var\(--notice-surface\);[^}]*box-shadow: var\(--notice-shadow\);/);
  // Dawn while running, cloud blue when done, honey when the reader is needed.
  assert.match(css, /\.notice-mark-running \{[^}]*var\(--dawn\)/);
  assert.match(css, /\.notice-mark-done \{[^}]*var\(--moss\)/);
  assert.match(css, /\.notice-mark-attention \{[^}]*var\(--honey\)/);
  // Rounded squares, never circles or capsules.
  assert.match(css, /\.notice-mark \{[^}]*border-radius: 8px;/);
  assert.match(css, /\.kb-backfill-dismiss \{[^}]*border-radius: 6px;/);
});

test("a running notice's documents sit under a hairline, stage pushed right and quieter", async () => {
  const [components, css] = await Promise.all([
    read("../app/components/MemoryWorkspace.tsx"),
    read("../app/globals.css"),
  ]);
  assert.match(components, /<i className="kb-backfill-filing-spin" aria-hidden="true" \/>\s*<strong>\{title\}<\/strong>/);
  assert.match(css, /\.kb-backfill-filing \{[^}]*border-top: 1px solid var\(--notice-hairline\);/);
  assert.match(css, /\.kb-backfill-filing li > span \{[^}]*font-size: 11\.5px;[^}]*text-align: right;/);
  assert.match(css, /\.kb-backfill-detail \{[^}]*margin-top: 4px;[^}]*font-size: 12\.5px;/);
});

test("one-line messages: errors stay until dismissed, hints leave on their own", async () => {
  const [notice, css, workspace, memoryWorkspace, dashboard] = await Promise.all([
    read("../app/components/Notice.tsx"),
    read("../app/globals.css"),
    read("../app/components/Workspace.tsx"),
    read("../app/components/MemoryWorkspace.tsx"),
    read("../app/components/Dashboard.tsx"),
  ]);
  // A plain string is an error: warning mark, explicit dismiss, never timed.
  assert.match(notice, /typeof notice === "string" \? "error" : notice\.tone/);
  assert.match(notice, /className="toast toast-error" role="alert"/);
  assert.match(notice, /className="toast-close" aria-label="Dismiss"/);
  // A hint's lifetime is a CSS animation; its end dismisses it, hover holds it.
  assert.match(notice, /event\.animationName === "toast-hint-life"/);
  assert.match(css, /\.toast-hint \{[^}]*toast-hint-life 6s linear both;/);
  assert.match(css, /\.toast-hint:hover,\s*\.toast-hint:focus-visible \{\s*animation-play-state: paused;/);
  assert.doesNotMatch(css, /\.toast-error \{[^}]*toast-hint-life/);
  // Every surface that shows one-line messages uses the one component, hands
  // it the notice with its tone, and leaves the lifetime to it.
  assert.match(dashboard, /<Toast notice=\{notice\} onDismiss=\{\(\) => setNotice\(""\)\} \/>/);
  assert.doesNotMatch(workspace + memoryWorkspace + dashboard, /onNotice=\{\(notice\) => set\w+\(noticeText\(notice\)\)\}/);
  assert.doesNotMatch(workspace + memoryWorkspace + dashboard, /setTimeout\(\(\) => setNotice\(""\)/);
  assert.match(workspace, /<Toast notice=\{notice\} onDismiss=\{\(\) => setNotice\(""\)\} \/>/);
  assert.match(memoryWorkspace, /<Toast notice=\{notice\} onDismiss=\{\(\) => setNotice\(""\)\} \/>/);
  assert.doesNotMatch(workspace + memoryWorkspace, /className="toast"/);
});

test("guidance is sent as a hint, failures as plain errors", async () => {
  const [rail, workspace, chat] = await Promise.all([
    read("../app/components/chat/ConversationRail.tsx"),
    read("../app/components/Workspace.tsx"),
    read("../app/components/ChatPanel.tsx"),
  ]);
  assert.match(rail, /const FULL = "10 chats maximum\. Continue a chat or delete one to start another\.";[\s\S]*onNotice\(hint\(FULL\)\)/);
  assert.match(workspace, /setNotice\(hint\("Delphi reads PDFs or webpages — that file is not one\."\)\)/);
  assert.match(chat, /onNotice\(hint\("Open a document or project chat before attaching an image\."\)\)/);
  // The session failure is an error: it must not time out unread.
  assert.match(workspace, /setNotice\("Local session unavailable\. Quit and reopen Delphi to reconnect\."\)/);
});

test("Related Memory says only how many pages it left out, as a solid corner tag", async () => {
  const [rail, css] = await Promise.all([
    read("../app/components/RelatedMemoryRail.tsx"),
    read("../app/globals.css"),
  ]);
  assert.doesNotMatch(rail, /more pages in list/);
  assert.match(rail, /className="kb-related-hidden"[\s\S]{0,200}\+\{visual\.hidden\}/);
  assert.match(css, /\.kb-related-hidden \{[^}]*right: 10px;[^}]*bottom: 10px;[^}]*border-radius: 4px;[^}]*color: #fff;/);
});
