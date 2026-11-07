/**
 * Delphi's display library: the spec a model writes and the states it draws.
 *
 * A display is data, never markup. Core validates it (`delphi_core.artifacts.display`)
 * before publication; this reader re-checks its shape, so a saved answer from a
 * newer or older build degrades to a problem card instead of drawing nonsense.
 * Every text field may hold inline TeX between `$` signs.
 */

export const DISPLAY_VERSION = 1;

export type Tip = { title: string; line?: string };
export type Tone = "plain" | "blue" | "saffron" | "sand" | "dashed" | "muted" | "off";

export type Node = {
  type: "node"; id?: string; label: string; note?: string; short?: string; math?: string;
  tone?: Tone; look?: "box" | "pill" | "head" | "chip"; glow?: boolean; hidden?: boolean;
  repeat?: { count: string; run?: boolean; off?: boolean }; tip?: Tip;
};
export type Tile = {
  type: "tile"; id?: string; label?: string; noise?: number; blur?: number; defect?: number;
  ring?: boolean; fix?: boolean; empty?: boolean; dim?: boolean; glow?: boolean; tag?: string; grow?: boolean; tip?: Tip;
};
export type Link = { type: "link"; style?: "arrow" | "dashed"; label?: string };
export type FlowItem = Node | Tile | Link;
export type Row = { id?: string; hidden?: boolean; parallel?: boolean; items: FlowItem[] };
export type Progress = { id?: string; label: string; value: number; right?: string; accent?: string; note?: string };
export type Lane = {
  id?: string; label: string; faded?: boolean; rows: Row[];
  loop?: { id?: string; label: string; on?: boolean }; back?: string; progress?: Progress;
};

export type Key = { label: string; mark: "line" | "dash" | "swatch" | "edge" | "dashed" | "none"; tone?: Tone | SeriesTone };
type FigureBase = { id?: string; title?: string; subtitle?: string; key?: Key[]; hidden?: boolean };

export type Flow = FigureBase & { kind: "flow"; style?: "chain" | "stretch"; lanes: Lane[] };

export type SeriesTone = "blue1" | "blue2" | "blue3" | "blue4" | "grey" | "saffron" | "walnut";
export type Point = { x: number; y: number; tip?: Tip; read?: { label: string; value: string }[] };
/** sketch: points core sampled from a shape the source described; drawn as a line, with dots only where a point can be read. dots: points with no line. */
export type Series = { id?: string; label?: string; tone?: SeriesTone; dash?: boolean; dots?: boolean; sketch?: boolean; points: Point[] };
export type Axis = { scale?: "linear" | "log"; min?: number; max?: number; ticks?: { at: number; label: string }[] };
export type Chart = FigureBase & {
  kind: "chart"; x: Axis; y: Axis; series: Series[]; minimum?: boolean; frontier?: boolean; hint?: string; height?: number;
};

export type Cell = { id?: string; value: string; state?: "plain" | "pick" | "faint"; tip?: Tip };
export type MatrixRow = { id?: string; label: string; cells: Cell[]; output?: { id?: string; text: string; on?: boolean } };
export type Matrix = FigureBase & {
  kind: "matrix"; caption?: string; cols: string[]; output?: string; rows: MatrixRow[];
  foot?: { label: string; items: { id?: string; chips: string[]; note: string; dim?: boolean }[] };
};

export type Place = { col: number; row: number; cols?: number; rows?: number };
export type GridItem =
  | (Node & Place)
  | ({ type: "text"; id?: string; text: string } & Place)
  | ({ type: "arrow"; id?: string; dir: "right" | "down" | "up" | "both"; pill?: Node; hidden?: boolean } & Place)
  | ({ type: "group"; id?: string; tone: "blue" | "saffron" | "sand" } & Place);
export type Grid = FigureBase & { kind: "grid"; columns: ("node" | "link")[] | number; items: GridItem[] };

export type Bar = { id?: string; series: string; start: number; end: number; tip?: Tip };
export type Timeline = FigureBase & {
  kind: "timeline"; max: number; series: { id: string; label: string; tone: "blue" | "saffron" | "grey" }[];
  panels: { id?: string; title: string; note?: string; end?: number; endLabel?: string; lanes: { label: string; bars: Bar[] }[] }[];
};

export type Compare = FigureBase & { kind: "compare"; tiles: Tile[]; lead?: string; text: string };

export type Figure = Flow | Chart | Matrix | Grid | Timeline | Compare;

export type Patch = Record<string, Record<string, unknown>>;
export type Varied = string | Record<string, string>;
export type Step = { name: Varied; note: Varied; set?: Patch; variants?: Record<string, Patch> };
export type Control = {
  id?: string; label: string; options: { value: string; label: string }[]; default: string; caption?: string; hint?: string;
};

export type Display = {
  display: 1; title: string; badge?: string; control?: Control; variants?: Record<string, Patch>;
  steps?: Step[]; figures: Figure[]; footnote?: string;
};

export type DisplayState = { figures: Figure[]; stepName: string; stepNote: string };

const PREFIX = /^\s*\{\s*"display"\s*:\s*1\s*[,}]/;

/** A fence body is a display when it is a JSON object that opens with its version. */
export function isDisplaySource(source: string): boolean {
  return PREFIX.test(source);
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown) => typeof value === "string";
const KINDS = new Set(["flow", "chart", "matrix", "grid", "timeline", "compare"]);

/** The shape the reader relies on; core holds the full contract. */
export function parseDisplay(source: string): Display | null {
  if (!isDisplaySource(source)) return null;
  let value: unknown;
  try { value = JSON.parse(source); } catch { return null; }
  // An older or foreign source may write an absent field as null.
  if (record(value)) for (const key of ["steps", "control", "variants", "badge", "footnote"]) if (value[key] === null) delete value[key];
  if (!record(value) || value.display !== DISPLAY_VERSION || !text(value.title) || !Array.isArray(value.figures) || !value.figures.length) return null;
  if (!value.figures.every(figure => record(figure) && KINDS.has(String(figure.kind)))) return null;
  if (value.steps !== undefined && (!Array.isArray(value.steps) || !value.steps.every(step => record(step) && (text(step.name) || record(step.name))))) return null;
  if (value.control !== undefined) {
    const control = value.control;
    if (!record(control) || !Array.isArray(control.options) || !control.options.length || !control.options.every(option => record(option) && text(option.value) && text(option.label))) return null;
    if (!control.options.some(option => (option as { value: string }).value === control.default)) return null;
  }
  return value as Display;
}

/** Every object carrying an id, in document order. */
export function indexIds(figures: unknown): Map<string, Record<string, unknown>> {
  const found = new Map<string, Record<string, unknown>>();
  const walk = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!record(value)) return;
    if (typeof value.id === "string" && !found.has(value.id)) found.set(value.id, value);
    Object.values(value).forEach(walk);
  };
  walk(figures);
  return found;
}

function apply(index: Map<string, Record<string, unknown>>, patch: Patch | undefined) {
  if (!patch) return;
  for (const [id, props] of Object.entries(patch)) {
    const target = index.get(id);
    if (!target || !record(props)) continue;
    for (const [key, value] of Object.entries(props)) if (key !== "id" && key !== "type" && key !== "kind") target[key] = value;
  }
}

const pick = (value: Varied | undefined, variant: string) => !value ? "" : typeof value === "string" ? value : value[variant] ?? Object.values(value)[0] ?? "";

/**
 * What the reader sees at one step and control value. Steps accumulate: each
 * names only what changes from the step before it, under the control's own
 * patch, which applies from the first step on.
 */
export function displayState(spec: Display, step: number, variant: string): DisplayState {
  const figures = structuredClone(spec.figures);
  const index = indexIds(figures);
  apply(index, spec.variants?.[variant]);
  const steps = spec.steps ?? [];
  const last = Math.min(Math.max(step, 0), Math.max(steps.length - 1, 0));
  for (let at = 0; at <= last && at < steps.length; at++) {
    apply(index, steps[at].set);
    apply(index, steps[at].variants?.[variant]);
  }
  const current = steps[last];
  return { figures, stepName: pick(current?.name, variant), stepNote: pick(current?.note, variant) };
}

/** Text with inline `$TeX$` spans; `\$` is a literal dollar. */
export function mathSegments(value: string): { text?: string; math?: string }[] {
  const parts: { text?: string; math?: string }[] = [];
  let buffer = "", math = false;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === "\\" && value[index + 1] === "$") { buffer += "$"; index++; continue; }
    if (char === "$") {
      if (buffer) parts.push(math ? { math: buffer } : { text: buffer });
      buffer = ""; math = !math; continue;
    }
    buffer += char;
  }
  if (buffer) parts.push(math ? { text: `$${buffer}` } : { text: buffer });
  return parts;
}
