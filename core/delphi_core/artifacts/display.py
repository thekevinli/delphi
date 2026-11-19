"""Delphi's display library: the contract a model's display spec must meet.

A display is data the reader draws with its own components
(`desktop/frontend/app/lib/display-spec.ts`); it never carries markup or
script. Every state a reader can reach, each step under each control option,
is built here and checked against the same schema, so a patch that names a
missing part or breaks a figure is refused before anything is rendered, and
such a refusal costs the model no attempt.
"""

from __future__ import annotations

import copy
import json
import math
import re
from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, TypeAdapter, ValidationError, model_validator

from .types import SOURCE_MAX

VERSION = 1
PREFIX = re.compile(r"^\s*\{\s*\"display\"\s*:\s*1\s*[,}]")

Id = Annotated[str, StringConstraints(pattern=r"^[A-Za-z][A-Za-z0-9_-]{0,39}$")]
Label = Annotated[str, StringConstraints(min_length=1, max_length=120)]
Short = Annotated[str, StringConstraints(max_length=60)]
Line = Annotated[str, StringConstraints(max_length=240)]
Note = Annotated[str, StringConstraints(max_length=600)]
TeX = Annotated[str, StringConstraints(max_length=120)]
Unit = Annotated[float, Field(ge=0, le=1)]


class _Part(BaseModel):
    # Strict: the reader reads the raw JSON, so "false" or "0.6" must not pass as a bool or number.
    model_config = ConfigDict(extra="forbid", strict=True)


class Tip(_Part):
    title: Label
    line: Line | None = None


Tone = Literal["plain", "blue", "saffron", "sand", "dashed", "muted", "off"]


class Repeat(_Part):
    count: Annotated[str, StringConstraints(min_length=1, max_length=8)]
    run: bool = False
    off: bool = False


class Node(_Part):
    type: Literal["node"]
    id: Id | None = None
    label: Label
    note: Line | None = None
    short: Short | None = None
    math: TeX | None = None
    tone: Tone | None = None
    look: Literal["box", "pill", "head", "chip"] | None = None
    glow: bool = False
    hidden: bool = False
    repeat: Repeat | None = None
    tip: Tip | None = None


class Tile(_Part):
    type: Literal["tile"]
    id: Id | None = None
    label: TeX | None = None
    noise: Unit = 0
    blur: Annotated[float, Field(ge=0, le=8)] = 0
    defect: Unit = 0
    ring: bool = False
    fix: bool = False
    empty: bool = False
    dim: bool = False
    glow: bool = False
    tag: Annotated[str, StringConstraints(max_length=6)] | None = None
    grow: bool = False
    tip: Tip | None = None


class Link(_Part):
    type: Literal["link"]
    style: Literal["arrow", "dashed"] = "arrow"
    label: TeX | None = None


FlowItem = Annotated[Union[Node, Tile, Link], Field(discriminator="type")]


class Row(_Part):
    id: Id | None = None
    hidden: bool = False
    # Parts that run side by side (replicas, alternatives): a chain draws no arrows between them.
    parallel: bool = False
    items: Annotated[list[FlowItem], Field(min_length=1, max_length=12)]


class Progress(_Part):
    id: Id | None = None
    label: Label
    value: Unit
    right: Short | None = None
    accent: Short | None = None
    note: Line | None = None


class Loop(_Part):
    id: Id | None = None
    label: Label
    on: bool = False


class Lane(_Part):
    id: Id | None = None
    label: Label
    faded: bool = False
    rows: Annotated[list[Row], Field(min_length=1, max_length=4)]
    loop: Loop | None = None
    back: Line | None = None
    progress: Progress | None = None


class Key(_Part):
    label: Label
    mark: Literal["line", "dash", "swatch", "edge", "dashed", "none"]
    tone: Literal["blue1", "blue2", "blue3", "blue4", "grey", "saffron", "walnut", "blue", "plain", "sand"] | None = None


class _Figure(_Part):
    id: Id | None = None
    title: Label | None = None
    subtitle: Line | None = None
    key: Annotated[list[Key], Field(max_length=6)] | None = None
    hidden: bool = False


#: Each kind of box: the fields it never draws, and the tones it has a colour for. Anything else would vanish from the reader's view.
BOXES = {"chain": ({"math", "short", "look", "repeat"}, {"plain", "blue", "saffron", "dashed", "muted", "off"}),
         "stretch": ({"note", "short", "look"}, {"plain", "blue", "saffron", "muted", "off"}),
         "grid": ({"math", "repeat"}, {"plain", "blue", "saffron", "sand", "off"}),
         "pill": ({"math", "repeat", "look", "tone"}, set())}


def _box_draws(node: Node, kind: str) -> None:
    undrawn, tones = BOXES[kind]
    given = sorted(name for name in node.model_fields_set & undrawn if getattr(node, name) is not None)
    if kind == "grid" and node.short is not None and node.note is None:
        given.append("short without a note")
    if given:
        raise ValueError(f"a {kind} node does not draw {', '.join(given)} (node {node.label!r}); leave {'it' if len(given) == 1 else 'them'} out or use another figure")
    if node.tone is not None and tones and node.tone not in tones:
        raise ValueError(f"a {kind} node has no tone {node.tone!r} (node {node.label!r}); use one of {', '.join(sorted(tones))}")


class Flow(_Figure):
    kind: Literal["flow"]
    style: Literal["chain", "stretch"] = "chain"
    lanes: Annotated[list[Lane], Field(min_length=1, max_length=4)]

    @model_validator(mode="after")
    def _shape(self) -> Flow:
        for lane in self.lanes:
            if self.style == "chain" and (lane.loop is not None or lane.progress is not None):
                raise ValueError(f"a chain lane draws no loop or progress (lane {lane.label!r}); those belong to style 'stretch', and a chain says what loops back with back")
            if self.style == "stretch" and lane.back is not None:
                raise ValueError(f"a stretch lane draws no back (lane {lane.label!r}); show an outer loop with loop:{{label,on}}")
            for row in lane.rows:
                if self.style == "chain" and any(item.type != "node" for item in row.items):
                    raise ValueError("a chain flow holds nodes only; tiles and links belong to style 'stretch'")
                for item in row.items:
                    if item.type == "node":
                        _box_draws(item, self.style)
                if self.style == "stretch" and row.parallel:
                    raise ValueError("parallel belongs to a chain row; a stretch row is a path through networks")
                drawn = [item for item in row.items if item.type != "link"]
                if not drawn:
                    raise ValueError("a row needs at least one node or tile")
        return self


SeriesTone = Literal["blue1", "blue2", "blue3", "blue4", "grey", "saffron", "walnut"]


class Reading(_Part):
    label: Short
    value: Short


class Point(_Part):
    x: float
    y: float
    tip: Tip | None = None
    read: Annotated[list[Reading], Field(max_length=6)] | None = None


class At(_Part):
    x: float
    y: float


class Mark(_Part):
    """A point on a sketched curve the reader can hover: its y comes from the shape."""
    x: float
    tip: Tip | None = None
    read: Annotated[list[Reading], Field(max_length=6)] | None = None


class Shape(_Part):
    """A trend the source describes without numbers, sampled into points here and badged Illustrative."""
    kind: Literal["line", "power", "valley", "plateau"]
    start: At
    end: At
    at: At | None = None
    marks: Annotated[list[Mark], Field(max_length=12)] | None = None

    @model_validator(mode="after")
    def _anchors(self) -> Shape:
        if not self.end.x > self.start.x:
            raise ValueError("a shape runs left to right: end.x must be greater than start.x")
        if self.kind in {"line", "power"} and self.at is not None:
            raise ValueError(f"a {self.kind} runs from start to end; 'at' belongs to a valley (its minimum) or a plateau (where it levels off)")
        if self.kind == "valley" and self.at is None:
            raise ValueError("a valley needs 'at', its lowest point")
        if self.at is not None and not self.start.x < self.at.x < self.end.x:
            raise ValueError("'at' must lie between start.x and end.x")
        if self.kind == "valley" and not self.at.y < min(self.start.y, self.end.y):
            raise ValueError("a valley's 'at' must lie below both start and end")
        xs = [mark.x for mark in self.marks or []]
        if len(set(xs)) < len(xs):
            raise ValueError("two marks share an x; put everything said there in one mark")
        for mark in self.marks or []:
            if not self.start.x <= mark.x <= self.end.x:
                raise ValueError(f"a mark at x {mark.x:g} lies off the curve, which runs from {self.start.x:g} to {self.end.x:g}")
            if mark.tip is None and not mark.read:
                raise ValueError("a mark gives the reader something to read: a tip, read rows or both")
        if self.kind == "plateau" and self.at is not None and not min(self.start.y, self.end.y) < self.at.y < max(self.start.y, self.end.y):
            raise ValueError("a plateau's 'at' must lie between its start and end levels")
        if self.kind == "power" and (self.start.x <= 0 or self.start.y * self.end.y <= 0):
            raise ValueError("a power law needs positive x and start and end y of the same sign")
        return self


class Series(_Part):
    id: Id | None = None
    label: Short | None = None
    tone: SeriesTone | None = None
    dash: bool = False
    points: Annotated[list[Point], Field(min_length=1, max_length=80)] | None = None
    shape: Shape | None = None
    # Each point drawn as a dot with no line through them: measured optima, a scatter.
    dots: bool = False
    # Set here when a shape is sampled, so the reader draws a line and no readings.
    sketch: bool = False

    @model_validator(mode="after")
    def _one(self) -> Series:
        if (self.points is None) == (self.shape is None):
            raise ValueError("a series has either points (measured values) or a shape (a sketched trend), not both or neither")
        if self.dots and (self.shape is not None or self.sketch):
            raise ValueError("a sketched shape is drawn as a line; dots are for points the source reports")
        if self.points is not None and len(self.points) == 1 and not self.dots:
            raise ValueError("a line needs two points; a series of single points sets dots:true")
        return self

    def anchors(self) -> list[Point | At]:
        if self.points is not None:
            return list(self.points)
        return [self.shape.start, self.shape.end, *([self.shape.at] if self.shape.at else [])]


class Tick(_Part):
    at: float
    label: Short


class Axis(_Part):
    scale: Literal["linear", "log"] = "linear"
    min: float | None = None
    max: float | None = None
    ticks: Annotated[list[Tick], Field(max_length=12)] | None = None


class Chart(_Figure):
    kind: Literal["chart"]
    x: Axis
    y: Axis
    series: Annotated[list[Series], Field(min_length=1, max_length=8)]
    minimum: bool = False
    frontier: bool = False
    hint: Line | None = None
    height: Annotated[int, Field(ge=120, le=400)] | None = None

    @model_validator(mode="after")
    def _axes(self) -> Chart:
        anchors = [p for s in self.series for p in s.anchors()]
        for name, axis, values in (("x", self.x, [p.x for p in anchors]), ("y", self.y, [p.y for p in anchors])):
            if axis.scale == "log" and any(value <= 0 for value in [*values, *(v for v in (axis.min, axis.max) if v is not None)]):
                raise ValueError(f"{name} is a log axis, so every {name} value, min and max must be positive")
            low = axis.min if axis.min is not None else min(values)
            high = axis.max if axis.max is not None else max(values)
            if not high > low:
                raise ValueError(f"{name}.max must be greater than {name}.min")
            for tick in axis.ticks or []:
                if not low <= tick.at <= high:
                    raise ValueError(f"the {name} tick at {tick.at:g} lies outside {low:g} to {high:g}")
        return self


class Cell(_Part):
    id: Id | None = None
    value: Annotated[str, StringConstraints(max_length=24)]
    state: Literal["plain", "pick", "faint"] = "plain"
    tip: Tip | None = None


class Output(_Part):
    id: Id | None = None
    text: Line
    on: bool = False


class MatrixRow(_Part):
    id: Id | None = None
    label: Annotated[str, StringConstraints(min_length=1, max_length=24)]
    cells: Annotated[list[Cell], Field(min_length=1, max_length=8)]
    output: Output | None = None


class FootItem(_Part):
    id: Id | None = None
    chips: Annotated[list[Annotated[str, StringConstraints(min_length=1, max_length=2)]], Field(max_length=6)]
    note: Short
    dim: bool = False


class Foot(_Part):
    label: Short
    items: Annotated[list[FootItem], Field(min_length=1, max_length=8)]


class Matrix(_Figure):
    kind: Literal["matrix"]
    caption: Line | None = None
    cols: Annotated[list[Annotated[str, StringConstraints(min_length=1, max_length=24)]], Field(min_length=1, max_length=8)]
    output: Short | None = None
    rows: Annotated[list[MatrixRow], Field(min_length=1, max_length=12)]
    foot: Foot | None = None

    @model_validator(mode="after")
    def _square(self) -> Matrix:
        for row in self.rows:
            if len(row.cells) != len(self.cols):
                raise ValueError(f"row {row.label!r} has {len(row.cells)} cells for {len(self.cols)} columns")
        if self.foot and len(self.foot.items) != len(self.cols):
            raise ValueError(f"foot has {len(self.foot.items)} items for {len(self.cols)} columns")
        return self


class _Place(_Part):
    col: Annotated[int, Field(ge=1, le=9)]
    row: Annotated[int, Field(ge=1, le=24)]
    cols: Annotated[int, Field(ge=1, le=9)] = 1
    rows: Annotated[int, Field(ge=1, le=24)] = 1


class GridNode(Node, _Place):
    pass


class GridText(_Place):
    type: Literal["text"]
    id: Id | None = None
    text: Line


class GridArrow(_Place):
    type: Literal["arrow"]
    id: Id | None = None
    dir: Literal["right", "down", "up", "both"]
    pill: Node | None = None
    hidden: bool = False


class GridGroup(_Place):
    type: Literal["group"]
    id: Id | None = None
    tone: Literal["blue", "saffron", "sand"]


GridItem = Annotated[Union[GridNode, GridText, GridArrow, GridGroup], Field(discriminator="type")]


class Grid(_Figure):
    kind: Literal["grid"]
    columns: Annotated[list[Literal["node", "link"]], Field(min_length=1, max_length=9)] | Annotated[int, Field(ge=1, le=8)]
    items: Annotated[list[GridItem], Field(min_length=1, max_length=60)]

    @model_validator(mode="after")
    def _placed(self) -> Grid:
        width = self.columns if isinstance(self.columns, int) else len(self.columns)
        taken: dict[tuple[int, int], str] = {}
        for item in self.items:
            if item.type == "node":
                _box_draws(item, "grid")
            if item.type == "arrow" and item.pill is not None:
                _box_draws(item.pill, "pill")
            if item.col + item.cols - 1 > width:
                raise ValueError(f"an item at col {item.col} spanning {item.cols} passes the grid's {width} columns")
            if item.type == "arrow" and item.dir == "right" and item.pill is not None and not isinstance(self.columns, int) \
                    and all(self.columns[col - 1] == "link" for col in range(item.col, item.col + item.cols)):
                raise ValueError(f"the pill {item.pill.label!r} rides a right arrow in a link lane, which is too narrow for it; place that arrow in a node column, or span one")
            if item.type in {"node", "text", "arrow"} and not getattr(item, "hidden", False):
                name = getattr(item, "label", None) or getattr(item, "text", None) or f"{item.dir} arrow"
                for col in range(item.col, item.col + item.cols):
                    for row in range(item.row, item.row + item.rows):
                        if (col, row) in taken:
                            raise ValueError(f"{name!r} and {taken[(col, row)]!r} both sit at col {col}, row {row}")
                        taken[(col, row)] = name
        return self


class Bar(_Part):
    id: Id | None = None
    series: Id
    start: Annotated[float, Field(ge=0)]
    end: float
    tip: Tip | None = None


class TimelineLane(_Part):
    label: Short
    bars: Annotated[list[Bar], Field(max_length=24)]


class Panel(_Part):
    id: Id | None = None
    title: Label
    note: Line | None = None
    end: float | None = None
    endLabel: Short | None = None
    lanes: Annotated[list[TimelineLane], Field(min_length=1, max_length=6)]


class TimelineSeries(_Part):
    id: Id
    label: Short
    tone: Literal["blue", "saffron", "grey"]


class Timeline(_Figure):
    kind: Literal["timeline"]
    max: Annotated[float, Field(gt=0)]
    series: Annotated[list[TimelineSeries], Field(min_length=1, max_length=2)]
    panels: Annotated[list[Panel], Field(min_length=1, max_length=3)]

    @model_validator(mode="after")
    def _bars(self) -> Timeline:
        names = {series.id for series in self.series}
        for panel in self.panels:
            if panel.end is not None and not 0 <= panel.end <= self.max:
                raise ValueError(f"panel {panel.title!r} ends at {panel.end:g}, outside 0 to max {self.max:g}")
            for lane in panel.lanes:
                for bar in lane.bars:
                    if bar.series not in names:
                        raise ValueError(f"a bar names series {bar.series!r}; the series are {sorted(names)}")
                    if not bar.start < bar.end <= self.max:
                        raise ValueError(f"a bar from {bar.start:g} to {bar.end:g} must end after it starts and by max {self.max:g}")
        return self


class Compare(_Figure):
    kind: Literal["compare"]
    tiles: Annotated[list[Tile], Field(min_length=1, max_length=4)]
    lead: Line | None = None
    text: Note


Figure = Annotated[Union[Flow, Chart, Matrix, Grid, Timeline, Compare], Field(discriminator="kind")]
FIGURES = TypeAdapter(list[Figure])

Patch = dict[Id, dict[str, Any]]
Varied = Union[Annotated[str, StringConstraints(max_length=600)], dict[str, Annotated[str, StringConstraints(max_length=600)]]]


class Step(_Part):
    name: Varied
    note: Varied
    focus: Annotated[list[Id], Field(min_length=1, max_length=12)] | None = None
    set: Patch | None = None
    variants: dict[str, Patch] | None = None


class Option(_Part):
    value: Id
    label: Short
    off: Annotated[list[Id], Field(max_length=12)] | None = None


class Control(_Part):
    id: Id | None = None
    label: Label
    options: Annotated[list[Option], Field(min_length=2, max_length=4)]
    default: str
    caption: Line | None = None
    hint: Line | None = None


class Display(_Part):
    display: Literal[1]
    title: Label
    badge: Short | None = None
    reveal: bool = False
    control: Control | None = None
    variants: dict[str, Patch] | None = None
    steps: Annotated[list[Step], Field(max_length=12)] | None = None
    figures: Annotated[list[Figure], Field(min_length=1, max_length=4)]
    footnote: Line | None = None


class DisplayError(ValueError):
    """Every reason a spec is refused, worded for the model that wrote it."""

    def __init__(self, reasons: list[str]) -> None:
        self.reasons = reasons[:10]
        super().__init__("; ".join(self.reasons))


def _where(location: tuple[Any, ...]) -> str:
    # Pydantic names the matching union member after its index ("figures.0.flow.lanes"); a reader wants the data path.
    kinds = {"flow", "chart", "matrix", "grid", "timeline", "compare", "node", "tile", "link", "text", "arrow", "group"}
    kept = [part for at, part in enumerate(location)
            if not (part in kinds and at and isinstance(location[at - 1], int)) and not str(part).startswith(("function-", "list[", "int", "constrained-"))]
    return ".".join(str(part) for part in kept) or "spec"


def _clean(value: Any, path: str, reasons: list[str]) -> Any:
    """The spec without nulls (an absent field), with every number finite and every string encodable."""
    if isinstance(value, dict):
        return {key: _clean(item, f"{path}.{key}" if path else key, reasons) for key, item in value.items() if item is not None}
    if isinstance(value, list):
        return [_clean(item, f"{path}.{at}", reasons) for at, item in enumerate(value) if item is not None]
    if isinstance(value, float) and not math.isfinite(value):
        reasons.append(f"{path}: numbers must be finite")
    elif isinstance(value, str):
        try:
            value.encode("utf-8")
        except UnicodeEncodeError:
            reasons.append(f"{path}: contains a character that is not valid text")
    return value


def _drawn(figures: list) -> Any:
    """A state as the reader sees it: a false, empty-list or default field is the same as an absent one."""
    def prune(value: Any) -> Any:
        if isinstance(value, dict):
            # Identity, not equality: 0 == False, and a zero or empty text set by a step is a change.
            return {key: prune(item) for key, item in value.items() if item is not None and item is not False and item != [] and item != {}}
        if isinstance(value, list):
            return [prune(item) for item in value]
        return value
    return prune([figure.model_dump(exclude_defaults=True) for figure in FIGURES.validate_python(figures)])


def plain_title(text: str) -> str:
    return re.sub(r"[\r\n`\x00-\x1f\x7f]", " ", text).strip()[:160]


def _patch_nulls(raw: dict) -> list[str]:
    """A null in a patch would vanish with the other nulls and leave the field as it was; say so instead."""
    def options(value: Any) -> dict:
        return value if isinstance(value, dict) else {}
    patches: list[tuple[str, Any]] = [(f"variants.{option}", patch) for option, patch in options(raw.get("variants")).items()]
    steps = raw.get("steps")
    for at, step in enumerate(steps if isinstance(steps, list) else []):
        if isinstance(step, dict):
            patches.append((f"steps.{at}.set", step.get("set")))
            patches += [(f"steps.{at}.variants.{option}", patch) for option, patch in options(step.get("variants")).items()]
    found = []
    for where, patch in patches:
        for target, fields in (patch.items() if isinstance(patch, dict) else ()):
            if fields is None:
                found.append(f"{where}.{target} is null; give the fields to change, or leave {target!r} out")
            for key, item in (fields.items() if isinstance(fields, dict) else ()):
                if item is None:
                    found.append(f"{where}.{target}.{key} is null; a patch cannot remove a field, so give the value it should have (false, 0, \"\" or another)")
    return found


def _pydantic(error: ValidationError, prefix: str = "") -> list[str]:
    def hint(row: dict) -> str:
        # Both models placed grid items from 0 in the probes.
        return " (grid places count from 1)" if row["loc"][-1] in {"col", "row"} and row["type"] == "greater_than_equal" else ""
    return [f"{prefix}{_where(row['loc'])}: {row['msg'].removeprefix('Value error, ')}{hint(row)}" for row in error.errors()[:8]]


def _ids(value: Any, found: dict[str, int]) -> None:
    if isinstance(value, list):
        for item in value:
            _ids(item, found)
    elif isinstance(value, dict):
        if isinstance(value.get("id"), str):
            found[value["id"]] = found.get(value["id"], 0) + 1
        for item in value.values():
            _ids(item, found)


def _index(value: Any, found: dict[str, dict]) -> dict[str, dict]:
    if isinstance(value, list):
        for item in value:
            _index(item, found)
    elif isinstance(value, dict):
        if isinstance(value.get("id"), str):
            found.setdefault(value["id"], value)
        for item in value.values():
            _index(item, found)
    return found


def _apply(index: dict[str, dict], patch: dict[str, dict] | None) -> None:
    for target, fields in (patch or {}).items():
        index[target].update({key: item for key, item in fields.items() if key not in {"id", "type", "kind"}})


def _text_fields(value: Any, path: str = "") -> list[tuple[str, str]]:
    found: list[tuple[str, str]] = []
    if isinstance(value, list):
        for at, item in enumerate(value):
            found += _text_fields(item, f"{path}.{at}")
    elif isinstance(value, dict):
        for key, item in value.items():
            # A whole TeX field never carries `$` delimiters; prose fields may. A bar's series is an id.
            if key in {"math", "id", "kind", "type"} or (key == "series" and isinstance(item, str)) or (key == "label" and value.get("type") in {"tile", "link"}):
                continue
            found += _text_fields(item, f"{path}.{key}" if path else key)
    elif isinstance(value, str):
        found.append((path, value))
    return found


SAMPLES = 25
#: A node's note is a few words per column it spans; sentences belong in its tip.
NOTE_PER_COLUMN = 48


def _sample(shape: dict, scale: str, y_scale: str = "linear") -> list[dict]:
    """A sketched trend as points, evenly spaced as the axis draws them, and shaped as the y axis draws it."""
    log = scale == "log"
    def u(x: float) -> float:
        return math.log10(x) if log else x
    if y_scale == "log" and shape["kind"] != "power":
        # A line, valley or plateau keeps its shape on a log y axis: it is drawn in decades, then read back.
        lifted = {key: ({**point, "y": math.log10(point["y"])} if key in {"start", "end", "at"} and point else point) for key, point in shape.items()}
        return [{**point, "y": float(f"{10 ** point['y']:.4g}")} for point in _sample(lifted, scale)]
    start, end, at = shape["start"], shape["end"], shape.get("at")
    u0, u1 = u(start["x"]), u(end["x"])
    xs = [u0 + (u1 - u0) * i / (SAMPLES - 1) for i in range(SAMPLES)]
    marks = {u(mark["x"]): mark for mark in shape.get("marks", [])}
    anchors = {*marks, *([u(at["x"])] if at is not None else [])}
    # A sample a rounding error from an anchor would print as a second point at the same x.
    near = 1e-6 * (u1 - u0)
    xs = sorted([v for v in xs if all(abs(v - a) > near for a in anchors)] + list(anchors))
    kind = shape["kind"]
    ys = []
    for v in xs:
        if kind == "line":
            y = start["y"] + (end["y"] - start["y"]) * (v - u0) / (u1 - u0)
        elif kind == "power":
            x = 10 ** v if log else v
            y = start["y"] * (x / start["x"]) ** (math.log(end["y"] / start["y"]) / math.log(end["x"] / start["x"]))
        elif kind == "valley":
            ua = u(at["x"])
            side = start if v <= ua else end
            y = at["y"] + (side["y"] - at["y"]) * ((v - ua) / (u(side["x"]) - ua)) ** 2
        else:
            # Through 'at' when given; otherwise within a tenth of the gap a third of the way along.
            knee, left = (u(at["x"]), (at["y"] - end["y"]) / (start["y"] - end["y"])) if at else (u0 + (u1 - u0) / 3, 0.1)
            y = end["y"] + (start["y"] - end["y"]) * left ** ((v - u0) / (knee - u0))
        ys.append(y)
    return [{"x": float(f"{10 ** v if log else v:.6g}"), "y": float(f"{y:.4g}"),
             **{key: marks[v][key] for key in ("tip", "read") if v in marks and key in marks[v]}} for v, y in zip(xs, ys)]


def _expand(raw: dict) -> tuple[dict, list[str]]:
    """The shorthands (focus, reveal, an option's off, a sketched shape) written out as the plain spec the reader draws."""
    raw = copy.deepcopy(raw)
    reasons: list[str] = []
    index = _index(raw["figures"], {})
    sketched = False
    for figure in raw["figures"]:
        for series in figure.get("series", []) if figure["kind"] == "chart" else []:
            if "shape" in series:
                series["points"] = _sample(series.pop("shape"), figure["x"].get("scale", "linear"), figure["y"].get("scale", "linear"))
                series["sketch"] = sketched = True
    if sketched:
        raw["badge"] = "Illustrative"

    def write(patch: dict, target: str, field: str, value: Any) -> None:
        # What the model set itself wins over the shorthand.
        patch.setdefault(target, {}).setdefault(field, value)

    lanes = {id(lane) for figure in raw["figures"] if figure["kind"] == "flow" for lane in figure["lanes"]}
    cells = {id(cell) for figure in raw["figures"] if figure["kind"] == "matrix" for row in figure["rows"] for cell in row["cells"]}
    for at, option in enumerate((raw.get("control") or {}).get("options", [])):
        for target in option.pop("off", None) or []:
            part = index.get(target)
            field = (None if part is None else ("tone", "off") if part.get("type") == "node" else ("dim", True) if part.get("type") == "tile"
                     else ("faded", True) if id(part) in lanes else ("state", "faint") if id(part) in cells else None)
            if field is None:
                reasons.append(f"control.options.{at}.off names {target!r}, " + ("but no part has that id" if part is None else "which cannot be turned off; name nodes, tiles, lanes or matrix cells, or use variants"))
                continue
            write(raw.setdefault("variants", {}).setdefault(option["value"], {}), target, *field)

    steps = raw.get("steps") or []
    reveal = raw.pop("reveal", False)
    lit = {name for name, part in index.items() if part.get("type") in {"node", "tile"} and part.get("glow")}
    first: dict[str, int] = {}
    for at, step in enumerate(steps):
        if "focus" not in step:
            continue
        focus = step.pop("focus")
        nodes = []
        for target in focus:
            part = index.get(target)
            if part is None or part.get("type") not in {"node", "tile"}:
                reasons.append(f"steps.{at}.focus names {target!r}, " + ("but no part has that id" if part is None else "which is neither a node nor a tile; focus lights those, so change other parts with set"))
            else:
                nodes.append(target)
                first.setdefault(target, at)
        patch = step.setdefault("set", {})
        for target in nodes:
            write(patch, target, "glow", True)
        for target in sorted(lit - set(nodes)):
            write(patch, target, "glow", False)
        lit = set(nodes)
    if reveal:
        if not first:
            reasons.append("reveal shows each node at the first step whose focus names it; give the steps a focus, or leave reveal out")
        # A grid keeps a hidden part's place; a flow row would close up and move its neighbours.
        gridded = {name for figure in raw["figures"] if figure["kind"] == "grid" for name in _index(figure["items"], {})}
        reasons += [f"reveal: {target!r} is in a flow, whose row would move as it appears; reveal works in grids, so draw flow nodes from step 1 and let focus move"
                    for target, at in first.items() if at and target not in gridded]
        if reasons:
            return raw, reasons
        for target, at in first.items():
            if at:
                index[target]["hidden"] = True
                write(steps[at]["set"], target, "hidden", False)
        _reveal_arrows(raw["figures"], first, steps, set(index))
    return raw, reasons


def _reveal_arrows(figures: list, first: dict[str, int], steps: list, taken: set[str]) -> None:
    """A grid arrow appears with the node it points to, so no arrow leads to an empty place."""
    for figure in figures:
        if figure["kind"] != "grid":
            continue
        at_cell = {(col, row): item["id"] for item in figure["items"] if item["type"] == "node" and "id" in item
                   for col in range(item["col"], item["col"] + item.get("cols", 1)) for row in range(item["row"], item["row"] + item.get("rows", 1))}
        for item in figure["items"]:
            if item["type"] != "arrow":
                continue
            col, row, cols, rows = item["col"], item["row"], item.get("cols", 1), item.get("rows", 1)
            ends = [(col - 1, row), (col + cols, row)] if item["dir"] == "right" else [(col, row - 1), (col, row + rows)]
            step = max(first.get(at_cell.get(end), 0) for end in ends)
            if not step:
                continue
            if "id" not in item:
                item["id"] = next(name for n in range(1, 1000) if (name := f"arrow{n}") not in taken)
                taken.add(item["id"])
            item["hidden"] = True
            steps[step]["set"].setdefault(item["id"], {}).setdefault("hidden", False)


def _crowded(figures: list) -> list[str]:
    """Nodes whose note is a sentence or whose text is broken over lines."""
    found = []
    def walk(value: Any) -> None:
        if isinstance(value, list):
            for item in value:
                walk(item)
        elif isinstance(value, dict):
            if value.get("type") == "node":
                name = value.get("label", "a node")
                for field in ("label", "note", "short"):
                    if "\n" in value.get(field, "") or "\r" in value.get(field, ""):
                        found.append(f"node {name!r}: its {field} has a line break, which is drawn as a space; a node shows its label and note on lines of their own, so write each as one phrase and put more in its tip")
                limit = NOTE_PER_COLUMN * value.get("cols", 1)
                if len(value.get("note", "")) > limit:
                    found.append(f"node {name!r}: its note is {len(value['note'])} characters; a note holds a few words (about {limit} here), so put the rest in its tip")
            for item in value.values():
                walk(item)
    walk(figures)
    return found


def states(raw: dict) -> list[tuple[str, int, list]]:
    """Every (option, step, figures) a reader can reach, in order, from a schema-valid spec."""
    options = [option["value"] for option in raw["control"]["options"]] if raw.get("control") else [""]
    steps = raw.get("steps") or [{}]
    reached = []
    for option in options:
        figures = copy.deepcopy(raw["figures"])
        index = _index(figures, {})
        _apply(index, (raw.get("variants") or {}).get(option))
        for at, step in enumerate(steps):
            _apply(index, step.get("set"))
            _apply(index, (step.get("variants") or {}).get(option))
            reached.append((option, at, copy.deepcopy(figures)))
    return reached


def validate(spec: str | dict) -> tuple[dict, str]:
    """The spec and its canonical source, or a `DisplayError` with every reason found."""
    try:
        return _validate(spec)
    except RecursionError:
        raise DisplayError(["the spec is nested too deeply; a display is a few levels of figures, parts and patches"]) from None


def _keys(value: Any) -> set[str]:
    """Every key at any depth: a patch may replace a figure's whole series list."""
    if isinstance(value, dict):
        return set(value).union(*(_keys(item) for item in value.values()))
    if isinstance(value, list):
        return set().union(*(_keys(item) for item in value))
    return set()


def _patches(raw: dict):
    """Every patch a step, an option or a step's option applies, as {partId: fields}."""
    yield from (raw.get("variants") or {}).values()
    for step in raw.get("steps") or []:
        yield step.get("set") or {}
        yield from (step.get("variants") or {}).values()


def _validate(spec: str | dict) -> tuple[dict, str]:
    if isinstance(spec, str):
        if not PREFIX.match(spec):
            raise DisplayError(['a display is a JSON object that starts with {"display": 1, ...}'])
        try:
            raw = json.loads(spec, parse_constant=_constant)
        except (ValueError, RecursionError) as error:
            raise DisplayError([f"not valid JSON: {error}"]) from None
    else:
        raw = copy.deepcopy(spec)
    if not isinstance(raw, dict) or raw.get("display") != VERSION:
        raise DisplayError(['a display is a JSON object whose first field is "display": 1'])
    reasons: list[str] = _patch_nulls(raw)
    raw = _clean(raw, "", reasons)
    if reasons:
        raise DisplayError(reasons)
    try:
        model = Display.model_validate(raw)
    except ValidationError as error:
        raise DisplayError(_pydantic(error)) from None

    if not plain_title(model.title):
        reasons.append("title: write a short plain-text title, not only spaces or control characters")
    counts: dict[str, int] = {}
    _ids(raw["figures"], counts)
    reasons += [f"id {name!r} is used {count} times; ids name one part each" for name, count in counts.items() if count > 1]
    if reasons:
        raise DisplayError(reasons)
    reasons += [f"figures.{at}.series.{n}.sketch is set by the library when it samples a shape; give the series a shape instead"
                for at, figure in enumerate(raw["figures"]) if figure["kind"] == "chart"
                for n, series in enumerate(figure["series"]) if "sketch" in series]
    reasons += [f"a patch sets sketch on {target!r}; the library sets it when it samples a shape, and no step or option may change it"
                for patch in _patches(raw) if isinstance(patch, dict) for target, fields in patch.items() if "sketch" in _keys(fields)]
    if reasons:
        raise DisplayError(reasons)
    raw, reasons = _expand(raw)
    if reasons:
        raise DisplayError(reasons)
    counts = {}
    _ids(raw["figures"], counts)
    try:
        model = Display.model_validate(raw)
    except ValidationError as error:
        raise DisplayError(_pydantic(error)) from None
    options = [option.value for option in model.control.options] if model.control else []
    if model.control:
        if len(set(options)) != len(options):
            reasons.append("control.options repeat a value")
        labels = [option.label for option in model.control.options]
        if len(set(labels)) != len(labels):
            reasons.append("control.options repeat a label; each option needs its own")
        if model.control.default not in options:
            reasons.append(f"control.default {model.control.default!r} is not one of the options {options}")
    elif model.variants:
        reasons.append("variants need a control whose options name them")

    def names_options(where: str, keys: Any, every: bool = False) -> None:
        unknown = sorted(set(keys) - set(options))
        if unknown:
            reasons.append(f"{where} names {unknown}, which are not control options {options or '(there is no control)'}")
        elif every and set(keys) != set(options):
            reasons.append(f"{where} must give every option {options}; it lacks {sorted(set(options) - set(keys))}")

    def known(where: str, patch: dict | None) -> None:
        for target, fields in (patch or {}).items():
            if target not in counts:
                reasons.append(f"{where} changes {target!r}, but no part has that id")
            elif not isinstance(fields, dict) or not fields:
                reasons.append(f"{where}.{target} must be an object of the fields to change")
            elif fixed := sorted({"id", "type", "kind"} & set(fields)):
                reasons.append(f"{where}.{target} changes {fixed}, which a step cannot change; draw another part and show it instead")

    names_options("variants", (model.variants or {}).keys())
    for option, patch in (raw.get("variants") or {}).items():
        known(f"variants.{option}", patch)
    for at, step in enumerate(raw.get("steps") or []):
        where = f"steps.{at}"
        for field in ("name", "note"):
            if isinstance(step.get(field), dict):
                names_options(f"{where}.{field}", step[field].keys(), every=True)
        known(f"{where}.set", step.get("set"))
        names_options(f"{where}.variants", (step.get("variants") or {}).keys())
        for option, patch in (step.get("variants") or {}).items():
            known(f"{where}.variants.{option}", patch)
    for path, text in _text_fields(raw):
        if len(re.findall(r"(?<!\\)\$", text)) % 2:
            reasons.append(f"{path}: an unmatched $ opens math that never closes; write \\$ for a dollar sign")
    if reasons:
        raise DisplayError(reasons)

    reached = states(raw)
    steps = raw.get("steps") or []
    seen: set[str] = set()
    for option, at, figures in reached:
        try:
            FIGURES.validate_python(figures)
        except ValidationError as error:
            where = f"step {at + 1}" + (f" with {option}" if option else "") if steps else (f"option {option}" if option else "the figures")
            # The first state a broken patch reaches names it; later states repeat it.
            for reason in _pydantic(error):
                if reason not in seen:
                    seen.add(reason)
                    reasons.append(f"after the patches of {where}, figures.{reason}")
            continue
        for reason in _crowded(figures):
            if reason not in seen:
                seen.add(reason)
                reasons.append(reason)
    if reasons:
        raise DisplayError(reasons)
    by = {option: [_drawn(figures) for chosen, _, figures in reached if chosen == option] for option in options or [""]}
    for option in options or [""]:
        drawn = by[option]
        for at in range(1, len(drawn)):
            if drawn[at] == drawn[at - 1]:
                reasons.append(f"step {at + 1}{f' with {option}' if option else ''} changes nothing in the figures; make it change what it describes, or merge it into step {at}")
    if options:
        for first in range(len(options)):
            for second in range(first + 1, len(options)):
                one, two = options[first], options[second]
                if by[one] == by[two]:
                    reasons.append(f"options {one!r} and {two!r} draw the same thing at every step; a control must change the picture")
    if reasons:
        raise DisplayError(reasons)
    source = json.dumps({"display": VERSION, **{key: value for key, value in raw.items() if key != "display"}}, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    if len(source) > SOURCE_MAX:
        raise DisplayError([f"the display is {len(source)} characters; keep it under {SOURCE_MAX}"])
    return raw, source


def _constant(name: str) -> float:
    raise ValueError(f"{name} is not a JSON number; numbers must be finite")


def is_display(source: str) -> bool:
    return bool(PREFIX.match(source))
