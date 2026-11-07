# Architecture

Why this repository is shaped the way it is, and what it cost to find out.
`CLAUDE.md` is the operating manual; this is the reasoning behind it and the
record of what has already gone wrong.

---

## The decision that shapes everything

The desktop frontend lives in `frontend/` and compiles to a Worker-shaped module
that Electron can serve using ordinary Node APIs. It was copied from the pinned
Delphi frontend at `a13b8e53b0717a00d2c91bf0d8ce8c071e2f49fe` when macOS
navigation became independently maintained. Its
source, lockfile, assets, toolchain and tests now belong to this repository;
a private release wheel supplies only the backend. Web frontend changes do not
flow into desktop builds automatically.

The Dashboard owns a collapsible left rail; Reader and Memory keep their top
bar with a compact Search/Settings menu. Marketing, login and registration pages
are absent. The hidden local session bootstrap remains necessary for the
host-only cookie boundary below; there is no user-facing account lifecycle.
The desktop Worker refuses logout and password-change requests, while main
process registration and sign-in remain available for local provisioning.

Everything else follows from that. The shell's job is to reproduce, locally, the
few things the hosting platform used to provide: an origin to serve from, a
static-asset binding, and a proxy to the backend.

**If that ever stops being true** — if the build output stops being importable by
Node — the fallback is the single-page rewrite, and it is cheaper than it sounds:
the entire framework coupling is a handful of files using a router hook, a
pathname hook, a search-params hook and a link component. `tests/worker-host.test.mts`
exists to tell us at upgrade time, rather than at runtime.

## Two origins, one boundary

The reader can show third-party web pages, and it grants them a real origin so
that embedded media works. That origin is the backend's own. What stops such a
page from driving the API as the reader is not a check in the application — it is
that the session cookie is *host-only* on the interface's hostname and is
therefore never sent to the frame's hostname.

Cookies ignore ports but not hosts. So the boundary is two hostnames, and the
shell asserts they differ at startup rather than trusting whoever picks ports
next. This is also why the desktop app keeps a session cookie at all despite
having no sign-in: deleting the credential would delete the boundary.

The sign-in is removed as an *experience*, not as a mechanism. The main process
registers and signs in one local account over the same session the window uses.
The password is generated, stored in the owner-only profile, and never enters the renderer.

## A real interpreter

Some PDF work is isolated in a child process because the native library
underneath can abort the process outright, which no Python handler can catch.
That isolation is spawned through `sys.executable`, so the bundled runtime has to
be a genuine interpreter — under a frozen binary `sys.executable` re-launches the
app and the isolation silently disappears. Hence a pinned, checksum-verified
CPython rather than PyInstaller.

---

## Incidents that set a rule

Each of these is a rule in `CLAUDE.md`. They are recorded here because the rule
is short and the reason is not.

### The reading plan that linked nothing

On 2026-10-30 a reading plan beside Chinchilla named 35 places across three
papers — `**§§3.2–3.4, pp. 5–8**`, `**Table 6, p. 11**`, `**Equations (1)–(2),
p. 3**` — and none of them linked. The parser found citations only inside a
parenthetical, a rule no prompt ever stated: the persona's own examples write
"§4.2 gives accuracy" and quote `` `Eq. (6)` ``, which it could not read
either. Read against the reader's stored answers, 93 of 202 references a model
had written never became links, and every reference in a Memory chat stayed
text, because that renderer had no citation path at all.

The history showed why it kept returning: about half of some twenty-five earlier
citation fixes were one more shape the parser missed, or one more way markdown
split a citation before the parser saw it, each fixed against the answer that
had just failed. So the fix is a corpus, not a shape: whole recorded answers,
checked by a detector that shares nothing with the parser, in the unit suite
and in the real renderers. The same corpus showed links that went nowhere —
pages of a PDF the model read on the web, a name the library does not hold —
and those are now prose. → `CLAUDE.md` §5, "A citation is wherever an answer
names a place".

Questions put to a live Memory chat found what the stored answers had not: an
answer that gives each paper a section, with a table of places in each, names
the paper only in the heading — so a block now takes its section's paper — and
an answer about the library's web pages links their public addresses, which now
open the library's copy at the cited section.

### The blank page that was a routing collision

Assets were served *after* the application, on the assumption that the order did
not matter. It does: an asset path of two segments matches a document route, so
the app answered its own script requests with the app shell as `text/html`. The
only symptom was a blank window and a module-import error naming a file that
existed and served correctly when fetched by hand.

The hosting platform serves assets *before* the worker. Reproducing the platform
means reproducing the order. → invariant 2.

### The upload that returned 500

A large upload failed while every small request passed. The client had added
`Expect: 100-continue`, which the outbound fetch implementation refuses to
forward, so the proxy threw. Proxies must strip hop-by-hop headers; this one had
been forwarding everything.

Worse, the first fix made it hang instead of fail: answering mid-upload without
draining the body leaves the client writing into a socket nobody reads. A wedged
request is much harder to diagnose than a failed one. → invariants 4 and 5.

### The fix that appeared not to work

After correcting the asset ordering, the page kept failing for several minutes.
The server was right; the browser was serving a cached copy of the earlier wrong
response. No cache header does not mean no caching — it means heuristic caching,
which is exactly how a transient mistake becomes permanent. → invariant 6.

### The build that served the previous build

A rebuild with different configuration produced an app that called an address
nothing was listening on. The bundler does not fully clean its output directory,
so a chunk from the previous build survived and was served. It only ever happens
on an incremental rebuild, which is why the deployed path had never hit it.

`build/frontend.sh` now removes the output first, and afterwards asserts that
every asset the server bundle references actually exists — because a build whose
HTML names a missing chunk is broken in a way that only shows up as a blank
screen.

### The app that only worked here

Originally the frontend was built from the same submodule as the backend. But a submodule records a commit, not file
contents — and a redesign of the empty-library screen was made *inside*
`vendor/`, where it built perfectly, ran perfectly, and would have reached
nobody. A fresh clone would have produced the old screen.

The frontend now belongs to this repository, and the backend is consumed as a
published wheel. `build/backend-release.env` records its version, asset and
SHA-256. The builder verifies downloaded and cached bytes against that committed
pin, with no source-install fallback. Desktop contracts exercise the installed
runtime; upstream release CI retains internal regression coverage. This keeps
a fresh clone's backend selection reviewable. → invariant 12.

### The Dock icon that stopped the app

Setting the development Dock icon threw, the error propagated out of startup,
and the app quit before doing anything. The error box opened on another Space, so
it presented as a hang with no message.

Two rules came out of it: cosmetic setup is wrapped so it can never abort
startup, and failures are written to the log as well as shown, because a modal
that nobody can see is not a report. → invariants 13 and 14.

### The overlay that repainted the screen

Opening the composer stuttered. The backdrop animated `background` and
`backdrop-filter` up from zero, and the card animated `border-radius` — none of
which is compositable, so every frame repainted the whole viewport, and behind
the overlay there is usually a full-page PDF canvas.

Fading the backdrop by opacity alone and fixing the radius made it a composited
layer: measured worst frame went from visible stutter to 9 ms with no dropped
frames. A sweep of the rest of the stylesheet found no other keyframe animating a
non-compositable property.

### Three things a clean clone could not do

Building from a fresh checkout surfaced three defects invisible to anyone whose
machine was already set up: a source file excluded by a build-output ignore rule
and so never committed, a dependency whose optional extra was not declared
although the code required it at import time, and a package manager that refuses
an install whose build scripts are unapproved.

None is visible in an environment that has been incrementally maintained. This is
the argument for `check.sh` running the upstream suites against the interpreter
that actually ships, rather than a development environment that happens to have
the right things in it.

---

## Known boundaries

- The application this builds is a private dependency; a clone without access to
  it cannot build.
- Signed ad hoc, un-notarised: a downloaded build needs right-click → Open, or on
  macOS 15 and later System Settings → Open Anyway.
- Apple silicon as configured. Another architecture means another pinned
  interpreter checksum and another packaging target.
- The optional capture browser is detected, never bundled. Without one, pages
  that build themselves in the browser cannot be added and document previews are
  skipped; nothing else changes.
- One profile per machine, because there are no accounts.
- A startup window opens before profile loading and backend readiness. The
  reader opens only after session bootstrap.


## Shell hardening and the distribution blocker

The developer runtime installs source and bytecode. Compilation to bytecode is
not IP protection. The hackathon explicitly retains that build while the native
research service is developed here. `dist` now produces the source-bearing,
ad-hoc signed, un-notarised hackathon app and DMG; `dist:public` retains `auditRuntime` as a separate
blocking gate. This is not a completed public-release security architecture.

`readProfile` accepts the original unversioned configuration and validates it as
version 1. Invalid, unreadable, or future versions fail without writes.
`writeProfile` syncs a private temporary file and atomically renames it. A
Keychain-era profile's ciphertexts are decrypted once into plain fields; a
denied or locked Keychain leaves the file as it was. Incomplete identity alongside existing data
requires recovery of the matching backup, never credential regeneration.

Startup has explicit setup, launching, ready and stopping phases. Setup completion
cannot be mistaken for a user closing onboarding. Activation reopens the reader
only once the backend and session are ready. Setup IPC checks the sender and main
frame before validating input; permission requests are denied and navigation uses
parsed origins. `startBackend` owns restart timers and cancels pending startup on
shutdown. `send` awaits the streaming pipeline so a failed response or disconnected
client cancels the producer instead of raising an unhandled stream error.

## Conversational research handoff

The former manual notebook and local trial engine were removed in favor of a
single reader-chat handoff. Historical experiment files and SQLite tables remain
untouched, but no runner, dashboard, or mutation MCP tool is shipped.

`chatPlansHandler` preserves scope, model, effort and input fields. A nonce-tagged
plan command is withheld from streaming display and validated before a saved link
is emitted. Durable receipts restore the original question and saved answer on
history reload. These receipts must remain with the profile.

The backend decides when a turn searches the web: there is no web control in the
composer and no web field in the request, and a body that still carries one is
refused. The adapter adds nothing about tools to the prompt. A turn that searched
comes back with its trace and the pages it cites, and is stored that way.
`tests/chat-journey.test.mts` runs one such turn through the Worker host, the
adapter and the pinned backend against a local provider that speaks the Responses
stream; `frontend/tests/browser/chat-sources.spec.ts` holds what the reader sees:
citation chips, the Sources list, and a cut-off answer's notice with Retry.

A digest may cite a passage from outside the library. The backend keeps the
captured page; the reader opens it from the digest or from a Memory page's
provenance in `CapturedSourceView`, with the quoted passage marked.

`PlanStore` uses the existing database filename for compatibility, but only owns
plans, receipts and grants. `LocalPlans` hosts three script-free HTML pages.
Versioned scientific plans include source-grounded claims, conceptual tasks,
evaluation, stopping criteria and concrete implementation decisions. Source IDs and excerpt
presence are checked against captured text; this does not establish entailment.
Earlier plan formats render without inventing missing sections. Historical
progress and artifacts stay on disk and are excluded from new MCP responses.

The native bridge retains its socket and launcher contract, reading its token from the profile. MCP exposes
only `get_plan` and `read_plan_source`; legacy run grants and removed write tools
are rejected. External coding agents execute and monitor under their own
permissions. There is no completion callback or write-back dependency.

The reader owns plan creation and explicit archival. The HTML renderer uses only
fixed markup and escaped data, with no remote resources or model-supplied scripts.
Tests cover streaming, restoration, source validation, legacy records, removed
mutations, native pairing and source pagination. Provider instruction adherence
still needs empirical evaluation; schema checks cannot prove scientific fidelity.

A feasibility question once caused an unsolicited plan attempt and surfaced a
quote-validation error. `chatPlansHandler` now gates all local plan actions on
an explicit composer mode, before validation, snapshot capture or
pairing. Ordinary turns get no planning schema and cannot authorize side effects.

PDF text extraction can join words, wrap hyphens, flatten superscripts, and use
ligatures. `capturedQuote` matches these presentation differences and stores the
actual source span; changed wording, numbers, and operators still fail. This
prevents a valid plan from failing on source typography without treating a
model paraphrase as a verified quotation.

Plan schema v3 puts Reference first: document summaries, target locations,
corresponding text and actual captured PDF pages. `renderReferencePages` runs
PDFium in a bounded child of the bundled interpreter; unavailable images are
explicit and never reconstructed. `read_plan_source` accepts a captured page
number to return its image. `get_plan` includes image metadata, not base64.
The new schema removes monitoring and unresolved-question lists; ordinary
implementation choices must have concrete settings labeled source, user or
proposed. Older plans remain readable without inventing those decisions.

A UniFusion animation plan failed because its Reference entry selected eight
pages while `scientificV3` permits three. The saved receipt identified only that
array-limit violation; a retry selected three pages and saved successfully. The
capability prompt supplied an example but omitted the limit, so the model learned
it only through the saved validation feedback on retry. `chatPlansHandler` now
states the page budget and other schema size limits before generation, and tells
the model to retain additional source locations in the target and evidence rather
than narrow the plan to its image attachments. Validation remains strict; this
improves the instructions but does not guarantee model adherence.


## Webpage annotations

The desktop reader offers the same Highlight, Note and Reply actions for webpages
and PDFs through one `ReaderSelectionMenu`. Selection is the primary interaction;
the notes collection lives behind a small toolbar icon, outside the document.
`AnnotationsPanel` keeps original quotations and notes accessible when
an inline position is unavailable; it shares `NoteEditor` and the note markdown
renderer with the PDF reader. PDF overlap combines paint only, preserving each
record and its note. An overlapping click offers the records individually. Failed
saves keep the draft open, including edits made while a save was in flight.

`useWebAnnotations` keeps historical quotations and matching in a trusted worker.
The page frame receives temporary handles and current offsets, never note bodies
or a list of saved quotations. Text identity is structural and independent of CSS
visibility. An unchanged fingerprint reuses verified positions. Changed text uses
exact quotes, with exact surrounding context resolving duplicate occurrences only
when there is a unique best result. Original anchors stay unchanged; the resolved
position cache is separate and checks the quotation before reuse. Incomplete
searches remain unknown, and ambiguous placements do not hide the annotation.

The reader keeps one cached webpage copy from import. The first highlight or note
of a visit to the live page replaces it, in the background and once per opening,
with the page as the frame drew it — typeset math, embeds and anything else the
page's scripts built — taken with the selection it belongs to, and kept only once
the annotation is saved; the same annotation re-fetches the text the assistant
reads. There is no button, because a copy kept only when
someone remembers to ask is a copy nobody keeps. The frame's answer is untrusted:
the reader accepts only one it asked for, within the published size limit, and
the backend sanitises it regardless. A backend whose frame cannot serialise a page
says so, and then the text refresh renews the copy as it always did. Live view fetches a fresh
page with its own scripts intact, without storing it. Live reading never freezes
a rendered snapshot or replaces the site's player controls. The browser transport
may retrieve an original HTML response when plain HTTP is refused, but the reader
runs the page. Cached HTML retains external media URLs; embedded players remain
responsible for playback. Reload preserves the chosen
view without replacing the cache. Both page types share View cached and View live
in the ⋮ menu. This requires a backend release that acknowledges
the requested view; older releases show an update requirement rather than silently
serving a cached rendering as live. When the live page cannot be loaded, the
backend still frames a page that says so, and the reader opens the cached copy
with a notice instead of retrying; with no cached copy it shows one error. A note
edited while its save is in flight stays open, and a save pressed meanwhile runs
after the first. A shortened page, recognizable wall or substantial
loss of retained text preserves the saved copy. These are conservative checks,
not proof that every arbitrary application has completed loading. Saved pages can
still depend on external styles and media; this is not a complete offline archive.
Reply keeps selection-time text for the model instead of fetching a changed URL.
The reader integration uses standard browser APIs and authenticated HTTP, with no
Electron bridge. Delphi web can reuse these components and the same backend
contract when its frontend adopts annotations.

Synthetic tests exercise failed saves, overlapping notes, exact matching and
revision changes. The Chromium fixture also checks DOM preservation, responsive
text identity and mutation invalidation. A large-article fixture paints native
ranges and captures the page while monitoring main-thread long tasks.
An isolated desktop reader check covers note creation, reopening, relocation after
an inserted paragraph, and saved-page recovery after a simulated 404.


## Conversation strip

The chat card combines scope, conversation tabs and window controls in one sand-colored
strip above a hairline. Tabs keep a readable width (160px for the one on screen, 128px
for the rest); a shared width observer decides how many fit, and the context button gives
up its name before two tabs would lose theirs. Every other chat of a context is reached
from the context menu: pointing at Project or Memory lists that context's chats beside the
menu, or below it in a narrow rail, and choosing one in the other context switches context
and opens it. That list is the only place a conversation is deleted, and only for the
context on screen. A tab's cross closes the tab and keeps the conversation. Expand and
Hide chat are separate buttons; neither deletes history. Plan mode is stated in the strip;
Chat is only announced.

A background answer keeps running in its conversation session. Its tab and its row in the
list show a spinner until it finishes, or a "!" if it failed; a new answer is not marked.
Creating a tab animates only its opacity and horizontal translation; the card fades in,
and reduced motion disables both animations. The card has a soft drop shadow with no
outline border.

## Subscription inference (unreleased)

A reader can connect a ChatGPT or Claude plan instead of an API key. Everything that makes
this work lives in the macOS shell: the backend is the unchanged pinned release,
configured with a loopback `OPENAI_API_BASE_URL` and a fresh per-launch token as
its `OPENAI_API_KEY`. The shared backend carries no subscription code, because a
web-hosted Delphi cannot use this sign-in reasonably: Codex's OAuth client
accepts only `localhost` redirects, and a device-code flow would make a server
hold many readers' consumer credentials and send their traffic from one place.

`DirectOAuth` signs in with PKCE through Codex's public native client, keeps the
tokens in a `safeStorage` file and refreshes them single-flight. No Codex CLI is
involved. The reader renderer receives neither the tokens nor the bridge token.
`SubscriptionConnection` accepts an account only when its catalog offers the
models in `DESKTOP_TASK_MODELS`, and reports any composer choice from the
frontend's `CHAT_MODEL_EFFORTS` the plan lacks. Nothing names a model twice, so
changing Delphi's OpenAI models changes the API and ChatGPT connections together.
Claude has a separate model mapping, using the same task configuration boundary.

The catalog filters model visibility by the `client_version` in
`CHATGPT_OAUTH.models`. An old `0.153.4` pin hid GPT-6.1 Sol and GPT-6 Luna and
incorrectly rejected an account that supported them. The same sign-in returned
both models with `0.159.3`; keep the catalog pin compatible with the configured
models. `DirectOAuth.models` has a regression for this version filtering, and
`AiConnectionRow` reflects the shell's readiness instead of unconditionally
showing Connected when verification fails.

`startInferenceBridge` presents the subscription as the OpenAI API:

| Backend call | Bridge |
|---|---|
| `POST /responses` | Relayed to the subscription endpoint in its native Responses format. Only fields the endpoint rejects are dropped: `max_output_tokens`, `max_tool_calls`, `prompt_cache_options`, per-block `prompt_cache_breakpoint`, and `service_tier`, whose priority tier spends a plan faster. |
| PDFs | The endpoint has no file store, so the backend runs with `OPENAI_FILES_ENABLED=false` and sends each PDF inline as `file_data`. The bridge keeps no copy; it only enforces the inline size limit. |

Measured against the live endpoint:

- **Prompt caching** routes by a `session_id` header, which the bridge takes
  from the backend's `prompt_cache_key` (or derives, for requests without one).
  Without it a repeated document prefix cached nothing; with it, 95%.
- **The cache is warmed after a turn starts, never before it.** The endpoint
  caches the whole prompt of a request, not an arbitrary prefix. Delphi's
  turns share their documents and then differ, so a follow-up re-reads them:
  9,856 of 44,305 tokens cached. The bridge therefore sends a conversation's
  documents as a prompt of their own, stopped as soon as the model starts to
  answer, once per conversation; follow-ups then cached 31,104 of 35,306.
  That request used to go first and be waited for, which made the reader wait
  too: 13 s on a 7.6 MB paper on a good day and 68 s on a bad one, and it ran
  ahead of the Memory selection call as well, which missed its time limit
  that turn. It is now sent in the background once the turn has begun to
  answer. A cached prompt was not measurably faster to answer than an
  uncached one (3–6 s to the first event either way), so the first turn loses
  nothing: on a fresh paper its text began at 6.4 s and the second turn's at
  7.5 s. One measurement here went wrong and is worth remembering: removing
  the request altogether looked free, because the paper it was tested on
  still had an entry left by an earlier primed turn. Test caching on a
  document no earlier request has sent.
- **An inline PDF costs time on every turn, cached or not.** The same paper
  began answering in 10–14 s as a PDF with its prompt fully cached and in 3–4 s
  as extracted text (18,500 tokens rather than 43,000). The endpoint has no
  file store, so the PDF is what carries figures and layout to the model.
- **Reasoning summaries** arrive as one short headline per reasoning step rather
  than the API's streamed paragraph, whatever summary mode is requested. The
  chat trace shows every headline; there is no more text to relay.
- **Web search** runs natively, with its progress events and URL citations.
  `include: ["web_search_call.action.sources"]` returns the consulted URLs. A
  next round may hand back a `web_search_call` verbatim, without its id, or
  not at all, and a message with its annotations; all were accepted.
- **`max_tool_calls` is rejected** (400, "Unsupported parameter"), and the
  backend sends it on every turn that may search, so before it was dropped
  every chat turn on a plan failed. Nothing caps one round's hosted calls on
  this connection; the backend's count closes web search for later rounds.
- **`tool_choice`** `"none"` and `allowed_tools` are both accepted and obeyed.
  `allowed_tools` keeps the cached prompt (16,256 of 16,385 tokens);
  `"none"` on the same warm prompt cached 3,712, so it is not the same prompt
  to the cache.
- **Chat, end to end** (`build/subscription-live-checks.mjs chat`, October 12,
  2026, backend 0.5.2, `gpt-6.1-sol` at medium effort, one 41,000-token paper):
  a question the document settles made no search and cited its page; the
  second turn cached 40,320 of 44,330 input tokens; an outside-fact question
  made two hosted searches and its source survived a reload; a turn that
  opened a Memory page and then searched completed with no rejected second
  round (45,824 of 55,353 cached); a 35,000-character answer at high effort
  completed in 273 s; the Memory check completed in two calls and chose not
  to search. Text began 13–33 s after sending at medium effort and 45 s at
  high. One turn met a provider overload mid-search and was stored as failed,
  with its trace, not as an answer.
- **A call's log line** is written from the completed event as it passes. The
  backend hangs up once it has that event, often before the provider closes;
  such calls used to go unlogged, which hid their token counts.
- **Size**: 52 MB of PDFs in one request was accepted (131,878 input tokens); the
  context window, not a byte limit, bounds multi-document questions.
- **Dropped streams** happen on long responses. The bridge retries while nothing
  has reached the backend. A bounded prelude of envelope and reasoning events
  stays provisional until an answer, a tool call or an unknown event commits
  the stream, so a round that was inspecting a rendered draft retries with its
  feedback intact; past its byte limit the prelude flushes, so large output
  still streams. After commitment a failure is reported in-band and the round
  is not replayed. Explicit provider failures and cancellation never retry.
  Interruption logs record the event type, replay boundary and transport cause
  code, not content.
- **Visual tool results** carry text and pixels in one `function_call_output`.
  Sent as a synthetic user message, a screenshot read to the model as a new
  reader turn in the middle of inspection. The Responses API accepts multimodal
  tool outputs, and the Claude transport translates the same blocks into MCP
  results or native transcript blocks. Ordinary text results stay strings.
- **Limits**: a `usage_limit_reached` rejection becomes a 429 whose message states
  the reset time; until then the bridge answers locally without contacting the
  provider. Plan usage headers are shown in AI Connection. Any other failure
  affects only its own request.

On quit the bridge waits briefly for in-flight calls, so the backend's own
shutdown ends them; a call the bridge cut first would read as a provider failure
and spend a filing job's retry.

### Switching connections

Settings → Advanced → AI connection switches among the API keys, ChatGPT and Claude in
place; Delphi → AI Connection… is the window where credentials are entered. The
shell retains each connection’s credentials, so switching to one already set up restarts only
the backend (and the bridge), on the same port and session, in about three
seconds, then reloads the window. Nothing else moves:

- **Library, digests, Memory**: on disk, untouched. A digest's model is
  provenance, not a staleness key, so nothing is re-digested.
- **PDFs**: a stored provider file id only ever comes from the API key, because
  the subscription sends PDFs inline. Switching back re-uploads nothing; a PDF
  added while on the plan uploads once on its first API use. A stale id (an old
  bridge id, an expired OpenAI file) is re-uploaded once and replaced.
- **Models**: switching refreshes the model catalog; the composer resolves stale
  model and effort selections against the new connection. Claude chat offers
  Haiku, Sonnet and Opus 5.5 at low, medium, high and xhigh effort. Opus at
  medium effort is the chat default. `modelSettings` maps Sol tasks to Opus and
  Luna tasks to Sonnet. Reasoning efforts are preserved across connections.
- **Work in flight**: an answer, digest or upload blocks the switch. Background
  filing does not: the backend's graceful shutdown hands running claims back,
  and the new connection files them.

A side-by-side run of the same library on both connections — eight chat cases —
gave matching answers, citations and tool use; the
subscription was slower end to end by a few seconds per turn.
`build/subscription-live-checks.mjs` repeats the chat suite and a filing case
against a running unpackaged app. The filing case adds two related notes and
drains Memory's queue, so each kind of request the maintenance pipeline makes
(a structured choice, an agent with tools, a check, and a domain page written
with tools and a structured answer in one stream) crosses the bridge.

`inference.log` in the logs directory records each bridge request's route,
model, sizes, token counts, cache fingerprint and web-search count, never
content.


### Claude API key transport

A Claude API key (`claude-api`) reaches Anthropic's Messages API directly, through
the official SDK, behind the same bridge as the plans: the backend still sees one
OpenAI Responses API on loopback. `AnthropicTransport` (`main/inference/anthropic-api.ts`)
translates each request and streams the answer back as Responses events. Its key
has its own profile field (`claudeApiKey`), so saving it never replaces the
OpenAI key, and it is checked once with the free models listing before it is kept.

- **Unshaped requests.** The bridge's ChatGPT shaping drops `max_output_tokens` and
  the backend's cache breakpoints; this transport takes the request as written
  (`BridgeOptions.shape`), so the task's output ceiling and two breakpoints reach
  Anthropic, beside one on the instructions and the automatic one at the end.
- **Exact replay.** Each Messages response is handed back as a `reasoning` item first,
  whose sealed content is the response's exact content blocks, thinking signatures
  included, then the items the backend acts on. The backend replays reasoning in
  order, so the next round rebuilds that turn from what Anthropic returned. A thinking
  block is honoured only while everything before it is byte-identical, and the cache is
  a prefix match; the one tools array never changes within a turn (which tools may be
  called changes only through `tool_choice`, and the backend answers a withheld call
  itself). A block whose prefix moved anyway is dropped, not a 400 (`block_binding`).
- **What the models accept.** Thinking is always adaptive; effort is the backend's;
  forced tool choice is never sent; structured output schemas lose the keywords
  Anthropic refuses (lengths, counts), which the backend checks itself. A search loop
  that pauses is resumed inside the same answer. Opus and Sonnet ask for Anthropic's
  server-side fallback, so a reading a safety classifier declines is retried on a
  fallback model rather than refused. Inline documents stop at 22 MB, under the
  32 MB request limit, and the backend's OpenAI service tier is never sent.
- **Sources by address.** Opus and Sonnet's dynamic-filtering search links the
  pages it used in the answer's text without citation blocks, so a link to a page
  a search in the same turn returned becomes a `url_citation` (`annotateLinks`);
  Haiku's citations pass through as they are. A link no search returned is never
  a source.

### Claude subscription transport

Both account logos are 512×512 PNG assets in `frontend/public/brand`, shared by
the settings view and setup window.

`ClaudeTransport` implements the same `Upstream` interface as `DirectOAuth`.
The existing bridge owns authentication, request limits, streaming, retry and
shutdown; only provider translation differs. `AI_CONNECTIONS` separates provider
from credential type: a Claude API key is its own connection with its own
transport (below), never this one with a key.

`ClaudeConnection` delegates login, refresh and logout to the installed official
Claude Code CLI. It accepts only Claude subscription authentication and removes
API credentials and alternate-provider variables from the child environment.
It does not read Claude's credential files. An existing Claude Code subscription
login can connect immediately; otherwise the setup window starts the CLI’s browser
sign-in. No separate Delphi login marker is needed. This sign-in is shared with
Claude Code on the Mac. Version checks require 2.1.302 or newer; a newer major
version is used as is.

Claude Code is an external dependency the reader installs and updates. An app
opened from Finder inherits launchd's minimal `PATH`, not the shell's, so
`ClaudeLocator` checks the documented install locations (the native installer's
`~/.local/bin`, Homebrew, common npm prefixes) and then asks the reader's
interactive login shell for `command -v claude`, bounded by a timeout and
reading only a marked line past startup output. It looks again on every status
read and request, coalescing and throttling the shell lookup, so an install made
while Delphi is open needs no restart. A missing or too-old CLI is a
typed `ClaudeCodeUnavailable`; setup and Settings show the matching command from
`CLAUDE_CODE`, and a request fails with the same status and code as an expired
sign-in. Background filing then spends its attempts as it does after an expired
sign-in, and gives up until the reader retries it.

A conversation runs in one native process, in a private temporary directory,
for as long as the application keeps extending it. The request's tools are
advertised over authenticated loopback MCP. That MCP server never executes a
Delphi tool: the adapter returns the completed function calls to the existing
application, which owns execution and budgets, and holds each MCP call open. The
next request's function outputs answer those held calls; a new user message,
such as a repair, is written to the same process. Anthropic reads its prompt
cache only where an earlier request marked it. A fresh process per round
resends history whose marked end never recurs, so a Memory filing read 17% of
its input from cache and paid to write the rest every round. One process reads
nearly the whole previous prompt each round (measured on 22 October 2026: each
round's cached tokens were within a few tokens of the previous round's input).

So the process's tool list and system prompt never change. A tool a round
withholds stays listed and is refused when called. The restriction, and any
user turn Delphi places after the outputs (the last round's note, a figure), is
a user message written beside the held results, not text inside them: the model
rightly treats a tool result as untrusted and ignored a note placed there. Cache entries
use the five-minute lifetime, since rounds come seconds apart and the
subscription's one-hour default costs more to write. An idle process holds
240-380 MB, so one waiting on held calls is closed after five minutes, and one
that gave its final answer after two: a repair, which follows its check by
about a minute, continues it, and a chat's next turn only when that turn called
no Delphi tool, since the chat history drops tool rounds. A process continues
after a final answer only if Delphi replays the answer it gave: two processes
may answer the same first request. A request that extends no
live process (a different history, another account, an idle process closed,
or the oldest of more than two idle ones) starts a new
process that imports the completed native tool/result pairs from the request's
history, so losing a process between rounds repeats no write.

Claude Code can change what reaches the model: it saves a long result to a file
and shows an error instead, and it gives up on a held call after its timeout.
Each listed tool asks for results whole, and held calls get a timeout longer
than an idle process lives, but neither is relied on. Claude Code echoes every
result it gives the model and every queued message when it joins a model call;
before the next call, each must match what Delphi sent. Otherwise the process is
dropped before any output and the bridge's retry replays the round into a new
process, where results travel in its history. Output from an idle process ends
it too. When a process ends, Delphi also removes the folder Claude Code keeps
for that process's scratch directory and nothing else in the reader's Claude
Code state: Delphi may share the reader's plan limits, not their workflow. CLI hooks, project settings, persistence,
memory and unrelated built-ins are disabled. Cancellation and shutdown kill
only Delphi's process groups and remove the temporary transcripts.

PDFs and images are translated inline. JSON schemas use the CLI's structured
output channel. Hosted web results retain native replay history alongside the
Responses source trace, so citations survive a later Memory-tool round. Native
JSONL transcripts and web-result text are version-sensitive: protocol fixtures
and opt-in live checks must accompany changes to these assumptions. A process
failure is retried only before any visible output; afterward it fails the turn.
The transport does not promise matching model quality, latency or usage limits.

`AiServiceController` owns connection switching for every provider. It pauses
new requests, waits for backend shutdown before closing the bridge, starts the
new service on the same port and persists the selection only after readiness.
A failed startup restores the previous service and keeps the error visible.
The full-stack subscription workflow tests use the installed backend and real
bridges with synthetic external-model processes. Browser tests exercise setup,
API-key rejection, connection switching, continued conversations and rollback
in Chromium and WebKit; live tests separately verify actual subscription calls.

## Checked inline artifacts

An inline visual is authored through the core harness. Chat profiles offer
`draw_display`, `embed_figure` and `publish_artifact`; the instruction composer
supplies the authoring rules. A display is data: the model writes a JSON spec,
core checks every step and option before rendering, and the reader draws it
with its own components, so no model-written markup or script reaches it.
Chat stopped authoring HTML (the earlier `render_artifact`) because models
filled it with forced controls and drawings Delphi could not keep consistent;
saved answers with HTML visuals still run in their sandboxed frame. The original user question
is preserved. Memory maintenance and research profiles do not gain artifact
tools. An unavailable renderer leaves ordinary text chat usable.

Each turn keeps its drafts in memory. Rendering returns bounded diagnostics,
layout measurements, interaction observations and a screenshot contact sheet.
The model must receive that feedback in a subsequent round before publishing.
Publication binds an id and revision to the exact inspected source; the model
then places a reference in its answer. A delivery gate replaces only accepted
references, before both streaming and trace offsets are recorded. Unvalidated
source and stale references are withheld. Saved history therefore contains the
same accepted source the reader saw, without storing failed drafts or feedback
images in chat traces. Exhausted attempts produce a text fallback.

Installing the renderer does not enlarge an ordinary chat's tool-round budget.
Only a dispatched render attempt unlocks the fixed inspection/repair allowance;
image questions retain their one-tool-round limit until that happens. Schema
refusals can use the extension, but unoffered calls, publication alone and calls
in the closing round cannot. Output-token and deadline ceilings still apply.

Memory filing and conversation titles use `assistant_prose` before clipping or
scanning citations. It replaces artifact code nodes with bounded title markers,
preserving the explanation after a diagram and keeping JavaScript URLs out of
citation evidence. It never rewrites stored answers or user code. Follow-up
history retains exact source for editing: no tool currently retrieves an older
diagram. Its ten-exchange limit is not an aggregate character budget, so long
diagram-editing sessions can still consume substantial model context. Lazy
source retrieval is deferred rather than silently removing edit context.

The delivery gate streams ordinary bold text, headings, lists, Unicode, entities
and LaTeX without waiting for a line ending. Potential fence/reference prefixes
and incomplete encoded markers stay buffered, including when rendering is
disabled. CommonMark permits up to three spaces before a standalone published
reference; references inside sentences, lists, quotes or code examples do not
execute. Publication guidance asks for a separate paragraph. An undelivered
published revision receives a delivery-reference notice, distinct from a render
validation failure; repeated references do not report that the already-delivered
diagram was withheld.

The renderer serializes jobs and launches a disposable worker, which drives
a page Electron lends it (below; a fresh Chrome profile where no product lends
one). Its parent owns the deadline and the worker's process group;
stdin EOF and cancellation tear down the owned group. Credentials and backend
configuration are absent from the worker environment. Network loads,
navigation, downloads and extra browser targets are denied. Authored code runs
only in the opaque iframe used by chat, with the same CSP and runtime. The host
bundle imports the production React component and styles; its manifest binds
the exact assets. Fixed inspection code runs in a separate browser world, so a
draft cannot replace the measurement functions.

Checks cover runtime errors, overflowing or clipped content, control effects
and the header's lifecycle, at 270px and 800px in a finite chat viewport.
Requested interactions run at the narrow width; the wide view adds header and
scroll checks. A control passes by what it changes on screen, never by a class
or style spelling: a finished entrance animation can leave its class in place
without changing the restored view, and comparing class names once rejected
correct Back buttons. These are observations of specified states, not
exhaustive interaction testing or proof of scientific correctness; model visual
review and source-grounded reasoning still matter.

### What fresh trials showed

Fresh trials put fixed visualization questions through the chat benchmark's
HTTP/SSE recorder, in isolated accounts with no human revision prompts, and
reported first attempts, automatic recoveries, failures and latency
separately. A twenty-trial baseline, ten questions each on GPT-6.1 Sol and
Opus 5.5 at high effort, delivered seventeen; the three that did not had hit
the Claude plan's quota. Delivered answers took about three minutes at the
median (51–514 s), and in every one the published source matched the delivered
and saved bytes. That is a small sample of explicit requests, not a success
rate. Two readings matter more than the totals: a second draft is often a
voluntary refinement of one that already passed, so a count of automatic
repairs overstates genuine ones; and a schema-rejected call before a delivered
artifact is a recovered tool call, not an abandoned diagram. An example a
reader improved with follow-up messages is not reliability evidence.

What the trials changed:

- **A tool the model could not see.** An Opus answer said its diagram tool was
  unavailable although the request offered it: Claude Code could connect
  Delphi's MCP server in the background while it built the first prompt. The
  session now asks for server-level `alwaysLoad`, so Claude Code waits for tool
  discovery within its startup timeout. Models still call a Delphi tool by its
  bare name, so `claudeToolName` maps a bare or differently separated name of an
  offered tool onto it, and `claudeToolText` gives code-owned guidance the
  prefixed names.
- **A disconnect after reasoning.** A subscription stream could drop after
  reasoning but before any answer or tool, stranding a checked draft that was
  waiting for inspection. The bridge holds that prelude and retries the round
  (Dropped streams, above).
- **A paper the model could not keep.** On a paper question GPT exhausted its
  hosted searches and then searched the local library for an external paper.
  Hosted search returns no source text that ordinary tool history can carry
  across inspection rounds, and the diagram was withheld over grounding.
  `read_url` fills that gap: bounded, paginated text through the existing
  public-host fetcher and static extractor, with final URL, title and snapshot
  hash, on the document-read budget, at most four snapshots a turn. It never
  starts a browser, parses a PDF or writes the library or Memory; plan and
  maintenance profiles do not offer it, and turning web access off removes it.
  With it, the unchanged question delivered a diagram that was checked against
  the primary paper. Static extraction still misses text a page builds with
  scripts.
- **A paper the model could read but not show.** The same paper's PDF and its
  figures stayed out of reach, so the honest answer withheld the diagram.
  `read_url` now reads a PDF by page in the isolated PDF worker, four pages a
  call under the same document budget, and refuses one over the library's
  100-page ceiling before reading its text: no paper costs a turn more than
  any other source, and the file itself never reaches the provider. The pages
  it returns list their figures by turn-local id; `view_figure` shows one and
  `embed_figure` drafts a card of it from Delphi's template, which is rendered,
  inspected and published like a drawn diagram. A figure is the nearest picture
  above its caption's line, with the panels beside it, never one another
  caption sits under; a figure drawn as vector art is cut as the region above
  its caption and the model is told to check it.
  The card's image stays in the stored answer but is left out of the history
  later turns replay (`chat_history`), so one figure is not paid for again
  every turn.

Passing the checks does not remove every cost a reader sees. A tall diagram at
the narrow width still scrolls inside its frame, adjacent value labels can
crowd at 270px, and some inactive labels are faint.

### Nested frames and the network an artifact never gets

The bootstrap removes `RTCPeerConnection` from the artifact's own window, but
an artifact can create a nested `<iframe srcdoc>`, and that document is a
fresh realm with WebRTC restored. CSP has no WebRTC directive that Chromium
enforces, and `frame-src 'none'` does not apply to srcdoc. A page read with
`read_url` could therefore ask the model for an artifact that sends conversation
text out as a STUN hostname or TURN username, at validation and on every open.

What was measured, in Electron 44.2.0 (Chromium 152) and Chrome 156, with
loopback sinks only:

- Electron emits no `will-frame-navigate` for any srcdoc navigation, nested or
  the artifact's own, so the navigation guard cannot refuse one. A
  `Connection-Allowlist` response header was tried and withdrawn: Electron
  terminates the renderer for a missing `MdnsResponder` binder.
- The artifact runs in its own renderer process (sandboxed frames are
  isolated). Ending that process in `frame-created`, which the browser handles
  before the child's navigation, stops the nested document before it runs.
- `setWebRTCIPHandlingPolicy("disable_non_proxied_udp")` stops UDP but, with
  no proxy, still lets a TURN relay connect over TCP.
- Inside an out-of-process artifact, CDP reports no `Page.frameAttached` for
  its children, so a frame check built on it misses a nested frame removed
  before inspection; each new realm still gets an execution context. The
  artifact frame reports a detach from the host's session when it moves into
  its own process, so a check that forgets frames on detach forgets it.
- Branded Chrome ignores `--force-webrtc-ip-handling-policy`; it reads the
  profile preference the validator seeds.
- Nested srcdoc documents do inherit the artifact's CSP in Chromium and
  WebKit, so fetches and images stay refused; WebRTC alone escaped it.

So the desktop ends an artifact's process the moment it creates a frame
(`artifactFrameWatch`), and applies the UDP policy to the reader as defence in
depth. Artifact identity is fixed when the reader creates the frame, so a
renamed window keeps it and a page in the web frame cannot mint one. The
validator rejects a nested frame by its realm as well as its attach event, and
runs with a dead proxy and the seeded WebRTC preference. A reviewed artifact
never reaches the desktop's kill; one that grows a frame later shows as a
crashed frame, with the reason in the log.
`desktop/tests/artifact-isolation.test.mts` runs the real reader guard in
Electron: an unguarded control reaches both sinks and the guarded window
reaches neither, while controls, Reset, reader fetches and a web page's own
nested frames keep working. `scripts/artifact_security.py` checks the validator
half against the installed renderer and a real browser, a frame removed before
inspection included.

Two smaller gaps closed with it. `read_url` results count as web evidence for
Memory filing by their final address (`gather_session._addresses`). Direct
fetches refuse CGNAT and NAT64 addresses, and the web client resolves at the
socket and dials only the address it validated (`web_fetch._PublicOnlyBackend`),
as Chromium's capture proxy already did, so a second DNS answer cannot move a
fetch inside the network. The renderer's memory limit stays a sampled
watchdog: macOS gives an unprivileged process tree no enforced cap.

## One browser engine: Electron lends the backend its pages

Page capture (a page that builds itself, read once built), document previews
and figure captures, and draft validation each need a real browser. Core used
to launch whichever Chrome was installed, so each of them put a second Chrome
in the Dock, and on a Mac without one they were simply off. Electron already
ships a Chromium, so the desktop now lends core a page of it instead.

The split keeps every tested policy where it was. Core still decides what to
load, when a page is built, which proxy a capture reaches the web through
(`_public_only_proxy`, which checks every host public and dials the address it
checked) and every check run on a draft; it drives the page over DevTools as it
drove Chrome. `desktop/main/browser-host.ts` owns only what Chrome's process
tree did: one disposable page per job, over a Unix socket in a private
directory with a per-launch token, ended at its deadline, at its memory limit,
when its renderer dies, or when the backend closes the stream. Core never falls
back to an installed browser while a host is configured: that fallback would
bring back the second application this exists to remove, and hide a broken host
behind it. An app-wide `--remote-debugging-port` was rejected: it would hand any
local process the reader, signed in.

What was measured, in Electron 44.2.0 (Chromium 152), on Linux under a virtual
display, with loopback sinks only:

- A hidden `BrowserWindow` produced no animation frames in a second
  (`requestAnimationFrame` never fired) and took 3.1 s per screenshot; an
  offscreen one ran at 60 frames a second and took 47 ms. Job pages are
  offscreen: never shown, never focused, no Dock item.
- A draft's contact sheet, validated on the Electron page and on a launched
  Chromium, was identical pixel for pixel (0 of 1.9 million differ), with the
  same verdicts for a sound, a leaky and a nesting draft; 2.6 s against 3.2 s.
- A page's own session proxy carried every request; nothing reached an address
  the proxy refuses, and an artifact page's STUN and TCP TURN reached no sink,
  its own or a nested frame's.

Each page lives in an in-memory session of one of three slots, never the
reader's, so it holds no reader cookie and Chromium never shares a renderer
between it and the reader. Electron cannot free a session, so a slot is cleared
and reused rather than a session made per job. A further job waits for a slot
inside its own deadline. The validator page keeps the reader's navigation guard
and WebRTC policy behind a dead proxy, but not its frame kill: ending the
renderer would tell the model only that its draft "couldn't run", where the
validator reports the nested frame itself. The memory limit is the page's
renderers' resident size, sampled every half second; the GPU and network
processes are shared with the reader and not counted.
`desktop/tests/browser-host.test.mts` runs core's own capture, preview and
validator code against the real host.
