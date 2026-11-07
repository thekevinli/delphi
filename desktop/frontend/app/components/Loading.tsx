import type { CSSProperties, ReactNode } from "react";

/*
 * How Delphi waits. A region that is filling in draws the shape of what is
 * coming (`Skeleton`, `SkeletonBar`); a wait with nothing to outline gets a
 * small mark of its own — three pages for opening a project, the walk round a
 * pentagon for a graph — and one caption style. The Delphi mark itself is kept
 * for the start-up window, the Reader and notices; it is not used here.
 *
 * Everything moves by transform and opacity only, and holds still under
 * reduced motion. The timing and colours live beside the styles, under
 * "Loading" in globals.css.
 */

/**
 * A phrase with a soft light passing across it. Two copies of the text: the
 * base, and a lighter one seen only through a feathered window. The window
 * slides one way and the lighter copy slides the other by the same amount, so
 * the letters stay put while the light moves.
 */
export function SweepText({ text }: { text: string }) {
  return (
    <span className="sweep-text">
      {text}
      <span className="sweep-text-window" aria-hidden="true">
        <span className="sweep-text-shine">{text}</span>
      </span>
    </span>
  );
}

/** The one loading caption: present tense, ending in "…", the light passing over it. */
export function LoadingCaption({ text }: { text: string }) {
  return <span className="loading-caption"><SweepText text={text} /></span>;
}

/**
 * What a wordless outline says to a screen reader. A live region announces its
 * content, not its name, so the words have to be in it.
 */
export function LoadingWords({ text }: { text: string }) {
  return <span className="visually-hidden">{text}</span>;
}

/** Opening a project: three pages lifting in turn. */
export function PagesMark() {
  return (
    <span className="pages-mark" aria-hidden="true">
      <i className="pages-mark-sheet is-back" />
      <i className="pages-mark-sheet is-middle" />
      <i className="pages-mark-sheet is-front"><b /><b /><b /></i>
    </span>
  );
}

/*
 * The graph mark: a pentagon walked from its top vertex both ways round, the
 * two halves of the base meeting in the middle. Each step's links grow, then
 * its pages arrive; the shape rests, fades and walks again. Mirror pairs share
 * a kind, so the walk stays symmetric. The geometry is here; the timing of
 * each step is the matching keyframes in globals.css.
 */
const GRAPH_MARK = { width: 64, height: 60, radius: 25, centerX: 32, centerY: 32, sides: 5 } as const;

type GraphKind = "domain" | "source" | "question";
type GraphPoint = { x: number; y: number };

function graphVertex(index: number): GraphPoint {
  const angle = (-90 + (360 / GRAPH_MARK.sides) * index) * (Math.PI / 180);
  return {
    x: GRAPH_MARK.centerX + GRAPH_MARK.radius * Math.cos(angle),
    y: GRAPH_MARK.centerY + GRAPH_MARK.radius * Math.sin(angle),
  };
}

/** Vertex, the step at which the walk reaches it, and its kind. */
const GRAPH_NODES: Array<{ vertex: number; step: number; kind: GraphKind }> = [
  { vertex: 0, step: 0, kind: "domain" },
  { vertex: 1, step: 1, kind: "source" },
  { vertex: 4, step: 1, kind: "source" },
  { vertex: 2, step: 2, kind: "question" },
  { vertex: 3, step: 2, kind: "question" },
];

const BASE_MIDDLE: GraphPoint = {
  x: (graphVertex(2).x + graphVertex(3).x) / 2,
  y: graphVertex(2).y,
};

/** Each link grows from its first point during the step named. */
const GRAPH_EDGES: Array<{ from: GraphPoint; to: GraphPoint; step: number }> = [
  { from: graphVertex(0), to: graphVertex(1), step: 1 },
  { from: graphVertex(0), to: graphVertex(4), step: 1 },
  { from: graphVertex(1), to: graphVertex(2), step: 2 },
  { from: graphVertex(4), to: graphVertex(3), step: 2 },
  { from: graphVertex(2), to: BASE_MIDDLE, step: 3 },
  { from: graphVertex(3), to: BASE_MIDDLE, step: 3 },
];

const px = (value: number) => `${Math.round(value * 10) / 10}px`;

/** A graph on its way: the pentagon walk. Decorative; the region says what is loading. */
export function GraphMark() {
  return (
    <span
      className="graph-mark"
      aria-hidden="true"
      style={{ "--graph-mark-w": `${GRAPH_MARK.width}px`, "--graph-mark-h": `${GRAPH_MARK.height}px` } as CSSProperties}
    >
      <span className="graph-mark-field">
        {GRAPH_EDGES.map(({ from, to, step }, index) => (
          <i
            key={`edge-${index}`}
            className={`graph-mark-edge is-step-${step}`}
            style={{
              left: px(from.x),
              top: px(from.y),
              width: px(Math.hypot(to.x - from.x, to.y - from.y)),
              // Rounded like `px`, so the server's style and the client's agree.
              "--graph-mark-angle": `${Math.round(Math.atan2(to.y - from.y, to.x - from.x) * (1800 / Math.PI)) / 10}deg`,
            } as CSSProperties}
          />
        ))}
        {GRAPH_NODES.map(({ vertex, step, kind }) => {
          const { x, y } = graphVertex(vertex);
          const at = { left: px(x), top: px(y) };
          return [
            <i key={`ring-${vertex}`} className={`graph-mark-ring is-${kind} is-step-${step}`} style={at} />,
            <i key={`node-${vertex}`} className={`graph-mark-node is-${kind} is-step-${step}`} style={at} />,
          ];
        })}
      </span>
    </span>
  );
}

/**
 * A region filling in: its children are the outline of what will appear, and
 * one light passes over all of them. Announced by `label`, as hidden words,
 * since the outline has none.
 */
export function Skeleton({ label, className = "", children }: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return <div className={`skeleton ${className}`.trim()} role="status">
    <LoadingWords text={label} />
    {children}
  </div>;
}

/** One line or block of an outline. `tone` follows the line it stands for. */
export function SkeletonBar({ width = "100%", height, tone, className = "" }: {
  width?: string;
  height: number;
  tone?: "strong" | "tint";
  className?: string;
}) {
  return (
    <span
      className={`skeleton-bar${tone ? ` is-${tone}` : ""}${className ? ` ${className}` : ""}`}
      style={{ width, height: `${height}px` }}
    />
  );
}
