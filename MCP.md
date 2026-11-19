# Delphi MCP: local connections and installation

Delphi MCP lets Codex retrieve a plan and captured evidence from a reader conversation.
The connection is read-only. **MCP itself has no TCP port or HTTP
endpoint.** Codex launches a native stdio bridge, which connects to a private
Unix socket on the same Mac. The localhost ports below serve HTML or the app;
they are not URLs to enter as an HTTP MCP server.

## Start from a conversation

1. Open Delphi and discuss papers in the reader. Document, project and
   Memory-scoped chats all support the handoff.
2. Press **Shift+Tab** in the composer to switch to **Plan**, then ask: “Method A in this paper seems most useful. Create a plan to
   reproduce it.” Delphi can ask a clarification if the method is unclear.
3. Delphi replies with the saved HTML link, a `plan_id`, and a ready-to-copy MCP
   installation command. No research form is required.
4. Install the connection once, then tell Codex: “Use Delphi MCP to retrieve
   plan_id `<the ID from Delphi>` and implement it in my workspace. Read its
   evidence and acceptance criteria first.”

Keep Delphi open while Codex uses its MCP. Plans persist across app restarts;
creating a plan does not execute code or approve a managed experiment. The chat’s
selected model and effort draft the plan using Delphi’s configured provider.
Codex uses its own authentication, model, effort and workspace permissions to
implement it. Local storage and transport do not make either model’s API
inference local; source context sent to those models follows their normal chat
and client behavior.

## Install in Codex once

Delphi installs a managed launcher at `~/.local/bin/delphi-mcp` when preparing
the first chat handoff. Register it with:

```sh
codex mcp add delphi -- "$HOME/.local/bin/delphi-mcp"
```

The launcher supplies the bridge path, profile socket, pairing ID and the path of
the pairing token internally. It contains no secret: the token stays in Delphi's
profile, in a file only your macOS account can read. Delphi refreshes the launcher on subsequent starts when a reader-plan
pairing exists, so opening a moved or updated app repairs its bridge path.
Existing explicit-path MCP configurations remain supported.

Delphi's generated command includes the quoted absolute launcher path. The
Terminal example above expands `$HOME` before Codex saves its configuration, so
launching Codex from the Dock does not depend on shell PATH configuration. If an
older registration contains only `delphi-mcp`, run the current generated command
again to replace it. Delphi does not edit shell profiles and refuses to overwrite
an unrelated file or symlink at its managed launcher path.

Then start a **new Codex session** so it loads the MCP configuration. Verify the
entry from Terminal with:

```sh
codex mcp list
codex mcp get delphi
```

Ask Codex to call `get_plan` with the actual `plan_id`. That verifies the live
connection; seeing an entry in `mcp list` alone only verifies configuration.
Subsequent plans use the same installation. Setup guidance is always available
in **Help → Set Up Delphi MCP**, the hosted plan’s **MCP setup instructions**
disclosure, and normal chat. Help prepares or refreshes the launcher and offers
the install command for copying without using a model. A chat reminder displays
predefined guidance without provisioning credentials. Setup failure does not
discard a saved plan.

The equivalent manually configured stdio entry is:

```toml
[mcp_servers.delphi]
command = "/Users/YOUR_NAME/.local/bin/delphi-mcp"
```

Replace YOUR_NAME with your actual home-directory path, or copy the generated command from Delphi. Use one installation method. The bridge reads its pairing token from Delphi's
profile, authenticates to the profile socket, and reserves stdout for MCP
messages. Diagnostics go to stderr. Do not invent a pairing ID;
Delphi creates the pairing when preparing the chat handoff.

Codex’s stdio configuration is described in the
[official MCP guide](https://developers.openai.com/codex/mcp/).

## Connection and port map

| Surface | Address |
|---|---|
| MCP | `/tmp/delphi-research-<uid>-<profile-hash>.sock`; private Unix socket, no TCP endpoint |
| Plans | `http://localhost:8730` through `:8732`, by default, at `/plans/<plan_id>`; occupied ports fall back to a free loopback port |
| Reader | `http://localhost:<uiPort>`, selected at launch |

`DELPHI_PLAN_PORT` changes the preferred three-port range. The chosen port is persisted with each active plan and reused when available. If hosting cannot bind, the reader and MCP remain available and get_plan reports no hosted URL. Retrieve the current URL by plan_id after a port change; an old bookmarked port may belong to another process. Keep Delphi open while reading
plans or using MCP. The retired `/desktop/research` routes return 410.

## Tool contract

| Tool | Input | Result | Why retained |
| --- | --- | --- | --- |
| `get_plan` | `plan_id`: full UUID supplied by Delphi; optional `include_conversation` (default false) | Plan, revision, content hash, archived flag, current hosted URL, and source metadata with indices and available image pages | Retrieves the agreed research design without asking a model to locate or reconstruct it |
| `read_plan_source` | `plan_id`, zero-based `index`; optional `offset` (default 0), or `page` | Text chunk and next offset, or an actual captured PDF page image | Lets the coding agent check the plan against its literature |

Request `include_conversation: true` only when discussion details are needed; the default get_plan response omits that potentially large history and the original request payload.

Both tools advertise read-only, idempotent, closed-world behavior. Unknown tools,
invalid IDs, unknown source indices, unavailable images, and revoked pairings
return tool errors. Full UUIDs are required; prefix guessing is unsupported.
There is no plan-list tool: users hand over the specific plan ID they intend to
share. An active pairing can retrieve any known local plan ID, including archived
plans; it is not a separate per-plan grant.

Text reads contain at most 20,000 JavaScript string characters (UTF-16 code units).
Follow `nextOffset` until it is `null`. Offsets beyond the captured text are errors.
Use `imagePages` from `get_plan` when requesting an image. Images are captured PDF
pages, potentially including surrounding content, rather than generated figures.
An unavailable source is reported explicitly. A matched excerpt establishes text
identity, not that a source supports the model's interpretation.

A plan captures at most 20 documents, up to 512 KB of text per document, and up to
three PDF page images in total. Capture is a snapshot, not live library access.
Missing coverage and truncation remain explicit in the returned context. The
source revision is a hash of its captured text; the plan content hash covers its
design and captured context. Archival changes availability and revision, not that
content hash. Archived records remain readable through MCP, but their HTML slot
may be reused by another plan with a different ID.

## Reliability and recovery

HTML, localhost URLs, UUIDs, and installation guidance are produced by code after
schema validation. Models supply structured plan content, not executable HTML.
Full installation text appears on the first saved-plan handoff; subsequent replies give a short setup pointer. This records that guidance was shown, not that the client registered MCP. Direct questions naming Delphi MCP and `/mcp` return predefined help without a provider call; less direct wording may still use chat. Full help always remains in the native Help menu and plan page.

Unmatched generated quotes are omitted; actual source IDs must still resolve to
captured documents. The hosted page escapes text and forbids scripts and remote
assets. Page editing is intentionally outside this release.

Planning checkpoints its received draft and short reading-status summaries locally.
Up to three drafts are retained with their original request text within a shared
48,000-character retry-context budget, preserving the newest answer tails first; validation feedback is included in the
next attempt. After an internet failure or Stop during generation, send another
Plan-mode request in the same conversation. This starts a new paid generation;
there are no automatic paid retries. Tool execution that produced no returned
answer cannot be resumed: Delphi retains the request and available status
summaries, not inaccessible provider-side tool state.

Once the UI receives the plan-save progress event, Stop becomes disabled with
“Finishing save…” guidance. Valid completed JSON is no longer discarded: local source
capture and saving finish independently of the client, with a shared 30-second
capture deadline (including PDF rendering). The saved handoff is restored on chat
reload. An abrupt app termination can still require retry; received draft text is
checkpointed, rather than promising survival of work never delivered to Delphi.
Clearing a chat discards retry context without archiving existing plans. Editing
a message shows the composer's selected Chat or Plan mode and supports Shift+Tab
to change it before sending.

An identical completed request ID replays its saved answer without generating a
second plan or calling the provider. A still-running request cannot run twice.
After restart, an interrupted request can be retried. The plan records its request
receipt ID so a retry can recover a plan committed before its final answer was
delivered. Ordinary new messages get new request IDs and are not deduplicated by
wording. Existing plans and downstream implementation files are never rolled back
by a failed planning request.

Capacity is three hosted plans. The checklist selects exact IDs and revisions;
archival is transactional and retains records. In-flight reservations prevent
concurrent drafts from claiming the same last slot. These are local safeguards,
not distributed scheduling infrastructure.

## Transport and removed capabilities

The `delphi-mcp` bridge uses stdio to the client and an authenticated Unix socket
to Delphi. The socket is owner-only; a random pairing token lives in an owner-only file
(`research/mcp-token` in the profile), with only its hash in the grant. Every
tool call checks the grant. A missing or mismatched token is replaced and the
launcher rewritten, so the client's registration keeps working; nothing asks for
the Keychain. Quitting
Delphi closes the connection; reopen it and reconnect the client to continue.

No execution, trial runner, filesystem write, progress write-back, artifact upload,
or learning-record tool is exposed. Historical records remain on disk, but the
MCP projection excludes historical progress and artifacts. The retained tools
cover the complete read-only handoff; adding an agent-side side task to report
results back is intentionally unsupported.

Receipt marker lookups are indexed, including migration of existing receipts. Receipts are retained to restore historical handoffs; chat loading does not compare every message against every receipt.

The contract is covered by `tests/chat-plans.test.mts`,
`tests/reference-plan.test.mts`, `tests/plan-capacity.test.mts`, and
`tests/mcp-launcher.test.mts`, and `tests/plan-audit-regressions.test.mts`. Run `bash check.sh` for the full repository gate.

## Troubleshooting

- Open Delphi if the bridge cannot connect; opening the app also refreshes its launcher.
- Supply the `plan_id`, not a former notebook run ID or pairing ID.
- If an older client advertises write tools, start a new client session to refresh the tool list. Calls to retired tools are rejected.
- A plan exists only after chat returns its saved URL and ID. Interrupted or invalid drafts do not confirm a save.
- Three plans can be hosted. When full, the Plan-mode checklist lets you select which plans to archive before continuing. Records remain available through MCP.

To remove the client entry, run `codex mcp remove delphi`. This does not delete
plans, the launcher or the pairing token.
