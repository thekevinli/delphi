import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Render one path through the built Worker.
 *
 * `path` is a parameter because routes are now a thing Delphi has: a document
 * address, the two auth pages, and everything that should not resolve all need to
 * be asserted, and this is the only way to do that without a browser.
 */
/**
 * Every component and helper as one string.
 *
 * These assertions are about wiring that spans files — a component importing the
 * library it depends on, a class name the stylesheet also defines — and none of
 * them care which file a given line lives in. Reading the whole set is what lets
 * the code be reorganised without a test failing for a reason that is not a
 * regression; pinning a path is what left several of them stale after the last
 * split.
 */
/**
 * Every client source, as one string.
 *
 * Recursive, because these assertions are about what the product *does* and a
 * component moving into a subdirectory changes nothing about that. Reading the
 * concatenation rather than naming files is what stopped a batch of these
 * breaking during an earlier split; recursing is the same argument one level
 * down, and it is what let the chat surface grow a `components/chat/` folder
 * without silently emptying half the checks below.
 */
async function sources() {
  const dirs = ["../app/components", "../app/lib"];
  const parts = [];
  const walk = async (base) => {
    for (const entry of await readdir(base, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        await walk(new URL(`${entry.name}/`, base));
        continue;
      }
      if (/\.(tsx?|mts)$/.test(entry.name)) {
        parts.push(await readFile(new URL(entry.name, base), "utf8"));
      }
    }
  };
  for (const dir of dirs) {
    await walk(new URL(`${dir}/`, import.meta.url));
  }
  return parts.join("\n");
}

async function render(path = "/", origin = "http://localhost") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(new URL(path, origin), {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Delphi Dashboard without flashing the Reader", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Dashboard · Delphi<\/title>/i);
  assert.match(html, /class="dashboard-shell"/);
  // The wording of the loading state is free to change; that the first paint
  // is a live loading state — announced, and not the Reader — is the fact.
  assert.match(html, /class="dashboard-loading"[^>]*role="status"/);
  assert.doesNotMatch(html, /class="three-panel"/);
});

test("desktop has no marketing or authentication portals", async () => {
  for (const path of ["/landing", "/login", "/register"]) {
    assert.equal((await render(path)).status, 404);
  }
  const components = await sources();
  assert.doesNotMatch(components, /api\("\/api\/auth\/(logout|change-password)"/);
});


test("the inert three-segment reader route keeps the shared shell mounted", async () => {
  const response = await render("/@Reader/scaling-laws/chinchilla");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /class="loading-screen"/);
  assert.match(html, /Opening Delphi…/);
});

test("keeps Markdown and KaTeX rendering connected to assistant messages", async () => {
  const [workspace, layout, css, packageJson] = await Promise.all([
    sources(),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(workspace, /from "react-markdown"/);
  assert.match(workspace, /from "remark-math"/);
  assert.match(workspace, /from "remark-gfm"/);
  assert.match(workspace, /from "rehype-katex"/);
  assert.match(workspace, /REMARK_PLUGINS/);
  assert.match(workspace, /markdown-table-scroll/);
  assert.match(workspace, /message\.role === "assistant"/);
  assert.match(workspace, /role="link"/);
  assert.match(workspace, /tabIndex=\{0\}/);
  assert.match(workspace, /event\.key === "Enter"/);
  assert.match(layout, /katex\/dist\/katex\.min\.css/);
  assert.match(css, /\.message-markdown \.katex-display/);
  assert.match(css, /\.markdown-table-scroll/);
  assert.match(css, /\.message-markdown table/);
  assert.match(packageJson, /"react-markdown"/);
  assert.match(packageJson, /"remark-gfm"/);
  assert.match(packageJson, /"remark-math"/);
  assert.match(packageJson, /"rehype-katex"/);
  assert.match(packageJson, /"katex"/);
});

test("chat answers and digests share one reading type, the chat only smaller", async () => {
  const [css, flow, digest] = await Promise.all([
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/components/AnswerTrace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ResearchDigestView.tsx", import.meta.url), "utf8"),
  ]);
  // Both surfaces wear the one class.
  assert.match(flow, /className="message-markdown prose-reading"/);
  assert.match(digest, /className="digest-document prose-reading message-markdown"/);
  // The digest's faces and scale, once.
  const base = /\.prose-reading \{([^}]*)\}/.exec(css)?.[1];
  assert.ok(base);
  assert.match(base, /--prose-size: 16px;/);
  assert.match(base, /font-family: var\(--font-wiki\);/);
  assert.match(base, /font-size: var\(--prose-size\);/);
  // The chat changes sizes only, never rules.
  const chat = /\.message\.assistant \.prose-reading \{([^}]*)\}/.exec(css)?.[1];
  assert.ok(chat);
  assert.match(chat, /--prose-size: 15px;/);
  assert.doesNotMatch(chat, /font-family|color:/);
  // No chat-only answer rules left to outrank the shared ones.
  assert.doesNotMatch(css, /\.message\.assistant \.message-markdown (?:h1|p|a|strong|code|li)\b/);
  // Citations and code take the digest's treatment in both.
  assert.match(css, /\.prose-reading \.citation-link \{[^}]*font-size: 0\.8em;[^}]*font-weight: 600;/);
  assert.match(css, /\.prose-reading :not\(pre\) > code \{[\s\S]*?font-family: var\(--font-note-code\);/);
  assert.match(
    css,
    /\.citation-link \{[\s\S]*?display: inline;[\s\S]*?white-space: normal;/,
  );
});

test("reaches every persona endpoint from one control", async () => {
  const [workspace, api, css] = await Promise.all([
    sources(),
    readFile(new URL("../app/lib/api.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  // Asserted by endpoint rather than by component name, so reorganising the
  // components does not fail this for a non-reason.
  //
  // There used to be two persona controls: a drop-up in the account-wide chat,
  // and a button in every reader scope that opened a modal onto the *project's*
  // persona. They looked different and were reached differently. A persona
  // belongs to the conversation being held in it now, so there is one control
  // and nothing for the scope to branch on.
  assert.doesNotMatch(workspace, /composer-persona/);
  assert.doesNotMatch(workspace, /onOpenPersona/);
  assert.doesNotMatch(workspace, /\/api\/projects\/\$\{project\.id\}\/persona/);
  assert.match(workspace, /"\/api\/personas"/);
  assert.match(workspace, /\/api\/personas\/browse\?/);
  assert.match(workspace, /\/api\/personas\/\$\{persona\.id\}\/install/);
  // The choice is written to the conversation, which is what makes it survive
  // a reload — the whole point of moving it off the project.
  assert.match(workspace, /\/api\/chat\/persona\?/);
  // What a persona with `learner_memory` records is no longer a per-project
  // note list — it is the account-wide Memory. The assertion that used
  // to pin `/api/projects/${project.id}/learner` failed the day that shipped,
  // which is the failure mode this file warns about: it pinned a spelling that
  // was supposed to change. The durable fact is that the reader can reach the
  // memory a persona keeps about them.
  // Pinned as `href="/memory"` when the only way in was a card in the
  // account sheet; the account menu owns it now and builds the address from a
  // table, so the spelling moved again. What has to stay true is that the wiki
  // is reachable from the chrome, whatever the chrome is this month.
  assert.match(workspace, /"\/memory"/);
  assert.match(workspace, /expected_revision/);
  // The editor's file loader is gone: a persona is written in the box, and a
  // second way to fill it was chrome nobody reached for.
  assert.doesNotMatch(workspace, /accept="\.md,\.txt,text\/markdown,text\/plain"/);
  assert.match(api, /export type PersonaSummary/);
  assert.match(api, /export type PersonaBrowsePage/);
  assert.doesNotMatch(workspace, /value="SKILLS\.md"/);
  // Log out has moved twice: a pill floating over the foot of the sheet, then
  // the last row of Security, and now the foot of the settings rail. What has
  // to stay true is that it is one click from wherever the reader is, so it
  // sits in the rail every pane shows and not inside one pane's scroll.
  assert.doesNotMatch(css, /\.account-modal-footer/);
  assert.doesNotMatch(workspace, /className="settings-nav-item settings-logout"/);
  assert.doesNotMatch(css, /\.settings-logout/);
});

test("one persona menu, listing officials and your own, in every chat", async () => {
  const [components, css] = await Promise.all([
    sources(),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  // Named, and truncated rather than wrapped: inside a tool row the persona is
  // one pill among several.
  assert.match(components, /className="persona-pill-label"/);
  assert.match(css, /\.persona-pill-label \{[\s\S]*?text-overflow: ellipsis/);

  // Officials and your own, told apart, in every chat.
  assert.match(components, /Your personas/);
  // Managing them is a settings errand, so the menu asks upward rather than
  // opening anything over the conversation.
  assert.match(components, /Manage personas/);
  assert.match(components, /persona-picker-manage/);

  // A persona can be deleted while a conversation still names it, so a stored
  // id can dangle. The server resolves that to the account default rather than
  // failing the thread; the pill has to say the same thing, or it reads
  // "Persona" with no icon and tells the reader nothing about the voice their
  // next question will actually get.
  assert.match(components, /fallbackId/);
});

test("the persona menu opens above its own pill in every chat surface", async () => {
  const [components, css] = await Promise.all([
    sources(),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  // The wiki rail used to re-anchor the menu to the *right* edge of the
  // composer, so it opened at the far side of the panel with its pill nowhere
  // near it — and the same 400px overflow was never fixed for the reader's own
  // docked chat, which had no override at all. One rule for every surface now,
  // with the room measured on open because CSS cannot ask an ancestor how wide
  // it is.
  assert.doesNotMatch(css, /\.kb-chat-rail \.persona-picker-menu/);
  assert.doesNotMatch(css, /\.kb-chat-rail \.persona-pill/);
  assert.match(css, /--persona-menu-width/);
  assert.match(components, /--persona-menu-width/);
  // Still a drop-up, anchored to the pill's own right edge.
  assert.match(css, /\.persona-picker-menu \{[\s\S]*?bottom: calc\(100% \+ 10px\)/);
});

test("a persona's instructions are read beside the list, not on top of it", async () => {
  const [components, css] = await Promise.all([
    sources(),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  // Managing personas moved out of a modal floating over the reader and into
  // Settings, between Chats and Memory. "See detail" widens the sheet by a
  // column rather than covering the row it came from, because the reader is
  // comparing the two.
  assert.match(components, /aria-label={`See \${persona\.name} in detail`}/);
  assert.match(components, /className="settings-detail"/);
  // Collapsing the prompt uses the marketplace Back, not a second close.
  assert.match(components, /settings-detail[\s\S]*?PersonaBackButton/);
  assert.doesNotMatch(components, /settings-detail-collapse/);
  assert.match(css, /\.settings-modal\.is-detail \{[\s\S]*?grid-template-columns: 208px minmax\(0, 1fr\) 360px/);
  // A `0px` third track in the base rule, so the count is stable and the
  // widening interpolates instead of snapping.
  assert.match(css, /\.settings-modal \{[\s\S]*?grid-template-columns: 208px minmax\(0, 1fr\) 0px/);
  assert.match(components, />New persona<\/span>/);

  // The marketplace is a place, not the picker with a search box: a shelf of
  // cards carrying the two facts only a published persona has.
  assert.match(css, /\.persona-market-grid \{[\s\S]*?repeat\(auto-fill/);
  assert.match(components, /persona-market-author/);
  assert.match(components, /persona-market-installs/);
  // It morphs the sheet rather than opening a second dialog, which is what
  // lets "Back" return the reader to the pane they came from.
  assert.match(css, /\.settings-modal\.is-market/);
  assert.match(components, /All personas|‹<\/span> Back/);

  // The old picker modal is gone entirely.
  assert.doesNotMatch(css, /\.persona-dialog-cluster/);
  assert.doesNotMatch(css, /\.persona-skills-slot/);
});

test("offers project rename and removal from one actions menu", async () => {
  const components = await sources();

  assert.match(components, /data-project-menu/);
  assert.match(components, /className="project-switch" data-project-menu/);
  assert.match(components, /projectActionsMenu\(project\)/);
  assert.match(components, /setRenameProjectTarget\(item\)/);
  assert.match(components, /setDeleteProjectTarget\(item\)/);
  assert.match(
    components,
    /api\(`\/api\/projects\/\$\{id\}`,[\s\S]*?method: "DELETE"/,
  );
  assert.match(components, /<DeleteWithPagesModal\s+kind="project"\s+id=\{deleteProjectTarget.id\}/);
  assert.match(components, /\{action \?\? `Delete \$\{kind\}`\}\s*<\/button>/);
});

test("resolves every persona element through a palette alias", async () => {
  const [components, css, personas] = await Promise.all([
    sources(),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/personas.ts", import.meta.url), "utf8"),
  ]);

  for (const element of ["fire", "water", "leaf", "bolt", "stone", "wind"]) {
    assert.match(personas, new RegExp(`"${element}"`));
    // Declared as an alias of an existing token. A raw hex here would be a
    // sixth brand colour arriving through the back door.
    assert.match(
      css,
      new RegExp(`--element-${element}: (var\\(--|color-mix\\()[^;]*;`),
    );
    assert.match(css, new RegExp(`\\.element-icon\\.element-${element}`));
  }
  assert.match(components, /className=\{`element-icon element-\$\{element\}`\}/);
});

test("reads the persona character cap from server config", async () => {
  const [components, api] = await Promise.all([
    sources(),
    readFile(new URL("../app/lib/api.ts", import.meta.url), "utf8"),
  ]);

  // The server enforces this limit, so the client must not carry its own copy.
  // A hardcoded 30_000 here is the exact drift /api/config exists to prevent.
  assert.match(components, /config\.personaMaxCharacters/);
  assert.doesNotMatch(components, /maxLength=\{30_000\}/);
  assert.match(api, /personaMaxCharacters: number/);
  assert.match(api, /personaMaxCharacters: 30_000/);
});

test("opens quick-add on hover and retracts it after a meaningful leave", async () => {
  const [workspace, css] = await Promise.all([
    sources(),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(
    workspace,
    /aria-label=\{[\s\S]*?addMenuVisible[\s\S]*?"Close add menu"[\s\S]*?"Add a source"/,
  );
  assert.match(
    workspace,
    /onPointerEnter=\{\(event\) => \{[\s\S]*?source: "hover",[\s\S]*?setAddMenuOpen\(true\)/,
  );
  assert.match(
    workspace,
    /onPointerLeave=\{\(event\) => \{[\s\S]*?addMenuCloseRef\.current = setTimeout\([\s\S]*?setAddMenuOpen\(false\);[\s\S]*?}, 160\)/,
  );
  assert.match(workspace, /event\.pointerType === "touch"/);
  assert.match(workspace, /opened\?\.source === "hover"/);
  assert.match(workspace, /Date\.now\(\) - opened\.at < 1000/);
  assert.match(workspace, /onAddWebpage\(\)/);
  assert.match(workspace, /fileRef\.current\?\.click\(\)/);
  // The library's + opens straight onto a web address.
  assert.match(workspace, /onAddWebpage=\{\(\) => setAddDocumentOpen\(true\)\}/);
  assert.match(css, /\.quick-add\.open \.quick-add-glyph/);
  assert.match(css, /rotate\(135deg\)/);
  assert.match(css, /\.quick-add-menu/);
  assert.match(css, /\.library-panel \{[\s\S]*?z-index: 20/);
});

test("a source chosen before any project exists is carried into the new project's setup", async () => {
  const [workspace, warningGif] = await Promise.all([
    sources(),
    readFile(
      new URL(
        "../public/brand/animations/delphi-warning-alert.gif",
        import.meta.url,
      ),
    ),
  ]);

  // No modal of its own: the file or address waits as the setup's seed, the
  // reader names the project, and the setup that follows starts with it.
  assert.match(workspace, /type SetupSeed = \{ files: File\[\]; urls: string\[\] \}/);
  assert.match(workspace, /setSetupSeed\(\{ files: \[file\], urls: \[\] \}\);\s*setCreateProjectOpen\(true\)/);
  assert.match(workspace, /setSetupSeed\(\{ files: \[\], urls: \[url\] \}\)/);
  assert.match(workspace, /initialFiles=\{setupSeed\.files\}/);
  assert.doesNotMatch(workspace, /FirstProjectModal|PendingFirstSource/);
  assert.doesNotMatch(
    workspace,
    /className="quick-add-toggle"\s+disabled=\{!project/,
  );
  assert.equal(warningGif.includes(Buffer.from("NETSCAPE2.0")), true);
  // The final frame's 308-centisecond delay is its normal 80 ms plus the
  // requested three-second rest before the next loop.
  assert.equal(
    warningGif.includes(Buffer.from([0x21, 0xf9, 0x04, 0x09, 0x34, 0x01])),
    true,
  );
});

test("a full project keeps quick-add closed and explains the limit", async () => {
  const [workspace, css] = await Promise.all([
    sources(),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(workspace, /const atCapacity = Boolean\(/);
  assert.match(workspace, /const addMenuVisible = addMenuOpen && !atCapacity/);
  assert.match(
    workspace,
    /onPointerEnter=\{\(event\) => \{[\s\S]*?if \(atCapacity\) \{[\s\S]*?setCapacityTipProjectId\(project\?\.id \?\? null\);[\s\S]*?return;/,
  );
  assert.match(workspace, /disabled=\{uploading \|\| atCapacity\}/);
  assert.match(workspace, /Project is at maximum capacity/);
  assert.match(workspace, /atCapacity \? "at-capacity" : ""/);
  assert.match(
    workspace,
    /if \(!atCapacity\) return;[\s\S]*?setAddMenuOpen\(false\)/,
  );
  assert.match(workspace, /className="quick-add-capacity-tip"/);
  assert.match(css, /\.quick-add-capacity-tip \{/);
  assert.match(css, /\.quick-add\.at-capacity \.quick-add-glyph/);
  assert.match(css, /\.quick-add\.at-capacity \.quick-add-menu/);
});

test("shows approved loading animations for startup and document processing", async () => {
  const [workspace, pdfViewer, pageViewer, css, sunrise, climb] = await Promise.all([
    sources(),
    readFile(new URL("../app/components/PdfViewer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/PageViewer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(
      new URL(
        "../public/brand/animations/delphi-loading-sunrise.gif",
        import.meta.url,
      ),
    ),
    readFile(
      new URL(
        "../public/brand/animations/delphi-loading-climb.gif",
        import.meta.url,
      ),
    ),
  ]);

  // Opening a project is the three pages, not the Delphi mark: the mark is
  // kept for the start-up window, the Reader and notices.
  assert.match(workspace, /<main className="loading-screen">\s*<div className="loading-status" role="status">\s*<PagesMark \/>\s*<LoadingCaption text="Opening Delphi…" \/>/);
  assert.doesNotMatch(workspace, /className="loading-sunrise"/);
  assert.match(workspace, /<ProcessingDocumentBanner name=\{processingDocumentName\}/);
  assert.match(workspace, /setProcessingDocumentName\(file\.name\)/);
  assert.match(workspace, /delphi-loading-climb\.gif/);
  assert.match(css, /\.processing-document-banner \{/);
  // The upload banner carries the shared state mark: the climb, in its tile.
  assert.match(workspace, /<NoticeMark state="running" \/>/);
  assert.match(css, /\.notice-mark \{[^}]*width: 32px;[^}]*height: 32px;/);
  // Reader panel: climb overlay while a linked PDF or proxied page is still
  // fetching — the same gif as upload processing, centered rather than a
  // top banner, so a twenty-second ArXiv wait does not look like a blank panel.
  assert.match(pdfViewer, /className="document-loading"/);
  assert.match(pdfViewer, /<LoadingCaption text=\{fileUrl \? "Loading webpage…" : "Loading PDF…"\} \/>/);
  assert.match(pageViewer, /className="document-loading"/);
  assert.match(pageViewer, /<LoadingCaption text="Loading webpage…" \/>/);
  assert.match(css, /\.document-loading \{/);
  assert.match(
    css,
    // The size of the other loading marks, so the three read as one family.
    /\.document-loading img \{[\s\S]*?width: 54px;[\s\S]*?height: 54px/,
  );
  assert.equal(sunrise.includes(Buffer.from("NETSCAPE2.0")), true);
  assert.equal(climb.includes(Buffer.from("NETSCAPE2.0")), true);
});

test("centers the image attachment remove glyph independently of font metrics", async () => {
  const [workspace, css] = await Promise.all([
    sources(),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(
    workspace,
    /aria-label="Remove this image"[\s\S]*?<svg[\s\S]*?M2 2l6 6M8 2 2 8/,
  );
  assert.match(
    css,
    /\.composer-image button \{[\s\S]*?display: grid;[\s\S]*?place-items: center/,
  );
  assert.match(css, /\.composer-image button svg \{[\s\S]*?display: block/);
});

test("account navigation dismisses the modal before changing documents", async () => {
  const workspace = await sources();

  assert.match(
    workspace,
    /const leaveForPaper = \(projectId: string, paperId: string\) => \{[\s\S]*?onClose\(\);[\s\S]*?onOpenPaper\(projectId, paperId\);/,
  );
  // Open project goes to the project, not to whichever paper sorts first.
  assert.match(
    workspace,
    /const leaveForProject = \(target: Project\) => \{\s*onClose\(\);\s*onNavigate\(projectPath\(user\.username, target\)\);/,
  );
  assert.match(workspace, /onClick=\{\(\) => leaveForProject\(item\)\}/);
  assert.match(workspace, /leaveForPaper\(item\.id, itemPaper\.id\)/);
});

test("a replied-to passage shows no redundant word-count subtitle", async () => {
  const [workspace, css] = await Promise.all([
    sources(),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(workspace, /words quoted in full/);
  assert.match(workspace, /quoteExpanded \? "Show less" : "Show all"/);
  assert.match(workspace, /aria-label="Remove quoted passage"/);
  assert.match(css, /\.selection-chip p\s*\{[^}]*-webkit-line-clamp:\s*2;/);
  assert.doesNotMatch(css, /\.selection-chip\s*\{[^}]*border-left:/);

  // Sent, it is the same passage and keeps the same card — and one rule on
  // `.message`, not a per-surface one, is what makes the Reader, the wiki and
  // the expanded modal show it identically. Clamped by lines, because a
  // `max-height` cut the last line through its x-height.
  assert.match(css, /\.message > blockquote\s*\{[^}]*-webkit-line-clamp:/);
  assert.doesNotMatch(css, /\.message > blockquote\s*\{[^}]*max-height:/);
  assert.doesNotMatch(css, /\.message > blockquote\s*\{[^}]*border-left:/);
});

test("turns PDF links into full Delphi readers instead of opaque browser frames", async () => {
  const [workspace, api, pageViewer, pdfViewer, css] = await Promise.all([
    sources(),
    readFile(new URL("../app/lib/api.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/PageViewer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/PdfViewer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  // Detection travels as a typed API detail; prose is free to improve without
  // silently disconnecting the hint from the server response.
  assert.match(api, /readonly code\?: string/);
  assert.match(workspace, /reason\.code === "pdf_url"/);
  assert.match(workspace, /Keep as page/);
  assert.match(workspace, /Import PDF/);
  assert.match(workspace, /selection, Reply, highlights/);
  assert.match(workspace, /annotated downloads/);
  assert.match(workspace, /pdf_mode: pdfMode/);
  assert.match(css, /\.modal \.pdf-link-target/);
  assert.match(
    css,
    /\.pdf-link:hover \{[\s\S]*?background: transparent;[\s\S]*?outline: 0/,
  );
  assert.match(css, /\.pdf-link:focus-visible \{[\s\S]*?outline: 1px solid/);

  // Linked PDFs take the PDF.js branch. Keeping them out of PageViewer's
  // cross-origin iframe is what restores click collapse, whole-window drops,
  // text selection, Reply, highlights, and Delphi's pinch implementation.
  assert.match(workspace, /isWebPaper\(paper\) && !isWebPdf\(paper\)/);
  assert.match(
    workspace,
    /papers\/\$\{paper\.id\}\/page/,
  );
  assert.match(pdfViewer, /fileUrl \?\?/);
  // The selection menu is mounted here, whatever modifiers it carries — this
  // used to pin `className="selection-menu"` exactly and broke the day a third
  // action was added, which is a test failing because the product improved.
  assert.match(pdfViewer, /className=\{?[`"]selection-menu/);
  assert.match(pdfViewer, /onReply\(selection\.text\)/);
  assert.match(pdfViewer, /onHighlight/);

  // PageViewer is HTML-only again, so its sandbox stays unconditional.
  assert.doesNotMatch(pageViewer, /frame\.mode/);
  assert.match(pageViewer, /referrerPolicy="no-referrer"/);
  assert.match(pageViewer, /sandbox=\{frame\.sandbox\}/);
});

test("PDF and webpage annotations share the note editor", async () => {
  const [workspace, pageViewer, pdfViewer, editor, css] = await Promise.all([
    sources(),
    readFile(new URL("../app/components/PageViewer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/PdfViewer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/NoteEditor.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  // Web annotations require a canonical anchor from the frame.
  assert.match(pdfViewer, /notesEnabled \?[\s\S]{0,400}?startNote\(\)/);
  assert.match(pageViewer, /selection\.annotation/);
  assert.match(pageViewer, /AnnotationsPanel/);
  assert.match(pageViewer, /onSaveNote/);
  assert.match(workspace, /notesEnabled/);

  // A note hangs off a stroke, so the button mints one and keeps its id —
  // however that statement is spelled.
  assert.match(pdfViewer, /await onHighlight\(/);
  assert.match(pdfViewer, /highlightId: stroke\.id/);

  // A linked PDF is offered a stored copy before either annotation is written,
  // and the annotation is abandoned if the copy was not stored — a mark that
  // survived a declined download would be exactly the fragile one the question
  // was asked to prevent.
  assert.match(
    workspace,
    /if \(!\(await ensureStoredForAnnotation\(\)\)\) return null;/,
  );

  // Enter saves, Shift+Enter breaks the line — the inverse of an editor's
  // default, so it has to be bound explicitly or it silently reverts.
  assert.match(editor, /event\.key === "Enter" && !event\.shiftKey/);
  assert.match(editor, /handlers\.current\.onSave\(/);
  assert.match(editor, /event\.key === "Escape"/);

  // Tiptap is imported lazily, so the reading workspace never loads it.
  assert.match(editor, /await import\("@tiptap\/react"\)|import\("@tiptap\/react"\)/);
  assert.match(pdfViewer, /lazy\(\(\) => import\("\.\/NoteEditor"\)\)/);

  // The body is markdown on the wire, which is what Memory reads.
  assert.match(editor, /docToMarkdown|markdownToDoc/);

  // The highlighted passage is already visible beneath the card. Repeating it
  // inside the writing surface steals the first two lines from the note itself.
  assert.doesNotMatch(editor, /note-quote|<blockquote/);

});

test("the saved-note read view stays lightweight and fits the reader", async () => {
  const [preview, css] = await Promise.all([
    readFile(new URL("../app/components/NotePreview.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  // Hover, click, keyboard dismissal and editing are exercised in the browser
  // suite against both viewers; keep the build-level contract here.
  // Reading one costs no editor: the preview renders the stored markdown itself
  // and imports nothing, which is the same argument that made Tiptap lazy.
  assert.doesNotMatch(preview, /@tiptap/);
  assert.match(preview, /markdownToDoc/);

  // The card is measured against the page, so it fits the reader panel wherever
  // the divider is. A fixed width was clipped the moment the panel narrowed,
  // and the old second layout keyed on panel width put it outside the page
  // entirely — a wider reader is a wider *page*, never a margin to move into.
  assert.match(css, /\.pdf-note-open \{[\s\S]*?width:\s*min\([^)]*%\)/);
  assert.match(css, /\.pdf-note-gutter \{[\s\S]*?left:\s*0;[\s\S]*?right:\s*0;/);
  assert.doesNotMatch(css, /^\s*@container reader/m);

  // It grows out of the icon it replaces, so the origin is that icon's centre
  // rather than the card's own middle — otherwise it reads as a panel arriving
  // rather than the mark opening.
  assert.match(css, /\.pdf-note-open \{[\s\S]*?animation:\s*note-pop/);
  assert.match(css, /transform-origin:\s*calc\(100% - 13px\) 13px/);
  assert.match(css, /@keyframes note-pop/);
});

test("deleting a note takes its highlight with it", async () => {
  const [pdfViewer, preview] = await Promise.all([
    readFile(new URL("../app/components/PdfViewer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/NotePreview.tsx", import.meta.url), "utf8"),
  ]);

  // One authoritative highlight deletion cascades to its note. Failed saves
  // and Escape semantics are exercised by annotation-safety.test.mjs.
  assert.match(pdfViewer, /await onRemoveHighlight\(open\.highlightId\)/);
  assert.match(pdfViewer, /await onRemoveHighlight\(note\.highlightId\)/);
  assert.doesNotMatch(pdfViewer, /await onDeleteNote\?\./);

  // Deleting is reachable from the card you get on one click, not only from
  // the editor two clicks in.
  assert.match(preview, /aria-label="Delete note"/);
  assert.match(preview, /onDelete: \(\) => void;/);
});

test("the reader's toolbar and the windows that hang off it stay out of each other's way", async () => {
  const [panel, pageViewer, css] = await Promise.all([
    readFile(new URL("../app/components/AnnotationsPanel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/PageViewer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  const rule = (selector) => {
    const found = css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`));
    assert.ok(found, `${selector} is not in the stylesheet`);
    return found[1];
  };

  // The heading names the list. The count of it is already on the trigger, and
  // a reader looking at three entries can see that there are three.
  assert.match(panel, /<strong>Highlights &amp; Notes<\/strong>/);
  assert.doesNotMatch(panel, /saved passage/);

  // Set off by its own shade, not by a rule under it: the first entry's own
  // border already draws that line, and drawing it twice reads as a seam.
  assert.match(rule(".annotations-heading"), /background:/);
  assert.doesNotMatch(rule(".annotations-heading"), /border-bottom/);

  // Both windows drop by the same distance, so two menus off one row of
  // buttons do not open at two different heights.
  assert.match(css, /--reader-menu-drop:/);
  for (const selector of [".annotations-popover", ".reader-menu-items"])
    assert.match(rule(selector), /top: calc\(100% \+ var\(--reader-menu-drop\)\)/);

  // Tooltips open upward, into the space those windows do not use, and the
  // shell clips with a margin so the top row's labels are not cut in half.
  assert.match(rule(".page-tooltip::after"), /bottom: calc\(100% \+ 9px\)/);
  assert.doesNotMatch(rule(".page-tooltip::after"), /(^|\s)top:/);
  assert.match(rule(".page-shell"), /overflow-clip-margin:/);

  // Reading on puts the panel away. A PDF's clicks reach this window; a
  // webpage's are counted by the viewer that owns the frame.
  assert.match(panel, /pageClicks\?: number/);
  // A new click opens it only when it is choosing among marks; otherwise it closes.
  assert.match(panel, /if \(selected !== lastSelection && selected\.length\) setOpen\(true\);\s*else if \(pageClicks !== lastClicks\) setOpen\(false\);/);
  assert.match(pageViewer, /pageClicks=\{pageClicks\}/);

  // Both document types have live and cached views. The copy is kept by the
  // first annotation of a visit, not by a button nobody presses.
  assert.match(pageViewer, /page-url\?view=/);
  assert.doesNotMatch(pageViewer, /Update cache/);
  assert.match(pageViewer, /annotations\.keepAnnotatedPage\(savedViewRef\.current\)/);
  assert.match(pageViewer, />View live</);
  // The document's own entry is named by the reader, never by the site: a
  // renamed document keeps its name once the frame reports the page title.
  assert.match(pageViewer, /source === "home"\s*\?\s*historyRef\.current\[indexRef\.current\]\.title\s*:\s*pageTitle\(data\.title/);
  assert.doesNotMatch(pageViewer, /View the latest version/);
  assert.match(pageViewer, /View cached/);
  assert.doesNotMatch(pageViewer, /Refresh from source/);
  // A live page the backend could not serve opens the saved copy and says so,
  // as what the reader is looking at rather than as an error;
  // the view is the descriptor's, never guessed from the frame address.
  assert.match(pageViewer, /data\.unavailable === requested/);
  assert.match(pageViewer, /loadEntry\(historyRef\.current\[0\], true, fallback\)/);
  assert.match(pageViewer, /<strong>Saved copy/);
  // And why: a live page that never shows reads as a bug unless it is said.
  assert.match(pageViewer, /only shows its pages on its own website/);
  assert.doesNotMatch(pageViewer, /can’t be shown in the reader/);
  assert.doesNotMatch(pageViewer, /so this is your cached copy/);
  assert.doesNotMatch(pageViewer, /url\.includes\("view=cached"\)/);
});

test("keeps in-app browsing local to the mounted reader", async () => {
  const [workspace, viewer, chat, api, css] = await Promise.all([
    sources(),
    readFile(new URL("../app/components/PageViewer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ChatPanel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/api.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  // Document identity remains the heading and URL-issued workspace route. The
  // live page, history, captures, and scroll positions die with PageViewer.
  assert.match(workspace, /<h1>\{pageTitle\(paper\.title\)\}<\/h1>/);
  assert.match(workspace, /key=\{`\$\{project\.id\}:\$\{paper\.id\}`\}/);
  assert.match(viewer, /const HISTORY_LIMIT = 25/);
  assert.match(viewer, /const CAPTURE_MEMORY_LIMIT = 3 \* 1024 \* 1024/);
  assert.match(viewer, /scrollY: number/);
  assert.doesNotMatch(api, /currentUrl|current_url|viewportUrl.*Paper/);

  // Parent remounts flatten the iframe's session history; browser controls act
  // only on the component's bounded history and the address is not editable.
  assert.match(viewer, /aria-label="Back"/);
  assert.match(viewer, /aria-label="Forward"/);
  assert.match(viewer, /Back to the first page/);
  assert.match(viewer, /aria-label="Reload"/);
  assert.match(viewer, /className="page-address"/);
  assert.match(viewer, />Open in browser</);
  assert.match(viewer, />Save as new document</);
  assert.doesNotMatch(viewer, /Read using Safari\/Chrome|page-save-button|page-companion-button/);
  assert.doesNotMatch(viewer, /<input[^>]+page-address/);
  assert.match(viewer, /method: "POST"/);
  assert.match(viewer, /form\.submit\(\)/);
  assert.match(viewer, /className="document-loading"/);
  assert.match(viewer, /Loading webpage…/);
  assert.match(css, /\.document-loading \{/);
  assert.match(css, /\.page-tooltip::after/);

  // Chat asks the mounted reader only at send time; project mode never sends a
  // temporary viewport, and its copy explains the save boundary.
  // The intent, not the spelling: only a question scoped to the open document
  // may carry the live viewport. Every wider scope reads saved documents, so a
  // temporary page it never saw must not ride along.
  assert.match(chat, /if \(context === "document"\) viewport = await getViewport/);
  assert.match(chat, /getViewport\?\.\(quote\)/);
  assert.match(chat, /Using the page you’re viewing\./);
  assert.match(chat, /uses saved documents—save this page to include it\./);
});

test("no part of the app reaches for a browser extension", async () => {
  const workspace = await sources();

  // Reading a page as the signed-in reader needs code running inside the
  // site's own origin, which only an extension can do. That work is not on
  // this branch, and a half-present companion is worse than none: the reader
  // would be offered a door that opens onto nothing.
  assert.doesNotMatch(workspace, /companion|Companion/);
  assert.doesNotMatch(workspace, /captures\/documents|captures\/normalize/);
});

test("saves redirected reading views without mutating the pinned document", async () => {
  const workspace = await sources();

  assert.match(workspace, /Save page as new document/);
  assert.match(workspace, /projects\.map\(\(item\) =>/);
  assert.match(workspace, /item\.paperCount >= maxPapers/);
  assert.match(workspace, />Save as new document</);
  assert.match(workspace, /if \(!isWebPaper\(created\)\) void startDigest/);
  assert.doesNotMatch(
    workspace,
    /setCurrentUrl|current_url|Set as document/,
  );
});

test("the library rail moves a paper with the Settings sheet's lift, seat and gap", async () => {
  const [workspace, css] = await Promise.all([
    sources(),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(workspace, /beginPaperDrag/);
  assert.match(workspace, /papers\/order/);
  assert.match(workspace, /paper_ids/);
  // As in Settings: a mouse press that travels lifts the row without the hold a finger needs.
  assert.match(workspace, /if \(!gesture\.dragOnMove\) \{[\s\S]{0,200}?\}\s*liftPaper\(gesture\);/);
  // One look for both surfaces: the rail's card, seat and gap share the
  // sheet's rules rather than keeping a second set that drifts.
  assert.match(css, /\.account-paper-row\.dragging,\s*\.paper-row-main\.dragging \{[\s\S]*?rotate\(-1\.5deg\)/);
  assert.match(css, /\.account-paper-seat\.is-lifted,\s*\.paper-row\.is-lifted \{/);
  assert.match(css, /\.account-drop-slot,\s*\.paper-drop-slot \{/);
  // Another project takes the paper; a full one takes nothing.
  assert.match(workspace, /data-rail-move-project=\{item\.id\}/);
  assert.match(workspace, /target\.paperCount < maxPapers/);
  // The rail's old reorder vocabulary is gone.
  assert.doesNotMatch(`${workspace}\n${css}`, /drop-before|drop-after|drag-displaced|paper-shift-y|beginPaperPress/);
});

test("a library paper click returns chat to that paper's bounded context", async () => {
  const components = await sources();

  // The same callback powers both the expanded paper list and its collapsed
  // rail, so a click on either must remove ?chat=project. Keep this tied to the
  // selection boundary instead of the two button renderings.
  assert.match(
    components,
    /const selectPaper = \(nextPaper: Paper\) => \{[\s\S]*?if \(!project\) return;[\s\S]*?openDocument\([\s\S]*?paperId: nextPaper\.id[\s\S]*?false,[\s\S]*?\);/,
  );
  assert.doesNotMatch(
    components,
    /const selectPaper = \(nextPaper: Paper\) => \{[\s\S]*?nextPaper\.id === paper\?\.id/,
  );
});

test("the whole collapsed library rail expands the library", async () => {
  const workspace = await sources();

  assert.doesNotMatch(workspace, /title="Collapse library"/);
  assert.match(
    workspace,
    /className="library-rail"[\s\S]*?onClick=\{onToggleCollapsed\}/,
  );
  assert.match(
    workspace,
    /beginPanelAnimation = useCallback[\s\S]*?clearTimeout\(panelAnimationTimerRef\.current\)[\s\S]*?setTimeout\([\s\S]*?delphi-panel-resize-end[\s\S]*?PANEL_SETTLE_MS/,
  );
  assert.match(workspace, /moveLibrary = useCallback[\s\S]*?beginPanelAnimation\(true\);[\s\S]*?setLibraryCollapsed\(collapsed\)/);
  assert.match(workspace, /if \(!query\.matches\) return;\s*beginPanelAnimation\(\);\s*setLibraryCollapsed\(true\)/);
  assert.match(
    workspace,
    /<button\s+className="rail-toggle"\s+title="Expand library"/,
  );
  assert.match(
    workspace,
    /className=\{`rail-paper[\s\S]*?onClick=\{\(event\) => \{[\s\S]*?event\.stopPropagation\(\);[\s\S]*?onSelectPaper\(item\)/,
  );
});

test("both composer actions arm the chat rail transition before navigating", async () => {
  const workspace = await sources();
  assert.match(workspace, /openChatFromComposer = [\s\S]*?beginChatAnimation\(true\)[\s\S]*?router\.replace/);
  assert.match(workspace, /onSeeHistory=\{[\s\S]*?openChatFromComposer\(context\)/);
  assert.match(workspace, /onSend=\{\(draft: AskDraft\)[\s\S]*?openChatFromComposer\(draft\.context\)/);
  assert.match(workspace, /beginChatAnimation = [\s\S]*?delphi-panel-resize-start[\s\S]*?beginPanelAnimation\(false, true\)/);
  assert.match(workspace, /chatAnimating \? "is-chat-animating"/);
});

test("a new or empty project is filled by the setup, not by an empty reader", async () => {
  const [workspace, dashboard, setup] = await Promise.all([
    sources(),
    readFile(new URL("../app/components/Dashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ProjectSetup.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(
    workspace,
    /const collapseForReading = [\s\S]*?if \(libraryCollapsed \|\| !paper\) return/,
  );
  // Both places a project is made go straight into its setup.
  assert.match(workspace, /router\.push\(`\$\{projectPath\(user\.username, created\)\}\?setup=1`\)/);
  assert.match(dashboard, /router\.push\(`\$\{projectPath\(user\.username, created\)\}\?setup=1`\)/);
  assert.match(workspace, /searchParams\.get\("setup"\) === "1"/);
  assert.match(workspace, /<ProjectSetup/);
  // The reader panel's empty state is a line and the way into setup.
  assert.match(workspace, /<EmptyProject/);
  assert.doesNotMatch(workspace, /Add the first paper|EmptyReader|Read less, learn more/);
  // A link that leads nowhere is told in the same quiet line, not a hero of its own.
  assert.match(workspace, /function MissingDocument[\s\S]*?<ReaderNotice action="Back to your library"/);
  assert.doesNotMatch(workspace, /empty-reader|empty-symbol/);
  // Nothing leaves the setup before the last screen, and filing is asked for
  // once for the whole batch.
  assert.match(setup, /Nothing leaves this component until the last screen/);
  assert.equal(setup.match(/requestMemoryMaintenance\(/g)?.length, 1);
  // Over the project's limit, filing is refused until the list is trimmed.
  assert.match(setup, /disabled=\{!items\.length \|\| over > 0\}/);
  // PDFs only, several at once, by picker or by drop.
  assert.match(setup, /accept="application\/pdf,\.pdf"\s+multiple/);
  assert.match(setup, /if \(!isPdfFile\(file\)\) \{ notes\.push/);
});

test("empty chat offers two focused questions without explanatory copy", async () => {
  const chat = await readFile(
    new URL("../app/components/ChatPanel.tsx", import.meta.url),
    "utf8",
  );

  // Project: one about the document, one only the project behind it can answer.
  assert.match(chat, /Give me the TL;DR of this document\./);
  assert.match(chat, /How does this document relate to the others in this project\?/);
  // Memory, beside a document: what is new, and what is already there.
  assert.match(chat, /Given what I’ve already read, what is new in “\$\{paper\.title\}”\?/);
  assert.match(chat, /Are there some related work to “\$\{paper\.title\}” already in my Memory\?/);
  // The project-wide openers went with the project-wide thread.
  assert.doesNotMatch(chat, /acrossProject|Give me a concise reading order/);
  assert.doesNotMatch(chat, /Delphi answers with citations/);
});

test("keeps PDF and chat state keyed to paper identity after reordering", async () => {
  const [workspace, pdfViewer] = await Promise.all([
    sources(),
    readFile(new URL("../app/components/PdfViewer.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(workspace, /key=\{`\$\{project\.id\}:\$\{paper\.id\}`\}/);
  // A conversation is identified by its scope, and a document conversation by
  // the document — so reordering the library cannot carry one paper's thread
  // onto another. The key is built from `scopeKey`, which is unit-tested to
  // give every scope a distinct string.
  assert.match(workspace, /key=\{[\s\S]{0,400}scopeKey\(/);
  assert.match(workspace, /paperId: paper\?\.id/);
  assert.match(workspace, /streamAbortRef\.current\?\.abort\(\)/);
  // A thread load applies only while its own scope is still mounted, and
  // *prepends* rather than assigns: a seeded question can beat the history
  // home, and assigning would throw away the turn already streaming.
  assert.match(workspace, /if \(active\) setMessages\(\(current\) => \[\.\.\.result\.messages, \.\.\.current\]\)/);
  assert.match(workspace, /if \(active\) \{\s*setHighlights\(current =>/);
  assert.match(pdfViewer, /\[fileUrl, paperId, pdfjs, projectId\]/);
});

test("late project work cannot replace or redirect the project being viewed", async () => {
  const [workspace, css] = await Promise.all([
    sources(),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  // Refreshing after an upload or page fetch reads the live route when it
  // starts and checks it again before touching the one-slot detail cache.
  assert.match(workspace, /const readerLocationRef = useRef/);
  assert.match(workspace, /const wanted = readerLocationRef\.current\.projectId/);
  assert.match(
    workspace,
    /if \(readerLocationRef\.current\.projectId === wanted\)/,
  );

  // The startup project is not a permanent cache entry, and completing a page
  // fetch cannot pull someone back after they navigated elsewhere.
  assert.match(workspace, /resolution\?\.key === routeKey/);
  assert.match(workspace, /if \(!live \|\| pathname !== wantedKey\) return/);
  assert.match(
    workspace,
    /if \(readerLocationRef\.current\.path !== startedAt\) return/,
  );

  // While a legitimate route fetch catches up, show progress—not the
  // create-your-first-project state that made intact papers look deleted.
  assert.match(workspace, /routeKey && !project/);
  assert.match(workspace, /<ProjectLoading \/>/);
  assert.match(css, /\.reader-loading/);
});

test("supports keyboard-accessible same-project paper mentions", async () => {
  const [workspace, api, css] = await Promise.all([
    sources(),
    readFile(new URL("../app/lib/api.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(workspace, /paperMentionAt/);
  assert.match(workspace, /isResolvedPaperMention/);
  // The editor binds `contentEditable` to a flag and the panel passes the
  // scope's readiness into it — asserted as two facts rather than as one
  // spelling, because the editor is now shared with the floating composer,
  // which gates on nothing.
  assert.match(workspace, /contentEditable=\{!disabled\}/);
  assert.match(workspace, /disabled=\{!composerEnabled\}/);
  assert.match(workspace, /mark\.contentEditable = "false"/);
  assert.match(workspace, /paintComposerDraft/);
  assert.match(workspace, /if \(!text\) \{\s*node\.replaceChildren\(\);/);
  assert.match(workspace, /handleComposerPaste/);
  assert.match(workspace, /getData\("text\/plain"\)/);
  assert.match(workspace, /execCommand\("insertText", false, text\)/);
  assert.match(workspace, /suppressContentEditableWarning/);
  assert.match(workspace, /inline-paper-mention/);
  // A row is its title and a web/PDF mark; the ordinal was a second thing
  // to read before the one that decides the pick.
  assert.doesNotMatch(workspace, /mention-number|paperNumber/);
  assert.match(workspace, /<KindMark kind=\{paperMark\(item\)\} labelled \/>/);
  assert.doesNotMatch(workspace, /className="composer-references"/);
  assert.doesNotMatch(workspace, /removeReference/);
  assert.match(workspace, /role="listbox"/);
  assert.match(workspace, /aria-autocomplete="list"/);
  assert.match(workspace, /event\.key === "ArrowDown"/);
  assert.match(workspace, /event\.key === "ArrowUp"/);
  assert.match(workspace, /composerCursorOffset/);
  assert.match(workspace, /setComposerCursor/);
  assert.match(workspace, /paperMentionToken/);
  assert.match(workspace, /expandPaperMentionTokens\(\s*forcedPrompt \?\? draft,/);
  assert.match(workspace, /const spacer = \/\^\\s\/\.test\(trailingText\) \? "" : " "/);
  assert.match(workspace, /Number\(trailingText\.startsWith\(" "\)\)/);
  assert.match(workspace, /pendingComposerCursorRef\.current = nextCursor/);
  // The mentions the reader picked reach the request. Scope-gated, because the
  // account-wide conversation has no project to resolve a reference against and
  // the server refuses one there.
  assert.match(workspace, /referenced_paper_ids: isGeneral \? \[\] : activeReferenceIds/);
  assert.match(api, /referencedPapers\?: Array/);
  assert.match(css, /\.mention-menu/);
  assert.doesNotMatch(css, /\.composer-draft-preview/);
  assert.match(css, /\.composer-input/);
  assert.match(css, /\.inline-paper-mention/);
  assert.match(
    css,
    /\.inline-paper-mention\s*\{[\s\S]*padding:\s*2px 0\.28em;[\s\S]*font-size:\s*11\.5px;[\s\S]*font-weight:\s*625;/,
  );
  assert.doesNotMatch(css, /\.inline-paper-mention\s*\{[^}]*box-shadow:/);
  assert.doesNotMatch(css, /\.inline-paper-mention\s*\{[^}]*margin-inline:/);
});

/*
 * The `@` menu is one implementation, mounted by both surfaces, and what it may
 * reach is a fact about the scope rather than about the surface. Both halves
 * broke once: the floating composer shipped as a bare `<textarea>` and silently
 * had no mentions at all, and the docked one offered the project's documents
 * inside the account-wide conversation, where a reference cannot resolve.
 */
test("scopes @-mentions to the question, in both places one is written", async () => {
  const [composer, panel, field, css] = await Promise.all([
    readFile(new URL("../app/components/chat/AskComposer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ChatPanel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/chat/MentionField.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  // One editor, two mounts. A textarea here is the regression.
  assert.match(composer, /<MentionField/);
  assert.doesNotMatch(composer, /<textarea/);
  assert.match(panel, /<MentionField/);
  assert.doesNotMatch(panel, /<textarea/);

  // General reaches no documents, in either surface; images stay reachable in
  // every scope, which is why the menu is still offered there.
  assert.match(composer, /context === "general"\s*\?\s*\[\]/);
  assert.match(composer, /context === "general"\s*\?\s*\["images"\]/);
  assert.match(panel, /isGeneral\s*\?\s*\[\]/);
  assert.match(panel, /isGeneral\s*\?\s*\["images"\]/);
  // A chooser with one option is a label pretending to be a control.
  assert.match(field, /tabs\.length > 1/);

  // A document named in the floating composer reaches the request it seeds;
  // without this the mention would look like it worked and attach nothing.
  assert.match(
    composer,
    /referencedPaperIds:\s*\n?\s*context === "general" \? \[\] : referencedPapers\.map/,
  );
  assert.match(panel, /seedReferencesRef\.current = seedReferencedPaperIds/);

  // The card is the menu's containing block, or it anchors to the viewport.
  assert.match(css, /\.kb-composer-card\s*\{[\s\S]*?position: relative/);
  // The openers are one bordered list at the lower left, in every context;
  // the centred heading-and-paragraph empty state is gone.
  assert.match(css, /\.suggestions\s*\{[^}]*width: 100%;[^}]*max-width: 520px/);
  assert.match(css, /\.chat-empty\s*\{[^}]*justify-content: flex-end;[^}]*align-items: flex-start/);
  assert.doesNotMatch(css + panel, /chat-empty-suggestions|Ask your Memory\./);
});

test("keeps temporary chat images thread-scoped and explicitly reusable", async () => {
  const [workspace, api, css] = await Promise.all([
    sources(),
    readFile(new URL("../app/lib/api.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(workspace, /image\/png,image\/jpeg,image\/webp/);
  assert.match(workspace, /handleComposerPaste/);
  assert.match(workspace, /onPaste=/);
  // Drop handlers live on the file-drop hooks, not as a JSX `onDrop=` on
  // each field — pinning the attribute is what went stale the moment the
  // two surfaces started sharing one claim.
  assert.match(workspace, /useImageDrop/);
  assert.match(workspace, /useCoveringFileDrop/);
  assert.match(workspace, /@\[Image #\$\{image\.number\}\]/);
  assert.match(workspace, /referenced_image_ids: activeImageIds/);
  // The images live behind their own tab in the same menu the documents use.
  assert.match(workspace, /"Documents" : "Images"/);
  assert.match(workspace, /event\.key === "ArrowLeft"/);
  assert.match(workspace, /Image expired/);
  assert.match(api, /referencedImages\?: Array/);
  assert.match(api, /chatImageMaxPerQuestion/);
  assert.match(css, /\.composer-images/);
  assert.match(css, /\.message-image-expired/);
});

/*
 * File-drop ownership is nested: a covering surface claims every file drag
 * while it is up, so the window-level paper overlay cannot paint over a
 * question still being written. The docked composer claims images only, so a
 * PDF over the rail still reaches the library.
 */
test("keeps an image dropped on the composer away from the paper uploader", async () => {
  const [workspace, css] = await Promise.all([
    sources(),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(workspace, /carriesPdf/);
  assert.match(workspace, /export function useImageDrop/);
  assert.match(workspace, /export function useCoveringFileDrop/);
  assert.match(workspace, /event\.stopPropagation\(\)/);
  assert.match(workspace, /imageDrop\.active \? " image-drop"/);
  assert.match(workspace, /\{\.\.\.imageDrop\.handlers\}/);
  // The floating composer claims from the backdrop, not the card: a PDF over
  // the dimmed page has to be swallowed too, or the overlay still appears.
  assert.match(workspace, /\{\.\.\.coveringDrop\.handlers\}/);
  assert.match(workspace, /kb-composer-card\$\{coveringDrop\.active/);
  assert.match(workspace, /imageDropHint/);
  assert.match(css, /\.composer\.image-drop/);
  assert.match(css, /\.kb-composer-card\.image-drop/);
  assert.match(workspace, /Delphi reads PDFs or webpages/);
});

test("the floating composer stages images until send so a context switch keeps them", async () => {
  const composer = await readFile(
    new URL("../app/components/chat/AskComposer.tsx", import.meta.url),
    "utf8",
  );
  // Local object URLs, not a thread-scoped upload: the context pill is still
  // a decision about the question, not a change of conversation.
  assert.match(composer, /createObjectURL/);
  assert.doesNotMatch(composer, /attached\.context === context/);
  // Same remove control as the docked strip, so a dropped thumbnail can leave.
  assert.match(composer, /aria-label="Remove this image"/);
  assert.match(composer, /className="composer-image"/);
  assert.match(composer, /revokeObjectURL/);
  // The upload names the context chosen at send, not the one at drop.
  assert.match(
    composer,
    /const target = targetFor\(context\);[\s\S]*conversationQuery\(target, destination\)/,
  );
});

test("staged images belong to their conversation, not to the mounted panel", async () => {
  const [panel, css] = await Promise.all([
    readFile(new URL("../app/components/ChatPanel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  // Held in the conversation's session, so switching tabs or scopes keeps each
  // chat's attachments with its own draft rather than carrying them across.
  assert.match(panel, /useConversationField<ComposerImage\[\]>\(session, "composerImages"/);
  assert.doesNotMatch(panel, /chat-image-stage/);
  assert.doesNotMatch(panel, /composer-image-number/);
  assert.match(css, /\.composer:focus-within[\s\S]*?0 0 0 2px/);
});

test("offers reasoning efforts and takes the default from config", async () => {
  const workspace = await sources();

  // No local hardcoded default: the pill falls back to whatever /api/config
  // published, the same way the model picker already does.
  assert.match(workspace, /config\.defaultReasoningEffort/);
  assert.match(workspace, /chatEffort\(forModel, chosen, config\.modelReasoningEfforts, config\.defaultReasoningEffort\)/);
  assert.match(workspace, /const effort = resolveEffort\(model, chosenEffort\);/);
  for (const level of ["xhigh", "high", "medium", "low"]) {
    assert.match(workspace, new RegExp(`${level}:`));
  }
  // The pill's effort, unless the Ask composer seeded this one question.
  assert.match(workspace, /reasoning_effort: requestEffort/);
  assert.match(workspace, /const requestEffort = seed\?\.choice \? resolveEffort\(requestModel, seed\.choice\.effort\) : effort;/);
});

test("the Ask composer's mode, model and effort answer the question it sent", async () => {
  const components = await sources();
  // The composer sends every pill with the question, like the persona. The
  // docked chat used to answer with its own model, effort and web search.
  assert.match(components, /choice: \{ mode, model, effort \},/);
  // Both surfaces that take an Ask composer's question hand the choice on.
  assert.match(components, /setAskChoice\(draft\.choice\);/);
  assert.match(components, /openAsk\(\{ question: prompt, imageIds, personaId, choice, conversation, requestId \}\)/);
  assert.equal((components.match(/seedChoice=\{askChoice\}/g) ?? []).length, 2);
  // Memory docks the answer where it was asked, so nothing is
  // held across a route change any more.
  assert.match(components, /setAskChoice\(choice\);/);
  // A surface mounted for the question starts on the composer's pills; one
  // already mounted moves them. The send gets the choice directly, because the
  // pill state set beside it lands after the request is built.
  assert.match(components, /useConversationField<ChatMode>\(session, "chatMode", seedChoice\?\.mode \?\? ChatMode\.Chat\)/);
  assert.match(components, /setChatMode\(seedChoice\.mode\);\s*setChosenModel\(seedChoice\.model\);\s*setChosenEffort\(seedChoice\.effort\);/);
  assert.match(components, /void send\(seedQuestion, undefined, \{\s*choice: seedChoice,/);
  // The seed's persona first; otherwise only one picked here, never an id loaded (inv. 26).
  assert.match(components, /persona_id: seed\?\.personaId \?\? \(personaChosenRef\.current \? personaId : null\) \?\? undefined,/);
  assert.match(components, /model: requestModel,/);
  // Web search is not a choice a reader makes: the model decides when to
  // search, so no surface holds a switch for it and no request names one. The
  // server refuses a request that still does.
  assert.doesNotMatch(components, /webSearch|WebSearchToggle|web_search: request/);
  // The seeded turn shows the images the composer attached to it.
  assert.match(components, /const messageImages = seeded\s*\? images\.filter\(\(image\) => seeded\.includes\(image\.id\)\)/);
});

test("model picker reveals effort only after a model click", async () => {
  const [picker, css] = await Promise.all([
    readFile(new URL("../app/components/ChatBits.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(picker, /model-picker-submenu/);
  assert.match(picker, /effectiveModelEfforts\[pendingModel/);
  // Exactly the connection's own list: an API key and a ChatGPT plan publish different models.
  assert.match(picker, /const selectableModels = models;/);
  assert.doesNotMatch(picker, /onPointerEnter=\{\(\) => setPreviewModel/);
  assert.match(picker, /onModelChange\(pendingModel\.value\)/);
  assert.match(picker, /onEffortChange\(option\.value\)/);
  // One window, two panes: choosing a model slides the effort list in where
  // the models were, so there is no side to choose between. The effort list
  // used to fly out sideways, and in a docked chat card it landed outside
  // `.kb-ask-modal`'s `overflow: hidden` and vanished.
  assert.doesNotMatch(await sources(), /effortMenuSide|effort-menu-/);
  assert.match(picker, /data-view=\{onEfforts \? "efforts" : "models"\}/);
  // Both panes stay mounted so they can cross; the hidden one leaves the tab order.
  assert.match(picker, /inert=\{onEfforts\}/);
  assert.match(picker, /inert=\{!onEfforts\}/);
  // The window's height change is a transform on its surface, never an
  // animated height, per the repo's transform-and-opacity rule.
  assert.match(picker, /scaleY\(\$\{previous \/ next\}\)/);
  assert.match(css, /\.model-picker-surface \{[^}]*transform-origin: 50% 100%/);
  assert.match(css, /\[data-view="efforts"\] \.model-picker-models \{[^}]*transform: translateX\(-/);
  assert.doesNotMatch(css, /\.model-picker[^{]*\{[^}]*transition:[^};]*\bheight\b/);
  assert.match(css, /0 22px 48px/);
});

test("wires durable digest preparation, progress, retry, and cancellation", async () => {
  const [workspace, api, css] = await Promise.all([
    sources(),
    readFile(new URL("../app/lib/api.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(workspace, /papers\/\$\{paperId\}\/digest\/stream/);
  // The destination is explicit because the first document can be uploaded
  // before the newly created project becomes the active route.
  assert.match(workspace, /void startDigest\(destination\.id, result\.id\)/);
  assert.match(workspace, /void startDigest\(projectId, kept\.id\)/);
  assert.match(workspace, /void startDigest\(destinationProjectId, created\.id\)/);
  assert.doesNotMatch(workspace, /Math\.round\((?:paper|item)\.tokens/);
  // The paper row menu's order: the archive toggle first, Remove last — a
  // swapped position should fail this, not the wording.
  assert.match(
    workspace,
    /isDone\(item\) \? "Active" : "Done"[\s\S]*Rename[\s\S]*Move project[\s\S]*Remove document/,
  );
  // The digest is the reader's Digest view now, not a library menu item over a modal.
  assert.doesNotMatch(workspace, /Show digest|DigestModal/);
  assert.match(workspace, /role="group" aria-label="Show"/);
  assert.match(workspace, /<DigestPane/);
  assert.match(workspace, /createPortal\([\s\S]*className=\{`paper-actions-menu/);
  assert.match(css, /\.paper-actions-menu\s*\{[\s\S]*position: fixed/);
  assert.match(workspace, /\/papers\/\$\{paper\.id\}\/digest/);
  assert.match(workspace, /<ResearchDigestView[\s\S]*digest=\{digest\}/);
  assert.match(workspace, /remarkDigestMarkdown/);
  // Full-document Markdown and grouped evidence are exercised in the digest browser suite.
  assert.match(workspace, /<DigestAssetVisual/);
  assert.match(workspace, /afterEvidenceId/);
  assert.match(workspace, /aria-label="Regenerate digest"/);
  assert.match(workspace, /regenerating \? "Regenerating…" : "Regenerate"/);
  assert.match(workspace, /Uses model tokens once\./);
  assert.doesNotMatch(workspace, /Named prior work|Open questions & evidence gaps/);
  assert.match(workspace, /payload\.type === "progress"/);
  // Stage reports are not text in the chat's waiting line: it keeps cycling
  // its phrases, and a capacity wait only sets the line's tooltip.
  assert.doesNotMatch(workspace, /Preparing project context/);
  assert.match(workspace, /isCapacityWait\(String\(payload\.message/);
  // A reader kept waiting on Flex capacity has somewhere to go about it. The
  // wording used to be pinned as "Use Standard tier instead of Flex", which
  // was the checkbox's phrasing of a choice between two named tiers; it is a
  // Standard | Flex pill now, and the durable fact is that both tiers are
  // named on a control that writes the preference. It sits under the OpenAI
  // key now, the only connection billed by tier.
  assert.match(workspace, /use_standard_tier: useStandardTier/);
  assert.match(workspace, /const TIER_LABEL = \{ standard: "Standard", flex: "Flex" \}/);
  assert.match(
    workspace,
    /label: TIER_LABEL\.standard[\s\S]{0,120}?label: TIER_LABEL\.flex/,
  );
  assert.doesNotMatch(workspace, /Your library is stored in/);
  // One context control, shared by the docked header and the floating
  // composer: the scope menu, rolling down from the chat's tab strip and up
  // from the composer low in the window. The three-way toggle took a third of
  // the composer's header to say what one pill says.
  assert.match(workspace, /<ConversationScopeMenu\s+direction="up"/);
  assert.doesNotMatch(workspace, /<ContextPill|className="chat-scope-toggle"/);
  assert.match(workspace, /role="menuitemradio" aria-checked=\{option === context\}/);
  assert.doesNotMatch(workspace, /className="chat-scope-menu"/);
  assert.match(workspace, /tab === "papers" \? "Documents" : "Images"/);
  assert.match(workspace, />\s*Documents\s*<\/button>[\s\S]*?>\s*Projects\s*<\/button>/);
  assert.doesNotMatch(workspace, /className="segmented chat-scope-switch"/);
  // The context leads the docked header and Expand and Hide close it, past the tabs.
  assert.match(
    workspace,
    /className="conversation-header"[\s\S]{0,300}?<ConversationScopeMenu[\s\S]{0,400}?<ConversationWindowControls/,
  );
  // The chat owns its own rail wrapper, and no shell spells the class itself.
  // Full screen is a fixed backdrop over the viewport, so the two ways out of
  // it — a click on the backdrop, Escape — have to be handled by whoever holds
  // `fullscreen`. Hoisting the wrapper into the shells silently dropped both.
  assert.match(workspace, /className=\{`kb-chat-rail landed\$\{fullscreen \? " is-fullscreen"/);
  assert.match(
    workspace,
    /fullscreen && event\.target === event\.currentTarget\) leaveFullscreen\(\)/,
  );
  assert.match(workspace, /if \(event\.key === "Escape" && !event\.defaultPrevented\) leaveFullscreen\(\)/);
  // Closing plays before the address changes. `?chat=` is the only record of
  // what is open (invariant 21), so unmounting on the navigation would make the
  // panel vanish on one frame instead of leaving.
  assert.match(workspace, /setChatClosing\(true\)[\s\S]{0,1200}?CHAT_EXIT_MS/);
  assert.match(workspace, /hideGraph=\{chatOpen && !askOpen && !chatClosing/);
  // Two remembered widths, because the column holds two different things. A
  // drag in one state must not silently move the other, and both are clamped
  // when the window shrinks — the one off screen is what the column jumps to
  // next time.
  assert.match(workspace, /setChatColumnWidth\(clamp\)[\s\S]{0,80}?setRailColumnWidth\(\(width\) =>/);
  assert.match(workspace, /!chatDocked \? railColumnWidth : sideColumn \? sideColumnWidth\(/);
  // The rail measures with a callback ref, not a mount effect. The graph is
  // unmounted while a chat is docked, so on the rail's own mount there is no
  // node to observe and an effect with `[]` deps never runs again to notice one
  // arriving — which left the map frozen at its `{0, 0}` fallback.
  assert.match(workspace, /const ref = useCallback\(\(node: HTMLDivElement \| null\)/);
  assert.doesNotMatch(workspace, /const \[graphRef, box\] = useMeasuredBox\(\)[\s\S]{0,200}?ref\.current/);
  // Reader replies always open a fresh composer carrying the passage.
  assert.match(workspace, /const reply = \(text: string\) => \{[\s\S]*?if \(chatDocked\) \{\s*window\.dispatchEvent\(new CustomEvent\("delphi-reply"[\s\S]*?return;\s*\}\s*setAskInitialContext\("document"\);\s*setAskQuote\(text\);\s*setAskOpen\(true\)/);
  assert.match(workspace, /onReply=\{reply\}/);
  assert.match(workspace, /seedSelectedText=\{seedQuote\}/);
  assert.match(workspace, /selectedText: quoted/);
  // Only General where there is no project to narrow to — the wiki mounts with
  // none, and a Document chip there could never resolve to anything.
  assert.match(workspace, /inReader: Boolean\(projectId\)/);
  // The exit plays once. The navigation that ends it is asynchronous, so
  // clearing the closing flag in the same tick re-docked the panel for a frame
  // and played the whole animation a second time when the address landed. It
  // is cleared where a chat *opens* instead — the only moment it can be wrong.
  assert.match(workspace, /if \(open\) setChatClosing\(false\)/);
  assert.doesNotMatch(
    workspace,
    /chatCloseTimer\.current = null;\s*setChatClosing\(false\)/,
  );
  // Every tab's cross closes its tab without deleting the chat; Hide chat closes the window.
  assert.match(workspace, /className="conversation-tab-close" aria-label=\{`Close \$\{item.title\}`\}[^>]*onClick=\{\(\) => closeTab\(item\)\}/);
  assert.match(workspace, /className="conversation-tab-close"/);
  assert.doesNotMatch(workspace, /aria-label="Chat actions"/);
  assert.doesNotMatch(workspace, /className="chat-actions-menu"/);
  assert.doesNotMatch(workspace, /className="chat-context-label"/);
  assert.match(css, /\.messages\s*\{[\s\S]*mask-image: linear-gradient\(to bottom, transparent, #000 24px\)/);
  // One wording for all three scopes. The prompt used to name the scope, which
  // put the same fact a few pixels below the Context pill that both states it
  // and changes it — and rewrote itself mid-decision every time the pill moved.
  assert.match(workspace, /COMPOSER_PLACEHOLDER = "Ask Delphi anything \(press ⇧ ⇥ to toggle Plan mode\)"/);
  // Matched as a returned string, not as prose: the comment above the function
  // quotes the wordings it replaced, which is the record of why.
  assert.doesNotMatch(workspace, /return "Ask across this project/);
  assert.match(workspace, /streamAbortRef\.current\?\.abort\(\)/);
  assert.match(workspace, /\/chat\/cancel/);
  assert.match(workspace, /request_id: requestId\.replaceAll/);
  assert.match(workspace, /Request cancelled\./);
  // One control, two states: the square must not keep the accent that says
  // "send", or the stop click looks like a second question.
  assert.match(workspace, /streaming \? "stopping" : ""/);
  assert.match(css, /\.send-button\.stopping\s*\{[\s\S]*?background: var\(--muted\)/);
  assert.match(api, /status: "pending" \| "ready" \| "failed" \| "missing"/);
  assert.match(api, /contentMarkdown: string/);
  assert.match(api, /citations: DigestCitation\[\]/);
  assert.match(api, /error\?: boolean/);
  assert.match(api, /cancelled\?: boolean/);
  assert.doesNotMatch(workspace, /<DigestStatusIcon/);
  assert.match(css, /\.paper-actions-menu/);
  // The digest crossfades in the reader's page box, and the toggle's knob slides:
  // opacity and transform only, and nothing left of the modal it replaced.
  assert.doesNotMatch(css, /\.digest-modal|--digest-start-scale-x|\.digest-regenerate|\.digest-empty-state/);
  assert.match(css, /\.reader-digest\.is-shown \{[^}]*transition: opacity 180ms/);
  assert.match(css, /\.reader-view-knob \{[^}]*transition: transform 220ms/);
  assert.match(css, /\.digest-footer \{/);
  assert.match(css, /\.message\.assistant\.error/);
  assert.match(css, /\.message\.assistant\.cancelled/);
});

test("the latest user message can be edited and resent in place", async () => {
  const [workspace, css] = await Promise.all([
    sources(),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  // Only the most recent user turn grows a pencil, and only on hover — earlier
  // questions are history, not a second composer.
  assert.match(workspace, /index === lastUserIndex/);
  assert.match(workspace, /aria-label="Edit message"/);
  assert.match(workspace, /className="message-edit"/);
  assert.doesNotMatch(workspace, /aria-label="Copy message"/);
  assert.match(css, /\.message-edit\s*\{[\s\S]*?right: 100%/);
  assert.match(css, /\.message-edit\s*\{[\s\S]*?bottom: 8px/);
  assert.match(
    css,
    /\.message\.user\.is-latest:hover \.message-edit/,
  );
  // A gutter inside the bubble reads as trailing space on a wrapped last
  // line, the same leftover earlier questions already show. The pencil
  // sits to the left of the bubble instead.
  assert.doesNotMatch(
    css,
    /\.message\.user\.is-latest \.message-bubble \{[^}]*padding-(right|bottom):/,
  );
  // Cancel is an x beside the composer's send arrow. The in-place editor is
  // that same composer card — mentions, model, persona, attach, web search —
  // and never grows a Context pill: the turn already has a scope.
  assert.match(workspace, /aria-label="Cancel edit"/);
  assert.match(workspace, /composerCard\("edit"\)/);
  assert.match(workspace, /composer-edit/);
  assert.match(workspace, /initialDraft=\{draft\}/);
  assert.doesNotMatch(workspace, /className="message-edit-send"/);
  assert.match(workspace, /replace_request_id:/);
  // The stale answer leaves the transcript before the edited prompt is
  // appended, rather than stacking a second reply under a question it no
  // longer answers.
  assert.match(workspace, /replaceFrom/);
  const panel = await readFile(
    new URL("../app/components/ChatPanel.tsx", import.meta.url),
    "utf8",
  );
  assert.equal(panel.split("<ConversationScopeMenu").length - 1, 1);
  // Edit sits in the transcript, often under the header: menus that opened
  // upward were clipped by `.messages`, so they drop into the turn below.
  assert.match(css, /\.composer-edit \.mention-menu\s*\{[\s\S]*?top:/);
  assert.match(css, /\.composer-edit \.model-picker\s*\{[\s\S]*?top:/);
  assert.match(css, /\.composer-edit \.persona-picker-menu\s*\{[\s\S]*?top:/);
  assert.match(css, /\.messages\.is-editing-message/);
  assert.match(css, /\.message\.user\.is-editing\s*\{[\s\S]*?scroll-margin-top: 22px/);
  assert.match(css, /\.message\.user\.is-editing \.composer\s*\{[\s\S]*?margin: 4px 10px 12px/);
  assert.match(panel, /is-editing-message/);
  // The header is a sibling of the transcript, not part of it. Parking the
  // editor with scrollIntoView also scrolled `.kb-ask-modal` and took the
  // scope pill with it; only `.messages` may move.
  assert.doesNotMatch(panel, /scrollIntoView/);
  assert.match(panel, /scroller\.scrollTo/);
});

test("docked chat chrome is one token set on both shells", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  // User bubbles, assistant answers, and cancelled all read the window's
  // token. Spelling 14px on the bubble and 13px on the answer is how the
  // Reader's questions looked a size larger than Delphi's replies.
  assert.match(css, /--chat-message-size:\s*13px/);
  assert.match(
    css,
    /\.message > div:not\(\.composer\) \{[\s\S]*?font-size:\s*var\(--chat-message-size\)/,
  );
  // An answer's size is the reading type's, in the docked window and the ask
  // modal alike; neither sets its own.
  assert.doesNotMatch(css, /\.kb-ask-modal \.message\.assistant \.message-markdown \{[^}]*font-size/);
  assert.doesNotMatch(css, /\.kb-ask-modal \{[^}]*--chat-message-size:/);
  assert.doesNotMatch(css, /\.reader-rail \.kb-ask-modal \{[^}]*--chat-message-size:/);

  // Radius and rail inset are the same chase: one radius token for the docked
  // card on both shells (its value is a design choice, not the contract), and
  // a shared `--panel-inset-top` on the Reader.
  assert.match(css, /--chat-card-radius:\s*\d+px/);
  assert.match(css, /--chat-rail-gap:\s*10px/);
  // The top inset is named on its own because the sticky Related Memory
  // header has to paint exactly that strip: a sticky offset is measured from
  // the scrollport — the rail's padding box — so `top: 0` parks the header
  // below the rail's real top edge, and scrolled text was painted in the gap.
  assert.match(css, /--panel-inset-top:\s*8px/);
  assert.match(css, /--chat-rail-padding-top:\s*var\(--panel-inset-top\)/);
  assert.match(css, /--chat-rail-padding:\s*var\(--chat-rail-padding-top\) 6px 14px/);
  assert.match(css, /\.library-panel \{[\s\S]*?padding:\s*var\(--panel-inset-top\) 12px 0/);
  assert.match(css, /\.library-rail \{[\s\S]*?top:\s*var\(--panel-inset-top\)/);
  assert.match(css, /\.reader-panel \{[\s\S]*?margin-top:\s*var\(--panel-inset-top\)/);
  assert.match(
    css,
    /\.kb-related-pin::before \{[\s\S]*?height:\s*var\(--chat-rail-padding-top\)/,
  );
  assert.match(
    css,
    /\.reader-rail,\s*\.kb-related-rail \{[\s\S]*?gap:\s*var\(--chat-rail-gap\)/,
  );
  assert.match(
    css,
    /\.reader-rail,\s*\.kb-related-rail \{[\s\S]*?padding:\s*var\(--chat-rail-padding\)/,
  );
  assert.match(
    css,
    /\.kb-chat-rail \.kb-ask-modal \{[\s\S]*?border-radius:\s*var\(--chat-card-radius\)/,
  );
  assert.doesNotMatch(
    css,
    /\.reader-rail \.kb-chat-rail \.kb-ask-modal \{[^}]*border-radius:/,
  );
});

test("archives a paper out of the working set without hiding it", async () => {
  const [components, api] = await Promise.all([sources(), readFile(
    new URL("../app/lib/api.ts", import.meta.url),
    "utf8",
  )]);

  // One shared predicate everything else reads doneAt through.
  assert.match(api, /export const isDone = \(paper: Paper \| null \| undefined\) =>/);
  // The @mention list excludes a done paper — an archived paper is still
  // readable, just not part of the active thread.
  assert.match(components, /\.filter\(\(item\) => !isDone\(item\)\)/);
  // A done paper stays in the rail, after the ones still being read, below
  // one divider: finishing a document does not put it away.
  assert.match(components, /\.\.\.allOrderedPapers\.filter\(\(item\) => isDone\(item\)\),/);
  assert.match(components, /isDone\(item\) && index === activePapers\.length \? \(\s*<div className="paper-list-divider"/);
});

test("reaches the palette through semantic roles, never a raw hex", async () => {
  const [css, projectColor] = await Promise.all([
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/project-color.ts", import.meta.url), "utf8"),
  ]);

  const SOURCE = {
    "--clay": "#5a2620",
    "--dawn": "#ee9d66",
    "--moss": "#3e7bc9",
    "--sand-cream": "#f4f1ef",
    "--umber": "#241412",
  };
  for (const [token, hex] of Object.entries(SOURCE)) {
    assert.match(css, new RegExp(`${token}:\\s*${hex}`, "i"));
  }
  // Project hues are the same values the stylesheet names, so a project's
  // tile and its label tint can never drift apart.
  const PROJECT = {
    "--coral": "#c94e3a",
    "--saffron": "#e0a020",
    "--cloud": "#3e7bc9",
    "--orchid": "#8e4a9c",
    "--clay": "#5a2620",
  };
  for (const [token, hex] of Object.entries(PROJECT)) {
    assert.match(css, new RegExp(`${token}:\\s*${hex}`, "i"));
    assert.match(projectColor, new RegExp(hex, "i"));
  }


  assert.match(css, /--ink:\s*var\(--[a-z-]+\)/);
  assert.match(css, /--action:\s*var\(--[a-z-]+\)/);
  assert.match(css, /--accent:\s*var\(--[a-z-]+\)/);

  assert.match(css, /\.paper-row\.done\s*\{[\s\S]*?var\(--moss\)/);
  assert.match(css, /\.account-paper-done\s*\{[^}]*color:\s*var\(--moss-dark\)/);

  const RETIRED =
    /#dad7cd|#a3b18a|#527a52|#3a5a40|#344e41|#79a95b|#ffd6ff|#e7c6ff|#c8b6ff|#b8c0ff|#bbd0ff|#6d53b8|#42539c|#c67139|#728157|#5a6644|#e3e6d9/i;
  assert.doesNotMatch(css, RETIRED);
});

test("a route still resolving loads rather than reporting an empty library", async () => {
  const [components, css] = await Promise.all([
    sources(),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  // Deployed, resolving a project is a round trip, and for that second the
  // panels have no project for exactly the same reason a brand new account has
  // none. Every empty state has to be gated on knowing which of those it is.
  assert.match(components, /const resolving =/);
  assert.match(components, /<ProjectLoading \/>/);
  // The same mark the boot screen uses, so a slow route reads as one thing
  // loading rather than as an error the reader has to interpret. Said once:
  // the library rail used to run its own copy beside this one, so a reader
  // waiting on one route watched two marks in two panels.
  assert.match(
    components,
    /className="reader-loading" role="status">\s*<PagesMark \/>/,
  );
  assert.doesNotMatch(components, /library-loading/);
  assert.doesNotMatch(css, /\.library-loading/);
});

test("a persona is never pinned open by something that is using it", async () => {
  const components = await sources();

  // This used to warn which *projects* an edit would reach and refuse a delete
  // while any of them pointed at the persona. A persona belongs to a
  // conversation now and is resolved per turn, so a deleted one simply falls
  // back to the default — and counting conversations the way projects were
  // counted would make a persona used for a month undeletable.
  assert.doesNotMatch(components, /PersonaUsageDialog/);
  assert.doesNotMatch(components, /persona\?\.projects/);
  assert.doesNotMatch(components, /error\.detail\?\.projects/);
  // What has to stay true: editing still reaches everything using it, because
  // a persona is referenced and never copied.
  assert.match(components, /Your conversations use these instructions from their next turn/);
});

test("a paper can be filed into another project from the menu or by dragging", async () => {
  const [components, css] = await Promise.all([
    sources(),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  // One move function behind both entry points, so the picker and the drag
  // cannot drift on what a move does to the address the reader is standing on.
  assert.match(components, /papers\/\$\{paperId\}\/move/);
  assert.match(components, /onMovePaper/);
  assert.match(components, /Move project/);
  assert.match(components, /<MovePaperModal/);

  assert.match(components, /data-account-project=\{item\.id\}/);
  assert.match(components, /requestAnimationFrame\(runAutoScroll\)/);
  assert.match(css, /\.account-paper-row\.dragging/);

  // A project with no room refuses the drop here for the same reason the
  // picker greys it out — finding out from a 409 after the drop is worse.
  assert.match(components, /Project at maximum capacity\./);
  assert.match(components, /const room =/);
  assert.match(css, /\.move-paper-option\.is-full \{/);
});

test("the landing gap follows the pointer and pushes what is under it", async () => {
  const [components, css] = await Promise.all([
    sources(),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  // A gap at every insertion point, all mounted for the whole drag and all
  // closed but one. Mounted, because an element that appears already open
  // cannot transition — and the transition is the point.
  assert.match(components, /drop\?\.projectId === item\.id &&\s*drop\.index === index/);
  assert.match(components, /gapOpen\(0\)/);
  assert.match(components, /gapOpen\(paperIndex \+ 1\)/);
  assert.match(components, /data-account-paper=\{itemPaper\.id\}/);
  // Closed is genuinely zero — no height, and nothing of its dashed outline
  // showing — so arming them all at the start of a drag moves nothing. Open,
  // it is a row tall.
  assert.match(css, /\.account-drop-slot,\s*\.paper-drop-slot \{[\s\S]*?height: 0;[\s\S]*?overflow: hidden;/);
  assert.match(css, /\.account-drop-slot::after,\s*\.paper-drop-slot::after \{[\s\S]*?dashed/);
  assert.match(css, /\.account-drop-slot\.open \{[\s\S]*?height: 62px/);
  // The open gap is the answer while the pointer rests on it: it has no row
  // under it to anchor to, and falling through sent the gap to the foot.
  assert.match(components, /element\.dataset\.accountSlot/);
  // In flow, and springy: the height is what carries this project's papers and
  // every heading below it down together.
  assert.match(
    css,
    /\.account-drop-slot,\s*\.paper-drop-slot \{[\s\S]*?height 260ms cubic-bezier\(0\.2, 1\.35, 0\.45, 1\)/,
  );
});

test("one drag both reorders a project and files a paper into another", async () => {
  const components = await sources();

  // The gesture shows one gap, so the drop has to honour the index it showed.
  // Two endpoints behind it, because they are two different facts — and the
  // reorder route already owns dense positions, so the move must not grow a
  // second way to do that.
  assert.match(components, /const applyDrop = async/);
  assert.match(components, /landing\.projectId !== fromProjectId/);
  assert.match(components, /papers\/order/);
  assert.match(components, /JSON\.stringify\(\{ project_id: toProjectId, position \}\)/);
});

test("a pointer that moves is dragging a paper, not clicking through to it", async () => {
  const [components, css] = await Promise.all([
    sources(),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  // A mouse has no drag-to-scroll gesture, so a press that travels is a drag
  // and nothing else. Requiring the 360ms hold first meant every drag started
  // before it — the destination is usually above the paper — was discarded and
  // replayed as a click, closing the sheet onto the paper still being held.
  assert.match(components, /dragOnMove: event\.pointerType !== "touch"/);
  assert.match(components, /if \(travelled <= 7\) return;/);
  assert.match(components, /liftPaper\(gesture\)/);
  // The suppression is armed when the lift happens, not when the drop does.
  assert.match(
    components,
    /const liftPaper = [\s\S]{0,400}?suppressClickRef\.current = true/,
  );
  // A project with nothing in it is the drop a reader most wants to make, and
  // a heading plus one line of grey text is not enough of it to aim at.
  assert.match(
    css,
    /\.account-project-list\.is-dragging \.account-paper-list \{[\s\S]*?min-height/,
  );
});

test("Memory resolves as a static route ahead of the reader's", async () => {
  // `/memory` is one segment, exactly like the reader's `[project]`
  // route. Static segments resolve first, and the failure if they ever did not
  // would be silent: the address would render an empty workspace looking for a
  // project nobody has.
  const response = await render("/memory");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>Memory · Delphi<\/title>/i);
  assert.doesNotMatch(html, /class="loading-screen"/);

  const graph = await render("/memory/graph");
  const health = await render("/memory/health");
  assert.equal(graph.status, 200);
  assert.equal(health.status, 200);
  assert.match(await graph.text(), /Memory Map · Delphi/);
  assert.match(await health.text(), /Memory Health · Delphi/);
});

test("a Memory page arrives through a validated query, never a path", async () => {
  const hostile = await (
    await render("/memory?page=../../etc/passwd")
  ).text();
  const real = await (await render("/memory?page=kl-divergence")).text();

  // `?page=` is a value anyone can write, including someone sending a link, so
  // it goes through the slug alphabet before it can become a request. The
  // framework echoes the raw query in its own navigation state either way —
  // what matters is the prop the page was actually handed.
  assert.match(hostile, /initialSlug\\?":\s*null/);
  assert.match(real, /initialSlug\\?":\\?"kl-divergence/);
});

test("Memory is a structure tree, not a flat list", async () => {
  const [components, rail, css] = await Promise.all([
    sources(),
    readFile(new URL("../app/components/MemoryRail.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  // The rail's shape comes from a pure builder rather than from the
  // component, which is what lets the derivation be unit-tested at all.
  assert.match(components, /buildMemoryTree/);
  // Domains are folders: opening one lists every page filed under it, however
  // deep, as one flat run — the nesting was a second thing to navigate.
  assert.match(rail, /function pagesUnder\(node: TreeNode\): TreeNode\[\]/);
  assert.match(rail, /const pages = expanded \? pagesUnder\(domain\) : \[\]/);
  assert.match(css, /\.kb-memory-pages \{[\s\S]*?padding: 0 0 0 19px/);
});

test("no Memory column carries a pixel floor the window might not have", async () => {
  const css = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );

  // Invariant 31. The reading pane and its outer frame both have fractional
  // tracks with zero floors, so neither can push content beyond the window.
  // Read each `.kb-body` rule's own block rather than scanning forward from
  // its opening brace: the state classes set only the width *variables* the
  // one track list reads, so a lazy match for the next `grid-template-columns`
  // walked out of the rule and judged an unrelated one.
  const blocks = [...css.matchAll(/\.kb-body \{([^}]*)\}/g)];
  assert.ok(blocks.length, "no .kb-body grid found");
  const tracks = blocks
    .map(([, block]) => block.match(/grid-template-columns:([^;]+);/))
    .filter(Boolean);
  assert.ok(tracks.length, "no .kb-body track list found");
  for (const [, declaration] of tracks) {
    assert.doesNotMatch(
      declaration,
      /\d+px/,
      `.kb-body track carries a pixel floor: ${declaration.trim()}`,
    );
    assert.match(declaration, /minmax\(0,/);
  }
  assert.match(
    css,
    /\.kb-frame \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/,
  );
  assert.doesNotMatch(css, /\.kb-nav(?:-|\s|\{)/);
  assert.match(
    css,
    /@media \(max-width: 900px\)[\s\S]*?\.kb-body \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/,
  );
});

test("asking and searching are two controls, both in the bar", async () => {
  const [components, css] = await Promise.all([
    sources(),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  // Both controls reach all three things an account holds, so by invariant 32a
  // both belong in the chrome rather than beside any one panel. Ask used to
  // float over the wiki's reading column, which said it was the wiki's — while
  // it can now ask about the open document and the project too.
  assert.match(components, /className="topbar-ask"/);
  // A bare glyph at rest — reading is the window's point, and a filled pill
  // was the loudest thing on it — pressed in a clay tint while a conversation
  // is docked, and lifted onto a surface shared with the menu only on hover.
  assert.match(css, /\.topbar-ask \{[\s\S]*?background: transparent/);
  assert.match(components, /aria-pressed=\{docked\}/);
  assert.match(css, /\.topbar-ask\[aria-pressed="true"\] \{/);
  assert.match(css, /\.topbar \.account-strip:hover::before/);
  assert.doesNotMatch(components, /className="kb-ask-pill"/);
  assert.doesNotMatch(css, /\.kb-ask-pill/);
  // A mark at rest, its name after 0.6s of hover. The dwell is a
  // `transition-delay` on the hover state only, so the label rolls back the
  // instant the pointer leaves — and no timer has to be kept in step with it.
  assert.match(css, /\.topbar-ask:hover span,[\s\S]{0,700}?transition-delay: 0\.6s/);
  assert.match(css, /\.topbar-ask span \{[\s\S]{0,300}?max-width: 0/);
  // The newest turn is kept in view, but only *animated* when the move is
  // short. Loading a thread flew the whole transcript past the reader, which
  // is an animation performed at them rather than the view settling.
  assert.match(components, /session\.cells\.get\("scrollTop"\)/);
  // `"instant"`, never `"auto"` — `.messages` sets `scroll-behavior: smooth` in
  // CSS and `"auto"` defers to it, so the placement animated the whole thread
  // while reading, in the code, as though it did not.
  // Where to go is `transcriptScroll`'s rule (unit-tested), fed the saved position.
  assert.match(components, /node\.scrollTo\(\{ top: next\.top, behavior: "instant" \}\)/);
  assert.match(components, /transcriptScroll\(\{[\s\S]{0,80}historyLoaded: threadLoaded, saved,/);
  // Expanded, the close button and Escape both mean "back to the rail", and
  // the card collapses toward it rather than being swapped out from under it.
  assert.match(components, /fullscreen \? leaveFullscreen\(\) : enterFullscreen\(true\)/);
  assert.match(css, /\.kb-chat-rail\.is-fullscreen\.is-collapsing/);
  // Collapse is one movement. Dropping `is-collapsing` in the same tick as
  // `is-fullscreen` let the rail interpolate height from the overlay's 100vh
  // — a flash, then the same grow-in that plays when a question is first sent.
  assert.doesNotMatch(
    components,
    /setCollapsing\(false\);\s*enterFullscreen\(false\)/,
  );
  assert.match(css, /\.kb-chat-rail\.is-collapsing \{[^}]*transition: background/);
  // The wiki column stays split while the overlay is up. Undoing it made
  // collapse re-open the rail from related-width, which is the composer's
  // send animation, not a shrink.
  assert.match(components, /railHasChat \? "kb-rail-split"/);
  assert.doesNotMatch(
    components,
    /askMode === "rail" && !chatFullscreen \? "kb-rail-split"/,
  );
  // The map and Health dock the conversation too, so wherever it is `rail`
  // it is on screen and the press nudges a card the reader can see. One
  // element serves all three layouts, and the map and Health share a frame so
  // the toggle between them does not remount it.
  assert.match(components, /const railHasChat = askMode === "rail";/);
  assert.equal((components.match(/\{chatRail\}/g) ?? []).length, 2);
  assert.match(components, /\{section !== "wiki" \? \(\s*<div\s+className="kb-memory"/);
  assert.match(css, /\.kb-shell-memory\.kb-rail-split \.kb-memory \{[^}]*minmax\(0, var\(--kb-chat-width\)\)/);
  // It goes with the reader between the three, by address.
  assert.match(components, /router\.push\(withChat\("\/memory\/health"\)\)/);
  assert.match(components, /docked=\{railHasChat\}[\s\S]{0,400}if \(railHasChat\) \{\s*setChatNudge/);
  // Memory's rail card sets its own height, so its map fills it at 1:1.
  assert.match(css, /\.kb-related-memory \.kb-related-graph svg \{[^}]*height: 100%;[^}]*aspect-ratio: auto;/);
  // A share of the window, with no pixel cap to hold a large display's card
  // shorter than a laptop's, and an expanded card wider than the docked one.
  // 10% taller than 72vh, short of hiding Related Memory's first two rows.
  assert.match(css, /\.kb-chat-rail\.landed \{[^}]*?height:\s*min\(79vh, 100vh - 217px\);/);
  // The docked measure grows with the column from 37 widths of its type to 56.
  assert.match(css, /\.chat-surface \{[^}]*--chat-measure-start: calc\(37 \* var\(--chat-message-size\)\);/);
  assert.match(css, /\.chat-surface \{[^}]*--chat-measure: min\(\s*calc\(56 \* var\(--chat-message-size\)\),\s*calc\(var\(--chat-measure-start\) \+ \(100cqi - [^;]*\) \* 2 \/ 3\)\s*\);/);
  assert.match(css, /\.kb-chat-rail\.is-fullscreen \.kb-ask-modal \{\s*--chat-measure: 1240px;/);
  assert.doesNotMatch(css, /height:\s*min\(760px, 72vh\)/);
  assert.match(
    css,
    /\.kb-chat-rail\.is-fullscreen \.kb-ask-modal \{[^}]*width: calc\(40vw \+ 0\.6 \* max\(min\(60vw, 980px\), 50vw\)\);[^}]*height: calc\(40vh \+ 0\.6 \* 78vh\);/,
  );
  assert.doesNotMatch(css, /height:\s*min\(508px, 58vh\)/);
  assert.match(css, /--kb-chat-width:\s*460px/);
  assert.match(components, /setChatColumnWidth\] = useState\(CHAT_COLUMN\)/);
  assert.match(components, /setRailChatWidth\] = useState\(CHAT_COLUMN\)/);
  // Expanding and collapsing are a move between two *measured* boxes, driven
  // from the component. Neither end is a geometry the stylesheet can know —
  // the docked width is whatever the reader dragged their rail to — so a
  // keyframe or a size transition here would run against the measured move and
  // put back the overshoot it exists to remove.
  assert.match(components, /flyCard\(from, card\.getBoundingClientRect\(\), true\)/);
  assert.match(components, /flyCard\(card\.getBoundingClientRect\(\), home, false\)/);
  // The expand flight's effect must not depend on `collapsing`. That re-ran
  // the grow the moment collapse started, so the card shrank, flew back out,
  // then shrank again when the overlay class came off.
  assert.match(
    components,
    /flyCard\(from, card\.getBoundingClientRect\(\), true\);\s*\}, \[dockedBoxRef, fullscreen, flyCard, settleCard\]/,
  );
  assert.doesNotMatch(css, /@keyframes kb-chat-expand/);
  const expanded = css.match(
    /\.kb-chat-rail\.is-fullscreen \.kb-ask-modal \{[^}]*\}/,
  );
  assert.ok(expanded, "the expanded card still names its own size");
  assert.doesNotMatch(expanded[0], /animation|transition/);
  // Ask always starts a new chat. Past ones live in the rail, which the
  // composer hands over to rather than choosing among them itself.
  assert.match(components, /setAskOpen\(true\)/);
  assert.match(components, /className="composer-history-button"/);
  assert.doesNotMatch(components, /aria-label="Conversation"/);
  // Dead twice over before this: the bar grew a centre slot for an earlier
  // design and kept the CSS after the component went.
  assert.doesNotMatch(css, /\.topbar-center \.kb-ask/);
  // The removed control, matched as markup rather than as prose: widened to
  // every source, the old wording also hit a doc comment that merely names it
  // as an example.
  assert.doesNotMatch(components, /kb-ask-mode|label="Ask or find"/);

  // It opens where the reader already is. Pressing it must never push a route:
  // asking a question may not rearrange the page being read. Asserted as the
  // *absence* of navigation in the handler rather than as its exact spelling —
  // the body has since grown a branch for the already-open case, and pinning
  // the one-liner made a test fail for a reason it was never about.
  const askButtons = [...components.matchAll(/<AskDelphiButton[\s\S]*?\/>/g)];
  assert.equal(askButtons.length, 2, "the Reader and the wiki each mount one");
  for (const [element] of askButtons) {
    assert.match(element, /onOpen=\{/);
    assert.doesNotMatch(element, /router\.(push|replace)|pathTo\(/);
  }
  // A question sent on the map or Health is answered there: no navigation to
  // the wiki, and those routes keep their own address with only the flag.
  assert.doesNotMatch(components, /router\.push\(memoryAskHref/);
  assert.match(components, /if \(section !== "wiki"\) return;/);
  assert.match(components, /section === "wiki"\) return;\s*const url = new URL\(window\.location\.href\);\s*if \(askMode === "rail"\) url\.searchParams\.set\("ask", "1"\);/);
});

test("collapsed catalog and Related Memory stay bounded and legible", async () => {
  // Read from the concatenation: the rail is mounted by both shells now, so it
  // is its own component, and this is about what it draws rather than where
  // the file sits.
  const [wiki, css] = await Promise.all([
    sources(),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(wiki, /related\.distances\.get\(node\.slug\) === distance/);
  // Node *count* is the only thing that varies with room. The dots and the
  // type are fixed pixel sizes mirrored into the viewBox, because legibility
  // is not a function of how wide the rail happens to be — a fixed viewBox
  // scaled to the column magnified them instead of showing more graph.
  assert.match(wiki, /if \(selected\.size >= capacity\) break/);
  assert.match(wiki, /viewBox=\{`0 0 \$\{box\.width/);
  // Dots and type at the rail's base sizes, grown only by the shared, capped scale.
  assert.match(wiki, /r=\{current \? metrics\.currentRadius : metrics\.nodeRadius\}/);
  assert.match(wiki, /fontSize: metrics\.labelFont/);
  // The type stops growing at 15px, a little over the list's titles; the dots go on.
  assert.match(wiki, /labelMax: 15,/);
  assert.match(wiki, /Math\.min\(scale, GRAPH\.labelMax \/ GRAPH\.labelFont\)/);
  assert.match(wiki, /labelFont: GRAPH\.labelFont \* type,/);
  assert.match(wiki, /nodeRadius: GRAPH\.nodeRadius \* scale,/);
  assert.match(wiki, /graphScale\(box\.width, box\.height, GRAPH\.reference\)/);
  assert.match(wiki, /Math\.sqrt\(drawable\) \/ \(GRAPH\.extentPerNode \* Math\.sqrt\(scale\)\)/);
  // And the tally under it counts what is actually drawn, so it falls as the
  // picture grows rather than quoting a number from a fixed ten.
  assert.match(wiki, /hidden: Math\.max\(/);
  assert.doesNotMatch(wiki, />this page</);
  assert.match(css, /\.kb-related-pin \{[\s\S]*?position:\s*sticky;[\s\S]*?top:\s*0/);
  assert.match(css, /\.reader-rail::-webkit-scrollbar,\s*\.kb-related-rail::-webkit-scrollbar \{\s*display: none/);
  assert.match(css, /\.kb-related-graph line \{[\s\S]*?transparent/);
  assert.match(css, /\.kb-related-graph \{[\s\S]*?user-select:\s*none/);
  assert.match(css, /\.kb-related-node:focus[\s\S]*?outline:\s*none/);
  // A press on a tabindex SVG group must not take focus: Safari then outlines
  // the whole `<g>` in its default blue ring, which is the highlight the
  // hover tooltip already makes unnecessary.
  assert.match(
    wiki,
    /className=\{`kb-related-node[\s\S]*?onMouseDown=\{\(event\) => \{[\s\S]*?event\.preventDefault\(\)/,
  );
  assert.match(wiki, /className="kb-related-tooltip"/);
  assert.doesNotMatch(wiki, /<title>\{node\.title\}<\/title>/);
  // On a Memory page the same rail is the left column: links first, the
  // local map at its foot, and the way back to the full map inside that map.
  assert.match(wiki, /layout === "memory"/);
  assert.match(wiki, /className="kb-related-back" onClick=\{onWholeGraph\}/);
  // A page is set on the digest's measure, widened on a large display from
  // one factor (an engine without typed arithmetic leaves it at the
  // laptop's 0); its reading type stays the laptop's.
  assert.match(css, /--kb-content-width: calc\(810px \* \(1 \+ 0\.55 \* var\(--kb-wide\)\)\)/);
  assert.doesNotMatch(css, /--kb-read-scale/);
  assert.match(css, /--kb-wide: 0;[\s\S]*?--kb-memory-rail: calc\(264px \* \(1 \+ 0\.2 \* var\(--kb-wide\)\)\)/);
  assert.match(css, /@supports \(width: calc\(100vw \/ 1px \* 1px\)\) \{\s*:root \{ --kb-wide: clamp\(0, \(100vw - 1512px\) \/ 1048px, 1\.5\); \}/);
  assert.match(css, /--prose-size: 17\.5px;/);
});

test("every streaming surface reads frames through one parser", async () => {
  const components = await sources();

  // Four hand-rolled copies of the same `getReader()` + split-on-blank-line
  // loop had already drifted in how they handled a partial trailing frame. A
  // parser bug in one of four places is a bug nobody finds.
  assert.match(components, /readSseStream/);
  assert.doesNotMatch(components, /\.body\.getReader\(\)/);

  // Check each caller separately: an import in ChatPanel cannot provide the
  // binding used by Workspace. Concatenating the files hid that regression.
  for (const directory of ["../app/components/", "../app/lib/"]) {
    const base = new URL(directory, import.meta.url);
    for (const path of await readdir(base, { recursive: true })) {
      if (!/\.tsx?$/.test(path) || path === "sse.ts") continue;
      const source = await readFile(new URL(path, base), "utf8");
      if (!/\breadSseStream\s*\(/.test(source)) continue;
      assert.match(
        source,
        /import\s*\{[^}]*\breadSseStream\b[^}]*\}\s*from\s*["'][^"']*\/sse(?:\.ts)?["']/,
        `${directory}${path} must import the shared stream reader`,
      );
    }
  }
});

test("health shows the queue and can act on what gave up", async () => {
  const text = await sources();
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  // Read from the queue's own route rather than folded into /health: stuck
  // work is not a property of the graph's shape, and /health is already a
  // two-tier contract (arithmetic over the records, plus the last model check).
  assert.match(text, /api\/memory\/maintenance"/);
  // The retry route had been implemented and shown nowhere, which is how a
  // document that silently failed to file left no trace a reader could find.
  assert.match(text, /maintenance\/jobs\/\$\{[^}]+\}\/retry/);
  // A job is named after the thing it is about; a marker is an idempotency key.
  assert.match(text, /job\.label/);
  // Health also distinguishes an absent filing from a broken graph and offers
  // the explicit action, filing exactly the documents it counted.
  assert.match(text, /onFile\(waiting\?\.paperIds\)/);
  // It counts the backlog through the shared planner rather than inventing its
  // own rule, so the badge here and the server's skip test cannot drift. This
  // used to pin `planBackfill(candidates, false)` — the literal spelling of a
  // `force` parameter that has since been deleted, because once the server says
  // which documents are behind, "queue everything regardless" is not a second
  // option but a wrong one. The planner taking a single argument is the durable
  // fact; the argument it no longer takes was the spelling.
  // `unqueued` is the candidates less the documents already in the queue, so a
  // queued document is not also offered as new.
  assert.match(text, /planBackfill\(unqueued\)/);
  assert.doesNotMatch(text, /planBackfill\([^)]*,/);
  // A current-version filing whose last job dropped a page is still owed
  // work. The GET preview and POST action share that fact, so Health cannot
  // display the debt while hiding the only button that settles it.
  assert.match(text, /item\.filed && !item\.stale && owesPage\(item\)/);
  assert.match(text, /a page the last filing could not write/);
  assert.doesNotMatch(text, /unverified|unresolved filing objection|"paper-added"|"paper-done"/);
  // Stuck is what gave up: a failed job with a retry ahead is only backing
  // off, and counting it as stuck called a healthy queue unhealthy.
  assert.match(text, /\.filter\(gaveUp\)/);
  // The rail foot is one status, drawn only while it has something to say,
  // and nothing on Health is a pill.
  assert.match(text, /className="kb-health-status"/);
  assert.match(css, /\.kb-health-status \{/);
  assert.doesNotMatch(text, /kb-activity-attention|kb-filing-controls/);
  assert.doesNotMatch(css, /\.kb-health-[^{]*\{[^}]*border-radius: 999px/);
  // File-it-all hands the backlog to the queue and then starts it, rather than
  // filing inside this component. It used to run three workers here, which made
  // the one operation that takes minutes per document also the only one tied to
  // the reader staying on the page.
  assert.match(text, /POST"[\s\S]{0,120}drainMemoryMaintenance\(\)/);
  assert.doesNotMatch(text, /const runBackfill/);

  // And the way back out. Update is the one control that commits an account to
  // an unbounded amount of model spend — a job per out-of-date document, drained
  // by the pump for the rest of the session — so it needs a stop. It lives both
  // here and on the card reporting the run, because that is where a reader looks
  // while it is happening.
  assert.match(text, /memory\/maintenance\/cancel/);
  assert.match(text, /aria-label="Stop filing"/);
  assert.match(text, /onStop\?: \(\) => void/);
  // Both stops are gated on the server's count, and the card's gate is the one
  // this pins: it was `state.running` alone, which is true for a run whose last
  // documents are all in flight — nothing left to cancel, yet a button offering
  // to. A one-document Update was that case from its first frame, so the first
  // press of the feature fired a request that removed nothing and changed
  // nothing on screen. Gating both on the rule the cancel itself applies is
  // what makes the button's presence mean something can happen.
  assert.match(text, /unfinished && cancellable > 0 && onStop/);
  assert.match(text, /cancellable=\{queue\?\.cancellable \?\? 0\}/);
});

test("durable Memory maintenance keeps asking, from one place", async () => {
  const text = await sources();
  // One module reaches the endpoint. The previous version of this test pinned
  // the exact call expression a shell used, which is the spelling and not the
  // intent — it broke on a rename that changed nothing.
  assert.equal(text.match(/memory\/maintenance\/drain/g)?.length, 1);
  assert.doesNotMatch(text, /function fileExchange/);
  // Shells arm the pump rather than each inventing their own schedule.
  assert.match(text, /startMemoryMaintenance\(/);
  // And the pump is what makes the server's retry backoff mean anything: a
  // mount-only trigger left a job that had backed off waiting for the reader
  // to navigate somewhere before anything retried it.
  assert.match(text, /visibilitychange/);
  assert.match(text, /setInterval/);
});

test("Memory operation failures are contained and explain edge timeouts", async () => {
  const [components, css] = await Promise.all([
    readFile(
      new URL("../app/components/MemoryWorkspace.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(components, /MemoryOperationErrorNotice/);
  assert.match(components, /Cloudflare stopped waiting before Delphi answered/);
  assert.match(components, /aria-label="Dismiss error"/);
  assert.doesNotMatch(components, /<p className="kb-error">/);
  assert.match(components, /\/api\/memory\/reorganize\/stream/);
  assert.match(components, /MemoryOperationProgress/);
  assert.match(components, /This can take a minute/);
  assert.match(
    components,
    /const pageOperationNotices = operationNoticesActive \? \([\s\S]*?<MemoryOperationProgress[\s\S]*?<UpdateBanner[\s\S]*?<BackfillProgress[\s\S]*?<MemoryOperationErrorNotice/,
  );
  assert.match(
    components,
    /<TopBar[\s\S]*?\{pageOperationNotices\}[\s\S]*?<div className="kb-frame">/,
  );
  assert.match(css, /\.kb-operation-error-actions \{[\s\S]*?flex: 0 0 auto/);
  assert.match(css, /\.kb-operation-error-actions \.secondary-button \{[\s\S]*?white-space: nowrap/);
  assert.match(components, /state\.stages\[title\]/);
  assert.doesNotMatch(components, /delphi-loading-moss\.gif/);
  // One chrome for every card that lands in the top layer — the upload
  // banner's — so a filing, a check and a failure are the same object arriving
  // in the same place rather than three differently tinted ones.
  assert.match(
    css,
    /\.processing-document-banner,\s*\.kb-notice-card,\s*\.kb-backfill \{[\s\S]*?box-shadow:/,
  );
  assert.match(css, /\.notice-mark img \{[^}]*object-fit: contain/);
  // Progress is the card's bottom edge, in the brand's burgundy.
  assert.match(css, /--notice-progress: var\(--clay\);/);
  assert.match(css, /\.kb-backfill-bar \{[^}]*position: absolute;[^}]*bottom: 0;[^}]*height: 3px;/);
  assert.match(css, /\.kb-backfill-bar span \{[^}]*background: var\(--notice-progress\)/);
  // The mark is what carries the state, in the product's own vocabulary: the
  // climb while work runs, the alert when it failed, the sunrise when it is
  // done. A notice that draws its own glyph is the thing this replaced. One
  // module names the animations; every notice asks it by state.
  const notice = await readFile(new URL("../app/components/Notice.tsx", import.meta.url), "utf8");
  assert.match(notice, /running: "\/brand\/animations\/delphi-loading-climb\.gif"/);
  assert.match(notice, /done: "\/brand\/animations\/delphi-loading-sunrise\.gif"/);
  assert.match(notice, /attention: "\/brand\/animations\/delphi-warning-alert\.gif"/);
  assert.match(components, /live \? "running" : run\.phase === "failed" \? "attention" : "done"/);
  assert.match(
    components,
    /function MemoryOperationErrorNotice[\s\S]*?<NoticeMark state="attention" \/>/,
  );
  assert.match(
    components,
    /function MemoryOperationProgress[\s\S]*?<NoticeMark state="running" \/>/,
  );
  // State never recolours the card: its tile does.
  assert.doesNotMatch(css, /\.kb-backfill\.has-failures \{/);
  assert.doesNotMatch(css, /\.kb-operation-error \{/);
  assert.match(css, /\.kb-operation-notice-layer \{[\s\S]*?position: fixed[\s\S]*?animation: processing-banner-land/);
  assert.match(css, /\.kb-operation-notice-layer > \* \{[\s\S]*?position: static/);
  // …except the two that draw along their own bottom edge.
  assert.match(css, /\.kb-operation-notice-layer > \.kb-backfill,\s*\.kb-operation-notice-layer > \.kb-health-notice \{\s*position: relative;/);
  assert.match(css, /\.kb-health-notice \{[\s\S]*?width: min\(/);
});

test("an update run outlives the tab that started it, and shrinks when ignored", async () => {
  const [components, css] = await Promise.all([
    readFile(
      new URL("../app/components/MemoryWorkspace.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  // Durability is the queue's, not a heartbeat's. The pass used to run in one
  // browser, so an account record and a 60-second timer were the only way
  // another tab — or the same tab after a reload — learned it was happening,
  // and leaving the page still destroyed the work. Each document is a leased
  // job instead, so the card is derived from the account's queue and every tab
  // shows the same run. Nothing reads that record any more.
  assert.match(components, /backfillFromQueue\(\s*queue && \{[^}]*\},\s*filedHere/);
  assert.doesNotMatch(components, /\/api\/memory\/update|UpdateRunNotice/);
  assert.doesNotMatch(components, /setInterval\([\s\S]{0,80}reportUpdate/);
  // Counts, never prose: what the reader is told still comes from the records.
  assert.doesNotMatch(components, /body: JSON\.stringify\(\{[^}]*stages/);
  // Looking away shrinks it; an error notice is never collapsed away.
  assert.match(
    components,
    /useDismissOnOutsideActivity\([\s\S]{0,160}kb-operation-notice-layer/,
  );
  // A rounded rectangle like every notice, never a capsule, and a running one
  // keeps its progress along the bottom edge.
  assert.match(css, /\.kb-notice-pill \{[^}]*border-radius: var\(--notice-radius\);/);
  assert.match(css, /--notice-radius: 10px;/);
  assert.match(components, /progress=\{state\.running \? percent : undefined\}/);
  // The count of what is not shown is a control, not a notice.
  assert.match(components, /more in progress[\s\S]{0,40}<\/button>/);
});

test("a best-effort wiki refresh cannot mark a running update as failed", async () => {
  const [components, css] = await Promise.all([
    readFile(
      new URL("../app/components/MemoryWorkspace.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  // Filing is the durable operation; the periodic overview reload only paints
  // work that has already landed. A transient 503 from that read must not show
  // an action-failed banner or expose a retry that starts a second run.
  // The throttled in-run refresh this used to pin lived inside the tab's own
  // worker loop, which no longer exists: the queue drains on its own and the
  // overview reloads when a job announces that something landed. What has to
  // survive is the property, not that loop — a read that fails must not put an
  // action-failed banner beside filing that is working.
  assert.match(components, /reportError: false/);
  assert.match(components, /onMemoryFiled\(/);

  // An explicit SVG has a centred view box; the old font glyph sat below the
  // flex row's visual centre even though its line box itself was centred. The
  // run's fold turns Health's own chevron rather than drawing one of its own.
  const failures = await readFile(new URL("../app/components/RunFailures.tsx", import.meta.url), "utf8");
  assert.match(failures, /import \{ Chevron, TechnicalDetail \} from "\.\/HealthBits"/);
  assert.match(css, /\.kb-run-fold\[aria-expanded="true"\] \.kb-health-chevron \{[^}]*rotate\(90deg\)/);
  assert.doesNotMatch(css, /kb-backfill-failure|\.kb-backfill-failures summary::after/);
});

test("domain names edit in place and request a focused regraph", async () => {
  const [components, rail] = await Promise.all([
    readFile(new URL("../app/components/MemoryWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/MemoryRail.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(components, /\/api\/memory\/domains\/\$\{encodeURIComponent\(domain\)\}/);
  assert.match(components, /method: "PATCH"/);
  // Renamed in place, on the open domain's own row.
  assert.match(rail, /aria-label=\{`Rename \$\{domain\.title\}`\}/);
  assert.match(rail, /expanded && domain\.heading \? \(/);
  assert.match(components, /await applyMoves\(moves, \[\.\.\.renamedDomains\]\)/);
  // A rename asks where pages belong by itself, as a new domain does; the rail
  // carries no button for it.
  assert.match(components, /const renameDomain = async[\s\S]*?void proposeRefile\(\);[\s\S]*?const deleteDomain/);
  assert.doesNotMatch(rail, /kb-memory-update|onUpdate/);
});

test("a new domain is the list's last row, and an empty one can be dropped", async () => {
  const [components, rail, css] = await Promise.all([
    readFile(new URL("../app/components/MemoryWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/MemoryRail.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  // Not a header button: a dashed row after the domains that turns into the
  // name field in place.
  assert.match(rail, /className="kb-memory-new"[\s\S]*?New domain/);
  assert.match(rail, /placeholder="New domain"/);
  assert.match(css, /\.kb-memory-new \{[\s\S]*?border: 1px dashed/);

  // Removal is offered exactly where both storage backends would allow it:
  // a domain with nothing filed under it. A filled one is renamed.
  assert.match(rail, /expanded && domain\.heading && domain\.count === 0 \? \(/);
  assert.match(components, /method: "DELETE"/);
});

test("one toolbar, shared by every shell, with search mounted in it once", async () => {
  const [topbar, workspace, wiki, css] = await Promise.all([
    readFile(new URL("../app/components/TopBar.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/Workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/MemoryWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(topbar, /export function TopBar/);
  assert.match(workspace, /import \{ TopBar \}/);
  // That the reader mounts the shared bar and hands it the account, not how
  // the props happen to be wrapped — the previous spelling pinned them onto
  // one line and broke the day the reader gained a second one.
  assert.match(workspace, /<TopBar[\s\S]{0,240}?user=\{user\}/);
  assert.doesNotMatch(workspace, /kb-ask-input/);
  assert.match(wiki, /import \{ TopBar \}/);
  // No surface-specific search control any more: the bar carries one search,
  // it belongs to the account, and it is the same on all three shells.
  assert.match(topbar, /<SearchOverlay/);
  assert.doesNotMatch(wiki, /delphi-mark-mono-black\.svg/);
  // The bar is centred on the window, which is the three-track `.topbar`
  // layout — so the wiki must not re-template those columns, and the centre
  // slot must stay centred rather than stretched beside the brand.
  assert.match(
    css,
    /\.topbar \{[^}]*grid-template-columns:\s*1fr minmax\(0, auto\) 1fr/,
  );
  // The centre slot is gone with the search it once held; nothing styles it.
  assert.doesNotMatch(css, /\.topbar-center/);
  assert.doesNotMatch(css, /\.kb-topbar \{[^}]*grid-template-columns:/);
  assert.doesNotMatch(css, /\.kb-topbar \.topbar-center \{/);
});

test("the log is part of Health, and every long list ends in a count", async () => {
  const [wiki, css] = await Promise.all([
    readFile(new URL("../app/components/MemoryWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  // What a pass touched and what is wrong with the shape are one scope, so
  // there is no Log tab and no pane mounted outside Health.
  assert.doesNotMatch(wiki, /label: "Log"/);
  assert.doesNotMatch(wiki, /tab === "log"/);
  assert.match(wiki, /<HealthLog\s+events=\{events\}\s+pages=\{pages\}/);

  // Health *is* the activity now: two weeks of bars that filter by day, and
  // All / Created / Revised over the rows.
  assert.match(wiki, /dailyEditCounts\(entries, 14\)/);
  assert.match(wiki, /aria-label="Edits per day, last two weeks"/);
  assert.match(wiki, /\(\["all", "created", "revised"\] as const\)/);
  assert.doesNotMatch(css, /\.kb-log-filter/);

  // The log's older days end in one quiet count that opens.
  assert.doesNotMatch(wiki, /className="kb-gap-chip"/);
  assert.match(wiki, /Show \{plural\(hidden, "earlier edit"\)\}/);
  assert.match(css, /\.kb-health-more \{[\s\S]*?color:\s*var\(--muted\)/);
});

test("the Memory rail stays quiet: no header buttons, one open domain", async () => {
  const [rail, css] = await Promise.all([
    readFile(new URL("../app/components/MemoryRail.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  // The DOMAINS label stands alone: no count beside it and no buttons.
  assert.match(rail, /<p className="kb-memory-label">Domains<\/p>/);
  // No "All domains" row: opening a domain again closes it and zooms out.
  assert.doesNotMatch(rail, /All domains/);
  assert.match(rail, /onToggle=\{\(\) => onFocus\(focus === domain\.slug \? null : domain\.slug\)\}/);
  // Map and Health are the rail's first row, level with the map's top edge.
  // The reader's own Documents | Projects control, not a second one restyled.
  assert.match(rail, /className="segmented library-tabs kb-memory-toggle"/);
  assert.doesNotMatch(css, /\.kb-memory-toggle button|\.kb-memory-toggle\.segmented::before/);
  assert.match(css, /\.kb-memory \{[\s\S]*?grid-template-columns: var\(--kb-memory-rail\) minmax\(0, 1fr\)/);
  // Each view is its own route and mounts its own rail: the press starts the
  // slide and the arriving toggle continues it, rather than snapping.
  assert.match(rail, /slide = \{ from: shown === "map" \? 0 : 1, to: entry === "map" \? 0 : 1, at: performance\.now\(\) \}/);
  assert.match(rail, /delay: -elapsed,[\s\S]*?pseudoElement: "::before"/);
  // A page's rail stands where the map's does, so the toggle does not jump.
  assert.match(css, /\.kb-shell-pages \{\n[^}]*--kb-catalog-width: calc\(var\(--kb-memory-rail\) \+ 10px\);/);
  assert.match(css, /\.kb-shell-pages \.kb-memory-rail-slot \{\n  margin: -4px 0 0 10px;/);
});

test("Memory diagnostics are durable routes reached from Settings", async () => {
  const [wiki, settings, graphRoute, healthRoute, css] = await Promise.all([
    readFile(new URL("../app/components/MemoryWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/SettingsModal.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/memory/graph/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/memory/health/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(wiki, /className="kb-nav"/);
  assert.doesNotMatch(wiki, /const TABS/);
  assert.doesNotMatch(wiki, /useState<MemorySection>/);
  assert.doesNotMatch(css, /\.kb-nav(?:-|\s|\{)/);
  assert.match(graphRoute, /initialSection="graph"/);
  assert.match(healthRoute, /initialSection="health"/);
  // Memory and the model settings share Advanced; neither was enough rows
  // to earn a rail entry of its own.
  assert.doesNotMatch(settings, /id: "knowledge"|id: "security"/);
  assert.match(settings, /<h4 id="settings-model-label">Model<\/h4>[\s\S]*?<h4 id="settings-memory-label">Memory<\/h4>/);
  assert.match(settings, /<strong>Map<\/strong>/);
  assert.match(settings, /<strong>Health<\/strong>/);
  assert.doesNotMatch(settings, /Account-wide/);
  assert.match(settings, /"\/memory\/graph"/);
  assert.match(settings, /"\/memory\/health"/);
  assert.match(css, /\.settings-group \{[\s\S]*?display:\s*grid;/);
  assert.doesNotMatch(css, /\.account-settings \{/);
  assert.match(css, /\.kb-graph \{[\s\S]*?width:\s*98%;[\s\S]*?margin:\s*20px auto 0;/);
});

test("opening a Memory page updates the preserved shell, not only its URL", async () => {
  const wiki = await readFile(
    new URL("../app/components/MemoryWorkspace.tsx", import.meta.url),
    "utf8",
  );

  const open = wiki.match(/const open = useCallback\(([\s\S]*?)\n  \);/)?.[1];
  assert.ok(open, "no Memory page opener found");
  assert.match(open, /setSlug\(target\)/);
  // On the wiki the shell's own state is the authority — routing there would
  // update the address and leave the pane showing the previous page. Graph
  // and Health are separate routes that this shell does not render, so
  // opening a page from one of them is a navigation, and it is the only one.
  const routed = open.match(/router\.(?:push|replace)/g) ?? [];
  if (routed.length) {
    assert.equal(routed.length, 1);
    assert.match(open, /section !== "wiki"\)? \{[\s\S]*?router\.push/);
  }
});

test("a page's provenance opens on request", async () => {
  const [wiki, css] = await Promise.all([
    readFile(new URL("../app/components/MemoryWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  // One line between hairlines, folded by default: a count for each group it
  // opens to, in the order they open.
  assert.match(wiki, /function Provenance[\s\S]*?useState\(false\)/);
  assert.match(wiki, /className="kb-provenance-toggle"[\s\S]*?aria-expanded=\{open\}/);
  assert.match(wiki, /provenanceCounts\(groups, authors, backlinks\.length\)/);
  // Open, one column: the sources, who wrote the page, then the referring pages.
  assert.match(wiki, /<h3>Sources<\/h3>[\s\S]*?<h3>Written by<\/h3>[\s\S]*?<h3>Referenced by<\/h3>/);
  // Each passage sits under the document it cites; a captured outside source is a source of its own.
  assert.match(wiki, /sourceGroups\(page\.citations, sources\)/);
  assert.match(css, /\.kb-provenance \{[\s\S]*?border-top: 1px solid[\s\S]*?border-bottom: 1px solid/);
  // The "Revised …" notice is gone; a page states its provenance, not its edits.
  assert.doesNotMatch(wiki, /RevisedStrip|kb-revised/);
});

test("a Memory page reads as a digest does", async () => {
  const [wiki, markdown, css, kinds, link, answer, chat] = await Promise.all([
    readFile(new URL("../app/components/MemoryWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/MemoryMarkdown.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/memory.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/MemoryLink.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/markdown.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ChatPanel.tsx", import.meta.url), "utf8"),
  ]);

  // The kind reads one label per kind, from the one map — the badge used to
  // special-case `domain` while every other surface read the map, and the two
  // disagreed.
  assert.match(kinds, /domain:\s*"Domain"/);
  assert.match(wiki, /className=\{`kb-kind kb-kind-\$\{page\.kind\}`\}[\s\S]{0,80}KIND_LABELS\[page\.kind\]/);
  // The body wears the digest's own classes, so lists, tables, code and maths
  // are set by the one reading type rather than a copy of it.
  assert.match(wiki, /<article className="kb-prose prose-reading message-markdown">/);
  assert.doesNotMatch(css, /\.kb-shell-pages \.kb-prose \{/);
  // Title and deck as the digest sets them: the display face for the title,
  // the reading face for the deck, and the title above the prose.
  const rule = (pattern) => {
    const body = css.match(pattern);
    assert.ok(body, `no rule matching ${pattern}`);
    return body[0];
  };
  assert.match(rule(/\.kb-page-header h2 \{[^}]*\}/), /font-family: var\(--font-display\)/);
  assert.match(rule(/\.kb-page-summary \{[^}]*\}/), /font-family: var\(--font-wiki\)/);
  const title = Number(rule(/\.kb-page-header h2 \{[^}]*\}/).match(/font-size: (?:calc\()?([\d.]+)px/)[1]);
  const prose = Number(rule(/\.kb-prose \{[^}]*\}/).match(/--prose-size: (?:calc\()?([\d.]+)px/)[1]);
  assert.ok(title > prose * 1.5, `the title (${title}px) should be display type over ${prose}px prose`);
  // A run of evidence markers is one citation in the digest's face, and each
  // marker opens what it cites when the page can say where that is: they used
  // to be text, so a claim's source could not be checked from its page.
  assert.match(markdown, /<span className="digest-citation"[^>]*>\s*\(\s*\{ids\.map\(\(id, index\) => \([\s\S]*?<Marker id=\{id\} cite=\{cite\} \/>/);
  assert.match(wiki, /function citeMarkers\(/);
  // A passage opens the reader at its page or section, as a digest citation does…
  assert.match(wiki, /onOpenDocument\(projectId, paperId, \{ page: citation\.page, section: citation\.section \}\)/);
  assert.match(wiki, /focusPage=\$\{focus\.page\}/);
  // …a captured outside source opens the capture, and a derived claim stays text.
  assert.match(wiki, /<ExternalMarker id=\{id\} evidenceId=\{citation\.evidenceId\}/);
  assert.match(wiki, /citation\.claimType === "derived" \|\| !paperId\) return null/);
  // The same markers in the provenance chips.
  assert.match(wiki, /"kb-provenance-marker"\}>\{cite\(id\) \?\? `E\$\{id\}`\}/);
  assert.match(wiki, /<MemoizedMemoryBody[\s\S]*?cite=\{cite\}/);
  // The rewrite offer: one block, its note and button on the same row. It is on
  // every concept page, so it does not say the page is behind.
  assert.match(wiki, /className="kb-rewrite"[\s\S]*?Rewrite this page\.[\s\S]*?className="kb-rewrite-field"[\s\S]*?className="kb-rewrite-button"/);
  assert.doesNotMatch(wiki, /today’s engine/);
  // A Memory link is an anchor in its page's kind, and a name with no page is
  // plain text rather than a link to nothing. One component draws it, for a
  // page and for an answer in either scope, so the two cannot drift apart.
  assert.match(link, /className=\{`kb-link kb-link-\$\{page\.kind\}`\}[\s\S]*?className="kb-link-dot"/);
  assert.match(link, /if \(!page \|\| !onOpen \|\| insideLink\) return <>\{label\}<\/>;/);
  assert.match(markdown, /<MemoryLink key=\{`\$\{key\}-\$\{index\}`\} link=\{segment\} pages=\{pages\} onOpen=\{onOpen\} \/>/);
  assert.match(answer, /<MemoryLink key=\{`\$\{childIndex\}-\$\{index\}`\} link=\{piece\} pages=\{pages\} onOpen=\{open\} \/>/);
  assert.doesNotMatch(markdown + answer, /className=\{`kb-link/);
  // The answer beside a document is handed the pages too: it names them.
  assert.match(chat, /<MemoAssistantMessage[\s\S]*?pages=\{linkable\}\s+onOpenPage=\{onOpenPage\}/);
  assert.doesNotMatch(markdown + answer + link + css, /kb-link-unresolved/);
  // Evidence is above, so the page ends with its prose: no foot at all.
  assert.doesNotMatch(wiki + css, /kb-page-footer|kb-rail-level|LevelPill/);
  assert.doesNotMatch(wiki, /className="kb-citations"/);
});

test("the Memory chat opens in the wiki rail", async () => {
  // Legacy `/memory/ask` still resolves so old links keep working: it
  // mounts the wiki shell with the overlay open, not a separate chat page.
  const legacy = await render("/memory/ask");
  assert.equal(legacy.status, 200);
  const legacyHtml = await legacy.text();
  assert.match(legacyHtml, /<title>Ask your Memory · Delphi<\/title>/i);
  assert.match(legacyHtml, /initialAsk/);

  // `?q=` is a value anyone can write, so it is bounded and trimmed
  // server-side before it can become a model request. Both the legacy address
  // and the canonical wiki URL seed the same prop.
  const seededLegacy = await (
    await render("/memory/ask?q=does%20distillation%20beat%20RL")
  ).text();
  assert.match(
    seededLegacy,
    /initialQuestion\\?":\\?"does distillation beat RL/,
  );

  const wiki = await render(
    "/memory?ask=1&q=does%20distillation%20beat%20RL",
  );
  assert.equal(wiki.status, 200);
  const html = await wiki.text();
  assert.match(html, /<title>Memory · Delphi<\/title>/i);
  assert.match(html, /initialQuestion\\?":\\?"does distillation beat RL/);

  // Graph and Health keep their own routes and dock the conversation beside
  // themselves, so the opener is the same everywhere and navigates nowhere.
  const wikiSource = await readFile(
    new URL("../app/components/MemoryWorkspace.tsx", import.meta.url),
    "utf8",
  );
  const openAsk = wikiSource.match(
    /const openAsk = useCallback\(([\s\S]*?)\n  \);/,
  )?.[1];
  assert.ok(openAsk, "no Memory ask opener found");
  assert.doesNotMatch(openAsk, /section !== "wiki"|router\.push/);
  assert.match(openAsk, /setAskMode\(question \? "rail" : "composer"\)/);
  // A Memory chat reopened from the Dashboard, Settings or search lands beside
  // the map, and both routes read the flag.
  for (const route of ["graph", "health"]) {
    const source = await readFile(
      new URL(`../app/memory/${route}/page.tsx`, import.meta.url),
      "utf8",
    );
    assert.match(source, /initialAsk=\{ask === "1"\}/);
  }

  // The Dashboard used to seed this same address from an ask bar. That bar is
  // gone; a Memory row still opens the wiki rail, and Graph/Health still
  // send through `memoryAskHref` above.
  const dashboard = await readFile(
    new URL("../app/components/Dashboard.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(dashboard, /memoryAskHref|Ask good questions/);
  assert.match(dashboard, /<h2>Recent threads<\/h2>/);
  assert.match(dashboard, /conversationDestination\(user\.username, conversation\)/);
});

test("how an answer was reached is one record, drawn once", async () => {
  const [components, css] = await Promise.all([
    sources(),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  // One account of how an answer was reached, in the order it happened: the
  // panel under a Memory answer and the list of calls beneath it are one fold
  // per stretch now, drawn from the record the backend stores.
  assert.doesNotMatch(components, /How it got there|How this was worked out/);
  assert.match(components, /<AnswerFlow/);
  assert.doesNotMatch(components, /in your wiki/);
  assert.doesNotMatch(css, /\.kb-walk|\.kb-trail|\.answer-trace/);
});

test("a Memory page body renders only Delphi's own locators", async () => {
  const components = await sources();

  // A wiki page is durable, model-authored text entering the reader's DOM.
  // These three are what keep that safe, and each of them is one careless
  // change away from not being.
  assert.match(components, /securityLevel: "strict"/);
  assert.match(components, /const FIGURE_SRC = \/\^figure:/);
  assert.match(components, /if \(!resolved\) \{/);
  // Figures cost image tokens only when asked for, so a body carries captions
  // and the route serves bytes — never a remote address.
  assert.match(components, /\/api\/memory\/figures\//);
});

test("the client's limits stay in step with the ones the server publishes", async () => {
  const [api] = await Promise.all([
    readFile(new URL("../app/lib/api.ts", import.meta.url), "utf8"),
  ]);

  for (const field of [
    "memoryEnabled",
    "memoryMaxPages",
    "librarySearchEnabled",
  ]) {
    assert.match(api, new RegExp(`\\b${field}\\b`), `${field} missing from api.ts`);
  }
  for (const setting of [
    "memory_enabled",
    "memory_max_pages",
    "library_search_enabled",
  ]) {
    }
});

test("the health counters are read from the base, not from a check having run", async () => {
  const [components] = await Promise.all([
    sources(),
  ]);

  assert.match(components, /api<MemoryHealth>\("\/api\/memory\/health"\)/);
  // The arithmetic tiles are gone from the view; the check stays, as one
  // quiet button beside the activity, and what it finds still surfaces.
  assert.match(components, /lastCheck/);
  assert.match(components, /Run health check/);
  // The one check covers both halves: claims, and where pages are filed.
  assert.match(components, /const runLint = async[\s\S]*?void proposeRefile\(\);[\s\S]*?\/api\/memory\/lint/);
  // A waiting backlog is announced on the map, not only listed in Health.
  assert.match(components, /section !== "graph"[\s\S]*?\/api\/memory\/backfill\/papers/);
  assert.match(components, /<BacklogNotice/);
  assert.match(components, /contradictions/);
});

test("a page the last filing dropped is grouped by its document and retried there", async () => {
  const [components] = await Promise.all([
    sources(),
  ]);


  assert.match(components, /health\?\.droppedTargets \?\? \[\]/);
  assert.match(components, /dropped\.map\(\(item\) => item\.paperId\)/);
  // Each row carries the checker's reason and the passage it objected to.
  assert.match(components, /\{finding\.reason\}/);
  assert.match(components, /finding\.quote \? <q className="kb-health-quote">/);
  // A contradiction shows what each page says, under that page.
  assert.match(components, /\.filter\(\(quote\) => quote\.page === slug\)/);
  assert.match(components, /className="kb-health-group"/);
  assert.match(components, /onClick=\{\(\) => onRetryDocument\(paperId\)\}/);
  assert.match(components, /JSON\.stringify\(\{ paperIds \}\)/);

  assert.doesNotMatch(components, /passed its independent check|unverifiedFilings|objections/);
  // Only shown when there is one: the panel's row reads "Pages not written".
  assert.match(components, /HEALTH_LISTS\.filter\(\(\{ list \}\) => counts\[list\] > 0\)/);
  // Beside the document the same fact offers Retry: the filing card, with
  // each refused page and its reason listed under it.
  assert.match(components, /outdatedFiling\(record\)/);
  assert.doesNotMatch(components, /reader-unfiled-progress/);
});

test("a failed health check explains that nothing changed and offers a retry", async () => {
  const [components, css] = await Promise.all([
    sources(),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  // Keep a lint failure in the Health pane rather than leaking the provider's
  // validation string into the wiki-wide error line. The raw detail remains
  // available for diagnosis, while the primary action runs the same bounded
  // foreground check again.
  assert.match(components, /setLintError\(/);
  assert.match(
    components,
    /<aside className="kb-health-card" role="alert">[\s\S]*<TechnicalDetail text=\{error\} \/>[\s\S]*onClick=\{onRetry\}/,
  );
  // A missing AI connection is something to do, not a failure: its verb goes
  // straight to the connection.
  assert.match(components, />\s*Open AI connection\s*</);
  assert.match(css, /\.kb-health-card\s*\{/);
  assert.match(css, /\.kb-health-verb\s*\{/);
});

test("a completed health check confirms in the sunrise banner and leaves on its own", async () => {
  const components = await sources();

  // The terminal SSE result drives the same fixed, animated surface as Update;
  // a pending Update proposal remains underneath and reappears after dismissal.
  assert.match(components, /completed = payload/);
  assert.match(components, /if \(!completed\) throw new Error\("The check ended without a result"\);\s*setLintNotice\(true\)/);
  assert.match(
    components,
    /function HealthCheckNotice[\s\S]*?kb-notice-card kb-health-notice[\s\S]*?<NoticeMark state="done" \/>/,
  );
  // The card leaves on its own; the drain's end is its dismissal, and hovering
  // holds it.
  assert.match(components, /function HealthCheckNotice[\s\S]*?className="kb-health-notice-life"[\s\S]*?animationName === "kb-notice-drain"\) onDismiss\(\)/);
});

test("a long re-filing proposal scrolls without hiding its decision", async () => {
  const [components, css] = await Promise.all([
    sources(),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  // The explanation and actions sit outside the only scrolling element, so a
  // large proposal cannot push either one out of the bounded banner.
  assert.match(
    components,
    /kb-update-banner-copy[\s\S]*kb-update-banner-moves[\s\S]*kb-update-banner-actions/,
  );
  assert.match(
    css,
    /\.kb-update-banner\s*\{[^}]*max-height:\s*min\(60vh,[^}]*overflow:\s*hidden/s,
  );
  assert.match(
    css,
    /\.kb-update-banner-moves\s*\{[^}]*overflow-y:\s*auto/s,
  );
});

test("overlapping highlights merge only their painted geometry", async () => {
  const pdfViewer = await readFile(new URL("../app/components/PdfViewer.tsx", import.meta.url), "utf8");
  assert.match(pdfViewer, /unionOfHighlights\(/);
  const create = pdfViewer.slice(pdfViewer.indexOf("const unionHighlight"), pdfViewer.indexOf("const saveSelection"));
  assert.doesNotMatch(create, /onRemoveHighlight|onSaveNote/);
  assert.match(pdfViewer, /candidates\.length > 1/);
});

test("desktop navigation uses a Dashboard rail and a compact action menu", async () => {
  const html = await (await render()).text();
  assert.match(html, /Dashboard navigation/);
  assert.doesNotMatch(html, /class="topbar/);
  const components = await sources();
  assert.match(components, /aria-label="Search and settings"/);
  assert.doesNotMatch(components, /className="user-(avatar|handle|caret)"/);
});

test("the settings sheet ends in Advanced, and pays for the pane being read", async () => {
  const components = await sources();

  assert.match(components, /export function SettingsModal/);
  assert.match(
    components,
    /id: "projects"[\s\S]*?id: "chats"[\s\S]*?id: "advanced", label: "Advanced"/,
  );

  // Chats is fetched the first time that pane is looked at, not on open: the
  // sheet lands on Projects, and on the filesystem backend this read walks
  // every paper to migrate legacy thread files as it goes.
  assert.match(
    components,
    /if \(pane !== "chats" \|\| conversations !== null\) return;/,
  );
  assert.match(components, /api<DashboardConversation\[\]>\("\/api\/conversations"\)/);

  // Navigation is the action after the sheet, so the sheet goes first — the
  // same order `leaveForPaper` has kept since the account modal.
  assert.match(
    components,
    /const leaveForConversation = [\s\S]{0,200}?onClose\(\);[\s\S]{0,120}?onNavigate\(conversationDestination\(/,
  );

  // The old wiki card stays gone. Memory is a real pane with explicit
  // diagnostic destinations; the account menu still owns the way into Pages.
  assert.doesNotMatch(components, /account-knowledge-card/);
});

test("a chat row wears its project's accent, from the one palette helper", async () => {
  const [components, css] = await Promise.all([
    sources(),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  // `projectAccent` and not a second palette: a reader who knows Scaling Law is
  // orange from the switcher dot, the library glyph and the projects pane must
  // not have to re-learn it one pane over. The same helper is why all four
  // agree, and it is keyed on position in the project list, so the whole row of
  // surfaces shifts together or not at all.
  assert.match(
    components,
    /className="settings-chat-project"[\s\S]{0,400}?projectAccent\(\s*conversation\.projectId,\s*projects,\s*\)/,
  );
  assert.match(css, /\.settings-chat-project \{[\s\S]*?var\(--project-color/);

  // Mixed toward the ink rather than used neat. A pale accent still reads as a
  // dot; as a label on near-white paper it is not text anybody can read.
  assert.match(
    css,
    /\.settings-chat-project \{[\s\S]*?color-mix\([^)]*var\(--project-color[\s\S]*?var\(--umber\)/,
  );
});

test("Chats and Plans read as the Advanced pane does, title first", async () => {
  const settings = await readFile(new URL("../app/components/SettingsModal.tsx", import.meta.url), "utf8");
  // One card per day, and the day is the only time a chat row shows.
  assert.match(settings, /groupByDay\(conversations \?\? \[\], \(conversation\) => conversation\.lastEngagedAt\)/);
  assert.match(settings, /<section key=\{day\} className="settings-group">\s*<h4>\{day\}<\/h4>\s*<div className="settings-card">/);
  const chats = settings.slice(settings.indexOf('{pane === "chats" ? ('), settings.indexOf('{pane === "persona" ? ('));
  assert.doesNotMatch(chats, /<small>/);
  assert.doesNotMatch(chats, /settings-row-chevron/);
  // Title, then where it was asked, the project's dot leading its name.
  assert.match(chats, /<strong>\{conversation\.title\}<\/strong>\s*<span className="settings-chat-source"/);
  assert.match(chats, /<i className="settings-chat-dot" aria-hidden="true" \/>\s*\{collection\}/);
  // A plan: tile, question, its state or revision, a copyable id, and an
  // arrow only when it opens in the browser.
  const plans = settings.slice(settings.indexOf('{pane === "plans" ? ('), settings.indexOf('{pane === "chats" ? ('));
  assert.match(plans, /\["Hosted locally",[\s\S]*?\["Not hosted",/);
  assert.match(plans, /className="settings-plan-row"[\s\S]*?className="settings-plan-open"/);
  assert.match(plans, /className="settings-plan-row is-unhosted">\s*\{tile\}\s*\{text\}\s*\{id\}\s*<\/div>/);
});

test("the built stylesheet is served with an encoding, because it contains one", async () => {
  const [headers, css, worker, components] = await Promise.all([
    readFile(new URL("../public/_headers", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    sources(),
  ]);

  // A stylesheet served as bare `text/css` is decoded with a browser-chosen
  // fallback. Deployed, that was Latin-1 on roughly one first load in five —
  // a speculative CSS fetch before the document encoding is known — and a
  // UTF-8 triangle in `content:` arrived as "â–¸". The durable half is that
  // nothing rendered from `content:` is outside ASCII, so a missed charset
  // cannot paint mojibake. The close control and the trace fold's caret are
  // drawn; the settings source separator
  // is a CSS circle. Escaping the glyphs is not an alternative: the minifier
  // folds `\25B8` back to the literal character.
  const declarations = css.match(/content: "[^"]*";/g) ?? [];
  const nonAscii = declarations.filter((line) => /[^\x00-\x7F]/.test(line));
  assert.equal(nonAscii.length, 0);
  assert.doesNotMatch(css, /content: "▸/);

  // The other half: name the encoding anyway, on both paths a stylesheet
  // actually takes. `_headers` is what Cloudflare's asset server reads;
  // `withCssCharset` is what the Worker returns, including when vinext
  // reconstructs the Response and the header file never applies.
  assert.match(
    headers,
    /^\/assets\/\*\.css$[\s\S]*?^\s+Content-Type: text\/css; charset=utf-8$/m,
  );
  assert.match(worker, /function withCssCharset/);
  assert.match(worker, /text\/css; charset=utf-8/);

  // A `_headers` in `public/` replaces vinext's generated one rather than
  // merging with it, so the cache rule it wrote has to survive here too.
  assert.match(
    headers,
    /^\/assets\/\*$[\s\S]*?^\s+Cache-Control: public, max-age=31536000, immutable$/m,
  );
});

test("search is account-wide, mounted once, and reached the same way everywhere", async () => {
  const [components, css] = await Promise.all([
    sources(),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  // Mounted in the one component all three shells render, which is why no
  // shell had to be taught about it — the same argument that put the account
  // menu there.
  assert.match(components, /<SearchOverlay/);
  assert.match(components, /className="account-strip"/);

  // The menu names the shortcut, and the shortcut is the one the handler
  // binds. A menu promising a key nothing listens for is worse than no menu
  // entry at all.
  assert.match(components, /⌘K/);
  assert.match(
    components,
    /event\.key\.toLowerCase\(\) === "k"/,
  );
  assert.match(css, /\.search-backdrop \{/);
  assert.match(css, /\.account-menu-shortcut \{/);

  // Escape is claimed in the capture phase and stopped there. Half the shells
  // underneath keep their own global Escape listener, so an Escape that merely
  // bubbled would close the search box *and* the conversation behind it.
  assert.match(components, /addEventListener\("keydown", onKeyDown, true\)/);
});

test("the wiki's own Find is gone, and nothing is left listening for it", async () => {
  const [components, css, wikiRoute] = await Promise.all([
    sources(),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/memory/page.tsx", import.meta.url), "utf8"),
  ]);

  // It searched one thing from a bar that spans the product, and it navigated:
  // pressing it on /graph rearranged the wiki. Account-wide search replaces
  // both halves of that.
  assert.doesNotMatch(components, /kb-find/);
  assert.doesNotMatch(css, /\.kb-find/);
  assert.doesNotMatch(components, /enterFindMode/);
  assert.doesNotMatch(wikiRoute, /initialFind/);

  // And the pane that searched the raw library from a tab no route mounts.
  assert.doesNotMatch(components, /function LibraryPane/);
  assert.doesNotMatch(css, /\.kb-hits \{/);

  // ⌘K means one thing on every route now, so the Dashboard no longer spends
  // it on its own composer.
  assert.doesNotMatch(components, /composer\.current\?\.focus\(\)/);
});

test("the reader opens on Related Memory, and chat is summoned above it", async () => {
  const [components, css] = await Promise.all([
    sources(),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  // Someone who came to read gets the panel saying where this document sits in
  // what they already know. A conversation is asked for, not resident.
  // Read off the address, not held in state: a Dashboard row links straight at
  // a conversation, and local state meant arriving with `?chat=` in hand
  // opened the document with the panel shut (invariant 21).
  assert.match(components, /const chatOpen = chatIsDocked\(searchParams\.get\("chat"\)\)/);
  // And never beside the Ask composer: while it is up the rail is Related
  // Memory alone, so the two composers cannot both be on screen.
  assert.match(components, /\{chatOpen && !askOpen \? \(/);

  // Docked *above* the rail and pushing it down, by DOM order rather than by a
  // second mechanism — the same arrangement the wiki already uses.
  assert.match(
    components,
    /<aside className="reader-rail">[\s\S]*?ChatPanel[\s\S]*?RelatedMemoryRail/,
  );
  assert.match(css, /\.reader-rail \{[\s\S]*?flex-direction: column/);

  // The rail centres on the page written *from* the open document, because a
  // document is a source and a source has a page. Which of its pages that is
  // is a real decision and not a `find`: every concept and gap a pass filed
  // while reading the document carries the same paper as provenance, so the
  // first match was a `gap` page — and the document's own page was pushed
  // into the "related" list beneath it, the one place it cannot be.
  assert.match(
    components,
    /\/api\/memory\/documents\/\$\{encodeURIComponent\(routePaperId\)\}\/neighborhood\?hops=/,
  );
  assert.match(
    components,
    /memoryGraph\?\.paperId === routePaperId[\s\S]*?const paperPage = currentMemoryGraph\?\.sourcePage \?\? null/,
  );
  // Both rails consume the backend's distances; a second browser selector
  // must not choose a concept/gap merely because it shares provenance.
  assert.match(components, /distances=\{currentMemoryGraph\.distances\}/);
  assert.match(components, /distances=\{currentNeighborhood\?\.distances \?\? \{\}\}/);

  // And when nothing points back at it, that is said outright rather than
  // filled with the nearest unrelated pages.
  assert.match(components, /Not in your Memory yet/);
  assert.match(components, /File it now/);
  // A press files the document as what it actually is — an active document
  // takes the intent-only `added` pass, an archived one the evidence-capped
  // `done` pass — rather than always writing "added" and telling the wiki the
  // reader has only just picked it up. Matched on the two branches rather than
  // on the exact ternary: the surrounding expression grew a null guard when
  // this client was lifted out of the card, and that is spelling.
  assert.match(components, /paperIds: \[paperId\]/);
  assert.match(components, /delphi-loading-climb\.gif/);
  assert.match(components, /event\.type === "progress"/);

  // The fifth state, and the one that is true while a page exists: filed, and
  // written by a pass Delphi has replaced. It is a sibling above the rail
  // rather than anything inside `RelatedMemoryRail`, which the wiki mounts
  // too — a document-filing control in there would be one the wiki can never
  // use. And one record serves both cards, read above the fork.
  assert.match(components, /className="reader-unfiled is-outdated"/);
  // Full rail width and flush with the reader panel's top: no inset of its own.
  assert.match(css, /\.reader-unfiled\.is-outdated \{\s*padding: 0;/);
  assert.match(components, /an older Delphi/);
  // The press refiles the whole document, so the control says "document".
  // It read "Rewrite" while sitting beside one page and rewriting every page
  // that document owns — a promise about the page the reader was looking at.
  // The single-page rewrite is a different control and lives on the wiki page
  // itself, so what is asserted here is the *scope* of these two labels, not
  // a verb: the next honest rewording must not be able to reintroduce a
  // page-scoped word on a document-scoped button.
  assert.match(components, /"Retry document"/);
  assert.match(components, /"Update document"/);
  assert.match(
    components,
    /<aside className="reader-rail">[\s\S]*?OutdatedPage[\s\S]*?RelatedMemoryRail/,
  );
  assert.equal(components.match(/= useDocumentFiling\(\{/g)?.length, 1);

  // The graph route, not the overview: the overview carries the event log
  // too, and nothing beside a document somebody came to read needs it. The
  // wiki's own shell still uses the overview, which is why this is scoped to
  // the reader.
  const reader = await readFile(
    new URL("../app/components/Workspace.tsx", import.meta.url),
    "utf8",
  );
  assert.match(reader, /\/api\/memory\/documents\/\$\{encodeURIComponent\(routePaperId\)\}\/neighborhood/);
  assert.doesNotMatch(reader, /"\/api\/memory\/graph"/);
  assert.doesNotMatch(reader, /api<MemoryOverview>/);
});

test("the full Memory graph paints on Canvas without a false empty loading state", async () => {
  const [components, canvas, css] = await Promise.all([
    sources(),
    readFile(
      new URL("../app/components/MemoryGraphCanvas.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(components, /<MemoryGraphCanvas/);
  assert.match(canvas, /<canvas/);
  assert.match(canvas, /memory-graph\.worker\.ts/);
  // The graph grows while it waits: the pentagon walk, not the Delphi mark.
  // The Home card grows it without a caption; the full map names the wait.
  assert.match(canvas, /<GraphMark \/>\s*\{compact \? <LoadingWords text="Loading graph" \/> : <LoadingCaption text="Loading graph…" \/>\}/);
  assert.doesNotMatch(canvas, /delphi-loading-sunrise\.gif/);
  assert.doesNotMatch(canvas, /ready \? "Loading graph…" : `0 pages/);
  // The side key is gone: domains are drawn as regions and named on the map,
  // and zoom lives on the canvas itself.
  assert.doesNotMatch(canvas, /What the colors mean/);
  assert.match(canvas, /className="kb-graph-zoom"/);
  assert.match(css, /\.kb-graph-loading/);
});

test("the account graph draws only pages that exist, and previews on hover", async () => {
  const [memoryLib, canvas, base] = await Promise.all([
    readFile(new URL("../app/lib/memory.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../app/components/MemoryGraphCanvas.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/components/MemoryWorkspace.tsx", import.meta.url),
      "utf8",
    ),
  ]);

  // A `[[link]]` naming no page is plain words, not a place. Dropped at the
  // edge in `buildGraph`, so no line is left drawn to nowhere and no degree
  // counts it.
  assert.match(memoryLib, /if \(!pageBySlug\.has\(link\.from\) \|\| !pageBySlug\.has\(link\.to\)\) continue;/);
  assert.match(canvas, /buildGraph\(pages, links, domains\)/);
  // No retired kind is drawn, tinted or named anywhere in the Memory views.
  for (const text of [memoryLib, canvas, base]) {
    assert.doesNotMatch(text, /unresolved|includeUnresolved|"gap"|"question"|"synthesis"|nodeTone/i);
  }

  // Hover previews, and a card near the field's edge flips back inside it
  // rather than running off a canvas that does not scroll.
  assert.match(canvas, /schedulePreviewClose/);
  assert.match(canvas, /showPreview\(node, point\.x, point\.y, false\)/);
  assert.match(canvas, /useLayoutEffect/);
  assert.match(canvas, /originX = "right"/);
  assert.match(canvas, /originY = "bottom"/);
  assert.match(canvas, /KIND_LABELS\[preview\.node\.kind/);

  // The layout cache is keyed on the graph revision, which moves on every
  // Memory write — so writing one has to sweep the ones it replaced, or the
  // quota fills with dead positions and the cache silently stops working. The
  // sweep is `rememberLayout`, run for real in tests/layout-cache.test.mts.
  assert.match(canvas, /LAYOUT_CACHE_PREFIX/);
  assert.match(canvas, /rememberLayout\(key, positionsRef\.current\)/);
});

test("both rails resize, and the wiki's drag does not fight its own animation", async () => {
  const [components, css] = await Promise.all([
    sources(),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  // One divider, told which custom property it owns. Deriving that from `side`
  // stopped being possible the moment a second grid grew one.
  assert.match(components, /cssVar: string/);
  assert.match(components, /cssVar="--library-width"/);
  assert.match(components, /cssVar="--chat-width"/);
  assert.match(components, /cssVar="--kb-chat-width"/);

  // The collapse animation and the drag are the same property, so they cannot
  // both be live: without this the columns chase the pointer 340ms behind it.
  assert.match(css, /\.kb-body\.is-panel-resizing \{[\s\S]*?transition: none/);
  assert.match(
    css,
    /\.kb-shell-pages \.kb-body \{[\s\S]*?transition: grid-template-columns 340ms/,
  );

  // Every child names its track once the divider is a real column — an
  // unnamed one slides the rest a column left (invariant 32).
  assert.match(css, /\.kb-shell-pages \.kb-body > \.panel-divider \{\s*grid-column: 3/);
  assert.match(css, /\.kb-shell-pages \.kb-related-rail \{\s*grid-column: 4/);

  // Bounds live in the callback, never as a CSS floor the window may not have.
  assert.match(components, /const constrainRailWidth/);
  // `min-width: 0` is the grid-overflow guard and must stay; a *positive*
  // floor is the thing invariant 31 refuses.
  assert.doesNotMatch(css, /\.kb-related-rail \{[\s\S]{0,200}min-width:\s*[1-9]/);
});

test("a finished filing notice shrinks when looked away from, and stops coming back", async () => {
  const [workspace, css] = await Promise.all([
    sources(),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  // The gate used to be `backfill.running` alone, which covered every card
  // except the one that stays on screen longest — a run this tab had just
  // finished — so a result sat expanded over the page until it was dismissed
  // by hand.
  assert.match(workspace, /useDismissOnOutsideActivity\(\s*!noticesCollapsed && Boolean\(run\),/);
  // Dismissing puts away the failures it showed, one failure at a time, so a
  // new run, or a document that fails again, is shown again. A flag for the
  // whole card hid every later run until the page was reloaded.
  assert.match(workspace, /\.filter\(\(job\) => !dismissed\.has\(failureKey\(job\)\)\)/);
  assert.doesNotMatch(workspace, /dismissedBackfill/);

  // The layer scrolls, so it clips whatever leaves its padding box — which was
  // every card's bottom shadow. The gutter is the room for it, and `content-box`
  // is what keeps it from coming out of the card's own width.
  assert.match(
    css,
    /\.kb-operation-notice-layer \{[\s\S]*?box-sizing: content-box;[\s\S]*?padding: 8px 48px 66px;/,
  );
  // A 48px strip down each side of the window would otherwise swallow the very
  // outside click that collapses these cards.
  assert.match(
    css,
    /\.kb-operation-notice-layer \{[\s\S]*?pointer-events: none;/,
  );
  assert.match(
    css,
    /\.kb-operation-notice-layer > \* \{[\s\S]*?pointer-events: auto;/,
  );
  // The collapse is the card shrinking, and the card unmounts — so the pill is
  // what has to carry it.
  assert.match(
    css,
    /\.kb-operation-notice-layer > \.kb-notice-pill \{[\s\S]*?animation: kb-notice-shrink/,
  );
  assert.match(css, /@keyframes kb-notice-shrink \{[\s\S]*?scaleX\(1\.9\)/);
});

test("Reader filing status follows background publication, and Done files nothing", async () => {
  const reader = await readFile(new URL("../app/components/Workspace.tsx", import.meta.url), "utf8");
  const filing = await readFile(new URL("../app/components/DocumentFiling.tsx", import.meta.url), "utf8");
  const hook = filing.slice(filing.indexOf("function useDocumentFiling("));
  // Marking a document done changes the library only: no refresh, no drain.
  assert.doesNotMatch(hook, /doneAt/);
  assert.doesNotMatch(reader, /papers\/\$\{item\.id\}\/done`[\s\S]{0,260}fileDocument\(\)/);
  // Asking for a document outright also ends the wait on its session.
  assert.match(hook, /sendSessionRelease\(\{ paperId, projectId \}\)/);
  assert.match(hook, /onMemoryFiled\(\(\) => void refresh\(\)\)/);
  assert.match(hook, /request !== filingRead\.current/);
});

test("planning honors the composer mode for edits and requires explicit mode on seeds", async () => {
  const panel = await readFile(new URL("../app/components/ChatPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /<ModeTag mode=\{chatMode\}/);
  assert.match(panel, /const planning = fromComposer \? planMode : seed\?\.choice\?\.mode === ChatMode\.Plan;/);
  assert.match(panel, /setChatMode\(nextChatMode\)/);
  assert.match(panel, /desktop_mode: planning/);

});

test("editing exposes mode controls and saving disables cancellation", async () => {
  const panel = await readFile(new URL("../app/components/ChatPanel.tsx", import.meta.url), "utf8");
  // Chat or Plan reads on the scope's row, beside the tabs, not over the field.
  assert.match(panel, /\{conversationTabs\}[\s\S]{0,200}<ModeTag mode=\{chatMode\} \/>/);
  assert.match(panel, /if \(!streaming && composerEnabled && isModeShortcut\(event\)\)/);
  assert.match(panel, /disabled=\{savingPlan \|\|/);
  assert.match(panel, /if \(savingPlanRef.current\) return;\s*const requestId = streamRequestIdRef.current;/);
  assert.match(panel, /payload.stage === "plan_save"/);
  assert.match(panel, /savingPlan \? "Finishing save…"/);
});

test("wiki question seeds override a persona only for a submitted composer pick", async () => {
  const wiki = await readFile(
    new URL("../app/components/MemoryWorkspace.tsx", import.meta.url), "utf8",
  );
  // A URL seed bypasses the composer. Feeding its default into the
  // panel overwrites a saved Mentor conversation with ADHD on the first send.
  assert.doesNotMatch(wiki, /seedPersonaId=\{draftPersonaId\}/);
  assert.match(wiki, /seedPersonaId=\{askPersonaId\}/);
  assert.match(wiki, /\[askPersonaId, setAskPersonaId\] = useState<string \| undefined>\(\)/);
  assert.match(wiki, /openAsk\(\{ question: prompt, imageIds, personaId, choice, conversation, requestId \}\)/);
  assert.match(wiki, /setAskPersonaId\(personaId\);/);
  // The composer's model, effort and web search follow the same rule: a
  // question that never passed through the composer carries none, and the
  // conversation's own pills answer it.
  assert.match(wiki, /seedChoice=\{askChoice\}/);
  assert.match(wiki, /setAskPersonaId\(personaId\);\s*setAskChoice\(choice\);/);
});

test("a Plan send settles plan storage before it creates the chat it goes to", async () => {
  const panel = await readFile(new URL("../app/components/ChatPanel.tsx", import.meta.url), "utf8");
  const begin = panel.indexOf("  const sendTurn = async (");
  const body = panel.slice(begin, panel.indexOf("\n  const send = async", begin));
  // Creating a chat remounts this panel under the new conversation's key, and
  // the unmount cancels a capacity check still in flight: the first Plan send
  // from a new tab stopped silently, with no dialog. Order is the fix.
  const capacity = body.indexOf("await capacity.ensure()");
  const creation = body.indexOf("await ensureConversation()");
  assert.ok(capacity > 0 && creation > 0, "sendTurn checks capacity and creates the conversation");
  assert.ok(capacity < creation, "plan storage is settled before the conversation is created");
});

test("a plan-capacity retry mid-send can end: it honours Stop and a panel that is gone", async () => {
  const panel = await readFile(new URL("../app/components/ChatPanel.tsx", import.meta.url), "utf8");
  // The hook's own behaviour is exercised in tests/browser/plan-capacity.spec.ts;
  // here, that the send hands it the request's abort signal and reports Stop as
  // stopped rather than as a failure.
  assert.match(panel, /await capacity\.ensure\(controller\.signal\)/);
  assert.match(panel, /if \(controller\.signal\.aborted\) throw new DOMException\("Stopped", "AbortError"\)/);
});

test("changing the AI connection turns the settings sheet over to it", async () => {
  const [settings, connection] = await Promise.all([
    readFile(new URL("../app/components/SettingsModal.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/AiConnectionSetting.tsx", import.meta.url), "utf8"),
  ]);
  // One row says what is serving; Change swaps the sheet, rail included,
  // rather than stacking a second dialog on the first.
  assert.match(settings, /<AiConnectionRow connection=\{aiConnection\} onOpen=\{\(\) => setConnectionView\(true\)\} tier=\{tier\.value\} \/>/);
  assert.match(settings, /connectionView && aiConnection\.state \? \(\s*<AiConnectionView connection=\{aiConnection\}/);
  assert.match(connection, /aria-label="Connection type"/);
  // Each subscription, then every provider key under one "API keys" entry;
  // a Claude key beside OpenAI's.
  assert.match(connection, /const RAIL: RailId\[\] = \["chatgpt-oauth", "claude-subscription", "api-keys"\];/);
  const keys = await readFile(new URL("../app/lib/ai-connection.ts", import.meta.url), "utf8");
  assert.match(keys, /\{ id: "claude-api", name: "Claude", [^}]*available: true \}/);
  assert.doesNotMatch(connection, /Other provider|another provider/i);
  // Credentials never pass through the reader's renderer: signing in and
  // replacing a key hand off to the shell's AI Connection window.
  assert.doesNotMatch(connection, /<input|type="password"|apiKey:/);
  assert.match(connection, /connectionRequest\(\{ action: "manage", to \}\)/);
});

test("a document Memory has in hand says so in the library, not only in its own rail", async () => {
  const [components, css] = await Promise.all([
    sources(),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  // The rail's card speaks for the open document only, so a document added
  // while another was open sat in the library with nothing to say it was
  // being filed. The library shares the card's one read of the queue.
  assert.match(components, /const filingOf = useLibraryFiling\(memoryEnabled\);/);
  assert.match(components, /filing === "running" \? "Filing into Memory" : "In line for Memory"/);
  // It hears a drain move the queue, and polls only while something is owed.
  assert.match(components, /onMemoryQueue\(readWhenSeen\)[\s\S]*?onMemoryFiled\(readWhenSeen\)/);
  assert.match(components, /queue\.watching \|\| queueOwed\(queue\.snapshot\)/);
  assert.match(css, /\.paper-row small\.paper-metadata \.paper-filing\.is-running \{/);
});
