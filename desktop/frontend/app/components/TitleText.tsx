import { Fragment, useEffect, useMemo, useState } from "react";

import { titleSegments } from "../lib/latex";

type Katex = typeof import("katex").default;
// Most titles hold no math, so KaTeX stays out of the routes that list them.
let loaded: Katex | undefined;
let loading: Promise<Katex> | undefined;

/**
 * A title with its mathematics typeset. KaTeX's own output is the only markup
 * set here, with `trust` left off; an expression it cannot parse is shown as
 * the source the model wrote, which is what the row showed before.
 */
export default function TitleText({ title }: { title: string }) {
  const segments = useMemo(() => titleSegments(title), [title]);
  const math = segments.some(segment => "math" in segment);
  const [katex, setKatex] = useState(loaded);
  useEffect(() => {
    if (!math || katex) return;
    let live = true;
    loading ??= import("katex").then(module => (loaded = module.default));
    loading.then(value => { if (live) setKatex(value); }, () => { loading = undefined; });
    return () => { live = false; };
  }, [math, katex]);
  const parts = useMemo(() => katex ? segments.map(segment => {
    if ("text" in segment) return segment.text;
    try {
      return { html: katex.renderToString(segment.math, { throwOnError: true, strict: false }) };
    } catch {
      return segment.source;
    }
  }) : [title], [katex, segments, title]);
  if (parts.every(part => typeof part === "string")) return <>{title}</>;
  return <>{parts.map((part, index) => typeof part === "string"
    ? <Fragment key={index}>{part}</Fragment>
    : <span key={index} className="title-math" dangerouslySetInnerHTML={{ __html: part.html }} />)}</>;
}
