# Delphi architecture

> **This is `core/` of this repository: the `delphi_core` package**, which the desktop
> app builds in and the web app installs as a pinned wheel. The web app's SQL store,
> migrations and deployment, and their incidents, are described in its own repository.

## Design goals

1. Keep identity, paper bytes, extracted text, highlights, and chat history
   server-authoritative.
2. Keep model transport behind a small provider boundary.
3. Preserve document annotations independently of screen size and zoom.
4. Keep the storage backend swappable, and prove the swap with one test suite.

## Request flow

The browser authenticates once and receives a signed HttpOnly cookie. Every API
route resolves the username from that cookie, scopes storage to that user, and
validates project ownership before returning metadata or bytes. Registration can
require a signup code, and the session cookie's `Secure` flag is configurable so
the same build works on plain-http localhost and on HTTPS.

Uploading a PDF streams it to a generated identifier and parses it with `pypdf`.
The page count is checked as soon as it is known — before text extraction — and
a rejected file is removed rather than left behind. The browser checks size
before uploading so an oversized file fails immediately; the server enforces both
limits regardless, and publishes them through `/api/config` so the client cannot
hold a different number.

A paper over the compression threshold has its raster images re-encoded before
it is stored, after the page check so a paper about to be rejected never costs
the CPU. Only image streams are rewritten — the text layer, vectors, and page
geometry are untouched — and `compress_pdf` proves it for each rewrite, against
the page text the route just extracted: a copy that no longer reads identically
is thrown away. The record stores the size of what was actually kept. The
rewrite is also discarded unless it saves bytes, so a PDF that cannot be
improved is never made worse, and a missing image library downgrades to storing
the original rather than failing the upload.

That is also what lets a paper over `MAX_UPLOAD_MB` be accepted rather than
refused. It is compressed like any other, and if the result fits, its bytes are
written under a fresh paper id while the record is not — the reader is asked
whether the smaller paper is the one they wanted, and answers with a signed
token carrying the record to write. Nothing pending is held server-side, so the
answer can land on any instance. Declining deletes the two objects, because
bytes with no record are invisible to every other route and nothing would look
at them again. A paper that still does not fit after compression is refused
having been written nowhere at all.

PDF.js fetches the authenticated file route, paints the page canvas, and creates
its own selectable text layer. Pages render only when near the viewport; the rest
hold correctly shaped placeholders derived from page 1's aspect ratio, so the
scrollbar and citation jumps still land in the right place. The PDF engine is
imported as a module-level promise and warmed while the library loads, since the
cold import — not the file fetch — was what made the first paper slow.

Selections are converted from viewport rectangles to page-normalized
coordinates. The backend stores those rectangles and the selected text. On
render, the browser multiplies normalized coordinates by the current page size.
The same rectangles can be burned into an exported PDF.

## Navigation and URLs

The address bar is the only place that records what is open. There is no
"selected project" or "selected paper" state anywhere in the client; both are read
out of the path on every render, which is what makes a refresh, a bookmark and a
shared link all behave the same way. Before this, all of it lived in `useState`, so
reopening the tab landed on whichever project happened to be newest.

A document is at `/@username/<project-slug>/<paper-slug>`. The backend allocates
lowercase ASCII slugs, adding readable collision suffixes inside the owner's
project namespace and inside each project's paper namespace. A rename replaces
the mapping immediately, so the retired address no longer resolves; deletion
frees the slug for reuse. Opaque project and paper ids remain the durable identity
for storage, object keys and every mutation API.

The visible `@username` is a target namespace, never a credential. The reader
resolver requires the signed session and currently accepts only an exact match
with that authenticated username; mismatch, missing project and missing paper all
produce the same unavailable-document 404. This is deliberately the future
sharing policy boundary: access can widen there without changing canonical URLs
or teaching the browser to authorize from visible metadata.

One active conversation belongs to a document or to the account-wide Memory. Both use the append-only `chat_threads` / `chat_messages` authority; a
public conversation id is provenance and dashboard identity. The path always
names the document being read, and `?chat=paper` or `?chat=general` says which
conversation is docked. Clearing deletes that conversation, so the next prompt
creates a new public id.

The workspace mounts in `app/(reader)/layout.tsx`, and that is load-bearing. A
layout instance is reused across a change to the segments below it, so moving
between documents updates it rather than replacing it — which is what keeps the
library, the chat panel, the panel widths, the per-document zoom and the warmed
pdf.js engine alive across a navigation. Rendering the workspace from a `page.tsx`
would tear all of that down on every click. The pages beneath are deliberately
inert: the shell reads the address itself, so there is one place that turns a URL
into ids rather than three pages pushing params upward. `loading.tsx` and
`template.tsx` are the two file conventions keyed on interpolated params, and are
therefore the two that would remount on every move; neither is used.

Three panels do not fit in every window, and the interesting question is which
one gives way. The grid used to answer by overflowing: two fixed side columns
plus a 360px floor under the reader summed past a half-screen laptop window and
pushed the chat panel off the right edge, where nothing scrolled it back. So no
column carries a pixel floor the window might not have — the reader's real
minimum is enforced where it can be honoured, in the divider constraints, which
also re-clamp when the window itself shrinks. Below `COMPACT_WIDTH` the library
is the panel that yields: it opens as its rail, and expanding it lifts the panel
out of the grid to float over the reader behind a click-away scrim, so the reader
and the chat keep the widths they were given whether the library is open or shut.
Further down, past the point where two columns stop being useful, the chat takes
a row of its own instead — which frees the width the library wanted, so it stops
floating and goes back to being a column.

Because the reader resolver translates the complete visible route in one request,
a deep link does not have to discover ids from the project list. Boot fires
`/api/auth/me`, `/api/config`, `/api/projects` and `/api/reader/*` as one
`Promise.allSettled` — three sequential round trips before anything could paint,
now one. `allSettled` because the resolver leg is allowed to fail: a link to a
deleted document must not take the boot down with it.

Signing in and signing up are their own routes, outside that group, so no workspace
chrome mounts behind them. A request refused with 401 — from any component, at any
time — redirects to `/login?next=<where they were>`, which is what turned a mid-read
session expiry from a workspace where every action failed into a sign-in that gives
the reader their place back. `next` is a destination someone else can choose, so it
is validated as a same-origin path on the way in and again on the way out, and an
auth page is refused as a target so signing in cannot loop.

A document that cannot be opened gets one card and one sentence, whatever the
reason. The API deliberately cannot tell "deleted" from "not yours" — both are 404,
so a stranger with a guessed id learns nothing — and wording that varied by cause
would leak exactly what that 404 withholds.

The bare `/` is the authenticated Dashboard. Its single bounded API read computes
library statistics, recent conversations, document recency, and project cards
without a model call. `/reader` is the empty Reader landing route; canonical
project and document paths still mount beneath the persistent Reader layout. A
document open sends a narrow engagement touch, and Dashboard resume order comes
from that server-authoritative timestamp rather than browser-local history.

Document excerpts are bounded first-sentence extraction, never generated prose.
New PDF thumbnails are complete first-page PDFium renders; web thumbnails are
bounded first-viewport Chromium captures. The renderer pins the source and a
small set of asset hosts discovered in the safely fetched HTML to validated
public IPs and refuses every other host; a flat Delphi card is only the failure
fallback. Thumbnail bytes are written before their metadata and travel through staged discard,
promotion, refresh, movement, and deletion. Old records receive stable
placeholders and are never mutated by a Dashboard load. The first later Reader
engagement opportunistically replaces that placeholder with a derived thumbnail;
the Reader does not wait for the work and a failure leaves the placeholder intact.

The first prompt carrying a mounted surface's `engagement_id` atomically claims
one title attempt for that conversation and engagement. A bounded request over
recent role/content text runs concurrently with the answer, is awaited before
the stream request closes, and may replace the immediate deterministic fallback
with a title cut at a word to `CONVERSATION_TITLE_MAX_CHARS` (120), the same bound
as the fallback and a rename. Failure keeps the last good title
and cannot cancel the answer.

## Web documents

A project can hold web pages beside its PDFs. The motivation is that a great deal
of what people want to read is a blog post or a docs page, and asking them to
print it to PDF first both adds friction and destroys the parts worth reading —
typeset maths, interactive figures, embedded media.

Adding a page fetches it once and stores a *snapshot*: the article cut into
sections, each labelled with an anchor. The anchor is the heading's own `id`
where the page has one, and a slug of the heading text where it does not. That
choice is what makes the rest work — those ids already exist in the live DOM, so
the same anchor names a slice of text for the model and a scroll target for the
reader. Sections are the web equivalent of page numbers.

Extraction descends into anything containing a heading rather than trusting a
tag to be a leaf. `<figure>` has no implied end tag in HTML5, so a post that
opens one and never closes it nests every later section inside it — a browser
parses it that way too — and a tag-based walk silently loses two thirds of such
a page.

Only the outline reaches the model: titles, anchors, and word counts, a few
hundred tokens for a 15,000-word post. A `read_webpage` function tool serves one
section on request, and the chat route runs a bounded loop, handing the model's
own output back (reasoning, what it said, its calls) with our
`function_call_output`, because `store: False` means the provider remembers
nothing between requests. A question about PDFs
alone still sends no `tools` field at all, so its cached prefix is untouched.

In the Reader the panel shows the live page, not the snapshot, through a proxy
that injects `<base href>` and a bridge script. The saved title, URL, snapshot and
digest remain pinned to the document the reader created. Following a link changes
only a temporary viewport inside the mounted `PageViewer`; its bounded 25-entry
history, captures and scroll positions disappear on document switch, logout or
tab close. The browser's joint history stays flat because the parent remounts the
frame for each entry, so the browser Back button still leaves the Delphi document.

The base tag is why the anonymous path stays small:
stylesheets, fonts, images and scripts resolve against the origin site and load
straight from it, with no rewriting engine and no asset traffic through Cloud
Run. `render_frame` removes redundant anonymous CORS attributes from originally
same-origin stylesheets and classic scripts; modules, fonts, integrity checks and
credentialed loads keep their declared behavior. What it costs is that the page
runs in an opaque origin, so its own
same-origin `fetch` fails CORS and `localStorage` throws.

Normal trusted left-clicks mint one destination authorization on Delphi's
credentialed origin, then submit the destination and token as fields to a
frame-only POST route. The token is short-lived and bound to user, project,
paper, sandbox mode and the exact normalized URL hash. The destination and its
query never enter a request URL. Both mint and frame routes check the host, and
the fetcher checks every redirect hop. Modified clicks, downloads, `_blank`,
non-HTTP links and POST forms remain explicit external actions. Same-document
fragments stay inside the bridge; scripted cross-document navigations are
cancelled where the Navigation API exposes `userInitiated`, with hello recovery
as the backstop.

Images are decoded and re-emitted as bounded static WebP inside the same bridge.
PDFs get an import-or-open interstitial rather than Chrome's opaque PDF viewer.
Navigation fetches exactly once and never updates `.web`, `.txt`, `sourceHash`,
digest metadata, or the document's visible title.

Getting the bytes is a ladder, and only the rung a page actually needs. A plain
fetch serves almost everything. A 401/403/429 carrying `Set-Cookie` is a
*challenge* rather than a refusal, so one retry replays those cookies — which is
what makes a WAF-fronted blog readable — and they stay local to that call and
host. A page that parses to no sections at all, or a status a browser might walk
through, escalates to `browser_render.render_dom`, which runs the page's own
scripts and returns the DOM they built; that is what makes a public Notion page
or any comparable SPA readable, and it costs ~10-20s on the add. Anything left
is classified by `describe_failure` into blocked, missing or unavailable, so the
reader is told which site refused and why rather than a status code. Delphi does
not try to defeat bot detection.

Anonymous fetches share one lifespan-scoped HTTP/2 connection pool with bounded
connections and keep-alives. Every outbound request is constructed as a raw
`httpx.Request` before `send`, so cookies learned from an upstream `Set-Cookie`
are never merged into a later request. Responses and the pool close explicitly.
Timing and failure logs identify stages and categories without destination query
strings, captured prose, tokens or image bytes.

### The sandbox origin

Pages are served from a second origin — `WEB_SANDBOX_ORIGIN` — and that choice
is what decides how much of the web actually works.

Sandbox flags inherit into nested browsing contexts and can only narrow. A page
that embeds a Vimeo or YouTube player is embedding an iframe, so without
`allow-same-origin` the *player* loads unable to use *its own* origin, and
renders a dead poster frame. Granting it is what makes embedded video and 3D
demos work, and it also retires the shims below, since storage, cookies and
history start working natively.

It is safe exactly when the origin granted is worthless to an attacker. On
Delphi's own origin it would be catastrophic and `HttpOnly` would not help: a
proxied page cannot *read* the cookie, but the browser still attaches it to any
same-origin request the page makes, so `fetch('/api/projects')` returns the
reader's library. On a host the cookie never reaches, the same script gets 401.

Locally that host is free: `127.0.0.1` and `localhost` are different hosts and
therefore different origins, and a host-only cookie set on one is never sent to
the other — one uvicorn serves both. Left unset, pages are served
without a real origin: everything still reads, embedded media does not play.

Because the sandbox origin has no cookie, the canonical frame's address carries
a token instead — signed with the session secret, scoped to one user, project and
paper, valid for minutes, and accepted by no other route. Temporary navigation
uses the destination-bound form token above. The canonical token is deliberately
worth as little as possible; the path rewrite below strips it before the page's
own scripts run.

Almost the entire security weight of web documents now rests on that one setting,
so it is guarded twice. The app refuses to start if `WEB_SANDBOX_ORIGIN` is also
a frontend origin — the realistic mistake, made to silence a CORS or
frame-ancestors error, and one that would look like it worked. And the page route
refuses at request time if a token and a session cookie arrive together, since
that means the origin is receiving credentials whatever the configuration says.
The second check exists because the first cannot see the failure that worries me
most: the session cookie later gaining a `Domain=` attribute to share login
across subdomains, at which point a subdomain sandbox origin silently starts
receiving it and nothing in the configuration has changed.

### The frame's path

`window.location` is unforgeable, so a proxied document reports Delphi's path
rather than the article's. A client-rendered site reads that as its route, asks
its own API for a post that does not exist, and replaces the perfectly good
server-rendered article with its own 404 — Substack does exactly this, and
granting a real origin made it worse by letting the framework hydrate far enough
to overwrite what was already on screen.

`history.replaceState` is the one part of `location` that can be changed, and it
is permitted as long as the new URL is same-origin with the document, which the
sandbox origin is. So the bridge adopts the article's own path before any of the
page's scripts run. The path need not exist on that server; nothing is fetched.

Device powers are a separate mechanism from sandbox flags and also delegate
downward, so the outer frame passes through `autoplay`, `fullscreen` and
`encrypted-media` or no player can use them.

Two things keep the rest safe. The routes serve HTML only to a frame request,
redirecting a top-level navigation to the real site, because the sandbox
attribute is applied by the embedder and there is no embedder in a bare tab.
`Content-Security-Policy: sandbox` was the obvious alternative and is not used:
Chrome renders such a document fine at the top level and paints nothing at all
when it is framed. The canonical GET route still takes no URL at all; the
separate navigation POST accepts only the exact destination its authenticated
parent minted, so neither route is an anonymous open proxy.

Without a sandbox origin configured, the frame has no origin, and four ordinary
APIs throw — `localStorage`, `sessionStorage`, setting `document.cookie`, and
`history.pushState`/`replaceState`. With one configured only the last still
throws, because `<base href>` makes a relative history URL resolve cross-origin;
the shims below detect what actually fails and install themselves accordingly,
so they cost nothing once the origin is real. Every client-rendered framework
touches at least one while
booting, so a React or Next site would return perfect HTML and then die during
hydration, leaving a blank frame. The bridge shims all four before the page's own
scripts run, which is why it is injected at the top of `<head>` rather than the
end of `<body>`. The shims grant nothing back: storage is per-load memory,
cookies go nowhere, and a history entry keeps its state but not its URL.

Trusted reading clicks may move to another public page in the local viewport.
What remains with the page is anything it does to itself: `javascript:` links,
fragment jumps, and handlers driving animations, tabs and 3D demos. A per-served-
document nonce accompanies every bridge message, and the parent binds the first
valid hello for each remount; page script cannot manufacture a trusted request by
posting a lookalike message.

Intercepting clicks is not sufficient on its own, and cannot be made sufficient.
Substack's Subscribe control is a `<button>` whose handler sets `location.href`;
no link is clicked, and `window.location` is unforgeable, so that assignment
cannot be patched from script. Forms, `window.open`, meta refresh and client
routers are all further entries in a list that will always be missing one.

So the guarantee is enforced as an invariant instead: **the frame only ever
shows a document Delphi served.** Every document the proxy returns says hello
while it parses, before any of the page's own scripts run. Every committed
navigation fires `load` on the frame. A load that cannot claim a hello is a
document we did not serve — a page the site sent itself to, or the browser's own
"refused to connect" — and the panel puts the reader back and says so. That
covers every escape route at once, including ones that do not exist yet.

Hellos are *claimed* rather than counted or flagged. A boolean would still be
set from the previous document when a foreign one arrives, which is precisely
how the first version of this check missed the escape it was written for; a
running total drifts permanently once a foreign load has consumed a load with no
hello. Claiming resynchronises by itself and does not care whether the hello or
the load event arrives first. Recovery is capped, because a proxy route that
somehow stopped greeting would otherwise reload forever.

There is no trusted URL to follow in that case: a script triggered the navigation
and the page it reached is cross-origin. Recovery restores the current local
history entry rather than mutating the saved document.

### Pages that need a signed-in reader

Out of scope on this branch, and worth being precise about why. A proxy fetch is
made by the server, which holds no session of the reader's; the session cookie
is HttpOnly and scoped to the publisher, so it cannot be borrowed. A plain
`<iframe>` at the live site would carry it, but every such publisher sends
`frame-ancestors`, and even if it rendered, a cross-origin frame is opaque —
Delphi could not read a word of it for the model or expose a selection.

That leaves code running inside the site's own origin in the reader's browser,
which on the web platform means a browser extension. An attempt at one lives on
the `in-app-browser` branch. It is unfinished for a reason worth recording: a
signed-in page like X builds its media only when Chrome actually paints the tab,
and a tab captured in the background is never painted — the post, the layout and
the sign-in all arrive, and not one image exists.

## Model requests

On the first model question for a paper, the backend uploads the PDF to the
OpenAI Files API and stores the returned file ID, guarded on being unset so two
concurrent first questions cannot orphan an upload. Responses API requests reuse
those IDs, send PDF page images at `detail: "low"`, retain ten complete
question–answer exchanges in every scope, and stream back server-sent events: answer-text deltas, reasoning
summaries, and hosted-tool status. The completed assistant message is appended
only after the stream finishes. Deleting a paper or project also attempts to
remove its remote OpenAI files.

The model is client-selectable from a server-supplied list, with unrecognized
names falling back to the default. Hosted web search is opt-in and omitted from
the payload when off, so it does not perturb the prompt-cache prefix.

Document chat resolves context only when a question is sent, from the canonical
snapshot; an anonymous redirected page is fetched and extracted once in memory;
and an image becomes low-detail visual input. The project's other documents
arrive only as saved digest cards, never written while a question waits. Successful redirected
answers first persist the exact clean context as immutable paper-scoped evidence,
then append the assistant message with its evidence metadata, so a later citation
reopens the same view without changing the paper. Clearing paper chat or deleting
the paper deletes its evidence; moving the paper moves the evidence.

Web creation does not automatically generate a digest. Explicit generation and
document filing do; an ordinary document question attaches only the digests that
are already ready (`ready_project_digests`) and never builds a missing one. New
web digest metadata includes `sourceUrl` and is valid only when version,
source hash and the stored document URL all still match. The generating model
is provenance: switching the author for future calls does not invalidate a
completed digest. Explicit regeneration still uses the currently configured model.

Research Digest v7 is a compact evidence index rather than a visual quota. It is
bounded to 8,000 characters (about 1,000–1,500 words), high reasoning effort and
a 16k output budget. Before
generation Delphi inventories bounded, stable PDF and web elements—captioned
figures, tables, algorithms, exact rendered candidates, dimensions, hashes,
duplicates and QR/barcode decoys. Terra/high may select zero or more exact IDs and must
bind each placement to evidence; Delphi captures that candidate, stores its bytes
before the digest envelope, and removes superseded bytes only after the new
envelope publishes. The digest keeps formal notation, procedures, negative
results and distinct result/ablation tables when the source makes them material.

Document filing is a versioned pipeline independent of persona voice, the package
`memory_maintenance/`. A document's `source` page is not part of it: Delphi copies
that document's research digest as the page, carrying its citations and its
captured assets across, when the digest is published. So the page a reader opens
to bring the paper back is the artifact already written and already validated
rather than a model's second account of the same thing. It is also the only way to
guarantee one document has exactly one page - a rule a per-filing validator could
state but never enforce, because the failures it allowed happened between filings.

Import queues one `document` job, and a job runs five stages in order. *Gather*
reads the closed evidence set with no model: the document and its digest (the
reader's notes are their session's to file). *Select* is one cheap call over the whole Memory index
that names the pages the event bears on, or says there is nothing to file, in
which case no agent runs. *Maintain* is one agent in a bounded tool
loop: it reads Memory with the tools chat reads it with and changes concept pages
with two tools that write, each of which checks and stages and stores nothing.
An edit names blocks of the page as it was shown and never carries a new body,
because a model that rewrites a whole page to add a paragraph quietly loses
detail from the paragraphs it meant to keep. *Verify* shows every staged page to
a second model beside the exact passages its citations name. The checker
reports and Delphi decides: an objection blocks its page only when its quote is
in what the checker was shown, since a checker that is believed costs the reader
a correct page for every objection it invents. A blocked page gets one repair by
the same agent run and one more check, then is dropped by itself and named on
the job's event. *Commit* writes the pages that passed, their version rows and
the event in one transaction, each page against the revision the agent read.

Prose, LaTeX, Markdown tables, pseudocode and Mermaid are the whole
representation vocabulary, and all of it lands in the one atomic commit.
Generated diagrams, charts and animations used to be drawn in a provider code
container as optional follow-up jobs. They were retired: a measured filing spent
three container renders and nine minutes, then lost the answer's page update when
the visual check returned nothing, and document filings never reached them at all.
A mechanism that prose cannot carry is what Mermaid is for.

### What the provider does, measured

The harness rests on provider behaviour that is documented thinly or not at
all, so it was measured before anything was built on it: on October 10, 2026,
against the API-key connection with `gpt-6.1-sol`, by a probe script since
deleted. Every request was stateless (`store: False`) with hosted web search
beside a function tool. The macOS app's subscription connection was measured
with the same requests on October 11 and differs in one way that matters: it
rejects `max_tool_calls`, so the app's bridge drops it and only the count kept
here, which closes web search for later rounds, limits hosted calls there.

| # | Question | Measured | Decides |
|---|---|---|---|
| P1 | What may a next round be handed back? | Every form is accepted: a `web_search_call` verbatim, without its `id`, or left out; reasoning whose neighbouring hosted item is left out; a message with its `url_citation` annotations. **Leaving the hosted item out is accepted and wrong**: the next round ran the same search again and read about twice the input | `REPLAY_POLICY` hands a completed `web_search_call` back without its `id`, and a message with its annotations |
| P2 | `max_tool_calls` | Accepted, minimum 1 (`0` is a 400). Each `search`, `open_page` or `find_in_page` is one `web_search_call` item and counts as one; a function call does not count. A call past the limit still arrives as an item, but its final `status` is `searching`, never `completed`, and the response completes normally | The allowance counts items whose status is `completed`. A spent allowance is never sent as `0`; the round restricts callable tools instead (P6) |
| P3 | `include: ["web_search_call.action.sources"]` | Accepted. A `search` action carries `sources: [{type: "url", url}]`, with no titles. `open_page` carries its `url` | A web row in the trace lists addresses; titles come from citations |
| P4 | Citations | An annotation is `{type: "url_citation", url, title, start_index, end_index}`. The cited address is already an inline Markdown link in the text. The indices count Unicode code points | Positions are not stored; rendering matches links to `sources` by address |
| P5 | The output ceiling | The stream ends with `response.incomplete`; `response.status` is `incomplete` and `incomplete_details.reason` is `max_output_tokens`. The partial text has streamed, its message item has `status: "incomplete"`, and usage is present | The terminal contract and its fixtures |
| P6 | Closing a turn | `tool_choice: "none"` and `tool_choice: {type: "allowed_tools", …}` are both accepted beside a hosted tool, both are enforced, and both leave the cached prefix intact (15,860 and 15,932 of 15,932 cached tokens). Removing `tools`, which the closing round used to do, cached nothing | The closing round keeps `tools` and sends `tool_choice: "none"`; a spent class is withheld with `allowed_tools` |

One consequence is not a setting. In a turn that searches and then calls one
of Delphi's tools, the search results themselves are not among the items a
stateless next round can be handed. The model keeps what it learned in its
sealed reasoning, and the final message may then carry no citation annotation
for a fact it found a round earlier. The addresses it consulted are still in
the trace.

## The storage boundary

`Storage` holds records and `ObjectStore` holds bytes. Neither exposes a
filesystem path, because another product's implementation (the web app's SQL
store) has no path to expose; routers call entity methods and
never learn where data physically lives. The health endpoint reports only the
backing-store kind; account responses deliberately omit physical locations so
deployment details never become user-facing account metadata.

Every implementation — the filesystem one in core, the web app's SQL one — runs
the test kit's store tests (`delphi_core_testkit.conformance`), so
a divergence fails a test rather than production. An app's stores are chosen
when it is created (`create_app`'s `Stores`); core's own are the local ones.

Three properties come from the design rather than from patches:

- The project list is derived, so there is no duplicate summary to drift.
- Chat turns are appended as rows, so a second tab cannot drop the first tab's
  messages.
- Object keys pass through identifier validation, since an object store will
  accept a key containing `../`.

Serving PDFs keeps range requests working without buffering the file: the range
header is resolved explicitly and the object store seeks. Responses are marked
immutable, because the bytes for a paper id never change.

## Extension points

- **Storage:** implement `Storage` and `ObjectStore` for another backend and run
  the contract suite against it.
- **Retrieval:** PDFs are attached whole and web documents are read a section at
  a time; replace either with chunking, embeddings, or reranking behind
  `build_responses_input` while keeping the chat route stable.
- **Tools:** `read_webpage` is the first custom function tool, and `run_model_turns`
  is a general call loop — another tool is a schema plus a branch in it.
- **Models:** add Responses-compatible services behind the provider boundary
  without leaking credentials into the browser.
- **Background work:** move extraction/OCR into a task queue and add processing
  status to paper metadata.
- **Limits:** make project and upload limits plan-aware in `Settings`.

## Known boundaries

- Text extraction does not OCR scanned PDFs.
- Project chat still loads bounded full-text context rather than vector
  retrieval, but it is no longer the only way to find something: `search_library`
  ranks a lexical index over every stored page and section in the account, so a
  question can discover which of thirty documents across four projects is worth
  opening before it opens one.
- On the local store that index is a linear scan — correct for a single machine, not a scalable query, the
  same admission the persona marketplace makes. It is also *lexical*: it will
  miss a paper that discusses a concept in different words, which is exactly
  where an embedding index would earn its place later. The compiled Memory is what covers that gap in the meantime, because it stores the reader's
  vocabulary rather than the authors'.
- `document_sections` is derived and rebuildable from the stored `.txt`/`.web`
  objects at any time (`python -m delphi_core.backfill.index`), so it is a cache with a source
  of truth rather than a second copy that can drift. It is never the authority
  for what a document says.
- Extraction prefers the HTML as served, and escalates only when that is not a
  page: a site that renders entirely in the browser is built once in headless
  Chromium and read from the DOM its scripts produced. A page served only to a
  signed-in reader still reaches Delphi signed out, and the reader can browse it
  live in the frame.
- Without a sandbox origin, storage and cookies inside the frame are per-load
  memory, so a consent banner reappears on every open and preferences never
  stick. With one, they persist per sandbox origin rather than per document.
- A site's consent banner now works properly, which includes its scroll lock: a
  page can refuse to scroll until the banner is answered, inside the frame.
- The frame adopts the article's path, but not its origin. A site that routes on
  origin or subdomain can still resolve incorrectly.
- Webfonts licensed to a domain (Typekit, Hoefler) refuse to serve a frame that
  cannot present their customer's referrer, so such pages fall back to system
  faces. Nothing can be done from this side.
- A saved webpage is refreshed explicitly or by a healthy annotation capture.
  Stored-render pages require explicit Refresh. Captured Reply evidence keeps
  the selected text revision even when the source URL subsequently changes.
- Web highlights use versioned text anchors. Unplaceable annotations remain
  available as original quotes and notes rather than disappearing.
- With `<base href>`, the origin site serves the reader's browser directly and so
  can see them; `referrer: no-referrer` keeps Delphi's own URLs out of its logs.
- Sessions use one HMAC secret and do not include password recovery.
- The webpage toolbar lists highlights and notes even when inline placement fails.
  A PDF's list sits in the reader toolbar, and is how a click on overlapping
  strokes — painted as one band — reaches each record.
  Annotation creation is scoped to the saved document; temporary browsing and
  historical citation evidence do not create marks on that document.
- A *conversation* references a persona inside its own account and *copies* one
  taken from the marketplace; a project holds none. Editing your own reaches
  every conversation of yours that names it; installing someone else's forks a
  private copy that never receives their later changes. There is no "update
  available" prompt yet.
- Deleting a persona is always allowed. A conversation that still names one
  answers as the default from its next turn, because a stored id naming nothing
  is an ordinary state rather than an error. Deleting an account removes its
  published personas from the marketplace, and every copy already installed
  keeps working.
- Publishing is immediate and author-controlled. There is no reporting path, no
  review queue, and no administrator role. A published persona is another
  reader's text entering your instructions, which is why it arrives inside the
  same `<project_skills>` wrapper as your own, is shown in full before you take
  it, and is copied rather than linked.
- Learner memory is no longer per project. It has become the **Memory**:
  an account-wide wiki of interlinked markdown pages, organised by domain, that
  Delphi writes and the reader browses at `/memory`. A paper moved
  between projects therefore keeps the Memory pages it produced — projects and
  papers appear on a page only as provenance, so deleting either leaves the page
  standing with a dangling citation.
- The Memory graph is one borderless composition: a 16:9 graph field and a
  full-height reserved right rail with the legend at its top. Gesture help
  anchors to the lower-left edge of the viewport-height graph section rather
  than to the shorter drawing. Graph and Health have durable
  `/memory/graph` and `/memory/health` routes under the
  Settings sheet's Memory pane; the wiki itself carries no section rail.
- The Memory pages reaching a Project question are chosen by a small model call
  that reads the whole index, at most `SELECT_MAX_PAGES`, opened into the request under a
  character budget. Everything else is reachable from them through
  `open_memory`, `memory_links` and `grep_memory`.
  The Memory tools are intentionally offered to every persona whenever the
  KB operator switch is enabled. Persona text controls style, not whether the
  account's memory exists. Persona rows carry no capability flags; the
  `learner_memory` capability and the learner-note table it gated are gone.
- A captured figure is a copy of a figure in a document the reader added, held
  for their own recall. They are account-private, served only to their owner,
  and deleted with the page. A figure that cannot be captured — animated,
  oversized, or refused by its host — is kept as a link and may stop resolving
  later; Health reports it and nothing re-fetches automatically.
- Importing a document files it, and so does a finished session; marking a
  document done files nothing. Memory holds three kinds of page: a `source`
  page is one document's digest, a `concept` page explains one idea, and a
  `domain` page says how the pages filed under it connect. Only concept pages
  are written by the filing agent.
- A session is what the reader did beside one document (its chats in every tab
  and its note changes) or in one Memory chat, and it is filed once, after the
  reader leaves. Every whole answer and every note change holds the session's
  one job and pushes its wait forward; the window reports that the reader left
  (`POST /api/memory/sessions/release`), reports it for every session at
  launch because closing the app sends nothing, and the idle limit ends the
  wait when neither happens. An exchange is filed only if it rested on
  something other than Memory: a document the answer held or opened, a passage
  the reader selected, or the web while outside evidence is switched on. That
  is what keeps a Memory chat from feeding on its own answers. What Delphi
  answered is never a source; a claim taken from an answer is cited to the
  document the answer rested on. A conversation held before sessions were
  filed keeps its history out: its first whole answer starts the watermark
  just before that exchange. A long session is filed in parts of eight
  exchanges, and the agent is given an excerpt of each answer.
- What rests on a note cites it, and goes when the reader deletes it. Notes are
  filed only by their session's job, in a run of their own after its
  exchanges, and in that run Delphi's own inference and uncited text must cite
  the note they came from; what a document's page says stands without it and
  stays. When the note is deleted, the pages citing it go to the agent, which
  removes what rested on it alone and is refused a page that still cites it or
  keeps those words; a page it left alone loses, in the commit, each statement
  that cited only the note and Delphi's inference, and the note's citation
  everywhere else. An edited note is filed again from the pages that cite it.
- A domain's page is written by a `domain` job and never on read. The job is
  queued when a page joins or leaves the domain or is deleted, when a member's
  summary changes, or when the domain is created or renamed, and it waits for
  the domain to settle so a burst is one composition. `general` is never
  written, nor a domain with fewer than three source and concept pages; a
  domain with no written page has none, and nothing writes a listing to stand
  in for one. A written domain page may be chosen for an answer and is never
  offered as a neighbour of another page. Its prose lags the domain until the
  job runs in an open tab.
- The Memory check (lint) reports and writes no page. It reads concept and
  domain pages, keeps a contradiction only when it quotes each page in words
  that page holds, and queues one `reconcile` job for each; that job runs
  through the same pipeline with no selection call, may cite only what the
  pages already cite, and can edit the concept pages among them.
- Filing is durable, foreground-driven work. The backend creates an account-
  scoped `document` job before a new paper becomes visible, and again when a
  digest is republished with different content. Workspace and KB mounts lease
  and drain those jobs while a request is open, because a server cannot be
  relied on to run detached work after a response closes. A closed tab merely leaves
  a lease to expire; the next mount resumes it. A job's event carries its
  operation (the job's id, the version it was queued for and the fingerprint of
  what it read), which makes recovery after a completed write idempotent, while
  three failed attempts remain inspectable and explicitly retryable through the
  maintenance API.
- A Memory page records nothing about the reader: no level, no observations,
  no count of how often or how recently they met it. Two rules hold at the
  durable write in both backends, each against the record read inside the same
  lock or transaction. A job's commit, a page rewrite and a digest
  refresh carry the revision they drafted against, so a stale draft cannot
  overwrite a newer publication (`check_expected_revision`). And a page is one
  of three kinds, its citations one of four claim types (`check_page_shape`).
- A page the checker blocked twice is dropped, and stays reported on Health as a
  dropped target until a later job for the same document writes everything it
  stages. It is read from the newest event of the document's markers over the
  whole log, so no window ages it out. Retry files the document again; nothing
  else clears one. What an empty list means is that no document's last job
  dropped a page, not that every page was checked: the checker reads only what
  a job stages.
- A reader can bring one page to the current authoring pass without re-filing
  the document it came from. `Rewrite this page` revises the prose of one
  `concept` and is refused if it would change that page's links, evidence
  markers or figures, so the graph the reader built holds still. It needs the
  page's cited documents still in the library, clears nothing the document
  owes, and is not offered on a derived `source` page or a composed domain
  page. The Reader's own control is document-scoped and says so.
- Digest generation uses deterministic validation before publication, without
  a second automatic model check. The filing checker remains; an
  additional digest verifier needs evidence of meaningful benefit before its
  cost and potential retries belong on every document.
- No embeddings, and no image generation. Retrieval is index plus tool, and
  every figure came out of a document the reader chose.
- A domain of interest is a record (`memory_domains`) rather than a bare
  string: it carries the title the reader chose, their ordering of it, and
  whether they claimed the domain or a model named it in passing. The slug on
  each page stays denormalised beside it, because that is the hard filter
  every read already runs.
- The sidebar's hierarchy is *derived* from the link graph, not stored. Every
  sub-domain heading is therefore a real page rather than a curated category,
  and a domain whose pages all link only to its domain page renders flat. Reader-defined
  domains and re-filing are the escape hatch; a stored parent per page would be
  the next step, and the tree builder already accepts one.
- The Memory conversation opens in the wiki's right rail (not a
  separate page): the compact composer unrolls a bounded chat above Related
  Memory while the whole rail remains scrollable. It gets the full ladder —
  the wiki first, the library behind it — and reports which it used rather
  than promising. Its "how it got there" panel is computed from Delphi's own
  record of the calls it made, never from the model's account of its own
  reasoning, so every line is checkable and the prose is terser than a
  narration would be. Its selected persona is a request-start snapshot of an
  official or account-owned persona (Mentor by default), applied as style rather
  than evidence. Its elapsed figure is time spent in lookups, not the length of
  the turn. Related Memory is the configurable, undirected local traversal
  of stored wiki links, defaulting to two hops. Domain membership is visual
  grouping in the full graph, never a shortcut in a rail. Both rails consume
  backend distances from the current source/wiki page. Reader rails request only that
  bounded neighborhood; the ETag-aware whole graph remains a durable route for
  the times a local view is not enough. Its 1,000-page renderer paints a seeded
  high-DPI Canvas immediately and settles positions in a worker, so simulation
  frames never reconcile thousands of SVG elements through React.
- **Delphi syncs with no other application.** `Storage`/`ObjectStore` expose no
  filesystem path by design, so a vault sync would be a second product.
  `GET /api/export` (`account_export.py`) is the escape hatch, and it is one-way:
  the whole account as one folder — documents as added, digests, annotations,
  chats as transcripts, Memory, personas, plans — with a `README.md`, a
  `manifest.json` and an `index.html` that opens from disk. It targets no
  application's format. Every `[[link]]`, `figure:<id>` and `[E<n>]` is
  resolved to a relative path, because they name things only Delphi can find;
  converting the folder to a vault or an import is left to whoever needs it.
  Page history, the filing log and the queue stay out: they mean nothing
  without Delphi. It is built into a temporary file, never in memory.
- The raw layer holds PDFs and web pages. Images, datasets and repositories are
  not document kinds Delphi has — chat images are deliberately ephemeral — so
  they are out of scope rather than overlooked.
- Moving a paper is a single request that copies its objects to their new keys,
  re-parents the record, then drops the old copies. Interrupted midway it leaves
  unreferenced objects at the destination rather than a paper whose record points
  at bytes that are not there; nothing sweeps those up yet.
- Marketplace browsing on the filesystem backend scans every account's persona
  directory. Correct for a single-machine install, and not a scalable query.
- `projects.skills_*` are gone, dropped by `b8d24f60a3c1` a release after the
  code that stopped reading them. A project holds neither guidance nor a
  persona; both were the same thing wearing two names.
- A project holds at most 50 documents in total, archived included. Marking a
  paper done frees a slot in the 10-document working set but does not grow
  the project past that ceiling.

---

## Incidents that set a rule

The operating manual (`CLAUDE.md` / `AGENTS.md`) states these rules in one or two
sentences and points here. Each of these cost real time; the lesson in the last
line of each is usually worth more than the fix.

### equations with the wrong stylesheet

Fractions and superscripts rendered as overlapping notation even though the
LaTeX parsed successfully. The app imported KaTeX 0.18.1's CSS while
`rehype-katex` rendered with its own 0.16.47 dependency. The newer stylesheet
renamed layout classes such as `.base` and `.strut`, leaving the older HTML's
geometry partly unstyled. Adding padding around the equation could not repair
that missing internal layout.

The direct KaTeX dependency now matches the renderer. `latex.test.mts` checks
that validation, rendering and the shipped stylesheet use the same release;
`markdown.spec.ts` exercises the actual renderers with production CSS in both
browsers. A successful parse is not evidence of a correctly typeset equation.

### the queue that never drained

*Rule: invariant 50a.*

Thirty-nine papers sat queued at zero attempts and were never filed, behind a handful
of jobs claimed a dozen times each with `lastError` null. Three separate defects, each
of which alone would have been survivable:

- **The stream went silent and nothing raised.** A model call says nothing for as long
  as it thinks, and an intermediary drops a connection that idles — *without a frame*,
  so the client sees a clean end of body and the route's `except` never runs because
  nothing raised. Invisible in local development, where nothing sits between the two
  processes. `delphi_core/sse.py::event_stream` is now the only way to answer with an event
  stream, heartbeating at the *byte* level so it covers routes nobody thought about,
  emitting an SSE comment that `parseSseFrames` already skipped — so it reached every
  existing client unchanged.
- **A strict `createdAt` claim order starved the queue.** `attempts` counts *claims*,
  so a drain the reader navigated away from would be reclaimed by the very next mount,
  ahead of everything behind it, forever. Claim by kind, then least-attempted, then
  oldest. The kind rank (documents before every other kind) is a deliberate trade whose
  real cost is that a whole-library refile starves domain composition until it drains —
  accepted, because the alternative starves the thing somebody is watching.
- **A cancelled claim was being spent rather than handed back.** `asyncio.CancelledError`
  is a `BaseException` that `except Exception` cannot see, so counting it cost a real
  document every attempt it had, with no filing ever tried and no error ever recorded.

**Whenever a handler decides what a failure means, check what it does with the
cancellation it cannot catch.**

A fourth follow-on: the document and chat writes were then the only enqueuers, so creating a domain, renaming one, moving pages or deleting one left a domain page
describing a membership that no longer existed. Enqueue from the storage method rather
than the router, and enqueue *liberally* — `resolve_compose_targets` is what knows
whether there is anything to write. (History: that function and the listings it
maintained are gone. `storage/domains.py::domains_owed` now decides which
domains a page write leaves owed, and `gather_domain` whether there is
anything to compose.)

### the lint that called every page an orphan

*Rules: invariant 48, and the whole-edge-list trap in `§8`.*

The graph and the lint each walked the link graph page by page — thirty-nine round
trips to draw one picture. Worse, the lint *reasoned from the walk's output*: handed
only the **unresolved** targets under a heading that said "link graph", it concluded
honestly and wrongly that no page had an incoming link, and reported every page in the
account as an orphan. Orphan-hood is `linkDegree == 0` and was already on every listing.

This is the only lint bug this repository has seen, and it was not a model failing to
reason — it was a model reasoning correctly over an input whose label lied about its
contents. **Worth remembering when naming anything a model is asked to reason over.**
It is also why the health tiers are split: what is countable is computed from the
records with no provider configured, and only contradictions cost a model call.
(Lint also suggested next questions and wrote pages then; it now reports
contradictions and writes nothing.)

A related shape in the renderer: `buildGraph` used to mint a node for every slug in the
edge list, so a dangling `[[link]]` arrived as a dashed circle opening a 404, and a
third of a real 246-page picture was those. The account graph now drops dangling targets
**at the edge**, not at the node — filtering nodes later leaves lines drawn to nowhere,
and the degree the radii scale from would still have counted them.

### the passes that settled an objection they had not worked on

*Rule: invariant 48, for dropped targets. The objection record this happened to, and
invariant 48a, were retired with the filing pass they belonged to; the lesson is kept.*

`unverified_filings` walked the newest 200 events and treated *any* later event naming a
slug as having settled it, so a page move, a lint, a domain compose and an answer ingest each
cleared an obligation none of them had discharged — moving a page to another domain marked
its objection resolved. The 200-event window did the rest: past it, an objection aged out
of Health and Update at once, so the finding and the only control that could act on it
disappeared together. A windowless per-marker projection replaced the scan.

The reader-facing consequence is worth stating plainly, because it is the kind of thing a
UI quietly gets wrong: **an empty Health list means nothing owed is recorded, not that
every page passed a check.** What replaced the objection record keeps both halves of the
fix: a dropped target is read from the newest event of its own document's markers, over
the whole log.

The same change fixed a second defect, in a rule the learning model took with it when it
was removed: a page write replaced a stored reader level whenever a filing did not mention
one. What that fix left behind is where a rule about a write belongs — at the durable
write, against a `prior` read inside the same lock or transaction, because "every writer
remembers" is not a property anything can enforce.

### the page lost over one sentence

*Rule: invariants 67 and 68 (`verify_round`).*

On 2026-10-14 a reader's profile filed Su Jianlin's Muon essay (kexue.fm, in Chinese) beside
Keller Jordan's Muon post. Both jobs ran at once and both meant to create `muon-optimizer`.
Jordan's committed first. Su's page was blocked on one sentence, "infinity-norm vector
geometry gives SignSGD", cited to the section on matrix norms; the essay says it in the
section before, in Chinese, so no word of the claim was on the page that holds it. The
repair was asked to fix the sentence and tried to create the page again, which was refused
because the name now belonged to Jordan's page; refused twice, the page was dropped whole.
Three defects in one event: a true claim the re-cite could not find (it read only PDF pages
and matched only shared words), a whole page lost for one sentence, and a job that went on
repairing a page another job had already written.

So a claim words cannot place is asked of one bounded call that must quote the passage it
names; a sentence a repair cannot mend is struck, and only what changed is checked again; and
a page whose name or idea another job wrote meanwhile sends the job round again
(`StaleRevision`) instead of to a repair that cannot succeed. Round 4c's `scaling-laws`
domain page, blocked twice on true claims and filed on a resumed third run, was the same
defect at domain scale.

### the note that outlived its deletion

*Rule: invariant 53 (`reader_notes.py`).*

On 2026-10-15 a live check on 0.6.3 filed four real margin notes on the NTK and Chinchilla
papers and then deleted their highlights. Three of the four had been filed as Delphi's own
work: the reader's check that a 20-fold width is 400 times the weights, their doubt that the
theorem covers training to convergence, and the e06 FLOP arithmetic were each written as
`derived` inference beside the paper's pages, with no `reader-note` citation. Retraction finds
a note's claims only through that citation, so deleting the notes queued sessions that
gathered nothing, and the reader's arithmetic and conclusions stayed in Memory as if a paper
had said them. Only the note that brought outside knowledge (a link to lazy training) was
cited to the note, and it was retracted. The contract had steered the agent there: arithmetic
is `derived`, and nothing said that text resting on a note must also cite it.

So a note is filed in a run of its own, where everything that is not a document's page must
cite the note, and a deleted note's statements are removed by rule where they rested on it
alone. A citation is a record of provenance as well as of support; when it is the only
record, it has to be complete by construction.

### the pill that lied

*Rule: every scope resolves its persona through `personas.persona_for_turn` (invariant 26).*

When the project persona was dropped (`b8d24f60a3c1`), `ChatRequest.persona_id` kept a
comment saying the reader scopes "take the project's", so the reader-scope client sent
no id. `chat_stream` meanwhile resolved `body.persona_id or DEFAULT_PERSONA_KEY` and never
read the conversation. Every document and project turn answered as the default whatever
the pill showed — and the stream's own `set_conversation_persona` then stamped that
default over the pick `PUT /api/chat/persona` had just recorded, erasing the evidence.

The first fix overcorrected on the client: it echoed whatever id the thread had loaded.
A deleted persona leaves its id stored — deliberately, since a dangling stored id falls
back — but the echoed copy arrived as an *explicit* id, which is a 404, so a conversation
held in a deleted persona could not be sent in at all. Resolution had also moved after
the replacement drop, so an edit in such a conversation deleted the question before
refusing it.

Two things generalise:

- **A comment about a deleted column is a live instruction until someone deletes it.**
  The stale sentence was the specification the client was written against.
- **Echoing server state back as a request turns a stored value into a claim.** The
  server treats the two differently for good reason; a client that relays one as the
  other erases that distinction.

### the adapters nobody was using

The project-wide chat scope was retired from the context picker but kept alive
underneath: a third `ChatScope`, an `across_project` boolean branched on in a
dozen places in `routers/chat.py`, a `?chat=project` URL spelling with its own
parser, a `legacy` flag through the conversation rail, a `project_chat` thread
kind in the schema, and a ledger row in this file that said "preserve with
adapters, never delete". Learner notes had the same shape: a table nothing
wrote, three routes nothing called, a persona capability every client sent as
`[]`, and a note in this file promising a follow-up migration "once they go".
Each was kept for readers who did not exist — Delphi had no external users —
and each cost every later change a branch to reason about.

The rule this set is in CLAUDE.md §0: nothing is kept for old data, old links
or old containers. Remove the path, delete the rows by migration, and if the
removal breaks Memory filing or context fetching, fix the dependency rather
than keep the shim. The harness table in § "The harness" is the place to see
what the model can reach from where; a row that reads "legacy" there is a
removal waiting to happen, not a contract.

### Web annotations keep records separate from placement

HTML anchors use the structural article text, UTF-16 offsets, a normalization
version and SHA-256 fingerprints. The parent worker owns historical quotes and
relocation. The injected bridge reports bounded current text and paints native
CSS ranges using temporary handles; it receives neither note bodies nor saved
quotes, and persists nothing in the site's origin. Exact unique quotes place;
exact context resolves repeated occurrences only with a unique positive score.
Timed-out searches remain unknown. Matching does not rewrite original anchors.

Capture is on demand, the way Text Fragments and Hypothesis take a selection.
When the reader acts on one, the bridge reads the article's text and the
selection's offsets in one uninterrupted pass, and the worker anchors that
snapshot; a Reply pins the same snapshot as its evidence. Nothing waits for the
page to hold still. The index marks are painted from is rebuilt a second after
the article's text stops changing, and at most two seconds after it first
changed, so a page that never settles is still annotated and repainted: an
animated simulation (fleetwood.dev), or MathJax 2 typesetting 362 formulas for
ninety seconds (sander.ai). What the index leaves out is decided by what an
element is, never by how it behaves. A behavioural rule that left "live
widgets" out once took sander.ai's whole post for one, because each typeset
display formula counted as a rewrite of the block that held it.

A saved webpage has two halves in one `.web` object, each with one writer
(`web_revision.py`). The **text** — sections, and the flat `.txt` export beside
them — is what the model reads and the digest is built from, and it always comes
from Delphi's own fetch: `publish_snapshot` writes it at import and on a refresh,
and unchanged text keeps its hash, so the digest survives an annotated visit. The
**page copy** (`savedDom`) is what the cached view shows, what highlights are
matched against there, and what the thumbnail photographs. Creation seeds it with
the page as fetched. After that, the first annotation of a visit to the live page —
a highlight or a note — has the frame serialise the page as drawn, `PUT saved-page`
stores it through `freeze`, and the text is re-fetched; later annotations in that
visit do neither. The copy is a backup for a page that is taken down, not a history
of one. There is no button: a copy kept only when someone remembers to ask is a
copy nobody keeps.

The copy used to be a second server fetch with every script removed, so it never
held what the page's scripts drew: sander.ai's formulas were stripped with their
MathJax sources, a highlight over typeset text could not be found in the cached
view, and a site refusing repeat fetches (pi.website) gave a copy that was not the
page annotated. A copy is taken with the selection it belongs to, so a page that
changes while the highlight saves is kept as marked. The frame sheds Delphi's own
nodes (`data-delphi-frame`, the annotation style and hover attribute), gives the
zoom and pinch styles back, writes rules a page built through the CSSOM into their
elements (MathJax CHTML's glyphs exist nowhere else) and names the width the page
was laid out at; `freeze` then removes all of it again regardless, because the
markup is untrusted. An identical copy is a no-op on the server, so a retry after
a lost response costs nothing. Serialising is one pass over the DOM — 41 ms for
Wikipedia's 17,000-element WWII article — and nothing the reader waits on follows
it. The two writers share `annotation_revision_lock`, and each keeps the other's
half.

The upload is untrusted input from a page Delphi does not control. The route takes
the account's session only, never the page token the sandboxed frame holds; the
panel accepts only an answer to a capture it requested; the body is bounded in
UTF-8 bytes as it streams; and the copy is refused when it has no readable text,
is a wall, or no longer holds half the fetched words. That last check is an
incomplete-page heuristic, **not** authenticity: a hostile page can keep the words
in a hidden element and show something else, and the copy is only ever shown in
the same sandboxed frame the live page already ran in. `freeze` judges URLs as a
browser parses them — tabs and newlines removed, controls trimmed — so
`java&#10;script:` is refused; players (YouTube, Vimeo) stay iframes that play
from their own origin, because a copy holding the video would be unbounded and one
holding a still would be useless, while `<object>`/`<embed>` become links.
Canvas, shadow roots and media state are not captured, and a formula typeset after
the visit's last annotation stays as MathJax's preview text.

Opening, reloading and switching views never write the copy,
and annotating the saved copy keeps nothing: it already is what is kept. Live view fetches fresh HTML
and lets the reader run the document's own scripts. A retryable HTTP refusal may
use the bounded public-only browser transport to obtain the original document
response, without waiting for a rendered snapshot. Freezing a live page had
stripped player handlers while retaining dead buttons and timers; waiting for
its continuously updating DOM also delayed opening. Live loading must not use
the snapshot pipeline or guess which controls to replace. The one document the
reader cannot run is a shell only its own scripts draw: they boot on an origin that
is not their own and paint nothing (a public Notion page framed blank), and a module
is not even fetched, being fetched with CORS from a site that answers none for its own
assets on Delphi's sandbox origin (z.ai's Vite blog). `boots_in_frame` declines those, so the
live view is unavailable and the reader shows the saved copy, still no snapshot. A stored DOM's inline width equal to its capture
viewport is served as `100%`: it is the script's measurement of the window, and
kept as pixels it stopped the page rewrapping when the reader zooms. Cached view
serves the saved HTML. Reload preserves the chosen view and never updates the cache.
A view that cannot be served is still framed, as a page carrying
`data-delphi-unavailable`, because a JSON error in the iframe never greets the parent
and was retried as an escape. A failed live view falls back to the cached copy and
says so; a missing cached copy is one error, never a retry.
Both clients request an explicit view in the frame descriptor and reject an older
backend that cannot distinguish them. Large DOM work yields in slices.
External styles and embedded media remain network-dependent; the backup is not a
complete offline web archive. Captured Reply evidence retains model-readable text
by content hash, without a second DOM or asset copy.

A quiet interval is a bounded observation, not proof that an arbitrary application
has completed. Known walls, shortened prefixes and low retained-block coverage
protect the prior copy and leave placement unavailable. Original quotes and notes
remain independent records, visible even when the current document cannot place
them. Synthetic fixtures cover replacement, truncation, duplicate text, changed
context, responsive layout, DOM updates, Unicode boundaries, failed writes and
selection-time evidence. The browser fixtures exercise Chromium and WebKit ranges and check that painting
never mutates the article DOM. The web frontend fetches the backend's matching
worker into a Blob URL, retaining that URL until teardown because WebKit can load
it after the Worker constructor returns. The frame sends temporary handles and
geometry; React owns note cards and drafts. Frame generations are fenced by a
parent epoch, while pinned Reply evidence survives frame replacement within the
same document. Late record reads merge with local writes and deletions, and late
mutation responses cannot populate another document. Failed note saves leave the
draft in workspace memory. Chrome and Safari are the browser release targets;
Firefox is best effort.
