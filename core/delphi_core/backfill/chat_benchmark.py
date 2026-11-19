"""
Are chat answers better or worse with one build, or one Memory, than another?

    # a server per arm, each on its own copy of one staged data directory
    backend/.venv/bin/python -m delphi_core.backfill.chat_benchmark stage  --base-url http://127.0.0.1:8201 --questions q.json --library papers/ --out bench/
    backend/.venv/bin/python -m delphi_core.backfill.chat_benchmark run    --base-url http://127.0.0.1:8201 --questions q.json --arm new --out bench/
    backend/.venv/bin/python -m delphi_core.backfill.chat_benchmark judge  --questions q.json --arm new --model <a model other than the one answering> --out bench/
    backend/.venv/bin/python -m delphi_core.backfill.chat_benchmark report --questions q.json --out bench/

    # or an account the server already holds (a restored corpus, a staged candidate)
    CHAT_BENCHMARK_PASSWORD=... backend/.venv/bin/python -m delphi_core.backfill.chat_benchmark adopt --base-url ... --user corpus --questions q.json --out bench/
    backend/.venv/bin/python -m delphi_core.backfill.chat_benchmark run --base-url ... --questions q.json --arm busy --while-draining --out bench/

The chat-side evaluation rig. It asks a fixed question file through the real
`/api/chat/stream`, once per arm, and writes each answer with its trace,
sources and timing; `judge` grades the answers against the file's reviewed
facts and `report` decides the gates that can be decided mechanically.
`memory_eval.py` owns the page-level metrics and reads this rig's summary
(`summarise`, also written as `report.json`) for the answer-level ones:
accuracy and cost of answers with no Memory, the old Memory and the new one,
and whether an answer builds on the page its key names.

An **arm** is a name (`old`, `new`, `none`, `new+web`; the first comparison
used `A`, `B` and `C`) for one server over one copy of the staged data. Its
files are `arm-<name>.jsonl` and `arm-<name>.graded.jsonl`. The rig speaks
HTTP and imports nothing from the application but its settings, so one file
drives servers built from different commits (`--legacy-body` sends the request
field the commit before the web harness still requires). Every arm names the
Mentor persona, so a difference between arms is never one between personas.

`--questions PATH` names the question file, which every command needs, and
`--library PATH` the directory `stage` imports that file's documents from.
Neither has a default: core ships no question file, since one is about a
particular library, and an installed core cannot know where a checkout keeps
its documents. A question file holds:

| Field       | Meaning |
|-------------|---------|
| `library`   | the documents `stage` imports: `key`, `file` (relative to `--library`), `finished`; or that `adopt` finds: `key`, `id` |
| `project`   | the name of the one project they are imported into |
| `questions` | `id`, `class`, `scope`, `prompt`, `facts`; `open` (the library key of the open document) in document scope; `builds_on` (a library key: a good answer links a page resting on it) or `links: "none"` (no connection exists, so no page may be linked); `search` to override the class |
| `classes`   | per class: `search` (`"never"` or `"always"`) and `timed` (counts towards time to first text). `CLASSES` is what a class means when the file says nothing |
| `arms`      | per arm name: `gated` (false for a reference arm that is only counted and timed), `web` (web search is on, so the search and source gates apply) and `against` (the arm whose time to first text this one must stay close to) |
| `gates`     | thresholds: `wrong_searches_allowed`, `right_searches_required`, `first_text_ratio` |

So the gates come from the classes and from these fields, never from an arm's
name. An arm the file does not describe gets the connection gate alone, and
`report` says the web gates were not applied to it.

`stage` builds the library through the product's own routes in whatever data
directory the server was started on: one account, one project, the library's
documents, filed into Memory, with the ones marked `finished` marked so. Stage
once, then start each arm's server on a copy of that directory, so every arm
answers from the same digests. `adopt` is `stage` for a library that is
already there: the file's `library` names each document by its stored `id`
(each may sit in its own project), and the account's password is read from
`CHAT_BENCHMARK_PASSWORD`. `run --while-draining` drains the Memory queue from
a second client while it asks, and records for each answer whether a job was
running, for the gate that chat does not slow down beside maintenance.

`report` reads what can be read mechanically: whether a search ran against
whether the question's class wanted one, which Memory pages the answer links
against the key, whether every cited address is among the stored sources, time
to first text, rounds and hosted calls, and the judge's grades where `judge`
has run. Correctness against the keys needs that pass (a model other than the
one answering) and a person: `report` prints the gates it can decide and lists
the answers a person has to read.

An offline rig (CLAUDE.md §3.1): reachable from no route and no
`run_backfill.sh` command, and it creates its own account rather than touching
a reader's. Only `judge` calls a model.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import re
import os
import statistics
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any

import httpx

from ..config import Settings

USERNAME = "benchmark_reader"
PASSWORD = "Benchmark-only-2026!"
#: Where `adopt` and `run` read an adopted account's password, so it is never on a command line.
PASSWORD_VARIABLE = "CHAT_BENCHMARK_PASSWORD"
PROJECT = "Benchmark library"
#: What a question class means when the question file does not say: whether a
#: web search must never or must always run on it, and whether its answers
#: count towards time to first text (those that settle from the open document).
#: A class absent here, and absent from the file, is gated on nothing.
CLASSES: dict[str, dict[str, Any]] = {
    "document": {"search": "never", "timed": True},
    "memory": {"search": "never"},
    "only-this-paper": {"search": "never"},
    "outside-fact": {"search": "always"},
    "lineage": {"search": "always"},
}
#: The thresholds a file may restate under `gates`. `right_searches_required`
#: has no fixed default: unless the file gives one, it is every must-search
#: question the arm answered but one.
GATES: dict[str, Any] = {"wrong_searches_allowed": 1, "right_searches_required": None, "first_text_ratio": 1.15}
#: An arm's name reaches a file name, and `new+web` has to be one.
ARM = re.compile(r"[A-Za-z0-9][A-Za-z0-9+_-]{0,39}")
LINK = re.compile(r"\[\[([^\]|]+)\]\]")
WEB_LINK = re.compile(r"\]\((https?://[^)\s]+)\)")


def arm_name(value: str) -> str:
    if not ARM.fullmatch(value):
        raise argparse.ArgumentTypeError(
            f"{value!r} is not an arm name: letters, digits, '+', '_' and '-', at most 40, starting with a letter or digit"
        )
    return value


def arm_file(out: Path, arm: str, *, graded: bool = False) -> Path:
    return out / f"arm-{arm}{'.graded' if graded else ''}.jsonl"


def load_questions(path: str | Path) -> dict[str, Any]:
    """The question file, checked: every problem at once, before a server is asked anything."""
    path = Path(path)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit(f"{path}: cannot be read as a question file ({error})")
    if not isinstance(data, dict):
        raise SystemExit(f"{path}: a question file is an object with `library` and `questions`")
    problems: list[str] = []
    library = data.get("library")
    if not isinstance(library, list) or not all(
        isinstance(entry, dict) and isinstance(entry.get("key"), str)
        and (isinstance(entry.get("file"), str) or isinstance(entry.get("id"), str))
        for entry in library
    ):
        problems.append("`library` must be a list of {key, file} (to stage) or {key, id} (to adopt)")
        library = []
    documents = [entry["key"] for entry in library]
    if len(set(documents)) != len(documents):
        problems.append("`library` repeats a key")
    classes = {name: dict(meaning) for name, meaning in CLASSES.items()}
    for name, meaning in (data.get("classes") or {}).items():
        if not isinstance(meaning, dict) or meaning.get("search") not in (None, "never", "always"):
            problems.append(f"class {name}: `search` is \"never\" or \"always\"")
            continue
        classes[name] = {**classes.get(name, {}), **meaning}
    questions = data.get("questions")
    if not isinstance(questions, list) or not questions:
        problems.append("`questions` must be a non-empty list")
        questions = []
    seen: set[str] = set()
    for index, question in enumerate(questions):
        name = question.get("id") if isinstance(question, dict) else None
        label = f"question {name or index}"
        if not isinstance(question, dict):
            problems.append(f"{label}: not an object")
            continue
        for field in ("id", "class", "scope", "prompt"):
            if not isinstance(question.get(field), str) or not question[field]:
                problems.append(f"{label}: `{field}` is missing")
        if name in seen:
            problems.append(f"{label}: the id is used twice")
        seen.add(name)
        if not isinstance(question.get("facts"), list) or not question["facts"]:
            problems.append(f"{label}: `facts` must list at least one fact")
        if question.get("scope") != "general" and question.get("open") not in documents:
            problems.append(f"{label}: `open` must name a library key")
        if question.get("builds_on") is not None and question["builds_on"] not in documents:
            problems.append(f"{label}: `builds_on` must name a library key")
        if question.get("links") not in (None, "none"):
            problems.append(f"{label}: `links` can only be \"none\"")
        if question.get("links") and question.get("builds_on"):
            problems.append(f"{label}: has both `builds_on` and `links: none`")
        if question.get("search") not in (None, "never", "always"):
            problems.append(f"{label}: `search` is \"never\" or \"always\"")
    arms = data.get("arms") or {}
    for name, described in arms.items() if isinstance(arms, dict) else ():
        if not ARM.fullmatch(name) or not isinstance(described, dict):
            problems.append(f"arm {name}: not an arm name with an object beside it")
        elif described.get("against") is not None and described["against"] not in arms:
            problems.append(f"arm {name}: `against` names an arm the file does not describe")
    if not isinstance(arms, dict):
        problems.append("`arms` must be an object")
        arms = {}
    unknown = sorted(set(data.get("gates") or {}) - set(GATES))
    if unknown:
        problems.append(f"`gates` has unknown thresholds: {', '.join(unknown)}")
    if problems:
        raise SystemExit(f"{path} is not a usable question file:\n  " + "\n  ".join(problems))
    return {
        **data, "library": library, "questions": questions, "classes": classes, "arms": arms,
        "gates": {**GATES, **(data.get("gates") or {})}, "project": data.get("project") or PROJECT,
    }


def client(base_url: str) -> httpx.Client:
    return httpx.Client(base_url=base_url, timeout=httpx.Timeout(1200, connect=10))


def sign_in(http: httpx.Client, *, create: bool, user: str | None = None) -> None:
    """The rig's own account, or with `user` an adopted one, whose password is in `PASSWORD_VARIABLE`."""
    body = {"username": user or USERNAME, "password": os.environ.get(PASSWORD_VARIABLE, "") if user else PASSWORD}
    response = http.post("/api/auth/register" if create else "/api/auth/login", json=body)
    if create and response.status_code == 409:
        response = http.post("/api/auth/login", json=body)
    response.raise_for_status()


def events(response: httpx.Response):
    for line in response.iter_lines():
        if line.startswith("data:") and line[5:].strip() not in {"", "[DONE]"}:
            yield json.loads(line[5:])


def drain(http: httpx.Client) -> None:
    """Run the Memory queue until nothing is due, as an open tab would."""
    for _ in range(400):
        with http.stream("POST", "/api/memory/maintenance/drain") as response:
            response.raise_for_status()
            last = None
            for last in events(response):
                pass
        if not last or last.get("claimed") is False:
            return
    raise SystemExit("The Memory queue did not settle.")


def rests_on(http: httpx.Client, papers: dict[str, str]) -> dict[str, list[str]]:
    """
    Which library keys each Memory page rests on, so a key can say "builds on
    the feature-learning paper" without knowing what its pages will be called.
    """
    pages = http.get("/api/memory").json()["pages"]
    found: dict[str, list[str]] = {}
    for page in pages:
        detail = http.get(f"/api/memory/pages/{page['slug']}").json()["page"]
        named = [detail.get("sourcePaperId"), *(citation.get("paperId") for citation in detail.get("citations") or ())]
        found[page["slug"]] = sorted({key for key, paper_id in papers.items() if paper_id in named})
    return found


def adopt(args: argparse.Namespace) -> int:
    """
    Point the rig at an account a server already holds, in place of `stage`.

    For a library that cannot be imported through the routes (saved web pages)
    or whose Memory was built elsewhere (a staged rebuild candidate). The
    question file's `library` names each document by its stored `id`; each may
    sit in a project of its own. Nothing is written to the server.
    """
    out = Path(args.out)
    questions = load_questions(args.questions)
    unnamed = [entry["key"] for entry in questions["library"] if not entry.get("id")]
    if unnamed:
        raise SystemExit(f"To adopt, every library entry names its stored `id`; these do not: {', '.join(unnamed)}")
    if not os.environ.get(PASSWORD_VARIABLE):
        raise SystemExit(f"Set {PASSWORD_VARIABLE} to the password of {args.user}.")
    with client(args.base_url) as http:
        sign_in(http, create=False, user=args.user)
        projects: dict[str, str] = {}
        for listed in http.get("/api/projects").json():
            project = http.get(f"/api/projects/{listed['id']}").json()
            projects.update({paper["id"]: listed["id"] for paper in project.get("papers") or ()})
        missing = [entry["key"] for entry in questions["library"] if entry["id"] not in projects]
        if missing:
            raise SystemExit(f"{args.user} holds no document for: {', '.join(missing)}")
        papers = {entry["key"]: entry["id"] for entry in questions["library"]}
        staged = {
            "user": args.user, "projectId": None, "papers": papers,
            "projects": {key: projects[paper_id] for key, paper_id in papers.items()},
            "pages": rests_on(http, papers),
        }
    out.mkdir(parents=True, exist_ok=True)
    (out / "stage.json").write_text(json.dumps(staged, indent=2))
    print(f"adopted {len(papers)} documents and {len(staged['pages'])} Memory pages of {args.user} into {out / 'stage.json'}")
    return 0


def stage(args: argparse.Namespace) -> int:
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    questions = load_questions(args.questions)
    library = questions["library"]
    unfiled = [entry["key"] for entry in library if not entry.get("file")]
    if unfiled:
        raise SystemExit(f"These library entries name no `file` to import (adopt them instead): {', '.join(unfiled)}")
    directory = Path(args.library)
    missing = [entry["file"] for entry in library if not (directory / entry["file"]).is_file()]
    if missing:
        raise SystemExit(f"Not in {directory}: {', '.join(missing)}")
    with client(args.base_url) as http:
        sign_in(http, create=True)
        project = http.post("/api/projects", json={"name": questions["project"]})
        project.raise_for_status()
        project_id = project.json()["id"]
        papers: dict[str, str] = {}
        for entry in library:
            path = directory / entry["file"]
            with path.open("rb") as handle:
                added = http.post(
                    f"/api/projects/{project_id}/papers",
                    files={"file": (path.name, handle, mimetypes.guess_type(path.name)[0] or "application/pdf")},
                )
            added.raise_for_status()
            papers[entry["key"]] = added.json()["id"]
            print(f"  added {entry['file']} as {papers[entry['key']]}")
        deadline = time.monotonic() + args.filing_minutes * 60
        while True:
            drain(http)
            state = http.get("/api/memory/backfill/papers").json()["papers"]
            waiting = [paper["paperId"] for paper in state if not paper.get("filed")]
            if len(state) == len(library) and not waiting:
                break
            if time.monotonic() > deadline:
                raise SystemExit(f"Not filed in time: {waiting}")
            print(f"  filing: {len(waiting)} of {len(state)} documents still to file")
            time.sleep(10)
        for entry in library:
            if entry.get("finished"):
                done = http.post(
                    f"/api/projects/{project_id}/papers/{papers[entry['key']]}/done", json={"done": True}
                )
                done.raise_for_status()
        drain(http)
        staged = {"projectId": project_id, "papers": papers, "pages": rests_on(http, papers)}
    (out / "stage.json").write_text(json.dumps(staged, indent=2))
    print(f"staged {len(papers)} documents and {len(staged['pages'])} Memory pages into {out / 'stage.json'}")
    return 0


def ask(http: httpx.Client, body: dict[str, Any], maintenance: "Maintenance | None" = None) -> dict[str, Any]:
    """One real turn, as the reader would see it arrive."""
    started = time.monotonic()
    record: dict[str, Any] = {"answer": "", "firstTextMs": None, "error": None, "trace": None, "sources": [], "incomplete": None}
    if maintenance is not None:
        record["maintenance"] = {"atStart": maintenance.busy, "atFirstText": None}
    with http.stream("POST", "/api/chat/stream", json=body) as response:
        if response.status_code >= 400:
            response.read()
            record["error"] = f"{response.status_code}: {response.text[:400]}"
            return record
        for event in events(response):
            kind = event.get("type")
            if kind == "delta":
                if record["firstTextMs"] is None:
                    record["firstTextMs"] = round((time.monotonic() - started) * 1000)
                    if maintenance is not None:
                        record["maintenance"]["atFirstText"] = maintenance.busy
                record["answer"] += event.get("text") or ""
            elif kind == "error":
                record["error"] = event.get("message") or json.dumps(event)[:400]
            elif kind == "done":
                record["trace"] = event.get("trace")
                record["sources"] = event.get("sources") or []
                record["incomplete"] = event.get("incomplete")
    record["totalMs"] = round((time.monotonic() - started) * 1000)
    return record


def calls(trace: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    return [entry for stretch in trace or () for entry in stretch.get("entries") or () if entry.get("kind") == "tool"]


class Maintenance:
    """
    A second client that drains the Memory queue for as long as an arm runs.

    For the gate that chat does not slow down while a maintenance job runs:
    queue work first (a domain to compose, a page to rewrite), then `run
    --while-draining`. `busy` is true while a drain request holds a job, which
    its events say by carrying a `jobId`; each answer records whether a job
    was running when it was asked and when its first text arrived.
    """

    def __init__(self, base_url: str, user: str | None) -> None:
        self.base_url, self.user = base_url, user
        self.busy = False
        self.jobs = 0
        self.stopping = threading.Event()
        self.thread = threading.Thread(target=self._loop, daemon=True)

    def _loop(self) -> None:
        with client(self.base_url) as http:
            sign_in(http, create=False, user=self.user)
            while not self.stopping.is_set():
                held = False
                with http.stream("POST", "/api/memory/maintenance/drain") as response:
                    response.raise_for_status()
                    for event in events(response):
                        if event.get("jobId") and not held:
                            held, self.busy = True, True
                            self.jobs += 1
                self.busy = False
                if not held:
                    self.stopping.wait(2)

    def __enter__(self) -> "Maintenance":
        self.thread.start()
        return self

    def __exit__(self, *_: object) -> None:
        self.stopping.set()


def run(args: argparse.Namespace) -> int:
    out = Path(args.out)
    staged = json.loads((out / "stage.json").read_text())
    questions = load_questions(args.questions)["questions"]
    only = set(args.only or ())
    target = arm_file(out, args.arm)
    done = {json.loads(line)["id"] for line in target.read_text().splitlines()} if target.exists() else set()
    user = staged.get("user")
    maintenance = Maintenance(args.base_url, user) if args.while_draining else None
    with client(args.base_url) as http, target.open("a") as handle:
        sign_in(http, create=False, user=user)
        if maintenance is not None:
            maintenance.__enter__()
            # The first claim, so the first question already has a job beside it.
            for _ in range(30):
                if maintenance.busy:
                    break
                time.sleep(1)
        for question in questions:
            if question["id"] in done or (only and question["id"] not in only):
                continue
            general = question["scope"] == "general"
            where = {} if general else {
                "project_id": (staged.get("projects") or {}).get(question["open"]) or staged["projectId"],
                "paper_id": staged["papers"][question["open"]],
            }
            # Each question gets a conversation of its own, made the way the client
            # makes one. A document holds ten at most, so what an earlier
            # question left is removed first; its answer is already on file here.
            listed = http.get("/api/chat/conversations", params={"scope": question["scope"], **where})
            listed.raise_for_status()
            for earlier in listed.json()["items"]:
                http.delete("/api/chat", params={"scope": question["scope"], "conversation_id": earlier["id"], **where})
            made = http.post("/api/chat/conversations", json={"scope": question["scope"], "creation_key": uuid.uuid4().hex, **where})
            made.raise_for_status()
            conversation = made.json()
            body: dict[str, Any] = {
                "prompt": question["prompt"],
                "scope": question["scope"],
                "persona_id": "mentor",
                "conversation_id": conversation.get("id") or conversation["conversation"]["id"],
                **({"generation": conversation["generation"]} if "generation" in conversation else {}),
                **where,
                **({"model": args.model} if args.model else {}),
                **({"reasoning_effort": args.effort} if args.effort else {}),
                # The earlier commit requires the field this one refuses.
                **({"web_search": False} if args.legacy_body else {}),
            }
            record = ask(http, body, maintenance)
            tools = calls(record["trace"])
            record.update(
                id=question["id"], kind=question["class"], arm=args.arm,
                searched=any(call.get("tool") == "web_search" and call.get("ok") for call in tools),
                tools=[call.get("tool") for call in tools],
                links=sorted(set(LINK.findall(record["answer"]))),
            )
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
            handle.flush()
            beside = f"  job running: {record['maintenance']}" if maintenance is not None else ""
            print(f"  {question['id']:<5} {record.get('totalMs', 0) / 1000:6.1f}s  searched={record['searched']!s:<5} "
                  f"links={len(record['links'])}  {record['error'] or ''}{beside}")
    if maintenance is not None:
        maintenance.__exit__()
        print(f"  {maintenance.jobs} maintenance job(s) claimed while the arm ran")
    return 0


JUDGE_INSTRUCTIONS = """
You grade one answer from a reading assistant against a reviewed key. You are
given the question, the key's facts, and the answer. Decide, for each fact,
whether the answer states it (a paraphrase with the same numbers and the same
conditions counts; a number without the condition the key gives does not).
Then list every claim in the answer that contradicts the key or attributes to
the paper something the key says it does not report. Be literal. Do not reward
length or style.
""".strip()
JUDGE_FORMAT = {
    "type": "json_schema", "name": "benchmark_grade", "strict": True,
    "schema": {
        "type": "object", "additionalProperties": False, "required": ["facts", "errors"],
        "properties": {
            "facts": {"type": "array", "items": {"type": "boolean"}},
            "errors": {"type": "array", "items": {"type": "string"}},
        },
    },
}


def judge(args: argparse.Namespace) -> int:
    out = Path(args.out)
    settings = Settings()
    keys = {question["id"]: question for question in load_questions(args.questions)["questions"]}
    source = arm_file(out, args.arm)
    graded = arm_file(out, args.arm, graded=True)
    with httpx.Client(timeout=300) as http, graded.open("w") as handle:
        for line in source.read_text().splitlines():
            record = json.loads(line)
            key = keys[record["id"]]
            response = http.post(
                f"{settings.api_base_url.rstrip('/')}/responses",
                headers={"Authorization": f"Bearer {settings.api_key}"},
                json={
                    "model": args.model, "store": False, "instructions": JUDGE_INSTRUCTIONS,
                    "text": {"format": JUDGE_FORMAT},
                    "input": json.dumps({"question": key["prompt"], "facts": key["facts"], "answer": record["answer"]}, ensure_ascii=False),
                },
            )
            response.raise_for_status()
            text = "".join(
                block.get("text") or "" for item in response.json().get("output", ())
                for block in item.get("content") or () if block.get("type") == "output_text"
            )
            grade = json.loads(text)
            handle.write(json.dumps({"id": record["id"], **grade}) + "\n")
            print(f"  {record['id']:<5} {sum(grade['facts'])}/{len(key['facts'])} facts, {len(grade['errors'])} error(s)")
    return 0


def _lines(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def summarise(out: Path, questions: dict[str, Any]) -> dict[str, Any]:
    """
    Everything `report` prints, as data: per arm its counts, timing, grades and
    gates. `memory_eval` reads this for the answer-level metrics.

    Which gates an arm gets is decided by the question file: a question's class
    (or its own `search`) says whether a search was wanted, `links` and
    `builds_on` say what may and should be linked, and the file's `arms` entry
    says whether the arm is gated at all, whether web search was on in it, and
    which arm its time to first text is held against.
    """
    keys = {question["id"]: question for question in questions["questions"]}
    classes, thresholds = questions["classes"], questions["gates"]
    staged = json.loads((out / "stage.json").read_text(encoding="utf-8"))
    answers: dict[str, dict[str, dict[str, Any]]] = {}
    for path in sorted(out.glob("arm-*.jsonl")):
        name = path.name[len("arm-"):-len(".jsonl")]
        if ARM.fullmatch(name):  # which leaves out arm-<name>.graded.jsonl
            answers[name] = {record["id"]: record for record in _lines(path)}
    if not answers:
        raise SystemExit("No arm has been run.")
    strangers = sorted({qid for records in answers.values() for qid in records} - set(keys))
    if strangers:
        raise SystemExit(f"Answers to questions this file does not hold: {', '.join(strangers)}. Is --questions the file the arms were run with?")

    def wanted(qid: str) -> str | None:
        return keys[qid].get("search") or classes.get(keys[qid]["class"], {}).get("search")

    def first_text(records: dict[str, dict[str, Any]]) -> float | None:
        times = [record["firstTextMs"] for qid, record in records.items()
                 if classes.get(keys[qid]["class"], {}).get("timed") and record["firstTextMs"]]
        return statistics.median(times) if times else None

    timed = sorted(name for name, meaning in classes.items() if meaning.get("timed"))
    arms: dict[str, dict[str, Any]] = {}
    for name, records in answers.items():
        described = questions["arms"].get(name) or {}
        arm: dict[str, Any] = {
            "answers": len(records),
            "errored": sum(1 for record in records.values() if record["error"]),
            "cutOff": sum(1 for record in records.values() if record["incomplete"]),
            "firstTextMs": first_text(records),
            # Of the answers run `--while-draining`, how many had a job running both when asked and at first text.
            **({"beside": sum(1 for record in records.values() if (record.get("maintenance") or {}).get("atStart")
                              and record["maintenance"].get("atFirstText"))}
               if any("maintenance" in record for record in records.values()) else {}),
            "described": name in questions["arms"],
            "gated": described.get("gated", True),
            "web": bool(described.get("web")),
            "gates": [],
        }
        arms[name] = arm
        graded = arm_file(out, name, graded=True)
        if graded.exists():
            grades = [grade for grade in _lines(graded) if grade["id"] in keys]
            arm["judged"] = {
                "answers": len(grades),
                "facts": sum(len(keys[grade["id"]]["facts"]) for grade in grades),
                "stated": sum(sum(1 for fact in grade["facts"][: len(keys[grade["id"]]["facts"])] if fact) for grade in grades),
                "errors": sum(len(grade["errors"]) for grade in grades),
                "withErrors": sorted(grade["id"] for grade in grades if grade["errors"]),
            }
        if not arm["gated"]:
            continue

        def gate(label: str, ok: bool, detail: str, arm: dict[str, Any] = arm) -> None:
            arm["gates"].append({"label": label, "ok": ok, "detail": detail})

        # Connections: the one gate every arm gets, and it is mechanical.
        forced = [qid for qid, record in records.items() if keys[qid].get("links") == "none" and record["links"]]
        gate("no page linked where the key says there is no connection", not forced, ", ".join(forced) or "none linked")
        expected = [qid for qid in records if keys[qid].get("builds_on")]
        built = [qid for qid in expected
                 if any(keys[qid]["builds_on"] in staged["pages"].get(slug, ()) for slug in records[qid]["links"])]
        arm["builtOn"] = {"built": built, "expected": expected}
        if not arm["web"]:
            continue
        must_not = [qid for qid in records if wanted(qid) == "never"]
        wrongly = [qid for qid in must_not if records[qid]["searched"]]
        gate("searched on a must-not-search question", len(wrongly) <= thresholds["wrong_searches_allowed"],
             f"{len(wrongly)} of {len(must_not)} ({', '.join(wrongly) or 'none'})")
        must = [qid for qid in records if wanted(qid) == "always"]
        rightly = [qid for qid in must if records[qid]["searched"]]
        required = thresholds["right_searches_required"]
        gate("searched on a must-search question", len(rightly) >= (max(len(must) - 1, 0) if required is None else required),
             f"{len(rightly)} of {len(must)}")
        invented = {
            qid: sorted(set(WEB_LINK.findall(record["answer"])) - {source["url"] for source in record["sources"]})
            for qid, record in records.items()
        }
        invented = {qid: urls for qid, urls in invented.items() if urls}
        gate("every linked address is among the answer's sources", not invented, json.dumps(invented) if invented else "all are")
    for name, arm in arms.items():
        reference = (questions["arms"].get(name) or {}).get("against")
        if not arm["gated"] or reference not in arms:
            continue
        ours, theirs = arm["firstTextMs"], arms[reference]["firstTextMs"]
        if ours is None or theirs is None:
            continue
        arm["gates"].append({
            "label": f"time to first text on {', '.join(timed)}-settled questions",
            "ok": ours <= theirs * thresholds["first_text_ratio"],
            "detail": f"{ours / 1000:.1f}s against {theirs / 1000:.1f}s",
            "against": reference,
        })
    return {
        "questions": len(keys), "timedClasses": timed, "arms": arms,
        "failed": any(not gate["ok"] for arm in arms.values() for gate in arm["gates"]),
    }


def report(args: argparse.Namespace) -> int:
    out = Path(args.out)
    summary = summarise(out, load_questions(args.questions))
    timed = ", ".join(summary["timedClasses"])
    compared: list[dict[str, Any]] = []
    for name, arm in summary["arms"].items():
        print(f"\narm {name}: {arm['answers']} answers, {arm['errored']} errored, {arm['cutOff']} cut off")
        if arm["firstTextMs"] is not None:
            print(f"  median time to first text, {timed}-settled: {arm['firstTextMs'] / 1000:.1f}s")
        if "beside" in arm:
            print(f"  run beside the Memory queue: {arm['beside']} of {arm['answers']} answers had a job running when asked and at first text")
        if "judged" in arm:
            judged = arm["judged"]
            print(f"  judge (reported, not gated): {judged['stated']} of {judged['facts']} key facts stated, "
                  f"{judged['errors']} contradicting claim(s) in {len(judged['withErrors'])} of {judged['answers']} graded answers")
        for gate in arm["gates"]:
            if "against" in gate:
                compared.append(gate)
                continue
            print(f"  {'pass' if gate['ok'] else 'FAIL'}  {gate['label']}: {gate['detail']}")
            if gate["label"].startswith("no page linked"):
                print(f"  built on the expected page (reported, not gated): "
                      f"{len(arm['builtOn']['built'])} of {len(arm['builtOn']['expected'])}")
        if arm["gated"] and not arm["web"] and not arm["described"]:
            print("  web gates not applied: the question file does not describe this arm, so nothing says web search was on")
    for gate in compared:
        print(f"  {'pass' if gate['ok'] else 'FAIL'}  {gate['label']}: {gate['detail']}")
    (out / "report.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
    web = [name for name, arm in summary["arms"].items() if arm["gated"] and arm["web"]]
    read = [name for name, arm in summary["arms"].items() if arm["gated"]]
    whose = " and ".join(web or read)
    print(f"\nFor a person to read: every connection answer of arm {whose}, and twelve answers per arm against their keys "
          "(the judge's grades are in arm-*.graded.jsonl).")
    return 1 if summary["failed"] else 0


def parser() -> argparse.ArgumentParser:
    made = argparse.ArgumentParser(
        prog="python -m delphi_core.backfill.chat_benchmark",
        description=__doc__.split("\n\n")[0],
        epilog="An arm is a name of your choosing (old, new, none, new+web, A): its answers are kept in "
               "<out>/arm-<name>.jsonl, and the question file's `arms` entry for that name says which gates it gets.",
    )
    commands = made.add_subparsers(dest="command", required=True)
    told = {
        "stage": "build the library and its Memory through a running server's own routes",
        "adopt": f"use a library and Memory a server already holds, in place of stage (password in ${PASSWORD_VARIABLE})",
        "run": "ask every question of one arm's server and record the answers",
        "judge": "grade one arm's answers against the reviewed facts (the one command that calls a model)",
        "report": "decide the gates the question file sets, for every arm that has been run",
    }
    for name in ("stage", "adopt", "run", "judge", "report"):
        command = commands.add_parser(name, help=told[name], description=told[name])
        command.add_argument("--out", required=True, help="where this comparison's files are kept")
        command.add_argument("--questions", required=True, metavar="PATH",
                             help="the question file: its library, questions and reviewed facts")
        if name in {"stage", "adopt", "run"}:
            command.add_argument("--base-url", required=True)
        if name == "adopt":
            command.add_argument("--user", required=True, help="the account the server already holds")
        if name in {"run", "judge"}:
            command.add_argument("--arm", required=True, type=arm_name, metavar="NAME",
                                 help="the arm's name, for example old, new or none")
            command.add_argument("--model", default="" if name == "run" else None, required=name == "judge")
        if name == "stage":
            command.add_argument("--library", required=True, metavar="PATH",
                                 help="the directory holding the question file's `library` documents")
            command.add_argument("--filing-minutes", type=int, default=45)
        if name == "run":
            command.add_argument("--effort", default="")
            command.add_argument("--legacy-body", action="store_true")
            command.add_argument("--while-draining", action="store_true",
                                 help="drain the Memory queue from a second client while the arm runs (queue the work first)")
            command.add_argument("--only", action="append", help="one question id; repeat for more")
    return made


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    return {"stage": stage, "adopt": adopt, "run": run, "judge": judge, "report": report}[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
