import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DASHBOARD_THREAD_LIMIT, SHELF_DOCUMENT_LIMIT, compactSourceLabel, conversationContext,
  conversationDay, conversationDestination, groupByDay, horizontalWheelDelta, relativeTime, shelfCaption, shortRelativeTime,
} from "../app/lib/dashboard.ts";
import { accentInk, accentTint } from "../app/lib/project-color.ts";

test("a thread card says what the thread was about, without inventing a summary", () => {
  assert.equal(conversationContext({ kind: "document_chat", paperTitle: "Abra: Scaling Diffusion Image Training" }), "Abra: Scaling Diffusion Image Training");
  assert.equal(conversationContext({ kind: "document_chat", paperTitle: null }), "A document");
  // The project is already named beside it: "Infra 101 > Across the project".
  assert.equal(conversationContext({ kind: "project_chat" }), "Across the project");
  assert.equal(conversationContext({ kind: "memory_chat" }), "Across your memory");
});

test("the top of the Dashboard is threads beside memory, with counts kept quiet", async () => {
  const [dashboard, css, canvas] = await Promise.all([
    readFile(new URL("../app/components/Dashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/components/MemoryGraphCanvas.tsx", import.meta.url), "utf8"),
  ]);

  // The mission headline and its big number row are gone: nothing on the
  // first screen outranks the reader's own threads and memory.
  assert.doesNotMatch(dashboard, /DASHBOARD_HEADLINE|DashboardTagline|dashboard-metrics|completedPercent/);
  assert.doesNotMatch(css, /\.dashboard-metrics|\.dashboard-tagline|\.dashboard-head\b/);
  assert.match(css, /\.dashboard-top \{[^}]*grid-template-columns: minmax\(0, 3fr\) minmax\(0, 2fr\);/);
  assert.match(dashboard, /data\.conversations\.slice\(0, DASHBOARD_THREAD_LIMIT\)/);
  // Four: the threads card is sized for four rows and Memory matches it.
  assert.equal(DASHBOARD_THREAD_LIMIT, 4);
  assert.match(css, /\.dashboard-conversations \{[^}]*min-height: calc\(4 \* var\(--dashboard-thread-height\)/);

  // Memory is the real graph, drawn by the Memory canvas in its compact
  // form, and nothing else: no counts, no key.
  assert.match(dashboard, /api<MemoryOverview>\("\/api\/memory"\)/);
  assert.match(dashboard, /<MemoryGraphCanvas compact /);
  assert.doesNotMatch(canvas, /kb-graph-summary/);
  // At rest the card names domains only; a page's name comes up on hover, and
  // a domain's pages are named once the card is zoomed onto it. Its one
  // control is the full map's fit, in the same corner.
  assert.match(canvas, /if \(\(compact && focusGroup < 0\) \|\| !settledRef\.current \|\| view\.size > 110\) return;/);
  assert.match(dashboard, /focusDomain=\{focus\} onFocusDomain=\{setFocus\}/);
  // It lays its domains out as the full map does: packed for the card's own
  // long shape, each name placed by the map's rule (memory.test.mts), with a
  // strip above in pixels so the top name is not cut off.
  assert.match(canvas, /if \(!settledRef\.current \|\| clusters\.count < 2 \|\|/);
  assert.match(canvas, /const box = placeDomainName\(\{/);
  assert.match(canvas, /const strip = compact\s*\? Math\.min\(0\.3, \(30 \* graphScale\(sizeRef\.current\.width, sizeRef\.current\.height, CARD_REFERENCE\)\) \/ sizeRef\.current\.height\)/);
  assert.match(canvas, /!ready \? null : \(\s*<div ref=\{zoomRef\} className="kb-graph-zoom"/);
  assert.doesNotMatch(canvas, /GraphResetButton|resetRef/);
  assert.doesNotMatch(dashboard, /dashboard-memory-stats|dashboard-memory-legend|data\.stats/);
  assert.doesNotMatch(css, /\.dashboard-memory-stats|\.dashboard-memory-legend/);
  // In pastels, read by the canvas from the card, so the full map keeps its
  // solids; and the domain names carry no pill.
  assert.match(css, /\.dashboard-memory-graph \{[^}]*--kb-node-domain: color-mix\(in srgb, var\(--coral\) 48%, white\);/);
  assert.match(css, /\.dashboard-memory-graph \{[^}]*--kb-region-pill-stroke: transparent;/);
  assert.match(canvas, /getPropertyValue\("--kb-region-pill-stroke"\)/);
  // The fit sits in the card's corner on a backdrop, not in an outlined box.
  assert.match(css, /\.kb-graph\.is-compact \.kb-graph-zoom \{[^}]*border: 0;[^}]*border-radius: 50%;[^}]*background: var\(--sand-cream\);/);
  assert.match(dashboard, /<SectionTitle title="Memory" label="Memory, open the map" href="\/memory\/graph" \/>/);
});

test("a thread row is its project on its own tint, a crumb, and a corner time", async () => {
  const dashboard = await readFile(new URL("../app/components/Dashboard.tsx", import.meta.url), "utf8");
  assert.match(dashboard, /"--project-tint": accentTint\(color\), "--project-ink": accentInk\(color\)/);
  assert.match(dashboard, /className="dashboard-thread-crumb"/);
  assert.match(dashboard, /shortRelativeTime\(conversation\.lastEngagedAt\)/);
  // Every row is equal: the newest is first, not highlighted.
  assert.doesNotMatch(dashboard, /is-latest/);
  assert.equal(accentTint("#c94e3a"), "#fce4de");
  assert.equal(accentInk("#c94e3a"), "#a8423a");
  assert.equal(accentInk("#E0A020"), "#7a5b0f");
});

test("conversation destinations preserve their exact scope", () => {
  const common = { id: "c", title: "Title", lastEngagedAt: "2026-01-01T00:00:00Z" };
  // Every row carries a `?chat=`, because every row *is* a conversation and
  // following it has to dock one. Without it a document chat opened its
  // document with the panel shut, which reads as the link having done nothing.
  assert.equal(conversationDestination("reader", { ...common, kind: "document_chat", projectSlug: "p", paperSlug: "d" }), "/@reader/p/d?chat=paper&conversation=c");
  assert.equal(conversationDestination("reader", { ...common, kind: "project_chat", projectSlug: "p", lastDocumentSlug: "d" }), "/@reader/p/d?chat=project&conversation=c");
  assert.equal(conversationDestination("reader", { ...common, kind: "memory_chat" }), "/memory/graph?ask=1&conversation=c");
});

test("relative times and carousel wheel direction are concise", () => {
  const now = Date.parse("2026-01-01T12:00:00Z");
  assert.equal(relativeTime("2026-01-01T11:58:00Z", now), "2m ago");
  assert.equal(shortRelativeTime("2026-01-01T11:59:30Z", now), "now");
  assert.equal(shortRelativeTime("2026-01-01T11:55:00Z", now), "5m");
  assert.equal(shortRelativeTime("2026-01-01T06:00:00Z", now), "6h");
  assert.equal(shortRelativeTime("2025-12-31T11:00:00Z", now), "1d");
  assert.equal(horizontalWheelDelta(2, -30), 0);
  assert.equal(horizontalWheelDelta(40, 5), 40);
  assert.equal(horizontalWheelDelta(0, 30, true), 30);
});

test("long project source labels end in a bounded ellipsis", () => {
  assert.equal(compactSourceLabel("RHODA.AI"), "RHODA.AI");
  assert.equal(
    compactSourceLabel("MAGAZINE.SEBASTIANRASCHKA.COM"),
    "MAGAZINE.SEBASTIANRAS...",
  );
  assert.equal(compactSourceLabel("ABCDEFGHIJKLMNOPQRSTUVWXYZ", 10), "ABCDEFG...");
});

test("Dashboard owns a rail instead of a top bar", async () => {
  const dashboard = await readFile(new URL("../app/components/Dashboard.tsx", import.meta.url), "utf8");
  assert.match(dashboard, /<DashboardRail/);
  assert.doesNotMatch(dashboard, /<TopBar/);
});

test("projects are shelves: one row per project, its name in a column, covers on its tint", async () => {
  const [dashboard, css] = await Promise.all([
    readFile(new URL("../app/components/Dashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  // Rows, not cards: the old three-column rail and its per-card lists are gone.
  assert.doesNotMatch(dashboard, /ProjectCard|dashboard-project-rail/);
  assert.doesNotMatch(css, /\.dashboard-project-rail|\.dashboard-project-documents/);
  assert.match(dashboard, /<ProjectShelf key=\{project\.id\}/);
  // One card, like the threads card above, with rows split by its hairline.
  assert.match(css, /\.dashboard-shelves \{[^}]*border: 1px solid var\(--line\);[^}]*border-radius: 10px;/);
  assert.match(css, /\.dashboard-shelf \+ \.dashboard-shelf \{[^}]*border-top: 1px solid/);
  // The project's tint pools only along the floor, in the project's own ink.
  assert.match(dashboard, /"--shelf-ink": accentInk\(color\), "--shelf-tint": accentTint\(color\)/);
  assert.match(css, /\.dashboard-shelf \{[^}]*linear-gradient\(180deg, transparent 0 48%, color-mix\(in srgb, var\(--shelf-tint\) 50%, transparent\) 100%\)/);
  // A cover is a source line at rest and its title, two lines at most, on hover.
  assert.match(dashboard, /shelfCaption\(document\)/);
  assert.match(css, /\.dashboard-shelf-title \{[^}]*-webkit-line-clamp: 2;/);
  assert.match(css, /\.dashboard-shelf-cover:hover \.dashboard-shelf-title/);
  // The row scrolls sideways, capped, with no arrow: the cut-off cover says so.
  assert.match(dashboard, /project\.documents\.slice\(0, SHELF_DOCUMENT_LIMIT\)/);
  assert.equal(SHELF_DOCUMENT_LIMIT, 10);
  assert.match(css, /\.dashboard-shelf-row \{[^}]*overflow-x: auto;/);
  assert.doesNotMatch(dashboard, /Scroll to browse|\+\$\{.*\} more/);
  // Open is a rounded square, not a circle.
  assert.match(css, /\.dashboard-shelf-open \{[^}]*border-radius: 6px;/);
  // Both edges fade, out of a gutter, so a cover part-way past either edge
  // dissolves rather than being cut; and scrolling is native, never smoothed
  // into an animation each wheel tick interrupts.
  assert.match(css, /\.dashboard-shelf-row \{[^}]*mask-image: linear-gradient\(90deg, transparent 0, #000 var\(--shelf-fade\), #000 calc\(100% - var\(--shelf-fade\)\), transparent 100%\);/);
  assert.match(css, /\.dashboard-shelf-row \{[^}]*margin: -14px calc\(-1 \* var\(--shelf-fade\)\) -16px;/);
  assert.doesNotMatch(css, /\.dashboard-shelf-row \{[^}]*scroll-behavior: smooth/);
});

test("a shelf holds only its documents: adding happens inside the project", async () => {
  const [dashboard, workspace, css] = await Promise.all([
    readFile(new URL("../app/components/Dashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/Workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(dashboard, /dashboard-shelf-add|onAdd|\?add=1/);
  assert.doesNotMatch(css, /dashboard-shelf-add|add-document-choice/);
  assert.doesNotMatch(workspace, /searchParams\.get\("add"\)|addDocumentMode|initialMode/);
});

test("a shelf caption names the source and length, never the title", () => {
  assert.equal(shelfCaption({ kind: "pdf", filename: "2312.07104v2.pdf", title: "SGLang", url: null, pages: 20 }), "2312.07104 · 20 pp");
  assert.equal(shelfCaption({ kind: "pdf", filename: "knapformer.pdf", title: "KnapFormer", url: null, pages: 14 }), "Uploaded · 14 pp");
  assert.equal(shelfCaption({ kind: "web", filename: "index.html", title: "A Steerable Model", url: "https://www.pi.website/research/x", pages: 7 }), "pi.website · 7 sections");
  assert.equal(shelfCaption({ kind: "web", filename: "page.html", title: "Saved", url: null, pages: 1 }), "Saved webpage · 1 section");
});

test("the Dashboard rail is the burgundy frame", async () => {
  const [rail, css] = await Promise.all([
    readFile(new URL("../app/components/DashboardRail.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(rail, /delphi-mark-on-burgundy\.svg/);
  assert.match(css, /\.dashboard-sidebar \{[^}]*background: var\(--clay\);/);
  // Collapsed, only the brand is inert: the tools stay live above the expand
  // target, each taking the pointer on its icon's square alone.
  assert.match(rail, /<div className="desktop-rail-header" inert=\{collapsed\}/);
  assert.doesNotMatch(rail, /desktop-rail-inner" inert/);
  assert.match(css, /\.is-collapsed \.desktop-rail-inner \{[^}]*z-index: 1; pointer-events: none; \}/);
  assert.match(css, /\.is-collapsed \.desktop-rail-actions button::before \{ pointer-events: auto; \}/);
  // Its icons in the rail's own white, not the menu's muted grey.
  assert.match(css, /\.desktop-rail-actions \.account-menu-icon \{[^}]*color: inherit;/);
  // Hovered, an icon plays its own motion to the end — the gear one tooth, a
  // sixth, so it lands where it began — and collapsed, its name shows beside
  // the rail, outside the clipped rail itself.
  assert.match(rail, /settings: \[\[\{ transform: "rotate\(0deg\)" \}, \{ transform: "rotate\(60deg\)" \}\]/);
  assert.match(rail, /icon\.getAnimations\(\)\.length \|\| window\.matchMedia\("\(prefers-reduced-motion: reduce\)"\)\.matches/);
  assert.match(rail, /<\/aside>\n    \{collapsed && tip && <span className=\{`desktop-rail-tip/);
  assert.match(css, /\.desktop-rail-tip \{ position: fixed;[^}]*pointer-events: none;/);
});

test("a project shelf owns only horizontal wheel gestures", async () => {
  const dashboard = await readFile(new URL("../app/components/Dashboard.tsx", import.meta.url), "utf8");
  // React's onWheel is passive, so preventDefault there cannot stop a
  // horizontal flick becoming browser back/forward or a vertical tick
  // being remapped onto the cards while the page also moves.
  assert.match(dashboard, /addEventListener\("wheel", onWheel, \{ passive: false \}\)/);
  assert.doesNotMatch(dashboard, /onWheel=\{/);
});

test("Memory conversations carry a dark-orange shared graph badge", async () => {
  const [dashboard, css] = await Promise.all([
    readFile(new URL("../app/components/Dashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(dashboard, /import \{ MemoryIcon \} from "\.\/MemoryIcon"/);
  assert.match(dashboard, /<MemoryIcon className="dashboard-conversation-source-icon" \/>Memory/);
  assert.match(css, /\.dashboard-conversation-memory \{[^}]*color: var\(--clay-dark\);[^}]*font-weight: 600;/);
  assert.doesNotMatch(css, /> button\.is-knowledge (?:strong|small)/);
});

test("recent threads and projects share section headings", async () => {
  const [dashboard, css] = await Promise.all([
    readFile(new URL("../app/components/Dashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  // The pill used to seed `/memory?ask=1&q=`. Graph and Health still
  // do; this surface only lists threads the reader already has.
  assert.doesNotMatch(dashboard, /Ask good questions|memoryAskHref|setQuestion/);
  assert.doesNotMatch(css, /\.dashboard-ask\b/);

  assert.match(dashboard, /<h2>Recent threads<\/h2>/);
  // Threads and Memory open their detail from the title itself, lit by the
  // chat's waiting sweep on hover and bare otherwise; Projects gets a plus,
  // its words in a tooltip.
  assert.match(dashboard, /<SectionTitle title="Recent threads" label="Recent threads, see all" onClick=\{\(\) => openSettings\("chats"\)\} \/>/);
  assert.match(dashboard, /<SweepText text=\{title\} \/>/);
  assert.doesNotMatch(dashboard, /kind="more"|dashboard-section-dot/);
  assert.match(css, /\.dashboard-section-link \{[^}]*border: 0;[^}]*background: transparent;[^}]*cursor: pointer;/);
  assert.match(css, /\.dashboard-section-link:not\(:hover, :focus-visible\) \.sweep-text-window \{ visibility: hidden; \}/);
  assert.match(dashboard, /<SectionAction label="New project" onClick=\{\(\) => setCreatingProject\(true\)\} \/>/);
  assert.doesNotMatch(dashboard, />See all<|>Explore<|>New project</);
  assert.match(css, /\.dashboard-section-action \{[^}]*width: 28px;[^}]*border-radius: 7px;/);
  assert.match(css, /\.dashboard-section-action\.is-add:hover svg[^{]*\{ transform: rotate\(90deg\); \}/);
  assert.match(css, /\.dashboard-section-action::after(?:, [^{]+)? \{ content: attr\(data-tip\);/);
  assert.match(dashboard, /<CreateProjectModal/);
  // A thread row is its project, context, time and title: no arrow button.
  assert.doesNotMatch(dashboard, /dashboard-thread-go/);
  assert.doesNotMatch(dashboard, /Continue reading|recentDocuments|document.excerpt/);
  assert.match(dashboard, /<h2>Projects<\/h2>/);
  assert.match(dashboard, /data\.conversations\.slice\(0, DASHBOARD_THREAD_LIMIT\)\.map/);
  assert.match(dashboard, /conversationDestination\(user\.username, conversation\)/);
  assert.match(dashboard, /kind === "memory_chat"/);

  // Section names are labels in small burgundy capitals, so they never
  // outrank the threads and the graph beneath them.
  assert.match(css, /\.dashboard-section-title h2 \{[^}]*font-size: 11\.5px;[^}]*text-transform: uppercase;/);
  assert.match(css, /\.dashboard-conversations \{[^}]*display: grid;/);
});

test("chats are grouped by the reader's calendar day, not by hours elapsed", () => {
  // 08:00 local on a Thursday.
  const now = new Date(2026, 9, 8, 8, 0).getTime();
  const at = (days: number, hour: number) => new Date(2026, 9, 8 - days, hour, 0).toISOString();
  assert.equal(conversationDay(at(0, 1), now), "Today");
  // Nine hours ago is last night: yesterday, though fewer than 24 hours passed.
  assert.equal(conversationDay(at(1, 23), now), "Yesterday");
  assert.equal(conversationDay(at(6, 12), now), "This week");
  assert.equal(conversationDay(at(7, 12), now), "Earlier");
  // Days keep their order, items keep theirs, and empty days are left out.
  const items = [at(0, 7), at(0, 2), at(3, 9), at(30, 9)];
  assert.deepEqual(groupByDay(items, (item) => item, now), [
    { day: "Today", items: [items[0], items[1]] },
    { day: "This week", items: [items[2]] },
    { day: "Earlier", items: [items[3]] },
  ]);
});


test("the dashboard column grows past its laptop width on a large display", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  // Of the window less the open rail, so collapsing the rail never resizes it.
  assert.match(css, /\.dashboard-wrap \{ max-width: max\(var\(--dashboard-container-width\), calc\(\(100vw - var\(--desktop-rail-width, 0px\)\) \* 0\.88\)\);/);
  assert.match(css, /--dashboard-container-width: 1320px;/);
});
