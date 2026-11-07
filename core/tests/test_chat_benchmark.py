"""The chat rig's argument handling and its report, on synthetic answers.

Nothing here reaches a server or a provider: `report` reads files, and the
tests write them.
"""

import json

import pytest

from delphi_core.backfill import chat_benchmark
from delphi_core.backfill.chat_benchmark import arm_file, load_questions, parser, summarise


def answer(qid, kind, *, searched=False, links=(), first=1000, text="An answer.", sources=(), error=None):
    return {
        "id": qid, "kind": kind, "answer": text, "firstTextMs": first, "totalMs": first + 500, "error": error,
        "trace": None, "sources": list(sources), "incomplete": None, "searched": searched, "tools": [],
        "links": list(links),
    }


def write_arm(out, arm, records, *, grades=None):
    arm_file(out, arm).write_text("".join(json.dumps(record) + "\n" for record in records))
    if grades is not None:
        arm_file(out, arm, graded=True).write_text("".join(json.dumps(grade) + "\n" for grade in grades))


def small_file(tmp_path, **extra):
    """Six questions over two documents, in the shipped file's format."""
    body = {
        "library": [{"key": "first", "file": "first.pdf", "finished": True}, {"key": "second", "file": "second.pdf"}],
        "questions": [
            {"id": "d1", "class": "document", "scope": "document", "open": "first", "prompt": "?", "facts": ["a", "b"]},
            {"id": "m1", "class": "memory", "scope": "general", "prompt": "?", "facts": ["a"]},
            {"id": "o1", "class": "outside-fact", "scope": "document", "open": "first", "prompt": "?", "facts": ["a"]},
            {"id": "o2", "class": "outside-fact", "scope": "document", "open": "first", "prompt": "?", "facts": ["a"]},
            {"id": "c1", "class": "connection", "scope": "document", "open": "second", "prompt": "?", "facts": ["a"],
             "builds_on": "first"},
            {"id": "c2", "class": "connection", "scope": "document", "open": "second", "prompt": "?", "facts": ["a"],
             "links": "none"},
        ],
        **extra,
    }
    path = tmp_path / "questions.json"
    path.write_text(json.dumps(body))
    out = tmp_path / "bench"
    out.mkdir()
    (out / "stage.json").write_text(json.dumps({
        "projectId": "p", "papers": {"first": "1", "second": "2"},
        "pages": {"first-idea": ["first"], "second-idea": ["second"]},
    }))
    return path, out


def good_answers():
    return [
        answer("d1", "document", first=2000),
        answer("m1", "memory"),
        answer("o1", "outside-fact", searched=True, text="See [it](https://a.example/x).",
               sources=[{"url": "https://a.example/x"}]),
        answer("o2", "outside-fact", searched=True),
        answer("c1", "connection", links=["first-idea"]),
        answer("c2", "connection"),
    ]


# --- arguments -------------------------------------------------------------


@pytest.mark.parametrize("command", [["stage", "--base-url", "http://x", "--library", "/corpus"],
                                     ["adopt", "--base-url", "http://x", "--user", "u"],
                                     ["run", "--base-url", "http://x", "--arm", "new"],
                                     ["judge", "--arm", "new", "--model", "m"], ["report"]],
                         ids=["stage", "adopt", "run", "judge", "report"])
def test_every_command_is_told_its_question_file_and_none_is_assumed(command, capsys):
    """Core ships no question file: one is about a particular library, and the library's checkout keeps it."""
    with pytest.raises(SystemExit):
        parser().parse_args([*command, "--out", "o"])
    assert "--questions" in capsys.readouterr().err
    assert parser().parse_args([*command, "--out", "o", "--questions", "q.json"]).questions == "q.json"


def test_stage_is_told_where_the_library_is_and_none_is_assumed(capsys):
    """An installed core cannot know where a checkout keeps the documents a question file names."""
    with pytest.raises(SystemExit):
        parser().parse_args(["stage", "--base-url", "http://x", "--out", "o", "--questions", "q.json"])
    assert "--library" in capsys.readouterr().err


def test_questions_and_library_are_selectable():
    staged = parser().parse_args(
        ["stage", "--base-url", "http://x", "--out", "o", "--questions", "q.json", "--library", "/corpus"]
    )
    assert (staged.questions, staged.library) == ("q.json", "/corpus")
    for command in (["run", "--base-url", "http://x", "--arm", "new"], ["judge", "--arm", "new", "--model", "m"]):
        assert parser().parse_args([*command, "--out", "o", "--questions", "q.json"]).questions == "q.json"


@pytest.mark.parametrize("name", ["old", "new", "none", "new+web", "A", "B", "C", "run-2", "new_web"])
def test_an_arm_is_a_free_form_name_and_names_its_files(name, tmp_path):
    args = parser().parse_args(["run", "--base-url", "http://x", "--out", str(tmp_path), "--questions", "q.json", "--arm", name])
    assert args.arm == name
    assert arm_file(tmp_path, name).name == f"arm-{name}.jsonl"
    assert arm_file(tmp_path, name, graded=True).name == f"arm-{name}.graded.jsonl"


@pytest.mark.parametrize("name", ["", "new.graded", "../x", "a b", "-x", "x" * 41])
def test_an_arm_name_that_could_not_be_a_file_name_is_refused(name, capsys):
    with pytest.raises(SystemExit):
        parser().parse_args(["run", "--base-url", "http://x", "--out", "o", "--questions", "q.json", "--arm", name])
    assert "arm" in capsys.readouterr().err


def test_library_is_a_stage_option_only(capsys):
    with pytest.raises(SystemExit):
        parser().parse_args(["report", "--out", "o", "--questions", "q.json", "--library", "/corpus"])
    assert "--library" in capsys.readouterr().err


def test_stage_refuses_a_library_without_the_documents_before_asking_the_server(tmp_path, monkeypatch):
    path, out = small_file(tmp_path)
    monkeypatch.setattr(chat_benchmark, "client", lambda *_: pytest.fail("a server was contacted"))
    with pytest.raises(SystemExit, match="first.pdf, second.pdf"):
        chat_benchmark.main(["stage", "--base-url", "http://x", "--out", str(out), "--questions", str(path),
                             "--library", str(tmp_path / "nowhere")])


# --- the question file -----------------------------------------------------


def test_a_class_means_what_the_rig_says_unless_the_file_says_otherwise(tmp_path):
    path, _ = small_file(tmp_path, classes={"connection": {"search": "never"}, "memory": {"timed": True}})
    classes = load_questions(path)["classes"]
    assert classes["document"] == {"search": "never", "timed": True}
    assert classes["connection"] == {"search": "never"}
    assert classes["memory"] == {"search": "never", "timed": True}


def test_every_problem_in_a_question_file_is_named_at_once(tmp_path):
    path = tmp_path / "bad.json"
    path.write_text(json.dumps({
        "library": [{"key": "first", "file": "first.pdf"}],
        "arms": {"new": {"against": "old"}},
        "gates": {"pass_mark": 3},
        "questions": [
            {"id": "d1", "class": "document", "scope": "document", "open": "missing", "prompt": "?", "facts": ["a"]},
            {"id": "d1", "class": "document", "scope": "general", "prompt": "?", "facts": []},
            {"id": "c1", "class": "connection", "scope": "general", "prompt": "?", "facts": ["a"],
             "builds_on": "nothing", "links": "some"},
        ],
    }))
    with pytest.raises(SystemExit) as refused:
        load_questions(path)
    message = str(refused.value)
    for expected in ("`open` must name a library key", "used twice", "`facts` must list", "`builds_on` must name",
                     "`links` can only be", "`against` names an arm", "unknown thresholds: pass_mark"):
        assert expected in message


def test_a_file_that_is_not_json_is_refused_by_name(tmp_path):
    path = tmp_path / "broken.json"
    path.write_text("{")
    with pytest.raises(SystemExit, match="broken.json"):
        load_questions(path)


# --- report ----------------------------------------------------------------


def run_report(path, out, capsys):
    code = chat_benchmark.main(["report", "--out", str(out), "--questions", str(path)])
    return code, capsys.readouterr().out


def test_an_arm_the_file_does_not_describe_gets_the_connection_gate_alone(tmp_path, capsys):
    path, out = small_file(tmp_path)
    write_arm(out, "new", good_answers())
    code, printed = run_report(path, out, capsys)
    assert code == 0
    assert "arm new: 6 answers, 0 errored, 0 cut off" in printed
    assert "pass  no page linked where the key says there is no connection: none linked" in printed
    assert "built on the expected page (reported, not gated): 1 of 1" in printed
    assert "web gates not applied" in printed
    assert "must-search" not in printed


def test_a_page_linked_on_a_no_connection_question_fails_whatever_the_arm_is_called(tmp_path, capsys):
    path, out = small_file(tmp_path)
    answers = good_answers()
    answers[-1] = answer("c2", "connection", links=["first-idea"])
    for arm in ("old", "none", "B"):
        write_arm(out, arm, answers)
    code, printed = run_report(path, out, capsys)
    assert code == 1
    assert printed.count("FAIL  no page linked where the key says there is no connection: c2") == 3


def test_building_on_the_wrong_document_is_counted_and_not_gated(tmp_path, capsys):
    path, out = small_file(tmp_path)
    answers = good_answers()
    answers[4] = answer("c1", "connection", links=["second-idea", "never-staged"])
    write_arm(out, "new", answers)
    code, printed = run_report(path, out, capsys)
    assert code == 0 and "built on the expected page (reported, not gated): 0 of 1" in printed


def test_the_web_gates_follow_the_files_arms_and_classes_not_the_arms_letter(tmp_path, capsys):
    path, out = small_file(
        tmp_path,
        arms={"none": {"gated": False}, "new+web": {"web": True, "against": "none"}},
        gates={"wrong_searches_allowed": 0},
    )
    write_arm(out, "none", [answer("d1", "document", first=1000)])
    answers = good_answers()
    answers[0] = answer("d1", "document", searched=True, first=1300)   # must not search; 30% slower
    answers[3] = answer("o2", "outside-fact", searched=False,          # must search; and an address of its own
                        text="[here](https://made.example/up)")
    write_arm(out, "new+web", answers)
    code, printed = run_report(path, out, capsys)
    assert code == 1
    assert "arm none: 1 answers" in printed and "pass" not in printed.split("arm new+web")[0]
    assert "FAIL  searched on a must-not-search question: 1 of 2 (d1)" in printed
    # One of two must-search questions searched: all but one is the default bar.
    assert "pass  searched on a must-search question: 1 of 2" in printed
    assert 'FAIL  every linked address is among the answer\'s sources: {"o2": ["https://made.example/up"]}' in printed
    assert "FAIL  time to first text on document-settled questions: 1.3s against 1.0s" in printed
    assert "every connection answer of arm new+web" in printed
    summary = json.loads((out / "report.json").read_text())
    assert summary["failed"] and summary["arms"]["none"]["gates"] == []
    assert [gate["ok"] for gate in summary["arms"]["new+web"]["gates"]] == [True, False, True, False, False]


def test_a_questions_own_search_field_overrides_its_class(tmp_path):
    path, out = small_file(tmp_path, arms={"new": {"web": True}})
    data = json.loads(path.read_text())
    data["questions"][4]["search"] = "always"      # c1: a connection question, ungated by class
    path.write_text(json.dumps(data))
    write_arm(out, "new", good_answers())
    gates = {gate["label"]: gate for gate in summarise(out, load_questions(path))["arms"]["new"]["gates"]}
    assert gates["searched on a must-search question"]["detail"] == "2 of 3"


def test_the_judges_grades_are_reported_beside_the_gates_and_gate_nothing(tmp_path, capsys):
    path, out = small_file(tmp_path)
    write_arm(out, "new", good_answers(), grades=[
        {"id": "d1", "facts": [True, False], "errors": ["says 12 where the key says 21"]},
        {"id": "m1", "facts": [True], "errors": []},
        {"id": "c1", "facts": [False], "errors": []},
    ])
    code, printed = run_report(path, out, capsys)
    assert code == 0
    assert "judge (reported, not gated): 2 of 4 key facts stated, 1 contradicting claim(s) in 1 of 3 graded answers" in printed
    judged = json.loads((out / "report.json").read_text())["arms"]["new"]["judged"]
    assert judged == {"answers": 3, "facts": 4, "stated": 2, "errors": 1, "withErrors": ["d1"]}
    # The graded file is not mistaken for an arm of its own.
    assert list(summarise(out, load_questions(path))["arms"]) == ["new"]


def test_answers_to_another_files_questions_are_refused(tmp_path):
    path, out = small_file(tmp_path)
    write_arm(out, "new", [answer("zz", "document")])
    with pytest.raises(SystemExit, match="zz"):
        summarise(out, load_questions(path))


def test_no_arm_run_is_said_so(tmp_path):
    path, out = small_file(tmp_path)
    with pytest.raises(SystemExit, match="No arm has been run"):
        summarise(out, load_questions(path))


# --- an account the server already holds -----------------------------------


def adopted_file(tmp_path):
    path = tmp_path / "corpus.json"
    path.write_text(json.dumps({
        "library": [{"key": "rope", "id": "aaa111"}, {"key": "muon", "id": "bbb222"}],
        "questions": [
            {"id": "d1", "class": "document", "scope": "document", "open": "rope", "prompt": "?", "facts": ["a"]},
            {"id": "d2", "class": "document", "scope": "document", "open": "muon", "prompt": "?", "facts": ["a"]},
        ],
        "arms": {"idle": {"gated": False}, "busy": {"against": "idle"}},
        "gates": {"first_text_ratio": 1.10},
    }))
    return path


def fake_server(seen):
    """Two projects, one document each, one Memory page citing the second; chat answers with one delta."""
    import httpx

    def handle(request):
        path = request.url.path
        seen.append((request.method, path, request.content.decode() if request.content else ""))
        if path == "/api/auth/login":
            body = json.loads(request.content)
            ok = body == {"username": "corpus", "password": "from-the-environment"}
            return httpx.Response(200 if ok else 401, json={})
        if path == "/api/projects":
            return httpx.Response(200, json=[{"id": "p1"}, {"id": "p2"}])
        if path.startswith("/api/projects/"):
            paper = {"p1": "aaa111", "p2": "bbb222"}[path.rsplit("/", 1)[1]]
            return httpx.Response(200, json={"papers": [{"id": paper}]})
        if path == "/api/memory":
            return httpx.Response(200, json={"pages": [{"slug": "muon"}]})
        if path == "/api/memory/pages/muon":
            return httpx.Response(200, json={"page": {"sourcePaperId": None, "citations": [{"paperId": "bbb222"}]}})
        if path == "/api/chat/conversations" and request.method == "GET":
            return httpx.Response(200, json={"items": []})
        if path == "/api/chat/conversations":
            return httpx.Response(200, json={"id": "c" * 32})
        if path == "/api/chat/stream":
            return httpx.Response(200, text='data: {"type": "delta", "text": "An answer."}\n\ndata: {"type": "done"}\n\n')
        return httpx.Response(404)

    return lambda base_url: httpx.Client(base_url=base_url, transport=httpx.MockTransport(handle))


def test_a_library_entry_may_name_a_stored_document_and_then_cannot_be_staged(tmp_path, monkeypatch):
    path = adopted_file(tmp_path)
    assert [entry["id"] for entry in load_questions(path)["library"]] == ["aaa111", "bbb222"]
    monkeypatch.setattr(chat_benchmark, "client", lambda *_: pytest.fail("a server was contacted"))
    with pytest.raises(SystemExit, match="adopt them instead"):
        chat_benchmark.main(["stage", "--base-url", "http://x", "--out", str(tmp_path / "o"), "--questions", str(path),
                             "--library", str(tmp_path)])


def test_adopt_needs_the_password_in_the_environment(tmp_path, monkeypatch):
    monkeypatch.delenv(chat_benchmark.PASSWORD_VARIABLE, raising=False)
    monkeypatch.setattr(chat_benchmark, "client", lambda *_: pytest.fail("a server was contacted"))
    with pytest.raises(SystemExit, match="CHAT_BENCHMARK_PASSWORD"):
        chat_benchmark.main(["adopt", "--base-url", "http://x", "--user", "corpus", "--out", str(tmp_path / "o"),
                             "--questions", str(adopted_file(tmp_path))])


def test_adopt_finds_each_documents_project_and_run_asks_in_it_as_that_account(tmp_path, monkeypatch):
    seen = []
    monkeypatch.setenv(chat_benchmark.PASSWORD_VARIABLE, "from-the-environment")
    monkeypatch.setattr(chat_benchmark, "client", fake_server(seen))
    path, out = adopted_file(tmp_path), tmp_path / "bench"
    assert chat_benchmark.main(["adopt", "--base-url", "http://x", "--user", "corpus", "--out", str(out), "--questions", str(path)]) == 0
    staged = json.loads((out / "stage.json").read_text())
    assert staged == {"user": "corpus", "projectId": None, "papers": {"rope": "aaa111", "muon": "bbb222"},
                      "projects": {"rope": "p1", "muon": "p2"}, "pages": {"muon": ["muon"]}}
    assert not any(method != "GET" and path != "/api/auth/login" for method, path, _ in seen)

    seen.clear()
    assert chat_benchmark.main(["run", "--base-url", "http://x", "--arm", "idle", "--out", str(out), "--questions", str(path)]) == 0
    asked = [json.loads(body) for method, where, body in seen if where == "/api/chat/stream"]
    assert [(body["project_id"], body["paper_id"]) for body in asked] == [("p1", "aaa111"), ("p2", "bbb222")]
    records = [json.loads(line) for line in arm_file(out, "idle").read_text().splitlines()]
    assert [record["answer"] for record in records] == ["An answer.", "An answer."]
    assert all("maintenance" not in record for record in records)


def test_an_arm_run_beside_maintenance_says_how_many_answers_had_a_job_running(tmp_path, capsys):
    path = adopted_file(tmp_path)
    out = tmp_path / "bench"
    out.mkdir()
    (out / "stage.json").write_text(json.dumps({"user": "corpus", "projectId": None, "papers": {}, "pages": {}}))
    write_arm(out, "idle", [answer("d1", "document", first=10_000), answer("d2", "document", first=10_000)])
    busy = [answer("d1", "document", first=10_500), answer("d2", "document", first=12_000)]
    busy[0]["maintenance"] = {"atStart": True, "atFirstText": True}
    busy[1]["maintenance"] = {"atStart": True, "atFirstText": False}
    write_arm(out, "busy", busy)
    code, printed = run_report(path, out, capsys)
    assert code == 1
    assert "run beside the Memory queue: 1 of 2 answers had a job running when asked and at first text" in printed
    assert "FAIL  time to first text on document-settled questions: 11.2s against 10.0s" in printed
