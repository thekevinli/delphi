"""
The checks on a Memory edit that need neither storage nor a model.

A write tool runs these on every call, so the agent that sent an edit meets a
refusal while it can still act on it. Each check returns its refusals as
sentences, one for each thing that is wrong, written for that agent. An empty
list is a pass. Nothing here raises for what a model sent.

- `preservation_problems(body, changes)`: detail may not vanish quietly. An
  existing citation marker or `[[link]]` may disappear only inside a `replace`
  or `delete` that states a reason from `REASONS`; `superseded` and
  `contradicted` also name the evidence; `moved` is believed only when another
  operation of the same edit inserts the text; a `delete` always states one;
  a `replace` or `replace_text` that states none may add words around the
  page's text but not reword it (`REWORDING_ALLOWANCE`); and one edit may not
  remove more than a quarter of a body, or 1,000 characters where a quarter
  is less than that. `changes` is what
  `ops.apply_operations` recorded, one for each operation, read by attribute
  (`ChangeMade`) so that this module does not import that one. Removal is
  counted for each operation as the characters it took out beyond those it
  put in, so text added elsewhere does not pay for text deleted here.
- `repair_links(body, known)`: every `[[slug]]` resolves, or becomes its
  words. Returns the body and the slugs repaired. A tool that would sooner
  refuse than repair has the list to say so with.
- `calculation_problems(calculations)`: a number Delphi derived is recomputed
  from its stated inputs by `evaluate`, which reads arithmetic and nothing
  else. Units are carried, not checked.
- `shape_problems(body, limits)`: length, URLs, and LaTeX.

Code is left alone by the link repair and the URL rule: `m[[0]]` in a fenced
block is an index, and rewriting it as words would corrupt the example.
"""

from __future__ import annotations

import ast
import math
import operator
import re
from collections.abc import Collection, Iterator, Mapping, Sequence
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Any, Protocol

from ..storage.base import memory_slug

#: The reason that says the text is still on the page, somewhere else. It is
#: the one reason that can be checked here, so it is.
MOVED = "moved"
#: The reader deleted the note the text rested on, so it is no longer evidence.
WITHDRAWN = "withdrawn"
#: There is no reason for shortening or rewording what a page says: text a page
#: keeps keeps its words, so that what a reader saw there is still there.
REASONS = ("superseded", "contradicted", "duplicate", "off-topic", MOVED, WITHDRAWN)
#: A reason that claims something about a source, and so has to name it.
REASONS_NEEDING_EVIDENCE = {"superseded": "supersedes", "contradicted": "contradicts"}
#: The share of a body one edit may remove.
REMOVAL_MAX = 0.25
#: What one edit may always remove, whatever the share. A quarter of a short
#: page is less than one of its paragraphs, and a rule that refuses deleting
#: one duplicate paragraph teaches the author to leave it there. So the share
#: is the limit only on a page of more than four times this.
REMOVAL_FLOOR_CHARS = 1_000
#: The words of a page's text that an operation with no reason may change.
#: Adding a clause turns "X." into "X," and joining two sentences drops a
#: capital; more than a few is a rewording.
REWORDING_ALLOWANCE = 3
#: How far a stated result may be from the recomputed one.
RESULT_TOLERANCE = 0.01
EXPRESSION_MAX_CHARS = 300

_MARKER = re.compile(r"\[E\d+\]")
# `storage.base.WIKI_LINK`, with the label captured: the repair needs the
# author's words, and the graph only ever needed the target.
_LINK = re.compile(r"\[\[([^\[\]|]{1,120})(?:\|([^\[\]]{0,120}))?\]\]")
_CODE = re.compile(r"(?ms)^ {0,3}(`{3,}|~{3,}).*?(?:^ {0,3}\1[`~]*[ \t]*\r?$|\Z)|`[^`\n]+`")
_URL = re.compile(r"(?i)\b(?:https?://|www\.)[^\s<>()\[\]]+")


class ChangeMade(Protocol):
    """What one operation did, as `ops.Change` records it."""

    op: str
    blocks: tuple[str, ...]
    before: str
    after: str
    reason: str | None
    evidence: tuple[str, ...]


@dataclass(frozen=True)
class BodyLimits:
    """
    `target` is what the author is told. `accept` is what is taken, and its
    role stays unstated: a refusal names the target. A body at `wall`, the
    most the schema can carry, was cut off there and is never trimmed to fit.
    """

    target: int
    accept: int
    wall: int


CONCEPT_LIMITS = BodyLimits(target=8_000, accept=12_000, wall=16_000)
#: A domain's page says in a sentence or two how each member page connects, so
#: it grows with its domain: scaling-laws reached 8,726 characters at 19 pages,
#: and the next page could not join, since the composer may not shorten what the
#: page says. Twice the room lasts a domain about twice that size.
DOMAIN_LIMITS = BodyLimits(target=12_000, accept=18_000, wall=24_000)


def _prose(body: str) -> Iterator[tuple[str, bool]]:
    """The body in order, as (text, whether it is prose and not code)."""
    cursor = 0
    for code in _CODE.finditer(body):
        yield body[cursor : code.start()], True
        yield code.group(0), False
        cursor = code.end()
    yield body[cursor:], True


def _carried(text: str) -> set[str]:
    """The citation markers and links a piece of text holds."""
    links = {f"[[{slug}]]" for found in _LINK.finditer(text) if (slug := memory_slug(found.group(1)))}
    return set(_MARKER.findall(text)) | links


def preservation_problems(
    body: str,
    changes: Sequence[ChangeMade],
    *,
    evidence: Collection[str] | None = None,
    removal_max: float = REMOVAL_MAX,
    removal_floor: int = REMOVAL_FLOOR_CHARS,
    keep_words: bool = True,
) -> list[str]:
    """
    `body` is the page before the edit. `evidence`, when given, is every id an
    operation may name as its evidence: the edit's new references and the
    page's own markers, as `N2` and `E3`. `keep_words` holds the page's words
    as well as its detail: a concept page's. A domain page is an orientation
    its composer rewrites as the domain changes, and keeps only its detail.
    """
    problems: list[str] = []
    removed = 0
    for number, change in enumerate(changes, start=1):
        where = f"Operation {number} ({change.op}) on {', '.join(change.blocks)}"
        if change.op in {"replace", "delete"} and change.reason == MOVED:
            # Text that moved is neither removed nor lost, if it did move.
            elsewhere = _squashed("\n".join(other.after for other in changes if other is not change))
            if _squashed(change.before) not in elsewhere:
                problems.append(
                    f"{where} says the text was moved, and no other operation of this edit inserts "
                    "it unchanged; insert the same text where it belongs, or give another reason."
                )
            continue
        removed += max(0, len(change.before) - len(change.after))
        lost = ", ".join(sorted(_carried(change.before) - _carried(change.after)))
        if change.op not in {"replace", "delete"}:
            if lost:
                problems.append(
                    f"{where} removes {lost}; only a replace or a delete may remove a citation "
                    "or a link, and it must state a `reason`."
                )
            elif keep_words and change.op == "replace_text" and (problem := _reworded(change)):
                problems.append(f"{where} {problem}")
        elif change.reason is None and (lost or change.op == "delete"):
            what = f"removes {lost} and" if lost else "removes text and"
            problems.append(
                f"{where} {what} states no `reason`; keep what is there, or give one of "
                f"{', '.join(REASONS)}."
            )
        elif change.reason is None:
            if keep_words and (problem := _reworded(change)):
                problems.append(f"{where} {problem}")
        else:
            if problem := _reason_problem(change, evidence):
                problems.append(f"{where} {problem}")
    allowed = max(int(removal_max * len(body)), removal_floor)
    if body.strip() and removed > allowed:
        problems.append(
            f"The edit removes {removed:,} of the page's {len(body):,} characters; one edit may "
            f"remove at most {allowed:,} of them ({removal_max:.0%}, and never less than "
            f"{removal_floor:,}). Keep more of what the page says."
        )
    return problems


def _squashed(text: str) -> str:
    """Text with its whitespace collapsed: a moved block may be re-wrapped, not reworded."""
    return " ".join(text.split())


def _reworded(change: ChangeMade) -> str | None:
    """Why an operation with no reason changes more of the page's words than adding to them would."""
    old, new = change.before.split(), change.after.split()
    matcher = SequenceMatcher(None, old, new, autojunk=False)
    dropped = [word for tag, start, end, _, _ in matcher.get_opcodes() if tag in {"replace", "delete"} for word in old[start:end]]
    if len(dropped) <= REWORDING_ALLOWANCE:
        return None
    shown = " ".join(dropped[:8]) + (" …" if len(dropped) > 8 else "")
    return (
        f"changes {len(dropped)} words of the page's text ({shown!r}) and states no `reason`. Text a page "
        "keeps keeps its words: add yours around it, or, where the evidence supersedes, contradicts or "
        "repeats it, use `replace` with that reason."
    )


def _reason_problem(change: ChangeMade, evidence: Collection[str] | None) -> str | None:
    if change.reason not in REASONS:
        return f"gives the reason {change.reason!r}; a reason is one of {', '.join(REASONS)}."
    verb = REASONS_NEEDING_EVIDENCE.get(change.reason)
    if verb and not change.evidence:
        return (
            f"says the text is {change.reason} and names no evidence; list in `evidence` the "
            f"citation that {verb} it, such as N1."
        )
    unknown = [item for item in change.evidence if evidence is not None and item not in evidence]
    if unknown:
        return (
            f"names {', '.join(unknown)} as evidence, which is neither a citation this edit "
            "defines nor one the page has."
        )
    return None


def repair_links(
    body: str, known: Collection[str], titles: Mapping[str, str] | None = None
) -> tuple[str, list[str]]:
    """
    Turn each `[[slug]]` with no page behind it into plain words.

    `known` is every slug that exists, with those being created in the same
    commit. The words are what the author wrote, label or name, and for a bare
    slug the slug with its hyphens as spaces. The frontends draw a link with
    no page the same way (`wikiLinkText` in `frontend/app/lib/memory.ts`),
    except that they lower-case a name written with capitals; a stored body
    keeps the author's spelling, because the repair cannot be undone.

    `titles` is for a page that existed and was deleted: a link to it written
    without a label becomes the title it had, where the slug's words would be
    a worse name for it. A label the author wrote still wins.
    """
    repaired: list[str] = []

    def words(link: re.Match[str]) -> str:
        slug = memory_slug(link.group(1))
        if not slug or slug in known:
            return link.group(0)
        if slug not in repaired:
            repaired.append(slug)
        if titles and slug in titles and not (link.group(2) or "").strip():
            return titles[slug]
        label = (link.group(2) or link.group(1)).strip()
        return label if label and label != slug else slug.replace("-", " ")

    return "".join(_LINK.sub(words, text) if prose else text for text, prose in _prose(body)), repaired


class _NotArithmetic(Exception):
    pass


_BINARY = {
    ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
    ast.Div: operator.truediv, ast.Pow: operator.pow,
}
_REFUSED_SYNTAX = {ast.Call: "a function call", ast.Attribute: "an attribute lookup", ast.Subscript: "an index"}


def _value(node: ast.AST, inputs: Mapping[str, float]) -> float:
    # A whitelist over the parsed tree, and floats throughout: nothing is ever
    # executed, a name can only be an input, and `9 ** 9 ** 9` overflows at
    # once where integer arithmetic would compute for minutes.
    if isinstance(node, ast.Constant) and type(node.value) in (int, float):
        return float(node.value)
    if isinstance(node, ast.Name):
        if node.id not in inputs:
            raise _NotArithmetic(
                f"uses `{node.id}`, which is not among its inputs; give every quantity it "
                "uses in `inputs`, with its value, unit and citation"
            )
        return float(inputs[node.id])
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)):
        operand = _value(node.operand, inputs)
        return -operand if isinstance(node.op, ast.USub) else operand
    if isinstance(node, ast.BinOp) and type(node.op) in _BINARY:
        result = _BINARY[type(node.op)](_value(node.left, inputs), _value(node.right, inputs))
        if isinstance(result, complex):
            raise _NotArithmetic("takes a fractional power of a negative number")
        return result
    found = _REFUSED_SYNTAX.get(type(node), f"`{ast.unparse(node)}`")
    raise _NotArithmetic(
        f"contains {found}; an expression is numbers, its named inputs, + - * / ** and parentheses"
    )


def evaluate(expression: str, inputs: Mapping[str, float]) -> tuple[float | None, str | None]:
    """The value of an arithmetic expression, or why it has none. Never `eval`."""
    if not isinstance(expression, str) or not expression.strip() or len(expression) > EXPRESSION_MAX_CHARS:
        return None, f"needs an expression of at most {EXPRESSION_MAX_CHARS} characters"
    try:
        value = _value(ast.parse(expression.strip(), mode="eval").body, inputs)
    except _NotArithmetic as refused:
        return None, str(refused)
    except ZeroDivisionError:
        return None, "divides by zero with the inputs given"
    except (OverflowError, SyntaxError, ValueError, RecursionError, MemoryError):
        return None, "cannot be read as arithmetic that has a value"
    if not math.isfinite(value):
        return None, "cannot be read as arithmetic that has a value"
    return value, None


def _number(value: Any) -> bool:
    return type(value) in (int, float) and math.isfinite(value)


def calculation_problems(
    calculations: Sequence[Mapping[str, Any]],
    *,
    citations: Collection[str] | None = None,
    tolerance: float = RESULT_TOLERANCE,
) -> list[str]:
    """
    Recompute each derived number. An entry is `expression`, `inputs`,
    `result` and `unit`; `inputs` is a list of `name`, `value`, `unit` and
    `citation`, or a mapping from name to the other three. `citations`, when
    given, is every reference an input may cite (`N1`, `E3`).
    """
    problems: list[str] = []
    for number, entry in enumerate(calculations, start=1):
        expression, given = entry.get("expression"), entry.get("inputs") or ()
        where = f"Calculation {number} (`{expression}`)"
        rows = [{"name": name, **row} for name, row in given.items()] if isinstance(given, Mapping) else list(given)
        values: dict[str, float] = {}
        before = len(problems)
        for row in rows:
            name, cited = row.get("name"), row.get("citation")
            if not isinstance(name, str) or not name.isidentifier():
                problems.append(f"{where} has an input named {name!r}; name an input as one word, such as d_model.")
            elif not _number(row.get("value")):
                problems.append(f"{where}: input `{name}` has no numeric value.")
            elif not isinstance(cited, str) or not cited.strip():
                problems.append(f"{where}: input `{name}` has no citation; say where the number comes from.")
            elif citations is not None and cited not in citations:
                problems.append(f"{where}: input `{name}` cites {cited}, which is not a citation of this page or this edit.")
            else:
                values[name] = row["value"]
        if len(problems) > before:
            continue
        value, problem = evaluate(expression, values)
        stated = entry.get("result")
        if problem:
            problems.append(f"{where} {problem}.")
        elif not _number(stated):
            problems.append(f"{where} states no numeric result.")
        elif abs(value - stated) > tolerance * abs(value):
            problems.append(
                f"{where} comes to {value:.6g} with the inputs given, and the result stated is "
                f"{stated:.6g}; correct the result, the expression or the inputs."
            )
    return problems


# `malformed_math_in_body` and its patterns, copied from `research_digest.py`
# so that a page is held to exactly the rule a digest is. Copied, not
# imported: that module imports the harness, and the harness's write tools
# import this one.
_GREEK_MATH_NAMES = (
    "alpha|beta|gamma|delta|epsilon|varepsilon|zeta|eta|theta|vartheta|iota|"
    "kappa|lambda|mu|nu|xi|rho|varrho|sigma|varsigma|tau|upsilon|phi|varphi|"
    "chi|psi|omega|Gamma|Delta|Theta|Lambda|Xi|Pi|Sigma|Upsilon|Phi|Psi|Omega"
)
_MATH_SPAN = re.compile(r"\$\$.+?\$\$|\$[^$\n]+?\$|\\\(.+?\\\)", re.S)
_LITERAL_TEXT = re.compile(r"\\(?:text|mathrm|mathit|operatorname|textrm)\{[^}]*\}")
_BARE_GREEK = re.compile(r"(?<![\\A-Za-z])(?:" + _GREEK_MATH_NAMES + r"|pi)(?![A-Za-z])")
_STRAY_NEWLINE_ESCAPE = re.compile(r"\\n(?![A-Za-z])")
_ODD_DOLLAR_LINE = re.compile(r"(?<!\$)\$(?!\$)")
_LOOKS_LIKE_MATH = re.compile(r"[\\^_=]|\\[A-Za-z]+")


def malformed_math_in_body(body: str) -> list[str]:
    """Return visible LaTeX defects that can be established from Markdown."""
    problems: list[str] = []
    for span in _MATH_SPAN.findall(body):
        cleaned = _LITERAL_TEXT.sub("", span)
        for name in _BARE_GREEK.findall(cleaned):
            if name not in problems:
                problems.append(name)
        if _STRAY_NEWLINE_ESCAPE.search(span) and "stray \\n" not in problems:
            problems.append("stray \\n")
    for line in body.split("\n"):
        if len(_ODD_DOLLAR_LINE.findall(line)) % 2 == 0:
            continue
        stripped = line.rstrip()
        tail = stripped.rsplit("$", 1)[-1]
        if stripped.endswith("$") or _LOOKS_LIKE_MATH.search(tail):
            problems.append("unclosed $")
            break
    return problems


def shape_problems(body: str, limits: BodyLimits) -> list[str]:
    """Length, URLs and LaTeX of a body as it would be stored."""
    problems: list[str] = []
    if not body.strip():
        problems.append("The page body is empty.")
    elif len(body) >= limits.wall:
        problems.append(
            f"The page body is {len(body):,} characters, the most that can be sent, so its end was "
            f"probably cut off. A page is about {limits.target:,} characters; write a shorter one."
        )
    elif len(body) > limits.accept:
        problems.append(
            f"The page body would be {len(body):,} characters, and a page is about {limits.target:,}. "
            "Add less, and never shorten what the page already says to make room: what does not fit "
            "belongs on the page for the narrower idea it is about, linked from this one."
        )
    urls = [found for text, prose in _prose(body) if prose for found in _URL.findall(text)]
    if urls:
        problems.append(
            f"The body contains a URL ({urls[0][:80]}); a page names its sources through "
            "citations, never an address. Remove it."
        )
    defects = malformed_math_in_body(body)
    if defects:
        problems.append(
            f"The body's LaTeX is malformed ({', '.join(defects)}): close every $, write Greek "
            "letters as commands such as \\alpha, and leave no literal \\n inside maths."
        )
    return problems
