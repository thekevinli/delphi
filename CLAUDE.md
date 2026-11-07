# CLAUDE.md

Guidance for Claude Code working in this repository. `README.md` is the
user-facing description and `ARCHITECTURE.md` is the prose rationale and the
incident record; this file is the operating manual — what the shell is, which
properties must not break, and how to extend it without eroding the design.
`AGENTS.md` is its mirror for Codex.

Those three roles cover the general documentation. The explicitly requested
[`MCP.md`](MCP.md) is the focused exception for connection addresses, exposed tools
and user installation instructions. `core/` carries the backend's own manuals
(`core/CLAUDE.md`, `core/AGENTS.md`, `core/ARCHITECTURE.md`, `core/README.md`),
imported with it and trimmed of the web deployment in Plan 4 Stage 8. Do not add
any other document to a subdirectory.
Put other explanations in the code comment at the site that needs them, or in
the appropriate root-level document.

---

## 0. How to edit this file

**Ceiling 30k chars** — `wc -m CLAUDE.md` before you commit. This repo is a
shell around a product; if its manual approaches the product's own, the shell
has grown something it should not have. A section over budget is paid for out of
itself: retire an entry whose rule no longer earns its space.

Cite symbols, never line numbers. Never quote a test count — `bash check.sh` is
the authority. `AGENTS.md` is this file with two words changed; regenerate it
rather than editing twice:

```bash
sed -e '1s/.*/# AGENTS.md/' -e '3s/Claude Code/Codex/' CLAUDE.md > AGENTS.md
```

**The web app lives in its own private repository**, built on core's released
wheel. Nothing here names its deployment (cloud project, bucket, database, Worker,
hostnames); a tagged release scans for that (A8). `core/` is this repository's own
code and may be named anywhere.

---

## 1. What this is

A macOS application wrapped around Delphi. The backend is `core/` in this
repository (the `delphi-core` distribution, package `delphi_core`), built into the app from the
same commit.

The reader shell does four things:

1. Serves the local frontend's build output over a private loopback origin.
2. Runs the application's Python backend as a supervised child process.
3. Establishes a local session so the window opens already signed in.
4. Packages all of that as `Delphi.app`.

The macOS-owned conversational handoff lives in `main/research/` and `native/`.
It saves literature-grounded plans and shares captured sources over read-only MCP.
Execution and monitoring belong to the downstream coding agent and user tools.

**The macOS frontend is independently owned in `frontend/`.** It was copied from
the web app and now evolves here. Never wire frontend builds back to the web
repository's sources.

Inline artifact authoring belongs to `core/delphi_core/harness/`: chat profiles offer
`draw_display`, `embed_figure` and `publish_artifact`, and `compose_instructions`
supplies their authoring rules. Do not append them to forwarded user prompts or offer
them to Memory maintenance. A display is a JSON spec (`core/delphi_core/artifacts/display.py`
checks every step and option) that `frontend/app/components/display/` draws natively,
with no frame; its board examples are `core/tests/data/displays/`. `core/delphi_core/artifacts/` owns turn-local drafts,
bounded rendering and exact-source delivery. Publication requires a passing
render, screenshot feedback and a later model round; raw artifact fences never
become executable output. Runtime validation is not scientific verification.

The product supplies `ARTIFACT_RENDERER_PATH` with its browser host.
`build/artifact-validator.mjs` builds that isolated host from the same
`InlineArtifact` and styles used in chat, and it ships as a separate resource.
Preserve the sandbox, local controls, sticky stepper, reset and history
when changing this surface. Test renderer failures as well as successful views;
a job's page must end on cancellation, timeout or memory overflow.

**Every browser job runs in Electron's own Chromium.** Page capture, document
previews and draft validation are core's code, driving a page over DevTools;
`main/browser-host.ts` lends that page over a private socket
(`BROWSER_HOST_SOCKET`, `core/delphi_core/browser_host.py`), so no installed
browser is looked for or launched. The host owns where a page lives and for
how long; core keeps every policy, including the validating proxy a capture
reaches the web through. `tests/browser-host.test.mts` runs core's jobs on it.

In the reader, `main/artifacts/navigation.ts` is the last boundary: it refuses
artifact navigations and ends an artifact's renderer process the moment it
creates a frame, because a nested srcdoc is a realm with WebRTC that Electron
reports no navigation for. `tests/artifact-isolation.test.mts` holds it in the
real Electron; keep artifact frames named `delphi-artifact-` on the reader's
document.

---

## 2. Commands

The desktop app lives in `desktop/`; the core in `core/`; repository-level
tooling in `scripts/`. **Paths in the rest of this manual are relative to
`desktop/`** unless they start with `core/` or `scripts/`.

```bash
cd desktop
npm install
npm run build          # UI, python runtime (from ../core and backend/), main process
npm start              # run from the checkout
npm run dist           # unsigned app + DMG, from a clean, committed checkout
cd ..
bash check.sh          # the gate: core, core alone, local frontend, browser, backend parity + shell
bash check.sh --core   # core: pyflakes, vocabulary, layering, its suite, the desktop layer's, scripts'
bash check.sh --ours   # local frontend, browser + shell tests
bash check.sh --parity # installed backend consumer contracts
bash scripts/ci_core.sh  # the core's full CI: Python 3.11 + 3.12, wheels, core alone, API and surface diffs
bash scripts/ci_core.sh --release vX.Y.Z  # the same, building that tag's release (core/README.md)
```

The core's suite runs in the root `.delphi-build/core-env` (`scripts/core-env.sh`),
the pinned interpreter with `core[dev,release]` installed editable. Core is
local: no database, no cloud SDK, and its suite runs on the local store alone.

Plan 4's layering checks: A1, A3, A4 and A6–A8 ship in the test kit
(`python -m delphi_core_testkit.abstraction <check>`), and `scripts/layering.sh`
runs them over this checkout in `check.sh --core`. A2 (`scripts/core_alone.sh`, in
the full `check.sh` and `ci_core.sh`) runs core's suite from a copy, outside the
repository, against the installed wheels, so a test that reads the checkout
belongs in `scripts/tests`. A5 is the kit's `require_conformance`
(`DELPHI_REQUIRE_CONFORMANCE`), A9 `scripts/check_vocabulary.py`. A8 needs the
private list, kept outside every repository, as `DELPHI_PRIVATE_NAMES=<path>`:
the gates skip it without one, and a tagged release build refuses.

Individual steps: `build/frontend.sh`, `build/python-runtime.sh`,
`build/main.sh`. Each is independently runnable and each is
pinned and checksum-verified where it downloads anything. The reader's
browser suite (`frontend/tests/browser`, Chromium and WebKit) reads its frame
scripts from the bundled backend, so it needs `npm run build` first.

There is no global `node`, `pnpm` or `python` in this project. The frontend
toolchain comes from the local `build/runtime.sh`; the interpreter is
downloaded by `build/python-runtime.sh`.

To drive the running app for testing, launch it with
`--remote-debugging-port=<port>` and speak CDP to it. That is how the
click-through checks in `ARCHITECTURE.md` were performed.

---

## 3. Map

```
core/             the backend: delphi_core/, testkit/, tests/, manuals,
                  public-surface.txt (A3) and abstraction-exceptions.txt (A1, empty)
scripts/          release and wheel checks, the pyflakes gate, core CI and its
                  interpreter, layering.sh and core_alone.sh (A2);
                  tests/ for the scripts, which read the checkout
check.sh          the gate for both
desktop/          everything below
backend/          delphi_desktop: the desktop's Python layer over core, and its tests
main/
  index.ts        lifecycle, window, menus, navigation and download policy
  worker-host.ts  the Node HTTP server that runs the application's build output
  assets.ts       the static-asset binding the hosting platform normally provides
  ports.ts        the two loopback origins, and the assertion that they differ
  backend.ts      the backend child: its environment, supervision and log tail
  session.ts      first-launch registration and sign-in, over Electron's session
  config.ts       Application Support paths, the profile's secrets, the account name
  browser-host.ts the backend's browser pages: offscreen, pooled, relayed over DevTools
  browser-jobs.ts what a job may ask of it, checked without Electron
  fullscreen.ts   the full-screen flag stamped on the page, for the header layout
onboarding/       the first-run key prompt — the one screen not shared with the app
preload/          the onboarding window's only bridge; the main window has none
build/            reproducible build steps; notices.mjs, the third-party notices
  licenses/       the licence texts no shipped file carries, with their sources
tests/            the contract this shell must keep
scripts/          check-mcp-bridge.mts; live-answers.mts, questions through both
                  signed-in plans at once, on the checkout's code and chat route
frontend/        the independently maintained desktop UI and frontend tests
```

---

## 4. Invariants

Breaking one of these usually still passes a smoke test.

1. **The two loopback origins must not share a hostname.** The interface is
   served from one and the backend from the other, and the sandboxed frame that
   shows third-party pages is served from the backend's. The session cookie is
   host-only on the interface's host, so it is never sent to the frame's origin —
   that is the entire isolation mechanism, and it is a property of the hostnames,
   not the ports. `assertHostSplit` fails startup rather than trusting it.

2. **Static assets are served before the application, exactly as the hosting
   platform does it.** Asking the application first lets a two-segment asset path
   match a document route and return the app shell as `text/html`; the renderer
   then dies on a module import with a blank page and no useful error.

3. **Bodies are piped, never buffered, in both directions.** Answers stream for
   minutes and uploads are tens of megabytes. A buffering proxy passes every
   short request and fails only on the long ones. No Express, no body parsers, no
   compression middleware, no `Content-Length` rewriting.

4. **Hop-by-hop headers are stripped before forwarding.** They describe one
   connection, not the message, and `Expect: 100-continue` in particular makes
   the outbound fetch throw — turning every large upload into a 500.

5. **On error, drain the request body before answering.** Replying mid-upload
   without consuming the body leaves the client writing into a socket nobody
   reads: the request does not fail, it wedges.

6. **Every asset response states a cache policy.** No cache header means the
   browser's *heuristic* cache, which makes a wrong response sticky long after
   the server is fixed. Content-hashed assets are immutable; nothing else is.

7. **The renderer gets no preload and no node integration.** It runs the
   local frontend, which needs neither and must not be handed them.
   `webSecurity` stays on: the sandboxed frame's isolation is the ordinary
   same-origin policy.

8. **Secrets live in owner-only files and never reach the reader renderer.**
   The API key, the local account password and the session key are in
   `config.json`, the ChatGPT sign-in in `inference/oauth.json`, the MCP token in
   `research/mcp-token`, each 0600 like the library beside them. No Keychain: an
   ad hoc signed app is asked to unlock it again after every update, for nothing
   the user's own files do not already hold. A Keychain-era profile is moved
   out once (`moveSecretsOut`, `oauthStore`).

9. **The account name is fixed on first use.** It is part of the on-disk layout
   and appears in every reader URL, so changing it later strands a library rather
   than renaming it.

10. **`HOME` is passed through unchanged to the backend child.** A relocated
    `HOME` makes Chrome-for-Mac treat each capture as a new profile and start its
    updater, which hangs the capture. This is also why the app is not sandboxed.

11. **One instance only.** Two would race a single data directory whose storage
    layer serialises writes in-process and takes no file lock.

12. **The app's backend is built from this commit's `core/` and `backend/`.** The
    runtime receipt records the version, the core wheel's SHA-256, the commit, a
    content hash of `core/delphi_core`, `core/pyproject.toml` and the desktop layer,
    the desktop wheel and its SHA-256, then the repository's tree (`HEAD^{tree}`).
    `check.sh` refuses a runtime built from other content; `npm run dist` also
    refuses any uncommitted tracked file and a receipt from another commit or tree,
    so a DMG names exactly one commit and one tree (A7).

13. **Cosmetic setup may never abort startup.** Wrap it. An app that refuses to
    launch because it could not set its Dock icon is worse than one with the
    wrong icon.

14. **The backend never outlives the app.** Its stdin is a pipe only the app
    holds; end-of-file there, however the app ended, triggers the backend's own
    graceful shutdown (`PARENT_WATCH`). A quit handler alone misses SIGKILL and
    crashes, and a stray child keeps the port and the data directory.

15. **Failures are logged as well as shown.** A modal error box can open on
    another Space or behind a full-screen window, and then a failure looks like a
    hang.

16. **A browser job never leaves its own page.** Offscreen, never shown or
    focused, in an in-memory session of its slot and never the reader's, so it
    holds no reader cookie and shares no renderer with the reader; DevTools
    domains of that page only (`permitted`); a capture's network is core's
    loopback proxy, a draft's a dead one. No dialog, print panel or client
    certificate, and no `file:` read beyond the job's own document. Cleared before the slot is reused,
    because Electron cannot free a session.

---

## 5. Traps

- **`sys.executable` must be a real interpreter.** The application isolates some
  PDF work in a child process spawned as `[sys.executable, "-m", ...]`, because
  the native library underneath can abort the process outright and no Python
  handler can catch it. Under a frozen binary `sys.executable` re-launches the
  app instead, and the isolation silently disappears. This is why the runtime is
  a real CPython and not PyInstaller.

- **The interpreter and the UI build are payload, not code.** They must land in
  `Contents/Resources`, never inside the asar: one is executed and the other is
  imported by file URL, and neither works from an archive.

- **`process.env` is the whole configuration.** The application resolves its env
  file relative to the working directory, which never resolves for a bundled app,
  so every setting is passed explicitly. The data directory must be absolute or
  it resolves against the installed package.

- **A relative data directory lands inside the app bundle** and vanishes on
  update. Always absolute.

- **The build directory is not fully cleaned by the bundler.** A stale chunk from
  a previous build with different environment survives and is served — once
  producing a build that bypassed its own proxy. `build/frontend.sh` removes it
  first, and asserts afterwards that every asset the output references exists.

- **A citation's locator is matched against what the PDF prints**, never the
  noun form the model wrote. Papers print `Eq. (6)`, `3.2. Heading` and `Fig. 2`;
  models write "Equation 6" and "Section 3.2", which appear in the document
  nowhere. Caption recognition is a heuristic over extracted text and must stay
  one — when it misses, the citation lands on the page. Do not grow it into a
  list of per-document exceptions.

- **A citation is wherever an answer names a place, not only a parenthetical.**
  Models write `**Table 6, p. 11**`, "Fig. 3 (p. 4) shows" and `§§3.2–3.4` in
  their own sentences as often as `(Paper, Table 6, p. 11)`, and each shape
  fixed alone was followed by the next. One that fails to link goes, as the
  whole answer it came from, into `tests/fixtures/recorded-answers.json`, whose
  detector shares nothing with the parser. A citation with nowhere to go
  (`citationCandidates`) is drawn as prose, never as a link that does nothing.

- **An index miss relocates nothing.** A paper the model named and the library
  identifies uniquely keeps the citation even when its locator cannot be found;
  only a complete, clean scan that finds nothing may send a reader elsewhere. A
  page that fails to extract — or extracts to nothing, as a scanned one does —
  is "unknown", never "absent": a gap in our own text extraction must not move
  the reader into a different document. Resolution is also bounded; when the
  budget runs out the verdict is "unknown" and the reader still arrives.

- **A hidden window is not a headless browser.** Its renderer stops
  producing frames: `requestAnimationFrame` never fires, a draft's entrance
  never settles and a screenshot takes seconds. Job pages are offscreen
  (`webPreferences.offscreen`), which paints at a steady rate unseen.

- **The renderer's device pixel ratio is not 1.** Screenshot coordinates and CSS
  coordinates differ; drive input in CSS pixels.

- **`fetch` refuses to set some headers**, `Expect` among them. A test that needs
  to reproduce a real client must use a raw HTTP client, or it will silently test
  nothing.

- **A ChatGPT connection is an OpenAI API to the backend.** `backendEnv` passes
  the bridge URL and a per-launch token, never a saved API key. Keep subscription
  behaviour in the bridge; the shared backend serves web deployments that cannot
  use this sign-in. A Claude API key is served the same way, by
  `AnthropicTransport`, and keeps its own key slot: never the plan with a key.

- **Animate only `transform` and `opacity`.** Anything else repaints or
  relayouts every frame. This is a rule about the application's stylesheet, but
  the desktop app is where it shows: the overlay sits above a full-page canvas.

---

## 6. Extending it

| You want to | Do it here |
|---|---|
| Change what the backend is configured with | `backendEnv` in `main/backend.ts`, and a case in `tests/backend-env.test.mts` |
| Add a window or a menu | `main/index.ts`; keep the main window preload-free |
| Change the UI or its build | `frontend/` and `build/frontend.sh` |
| Add a first-run question | `onboarding/`, and one IPC channel in `preload/` |
| Support another architecture | a pinned checksum in `build/python-runtime.sh` and a target in the packaging config |
| Ship or bump a dependency, font or native library | nothing by hand: `build/notices.mjs` reads it from the build and fails until it can account for it. A text no shipped file carries goes in `build/licenses/`, its upstream in `sources.json` |
| Change how a ChatGPT plan serves the backend | `main/inference/bridge.ts`, a case in `tests/inference.test.mts`, and a live check: the endpoint's behaviour is measured, not documented |
| Change how a Claude API key serves the backend | `main/inference/anthropic-api.ts` and `tests/anthropic-api.test.mts`; keep a round's exact blocks replayable (ARCHITECTURE.md, "Claude API key transport") |
| Change what a chat turn forwards, or how its sources show | `main/research/chat-plans.ts` or `frontend/`; `tests/chat-journey.test.mts` holds the turn end to end, `frontend/tests/browser/chat-sources.spec.ts` what the reader sees |
| Change the side chat (`/side`) | core's `side_chat_stream` and `SIDE_CHAT_RULES`; it stores nothing, so `chat-plans.ts` never sees it (`tests/chat-journey.test.mts`) |
| Change what a browser job may do | `main/browser-jobs.ts` and `tests/browser-jobs.test.mts`; the page itself in `main/browser-host.ts`, held end to end by `tests/browser-host.test.mts` |
| Change how a web page is captured | core's `browser_render.py` and `routers/captures.py`, then a live run of `tests/live-capture.test.mts` (`DELPHI_LIVE_PAGES`) on a long Notion page, one page a run: two in one run outgrow this machine's memory, and notion.site answers 429 for minutes to a machine that reads it too often |
| Change how a bug is reported | the issue form in the root `.github/ISSUE_TEMPLATE/` and `main/report-bug.ts`, and a case in `tests/report-bug.test.mts` |
| Change the backend | `core/` (its manuals say how), or `backend/` for what only the desktop's app holds; then `npm run build`, `bash check.sh` and launch before committing |
| Change what a product may import from core | the surface module's `__all__`, then `python -m delphi_core_testkit.abstraction surface render --output core/public-surface.txt`; a breaking change needs a new minor version (`backend_release.py surface`). Never an entry in `core/abstraction-exceptions.txt` |
| Change the version | `desktop/package.json` and its lockfile, the three `pyproject.toml` files and their two `delphi-core==` pins together (A7, `0.7.0-dev.0` is `0.7.0.dev0`) |

Any change to the shell's contract with the application — an environment
variable, a route the host special-cases, the shape of the session bootstrap —
needs a test in `tests/`, because the core's own suite does not cover it.

---

## 7. Boundaries

Not bugs — the edges of what this shell claims to do.

- **Signed ad hoc, not notarised.** `mac.identity: "-"` seals the bundle, so a
  downloaded copy is refused as from an unidentified developer, never as
  damaged: right-click → Open, or on macOS 15 and later System Settings →
  Privacy & Security → Open Anyway. Developer ID, notarisation, hardened runtime
  and auto-update are not wired up.
- **Apple silicon only** as configured; the interpreter is per-architecture, so
  another target means another pinned checksum and another build.
- **No second browser.** Capture, previews and draft checks use the Chromium
  Electron ships. A job's memory is its renderers' resident size, sampled;
  the GPU process is shared.
- **The first launch is slow** — interpreter start plus backend import — and the
  window is shown before the backend is ready.
- **One profile per machine.** There is no account switching, because there are
  no accounts.


## Reader-to-Codex handoff

`chatPlansHandler` is the desktop chat HTTP adapter. Preserve the original scope,
model, effort and input fields; stream ordinary deltas and progress. Never report
a plan URL before validation and local persistence succeed. Retain chat receipts
with the profile so history displays the saved link and original user question.
`LocalPlans` hosts three escaped, script-free HTML plans. Archive only by an
explicit reader request containing the plan ID; never silently evict a plan.

The one-time plan MCP pairing shares reader-created plans and captured evidence.
It does not grant access to old run-scoped pairings, provider keys, or unrestricted
storage. General plans are implemented by external Codex under its own permissions;
do not misrepresent them as managed sandbox trials or synthetic benchmark results.

MCP exposes only `get_plan` and `read_plan_source`. Do not reintroduce experiment
execution, progress write-back, or a manual research dashboard. Preserve legacy
records on disk without exposing retired grants or mutation tools.

Plan actions require the `desktop_mode: "plan"` value from the explicit
chat control. Never infer authorization from prose or model output. Strip the
flag before forwarding to the backend. Normal chat cannot run local plan actions.

New plans use schema v4 (`main/research/plan-page.ts`, the backend's plan page
too): a question, Table 1 of runs by settings with decisive cells, setup,
readings and references. Exhibits beyond Table 1 come only from `exhibitKinds`,
and none is a valid choice. Label chosen defaults as proposed; do not invent
source-reported settings or leave routine choices as open questions. v2 and v3
records stay readable through their own renderer.
`renderReferencePages` uses a bounded child interpreter; never synthesize figures.
`read_plan_source` may return an image for a captured PDF page, while `get_plan`
returns image metadata. Monitoring remains outside the plan contract.
