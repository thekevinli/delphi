"""
How an answer was reached, as one record: what it was handed, what the model
said it was doing, and every call Delphi ran for it, in the order they happened.

There used to be three accounts of this and they disagreed about what lasts.
The reasoning summaries were forwarded and thrown away. The tool calls were
kept as a flat list, and for a Memory answer kept a second time as a "walk"
classified by how each page had been reached. A reader who reloaded a
conversation got the calls without the thinking that explains them, and never
in the order either happened.

`AnswerTrace` is the one record. It is built once, here, from the events both
chat streams already produce, and it is used twice: every change is sent down
the stream as a `trace` event so the answer in front of the reader is drawn
from it while it is written, and `stored()` is what goes on the message so a
reload draws the same thing. There is no second derivation to drift.

Two kinds of entry, and the difference matters (invariant 40):

- a **tool** entry is *ours*: a call the model asked Delphi for. Its
  arguments, its timing, whether it ran and failed and the pages it returned
  are facts. An entry is opened as the model begins the call, so one the
  answer ended on may never have run, and says so (`Interrupted`).
- a **thought** entry is *the model's*: the provider's summary of its
  reasoning, kept verbatim beside the calls it explains. It is never parsed,
  never used to decide anything, and never re-enters a request — the history
  projection keeps only role and content.

The record is laid out as **stretches**: the work between two pieces of answer
text. A model thinks, writes, then thinks again, and each stretch sits where it
happened in the answer (`offset`). Two units, stated once because the clients
are browsers:

- `offset` counts **UTF-16 code units**, which is what a browser slices a
  string by. Counting characters here would put every stretch after an emoji
  one place early.
- every time is **milliseconds since the request began** — never a clock
  time — so a stretch reads on its own and nothing depends on two machines
  agreeing what time it is.

    trace: [
      { offset, startedAt, endedAt,
        context?: { start: {kind, title?, slug?, pageKind?, paperId?},
                    index?: {pages, documents, projects, chats},
                    given?: [{slug, title, kind}], memory?: "unavailable" },
        entries: [
          { kind: "thought", at, text },
          { kind: "tool", at, ms, ok, error?, tool, running?, writing?, queued?,
            args: {pattern | query | slug | pages | ...},
            results: [{slug | paperId | url, title, kind}] } ] } ]
"""

import json
import time
from typing import Any

#: A thought is a summary line, not a transcript. Bounded so a talkative model
#: cannot put a second answer's worth of prose on every stored message.
THOUGHT_MAX_CHARS = 1_200
#: Entries one answer may keep. Past this the record stops growing and says so
#: (`truncated` on the stretch) rather than silently losing its tail.
ENTRIES_MAX = 80
#: Pages listed under one call. A lookup can match hundreds; the row shows the
#: first few and `found` carries the true count.
RESULTS_MAX = 12
ARGUMENT_MAX_CHARS = 200

def utf16_length(text: str) -> int:
    """How long a browser says this string is."""
    return len(text.encode("utf-16-le")) // 2


def call_arguments(
    keep: tuple[tuple[str, str], ...], arguments: str | dict[str, Any]
) -> dict[str, Any]:
    """
    The arguments of one call worth keeping, bounded and renamed.

    `keep` is the tool's own statement of which arguments those are and the
    name each is stored under (`harness.tool.TraceProjection`). The whole
    argument blob is never stored: for a read it would be a copy of the
    request, and the row only ever shows one thing a call was pointed at.
    """
    if isinstance(arguments, str):
        try:
            parsed = json.loads(arguments or "{}")
        except json.JSONDecodeError:
            return {}
    else:
        parsed = arguments
    if not isinstance(parsed, dict):
        return {}
    kept: dict[str, Any] = {}
    for source, name in keep:
        value = parsed.get(source)
        if isinstance(value, str) and value:
            kept[name] = value[:ARGUMENT_MAX_CHARS]
        elif isinstance(value, bool):
            continue
        elif isinstance(value, int):
            kept[name] = value
        elif isinstance(value, list):
            kept[name] = [item for item in value if isinstance(item, int)][:8]
    return kept


#: What a tool's own prose says when it did not do what was asked. Tools answer
#: every failure in prose (invariant 15), so the outcome is read off the start
#: of that prose — the one place it is stated — and nowhere else.
_NOT_FOUND = ("no page exists", "none of those pages exist", "no web document", "no pdf with")
#: Why a call was refused, as its own error says it: a source that could not
#: be read, arguments the tool would not take, or a draft not yet publishable.
_REFUSED = (
    ("reads pdfs of up to", "PDF too long"), ("no extractable text", "No text"), ("access challenge", "Site blocked"),
    ("no readable", "No text"), ("could not be read", "Unreadable"),
    ("cannot use these arguments", "Bad arguments"), ("not valid json", "Bad arguments"),
    ("is not a tool this conversation offers", "Unknown tool"),
    ("rendering is unavailable", "Unavailable"), ("short plain-text title", "Bad title"),
    ("unknown artifact_id", "Unknown draft"), ("already delivered", "Already delivered"),
    ("html characters for a new draft", "No HTML"), ("allowed visualizations", "Limit reached"),
    ("exhausted its draft attempts", "Limit reached"), ("unknown or stale artifact revision", "Stale revision"),
    ("has not passed rendering", "Not rendered"), ("inspect the render result", "Not inspected"),
    ("a source was read in or after", "Read after draft"), ("describe what you checked", "No review"),
)
_SPENT = ("budget is exhausted", "budget for consulting", "per-answer limit", "is spent")


def call_outcome(output: str) -> tuple[bool, str | None]:
    """Whether a call did what was asked, and the two words that say why not."""
    head = output[:240].lower()
    if any(marker in head for marker in _SPENT):
        return False, "Limit reached"
    if head.startswith("no page exists") or any(
        head.startswith("error:") and marker in head for marker in _NOT_FOUND
    ):
        return False, "Not found"
    if head.startswith("error:") and "limit is reached" in head:
        return False, "Limit reached"
    if head.startswith("error:") and "timed out" in head:
        return False, "Timed out"
    if head.startswith("error:") and (reason := next((said for marker, said in _REFUSED if marker in head), None)):
        return False, reason
    if head.startswith("error: artifact validation failed ("):
        reason = output.split("(", 1)[1].split(")", 1)[0][:40]
        return False, reason[:1].upper() + reason[1:]
    if head.startswith("error:"):
        return False, "Failed"
    return True, None


class AnswerTrace:
    """
    Records one answer's trace and says what changed, as stream events.

    Every method that changes the record returns the `trace` events describing
    that change, for the caller to send. A client that applies them in order
    holds exactly what `stored()` returns, which is the whole design: the live
    answer and the reloaded one are the same data.

    The events, each `{"type": "trace", "stretch": n, ...}`:

    - `open`   — a stretch began: `{offset, startedAt, context?}`
    - `entry` + `set`  — entry `k` of the stretch is now this (a new thought, a
      call the model began writing, the same call written, run or finished)
    - `entry` + `text` — append to thought `k`
    - `close`  — the stretch ended: `{endedAt}`
    """

    def __init__(self, started: float | None = None) -> None:
        self._started = time.monotonic() if started is None else started
        self._stretches: list[dict[str, Any]] = []
        self._written = 0
        self._thought: int | None = None
        self._context: dict[str, Any] | None = None
        self._entries = 0
        # Calls the model has asked for that Delphi has not yet answered, by
        # handle. Answer text that follows one in the same response does not
        # interrupt it: Delphi still runs it, and reports how it went.
        self._owed: set[tuple[int, int]] = set()

    def _now(self) -> int:
        return max(0, round((time.monotonic() - self._started) * 1000))

    def _event(self, **fields: Any) -> dict[str, Any]:
        return {"type": "trace", "stretch": len(self._stretches) - 1, **fields}

    def _set(self, handle: tuple[int, int]) -> dict[str, Any]:
        """The event saying what the entry at `handle` now is, wherever it sits."""
        stretch, index = handle
        entry = self._stretches[stretch]["entries"][index]
        return {"type": "trace", "stretch": stretch, "entry": index, "set": dict(entry)}

    def _running(self, handle: tuple[int, int] | None) -> dict[str, Any] | None:
        """The entry at `handle` while it is still running, else None."""
        if handle is None:
            return None
        stretch, index = handle
        entry = self._stretches[stretch]["entries"][index]
        return entry if "running" in entry else None

    def _open_stretch(self) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        """The stretch in progress, opening one where the answer now stands."""
        if self._stretches and "endedAt" not in self._stretches[-1]:
            return self._stretches[-1], []
        stretch: dict[str, Any] = {
            "offset": self._written,
            # The first stretch counts from the request: the wait before the
            # model says anything is part of it. A later one starts when its
            # first entry does, since the time before it was spent writing.
            "startedAt": 0 if not self._stretches else self._now(),
            "entries": [],
        }
        if not self._stretches and self._context:
            stretch["context"] = self._context
        self._stretches.append(stretch)
        self._thought = None
        return stretch, [
            self._event(open={key: value for key, value in stretch.items() if key != "entries"})
        ]

    def _add(self, entry: dict[str, Any]) -> tuple[int | None, list[dict[str, Any]]]:
        stretch, events = self._open_stretch()
        if self._entries >= ENTRIES_MAX:
            if not stretch.get("truncated"):
                stretch["truncated"] = True
                events.append(self._event(open={"truncated": True}))
            return None, events
        self._entries += 1
        stretch["entries"].append(entry)
        index = len(stretch["entries"]) - 1
        events.append(self._event(entry=index, set=dict(entry)))
        return index, events

    def context(
        self,
        start: dict[str, Any],
        index: dict[str, int] | None = None,
        *,
        given: list[dict[str, Any]] | None = None,
        memory: str | None = None,
    ) -> list[dict[str, Any]]:
        """
        What the answer was handed before it did anything: where the reader
        was, how much there was to choose from, and the Memory pages chosen
        for it (`given`). First stretch only, and never counted as a step —
        none of it is something the model did. Pages Delphi put in the request
        are context, not a call: no model asked for them.

        Choosing those pages is a call the reader waits on, so it is said
        twice: once with `memory="choosing"` when it starts, and again when it
        ends, with what came of it — `given`, or `"none"` for a considered
        nothing, or `"unavailable"` when Memory could not be consulted, which
        is a different statement. The second says when it ended (`memoryMs`).
        """
        choosing = (self._context or {}).get("memory") == "choosing"
        self._context = {
            "start": start,
            **({"index": index} if index else {}),
            **({"given": given[:RESULTS_MAX]} if given else {}),
            **({"memory": memory} if memory and not given else {}),
            **({"memoryMs": self._now()} if choosing else {}),
        }
        if not self._stretches:
            _, events = self._open_stretch()
            return events
        first = self._stretches[0]
        if "context" not in first:
            return []
        first["context"] = self._context
        return [{"type": "trace", "stretch": 0, "open": {"context": self._context}}]

    def thought(self, text: str) -> list[dict[str, Any]]:
        """More of the model's current summary line, as it streams."""
        if not text:
            return []
        stretch, events = self._open_stretch()
        if self._thought is None:
            index, added = self._add({"kind": "thought", "at": self._now(), "text": ""})
            events.extend(added)
            if index is None:
                return events
            self._thought = index
        entry = stretch["entries"][self._thought]
        room = THOUGHT_MAX_CHARS - len(entry["text"])
        if room <= 0:
            return events
        piece = text[:room]
        entry["text"] += piece
        events.append(self._event(entry=self._thought, text=piece))
        return events

    def thought_break(self) -> list[dict[str, Any]]:
        """The summary line ended; the next text starts another."""
        self._thought = None
        return []

    def call_begun(self, tool: str) -> tuple[tuple[int, int] | None, list[dict[str, Any]]]:
        """
        The model began writing a call to `tool`. Returns its handle and the events.

        Shown from this moment, while the call's arguments are still streaming
        (`writing`), because they can take as long as the call: a draft's whole
        source is its argument. Recorded only once Delphi ran it, the row came
        after that wait, and the answer sat on its last sentence with nothing to
        say it was still moving. `call_written` and `tool_started` complete the
        same entry, so it is one row from first word to result, and its `at`
        is when the model began it: `ms` counts from there, through any wait.

        `running` holds until Delphi has answered the call; `writing` and then
        `queued` say what it waits on before Delphi runs it, so a reader can
        tell the call being worked on from the ones behind it.
        """
        handle, events = self.tool_started(tool)
        entry = self._running(handle)
        if entry is not None:
            entry["writing"] = True
            events[-1] = self._set(handle)
            self._owed.add(handle)
        return handle, events

    def call_written(
        self, handle: tuple[int, int] | None, args: dict[str, Any] | None = None
    ) -> list[dict[str, Any]]:
        """The model finished writing the call, which now waits for Delphi to run it."""
        entry = self._running(handle)
        if entry is None:
            return []
        entry.pop("writing", None)
        entry["queued"] = True
        entry["args"] = dict(args or {})
        return [self._set(handle)]

    def tool_started(
        self,
        tool: str,
        args: dict[str, Any] | None = None,
        *,
        begun: tuple[int, int] | None = None,
    ) -> tuple[tuple[int, int] | None, list[dict[str, Any]]]:
        """
        A call Delphi is about to run. Returns its handle and the events.

        `args` is what the call keeps, already projected (`call_arguments`).
        Recorded before it runs so the reader sees what is being looked at
        while it is being looked at; `tool_finished` completes the same entry.
        `begun` is the handle `call_begun` gave the same call, whose entry this
        continues; a call nobody saw begin gets an entry of its own.

        The handle names the stretch as well as the entry: a call the provider
        runs is reported finished by the provider, and by then answer text may
        have closed the stretch it began in.
        """
        self._thought = None
        entry = self._running(begun)
        if entry is not None and entry["tool"] == tool:
            entry.pop("writing", None)
            entry.pop("queued", None)
            entry["args"] = dict(args or {})
            return begun, [self._set(begun)]
        index, events = self._add(
            {
                "kind": "tool",
                "at": self._now(),
                "tool": tool,
                "args": dict(args or {}),
                "running": True,
            }
        )
        handle = None if index is None else (len(self._stretches) - 1, index)
        return handle, events

    def tool_finished(
        self,
        handle: tuple[int, int] | None,
        *,
        ok: bool = True,
        error: str | None = None,
        results: list[dict[str, Any]] | None = None,
        found: int | None = None,
        args: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        """
        The call returned: how long it took, whether it worked, what it gave.

        `args` replaces what the entry kept, for a call Delphi did not make:
        the provider says what a hosted search asked only once it is done.
        """
        entry = self._running(handle)
        if entry is None:
            # It was interrupted when its stretch ended, and the entry already
            # says so: a record the reader has been shown as closed is not
            # reopened. Only a call Delphi still owes outlives its stretch.
            return []
        self._owed.discard(handle)
        entry.pop("running", None)
        if args is not None:
            entry["args"] = dict(args)
        entry["ms"] = max(0, self._now() - entry["at"])
        entry["ok"] = ok
        if error and not ok:
            entry["error"] = error
        listed = [item for item in results or [] if item.get("title")][:RESULTS_MAX]
        entry["results"] = listed
        if found is not None and found > len(listed):
            entry["found"] = found
        return [self._set(handle)]

    def tool(
        self,
        tool: str,
        args: dict[str, Any] | None = None,
        *,
        ms: int = 0,
        ok: bool = True,
        error: str | None = None,
        results: list[dict[str, Any]] | None = None,
    ) -> list[dict[str, Any]]:
        """A call that has already happened, recorded in one step."""
        handle, events = self.tool_started(tool, args)
        if handle is None:
            return events
        entry = self._stretches[handle[0]]["entries"][handle[1]]
        # It ran before it was recorded, so it began `ms` ago.
        entry["at"] = max(0, entry["at"] - ms)
        events.extend(self.tool_finished(handle, ok=ok, error=error, results=results))
        return events

    def answered(self, text: str) -> list[dict[str, Any]]:
        """Answer text was written: whatever stretch was in progress is over."""
        self._written += utf16_length(text)
        if not text.strip():
            # A paragraph break between two messages is not the answer resuming.
            return []
        return self._close()

    def finish(self) -> list[dict[str, Any]]:
        """The answer is complete; a stretch still open ends here."""
        return self._close(final=True)

    def _interrupt(self, handle: tuple[int, int]) -> list[dict[str, Any]]:
        # A call the stream ended on never returned; it did not succeed. Said
        # as an event too, so the answer on screen ends where the stored one
        # does and not with a call that runs for ever.
        self._owed.discard(handle)
        entry = self._stretches[handle[0]]["entries"][handle[1]]
        if not entry.pop("running", None):
            return []
        # `writing` or `queued` stays: a call cut off before Delphi ran it is
        # not said as though it ran, nor read back as evidence (`tool_entries`).
        entry.update(ms=max(0, self._now() - entry["at"]), ok=False, error="Interrupted", results=[])
        return [self._set(handle)]

    def _close(self, *, final: bool = False) -> list[dict[str, Any]]:
        events = []
        if final:
            # A call still owed from an earlier stretch will not be run now.
            for handle in sorted(self._owed):
                events.extend(self._interrupt(handle))
        if not self._stretches or "endedAt" in self._stretches[-1]:
            return events
        stretch = self._stretches[-1]
        last = len(self._stretches) - 1
        for index, entry in enumerate(stretch["entries"]):
            if "running" in entry and (final or (last, index) not in self._owed):
                events.extend(self._interrupt((last, index)))
        stretch["endedAt"] = self._now()
        self._thought = None
        return [*events, self._event(close={"endedAt": stretch["endedAt"]})]

    def stored(self, shift: int = 0) -> list[dict[str, Any]]:
        """
        The record as it goes on the message: exactly what the events built.

        Nothing is filtered or tidied here, because anything changed at this
        point would be a difference between the answer the reader watched and
        the one a reload shows. `shift` is the one adjustment: how many UTF-16
        units were trimmed from the front of the answer before it was stored,
        so each stretch still sits where it happened in the text that is kept.
        """
        return [
            {**stretch, "offset": max(0, stretch["offset"] - shift)}
            for stretch in self._stretches
        ]


def tool_entries(trace: Any) -> list[dict[str, Any]]:
    """
    The calls in a stored trace, in order, and nothing else.

    For anything that reads a trace back as evidence of what was read — answer
    filing does. The thoughts are left out by construction: they are the
    model's account of itself, and a later model asked to learn from that
    account would be learning from prose nobody checked. So is a call the
    answer ended on before Delphi ran it (`writing` or `queued`): it read
    nothing.
    """
    if not isinstance(trace, list):
        return []
    return [
        entry
        for stretch in trace
        if isinstance(stretch, dict)
        for entry in stretch.get("entries") or []
        if isinstance(entry, dict) and entry.get("kind") == "tool"
        and not entry.get("writing") and not entry.get("queued")
    ]
