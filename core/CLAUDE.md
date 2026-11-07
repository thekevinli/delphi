# CLAUDE.md

Guidance for Claude Code working in this repository. `README.md` is the user-facing
description and `ARCHITECTURE.md` is the prose rationale and the incident record; this file
is the operating manual — what the system is, which properties must not break, and how to
extend it without eroding the design. `AGENTS.md` is its mirror for Codex.

> **This is `core/` of this repository: the `delphi_core` package**, built into the
> desktop app and installed by the web app as a pinned wheel. The web app keeps its SQL
> store, its migrations and its deployment in its own repository. Paths are relative to
> `core/` unless they start with `desktop/` or `scripts/`; `frontend/` is the desktop's
> `desktop/frontend/`, which began as a copy of the web frontend. The repository-wide
> rules live in the root `CLAUDE.md`, and this manual's gates are `bash check.sh --core`
> and `bash scripts/ci_core.sh`.

Those three roles are the whole of the documentation, on purpose. Do not add a `README.md`
to a subdirectory: per-directory docs are how a repository ends up with four descriptions of
the same thing, three of them wrong. Put the explanation in the code as a module docstring,
or in the appropriate root-level document.

---

## 0. How to edit this file

**Hard ceiling 100k chars** — `wc -m CLAUDE.md` before you commit (characters, which is
what the CLI's limit counts; `wc -c` reports bytes and reads ~400 high here). Per section:
§3 ≤ 12k, §5 ≤ 40k, §8 ≤ 22k. The budget is what stops this file being cut by hand a
third time. **A section over budget is paid for out
of itself** — move a story to `ARCHITECTURE.md`, or retire an entry whose rule no longer
earns its space. Raising the number is the last resort, not the first.

A new "why" belongs in the code comment at the site that needs it — this repository is 9%
comments on purpose, and an agent editing a file reads them without being told to. **This
file gets one sentence naming the rule and the symbol to read.** If you are about to add a
paragraph here, you are adding it in the wrong place; if the story behind the rule is worth
keeping, it goes in `ARCHITECTURE.md` § "Incidents that set a rule".

Cite symbols, never line numbers — line numbers rot silently and nothing fails. Never quote
a test, lint or file count: they rot the same way, and `bash check.sh --core` is the
authority.

**Delphi is pre-launch and has no external users. Never keep a code path, route, column,
URL spelling, data-reading branch or doc rule only so that old data, old links, old client
bundles or old containers keep working.** Remove it, and delete the rows by migration. If
removal breaks something real — Memory filing, context fetching — fix that dependency; do
not keep the shim. "Preserve with adapters" is not a disposition this repository offers.

`AGENTS.md` is this file with two words changed; never edit it. Regenerate it with the
root `CLAUDE.md`'s `sed`, run on `core/CLAUDE.md`.

---

## 1. What Delphi is

A research reading workspace. `/` is Home: threads, Memory map and project shelves; `/reader` opens
the persistent three-panel workspace: a project library, a real PDF.js reader
or a proxied live web page, and a streaming model conversation grounded in whatever
is open. Behind those three sits a fourth thing that accumulates: an account-wide
**Memory** at `/memory`, a wiki of interlinked markdown pages —
with captured figures — that Delphi writes from what the reader asks and reads,
and then consults on every later question. Core is one HTTP contract on the local
store (`Stores.local()`, everything on the filesystem). A product builds its app with
`create_app` and may bring other stores: the desktop app runs core over loopback,
and the web app brings its own SQL store and deployment.

---

## 2. Commands

```bash
bash check.sh --core         # core's gate: pyflakes, vocabulary, layering (A1–A8), the suite,
                             # the desktop layer's suite, the scripts' tests, JavaScript contracts
bash scripts/ci_core.sh      # its full CI: 3.11 + 3.12, both wheels, core alone (A2),
                             # the reopen of the previous release's library, the API diff
PY=../.delphi-build/core-env/bin/python3      # from core/: the pinned interpreter
$PY -m pytest -q                              # the suite alone
# delphi_core.backfill.* are the bulk maintenance commands; every one takes --user/--quiet
$PY -m delphi_core.backfill.index             # rebuild the derived search index
$PY -m delphi_core.backfill.memory            # queue one `document` job per document owed
$PY -m delphi_core.backfill.memory --force --dry-run   # also the stale and the dropped
$PY -m delphi_core.backfill.thumbnails --dry-run       # document previews in bulk
$PY -m delphi_core.backfill.digests --dry-run          # digests behind the current version
# The offline rigs (memory_rebuild, the two benchmarks, memory_eval) are §3.1.
```

`bash check.sh --core` is the one command that has to be green. **Do not quote a
pass/fail count in this file: run the command.** `markdown.tsx`'s memoized `textual()`
factory is the one place allowed to assign a ref during render (§8).

**Core's suite runs the local store alone.** The storage contract is the test kit's
(`delphi_core_testkit.conformance`); the SQL store's half runs in the web app's suite.
The gates require every kit store test (`DELPHI_REQUIRE_CONFORMANCE`, A5), and A2
runs the suite from a copy against the installed wheels: a test reads nothing
outside `core/tests`, and a script's test lives in `scripts/tests`.

`build.cssMinify` stays `"esbuild"` until lightningcss learns `::search-text`, or the
frontend build fails. Why: `vite.config.ts`.

**Reader UI that crosses the web frame gets a spec in `frontend/tests/browser/`.** The
iframe, the annotation worker and pointer events are out of `node --test`'s reach, so
`check.sh` runs the shipped `PageViewer` in Chromium and WebKit through Playwright.

Never install into the ambient Python or Node: core's interpreter is
`.delphi-build/core-env` (`scripts/core-env.sh`), and the frontend's toolchain comes from
`desktop/build/runtime.sh`.
---

## 3. Map

```
delphi_core/
  config.py          Settings; the validator refusing a sandbox origin == a frontend one
  deps.py            get_storage / get_object_store / get_current_user
  schemas.py         every request body; the validation boundary
  defaults.py        frozen history: the text f7a3c19d5e84 classifies against
  personas.py        Mentor and ADHD, in code not rows; persona_for_turn
  app.py main.py     create_app, Stores; reference app. security.py: scrypt, HMAC
  routers/
    projects.py      projects, upload + staging, web pages, the framing proxy,
                     highlights, notes, store-in-place, annotated export
    chat.py          /api/config, history, the SSE stream, context assembly; all scopes
    memory.py        the KB over HTTP: pages, figures, lint, the queue and
                     its drain (run_document_job), /graph vs the rail's /neighborhood,
                     filing status, Update, rewrite, release, compose
    reader.py        authenticated visible-route resolution; the sharing boundary
    library.py       GET /api/library/search — the raw layer, discoverable
    search.py        GET /api/search — the account-wide box behind ⌘K
    auth.py dashboard.py personas.py digests.py    …as their names say
  harness/           one model client, the turn loop, budgets, replay, prompts,
                     research + evidence; profiles.py offers tools to tasks;
                     tools/ is one module per tool, two of which write
  artifacts/         inline visuals: a turn's drafts and reviews (session.py), the
                     bounded offline render (render.py, worker.py), exact delivery
  storage/
    base.py          the Storage / ObjectStore ABCs + safe_id / paper_key; page
                     kinds, claim types, job kinds, the two write checks
    local.py         filesystem implementation (one meta.json per project; @serialised)
    local_format.py  the local store's format marker and its format steps (71)
    sessions.py domains.py   a session's and a domain's job, the same in both stores
    ranges.py        HTTP Range parsing
  memory.py          the page shape and validator, source-page derivation,
                     lint (reports only), re-filing proposals
  memory_failure.py  why a Memory job failed: one of seven causes, by exception type
  memory_maintenance/  filing as a pipeline of stages (§4, 65–70, 73, 74)
    pipeline.py      run_job: the stages in order, one deadline; _GATHER by kind
    gather.py        the closed evidence set of a document's event; no model
    gather_session.py gather_reconcile.py gather_domain.py   …of the other kinds
    gather_crossref.py  a value one document gives another (75)
    select.py        one cheap call over the index; also "same idea?"
    maintain.py      the agent's bounded tool loop
    domain.py        the domain composer: read-only loop, its answer is the page
    agent.py         what those two loops share, on the harness
    verify.py        the checker call; is_blocking decides for Delphi
    verify_round.py  re-cite (verify_recite/_locate/_find), strike (verify_again/_claims) (67)
    commit.py        the one atomic write: pages, versions, event, notes
    commit_session.py  what a deleted note held comes off; watermarks advance
    run.py           what one stage hands the next
    jobs.py          job markers and fingerprints
    event.py         the event a job leaves; its operation id
    brief.py         the event as text: its tags, and fence
    blocks.py        a page as labelled top-level blocks
    ops.py           addressed edits, applied
    validate.py      preservation, links, arithmetic, shape
    cite.py          new citations held to the evidence set
    reader_notes.py  what rests on a note
    staging.py       MemoryDraft: evidence, shown, staged
    admit.py         what a write passes before it is staged
    contracts/       select.md maintain.md verify.md domain.md: a stage's prompt (§8)
  memory_harness.py       the Memory index, choosing from it, open_memory
  memory_health.py     the wiki's shape, computed: orphans, uncaptured figures,
                     dropped targets (48)
  memory_rewrite.py     one concept page rewritten without moving the graph (61)
  answer_trace.py    the one stored record of how an answer was reached
  memory_graph_index.py      the revision-keyed graph LRU
  research_digest.py the code-owned digest prompt; versioned evidence index
  source_inventory.py bounded PDF/web figures, tables, algorithms and decoys
  dashboard.py       thumbnails and Dashboard projection
  document_index.py  PDF pages / web sections → searchable rows; PAGE_MARKER
  workspace_search.py  the search box's collective rule; the row shape
  chat_history.py    complete_exchanges: every scope's ten-exchange window
  model_tasks.py     one row per model call + service_tier_for; no deployment sets a model
  plans.py routers/plans.py  shared Plan authority, captures, exports and scoped remote MCP
  account_export.py routers/export.py  the account as one folder: files, README, manifest, index
  plan_page.py       the plan schema (runs by settings, EXHIBIT_KINDS) and its script-free page
  sse.py             the one event-stream transport; heartbeat + anti-buffering
  pdf_worker.py      the child process every pdfium call is spawned into (§8)
  pdf_figures.py pdf_compress.py   the XObject walk; verified figure re-encoding
  web_fetch.py       fetches to a user-named host (SSRF guard); the ladder
  browser_render.py  the one bounded, DNS-pinned, hardened headless Chromium
  render_cache.py    what a render may answer from an earlier one: the immutable
  browser_host.py    a page a product lends instead (the desktop's Electron)
  web_extract.py     HTML → anchored markdown sections; what is not a page
  web_proxy.py web_bridge.js   base href + bridge injection; selection, clicks, pinch
  conversation_titles.py viewport.py chat_images.py    small derived helpers
  backfill/          bulk maintenance; most call the shipped routine the lazy path does
    __init__.py      flags, dependency construction, account loop, document walk
    memory.py        the catch-up (§2); --drain runs it here, domains last
    digests.py       digests behind RESEARCH_DIGEST_VERSION, by generate_digest
    index.py thumbnails.py    the derived index and document previews
    memory_rebuild.py *_benchmark.py memory_eval.py   offline rigs, §3.1
tests/               unit + route tests; the test kit's store tests on the local store
desktop/frontend/app/
  (reader)/layout.tsx        mounts the workspace; MUST stay a layout (§5, 22)
  (reader)/**/page.tsx       inert route markers — the shell reads the URL itself
  page.tsx layout.tsx        Dashboard, root
  memory/{,graph,health}/page.tsx           the wiki and its diagnostic routes
  components/Workspace.tsx   the shell: library, reader, modals, navigation
  components/ChatPanel.tsx   the one chat surface, mounted by both shells
  components/MemoryWorkspace.tsx    the wiki: pages, graph, health (with the log)
  components/MemoryGraphCanvas.tsx high-DPI whole-graph renderer; a Worker settles
  components/RelatedMemoryRail.tsx where the open thing sits in a bounded graph
  components/PdfViewer.tsx PageViewer.tsx   pdf.js canvas + text layer; the sandboxed
                           web frame and its postMessage protocol
  components/NoteEditor.tsx NotePreview.tsx   the note card; the read-only twin
  components/SearchOverlay.tsx  ⌘K over any shell; mounted once, in TopBar
  components/markdown.tsx MemoryMarkdown.tsx   the two renderers (§8 shares their rules)
  components/PanelDivider.tsx a draggable column edge, for any grid
  components/  TopBar, Dashboard, SettingsModal, AccountMenu, AuthForm, chat/,
               settings/, and the small presentational files
  lib/api.ts routes.ts       the fetch wrapper and the 401 hook; path building, ?next
  lib/memory.ts              slugs, [[links]], figure locators, filters; graph layout
  lib/memory-tree.ts         the sidebar's derived hierarchy, and its filter
  lib/memory-graph.worker.ts Barnes–Hut graph layout off the main thread
  lib/memory-maintenance.ts  startMemoryMaintenance — the durable-queue pump
  lib/session-release.ts     reports that the reader left a session (73)
  lib/backfill.ts            the Update pass: planning, progress, what it cost
  lib/chat-scope.ts          the two contexts, and everything derived from one
  lib/sse.ts answer-trace.ts one frame parser; bounded live/stored traces
  lib/remark-latex.ts        the TeX grammar both markdown renderers parse with
  lib/highlight-rects.ts frame-selection.ts   line bands; the web frame's scale
  lib/citations.ts citation-trail.ts   "(Paper, Table 1, p. 19)" → a jump, and back
  lib/citation-route.ts locator-index.ts anchor-index.ts   which document, and where
  globals.css                design tokens and every component style
desktop/frontend/worker/index.ts   the app's Worker, which `desktop/main/worker-host.ts` runs
desktop/frontend/tests/            node --test: SSR route assertions + pure-module units
```

`frontend/db/`, `frontend/drizzle/`, `frontend/examples/`, `frontend/app/chatgpt-auth.ts`
are inert starter-template scaffolding: Delphi's data is the backend's, never D1's.

### 3.1 Harnesses, and the offline evaluation rig

**Before building anything that measures a model, read this table.** Four
`backfill/` modules already stage accounts, rebuild a wiki offline, run arms
against each other and score the result.

| Command | What it gives you | What makes it safe |
|---|---|---|
| `memory_rebuild --user X --stage` (`--key`, `--resume`, `--report`, `--promote`, `--rollback`, `--web-frozen`, `--reextract`) | A whole wiki filed again by the shipped pipeline: documents, then their sessions (chats from the first turn, notes), then the domains that were settling. With a reviewed key the report scores quality. Promoted in one transaction | The candidate lives in an isolated filesystem store, invisible to the app. Promotion rechecks the source fingerprint and writes a rollback snapshot first |
| `digest_model_benchmark --candidate … --arm luna-high` | One fixed, stratified sample through two model/effort arms | It copies the candidate before calling the shipped `generate_digest`, and never touches the candidate or live data |
| `memory_eval pages\|edit\|events\|report` | Whether a candidate's pages are sound and match reviewed answer keys; no model is called | It reads files as JSON and never constructs `LocalStorage`: opening a store migrates it (71) |
| `chat_benchmark stage\|run\|judge\|report` | One question file through the real `/api/chat/stream`, once per arm, graded against reviewed facts | It speaks HTTP to one server per arm, in an account of its own; only `judge` calls a model |

- **The arms are named in `MODEL_TASKS` vocabulary** (`luna-high`, `terra-medium`),
  so a result maps onto a shipped configuration; never a bare model string.
- **The rigs are local by construction:** a filesystem store of their own, or an
  account of their own. Delete a rig once its comparison is over.
---

## 4. The four flows

**Auth.** `POST /api/auth/login` sets `delphi_session`, an HttpOnly signed cookie. Every
route resolves the username from it via `get_current_user`, and every `Storage` method takes
`username` as its first argument, so ownership is enforced *inside* the storage layer and no
router can forget it. A project owned by someone else raises 404, never 403 (invariant 25).

**PDF upload** (`routers/projects.py::upload_paper`). Stream to a scratch file →
parse with pypdf and check the page count *before* extraction → compress if over
`COMPRESS_OVER_MB` → refuse if still over `MAX_UPLOAD_MB` → write bytes, then the
record. Above `MAX_UPLOAD_MB` but under `MAX_UPLOAD_SOURCE_MB`, compression may
rescue it: the bytes are written and a signed *staged-upload token* carries the
pending record through the browser, answered by `confirm_staged_paper` or
`discard_staged_paper`. No server-side pending state, so the answer can land on any
instance.

**Web document.** `POST /pages` fetches once and stores a snapshot cut into sections
keyed by the heading's own `id` (or a slug). A PDF URL first offers a choice: import
it through the native PDF pipeline, or keep it as a web document whose pages become
`page-N` sections. Two objects, mirroring a PDF: `.web` (structured, what
`read_webpage` serves) and `.txt` (flat markdown, what everything generic reads).
The reader panel shows the live HTML page through the framing proxy, or the page copy
(`savedDom`); a linked PDF is re-fetched and shown through Delphi's PDF.js reader.
The model reads the *snapshot*, so the two can diverge — `POST /papers/{id}/refresh`
re-fetches the text, and `PUT /papers/{id}/saved-page` keeps the page as annotated.

Getting the bytes is a ladder, cheapest rung first, and only the rung a page actually
needs (invariant 43). A plain fetch serves almost everything; a 401/403/429 carrying
`Set-Cookie` is a *challenge*, not a refusal, so one retry replays those cookies, local
to that call and host; a page that parses to no sections escalates to
`browser_render.render_dom`. Anything left is classified by `describe_failure` into
blocked / missing / unavailable / throttled, so the reader is told which site refused and why rather
than a status code. Delphi does not try to defeat bot detection — see §9.

**Chat** (`routers/chat.py::chat_stream`). Both scopes run this one stream;
`general` swaps the file/digest/memory-selection steps for the whole Memory index
(`build_general_payload`). Append the user turn immediately → lazily
upload PDFs to the Files API and cache the ids → load web snapshots → compose instructions
from the system prompt plus the conversation's persona → build the Responses payload,
ending with the chosen `<reader_memory>` pages → `harness.loop.run_turn` streams SSE,
serving the read and Memory tools between rounds while accumulating a `trace` of what
it actually read → append the assistant turn, with its trace, only after the stream
finishes. An edit of the latest user message sends `replace_request_id` so that drop
happens *before* the new user turn is appended.

Project (wire `document`) and Memory (`general`) share one endpoint
(`POST /api/chat/stream`) and one client surface, discriminated by `ChatRequest.scope`;
each holds up to ten conversations (invariant 63). What is shared
is what decides *what the model sees*: `memory_harness`, the scope's profile
(`harness.profiles`), `tail_input` — the single place invariant 39's position −2 is written — and
`build_responses_payload`. What differs is orchestration, and that *is* the scopes: a
document question carries the project library — an index, then every digest that exists
(`ready_project_digests`, never generated there) — and names what is open beside the
question (`turn_context_block`); general takes the whole index
(invariant 44) and the open document as `open_document_block`.

A whole answer holds its session's job in the write that stores it, in either scope,
and nothing is filed while the reader is still there (73).

**Side chat** (`POST /api/chat/side`, `side_chat_stream`). The same preparation and
answer as a main turn (`prepare_answer`, `run_answer`) with none of `chat_stream`'s
writes, so no session job and no conversation lock. The client sends its side turns;
`tail_input` puts them after the stored history behind `SIDE_CHAT_MARKER`, and
`SIDE_CHAT_RULES` tells the model what it cannot do. Text only. A write added to the
shared half breaks `tests/test_side_chat.py`'s store snapshot, which is the point; the
provider file cache (`ensure_openai_files`) is the one write any first reader of a PDF makes.

An answer may carry an inline visual. A chat profile offers `draw_display`, whose JSON
spec `artifacts.display` checks in every state before a disposable offline browser
answers with bounded diagnostics and a screenshot, and
`publish_artifact`, which takes only the latest passing revision once a later round has
seen it (`artifacts.session.ArtifactSession`); `artifacts.delivery.Delivery` lets that
exact source, and no authored fence, into the answer. Drafts never write Memory.
`embed_figure` drafts a card of a source's own figure from Delphi's template
(`artifacts.figure_card`), and it is rendered, inspected and published like any draft.
`read_url` reads a PDF by page in the PDF worker, refuses one over `max_pages_per_paper`
before reading its text, and never hands the file to the provider (`source_reads`).

**Research Digest** (`research_digest.py`). The code-owned pass writes freeform Markdown
following the document rather than filling a section quota. PDFs reach the model as the
provider file plus the bounded source-element inventory; web documents as the stored
snapshot, its anchors, visual manifest and the same inventory. Both share the rules for
exact equations, evidence markers and locators, useful tables, and selected visuals.
The prompt states one document's share of the chat digest block
(`digest_document_max_tokens`) and `validate_digest` refuses a digest 20% over it.
A long source scales every one of its digest's lengths by one bounded factor (`DigestBudget`).

Digest visuals use a structured channel, not Markdown image syntax: the model names an exact
inventory id and an `afterEvidenceId`, and the reader places captured assets out of band
after that evidence. Publishing a digest is also what files a document: it derives the
source page and queues the document's job (`memory.file_republished_digest`, 36f).

**Memory** (`memory.py`, `routers/memory.py`). Three tiers, and the model
descends only as far as a question needs — that is the whole token argument:

| Tier | Cost | Serves |
|---|---|---|
| `<reader_memory>` (reader scopes) / the index (general) | one small call / cached | pages a model chose |
| `open_memory`, `grep_memory`, `memory_links` | cheap; already synthesized | the compiled wiki answers most questions |
| `search_library` → `read_paper` / `read_webpage` | expensive; exact | raw evidence, only when the wiki is not enough |

Writing runs the other way, through one pipeline (`memory_maintenance/`), and invariant 50
is its contract. **Import** queues a `document` job in the write that makes the document
visible (`add_paper`), and a foreground browser drains one leased job at a time.
`run_document_job` first makes what the job files from: it builds the **digest** when none
is current, and publishing a digest **derives the source page** and gives the same job the
digest's fingerprint; a document with a digest and no page gets one (`ensure_source_page`).
Then `pipeline.run_job` runs the stages, each handed what the one before returned:

| Stage | What it does | Model |
|---|---|---|
| `gather` | reads the event's closed evidence set; for a document: the document and its digest | none |
| `select` | reads the whole Memory index: which pages this bears on, or nothing to file | `memory.select` |
| `maintain` | the agent opens pages and stages edits and new concept pages, at most `staging.MAX_PAGES` | `memory.maintain` |
| `verify` | reads each staged page against the passages it cites; settles a blocked one (67) | `memory.verify` |
| `commit` | writes the pages that passed, their version rows and the job's event, atomically | none |

A job ends `filed`, `nothing` or `failed`, and each leaves an event (`event.py`). What the
agent had no room for goes to a follow-up job under the document's next marker
(`jobs.follow_up_marker`).

`run_job` runs four kinds of job, and gather is the stage that differs by kind
(`pipeline._GATHER`). A `session` job files what the reader asked and noted beside one
document, or in one Memory chat, once they have left it (73). A `reconcile` job starts from
the pages lint found to disagree, with no selection call, and may cite only the documents
those pages already cite. A `domain` job has the composer where the others have select and
maintain (74). A session or a domain with nothing owed ends with no event and no model call.

The graph's own shape is audited in two tiers that must not be confused.
`GET /health` computes what is countable — orphans, uncaptured figures, the targets a
document's last job dropped — from the records alone, on every request, with no provider
configured; `POST /lint` spends one model call on the finding only a model can make,
pages that contradict each other. It writes no page: each contradiction it can quote
queues a `reconcile` job. Invariant 48 is why.

The agent writes `concept` pages only. A `source` page is derived from its digest
(36f). A `domain` page is written by its domain's job and by nothing else, so a domain
with no written page has none (74). Lint and re-filing proposals run in `memory.py`
on `memory.review`. Native Markdown, LaTeX, tables,
pseudocode and Mermaid are the only representations, and **a page must stand alone**.
A page draws no pictures of its own: no provider code container, no generated figure.
---

## 5. Invariants

These are load-bearing. Breaking one usually still passes a smoke test.

**These numbers are cited from code** — `grep -rn "invariant 7" delphi_core`. A number is an
address: take the next free integer when you add one, **never renumber**, and add a lettered
sub-entry only if you intend to cite *it*. **36l, 42, 45, 48a, 56a, 58 and 60 are retired and must not be reused**
(45 folded into 40; 73 replaced 56a). Where the full reasoning lives in a module comment,
the entry names the file; follow the pointer before changing the rule.

**Identity and isolation**

1. `WEB_SANDBOX_ORIGIN` must be an origin the session cookie never reaches. Guarded
   twice: `Settings.sandbox_origin_is_not_the_app` refuses to start if it equals a
   frontend origin, and `paper_page` returns 500 if a page token and a session cookie
   arrive *together* — the second catches what the first cannot, the cookie later gaining
   a `Domain=`. Do not weaken either to silence a CORS or `frame-ancestors` error.
2. **The proxy serves a document, never an address.** `is_frame_request`
   (`Sec-Fetch-Dest`) gates the route and a top-level navigation gets a 303 to the real
   site, because serving proxied HTML at the top level runs third-party script on
   Delphi's origin beside the session cookie. It takes **no URL from the caller** —
   exactly the address stored on the document, which is what stops it becoming an open
   proxy on Delphi's domain.
4. `safe_id()` on every identifier that reaches an object key. Parameterised queries make
   it redundant for SQL; an object store will happily accept a key containing `../`.
5. The frame parent authenticates messages by `event.source`, **never** `event.origin` —
   an opaque origin serialises as the string `"null"`.
6. `web_fetch.check_public_host` runs on **every redirect hop**, not just the final URL.
   Redirects are followed by hand for exactly this reason.

**Durability and ordering**

7. **Bytes first, record last.** An orphaned object is invisible and reapable; a record
   pointing at bytes that were never written is a broken paper.
63. **Every chat operation names its conversation.** Storage takes only a selector,
    `conversation-<id>-<generation>` (`storage/conversations.py`); only
    `create_conversation` creates one. Deleting the context's last conversation clears it
    under a new generation, fencing late writes. `AnswerHeartbeat` stamps a running answer;
    a question unanswered with no stamp in `ANSWER_STALE_SECONDS` is closed by the next.
8. **Chat turns are appended, never written back as a whole thread** — the assistant turn
   lands up to fifteen minutes after the user turn, and rewriting would drop anything a
   second tab added. Replacing the last question is a tail delete
   (`drop_from_last_user_turn`); a later user turn from another tab is a 409.
64. **Only explicit `ChatRequest.mode` authorizes a Plan.** `plans.reserve`/`finish`
    fence capacity, receipts, captures and conversation generation; `routers.plans`
    exposes only fixed, revocable read grants to external tools.
9. `set_openai_file` writes one field on one paper and no-ops when an id is already set.
   It runs mid-stream, minutes after the project was read — a whole-aggregate write would
   replay a stale paper list over a concurrent rename or reorder.
10. Highlights are normalized `0..1` page rectangles, so they survive zoom and panel
    resize. Never store viewport pixels.
11. PDF compression is verified against a `(page_count, per_page_text)` fingerprint and
    discarded unless it matches *and* saves bytes. Idempotent
    (`MIN_SAVING_ALREADY_JPEG = 0.25`), because the backfill can be re-run.
33. **An object key names the project a paper sits in, so moving a paper moves its bytes.**
    `move_paper` copies the whole set *before* the record is re-parented and drops the
    source copies only after (7). What travels is about the document: record, digest,
    highlights, its own thread. What stays is about the collection.
51. **Union paint, never annotated records.** PDF selection geometry still merges into
    line bands; overlapping records and their notes remain independent. A destructive
    merge can cascade-delete every note except the first. HTML uses native CSS ranges;
    `web_annotation_bridge.js` must not wrap article text or keep frame storage.
52. **A note hangs off a highlight and survives revision replacement.** `HtmlHighlight`
    carries an immutable, versioned canonical quote anchor; HTML notes use null PDF
    coordinates. `web_annotations.js` uses verified offsets, exact quotes and exact
    context, never fuzzy matching. An unfinished search is unknown. Only temporary
    handles and current offsets enter the untrusted frame; notes and relocation stay
    in the parent worker. Capture reads the selection and page text in one pass on
    request; never gate it on a quiet page or on how an element behaves. Failed
    writes keep drafts open. Legacy text anchors remain unverified. `publish_snapshot`
    writes the fetched text and the import's page copy (a capture's whole page replaces
    only a first window); `publish_saved_page` the copy the frame serialised after a
    live annotation, never the text, through `freeze` and heuristic guards, never
    authentication. `annotation_revision_lock` fences both. Why: `web_revision.py`.
53. **Notes are the reader's words; what rests on one cites it and goes with it.**
    Writing, editing or deleting a note holds the document's `session` job (73), the only
    job that files notes: in a run of their own, after the session's exchanges
    (`gather_session`). They are stamped filed *after* the event is durable, if their
    update time is still the one read. A note reaches the model fenced as a `<reader_note>`,
    cited `reader-note` with a `noteId` `cite.check_citations` checks (35). In a notes
    run, inference or uncited words must cite the note (`reader_notes`). The pages citing
    an edited or deleted note (`note_citations`) go to the agent whatever the selection
    says (reason `withdrawn`). `admit.stage_edit` refuses a page that still cites a deleted
    note or keeps what rested only on it; `commit_session` takes that off a page left alone.
55. **Storing a linked PDF keeps the paper, and annotating one is gated on storing it.**
    `POST /papers/{id}/store` promotes in place — same id, so highlights, notes, digest and
    thread stay attached. Bytes before record before dropping the stale snapshot (7). The
    page limit is answered from `paper.pages` before anything is downloaded, and an
    over-limit result is refused rather than staged. If the copy is not stored nothing is
    written and `addHighlight` returns null. A promoted paper stops serving `url`; the
    address is kept as `source_url`/`sourceUrl`.
34. **The quota counts active documents.** A paper marked done is one the reader has
    read: it stays in the rail and the reading tools can open it, but carries no
    digest, is not `@`-mentionable, and is outside `max_papers_per_project`. `done_at` is a
    nullable timestamp, not a boolean: it gives the archive a stable sort.
73. **A session is filed once, after the reader leaves it.** A session is what the reader
    did beside one document (its chats in every tab, its note changes) or in one Memory
    chat. A whole answer and a note change each enqueue its one `session` job in the write
    that stores them (`append_turn`, `storage/sessions.py`; a cut-off, stopped or failed
    answer holds nothing), each pushing the wait forward by `Storage.session_idle_seconds`.
    `POST /api/memory/sessions/release` ends the wait: the window sends it when the
    reader leaves, and with no body at launch, since closing the app sends nothing. **An
    exchange is evidence only if it rested on something other than Memory**
    (`gather_session`): a document the answer held or opened, a passage the reader
    selected, or the web while `memory_web_evidence` is on, read from what is stored with
    the answer, never from its prose. So Memory never feeds on itself; an answer is never
    a source, and its claims cite what it rested on. `memoryFiledThrough` has three values
    (`jobs.unfiled_exchanges`): a request id is "filed through here", `""` is "from the first turn", and null, like an
    id the thread no longer holds, is "nothing to file", never "all of it". The first
    whole answer of a conversation with no usable watermark stamps it just before that
    exchange, so a later turn never files the history. `commit_session.settle` advances
    it on `filed` and `nothing`, never on `failed`.
57. **Dashboard reads are derived and model-free.** Thumbnails are derived bytes
    written before their metadata. Web captures pin the source and discovered asset
    hosts to validated public IPs. Existing documents get
    placeholders without a load-time write. A failed capture logs why, with the tail of
    Chromium's stderr. `_capture_slot` is a process-wide semaphore of one, and a capture
    that cannot get it declines rather than queueing. Why: `delphi_core/dashboard.py`.
57a. **The Dashboard read reads records and nothing else.** It is on the critical path
    after login, so projects load through `list_projects_with_papers` (one query, not
    `get_project` in a loop), and `dashboard_payload` **does not take an `ObjectStore`**:
    a read that cannot reach the object store cannot regress into paying for it, a cost
    that cannot be seen locally. Before adding a field here, ask which writer fills it.
57b. **Thumbnails carry renderer versions and remember failed attempts.**
    `thumbnail_fields` stamps attempts without clearing a saved preview; creation,
    engagement and the thumbnail backfill generate bytes, while retries belong to an
    engagement rather than the document's lifetime. Read `delphi_core/dashboard.py`.
57d. **Display order and palette order are two different orders.** The carousel sorts by
    recency; the library rail and sidebar tree never do, because people build a habit
    around them. `accentIndex` is stamped before the sort and the client colours from
    it, never from position.

**Model requests**

12. **The cached prompt prefix is an architectural asset.** `tools` is omitted entirely
    when empty rather than sent as `[]`, and is otherwise the same array, in catalogue
    order, on every round of a turn; the open PDF is first and carries a cache
    breakpoint, `project_library_blocks` follows with its own, ahead of @-referenced PDFs;
    nothing in it says what is open;
    `prompt_cache_key` is scoped to user + project + paper/project mode. If
    you change the shape of the prefix, bump `PROMPT_CACHE_VERSION` in `chat.py`.
13. **The growing `conversation` list is the only memory, and the last turn must be able
    to answer.** `store: False`: the provider remembers nothing, so `harness.loop`
    replays each round as `REPLAY_POLICY` says; `TurnBudget` bounds reads. The
    closing round keeps its tools and sends `tool_choice: "none"`.
13a. **A response is finished only when the provider says so.** Only
    `Terminal.COMPLETED` is stored as complete: a cut-off answer is kept as cut off;
    a cut-off artifact is an error.
15. **Tool failures return prose, never exceptions.** `read_webpage` answers "no such anchor,
    here are the ones that exist" so the model corrects itself; raising takes the stream
    down. A call to a tool the request did not offer is refused the same way: the
    offered set is the allowlist.
16. **A web document reaches the model as an outline** — titles, anchors, word counts.
    Never attach its full text: a few hundred tokens a turn instead of twenty thousand.

**Personas**

26. **A conversation references a persona; a project has none.** `chat_threads.persona_id`
    is nullable and deliberately not a foreign key: no key can name a persona that has no
    row. NULL resolves to `DEFAULT_PERSONA_KEY` at read time. Two
    writers keep the column true — the stream stamps whichever persona answered, and
    `PUT /api/chat/persona` records a pick made before anything is asked. **A dangling id
    is an ordinary state**, resolving to the default; an id named explicitly in a live
    request is still a 404. That asymmetry is `personas.persona_for_turn`, and **every
    scope resolves through it**, before any replacement drop. The client names only a
    pick made this session, never an id it loaded. **Both officials are read-only**
    (`PATCH` is 409), and `tutor`/`researcher` are unknown ids with **no alias**.
    Incident: ARCHITECTURE.md §Incidents "the pill that lied".
27. **A published persona is forked on install, never resolved.** Nothing another account
    owns is ever read while building a model request — that fork, not a permission check,
    is what makes running a stranger's instructions safe, and why an author can edit,
    unpublish and delete without reaching anyone. `resolve_persona_for_request` in
    `personas.py` is the single place ownership is established. There must not be a second.
28. **What changes every turn goes last in the input and never into `instructions`.** The
    selected `<reader_memory>` block sits after every cache breakpoint; anywhere earlier
    and one new page invalidates every cached PDF and digest block. For the same reason
    the persona's identity and revision belong in `prompt_cache_key` and the memory
    revision must not.
29. **Memory tools are not persona capabilities, and none of them writes.** With the KB
    switch on, every persona receives the Memory tools and `view_figure`; style belongs
    to `<persona>` and account memory does not. No chat tool writes Memory: a web
    page could ask. The two tools that write (`Tool.writes`) are offered by
    `memory.maintain` alone, held by `write_problems` in the structure test (65); the
    domain composer has neither. Web search is the task's (`ModelTask.web`), not a
    request's.
30. Listings never carry persona bodies: `browse_personas` returns metadata, `get_persona`
    one body at a time. Same argument as 16.
62. **One composer writes every chat instruction.** `harness.prompts.compose_instructions`
    builds both scopes in one order: evidence rules, the scope's section, a working
    method generated from the offered tools, building on what the reader has,
    presentation defaults, the wrapped persona, then `explain_contract`.
62a. **What the reader has read is the done mark, shown, never stored.**
    `memory_harness.read_state` prints a `Reader:` line on each page put before the
    answering model, from `doneAt`. Chat never infers or records it. The line ends
    `asked about <date>` when a session's chat revised the page, read from
    `Storage.page_history`: one read per open for every chosen page, and gone once
    `VERSIONS_KEPT` later revisions push that row out. It lets an answer say the reader
    asked about this before, never that they read or know it (`harness/association.py`);
    a concept or domain page citing a capture says so (`OUTSIDE_EVIDENCE`).
62b. **An outside claim cites a captured passage.** `harness.evidence` keeps only the
    research leads whose quote is on the fetched page; an `external` citation names a
    capture and section. Captures are immutable; uncited ones are reaped.

**Memory**

35. **A Memory page cites, or it is inference.** Body markers and the citation list are a
    bijection, and every locator is checked against a real page count, a stored anchor or
    a note that exists. Never invent a locator, and a figure locator *is* one. An invented
    one is refused, never repaired, because a silently corrected locator opens the wrong
    page. The maintenance agent may cite only the closed evidence set its job gathered
    (`cite.check_citations`): what `gather` left out cannot reach a page.
36. **What Memory puts in a request is bounded; the rest is reached by tool.** A Project
    question gets at most `SELECT_MAX_PAGES` pages within `memory_inline_max_chars`: the
    open document's own page, then what bears on the question.
36a. **An invented locator is refused (35); Delphi's own bookkeeping is repaired.** A
    body disagreeing with its *own* citation or figure list is Delphi disagreeing with
    itself: the stray
    `figure:` reference or `[E<n>]` marker is stripped and the page kept. Ask of any
    repair whether something upstream already decided using the value it changes.
36b. **A source figure is named by an exact capturable inventory ID, never a page or
    URL.** A digest names an element of its document's bounded inventory and Delphi
    captures it by that ID (`capture_candidate`). A failed scan is unknown (`None`),
    never "this PDF holds no pictures".
    **Where a Python validator refuses a value from a closed set, the schema should have
    made it unsayable.**
36c. **Repair in the direction of the work the model actually did.** A digest asset
    whose anchor never reached the prose is still placed, at the end
    (`_embed_digest_assets`); an embed of an asset already declared is stripped, not
    printed twice. When a model does one of two coordinated things, check which one
    before deciding it failed.
36f. **A document's page is derived, never authored.** The `source` page is its research
    digest copied (`source_page_from_digest`), bytes before rows, written when the digest
    is published (`file_republished_digest`) and, for a document that has a digest and no
    page, by `ensure_source_page` inside its job. No model writes one: the write tools
    refuse to edit a source or domain page and create concepts only (`admit.py`). **A
    guarantee that must hold *across* filings belongs in construction, not a validator.**
    The slug is
    reused **only by exact provenance** (a `source` page already carrying this
    `sourcePaperId`) or the reader's answer (`memory_same_document`), the paper id
    suffixed onto every other occupied name, because a
    domain page's slug *is* its domain name. Its citation cap is defined *as*
    `DIGEST_MAX_CITATIONS`. A new one is filed under `general`, and the first job that
    writes a concept from it moves it to that concept's domain
    (`commit._join_its_concepts`). Its title follows the document's rename; its slug
    never does (`sync_source_page_title`).
36g. **A page's figure rows are replaced with its body, never added to it.**
    `commit_memory_update` drops the figure rows of every page it rewrites before
    inserting the new ones, in the same transaction, handing orphaned keys back so bytes
    are reaped *after* publication. The per-page ceiling counts *rows*, so accumulated
    ones end in a 409 every retry reproduces. So an edit hands its page's figures back in
    the same commit (`commit._records`).
37. **A page body carries text and Delphi locators, never third-party URLs.** `figure:<id>`
    and `[[slug]]` only, enforced on both sides: the validator refuses a remote address and
    `figureSrc` refuses to render one. A chat answer is not a page: it may link the web, and
    its cited addresses are stored with it as `sources`.
38. **Figures cost no tokens until asked for.** `open_memory` and `read_url` serve captions
    and ids; `view_figure` attaches exactly one image, bounded by `memory_figure_max_views`.
    A source read's figures are turn-local (`source_figures`) and cut only when asked for.
39. **The block and Memory tools are unconditional when the KB is enabled.** The block
    sits at input position −2, after every cache breakpoint, so it cannot invalidate a
    cached prefix and can go to every persona. Persona rows carry no capability flags.
40. **One trace per answer, built once and used twice.** `AnswerTrace` records, per
    stretch, what the answer was handed, each call from the model's first word,
    and its reasoning summaries. Each change is a `trace` event; `stored()` is their
    result, unfiltered. Thoughts and unrun calls are not evidence: filing reads
    `tool_entries`; history keeps `role`/`content`. Offsets are UTF-16; times are ms
    from the request.
41. **A KB write names the account, never a project.** Papers and projects are provenance
    only, so filing a paper elsewhere or deleting it leaves Memory intact and its
    citation dangling.
61. **A page rewrite changes prose and nothing else.** `POST /pages/{slug}/rewrite` queues
    a `page-rewrite` job for one `concept` (422 for any other kind), and
    `validate_page_rewrite` refuses a draft whose `[[link]]` set,
    `[E<n>]` markers or figure references differ from the stored page's by one element. So
    the graph cannot move and figures cannot be regenerated under fresh ids (36g). It is a
    *different* operation from a document's job: it runs on `memory.maintain`, is checked
    on `memory.verify`, is told two sections of `contracts/maintain.md` so the two
    authors cannot drift, and reads the documents the page cites and nothing else of
    Memory. It owes its domain a composition only when it changed the summary (74). Its
    marker carries the revision it was queued against, so a crash after publication
    recovers as `reused`.
43a. **A domain is a record; the slug on a page is its denormalised filter.**
    `memory_domains` owns a domain's existence, title, ordering and `origin`;
    `memory_pages.domain` stays a `String(60)` and is deliberately **not** a foreign key
    — it is the hard filter every read already runs, and `upsert_memory_page` writes the
    missing domain itself in the same transaction, *before* the page row. `origin` never
    downgrades from `reader` to `model`, and a slug never moves: a rename changes the
    title only.
74. **A domain's page is written by its job, and by nothing on read.** `domain.py`
    composes it on `memory.domain` with the read tools alone. It is given the domain's
    record, each member's kind, title, summary, headings and opening, the links among
    them and what moved since the last composition (`gather_domain`), and may cite only
    the documents its members cite. **Its answer is its write**: addressed operations,
    or a whole page where there is none, in the strict format the same request carries,
    held to `admit` and the checker like any staged page. The store queues the job when a
    page joins, leaves or is deleted, a member's summary changes, or the domain is
    created or renamed (`storage/domains.py`); an edit under the same summary owes
    nothing. It waits `Storage.domain_settle_seconds` after the last change, so a burst
    is one composition; `POST /domains/{slug}/compose` and Update release it. `general`
    is never written, nor a domain under `jobs.DOMAIN_MIN_MEMBERS` source and concept
    pages, and unchanged members cost no model call (`domain_fingerprint`). **A domain
    with no written page has none**: its slug is a 404, and no read writes one. A
    written domain page may be chosen for an answer (`selected_slugs`) and is never a
    neighbour: it links to everything in its domain.
75. **One document's value for another is never written as the other's own**
    (`gather_crossref`; the domain page compares).
44. **General chat is shown the whole index and chooses by meaning.** `memory_harness.py`:
    every project, document, recent chat and Memory page, by name, summary and links —
    first in the input, identical for every question, so it is that scope's cached prefix
    (what is open rides beside the question, never in it). Summaries shorten to fit; no
    page is dropped. `open_memory` returns the pages the model chose and the start of
    what they link to, never through a domain page. No chat writes Memory while it
    answers (29); what it leaves is filed with its session (73).
44a. **History is ten complete exchanges in every scope.** `complete_exchanges` pairs
    by request ID only — a turn without one never pairs — omits cancelled/unanswered requests and
    orphan answers, and deduplicates delivery. Selected passages survive projection; traces
    do not.
44b. **Rails consume backend distances, not a second graph walk.** Both use stored
    incoming/outgoing links, `memory_related_hops` defaulting to two and validated zero
    through four. Reader centers require a real source page (32c). Domain membership
    creates no rail shortcuts.
46. **The KB chat never re-asks a question it has already asked.** Ask opens in the right
    rail on `/memory` (`?ask=1`); `?q=` seeds one turn and is dropped the moment it
    is used. A ref stops a re-render from re-sending; only clearing the address stops a
    *reload* spending another model call on an append-only thread. The persona it
    snapshots is style, never evidence or leave to skip the memory-first ladder.
47. **A re-filing pass proposes; the reader applies.** `propose_reorganization` writes
    nothing; `validate_reorganization` drops, rather than raises on, any move naming a
    page or domain that does not exist, and `POST /pages/move` writes once the reader has
    ticked what they accept. Re-filing is where a model is most likely to be confidently
    wrong about what a page is *about*. A domain page is never moved: it *is* its domain.
48. **A health finding Delphi can compute is computed; the model is asked only for what
    only it can see.** `build_memory_health` derives orphans, uncaptured figures and
    dropped targets from the records, with no provider. Only contradictions go to a
    model, and **lint reports and writes no page**: a finding is kept only when it quotes
    each page it names in words that page holds (`validate_memory_audit`), and each
    one kept queues a `reconcile` job (`queue_reconciliations`) that the pipeline runs
    with no selection call, on what those pages already cite. `lint_memory` calls the
    health **once** and uses it twice — the model's labelled input and the event's record
    — so the reader's counters and the model's numbers cannot disagree. **A dropped
    target is what a document's last job staged and could not write**, read from the
    newest event across the document's marker and its follow-ups (`latest_marker_events`,
    the whole log), so only a later job of the same document clears it;
    `document_filing_status` is the one predicate every surface shares.
49. **A Memory event's body only ever grows.** `pages` stays a `list[str]`, as
    two live readers iterate it as strings; `edits` carries title, kind, `action` and the
    pass's one-line `note`, and `eventEdits` is the one place the two shapes reconcile.
    `action` is **computed**: `revision` starts at 0 and increments on write, so
    `revision == 1` is exactly "created".
50. **Automatic KB maintenance is durable foreground work.** A unique account/marker
    `document` job is written before the paper it files becomes visible (`add_paper`), and
    again, with the digest's fingerprint, when a digest is published. Sessions (73),
    domains (74) and lint's `reconcile` jobs (48) queue theirs; marking a paper done or
    returning it to Active enqueues nothing. Claims have expiring leases; transient
    failures retry after bounded delays and the third stays inspectable until the reader
    retries it; a page that moved on under a job (`StaleRevision`) is due again at once.
    A move rewrites queued paper provenance; deleting a paper, thread or project removes
    the queued work whose authority it destroys. Completion removes a job only after its
    event exists, and only against the fingerprint it names (69). `retryAt` means one
    thing whatever the status: not claimable before this time (`job_is_due`). That is how
    a session waits for its reader and a domain settles: an enqueue naming `not_before`
    pushes the wait forward, and `release_memory_jobs` ends it. `HELD_JOB_KINDS`, the
    kinds no claim takes yet, is empty.
50a. **A long pass stays audible, and no job is permanently the queue head.** Streams answer
    only through `delphi_core/sse.py::event_stream`; no route builds its own
    `StreamingResponse`. Liveness is not progress — say progress in your own frames.
    `claim_memory_job` orders by kind (`DOCUMENT_JOB_KINDS` first), then fewest
    `attempts`, then oldest: `attempts` counts *claims*, so a strict `createdAt` order lets
    one abandoned drain hold the head forever. Catch `asyncio.CancelledError` **by name**
    and `release_memory_job`: `except Exception` cannot see it. Fail a job at
    `memory_job_max_attempts` on the way past rather than skipping it; a lease fences
    every mutation. Enqueue from the *storage method*, not the router, and liberally: a
    session's and a domain's marker is stable, so a burst of changes is one job. The pump
    (`startMemoryMaintenance`) is idempotent and module-level, re-drains on focus,
    visibility and five minutes, does nothing while hidden, probes once, then runs three
    workers. Incident: ARCHITECTURE.md
    §Incidents "the queue that never drained".
50b. **A durable row may name a version; it may never say "skip the check".** The drain
    writes the event *then* removes the job, so a row carrying `force` would file the
    same reading twice. The row carries `targetVersion`, the `MEMORY_VERSION` it was
    queued *for*, which also stops a later deploy upgrading every pending job;
    re-enqueueing reconciles that field only on a row no worker holds
    (`job_payload_is_upgradeable`). **Owed work is identified by the record, not a flag**,
    before anything is queued (`document_filing_status`).
43. **Descend the ladder, never skip it.** A Project question: the open document, the
    project's own (`search_library` there is project-only), then Memory. No word match
    picks Memory pages (`select_reader_memory`). `document_sections` is derived and rebuildable, so it is never
    the authority for what a document says — the stored `.txt`/`.web` objects are.
65. **A write tool stages; only the commit stores.** `edit_memory` and `create_memory`
    are adapters over `admit.stage_edit` and `stage_create`, which run every deterministic
    check and either stage the page in the run's `MemoryDraft` or answer `Error:` with
    what to change (15). An edit names blocks of the page as `open_memory` showed it and
    never carries a body, so a block no operation names is kept byte for byte
    (`ops.apply_operations`), and a citation or `[[link]]` may leave only with a stated
    reason (`validate.preservation_problems`). A create is refused while a page has the
    name, or may explain the same idea (`select.same_idea`). The kind
    is not an argument: both write `concept`.
66. **The pipeline's layout is a rule, held by `test_harness_structure.py`** (G5, G9,
    G11, G12): no stage imports a router or another stage, only `pipeline` imports
    stages, a `run.py` type is the hand-off, one stage loads each contract,
    `BELOW_THE_HARNESS` imports no harness, router or `memory.py`, `__init__` stays
    empty, and modules stay under `HARNESS_MODULE_MAX`.
67. **The checker reports; Delphi decides what blocks.** `verify.is_blocking`
    blocks a page only on an objection Delphi can find in what the checker was shown: one
    of four findings, a quote present in that page's changed text, and for an unsupported
    claim a source whose passage it read. Others are advisory, kept on the event. The verdict is per page (`verify_round`): a claim its cited passage lacks
    first gets the passage of its document that holds it (`verify_recite`); then one
    repair; only what no passage holds is struck, after check 2 too; later checks see
    only what none passed, three at most; then it is dropped.
    **An answer that cannot be read raises** (`SelectionUnreadable`,
    `UnreadableVerdicts`); it is never read as "nothing to file", "no page explains
    this" or "no objections".
68. **A commit is atomic, and under the revision the agent read.** `commit.commit` is the
    only call in the pipeline that stores a page: pages, their version rows and the event
    go through `commit_memory_update` in one transaction, fenced on the job's claim
    (`fence_job`), with `require_revision` so a `concept` or `domain` write naming no
    `expectedRevision` is a 422 and a stale one a 409 for the whole commit
    (`StaleRevision`: nothing written, the job runs again, no attempt spent), as for a
    create another job's page took (`verify_round.refuse_taken`). A
    `[[link]]` resolves to a page that exists or is created in the same commit, or is
    stored as its words (`validate.repair_links`).
69. **A job's operation is its id, the version it was queued for and the fingerprint it
    read.** `event.operation_id` stamps that on the event, and after gather the pipeline
    asks `has_memory_event(marker, operation_id=…)`: a job that committed and died
    before it left the queue answers `reused` with no model call. A fingerprint is a hash
    of what the job read (`jobs.document_fingerprint`: the digest), and
    `complete_memory_job` keeps the row when the stored one moved during the work, so
    nothing is marked filed that the pass did not read. A republish that changed nothing
    queues nothing. **A `session` or `domain` job completes against the fingerprint it was
    claimed with**, not the one it read: its row names the last change
    (`jobs.session_change`, `domain_change`), so a turn, a note or a change to the domain
    that arrives during the work keeps the row for one more pass; a session's operation
    names that change too (`event.operated_on`). A failed job's event carries the marker
    but not as its `requestId`: the marker says "done", and a failed job is retried.
70. **Text Delphi did not write is fenced, and cannot close its fence.** A digest, a
    captured page, a note and a chat enter a brief only through `brief.fence`, inside a
    tag the contracts name as material and never instruction; a spelling of one of those
    tags inside the text is defused first. The names live in `brief.py` once, and a test
    holds each contract to the list. The checker's request does the same for its own tags.
71. **The local store migrates once, at construction.** A profile on a reader's machine
    has no migration runner, so every `LocalStorage` construction calls
    `local_format.open_store`, and each account carries `memory/format.json`
    (`knowledge/format.json` before format 5). A step writes what it will delete into
    the marker *before* it deletes anything and the new
    format number last, so an interrupted run finishes from its own record. Format 2
    (three page kinds, four claim types; all of Memory kept in `knowledge.format-1`),
    format 3 (the listings that stood in for a domain's page go; the page files touched
    are kept in `knowledge.format-2/pages`) and format 4 (plans older than schema
    version 4 go with their captures; no copy, revision `a3c8e5f20d61`) and format 5
    (`knowledge/` renamed `memory/` in one `os.rename`, after `knowledgeUpdate` and the
    `knowledge_base_chat` kind are rewritten, with copies in `knowledge.format-4`;
    revision `0d70a9dd6ead`; a file named `knowledge` then holds the directory's place,
    so a release before format 5 refuses the profile instead of taking it for format 1).
    An account holding both directories is refused, not merged, and the bulk commands
    refuse a store not at the current format. The
    rules block in `local_format.py` is the text of revisions `b7d2f4a6c931` and
    `d6f2b8e41a57`, copied and never imported; `test_memory_retirement.py` holds the
    three equal, and none is edited alone.
72. **Three page kinds and four claim types, enforced at the durable write.**
    `MEMORY_KINDS` is `source`, `concept`, `domain`; `MEMORY_CLAIM_TYPES` is
    `author-claim`, `external`, `reader-note`, `derived`. `check_page_shape` refuses any
    other on every page write. `external` cites only a capture in the evidence set; only gather reads
    `memory_web_evidence` (`gather*.py`), and an answer's web paragraphs never reach the
    agent. Off, a digest's are cut too and the write tools refuse `external`
    (`cite.check_citations`); on, `gather_outside` re-grounds what answers cited and asks
    `needsOutside`, eight hosted calls a job.

**Layout**

31. **No column carries a pixel floor the window might not have.** A grid wider than its
    viewport overflows, and the chat panel goes off the right edge with nothing to scroll
    it back. The reader's minimum lives in the divider constraints, which re-clamp on
    window resize as well as on a drag.
32. **Below `COMPACT_WIDTH` the library is the panel that yields.** It opens as its rail,
    and expanding it *floats* over the reader rather than taking a column. Every panel
    names its own `grid-column`, or an absolutely positioned child lets auto-placement
    slide each later panel one track left. Below the stacking breakpoint the chat has its
    own row, so the float is scoped above it. The Memory graph is the one pane allowed
    out of the page column.
32a. **Controls must communicate their scope.** `SearchOverlay` is account-wide,
    document Find belongs to the browser, and pressing Ask Delphi preserves the open
    page; sending from Map or Health opens the Memory conversation.
32c. **The Reader opens on Related Memory; a conversation is summoned.** The right
    column is `RelatedMemoryRail`, centred on the page written *from* the open document;
    chat docks **above** it and pushes it down (`kb-rail-split`, by DOM order). A document
    nothing points back at gets an explicit card and a **File it now** button, never the
    nearest unrelated pages. **Provenance is not identity**: every concept created from a
    document carries its source page's `sourcePaperId`, so the centre is the `source`
    page, never the first match. `PanelDivider` takes the custom property it writes as a
    parameter. Bounds live in `constrain`, never as a CSS floor (31).

**Navigation**

21. **The URL is the only record of what is open.** No `setProject`/`setPaper` exists; both
    derive from `useParams`/`usePathname` on every render, and `?chat=paper|general` marks
    the docked thread. `detail` is only a one-project cache: async mutation refreshes must re-check
    `readerLocationRef` before replacing it, and background work must not navigate after
    the reader moves.
22. **The workspace mounts in `app/(reader)/layout.tsx`, never in a page.** A layout
    survives a change to the segments below it; a page does not, so moving it remounts
    pdf.js, the chat thread, the panel widths and the zoom on every document switch. So
    no `loading.tsx` or `template.tsx`.
23. **Paths resolve on the trailing id, never the slug.** Names are not unique and can be
    renamed; ids cannot contain `-`, which makes the last-hyphen split safe.
24. `?next=` is a destination a stranger can choose, so it goes through `isSafeNext` on the
    way in *and* out — same-origin path only, never an auth page, or signing in loops.
25. A document that cannot be opened gets **one card and one wording** for every cause. The
    API answers 404 identically for "deleted" and "not yours"; branching the copy on the
    reason would leak what that 404 exists to withhold.

**Configuration truth**

17. **Limits live in `Settings` and are published through `/api/config`.** The client checks
    before uploading for a fast failure; the server enforces regardless. Do not hardcode a
    limit in the frontend — `DEFAULT_APP_CONFIG` in `lib/api.ts` is only the pre-response
    placeholder and must be kept in step with `config.py`. API keys stay on the server:
    nothing model-related is ever prefixed `NEXT_PUBLIC_`.
59. **A visual is selected evidence, never a quota.** An image merely being present
    creates no obligation (36b). QR and
    barcode candidates are rejected unless that is the teaching objective, duplicates cannot
    both publish, and a failed capture disappears rather than becoming a remote hotlink.

---

## 6. Design principles this codebase already commits to

Not advice in the abstract: each point is a decision already made here, with the file that
makes it. Hold new work to it.

**Put the boundary where the swap is.** `Storage` holds records, `ObjectStore` holds bytes,
and neither exposes a filesystem path — the web app's implementation has none to expose
(`storage/base.py`). An abstraction that leaks its implementation's vocabulary has not
abstracted anything.

**Prove the swap with one test suite.** Every store runs the test kit's store tests
(`delphi_core_testkit.conformance`) through its own harness — two implementations without
a shared suite is two products.

**Design the failure mode out, don't patch it.** The filesystem backend stopped writing a
`projects.json` summary because it duplicated `meta.json` and the two could drift after a
crash; the list is derived now. Chat is append-only so concurrent tabs cannot clobber.
Properties, not fixes.

**Order writes so every crash point is survivable.** For each step ask: if the process dies
here, what does the next request see? The answer is always "an unreferenced object", never
"a record pointing at nothing".

**Validate at the edge, once, in a type.** Every request body is a Pydantic model in
`schemas.py` with real bounds (highlight rects `0..1`, prompts at 50k, `referenced_paper_ids`
at 9), so handlers work with values already legal.

**Treat the model as an untrusted, expensive, streaming peer.** Untrusted: a persona is
wrapped in `<persona>` and labelled style, never evidence. Expensive:
the outline-plus-tool pattern, `detail: "low"`, prompt caching and a per-turn read budget
control what one question costs. Streaming: one SSE channel with a small typed vocabulary,
and one stored trace of how each answer was reached.

**Bound every agentic loop in the dimension it actually grows** — turn count, per-read
characters, history window, output tokens, request timeout. A loop without an explicit
bound on the thing that grows is an incident waiting for a long document.

**Isolate untrusted content by construction, then check the property, not the config.**
Rather than enumerating every way a page might escape, the web-document design holds one
invariant, *the frame only ever shows a document Delphi served*, enforced by a hello
every served document emits and every `load` must claim. Hellos are *claimed*, not
counted or flagged: a boolean would still be set from the previous document, and a
running total drifts permanently after one miss.

**Distinguish gestures that look similar.** Zoom re-lays-out; pinch magnifies a compositor
transform, or pdf.js re-renders per wheel tick. The rule is implemented twice,
`PdfViewer.tsx` and `web_bridge.js`, because pinching a page and a paper must feel
identical; keep them in step.

**Make the expensive path lazy and the first use warm.** PDFs upload to the Files API on
the first question, not at upload time; the pdf.js engine is a module-level promise warmed
while the library loads, because the cold import — not the file fetch — made the first
paper slow.

**Comment the "why", never the "what".** Every non-obvious decision here carries the
observation that forced it: which site broke, which cap applied, which race was possible.
A comment naming the failure that would otherwise recur is why this manual can stay short.

**Let tests encode the invariant, not the implementation.** The layering checks (A1–A8)
read the import graph and the public surface because what they catch is invisible to every
behavioural test; `rendered-html.test.mjs` checks that the highlight
colour the browser paints equals the one the backend burns into an exported PDF. Test
names read as sentences.

**Assert the intent, not the spelling.** An assertion that pins a tagline, an `<option>`
element or palette hex literals fails when the product improves, and teaches people to
ignore the suite.

---

## 7. Extending it

| You want to | Do it here |
|---|---|
| Another storage backend | Implement `Storage` + `ObjectStore` outside core, importing only `delphi_core.storage` and `storage.rules`, and run the kit's store tests against it through a `StoreHarness` |
| Different retrieval (chunking, embeddings, rerank) | `build_responses_input` in `chat.py`; the route stays stable |
| Add a tool | Its domain function, a module in `harness/tools/`, `CATALOGUE`, the profiles that offer it, and, when a chat profile offers it, a `TRACE_TOOLS` row in each frontend; `test_harness_structure.py` holds all five |
| A tool that returns an image | Its `ToolResult` image: `registry.Toolset.dispatch` sends it inside that call's function output, so every provider adapter carries images there, never as a new user turn |
| A tool that writes Memory | The same, with `writes=True` and `BudgetClass.WRITE`, staging through `memory_maintenance.admit` and offered by a maintenance profile only. It never calls a store method: the commit stores (65) |
| A stage of the pipeline | A module in `memory_maintenance/` named in `STAGES` in `test_harness_structure.py`, called from `pipeline.run_job`, taking and returning types of `run.py`. A split stage keeps its name in front (`maintain_prompt.py`) |
| A contract file | `contracts/<stage>.md`, loaded by that one stage; then `[tool.setuptools.package-data]` in `pyproject.toml` and `RUNTIME_FILES` in `scripts/backend_release.py` (§8) |
| A kind of job the pipeline files | Its marker and fingerprint in `jobs.py`, a `gather_<kind>.py` in `pipeline._GATHER`, the kind in `run_maintenance_job`, and `event.trigger_of`. A kind that waits enqueues with `not_before` from the storage method (`storage/sessions.py` is the worked example) |
| Another official persona | A frozen `OfficialPersona` in `personas.py`; no migration, no row |
| A reader-facing domain operation | `Storage` domain methods, then `routers/memory.py` `/domains`; never rename a slug |
| A per-conversation setting | The record literal in `local.py`'s `_scope_conversation`, every thread reader answering the key (never omitting it), and a kit store test, which the web's store must also pass (with its own migration). `persona_id` is the worked example |
| A per-paper child collection (notes, highlights) | The `Storage` ABC, `local.py` and its `_paper_scoped_paths`, a kit store test, then a thin router |
| Another Memory page kind or claim type | `MEMORY_KINDS` / `MEMORY_CLAIM_TYPES` in `storage/base.py`, the `Literal` in `memory.py` and `schemas.py`, and a local format step (72); the kit's store tests hold every store to it |
| Another derived artifact | A `ModelTask` row in `model_tasks.py` naming the `Settings` fields it fills, so the mapping stays readable in one place and `ORCHESTRATOR_MODEL` still moves every unpinned task |
| Another provider | Behind `api_base_url` / `api_key`; turn off `OPENAI_PROMPT_CACHE_ENABLED` and `OPENAI_SERVICE_TIER` if it lacks them |
| Another maintenance job kind | `MEMORY_JOB_KINDS` in `storage/base.py`, a `run_maintenance_job` branch, and a kit store test. A retired kind needs a local format step: a local queue drops no unknown kind on read, and `local_format.JOB_KINDS` is format 2's list, not the live one |
| Another streaming route | Return `delphi_core.sse.event_stream(...)`. Never build the `StreamingResponse` yourself — the heartbeat and the anti-buffering headers are the whole reason it exists |
| A new limit | `Settings`, then publish it through `/api/config`, then read it in the client |
| Another health finding | Ask first whether the records already answer it. If they do, a function in `memory_health.py` and a key on its dict — no prompt, no route, no provider. Only if they genuinely cannot, a field on `KnowledgeAudit` and a paragraph in `MEMORY_LINT_SKILL`: an audit reports, and is never a page update (48) |
| A bulk maintenance command | A module in `backfill/`, calling the shipped routine rather than a copy of its skip test — and **name the version its algorithm stamps**, or it has no skip test and cannot be resumed |
| A schema change | The change in `local.py` and a kit store test. One that must rewrite stored local data is a step in `storage/local_format.py` with `LOCAL_FORMAT` bumped (71) |

Any change to a stored record shape must be asserted in the kit's store tests
(`delphi_core_testkit.conformance`), which every product's store runs.

---

## 8. Traps

Roughly sixty of these have their full reasoning as a comment or docstring at the file
named — this section is the **index**, not the argument. `Why:` points at the copy that
is kept current; **read it before changing the rule.**

**Configuration**

- `Settings` reads `env_file="../.env"` relative to the process CWD. A product passes its
  configuration explicitly (the desktop passes all of it through `backendEnv`).
- **A subprocess that hides its stderr cannot be debugged.** A failed browser capture
  logs the tail of Chromium's stderr (`browser_render.py`).
- **Put a model or an effort in `MODEL_TASKS`, never in a deployment's environment**: a
  deployment runs on code defaults. Why: `delphi_core/model_tasks.py`.

**Storage**

- Storage is synchronous on purpose; the SSE generator in `chat.py` runs on the event
  loop, so every storage call there goes through `run_in_threadpool`.
- **A project is one `meta.json`, so every filesystem record change is a read-modify-write
  of the whole file.** `@serialised` puts a re-entrant per-project lock around each;
  `move_paper` takes both projects' locks in path order. Every writer takes the project lock
  *before* `PERSONA_LOCK`. Why: `storage/local.py`.
- `fetch_to_tempfile` serves the **ten** callers needing a real file handle; **every one must
  `unlink` in a `finally`.**
- `LocalObjectStore._path`/`delete_prefix` map object keys explicitly, so a new key shape
  is a 400 until it is added — and the retention sweep must learn it too. Ask
  `_scope_thread` for a thread's kind rather than deriving one inline.
- `document_sections` is written *after* the paper record and a failure is logged, not raised
  (`index_paper_sections_safely`): a row for a paper no record names surfaces a hit the
  reader cannot open, and a raise answers a completed upload with a 500.
- **The research digest is not in the database, so nothing may search it per query**:
  matching `contentMarkdown` inside a `.digest` object would be one object read per
  document per keystroke (57a). `document_sections` is the derived search index;
  anything else wanting to be searchable has to get itself into it first.

**PDFs and the browser**

- **PDFium runs in a child process, and that is not optional.** A PDF whose Type 1 font
  needs substituting makes PDFium `abort()`; a native SIGABRT runs no Python handler, so
  one bad upload kills the container and every request in flight on it. `run_isolated` spawns
  `delphi_core.pdf_worker`, `None` for every failure; never `ProcessPoolExecutor`, which poisons
  itself on the first abort. Four fused operations (`pdf_worker.OPERATIONS`), the
  only boundaries where no live `PIL.Image` crosses; **another pdfium entry point means
  another operation**, as the card thumbnail became after concurrent uploads aborted the
  server. Why: `pdf_figures.py`.
- **Every child goes through `spawn_clean`.** `Popen` with `preexec_fn`, `cwd`,
  `start_new_session` or `close_fds` forks the server; on macOS that crashed captures.
  Why: `clean_exec.py`.
- `PAGE_MARKER` lives in `document_index.py` and is imported by three modules —
  `routers/chat.py`, `source_inventory.py`, `memory.py`. Two regexes over one stored
  format is how a page lands under the wrong number.
- Selection, clicks, citation jumps and zoom cross the web frame as `postMessage`, because
  a cross-origin document swallows clicks. A linked PDF must not use Chrome's MIME-handler
  iframe — it cannot expose selection — so `Workspace` sends it to `PdfViewer` with the
  content-checked `/page` route as `fileUrl`; `PageViewer` stays HTML-only and sandboxed.
- An interstitial can be longer than the article it replaces, so length cannot decide it:
  `is_interstitial` asks whether the page loads the challenge machinery. And a page that
  assembles itself is framed as the browser built it, never as text, with its
  scripts stripped by `static_document` — or they boot again and React replaces everything
  with an empty root. Why: `web_extract.py`, `web_proxy.py`.
- A page with no article of its own and exactly one frame is filed as the document that
  frame holds, like a redirect — but only at import, after the page's own reading, and only
  if the frame reads as an article on one plain fetch. Never guess between frames, never
  render one. Why: `framed_document` in `web_extract.py`, `framed_page` in `web_fetch.py`.
- Live view frames the source's own document; a shell only its same-origin module scripts
  draw cannot load there (modules need CORS), so the view declines to the saved copy rather
  than render. Why: `boots_in_frame` in `web_fetch.py`.
- Both the renderer and the capture validate hosts per request through
  `_public_only_proxy`, which runs `check_public_host` on each CONNECT and dials *the
  address it validated*, closing the resolve-then-connect gap. `base_chrome_flags` takes
  its network policy from the caller: `--proxy-server` and `--host-resolver-rules` are
  mutually exclusive. Direct fetches close the same gap where the socket opens
  (`web_fetch._PublicOnlyBackend`). Why: `browser_render.py`.
- **A product's browser host replaces launching, never backs it up.** With
  `BROWSER_HOST_SOCKET` set, capture, previews and validation ask it for a page and
  never look for a Chrome; the same proxy and reading run over its page. Why:
  `browser_host.py`.
- **An artifact reaches no network, in four layers**: its CSP and opaque sandbox; the
  validator's dead proxy and WebRTC preference (`worker.prepare_profile`; Chrome ignores
  the switch of that name); its nested-frame check, which reads new realms since an
  out-of-process frame reports no `frameAttached` (`BrowserRun.event_loop`); and the
  desktop, which refuses its navigations and ends its process when it nests a frame,
  the one thing no callback can refuse in time. The renderer's memory limit is
  sampled; macOS offers no hard cap. Why: `artifacts/worker.py`,
  `desktop/main/artifacts/navigation.ts`.
- A stored DOM is only correct at the width it was built at, so the renderer stamps
  `data-delphi-render-width` and the panel uses `transform: scale`, never `zoom`. Selection
  coordinates arrive in layout pixels and must be multiplied by that scale; both sides pin
  `--force-device-scale-factor=1`. The window is 1512×4000 because a lazy image needs a
  viewport rather than a longer wait, and the capture photographs static markup from
  `file://` in a separate process, never the live page. Why: `browser_render.py`.
- **A windowed page is grown, never scrolled**: Notion unmounts a block once it leaves
  the view, so once built it is shown the tallest window at once and fitted back,
  bounded by height and time, and a page that only grows blank with its window is put
  back. Why: `_uncover_windowed`.
- **The add never grows a window**: it reads a windowed page at its first window
  (`whole=False`), marks it `capture: "partial"`, and `add_paper` queues a `capture` job,
  the durable queue's one kind no Memory claim takes. The job reads it whole through
  `publish_snapshot`, whose page copy replaces only a copy still `savedPagePartial`;
  the filing waits (`waits_for_capture`). Why: `routers/captures.py`.
- **A render answers what an earlier render of the same site was told never changes**
  (`render_cache`), never a service worker's word, and asks the site for the rest: every render starts empty, so Notion's 721 script chunks
  were fetched on each, and an add and its capture got the machine throttled. A capture
  the site throttles waits ten, then thirty minutes (`THROTTLED_RETRY_DELAYS`). Why:
  `render_cache.py`.
- `render_dom` reads a page over DevTools once its content is still, never `--dump-dom`:
  that waits out virtual time, which stops while any request is pending. Why:
  `browser_render.py`.
- **A helper reached through a shared function is patched where it is defined**, or the
  test passes and does real DNS (`_pinned_public_address`). Names a test patches by
  module are its contract.

**Memory**

- **A `read_url` page is web evidence**, like an answer's `sources`:
  `gather_session._addresses` reads its final address from the trace, so its linked
  paragraphs are cut and it counts only while `memory_web_evidence` is on (72, 73).
- **A page's authors are read from the event log, never stored on it** (`memory_authorship`):
  a filing's marker names its author and its event keeps the author's `title`; upkeep names
  none. Deleting a document or a chat rewrites no page (41), its row greys; deleting a page
  logs one `deleted` edit.
- **A document never takes a page a deleted document left without the reader's answer**
  (`memory_same_document`): two documents can print one title. A likely match parks its job
  (`WAITS_FOR_READER`) until the Related Memory card is answered, and a parked job is
  no one's owed work (`waits_for_reader`); no match files as usual.
- Filing is drained by the window, not by detached server work. Pages upsert by slug, so
  a second filing revises.
- **The contracts are read at import, so they are part of the package.** `select.py`,
  `maintain.py` and `verify.py` load `contracts/*.md` as module constants. The wheel ships
  them through `[tool.setuptools.package-data]`, and `scripts/backend_release.py` and
  `tests/wheel_smoke.py` require them. A contract missing from either list
  passes every test in the checkout and fails the desktop app at import.
- **`reused` answers the same job claimed twice, and nothing else.** A new job is a new
  operation (69) and files its document again, so "is this owed" is decided before the
  enqueue, never left to the pipeline.
- **The store answers 409 for a stale page and for a full account alike**, so
  `commit._stale` reads the revisions again to tell which, and only the first is
  `StaleRevision`.
- **A job whose every page was dropped ends `failed`, on purpose**: it is retried, its
  notes stay unfiled for the retry, and what it could not write shows as a dropped target.
- **A session or a domain that is waiting is not stuck.** Its job is `pending` with a
  `retryAt` ahead, and `maintenance_snapshot` counts it out of `due` by the claim's own
  test. A turn that arrives while its job runs keeps the row and sets the wait again. A
  session job that failed three times is not revived by a later turn.
- **A store method takes no settings**, so the two waits ride on the store
  (`Storage.session_idle_seconds`, `domain_settle_seconds`), set where one is constructed.
- A job's event carries tokens per stage and no stage times.
- The graph and the lint read the whole edge list in one query, and every block lint is
  handed says exactly what it holds: a mislabelled input is read honestly and reasoned
  from wrongly. Incident: ARCHITECTURE.md §Incidents "the lint that called every page an
  orphan".
- `max_output_tokens` bounds reasoning *and* visible output together; at `xhigh` the
  thinking can consume the whole budget and the failure is a truncated unparseable artifact,
  or no output block at all. Why: `config.py`.
- **Three lengths, and the author hears one** (`validate.BodyLimits`). `target` is what
  it is told, `accept` is what Delphi takes, unstated because an author told it may write
  12,000 writes 12,000, and `wall` is the schema's `maxLength`: a body that reaches it was
  cut off there, so the check is `>=` and the page is refused, never trimmed.
- **A stage announced before an `await` describes the wait, not the work.** `run_job`
  yields a `progress` frame as each stage starts (`memory_gather` … `memory_commit`,
  and `memory_domain` for the composer), and
  the stage change is where the drain asks whether the job is still wanted and its lease
  still held. Adding a model call to the pipeline means adding the frame that says what
  it is, or a document sits on the previous stage's sentence for minutes.
- A server progress frame is written for one stream, not every surface showing it:
  relayed into a *list*, a filing frame prints the title twice. `describeFilingStage`
  rewrites it and passes an unrecognised message through rather than swallowing it — the
  stage is the only sign a long filing is still moving.
- **"No page for this document" is four situations, not one**: never filed, still queued, a
  pass that wrote nothing, and a job that gave up. `GET /memory/documents/{id}/filing`
  separates them from the records — no object read, no model call — and each gets its own
  sentence and verb. While a pass runs the card is *only* the progress.
- **A record of client-driven work needs a heartbeat, or it is a record of a lie.** The
  Update pass runs in the reader's browser, so a closed tab would leave a stored `running`.
  The tab stamps `heartbeatAt` on a **timer**, not per document, and `stale` is derived on
  *read*. What the browser may write is **counts only**.
- **An SSE route read through `api()` can never succeed**, because `api()` finishes with
  `response.json()`: the work is done and an error is reported. Every streaming route
  has one client shape: `fetch` plus `readSseStream`, then read the terminal frame.
- **A press that enqueues has to keep saying so.** On the durable queue the request
  returns in a second and the pass takes minutes. **`queued` is progress, not absence**:
  a guard suppresses the button, not the card. Whenever a control moves from streaming
  to queued, ask what used to be true for the length of the stream and now is not.
- **A rule about a page write is enforced at the durable write, against a `prior` read
  *inside* the lock or transaction, never one passed in by the caller.** Two live there:
  `check_expected_revision` (a job's commit, a page rewrite and a digest refresh
  carry `expectedRevision`; a stale one raises 409) and `check_page_shape` (72). Why:
  `storage/base.py`.
- **Automatic digest generation has no second model verifier.** Deterministic validation
  still checks structure, locators and malformed math before publication and preserves the
  previous ready digest on failure.
- **Loading a thread must never *assign* over messages already on screen.** The KB chat
  seeds its first question before `GET /thread` is home. History is what came *before*
  what is on screen, so it is prepended, and every updater reaching for the last message
  checks it is there.
- The sidebar's tree is **derived**, never stored (`buildMemoryTree`). Its optional
  `parents` map wins per page and nothing fills it yet, which is what makes a stored parent
  later a data change rather than a rewrite. Keep it deterministic — nothing may sort on
  recency. Why: `lib/memory-tree.ts`.

**Rendering, layout and notes**

- **A `<figure>` may not be rendered inside a `<p>`.** Markdown puts a lone image in a
  paragraph, so `MemoryMarkdown`'s `p` override drops the wrapper when the paragraph's
  only child is an image. Without it hydration tears down the subtree, presenting as a
  captured figure rendering as its caption alone, with no console error a reader would see.
- Mathematics and tables are one system across the two markdown renderers:
  `lib/remark-latex.ts` is the TeX grammar both parse with, and the table rules in
  `globals.css` name `.message-markdown` and `.kb-prose` together. `remarkLegacyMath` is
  KB-only and refuses anything with the punctuation of a program. Why: `lib/remark-latex.ts`.
- Mermaid is lazy-imported and KB-only, at `securityLevel: "strict"` — a diagram definition
  is model-authored text entering the reader's DOM. Tiptap is lazy-imported and note-only
  behind one shared import promise, so two notes opened in the same tick do not race, and
  the stored value is markdown — not the editor's document, not HTML. Why: `NoteEditor.tsx`.
- Note editor: Enter saves, Shift+Enter splits. Why: `NoteEditor.tsx`.
- **A locator index rules papers out; the anchor index rules one in** (papers share
  "Table 1", not a `§slug`). Late or failed means unknown and moves nothing. Why:
  `lib/citation-route.ts`.
- **The note gutter is the page's own margin, and there is no second layout.** A PDF
  page is rendered at the panel's own width, so a wider reader is a wider *page* and
  never uncovers a strip beside it. **Ask what the extra width goes to before keying a
  layout on it**, and watch a percentage width of a zero-width gutter.
- **A layer that scrolls clips the shadow of everything in it.** The gutter fixing
  `.kb-operation-notice-layer` is `box-sizing: content-box` plus padding, so `width` still
  names the *card's* width. A fixed strip down each side of the window swallows every
  click under it, so the layer is `pointer-events: none` and only its children are `auto`.
- **A cache keyed on a revision has to sweep the revisions it replaced.**
  `delphi:memory-layout:<revision>` moves on every Memory write, so keeping the old
  keys fills `localStorage` to its quota, which also breaks every other store there.
  `rememberLayout` removes every key under the prefix except the one it writes. Ask this
  of any key naming a version, an id or a revision.
- In `Workspace.tsx`, `textual()` mints component types and they must stay memoized. Built
  inline, React saw a new type each render, unmounted the answer subtree, and wiped the
  reader's text selection on every streamed token.

**Tests and tooling**

- **Public files are matched before routes**, the only reason `/brand/delphi-mark.svg` and
  `/fonts/*.woff2` still serve: both are two-segment paths `[project]/[paper]` would
  otherwise swallow. There is an SSR test, because the failure would be silent.
- A KB figure `<img>` needs no `crossorigin`: `:3000` → `:8000` is cross-*origin* but
  same-*site*. `use-credentials`
  puts the request into CORS mode for no gain and fails where the plain load succeeds.
- Pure modules under `app/lib` import each other with an explicit `.ts` extension so
  `node --test --experimental-strip-types` can resolve them (`allowImportingTsExtensions`
  exists for that). Type-stripping cannot handle `.tsx`, so anything needing a unit test
  must stay JSX-free.
- **`rendered-html.test.mjs` asserts by reading source files as text**, recursively
  concatenating `app/components` and `app/lib` via `sources()` rather than naming a file.
  It catches real cross-file drift and fails on a rename that changed nothing. If one
  breaks, check whether the *intent* still holds before changing the code.

---

## 9. Boundaries

Not bugs — the edges of what the system claims to do. **`ARCHITECTURE.md` §"Known
boundaries" is the full list and the copy kept current.** These are the ones worth
knowing before you promise a behaviour, without opening it.

- Text extraction does not OCR scanned PDFs. The export (`GET /api/export`) is a one-way copy.
- Extraction reads the HTML as served; a page that renders entirely in the browser is
  built once in headless Chromium and read from the DOM its scripts produced (~10–20s on
  the add). It does **not** cover content behind an interaction — infinite scroll, a "Load
  more" button, a tab — because nothing clicks.
- **Delphi does not defeat bot detection, by decision.** A site fronted by DataDome,
  Akamai Bot Manager, Kasada or equivalent fingerprints the TLS handshake, so a browser
  User-Agent, replayed cookies and a real headless Chrome are refused alike, and the
  reader is told so in those terms. A paywalled article is out of reach too: the
  entitlement belongs to the reader's own logged-in browser, never to the server.
- Opening, reloading and switching views never replace the saved copy (`paper_page`);
  a live annotation does, through `save_page_copy`. Canvas, shadow roots and media
  state are not captured; external media and styles remain network-dependent. Exact matching cannot prove semantic
  identity or that an arbitrary page has finished loading; degraded or ambiguous
  placements leave the reader's quote and note in the document's annotations list. Captured Reply
  evidence pins the selected text rather than fetching its URL again.
- Sessions use one HMAC secret; no password recovery.
- **The search box is collective and lexical.** Every term must appear in the same record,
  so a document holding only one word is absent, not a weak hit — the opposite of the
  model's own `search_library`, which stays coverage-weighted. It finds the authors'
  words, not the meaning. A result is a *thing*, not a place inside it: however many
  sections match, it is one row, quoted and opened at the **first** of them
  (`workspace_search.collapse_matches`).
- **Filing the document again is the only thing that clears a dropped target** (48;
  Retry is `POST /backfill/papers` scoped to that paper). An empty list means no document's last job dropped a page, **not** that every page was
  checked: the checker reads only what a job stages.
- **Rewriting one page is a different offer from updating the document.** It may not change
  that page's links, evidence markers or figures, and it clears nothing the document owes.
  It needs the page's cited documents still in the library — a grounded rewrite has to read
  the source — so it is refused rather than guessed at once they are gone. Offered only on
  `concept` pages: a `source` page is derived from its digest (36f) and a `domain` page is
  composed by its job (74).
- **Filing can be stopped, but not unwound.** `POST /maintenance/cancel` deletes the
  document jobs and reaches the one being written, because the drain asks
  `memory_job_exists` between stages. Only a job that gave up keeps its place: its
  error is the only account of why. Nothing is left half-filed; pages already written
  stay, and a document that was out of date still is, so the offer comes back. Both buttons are gated on the server's `cancellable` count. Stop covers
  `CANCELLABLE_JOB_KINDS`: not a `session`, `reconcile` or `domain` job.
- **Bumping `MEMORY_VERSION` is a spending decision**, for every account at once.
  Nothing refiles a wiki on its own: a document filed by a superseded pass reads as
  `stale`, and the refile is a reader's button or an operator's command. Edit a contract
  *without* moving the version when the change is not worth anyone's money;
  `SOURCE_PAGE_VERSION` is provenance on a figure row and gates nothing.
- **The Update pass is the queue, not its own engine.** Two things it must keep: a
  still-unfiled document has usually **already failed** and `enqueue_memory_job` is
  idempotent on its marker, so the route must revive a failed job or File-it-all does
  nothing for exactly the documents it exists to rescue; and "background" means *survives
  leaving the page*, not *runs with no browser*.
- **A domain's page lags its domain, and a small domain has none** (74). The page is
  rewritten only after the domain has settled and a tab drains the job; until a first
  composition the domain is its record and its members, with no page to open or link to.
- **A session is filed in parts when it is long, and what Delphi answered is clipped.**
  One event carries `gather_session.MAX_EXCHANGES` exchanges and the rest follow under
  the same marker. The agent sees an excerpt of each answer and the documents it rested
  on; a claim the documents do not carry is not filed.
- **A `reconcile` job can correct a concept page only.** It may name a domain page and
  read it, and the write tools edit concepts (36f); it brings in no new source.
- Editing your own persona reaches every conversation held in it; one installed from the
  marketplace is a copy and never receives the author's later changes. Deleting is always
  allowed. Publishing is immediate and author-controlled: no review queue, no admin role.
- A project holds at most 50 documents including archived (`max_papers_total_per_project`),
  of which 10 may be active (`max_papers_per_project`). Marking a paper done frees a slot in
  the working set and does not move the 50.
