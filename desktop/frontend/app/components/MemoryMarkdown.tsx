"use client";

/**
 * Rendering a Memory page.
 *
 * Everything `markdown.tsx` does for an answer, plus the three things only a
 * wiki page has: `[[links]]` that resolve to other pages, `figure:<id>` images
 * that resolve to Delphi's own route, and Mermaid diagrams.
 *
 * Kept separate from `markdown.tsx` rather than adding modes to it, because the
 * differences are about trust boundaries rather than styling. Memory pages
 * resolve stored figures and sanitize Mermaid output. A chat may additionally
 * render explicit visualization fences, whose scripts live only in an opaque
 * iframe and never enter this document's DOM.
 */

import {
  type ComponentPropsWithoutRef,
  createContext,
  createElement,
  Fragment,
  memo,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";

import type { MemoryFigure } from "../lib/api";
import { answerMarkdown } from "../lib/answer-references";
import { blockContext, type CitationTarget, libraryLink, type PaperAlias, paperAliases } from "../lib/citations";
import {
  figureById,
  figureSrc,
  type KnownPages,
  splitWikiLinks,
  wikiLinkWords,
} from "../lib/memory";
import { remarkLegacyMath } from "../lib/remark-latex";

import { isWebUrl, sourceFor, type WebSource } from "../lib/web-sources";
import { MathSpan } from "./MathSpan";
import { InsideLink, MemoryLink } from "./MemoryLink";
import { WebCitation } from "./WebCitation";
import { ArtifactMarkdown, ArtifactPre } from "./InlineArtifact";
import { BlockScope, CitationLink, CitedCode, type LibraryPapers, plainText, Uncited, withCitations } from "./markdown";
import { REMARK_PLUGINS, REHYPE_PLUGINS } from "../lib/markdown-pipeline";

const MEMORY_PLUGINS = [...REMARK_PLUGINS, remarkLegacyMath];

/**
 * Which URLs survive into the DOM at all.
 *
 * react-markdown strips any protocol it does not recognise, and `figure:` is
 * one — so without this, every captured figure silently degrades to its alt
 * text. Widening the allowlist to exactly one Delphi locator is also the
 * strictest possible version of invariant 37: a body cannot carry a remote
 * address even as an anchor, because nothing else gets through.
 */
const ALLOWED_URL = /^figure:[A-Za-z0-9_-]{1,32}$/;

function urlTransform(url: string, key: string, webLinks = false): string {
  // A chat answer may cite the web. A Memory page never may (invariant 37), so
  // this is on only where the caller says the text is an answer.
  if (webLinks && key === "href" && isWebUrl(url)) return url;
  return ALLOWED_URL.test(url) ? url : "";
}

/**
 * The engine, warmed once and shared.
 *
 * A module-level promise for the same reason `PdfViewer` warms pdf.js that way:
 * the cold import is the expensive part, not the render, and importing it per
 * diagram would make a page with four of them pay four times. Lazy, so the
 * reading workspace — which never renders a diagram — never loads it at all.
 */
let enginePromise: Promise<typeof import("mermaid").default> | null = null;

function engine() {
  if (!enginePromise) {
    enginePromise = import("mermaid").then((module) => {
      module.default.initialize({
        startOnLoad: false,
        // Model-authored text entering the reader's DOM. `strict` blocks the
        // click bindings and raw HTML that mermaid otherwise allows in a
        // diagram definition — the same untrusted-content posture already
        // applied to SKILLS.md and to marketplace personas.
        securityLevel: "strict",
        theme: "neutral",
        // Deliberately *not* `fontFamily: "inherit"`. Mermaid measures label
        // widths with the font it is configured with and renders with whatever
        // CSS resolves to; inheriting Delphi's face made it size every box for
        // one font and draw another, clipping "reconstruction" to "reconstructi".
        // A diagram in the page's own typeface is not worth an unreadable one.
      });
      return module.default;
    });
  }
  return enginePromise;
}

function Mermaid({ definition }: { definition: string }) {
  // Mermaid stamps the id into the SVG it returns, so two diagrams sharing one
  // would collide in the DOM. `useId` is stable across renders and unique per
  // instance, which a module-level counter is not once React remounts anything.
  const identity = `kb-diagram-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [render, setRender] = useState<{ svg: string; failed: boolean }>({
    svg: "",
    failed: false,
  });

  useEffect(() => {
    let live = true;
    engine()
      .then((mermaid) => mermaid.render(identity, definition))
      .then((result) => {
        if (live) setRender({ svg: result.svg, failed: false });
      })
      .catch(() => {
        // A diagram the model wrote wrong must not take the page down with it.
        // Falling back to the source is also honest: it shows exactly what was
        // written, which is what someone fixing it needs.
        if (live) setRender({ svg: "", failed: true });
      });
    return () => {
      live = false;
    };
  }, [definition, identity]);

  const { svg, failed } = render;
  if (failed) {
    return (
      <figure className="kb-diagram kb-diagram-failed">
        <pre>
          <code>{definition}</code>
        </pre>
        <figcaption>This diagram could not be drawn.</figcaption>
      </figure>
    );
  }
  if (!svg) return <div className="kb-diagram kb-diagram-loading" />;
  return (
    <div
      className="kb-diagram"
      // Mermaid's own output, produced under securityLevel: "strict" from a
      // definition it parsed itself. The model's text never reaches here as
      // markup — only as a diagram description mermaid has already sanitised.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/** `[E1]`, `[E2][E3]` — a run of evidence markers, as they appear in prose. */
const MARKERS = /(?:\[E\d{1,2}\])+/g;
const MARKER_ID = /E(\d{1,2})/g;

/**
 * Set a run of evidence markers as one citation, the way a digest cites:
 * `[E1][E6]` reads "(E1, E6)" in the citation face. At body weight, or as a
 * string of raised marks, they read as noise in the middle of a sentence —
 * which is exactly how a reader learns to skip the one thing that says where
 * a claim came from.
 */
/**
 * What a page passes in to make one marker open what it cites: the passage in
 * its document, or the captured outside source. Null leaves the marker as
 * text — a `derived` claim names no source, and a document that has left the
 * library has nowhere to open.
 */
export type CiteMarker = (id: number) => ReactNode | null;

function marks(text: string, key: string, cite?: CiteMarker): ReactNode {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(MARKERS)) {
    const start = match.index ?? 0;
    if (start > cursor) parts.push(text.slice(cursor, start));
    const ids = [...match[0].matchAll(MARKER_ID)].map((id) => Number(id[1]));
    parts.push(
      <span className="digest-citation" key={`${key}-e${start}`}>
        (
        {ids.map((id, index) => (
          <Fragment key={id}>
            {index ? ", " : null}
            <Marker id={id} cite={cite} />
          </Fragment>
        ))}
        )
      </span>,
    );
    cursor = start + match[0].length;
  }
  if (!parts.length) return text;
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

/** One marker, as text inside a link the author wrote: a link cannot hold another. */
function Marker({ id, cite }: { id: number; cite?: CiteMarker }) {
  return (useContext(InsideLink) ? null : cite?.(id)) ?? `E${id}`;
}

/** Turn `[[slug]]` inside rendered text into a Memory link (`MemoryLink`). */
function wikify(
  children: ReactNode,
  onOpen: ((slug: string) => void) | undefined,
  pages: KnownPages,
  cite?: CiteMarker,
  /** What a chat answer does to the rest of its prose: its citations become links. */
  prose?: (text: string) => ReactNode,
): ReactNode {
  return mapStrings(children, (text, key) =>
    splitWikiLinks(text).map((segment, index) => {
      if (segment.kind === "text") {
        const marked = marks(segment.text, `${key}-${index}`, cite);
        return <Fragment key={`${key}-${index}`}>{prose ? mapStrings(marked, prose) : marked}</Fragment>;
      }
      return <MemoryLink key={`${key}-${index}`} link={segment} pages={pages} onOpen={onOpen} />;
    }),
  );
}

function mapStrings(
  children: ReactNode,
  transform: (text: string, key: string) => ReactNode,
): ReactNode {
  if (typeof children === "string") return transform(children, "s");
  if (Array.isArray(children)) {
    return children.map((child, index) =>
      typeof child === "string" ? (
        <Fragment key={index}>{transform(child, String(index))}</Fragment>
      ) : (
        child
      ),
    );
  }
  return children;
}

/**
 * What a chat answer's prose needs to draw a citation of a document as a link,
 * by the rules `markdown.tsx` draws them by. Null on a Memory page, whose
 * evidence is its `[E#]` markers and nothing it might happen to say.
 */
type Citing = {
  onCitation: (target: CitationTarget) => void;
  papers: LibraryPapers;
  followable?: (target: CitationTarget) => boolean;
  source: string;
  aliases: PaperAlias[];
};
const CitingScope = createContext<Citing | null>(null);

type ProseTag = "p" | "li" | "em" | "strong" | "del" | "td" | "th" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6";

/**
 * One element of prose with its strings rewritten. A block reads the paper it
 * is about from its own range of the source, and the inline elements inside it
 * inherit that, exactly as an answer beside a document does; a heading or a
 * header cell never cites.
 */
function Prose({
  tag,
  node,
  block = false,
  cites = true,
  attributes,
  linkify,
  children,
}: {
  tag: ProseTag;
  node?: { position?: { start?: { offset?: number }; end?: { offset?: number } } };
  block?: boolean;
  cites?: boolean;
  attributes?: object;
  linkify: (children: ReactNode, prose?: (text: string) => ReactNode) => ReactNode;
  children?: ReactNode;
}) {
  const citing = useContext(CitingScope);
  const inherited = useContext(BlockScope);
  const insideLink = useContext(InsideLink);
  const uncited = useContext(Uncited) || !cites;
  const start = node?.position?.start?.offset, end = node?.position?.end?.offset;
  const context = useMemo(
    () => (block && citing ? blockContext(citing.source, citing.aliases, start, end) : inherited),
    [block, citing, start, end, inherited],
  );
  const prose = citing && !uncited && !insideLink
    ? (text: string) => withCitations(text, citing.onCitation, context, citing.followable)
    : undefined;
  const content = linkify(children, prose);
  const scoped = block ? <BlockScope.Provider value={context}>{content}</BlockScope.Provider> : content;
  return createElement(tag, attributes, cites ? scoped : <Uncited.Provider value={true}>{scoped}</Uncited.Provider>);
}

/**
 * A chat answer's link to a page the library holds opens the library's copy in
 * the reader (`libraryLink`); any other link is drawn as it was.
 */
function KeptLink({ href, label, children }: { href: string; label: ReactNode; children: ReactNode }) {
  const citing = useContext(CitingScope);
  const kept = citing ? libraryLink(href, plainText(label), citing.papers) : null;
  return kept && citing ? <CitationLink target={kept} onCitation={citing.onCitation} /> : <>{children}</>;
}

/** Code in a chat answer that is one citation and nothing else is drawn as it (`CitedCode`). */
function ProseCode(props: ComponentPropsWithoutRef<"code">) {
  const citing = useContext(CitingScope);
  return <CitedCode {...props} onCitation={citing?.onCitation} followable={citing?.followable} />;
}

/** A paragraph whose whole content is one image — markdown's way of saying
    "figure", and the one case the `<p>` wrapper has to be dropped for. */
function isLoneImage(node: unknown): boolean {
  const children = (node as { children?: Array<{ type?: string; tagName?: string; value?: string }> })
    ?.children;
  if (!children) return false;
  const real = children.filter(
    (child) => !(child.type === "text" && !child.value?.trim()),
  );
  return real.length === 1 && real[0].tagName === "img";
}

type FigureProps = ComponentPropsWithoutRef<"img"> & { figures: MemoryFigure[] };

function MemoryImage({ src, alt, figures }: FigureProps) {
  const resolved = figureSrc(typeof src === "string" ? src : undefined);
  const figure = figureById(figures, typeof src === "string" ? src : undefined);
  const [broken, setBroken] = useState(false);

  // Anything that is not a `figure:` locator is refused outright. A remote
  // address in a rendered body would leak the reader's IP and referrer to
  // whichever host the model happened to name, and would rot.
  if (!resolved) {
    return <span className="kb-figure-missing">{alt || "figure"}</span>;
  }
  if (broken) {
    return null;
  }
  // `bytes` in the query so a re-captured figure (same id, new WebP) is not
  // stuck behind the route's private max-age — the URL the browser keyed the
  // broken Seedance/DeepSeek captures under would otherwise keep serving them
  // for an hour after the bytes on disk had already been fixed.
  const srcWithVersion =
    figure && typeof figure.bytes === "number"
      ? `${resolved}?v=${figure.bytes}`
      : resolved;
  const locator = figure?.origin?.page
    ? `From p. ${figure.origin.page}`
    : figure?.origin?.url
      ? "From source"
      : null;
  return (
    <figure className="kb-figure">
      <img
        src={srcWithVersion}
        alt={figure?.alt || alt || figure?.caption || ""}
        loading="lazy"
        onError={() => setBroken(true)}
      />
      {figure?.caption ? (
        <figcaption>
          <span>{figure.caption}</span>
          <small>{locator}</small>
        </figcaption>
      ) : null}
    </figure>
  );
}

function MemoryBody({
  body,
  figures,
  pages,
  onOpen,
  webLinks = false,
  sources,
  cite,
  artifacts = false,
  streaming = false,
  onCitation,
  followable,
  papers,
}: {
  body: string;
  figures: MemoryFigure[];
  /** The pages a `[[slug]]` can open, with the title and kind it is drawn by. */
  pages: KnownPages;
  /** Absent where nothing can open a page: its names then read as words. */
  onOpen?: (slug: string) => void;
  /** The text is a chat answer, which may link to the web. A page may not. */
  webLinks?: boolean;
  /** The web pages a chat answer cites, so their links can say so. */
  sources?: WebSource[];
  /** A Memory page's `[E#]` markers, made to open what they cite. */
  cite?: CiteMarker;
  /** Explicitly enabled by assistant chat; stored Memory pages stay inert. */
  artifacts?: boolean;
  streaming?: boolean;
  /** A chat answer's citations of documents, and what follows one. A page has none. */
  onCitation?: (target: CitationTarget) => void;
  /** Whether a citation has anywhere to go in the library; one that has not stays prose. */
  followable?: (target: CitationTarget) => boolean;
  /** The library a citation may name, so a nameless one can be placed by its block. */
  papers?: LibraryPapers;
}) {
  const components = useMemo<Components>(() => {
    const linkify = (children: ReactNode, prose?: (text: string) => ReactNode) =>
      wikify(children, onOpen, pages, cite, prose);
    return {
      span: MathSpan,
      pre: ArtifactPre,
      p: ({ children, node }) =>
        // A figure is a block, and `<figure>` inside `<p>` is invalid HTML: the
        // parser closes the paragraph early, React's tree stops matching the
        // DOM, and hydration tears down the subtree — which is why a captured
        // figure rendered as its caption alone. Markdown puts a lone image in a
        // paragraph, so the paragraph is what has to go.
        isLoneImage(node) ? (
          <>{children}</>
        ) : (
          <Prose tag="p" node={node} block linkify={linkify}>{children}</Prose>
        ),
      li: ({ children, node }) => <Prose tag="li" node={node} block linkify={linkify}>{children}</Prose>,
      em: ({ children }) => <Prose tag="em" linkify={linkify}>{children}</Prose>,
      strong: ({ children }) => <Prose tag="strong" linkify={linkify}>{children}</Prose>,
      // Struck text is retracted, and never cites.
      del: ({ children }) => <Prose tag="del" cites={false} linkify={linkify}>{children}</Prose>,
      td: ({ children, node }) => <Prose tag="td" node={node} block linkify={linkify}>{children}</Prose>,
      ...Object.fromEntries((["th", "h1", "h2", "h3", "h4", "h5", "h6"] as const).map((tag) => [
        tag,
        ({ children, node: _node, ...props }: ComponentPropsWithoutRef<typeof tag> & { node?: unknown }) => (
          <Prose tag={tag} cites={false} attributes={props} linkify={linkify}>{children}</Prose>
        ),
      ])),
      img: (props) => <MemoryImage {...props} figures={figures} />,
      a: ({ href, children, node: _node, ...props }) => {
        const web: boolean = webLinks && isWebUrl(href);
        // A link cannot hold another: a `[[slug]]` inside one reads as its words.
        const label = mapStrings(children, (text) => wikiLinkWords(text, pages));
        // A page on the web opens outside the app; a cited one is a chip.
        const cited = web && href ? sourceFor(href, sources) : undefined;
        const link = cited ? <WebCitation source={cited} /> : (
          <InsideLink.Provider value={true}>
            {web ? <a {...props} href={href} target="_blank" rel="noopener noreferrer">{label}</a> : <a {...props} href={href}>{label}</a>}
          </InsideLink.Provider>
        );
        return web && href ? <KeptLink href={href} label={children}>{link}</KeptLink> : link;
      },
      table: ({ children }) => (
        <div className="markdown-table-scroll">
          <table>{children}</table>
        </div>
      ),
      code: ({ className, children, node: _node, ...rest }) => {
        const definition = String(children ?? "").trim();
        if (/\blanguage-mermaid\b/.test(className ?? "") && definition) {
          return <Mermaid definition={definition} />;
        }
        return <ProseCode className={className} {...rest}>{children}</ProseCode>;
      },
    };
  }, [figures, pages, onOpen, webLinks, sources, cite]);
  // A chat answer is read as `answerMarkdown` reads it, so its Sources list and
  // its links measure blocks against one string.
  const markdown = useMemo(() => (webLinks ? answerMarkdown(body, sources) : body), [body, webLinks, sources]);
  const aliasKey = (papers ?? []).map((paper) => paper.title).join("\u0000");
  const aliases = useMemo(
    () => paperAliases(papers ?? []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [aliasKey],
  );
  const citing = useMemo<Citing | null>(
    () => (onCitation ? { onCitation, followable, papers: papers ?? [], source: markdown, aliases } : null),
    [onCitation, followable, papers, markdown, aliases],
  );

  return (
    <ArtifactMarkdown.Provider value={{ source: markdown, enabled: artifacts, streaming }}>
      <CitingScope.Provider value={citing}>
        <ReactMarkdown
          remarkPlugins={MEMORY_PLUGINS}
          rehypePlugins={REHYPE_PLUGINS}
          urlTransform={(url, key) => urlTransform(url, key, webLinks)}
          components={components}
        >
          {markdown}
        </ReactMarkdown>
      </CitingScope.Provider>
    </ArtifactMarkdown.Provider>
  );
}

export const MemoizedMemoryBody = memo(MemoryBody);
