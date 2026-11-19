<p align="center">
  <img src=".github/assets/delphi-hero.png" alt="Delphi — a mountain beneath a rising sun" width="100%">
</p>

# Delphi

> **This is `core/` of this repository: the `delphi_core` package.** The desktop app
> builds it in, and the web app installs it as a pinned wheel and keeps its own SQL
> store and deployment. Paths are relative to `core/`.

Delphi is a research reading workspace that turns a library into durable
understanding. Keep projects on the left, read a real PDF or live web page in
the center, and ask a streaming AI conversation about exactly what is open on
the right. As you read, Delphi builds an account-wide, cited Memory that
later conversations can consult before reaching back into the raw library.

It runs entirely on your own machine: inside the desktop app (the repository's
README says how to install or build it), or from an installed wheel.

*Less climb. Same summit.*

## What works

- Local accounts with scrypt password hashing and signed, HttpOnly sessions,
  plus an optional signup code so a shared URL cannot spend your model credits
- Multiple projects — renamable, colour-coded, and reorderable — with documents
  that can be moved between them. Marking one Done archives it without deleting
  its reading view, annotations, digest, or paper chat
- PDF uploads by picker or by dropping a file anywhere in the window, validated
  at 30MB and 100 pages, with limits published by the server so the client and
  server cannot disagree
- Web pages as documents alongside PDFs: paste a URL and the blog post, doc page
  or lecture notes joins the project, read in a sandboxed frame that keeps the
  real page — its CSS, its typeset maths, its interactive widgets — rather than
  a flattened print of it
- In-app Back, Forward, Home, Reload and link following for public pages without
  changing the saved document; temporary history and scroll positions live only
  for the mounted reader tab
- A web page reaches the model as a section outline plus a `read_webpage` tool,
  so a 15,000-word post costs a few hundred tokens a turn instead of twenty
  thousand, and answers cite `§section-anchor` locations you can click into
- PDF.js canvas rendering with a selectable text layer (not an iframe), lazy
  per-page rendering, and a pre-warmed engine so the first paper opens as fast
  as the tenth
- Clean, zoom-safe PDF highlights stored as normalized line bands; overlapping
  records keep their own notes
- Webpage highlights anchored to exact passages, with a Highlights & Notes list
  that keeps quotes and notes accessible even when the article changes
- Margin notes anchored to PDF and webpage highlights, with read-only previews and a
  lazily-loaded markdown editor for bold, italic, code, links, quotes, and lists
- Select a passage to highlight it, write a note, or send it into the chat composer
- Webpages open live; page options also show a dated saved copy. Your first
  highlight or note in a visit saves the page as you see it — typeset math and
  embeds included — as that copy, in the background; Reload and switching views
  never do. A live page that cannot be loaded opens the saved copy and says so.
  JavaScript-rendered pages follow the same rules. Reply retains the selected
  text revision for the question
- Linked PDFs stay live until an annotation needs stable bytes; Delphi can then
  store the PDF in place without changing its document id or losing its thread
- Project chat follows the open document and carries the project's ready digests;
  Memory chat consults the account-wide wiki. Each context keeps multiple named
  conversations. Closing a tab keeps its history; deleting a conversation is a
  separate action
- Answers cite page numbers, and following a citation jumps the reader straight
  to the page
- Research digests compile a document into evidence-backed claims before the
  Memory files what matters across the wider library
- Export a paper as `delphi_export_<project>_<title>.pdf`, optionally with your
  highlights burned in
- Every document has its own canonical address — `/@reader/pixel-diffusion/pixel-dit`
  — so a refresh keeps your place, the back button works, and a link opens the
  paper you meant. Signing in returns you to the link you followed; `/` on its own
  reopens whatever you were last reading
- A collapsible library rail for focused reading, keeping every paper one click
  away
- Personas: two reading styles shipped in the app — Mentor orients you and asks
  what you already know, ADHD answers first and points at one place to look —
  plus any you write, keep private, or publish to a marketplace others can
  browse and copy
- Search across everything you have added: one lexical index over every PDF page
  and every web section in your account, so a question can find which of thirty
  documents in four projects is the one worth opening. The model gets the same
  search as a tool, in front of the reading tools it already had
- A Memory at `/memory`: an account-wide wiki Delphi writes as
  you read and ask, in interlinked markdown pages with real citations back into
  your library — and with the figures that actually bring a paper back, captured
  rather than linked
- Export everything — documents, digests, notes, chats, Memory, personas and
  plans — as one folder of plain files with an `index.html` that opens from
  disk, so a library outlives the app that made it
- Home combines recent threads, a live Memory map, and project shelves. Memory
  has a domain rail, readable articles, a full Map, and a separate Health view.
  Graph layouts keep domain circles apart, and a keyboard-accessible list remains
  available if the layout worker cannot run
- Ask Delphi docks the conversation *above* Related Memory instead of
  covering the page it is about, with a full-screen state for when it becomes
  the thing you are doing. It answers in a persona you pick (Mentor by default),
  and that persona is style only — it has no authority to skip the wiki-first
  ladder or the citation rules
- Follow-ups retrieve against the conversation, not the message that ended it.
  "Which document should I read then?" is almost all function words; searched
  alone it matched everything a little and answered about somewhere else, so
  the search now carries your recent questions and the pages the answer named
  back
- Memory maintenance is durable foreground work: answers, newly added
  documents, and first-time Done transitions enqueue leased jobs before becoming
  visible, so closing a tab does not silently lose the update
- Expandable traces preserve the context supplied, reasoning summaries, and
  actual tool calls between answer passages, including failed calls and
  interrupted work. Reloading a conversation retains the recorded trace
- Streaming OpenAI Responses API integration with a choice of models, opt-in
  hosted web search, and a live reasoning/tool-activity trace while the model
  works
- Low-detail PDF inputs, project-level prompt caching, cached OpenAI file IDs,
  and reasoning choices constrained by the selected model's capabilities
- Plan mode produces a saved research proposal with immutable captured sources:
  the question, Table 1 of runs by settings, setup, how each outcome would be
  read, and only the tables, diagrams or charts it needs. Three plans
  can be active; archiving keeps earlier plans available. Export a complete
  package, or explicitly share selected plans with a coding agent through a
  revocable, read-only remote MCP connection. The browser provides local Codex
  setup commands; it does not install software on your computer
- Markdown answers with KaTeX rendering for inline and display mathematics
- Pluggable storage: core runs on the local filesystem, and a product can bring
  its own stores through the same interface

Saved Plans belong to the account that created them; the catalog and captured
sources live in that account's store.

To connect a coding agent, save a plan using the composer's **Plan** mode, then
select it in **Settings → Plans → Create read-only access**. Delphi hosts the MCP
endpoint itself; there is no separate `delphi-mcp` package to download. Use the
URL and bearer token shown there with a client that supports authenticated
Streamable HTTP. The URL is the app's origin plus `/api/plans/mcp`; a localhost
URL is reachable only from that machine. A grant
names exactly the selected plans and does not include plans created later.
Archiving preserves the plan and existing sharing access; revoke the connection
to stop future reads. Normal browser viewing and export still require the
owner's sign-in. Automated journeys use isolated test accounts and do not add
sample plans to your account.

## Run locally

Core runs inside the desktop app (`desktop/`), or on its own from an installed
wheel ("Run the installed wheel without a checkout", below). From a checkout,
`bash check.sh --core` is its gate. Python 3.11 or newer.

After sign-in, `/` is Home: recent threads, the Memory map, and project shelves.
The persistent three-panel workspace starts at `/reader`; document deep links
and `/memory` keep their canonical addresses, as do the wiki's graph
and health routes. Project and Memory chats share one append-only
conversation store. The first prompt
in a newly mounted chat engagement starts a bounded, best-effort title request
alongside the answer stream; title failure never delays or fails the answer.

Settings come from the environment. The defaults run entirely on the local
filesystem; the only value you must supply is `OPENAI_API_KEY`, unless a product
such as the desktop app supplies its own connection. The settings worth knowing:

```bash
OPENAI_API_KEY=...
MODEL_DEFAULT=gpt-6.1-sol
MODEL_CHOICES=gpt-6-luna,gpt-6.1-sol
OPENAI_PROMPT_CACHE_ENABLED=true
OPENAI_SERVICE_TIER=flex
OPENAI_REQUEST_TIMEOUT_SECONDS=900
MODEL_MAX_OUTPUT_TOKENS=10000
SIGNUP_CODE=          # empty means open registration
COOKIE_SECURE=false   # turn on wherever the app is served over HTTPS
MAX_UPLOAD_MB=30        # what a stored paper may weigh
MAX_UPLOAD_SOURCE_MB=60 # what may be sent while trying to compress under that
MAX_PAGES_PER_PAPER=100
WEB_DOCUMENTS_ENABLED=true
WEB_BROWSING_ENABLED=true   # server-wide kill switch; browsing is on by default
LIBRARY_SEARCH_ENABLED=true
MEMORY_ENABLED=true
MEMORY_RELATED_HOPS=2  # link hops the wiki's Related Memory rail walks
WEB_TOOL_MAX_CALLS=6      # section reads the model may spend on one question
WEB_TOOL_MAX_CHARS=24000  # characters one of those reads may return
WEB_SANDBOX_ORIGIN=http://127.0.0.1:8000
```

`WEB_SANDBOX_ORIGIN` is the origin proxied pages are served from, and it must be
one the session cookie never reaches. Pages served from it are granted a real
origin, which is what an embedded video player or 3D demo needs — and what would
otherwise let any page a reader adds call `/api` with their credentials.
`127.0.0.1` and `localhost` are different hosts and so different origins, and a
host-only cookie set on one is never sent to the other, so a single uvicorn
serves both; this assumes you open Delphi at `localhost:3000`. Leave it empty to serve pages
without a real origin: everything still reads, embedded media does not play.

Pages that only exist for a signed-in reader are out of scope: the proxy fetches
them from the server, which holds no session of yours. They still open live in
the frame — signed out, as the site serves an anonymous visitor.

The API key stays in the Python backend. `MODEL_CHOICES` populates the composer
dropdown; a client may pick any of them, and an unrecognized name falls back to
`MODEL_DEFAULT`. Hosted web search is enabled at the server but opt-in for each
question; when unused it stays out of the request payload, so ordinary questions
keep their prompt-cache prefix intact.

PDF files are uploaded lazily on the first model question, reused by file ID,
sent with `detail: "low"`, and removed from OpenAI on a best-effort basis when
the local paper or project is deleted. By default, Delphi attaches only the
current PDF. Explicit `@paper` mentions append only those referenced PDFs; the
rest of the project arrives as its ready digests, never as files. The current PDF
is first and has an explicit cache breakpoint, while a stable per-paper cache key
improves reuse across follow-up questions. Set
`OPENAI_PROMPT_CACHE_ENABLED=false` when using an OpenAI-compatible provider
that does not implement cache breakpoints.

New accounts use Standard processing by default; existing accounts retain their
stored Standard/Flex preference, and Settings keeps the Flex lane available as
the lower-cost choice. Model requests allow up to 15 minutes for a streamed response. Set
`OPENAI_SERVICE_TIER=` to omit the tier field when using an OpenAI-compatible
provider that does not support `service_tier`.
The 10,000-token value is an upper bound, not a target: short answers can still
finish early. Assistant math renders from `$...$`, `$$...$$`, `\(...\)`, and
`\[...\]` delimiters.

## Core wheel releases

Core is a Python distribution, `delphi-core`, released beside its test kit,
`delphi-core-testkit`, at one version, which is also the app's (A7):
`core/pyproject.toml`, `core/testkit/pyproject.toml` and its `delphi-core==` pin,
`desktop/backend/pyproject.toml` and its pin, and `desktop/package.json` with its
lockfile. The API reads the version from the installed package metadata.
`pyproject.toml` is Python packaging configuration, not Git version control:
non-Python folders should not gain one for symmetry.

Releases are this repository's GitHub releases, `thekevinli/delphi`, tagged
`vX.Y.Z`, and are built and checked on this machine: GitHub Actions stays off.
`bash scripts/ci_core.sh` runs the whole CI over the checkout:

- first the release identity, so a wrong cut fails in seconds: the catalog, the
  previous release's assets checked against its `SHA256SUMS`, and this build's
  policy (`backend_release.py context`);
- the suite on Python 3.12 and 3.11, the scripts' tests and the layering checks;
- both wheels, built by `scripts/backend_release.py` from core-owned sources alone,
  then installed outside the checkout with only runtime dependencies: startup,
  HTTP auth, persistence across processes, package data and the PDF subprocess;
- A2, the two wheels alone in a fresh virtualenv;
- a library written by the previous release's wheel, reopened by this one;
- `oasdiff breaking` against the previous release's `openapi.json`, its report kept
  as `.delphi-build/ci-core/oasdiff-breaking.txt` for the release notes, and the
  public surface classified against the previous `public-surface.txt` (A3).

The first release, `v0.1.0`, has no previous release: nothing is downloaded, and
there is no library to reopen and no API or surface to diff, which the run says.
Every later release is compared with the one before it.

Untagged, it checks a development build. Between releases `main` carries a
development version (`X.Y.Z.devN`), which the compatibility policy reads as
`X.Y.Z`; the commit you tag carries the stable version. To release, review and
merge the version bump with its compatibility and migration notes, then, from a
clean clone of `thekevinli/delphi` at that commit (releases are cut there, so
each one descends from the last):

```bash
git tag -a v0.1.0 -m 'Delphi 0.1.0'
DELPHI_PRIVATE_NAMES=/path/to/the/private/list bash scripts/ci_core.sh --release v0.1.0
(cd .delphi-build/ci-core/dist && shasum -a 256 -c SHA256SUMS && cat release.json)
git push origin v0.1.0
gh release create v0.1.0 -R thekevinli/delphi --verify-tag --title 'Delphi 0.1.0' \
  --notes-file NOTES.md .delphi-build/ci-core/dist/*
```

Use the actual new version throughout, and attach every file `dist/` holds: the
two wheels, `release.json` (version, tag, commit, digests, the release compared
with, empty for the first), `openapi.json`, `public-surface.txt` and `SHA256SUMS`,
which lists them all; the next release compares with them. `--release` refuses
unless the tag names this clean checkout and the version is the tag's, and it does
not start without the private list (A8). Its wheels are built from the tag's own
tree (`git archive`), so nothing untracked or ignored in the checkout reaches them.
`vX.Y.Z` tags are stable releases; pre-release spellings are refused, and so is a
stable tag published as a prerelease. Never reuse or move a released tag:
rebuilding a published one is refused, and a fix is the next patch version. A
version never goes backwards from the catalog's latest release. Publish a release
only after its run passes; a failed draft is inspected and removed manually before
retrying. Protect `main` and the `v*` tag pattern in repository rules, and enable
immutable releases; nothing here configures them. A refusal is one line on stderr
and a failing exit.

API compatibility is compared with the highest published, stable `vX.Y.Z` release
in this repository's catalog. Drafts, prereleases and bare tags never become
baselines, so a failed attempt does not block the next. CI fetches every page of
the catalog once and uses that snapshot throughout; an API failure stops the run.
`gh release download` skips a pattern that matches nothing, so the previous
release's assets are held to its own `SHA256SUMS`, and a release that lacks
`public-surface.txt` is refused rather than read as having nothing to compare: a
published release with missing assets fails the gate instead of silently starting
a new baseline. During 0.x a minor bump can announce a reviewed breaking change;
from 1.0 onward a major bump is needed. Within a compatibility series, oasdiff
errors and warnings and a breaking surface change fail the run; across a boundary
they are reported. This checks the documented HTTP schema and the import surface;
streaming events, storage semantics and behaviour still need the suites and
consumer review. `check.sh`'s A2 builds the wheels from an empty catalog, offline,
so compared with nothing, as the first release is.

Earlier history, before this repository's first release, is kept in a private repository.

Release assets are public on this repository's releases; nothing uploads to PyPI
or an external API-review service. A consumer can download a pinned release:

```bash
gh release download v0.1.0 --repo thekevinli/delphi \
  --pattern '*.whl' --pattern SHA256SUMS --dir /tmp/delphi-core-download
```

Verify the wheel's SHA-256 against `SHA256SUMS`, then install the downloaded wheel
with the consumer's virtualenv Python:
`python -m pip install /path/to/delphi_core-0.1.0-py3-none-any.whl`.
Do not put access tokens in pip URLs. A wheel includes Python code and runtime
package data, not an interpreter, Chromium, frontend, user data or database
migrations.
Dependencies retain compatible ranges; consumers that require reproducible whole
environments must lock transitive dependencies for their Python/platform too.

### Run the installed wheel without a checkout

For a standalone local API on macOS or Linux, use Python 3.11 or 3.12 and a
verified wheel downloaded above. Keep the virtualenv separate from the persistent
library so upgrading or replacing the runtime never removes reader data:

```bash
python3 -m venv "$HOME/.local/share/delphi-core/venv"
DELPHI_PYTHON="$HOME/.local/share/delphi-core/venv/bin/python"
"$DELPHI_PYTHON" -m pip install /tmp/delphi-core-download/delphi_core-0.1.0-py3-none-any.whl

export DATA_DIR="$HOME/.local/share/delphi-core/data"
mkdir -p "$DATA_DIR"
# Generate once; retain this file across launches and wheel upgrades.
"$DELPHI_PYTHON" - <<'PY'
import os
from pathlib import Path
import secrets

path = Path(os.environ["DATA_DIR"]) / "session-secret"
try:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
except FileExistsError:
    pass
else:
    with os.fdopen(fd, "w") as stream:
        stream.write(secrets.token_hex(32))
PY
export SESSION_SECRET="$(cat "$DATA_DIR/session-secret")"
export DATABASE_URL=""
export COOKIE_SECURE=false
export FRONTEND_ORIGINS=http://localhost:3000
export WEB_SANDBOX_ORIGIN=http://127.0.0.1:8000

# Set OPENAI_API_KEY in this environment to enable model-backed features.
cd "$DATA_DIR"
"$DELPHI_PYTHON" -m uvicorn delphi_core.main:app --host 127.0.0.1 --port 8000 --workers 1
```

Use the downloaded version's actual wheel filename,
`delphi_core-<version>-py3-none-any.whl`; the app is `delphi_core.main:app`. In
another terminal,
`curl http://127.0.0.1:8000/api/health` should report local storage;
`http://127.0.0.1:8000/docs` exposes the API. The wheel does not serve a reader UI.
Point the consuming UI at this API and set `FRONTEND_ORIGINS` to its actual origin.
The example assumes a UI at `http://localhost:3000` that proxies `/api` requests to
the backend. Keep its hostname distinct from the web sandbox's `127.0.0.1`:
cookies ignore ports, so changing only the port does not isolate proxied pages.

`DATA_DIR` must be absolute and writable, outside the installed runtime or app
bundle. Relative paths resolve against the installed package's location. Preserve
the session secret so sessions and signed document tokens survive restarts. Use
one worker for filesystem storage. Settings also read `../.env` relative to the
process working directory; choose a working directory whose parent has no unrelated
`.env` file. For browser-rendered pages and thumbnails, install Chromium or Chrome
separately and set `CHROME_PATH` to its executable, or lend core a browser page per
job through `BROWSER_HOST_SOCKET` and `BROWSER_HOST_TOKEN` (`browser_host.py` holds
the wire), as the desktop app does with Electron's. A desktop launcher can supply
these same environment variables and Uvicorn arguments to its bundled interpreter.

## Architecture

```text
Browser / React
  ├─ project and document library (expanded or collapsed rail)
  ├─ PDF.js canvas + selectable text layer, rendered lazily
  ├─ sandboxed in-app browser with tab-local history, bridged by postMessage
  ├─ normalized line-band highlights + anchored margin notes
  ├─ Memory reading desk: page, catalog, Related Memory, docked Ask
  ├─ Memory graph and health checks on their own routes
  └─ SSE chat client (answer text, reasoning, tool status)
          │
          ▼
The app's Worker (the desktop runs it in desktop/main/worker-host.ts)
  └─ SPA + /api/* proxy to FastAPI
          │
          ▼
FastAPI boundary
  ├─ signed-cookie identity and ownership checks
  ├─ project, document, annotation, digest, and Memory services
  ├─ pypdf extraction + verified PDF compression
  ├─ destination-bound navigation and SSRF-guarded framing proxy
  ├─ durable memory-maintenance queue + locator validation
  └─ OpenAI Responses API streaming adapter + bounded tool loop
          │
          ▼
Storage interface
  ├─ local filesystem (.data/)
  └─ a product's own stores, through create_app
```

The API owns authorization and all durable state. The frontend never treats
browser storage or a user-supplied header as identity, and never assumes where
data lives — storage describes its own kind and location through
`/api/auth/me`. Provider credentials stay on the server.

## Storage

Storage sits behind an interface. Core implements it on the local filesystem;
any other implementation (the web app has an SQL one) is held to the same store
tests (`delphi_core_testkit.conformance`). Routes call entity methods; no method
hands back a filesystem path.

Core's store is the local filesystem:

```text
.data/
└── users/<username>/
    ├── account.json
    ├── personas/<personaId>.json
    ├── paper-evidence/<paperId>/<requestId>.json
    ├── memory/
    │   ├── pages/<slug>.json
    │   ├── figures.json
    │   ├── figures/<figureId>.webp
    │   └── jobs.json
    └── projects/<projectId>/
        ├── meta.json
        ├── SKILLS.md
        ├── papers/<paperId>.pdf
        ├── papers/<paperId>.web
        ├── papers/<paperId>.txt
        ├── papers/<paperId>.digest
        ├── chats/paper-<paperId>.json
        ├── highlights/<paperId>.json
        └── notes/<paperId>.json
```

A product hands its own stores to `create_app`; core reads no database or bucket
setting.

PDF highlight rectangles use normalized `0..1` page coordinates, so highlights
and their notes stay aligned at any zoom or panel width. PDFs are served with
working range requests and marked immutable, since the bytes for a stored paper
id never change.

Every new conversation starts on the **Mentor** persona. The picker under the
composer offers two shipped in the app — Mentor orients you in an unfamiliar
field and asks the one question that changes its explanation, ADHD leads with
the answer and names the table or section to look at — alongside any you write
yourself, editable in place or replaceable from a local `.md`/`.txt` file.

There were four. Tutor's defining move was one calibration question before
explaining, but four exemptions meant it almost never asked, so Mentor absorbed
it. Researcher's body was evidence discipline — author claims versus findings,
correlation versus causation, "not reported" versus "does not exist" — which is
not a style anyone should be able to switch off by picking another voice, so it
moved into the instructions every scope composes regardless of persona.

Delphi prepends up to 30,000 characters of the active persona to every new model
request, treated as user-authored response guidance rather than evidence from a
paper. Edits apply to subsequent requests and never rewrite existing chat
messages.

A persona you own is *referenced*, so improving it reaches every conversation of
yours that uses it. One you take from the marketplace is *copied*: the author can later
edit, unpublish, or delete theirs and your projects are unaffected. Publishing and
unpublishing are yours alone to do, and a persona a project still uses cannot be
deleted.

When Memory is enabled, every persona receives the same bounded,
domain-scoped Memory context and tools; a persona controls style, not access to
your account memory. Mentor uses that context most visibly, to calibrate depth
and avoid teaching material you already know — though a saved paper only means
the material is *available* to you, so it builds on what you have actually
demonstrated and otherwise draws the link between the sources.

The Memory conversation takes a persona too, defaulting to Mentor. It is
resolved once, when the request starts, from the personas shipped in the app and
the ones your account owns — a marketplace listing you have not installed is not
one of them, since running a stranger's instructions is what copy-on-install
exists to prevent. Like `SKILLS.md`, the body reaches the model labelled as
user-authored guidance, so it shapes the voice and never the evidence.

## Maintenance backfills

Several of the things Delphi shows you are *derived* — a search index, a document's
thumbnail, a document's research digest, the wiki pages written from
it. Each is produced lazily, for one document, at the moment a reader needs it,
and each is stamped with the version of the algorithm that produced it. The
backfills are the bulk half of those same routines: they walk a whole library and
bring everything up to the current version, calling the shipped code path rather
than a second copy of its skip test.

They are **operator-initiated**. Nothing refiles a reader's library on its own
when an algorithm improves.

### Which command, and where

Every backfill is a Python module, run against the local store:

```bash
cd core && ../.delphi-build/core-env/bin/python3 -m delphi_core.backfill.memory --force
```

A product that brings its own stores runs the same modules, with the same flags,
through `delphi_core.backfill.run`.

### The six

| Module | What it brings up to date | Costs model calls | `--dry-run` | `--force` |
|---|---|---|---|---|
| `index` | the derived full-text search index over PDF pages and web sections | no | no | no |
| `thumbnails` | document previews, behind `WEB_THUMBNAIL_VERSION` / `PDF_THUMBNAIL_VERSION` | no | yes | yes |
| `digests` | research digests behind `RESEARCH_DIGEST_VERSION` | **yes** | yes | yes |
| `memory` | one filing pass per document, into the durable queue | **yes** | yes | yes |
| `conversations` | one-time import of pre-conversation thread files | no | yes | no |

All six take `--user <name>` (repeatable; omit it for every account) and
`--quiet`.

`conversations` is the filesystem store's one-time import of pre-conversation
thread files.

### The two that spend money

`digests` and `memory` call the model. On a real library both are measured in
hours.

`memory` writes jobs into the durable maintenance queue by default and files
nothing — the queue is the mechanism the product already has, so the passes
inherit its leases, retries and idempotency. Add `--drain` to run that work here
instead of leaving it to whichever reader's tab opens first.

`--force` is the deliberate **refile**, and it is the flag to reach for when the
*authoring pass itself* changed rather than the library. Without it every
document's marker already exists, every job completes `reused` with no model
call, and the wiki keeps pages written by the pass you have just replaced — a run
that reads as having done nothing. It implies `--drain`, because a queued job
carries no `force` and the next browser would run it as the ordinary catch-up.

A refile revises rather than resets. Pages upsert by slug, so a document keeps
its addresses, its incoming `[[links]]` and its place in the graph, and gains a
revision. It deletes nothing, so a page the old pass wrote and the new one has no
opinion about stays — Memory → Health lists those as orphans.

Both commands are safe to interrupt and safe to re-run: each skips what is
already at the current version, so a second run costs only what the first did not
finish.

## Repository

- `delphi_core/routers/` — route modules for auth, projects, chat, digests, and Memory
- `delphi_core/storage/` — the storage interface and the local implementation
- `delphi_core/security.py` — password/session primitives
- `testkit/` — `delphi-core-testkit`: the store tests, goldens and layering checks
- `tests/` — core's unit and route tests
- `../desktop/frontend/` — the desktop's React + Vinext UI and PDF.js reader
- `ARCHITECTURE.md` — why the system is shaped this way, plus its known boundaries
- `AGENTS.md` / `CLAUDE.md` — synchronized agent-specific entry points to the
  operating manual: invariants, extension seams, and traps

The README, architecture rationale, and mirrored operating manual are the whole
documentation set, deliberately. A `README.md` per directory is how descriptions
start disagreeing with each other.

## Security notes

The checked-in session secret is intentionally a development fallback. Replace
`SESSION_SECRET` before exposing the service beyond localhost, set
`COOKIE_SECURE=true` wherever the app is served over HTTPS, and set
`SIGNUP_CODE` anywhere the URL is shared. PDF size, page count, and type are
validated, project ownership is checked on every file route, filenames are never
used as storage paths, and API keys are not sent to the browser. Public browsing
tokens are short-lived and bound to one user, project, paper and normalized
destination, and the proxy serves only the address stored on the document — it
takes no URL from its caller, so it cannot become an open proxy on Delphi's
domain.

### Web annotation browser checks

The annotation workflow targets current desktop Chrome and Safari; Firefox is
best effort. Webpage annotations apply to a saved document, not a temporary page
visited through its links. Missing or ambiguous passages remain in Highlights &
Notes. Saved copies retain page HTML but still depend on external styles and media.
Unsaved note drafts survive document switching within the mounted workspace; they
are not an offline write queue and are not persisted across a browser reload.

The desktop's browser suite (`desktop/frontend/tests/browser`) mounts the shipped
reader with the real frame bridge and matching worker against deterministic API
fixtures, in Chromium and WebKit; `bash check.sh --ours` runs it. Verify the
assembled app in installed Chrome and Safari as well.

The desktop's Memory journey (`desktop/tests/memory-journey.test.mts`) runs the
real backend with scripted model responses, so it needs no live API key and cannot
touch your library. A live-provider smoke test is still needed when changing model
prompts or defaults.
