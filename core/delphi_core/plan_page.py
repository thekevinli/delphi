"""What a research plan says, and the page it reads as.

A plan is a proposal a tech lead or advisor can read: a question, the runs that
answer it (Table 1, runs by settings), the method and setup that hold them
fixed, and how each outcome would be read. Runs and settings carry ids, so a
coding agent can be told "implement runs (1), (3) in setting (a)".

Beyond Table 1 the model may add up to three exhibits from `EXHIBIT_KINDS`, or
none. The prompt's guide and the schema come from the same classes, so a kind
the page cannot draw cannot be written. Every value is escaped; the page has no
script and no remote asset.
"""
from __future__ import annotations

import html
from typing import Annotated, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, model_validator

Prose = Annotated[str, Field(min_length=1, max_length=12000)]
Short = Annotated[str, Field(min_length=1, max_length=200)]


def text(limit: int):
    return Annotated[str, Field(min_length=1, max_length=limit)]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True, strict=True)


class Reference(Strict):
    sourceId: str = Field(min_length=1, max_length=64)
    location: Prose


class Passage(Strict):
    location: Prose
    excerpt: Prose


class Target(Strict):
    sourceId: str = Field(min_length=1, max_length=64)
    summary: Prose
    target: Prose
    pages: list[Annotated[int, Field(ge=1, le=2000)]] = Field(max_length=3)
    passages: list[Passage] = Field(max_length=8)


class Setting(Strict):
    id: str = Field(pattern=r"^[a-h]$")
    label: text(80)
    detail: str = Field(default="", max_length=160)


class Cell(Strict):
    setting: str = Field(pattern=r"^[a-h]$")
    reports: text(160)
    decisive: bool = False


class Run(Strict):
    id: str = Field(pattern=r"^\d{1,2}$")
    group: text(60)
    label: text(160)
    cells: list[Cell] = Field(max_length=8)


class Design(Strict):
    settings: list[Setting] = Field(min_length=1, max_length=6)
    runs: list[Run] = Field(min_length=1, max_length=16)
    caption: text(600)

    @model_validator(mode="after")
    def cells_name_settings(self):
        settings = [s.id for s in self.settings]
        if len(set(settings)) != len(settings) or len({r.id for r in self.runs}) != len(self.runs):
            raise ValueError("run and setting ids must be unique")
        for run in self.runs:
            named = [c.setting for c in run.cells]
            if len(set(named)) != len(named) or not set(named) <= set(settings):
                raise ValueError("each cell names one listed setting")
        if not any(c.decisive for r in self.runs for c in r.cells):
            raise ValueError("mark the cells the conclusion rests on as decisive")
        return self


class SetupRow(Strict):
    component: text(80)
    setting: Prose
    basis: Literal["source", "user", "proposed"]
    source: Reference | None = None

    @model_validator(mode="after")
    def source_settings_cite(self):
        if self.basis == "source" and self.source is None:
            raise ValueError("a source-reported setting cites its source")
        return self


class Reading(Strict):
    when: text(200)
    then: Prose


class WebSource(Strict):
    title: text(200)
    url: str = Field(pattern=r"^https://[^\s\"'<>]+$", max_length=500)
    note: str = Field(default="", max_length=300)


class TableExhibit(Strict):
    """Compare exact values or options across a few named attributes, when the reader will look values up."""
    kind: Literal["table"]
    title: text(120)
    caption: text(600)
    columns: list[text(60)] = Field(min_length=2, max_length=6)
    rows: list[list[Short]] = Field(min_length=1, max_length=12)

    @model_validator(mode="after")
    def rows_fill_columns(self):
        if any(len(row) != len(self.columns) for row in self.rows):
            raise ValueError("every row has one value per column")
        return self


class FlowStep(Strict):
    label: text(40)
    note: str = Field(default="", max_length=80)
    key: bool = False


class FlowExhibit(Strict):
    """Show what feeds what and what is held out, when the order or data path is the hard part to follow."""
    kind: Literal["flow"]
    title: text(120)
    caption: text(600)
    steps: list[FlowStep] = Field(min_length=2, max_length=7)


class Bar(Strict):
    label: text(60)
    value: float = Field(ge=0, le=1e9)
    basis: Literal["source", "computed"]
    detail: text(200)
    source: Reference | None = None

    @model_validator(mode="after")
    def source_values_cite(self):
        if self.basis == "source" and self.source is None:
            raise ValueError("a source-reported value cites its source")
        return self


class BarsExhibit(Strict):
    """Compare one quantity (time, memory, cost, data size) across runs or options, when relative size is the point."""
    kind: Literal["bars"]
    title: text(120)
    caption: text(600)
    unit: text(24)
    bars: list[Bar] = Field(min_length=2, max_length=10)


EXHIBIT_KINDS: tuple[type[Strict], ...] = (TableExhibit, FlowExhibit, BarsExhibit)
Exhibit = Annotated[Union[TableExhibit, FlowExhibit, BarsExhibit], Field(discriminator="kind")]


class ResearchPlan(Strict):
    version: Literal[4]
    title: str = Field(min_length=1, max_length=160)
    question: Prose
    scope: Prose
    design: Design
    method: Prose
    order: list[text(300)] = Field(min_length=1, max_length=8)
    pseudocode: str = Field(default="", max_length=12000)
    setup: list[SetupRow] = Field(max_length=20)
    readings: list[Reading] = Field(min_length=1, max_length=8)
    limits: Prose
    reference: list[Target] = Field(max_length=8)
    web: list[WebSource] = Field(default_factory=list, max_length=8)
    exhibits: list[Exhibit] = Field(default_factory=list, max_length=3)

    @model_validator(mode="after")
    def one_reference_per_document(self):
        if len({r.sourceId for r in self.reference}) != len(self.reference):
            raise ValueError("one reference entry per document")
        return self


def cited_sources(plan: dict) -> list[dict]:
    """Every source location the plan cites outside its reference entries: setup rows and bars."""
    bars = [b for e in plan.get("exhibits", []) if e["kind"] == "bars" for b in e["bars"]]
    return [item["source"] for item in plan["setup"] + bars if item.get("source")]


def number(value: float) -> str:
    """A bar's value as the macOS page writes it: ten significant digits, an exponent only below 1e-4."""
    return f"{value:.10g}"


def exhibit_guide() -> str:
    """How to choose an exhibit, one line per kind the page can draw."""
    kinds = "\n".join(f"- {kind.model_fields['kind'].annotation.__args__[0]}: {kind.__doc__}" for kind in EXHIBIT_KINDS)
    return ("Table 1 is drawn from design, the runs by settings, on every plan. Add an exhibit only when it shows "
            "something Table 1 and the prose cannot; most plans need none. Choose the kind by the question the reader "
            "will ask, never for variety: a chart of values the reader will look up is worse than a table, and a "
            "diagram of a sequence a numbered list states is clutter. Never draw results: every number is cited "
            "from a source or computed, with the location or formula in detail.\n" + kinds)


def render_plan(record, images=None, conversation=None):
    """The plan as a proposal: question, Table 1, method, setup, readings, limits and references."""
    p, esc = record["plan"], lambda value: html.escape(str(value))
    if p.get("version") != 4:
        raise ValueError("Unsupported plan version")
    documents = {d["id"]: d for d in record.get("documents", [])}
    order = list(dict.fromkeys([r["sourceId"] for r in p["reference"]] + [c["sourceId"] for c in cited_sources(p)] + list(documents)))
    def cite(reference):
        return f'<span class="ref">[{order.index(reference["sourceId"]) + 1}, {esc(reference["location"])}]</span>'
    def table(heads, rows, kind=""):
        head = "".join(f'<th scope="col">{h}</th>' for h in heads)
        return f'<table class="{kind}"><thead><tr>{head}</tr></thead><tbody>' + "".join(
            "<tr>" + "".join(f"<td>{c}</td>" for c in row) + "</tr>" for row in rows) + "</tbody></table>"
    def section(key, title, body):
        return f'<section id="{key}" aria-labelledby="{key}-title"><h2 id="{key}-title">{title}</h2>{body}</section>'
    numbers = {"table": 1, "figure": 0}
    def exhibit(item):
        family = "table" if item["kind"] == "table" else "figure"
        numbers[family] += 1
        caption = f'<figcaption><b>{family.title()} {numbers[family]}. {esc(item["title"])}.</b> {esc(item["caption"])}</figcaption>'
        if item["kind"] == "table":
            drawn = table([esc(c) for c in item["columns"]], [[esc(c) for c in row] for row in item["rows"]], "plain")
        elif item["kind"] == "flow":
            drawn = '<ol class="flow">' + "".join(
                f'<li class="{"key" if s.get("key") else ""}"><b>{esc(s["label"])}</b>{"<span>" + esc(s["note"]) + "</span>" if s.get("note") else ""}</li>'
                for s in item["steps"]) + "</ol>"
        else:
            top = max(b["value"] for b in item["bars"]) or 1
            drawn = '<div class="bars">' + "".join(
                f'<span>{esc(b["label"])}</span><span class="bar"><i style="width:{b["value"] / top * 100:.1f}%"></i>'
                f'<em>{number(b["value"])} {esc(item["unit"])}</em></span><small>{esc(b["basis"])}{" " + cite(b["source"]) if b.get("source") else ""}: {esc(b["detail"])}</small>'
                for b in item["bars"]) + "</div>"
        return f"<figure>{drawn}{caption}</figure>"

    design = p["design"]
    settings = [s["id"] for s in design["settings"]]
    heads = ["Run"] + [f'({esc(s["id"])}) {esc(s["label"])}<small>{esc(s["detail"])}</small>' for s in design["settings"]]
    rows, group = [], None
    for run in design["runs"]:
        if run["group"] != group:
            group = run["group"]
            rows.append(f'<tr class="group"><td colspan="{len(heads)}">{esc(group)}</td></tr>')
        cells = {c["setting"]: c for c in run["cells"]}
        rows.append(f'<tr><td><span class="run">({esc(run["id"])})</span> {esc(run["label"])}</td>' + "".join(
            f'<td class="decisive">{esc(cells[s]["reports"])}</td>' if s in cells and cells[s].get("decisive")
            else f"<td>{esc(cells[s]['reports'])}</td>" if s in cells else '<td class="none">·</td>'
            for s in settings) + "</tr>")
    head = "".join(f'<th scope="col">{h}</th>' for h in heads)
    matrix = (f'<table class="design"><thead><tr>{head}</tr></thead><tbody>{"".join(rows)}</tbody></table>'
              f'<p class="caption"><b>Table 1. Planned runs.</b> {esc(design["caption"])}</p>')
    # Numbered in reading order: a flow is drawn in Method, everything else in Design.
    others = [exhibit(e) for e in p.get("exhibits", []) if e["kind"] != "flow"]
    flows = [exhibit(e) for e in p.get("exhibits", []) if e["kind"] == "flow"]

    setup = table(["Component", "Setting", "Basis"], [
        [esc(s["component"]), esc(s["setting"]), esc(s["basis"]) + (" " + cite(s["source"]) if s.get("source") else "")]
        for s in p["setup"]], "setup") if p["setup"] else ""
    readings = table(["If", "Then"], [[esc(r["when"]), esc(r["then"])] for r in p["readings"]], "readings")
    targets = {r["sourceId"]: r for r in p["reference"]}
    shown = {(i["sourceId"], i["page"]): i for i in images or []}
    def source(source_id):
        document, target = documents.get(source_id, {}), targets.get(source_id)
        item = f'<b>{esc(document.get("title") or source_id)}</b>'
        if document.get("error"):
            item += f' <span class="muted">{esc(document["error"])}</span>'
        if target:
            item += f'<p>{esc(target["target"])}. {esc(target["summary"])}</p>' + "".join(
                f'<p class="quote">{esc(t["location"])}: “{esc(t["excerpt"])}”</p>' for t in target["passages"])
            for page in target["pages"]:
                image = shown.get((source_id, page))
                item += (f'<figure><img alt="Captured source page {page}" src="{esc(image.get("src") or "data:image/png;base64," + image["data"])}">'
                         f'<figcaption>Source page {page}, captured with this plan.</figcaption></figure>' if image
                         else f'<p class="muted">Page {page} could not be captured; read the source text instead.</p>')
        return f"<li>{item}</li>"
    references = "".join(source(i) for i in order) + "".join(
        f'<li><b><a href="{esc(w["url"])}" rel="noreferrer">{esc(w["title"])}</a></b> <span class="muted">Web page, not captured by Delphi.</span>'
        f'{"<p>" + esc(w["note"]) + "</p>" if w.get("note") else ""}</li>' for w in p.get("web", []))
    transcript = "" if conversation is None else (
        '<details class="conversation"><summary>Conversation captured with this plan</summary>' +
        ('<p class="muted">Truncated to its capture limit.</p>' if record.get("conversationTruncated") else "") +
        "".join(f'<p><b>{esc(m.get("role", "message").title())}</b><br>{esc(m.get("content", ""))}</p>' +
                (f'<p class="quote"><b>Selected passage</b><br>{esc(m["selectedText"])}</p>' if m.get("selectedText") else "")
                for m in conversation) +
        "</details>")

    decisive = next((s for s in settings if any(c["setting"] == s and c.get("decisive") for r in design["runs"] for c in r["cells"])), settings[0])
    runs = ", ".join(f'({r["id"]})' for r in design["runs"] if any(c["setting"] == decisive for c in r["cells"]))
    plan_id = esc(record["id"])
    handoff = (f'<details class="handoff"><summary>Hand off</summary><div class="handoff-panel">'
               f'<div><span class="label">1 · Connect Delphi once</span><p>Create read-only access in Delphi Settings → Plans, '
               f'or download the plan and its captured sources from the line under the title.</p></div>'
               f'<div><span class="label">2 · Point at runs from Table 1</span>'
               f'<pre>Use Delphi MCP plan {plan_id}. Implement runs {esc(runs)} in setting ({esc(decisive)}). '
               f'Hold Setup fixed and ask before changing it.</pre></div></div></details>')
    lead = documents.get(order[0], {}).get("title") if order else None
    byline = ((f'Research plan from {esc(lead)} [1]' if lead else "Research plan") + f' · revision {record.get("revision", 1)}' +
              (" · archived" if record.get("archived") else "") + f' · <a href="/api/plans/{plan_id}/export">Download plan and captured sources</a>')

    sections = [("question", "Question", f'<p>{esc(p["question"])}</p><p>{esc(p["scope"])}</p>'),
                ("design", "Design", matrix + "".join(others)),
                ("method", "Method", f'<p>{esc(p["method"])}</p>' + "".join(flows) + '<ol class="order">' +
                 "".join(f"<li>{esc(step)}</li>" for step in p["order"]) + "</ol>" +
                 (f'<details><summary>Pseudocode</summary><pre>{esc(p["pseudocode"])}</pre></details>' if p.get("pseudocode") else "")),
                ("setup", "Setup", setup),
                ("reading", "Reading the result", readings),
                ("limits", "Limits", f'<p>{esc(p["limits"])}</p>'),
                ("references", "References", f"<ol>{references}</ol>{transcript}" if references or transcript else "")]
    sections = [s for s in sections if s[2]]
    nav = "".join(f'<a href="#{key}">{title}</a>' for key, title, _ in sections)
    body = "".join(section(*s) for s in sections)
    return ('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">'
            f'<title>{esc(p["title"])} · Delphi</title><style>{PLAN_CSS}</style></head><body><div class="page">'
            f'<nav aria-label="Sections">{nav}</nav><main><header><div class="title"><h1>{esc(p["title"])}</h1>{handoff}</div>'
            f'<p class="byline">{byline}</p></header>{body}</main></div></body></html>')


# The same page the macOS shell renders for its own plans, in Delphi's palette.
PLAN_CSS = """:root{--ink:#241412;--text:#2e1f1c;--muted:#6e5953;--faint:#9a8581;--line:#e6e0dd;--hair:#eee8e5;--wash:#fbfaf9;--sand:#f4f1ef;--clay:#5a2620;--link:#a8423a;--dawn:#ee9d66;--dawn-soft:#fef1e6}
*{box-sizing:border-box}body{margin:0;background:#fff;color:var(--text);font:16px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.page{display:grid;grid-template-columns:160px minmax(0,780px);gap:72px;justify-content:center;padding:72px 40px 96px}
nav{position:sticky;top:72px;align-self:start;padding-top:96px;display:flex;flex-direction:column}
nav a{padding:5px 0;font-size:13px;color:var(--muted)}nav a:hover{color:var(--ink)}
main{min-width:0;display:flex;flex-direction:column;gap:52px}
header{display:flex;flex-direction:column;gap:16px}.title{display:flex;align-items:flex-start;gap:24px}
h1{margin:0;flex:1;color:var(--ink);font-size:38px;font-weight:650;line-height:1.15;letter-spacing:-.025em}
h2{margin:0 0 16px;color:var(--ink);font-size:21px;font-weight:650;letter-spacing:-.015em}
p{margin:0 0 14px;white-space:pre-wrap}.byline{margin:0;font-size:13px;color:var(--muted)}
a{color:var(--link);text-decoration:none}a:hover{color:var(--clay)}b{color:var(--ink);font-weight:650}
section{scroll-margin-top:24px}.muted{color:var(--faint);font-size:13px}.ref{font-size:.82em;font-weight:600;color:var(--link)}
.handoff{position:relative;flex-shrink:0;margin-top:6px}
.handoff summary{height:36px;padding:0 14px;display:flex;align-items:center;list-style:none;cursor:pointer;border:1px solid var(--line);border-radius:6px;font-size:13px;font-weight:600;color:var(--ink)}
.handoff summary::-webkit-details-marker{display:none}.handoff[open] summary{background:var(--ink);border-color:var(--ink);color:#fff}
.handoff-panel{position:absolute;right:0;top:44px;z-index:1;width:min(560px,86vw);padding:20px;background:#fff;border:1px solid var(--line);border-radius:10px;box-shadow:0 18px 48px rgba(36,20,18,.14);display:flex;flex-direction:column;gap:16px;font-size:13px;line-height:1.5}
.handoff-panel p{margin:6px 0 0;color:var(--muted)}.label{font-size:12px;font-weight:600;color:var(--muted)}
pre{margin:6px 0 0;padding:10px 12px;background:var(--sand);border:1px solid var(--line);border-radius:6px;font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink);white-space:pre-wrap;overflow-wrap:anywhere}
table{width:100%;border-collapse:collapse;font-size:13.5px;line-height:1.5;font-variant-numeric:tabular-nums}
th,td{padding:10px 12px;text-align:left;vertical-align:top;border-bottom:1px solid var(--hair);overflow-wrap:break-word}
thead th{font-size:12px;font-weight:600;color:var(--muted);border-bottom:1.5px solid var(--ink)}
.design th,.design td{text-align:center}.design th+th,.design td+td{box-shadow:inset 1px 0 0 var(--line)}
.design th:first-child,.design td:first-child{text-align:left}.design thead th{color:var(--ink);font-weight:700}
.design thead small{display:block;font-weight:400;color:var(--muted)}.run{font-weight:600;color:var(--ink)}
.design tr.group td{background:var(--wash);box-shadow:none;text-align:left;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
.design td.none{color:#c9bcb8}.design td.decisive{background:var(--dawn-soft);box-shadow:inset 0 0 0 1.5px var(--dawn)}
.setup td:first-child,.readings td:first-child{width:160px;font-weight:600;color:var(--ink)}.setup td:last-child{width:130px;color:var(--muted)}
figure{margin:28px 0 0}figure img{max-width:100%;border:1px solid var(--line);border-radius:6px}
figcaption,.caption{margin:12px 0 0;font-size:14px;line-height:1.55;color:#3a2925}
.flow{display:flex;flex-wrap:wrap;gap:8px;margin:0;padding:0;list-style:none}
.flow li{flex:1 1 120px;padding:10px 12px;border:1px solid #cfc5c2;border-radius:6px;font-size:12.5px;line-height:1.35;text-align:center}
.flow li b{display:block}.flow li span{color:var(--muted)}.flow li.key{background:var(--dawn-soft);border-color:var(--dawn)}
.bars{display:grid;grid-template-columns:minmax(0,160px) minmax(0,1fr) minmax(0,200px);gap:8px 14px;align-items:center;font-size:13px}
.bar{display:flex;align-items:center;gap:8px}.bar i{height:14px;min-width:2px;border-radius:2px;background:var(--clay)}.bar em{font-style:normal;color:var(--ink);white-space:nowrap}
.bars small{color:var(--muted);font-size:12px}
.order{margin:16px 0 0;padding-left:22px}.order li+li{margin-top:4px}
details summary{cursor:pointer;color:var(--muted);font-size:13px}details pre{margin-top:10px}
#references{padding-top:20px;border-top:1px solid var(--line)}#references h2{font-size:17px}
#references ol{margin:0;padding-left:22px;font-size:14px;line-height:1.6;color:#3a2925}#references li+li{margin-top:12px}
#references p{margin:4px 0 0}.quote{font-style:italic}.conversation{margin-top:24px}.conversation p{font-size:13px}
@media(max-width:900px){.page{grid-template-columns:1fr;gap:24px;padding:32px 20px 64px}nav{display:none}h1{font-size:30px}.design{display:block;overflow-x:auto}.bars{grid-template-columns:1fr}}
@media print{.handoff,nav{display:none}.page{display:block;padding:0}}"""
