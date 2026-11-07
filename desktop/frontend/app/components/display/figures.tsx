"use client";

import { Fragment, useContext, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";
import type { Chart, Compare, Figure, Flow, FlowItem, Grid, GridItem, Key, Lane, Matrix, Node, SeriesTone, Timeline } from "../../lib/display-spec";
import { ARROW, BACK, Formula, HoverContext, Rich, TileView, TipBox, useHover } from "./parts";

const SERIES: Record<SeriesTone, string> = { blue1: "#A9C6EC", blue2: "#7AA6DE", blue3: "#4F87CF", blue4: "#2F67AE", grey: "#B5A8A4", saffron: "#D08F12", walnut: "#8A5A3C" };
const SERIES_LABEL: Partial<Record<SeriesTone, string>> = { blue1: "#6E95C9", grey: "#8A7672" };
const RAMP: SeriesTone[] = ["blue1", "blue2", "blue3", "blue4"];
const BARS = { blue: "#9DBBE3", saffron: "#EFC873", grey: "#D9CFCB" };
const KEY_TONES: Record<string, string> = { ...SERIES, ...BARS, plain: "#B5A8A4", sand: "#D9CFCB" };

export function FigureView({ figure, at }: { figure: Figure; at: number }) {
  if (figure.hidden) return null;
  const body = figure.kind === "chart" ? <ChartView chart={figure} at={at} />
    : figure.kind === "matrix" ? <MatrixView matrix={figure} at={at} />
      : figure.kind === "flow" ? <FlowView flow={figure} at={at} />
        : figure.kind === "grid" ? <GridView grid={figure} at={at} />
          : figure.kind === "timeline" ? <TimelineView timeline={figure} at={at} />
            : <CompareView compare={figure} />;
  // A timeline's series are its key; anything the spec adds follows them.
  const keys: (Key & { color?: string })[] = [...(figure.kind === "timeline" ? figure.series.map(series => ({ label: series.label, mark: "swatch" as const, color: BARS[series.tone] })) : []), ...(figure.key ?? [])];
  return <div className={`dsp-fig${figure.kind === "compare" ? " is-compare" : ""}`}>
    {figure.title ? <div className="dsp-fig-title"><Rich text={figure.title} />{figure.subtitle ? <small><Rich text={figure.subtitle} /></small> : null}</div> : null}
    {body}
    {keys.length ? <KeyRow items={keys} spaced={figure.kind === "flow"} /> : null}
  </div>;
}

function KeyRow({ items, spaced }: { items: (Key & { color?: string })[]; spaced: boolean }) {
  return <div className="dsp-key" style={spaced ? { marginTop: 10 } : undefined}>{items.map((item, index) => <span key={index}>
    {item.mark === "none" ? null : <i className={item.mark === "line" ? "" : `is-${item.mark}`} style={{ "--c": item.color ?? KEY_TONES[item.tone ?? ""] ?? (item.mark === "dash" ? "#EE9D66" : "#3E7BC9") } as CSSProperties} />}
    <Rich text={item.label} /></span>)}</div>;
}

/** The characters a label prints: TeX commands and braces take no width of their own. */
const printed = (label: string) => label.replace(/\$|\\[a-zA-Z]+|[{}^_]/g, "").length;

/* ---------- chart ---------- */

function ChartView({ chart, at }: { chart: Chart; at: number }) {
  const { hover, setHover } = useContext(HoverContext);
  const along = (axis: Chart["x"]) => (value: number) => axis.scale === "log" ? Math.log10(Math.max(value, Number.MIN_VALUE)) : value;
  const tx = along(chart.x), ty = along(chart.y);
  const xs = chart.series.flatMap(series => series.points.map(point => point.x));
  const x0 = tx(chart.x.min ?? Math.min(...xs)), x1 = tx(chart.x.max ?? Math.max(...xs));
  const ys = chart.series.flatMap(series => series.points.map(point => point.y));
  const lo = chart.y.min ?? Math.min(...ys), hi = chart.y.max ?? Math.max(...ys);
  const y0 = ty(lo), y1 = ty(hi);
  const X = (value: number) => x1 === x0 ? 50 : (tx(value) - x0) / (x1 - x0) * 100;
  const Y = (value: number) => y1 === y0 ? 50 : Math.max(0, Math.min(100, (y1 - ty(value)) / (y1 - y0) * 100));
  // The y labels stand right-aligned in the gutter, which widens for words so no gridline runs through them.
  const gutter = Math.min(120, Math.max(30, 10 + 6 * Math.max(0, ...(chart.y.ticks ?? []).map(tick => printed(tick.label)))));
  const inside = (value: number) => value >= lo && value <= hi;
  const prefix = `c${at}-`;
  const active = hover?.startsWith(prefix) ? hover.slice(prefix.length).split(":").map(Number) : null;
  const series = chart.series.map((item, index) => {
    const tone = item.tone ?? RAMP[Math.min(index, RAMP.length - 1)];
    const shown = item.points.map((point, at) => ({ point, at })).filter(({ point }) => inside(point.y));
    const best = item.points.reduce((low, point, at) => point.y < item.points[low].y ? at : low, 0);
    return { item, index, tone, color: SERIES[tone], shown, best };
  });
  const point = active ? chart.series[active[0]]?.points[active[1]] : undefined;
  return <>
    <div className="dsp-read">
      {point?.read?.length ? point.read.map((row, index) => <span key={index}><Rich text={row.label} /><b><Rich text={row.value} /></b></span>)
        : <span><Rich text={chart.hint ?? "Hover a point to read it"} /></span>}
    </div>
    <div className="dsp-chart" style={{ ...(chart.height ? { height: chart.height } : {}), ...(gutter > 30 ? { marginLeft: gutter } : {}) }}>
      {chart.y.ticks?.map((tick, index) => <span key={index} className="dsp-ylab" style={{ top: `${Y(tick.at)}%` }}><Rich text={tick.label} /></span>)}
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {chart.y.ticks?.map((tick, index) => <line key={index} x1="0" x2="100" y1={Y(tick.at)} y2={Y(tick.at)} stroke="#F1ECEA" strokeWidth="1" vectorEffect="non-scaling-stroke" />)}
        {series.filter(({ item }) => !item.dots).map(({ item, index, color, shown }) => <polyline key={index} points={shown.map(({ point }) => `${X(point.x).toFixed(2)},${Y(point.y).toFixed(2)}`).join(" ")}
          fill="none" stroke={color} strokeWidth={active?.[0] === index ? 2.4 : 1.5} strokeDasharray={item.dash ? "4 3" : undefined} vectorEffect="non-scaling-stroke" />)}
        {chart.frontier ? <polyline points={series.map(({ item, best }) => `${X(item.points[best].x).toFixed(2)},${Y(item.points[best].y).toFixed(2)}`).join(" ")}
          fill="none" stroke="#EE9D66" strokeWidth="1.5" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" /> : null}
      </svg>
      {series.flatMap(({ item, index, color, shown, best }) => shown.filter(({ point, at: pointAt }) => !item.sketch || item.dots || point.tip || point.read?.length || (chart.minimum && pointAt === best)).map(({ point, at: pointAt }) => {
        const on = active?.[0] === index && active[1] === pointAt;
        return <button key={`${index}:${pointAt}`} type="button" className={`dsp-dot${item.dots ? " is-shown" : ""}${chart.minimum && pointAt === best ? " is-min" : ""}${on ? " is-on" : ""}`}
          style={{ left: `${X(point.x)}%`, top: `${Y(point.y)}%`, "--c": color } as CSSProperties}
          aria-label={point.tip ? `${point.tip.title}${point.tip.line ? `, ${point.tip.line}` : ""}` : `${item.label ?? "Series"}: ${point.x}, ${point.y}`}
          onMouseEnter={() => setHover(`${prefix}${index}:${pointAt}`)} onFocus={() => setHover(`${prefix}${index}:${pointAt}`)} onBlur={() => setHover(null)}><i /></button>;
      }))}
      {series.map(({ item, index, tone, shown }) => {
        const last = shown.at(-1);
        // A label at the right edge sits above its line's end, inside the card.
        return item.label && last ? <span key={index} className={`dsp-clab${X(last.point.x) > 75 ? " at-end" : ""}`} style={{ left: `${X(last.point.x)}%`, top: `${Y(last.point.y)}%`, color: SERIES_LABEL[tone] ?? SERIES[tone] }}><Rich text={item.label} /></span> : null;
      })}
      {chart.x.ticks?.map((tick, index) => <span key={index} className="dsp-xlab" style={{ left: `${X(tick.at)}%` }}><Rich text={tick.label} /></span>)}
      {point?.tip ? <div className="dsp-tip" style={{ left: `${Math.max(18, Math.min(82, X(point.x)))}%`, top: `${Y(point.y)}%` }}><b><Rich text={point.tip.title} /></b>{point.tip.line ? <span><Rich text={point.tip.line} /></span> : null}</div> : null}
    </div>
  </>;
}

/* ---------- matrix ---------- */

function MatrixView({ matrix, at }: { matrix: Matrix; at: number }) {
  const width = matrix.cols.length, output = matrix.output != null || matrix.rows.some(row => row.output);
  const template = `22px repeat(${width}, minmax(34px, 1fr))${output ? " minmax(118px, 1.5fr)" : ""}`;
  return <>
    <div className="dsp-matrix" style={{ gridTemplateColumns: template, "--cols": width } as CSSProperties}>
      <span />{matrix.cols.map((col, index) => <span key={index} className="dsp-mh"><Rich text={col} /></span>)}{output ? <span className="dsp-mh at-left dsp-out-head"><Rich text={matrix.output ?? ""} /></span> : null}
      {matrix.rows.map((row, r) => <Fragment key={r}>
        <span className="dsp-mt"><Rich text={row.label} /></span>
        {row.cells.slice(0, width).map((cell, c) => <MatrixCell key={c} id={`m${at}-${r}-${c}`} cell={cell} side={c === 0 ? "l" : c === width - 1 ? "r" : ""} />)}
        {output ? <span className={`dsp-out${row.output?.on ? " is-on" : ""}`}><Rich text={row.output?.text ?? ""} /></span> : null}
      </Fragment>)}
      {matrix.foot ? <>
        {/* The row label column is 22px: a word fits beside the loads, a phrase takes a line of its own above them. */}
        {printed(matrix.foot.label) > 5 ? <><span className="dsp-loadlabel is-wide"><Rich text={matrix.foot.label} /></span><span /></>
          : <span className="dsp-loadlabel"><Rich text={matrix.foot.label} /></span>}
        {matrix.foot.items.slice(0, width).map((item, index) => <div key={index} className={`dsp-load${item.dim ? " is-dim" : ""}`}>
          <div className="dsp-chips">{item.chips.map((chip, chipAt) => <span key={chipAt} className="dsp-chip">{chip}</span>)}{item.chips.length ? null : <span className="dsp-chip-empty" />}</div>
          <small><Rich text={item.note} /></small>
        </div>)}
        {output ? <span className="dsp-out-pad" /> : null}
      </> : null}
    </div>
    {/* The narrowest column has no room for an output column: the outputs follow the table. */}
    {output ? <ul className="dsp-outs">
      {matrix.output ? <li className="dsp-outs-head"><Rich text={matrix.output} /></li> : null}
      {matrix.rows.map((row, r) => <li key={r} className={row.output?.on ? "is-on" : ""}><b><Rich text={row.label} /></b> <Rich text={row.output?.text ?? ""} /></li>)}
    </ul> : null}
  </>;
}

function MatrixCell({ id, cell, side }: { id: string; cell: Matrix["rows"][number]["cells"][number]; side: "l" | "r" | "" }) {
  const { on, bind } = useHover(id);
  const state = cell.state === "pick" ? " is-pick" : cell.state === "faint" ? " is-faint" : "";
  return <button type="button" className={`dsp-cell${state}${on ? " is-hover" : ""}`} aria-label={cell.tip ? `${cell.tip.title}${cell.tip.line ? `, ${cell.tip.line}` : ""}` : cell.value} {...bind}>
    <Rich text={cell.value} />{on ? <TipBox tip={cell.tip} side={side} /> : null}
  </button>;
}

/* ---------- flow ---------- */

function FlowView({ flow, at }: { flow: Flow; at: number }) {
  if (flow.style === "stretch") return <div className="dsp-stretch">{flow.lanes.map((lane, index) => <StretchLane key={index} lane={lane} id={`f${at}-${index}`} />)}</div>;
  return <>{flow.lanes.map((lane, index) => <div key={index} className={`dsp-lane${lane.faded ? " is-faded" : ""}`}>
    <div className="dsp-lane-name"><Rich text={lane.label} /></div>
    {lane.rows.filter(row => !row.hidden).map((row, r) => {
      const nodes = row.items.filter((item): item is Node => item.type === "node" && !item.hidden);
      return <ChainRow key={r}>{nodes.map((node, n) => <div key={n} className="dsp-cnode">
        <ChainBox node={node} id={`f${at}-${index}-${r}-${n}`} side={n < nodes.length / 2 ? "l" : "r"} />
        {n < nodes.length - 1 ? <span className={`dsp-arr${row.parallel ? " is-none" : ""}`}>{ARROW}</span> : null}
      </div>)}</ChainRow>;
    })}
    {lane.back ? <div className="dsp-back">{BACK}<Rich text={lane.back} /></div> : null}
  </div>)}</>;
}

/** A chain that wraps hides the arrow ending each line, which would point at nothing; hiding keeps its width, so the wrap holds. */
function ChainRow({ children }: { children: ReactNode }) {
  const row = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = row.current;
    if (!element) return;
    const mark = () => {
      const nodes = [...element.children] as HTMLElement[];
      // A new line starts left of where the last one ended; a narrow column's list starts below at the same left.
      nodes.forEach((node, n) => node.classList.toggle("is-break", n < nodes.length - 1 && nodes[n + 1].offsetTop > node.offsetTop + 1 && nodes[n + 1].offsetLeft < node.offsetLeft));
    };
    mark();
    const observer = new ResizeObserver(mark);
    observer.observe(element);
    return () => observer.disconnect();
  });
  return <div ref={row} className="dsp-chain">{children}</div>;
}

function ChainBox({ node, id, side }: { node: Node; id: string; side: "l" | "r" }) {
  const { on, bind } = useHover(id);
  const tone = node.tone && node.tone !== "plain" ? ` tone-${node.tone}` : "";
  return <span className={`dsp-box${tone}${node.glow ? " is-glow" : ""}${on ? " is-hover" : ""}`} tabIndex={node.tip ? 0 : undefined} {...(node.tip ? bind : {})}>
    <Rich text={node.label} />{node.note ? <small><Rich text={node.note} /></small> : null}
    {on ? <TipBox tip={node.tip} side={side} /> : null}
  </span>;
}

function StretchLane({ lane, id }: { lane: Lane; id: string }) {
  const { uid, beat } = useContext(HoverContext);
  return <div className={`dsp-s-lane${lane.faded ? " is-faded" : ""}`}>
    <span className="dsp-s-name"><Rich text={lane.label} /></span>
    {lane.rows.map((row, r) => <div key={r} className={`dsp-s-row${row.hidden ? " is-hidden" : ""}`}>
      {withArrows(row.items.filter(item => item.type !== "node" || !item.hidden)).map((item, index) => item === "arrow" ? <span key={index} className="dsp-s-arr" />
        : item.type === "link" ? <span key={index} className={`dsp-s-arr${item.style === "dashed" ? " is-dashed" : ""}`}><Formula source={item.label} /></span>
          : item.type === "tile" ? <TileView key={index} tile={item} uid={uid} beat={beat} />
            : item.hidden ? null : <StretchBox key={index} node={item} id={`${id}-${r}-${index}`} />)}
    </div>)}
    {lane.loop ? <div className={`dsp-s-outer${lane.loop.on ? " is-on" : ""}`}><span><Rich text={lane.loop.label} /></span></div> : null}
    {lane.progress ? <div className="dsp-s-foot">
      <span><Rich text={lane.progress.label} /></span>
      <span className="dsp-s-bar"><i style={{ transform: `scaleX(${Math.max(0, Math.min(1, lane.progress.value))})` }} /></span>
      {lane.progress.right ? <span><Rich text={lane.progress.right} /></span> : null}
      {lane.progress.accent ? <span className="dsp-s-accent"><Rich text={lane.progress.accent} /></span> : null}
      {lane.progress.note ? <span className="dsp-s-skip"><Rich text={lane.progress.note} /></span> : null}
    </div> : null}
  </div>;
}

/** An arrow goes between two drawn things; an explicit link replaces it. */
function withArrows(items: FlowItem[]): (FlowItem | "arrow")[] {
  const out: (FlowItem | "arrow")[] = [];
  items.forEach((item, index) => {
    const previous = items[index - 1];
    if (previous && previous.type !== "link" && item.type !== "link") out.push("arrow");
    out.push(item);
  });
  return out;
}

function StretchBox({ node, id }: { node: Node; id: string }) {
  const { on, bind } = useHover(id);
  const { beat } = useContext(HoverContext);
  // A count of ×250 still orbits a few times: the loop shows repetition, it does not count it out.
  const times = Math.min(3, Number.parseInt(node.repeat?.count.replace(/\D/g, "") ?? "", 10) || 1);
  const classes = ["dsp-s-box", node.tone && node.tone !== "plain" ? `tone-${node.tone}` : "", node.glow ? "is-glow" : "",
    node.repeat?.off ? "is-off" : "", node.repeat?.run && !node.repeat.off ? "is-run" : "", on ? "is-hover" : ""].filter(Boolean).join(" ");
  return <div className={classes} style={{ "--k": times } as CSSProperties} tabIndex={node.tip ? 0 : undefined} {...(node.tip ? bind : {})}>
    {node.repeat ? <><span key={beat} className="dsp-s-loop"><i /></span><span className="dsp-s-cnt">{node.repeat.count}</span></> : null}
    <b><Rich text={node.label} /></b><Formula source={node.math} />
    {on ? <TipBox tip={node.tip} /> : null}
  </div>;
}

/* ---------- grid ---------- */

const span = (start: number, count = 1) => `${start} / span ${Math.max(1, count)}`;

function GridView({ grid, at }: { grid: Grid; at: number }) {
  const columns = typeof grid.columns === "number" ? Array.from({ length: grid.columns }, () => "node" as const) : grid.columns;
  const blocks = !columns.includes("link");
  const template = columns.map(column => column === "link" ? "20px" : "minmax(0, 1fr)").join(" ");
  const groups = grid.items.filter((item): item is Extract<GridItem, { type: "group" }> => item.type === "group");
  // The last row inside a group keeps a little of the group's colour below it.
  const closesGroup = (item: GridItem) => groups.some(group => item.col >= group.col && item.col < group.col + (group.cols ?? 1)
    && item.row + (item.rows ?? 1) === group.row + (group.rows ?? 1));
  const count = columns.length;
  return <div className={`dsp-grid${blocks ? " is-blocks" : ""}`} style={{ gridTemplateColumns: template }}>
    {grid.items.map((item, index) => {
      const style = { gridColumn: span(item.col, item.cols), gridRow: span(item.row, item.rows) };
      const id = `g${at}-${index}`, side = item.col === 1 ? "l" : item.col + (item.cols ?? 1) > count ? "r" : "";
      if (item.type === "text") return <div key={index} className="dsp-ch" style={style}><Rich text={item.text} /></div>;
      if (item.type === "group") return <div key={index} className={`dsp-group tone-${item.tone}`} style={style} />;
      if (item.type === "arrow") {
        // A hidden grid part keeps its place, so the grid does not move when it appears.
        const hide = item.hidden ? " dsp-hide" : "", quiet = item.hidden || undefined;
        if (item.dir === "right") return item.pill
          ? <div key={index} className={`dsp-hc${hide}`} aria-hidden={quiet} style={style}><i className="dsp-ahl" /><GridNode node={{ ...item.pill, look: "pill" }} id={`${id}-pill`} side={side} /><i className="dsp-ahl" /></div>
          : <div key={index} className={`dsp-ahl${hide}`} aria-hidden={quiet} style={style} />;
        return <div key={index} className={`dsp-vc${hide}`} aria-hidden={quiet} style={style}>
          {item.pill ? <><i className={`dsp-vl${item.dir === "down" ? "" : " dir-up"}`} /><GridNode node={{ ...item.pill, look: "pill" }} id={`${id}-pill`} side={side} /><i className={`dsp-vl${item.dir === "up" ? "" : " dir-down"}`} /></>
            : <i className={`dsp-vl dir-${item.dir}`} />}
        </div>;
      }
      return <div key={index} className={item.hidden ? "dsp-hide" : undefined} aria-hidden={item.hidden || undefined} style={{ ...style, ...(closesGroup(item) ? { paddingBottom: 5 } : {}) }}><GridNode node={item} id={id} side={side} /></div>;
    })}
  </div>;
}

function GridNode({ node, id, side }: { node: Node; id: string; side: "l" | "r" | "" }) {
  const { on, bind } = useHover(id);
  const classes = ["dsp-nd", node.tone && node.tone !== "plain" ? `tone-${node.tone}` : "", node.look && node.look !== "box" ? `look-${node.look}` : "", node.glow ? "is-glow" : "", on ? "is-hover" : ""].filter(Boolean).join(" ");
  return <div className={classes} tabIndex={node.tip ? 0 : undefined} {...(node.tip ? bind : {})}>
    <Rich text={node.label} />
    {node.note ? <small>{node.short ? <><span className="is-long"><Rich text={node.note} /></span><span className="is-short"><Rich text={node.short} /></span></> : <Rich text={node.note} />}</small> : null}
    {on ? <TipBox tip={node.tip} side={side} /> : null}
  </div>;
}

/* ---------- timeline ---------- */

function TimelineView({ timeline, at }: { timeline: Timeline; at: number }) {
  const scale = (value: number) => Math.max(0, Math.min(100, value / timeline.max * 100));
  const rank = new Map(timeline.series.map((series, index) => [series.id, index]));
  const place = (series: string) => timeline.series.length === 1 ? "at-middle" : rank.get(series) === 0 ? "at-top" : "at-bottom";
  const color = (series: string) => BARS[timeline.series.find(item => item.id === series)?.tone ?? "grey"];
  return <>
    {timeline.panels.map((panel, p) => <Fragment key={p}>
      <div className="dsp-tl-title"><Rich text={panel.title} />{panel.note ? <small><Rich text={panel.note} /></small> : null}</div>
      <div className="dsp-tl">
        {panel.lanes.map((lane, l) => <Fragment key={l}>
          <span className="dsp-tl-label"><Rich text={lane.label} /></span>
          <div className="dsp-track">
            {panel.end != null ? <span className="dsp-done" style={{ left: `${scale(panel.end)}%` }} /> : null}
            {lane.bars.map((bar, b) => <TimelineBar key={b} id={`t${at}-${p}-${l}-${b}`} left={scale(bar.start)} width={scale(bar.end) - scale(bar.start)}
              className={place(bar.series)} color={color(bar.series)} tip={bar.tip} side={bar.start > timeline.max / 2 ? "r" : "l"} />)}
          </div>
        </Fragment>)}
        {panel.end != null ? <div className="dsp-tl-foot">
          <span className={`dsp-end${scale(panel.end) > 60 ? " at-r" : ""}`} style={{ left: `${scale(panel.end) + (scale(panel.end) > 60 ? 0.6 : 0)}%` }}>
            <Rich text={panel.endLabel ?? "done at"} /> <b>{panel.end}</b></span>
        </div> : null}
      </div>
    </Fragment>)}
  </>;
}

function TimelineBar({ id, left, width, className, color, tip, side }: { id: string; left: number; width: number; className: string; color: string; tip?: { title: string; line?: string }; side: "l" | "r" }) {
  const { on, bind } = useHover(id);
  return <button type="button" className={`dsp-bar ${className}${on ? " is-hover" : ""}`} style={{ left: `${left}%`, width: `${width}%`, "--c": color } as CSSProperties}
    aria-label={tip ? `${tip.title}${tip.line ? `, ${tip.line}` : ""}` : undefined} {...bind}>{on ? <TipBox tip={tip} side={side} /> : null}</button>;
}

/* ---------- compare ---------- */

function CompareView({ compare }: { compare: Compare }) {
  const { uid, beat } = useContext(HoverContext);
  return <div className="dsp-compare">
    {compare.tiles.map((tile, index) => <TileView key={index} tile={tile} uid={uid} beat={beat} />)}
    <p>{compare.lead ? <b><Rich text={compare.lead} /> </b> : null}<Rich text={compare.text} /></p>
  </div>;
}
