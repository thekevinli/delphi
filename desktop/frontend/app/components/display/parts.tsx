"use client";

import katex from "katex";
import { createContext, Fragment, useContext, useMemo } from "react";
import { mathSegments, type Tip, type Tile } from "../../lib/display-spec";

/** Which element the pointer is on, the display's id prefix, and the state it shows (`beat`, which restarts a state's animations). */
export const HoverContext = createContext<{ hover: string | null; setHover: (key: string | null) => void; uid: string; beat: string }>({ hover: null, setHover: () => {}, uid: "d", beat: "" });

export function useHover(key: string) {
  const { hover, setHover } = useContext(HoverContext);
  const on = hover === key;
  return { on, bind: { onMouseEnter: () => setHover(key), onFocus: () => setHover(key), onBlur: () => setHover(null) } };
}

const cache = new Map<string, string>();
function tex(source: string) {
  let html = cache.get(source);
  if (html === undefined) {
    // Labels are short: no macros that grow, no links or HTML, nothing that can fail loudly.
    html = katex.renderToString(source, { throwOnError: false, strict: "ignore", trust: false, maxSize: 4, maxExpand: 40, output: "html" });
    if (cache.size > 500) cache.clear();
    cache.set(source, html);
  }
  return html;
}

/** Text with inline `$TeX$`. */
export function Rich({ text }: { text?: string }) {
  const parts = useMemo(() => mathSegments(text ?? ""), [text]);
  return <>{parts.map((part, index) => {
    if (part.math === undefined) {
      const glued = parts[index - 1]?.math !== undefined ? TRAILING.exec(part.text ?? "")?.[0].length ?? 0 : 0;
      return <span key={index}>{breakable((part.text ?? "").slice(glued))}</span>;
    }
    // Punctuation right after math stays on its line, as it would after a word.
    const after = parts[index + 1]?.math === undefined ? TRAILING.exec(parts[index + 1]?.text ?? "")?.[0] : undefined;
    const formula = <span className="dsp-mx" dangerouslySetInnerHTML={{ __html: tex(part.math) }} />;
    return after ? <span key={index} className="dsp-glue">{formula}{after}</span> : <Fragment key={index}>{formula}</Fragment>;
  })}</>;
}

const TRAILING = /^[.,;:!?)\]’”]+/;

/** A long identifier (`thinker_forward`, `a/b`, `Thinker2Talker`) may break at its seams in a narrow column. */
function breakable(text: string) {
  const pieces = text.split(/(?<=[_/])(?=\w)|(?<=\d)(?=[A-Z])/);
  return pieces.length === 1 ? text : pieces.map((piece, index) => <Fragment key={index}>{index ? <wbr /> : null}{piece}</Fragment>);
}

/** A whole TeX label, as tiles, links and a box's formula carry. */
export function Formula({ source, className = "dsp-mx" }: { source?: string; className?: string }) {
  if (!source) return null;
  return <span className={className} dangerouslySetInnerHTML={{ __html: tex(source) }} />;
}

export function TipBox({ tip, side }: { tip?: Tip; side?: "l" | "r" | "" }) {
  if (!tip) return null;
  return <span className={`dsp-tip${side ? ` at-${side}` : ""}`} role="tooltip"><b><Rich text={tip.title} /></b>{tip.line ? <span><Rich text={tip.line} /></span> : null}</span>;
}

export const ARROW = <svg width="12" height="10" viewBox="0 0 12 10" aria-hidden="true"><path d="M1 5h9M7 2l3 3-3 3" /></svg>;
export const BACK = <svg width="14" height="12" viewBox="0 0 14 12" aria-hidden="true"><path d="M13 2H4a3 3 0 0 0 0 6h7M3 8l-2 0M8 5l3 3-3 3" /></svg>;
const CHECK = <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true"><path d="m2 5 2 2 4-4" /></svg>;

/**
 * A stand-in image the library draws: a small landscape, blurred, noised or
 * broken by the amounts the spec gives. It shows what happens to an image, never
 * what a paper's own samples looked like.
 */
export function TileView({ tile, uid, beat }: { tile: Tile; uid: string; beat?: string }) {
  const blur = clamp(tile.blur ?? 0, 0, 8), noise = clamp(tile.noise ?? 0, 0, 1), defect = clamp(tile.defect ?? 0, 0, 1);
  const filter = blur > 0 ? `${uid}-b${String(blur).replace(".", "_")}` : "";
  const classes = ["dsp-s-tile", tile.dim ? "is-dim" : "", tile.glow ? "is-glow" : "", tile.grow ? "is-grow" : ""].filter(Boolean).join(" ");
  return <div className={classes} title={tile.tip?.title}>
    {tile.empty ? <div className="dsp-s-empty" /> : <svg key={tile.grow ? beat : undefined} viewBox="0 0 64 64" aria-hidden="true">
      {filter ? <defs><filter id={filter}><feGaussianBlur stdDeviation={blur} /></filter></defs> : null}
      <g filter={filter ? `url(#${filter})` : undefined}>
        <rect width="64" height="64" fill="#F6E3CF" /><circle cx="42" cy="21" r="9" fill="#EE9D66" />
        <path d="M-6 56 L22 22 L33 36 L42 28 L70 56 Z" fill="#8A5A3C" /><rect y="52" width="64" height="12" fill="#C9AE98" />
      </g>
      <g opacity={defect}><path d="M17 28 l6 -7 l3 9 l5 -2 l-3 9 l-8 -1 z" fill="#F6E3CF" /><circle cx="12" cy="14" r="4.5" fill="#5A4540" opacity=".75" /></g>
      {noise > 0 ? <rect width="64" height="64" fill="#888" filter={`url(#${uid}-noise)`} opacity={noise} /> : null}
    </svg>}
    <span className={`dsp-s-ring${tile.ring ? " is-on" : ""}`} />
    <span className={`dsp-s-fix${tile.fix ? " is-on" : ""}`}>{CHECK}</span>
    {tile.tag ? <span className="dsp-s-tag">{tile.tag}</span> : null}
    <Formula source={tile.label} />
  </div>;
}

/** The one shared noise texture every tile in a display uses. */
export function TileDefs({ uid }: { uid: string }) {
  return <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true"><defs>
    <filter id={`${uid}-noise`} x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="7" /><feColorMatrix type="saturate" values="0" /></filter>
  </defs></svg>;
}

function clamp(value: number, low: number, high: number) {
  return Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : low;
}

