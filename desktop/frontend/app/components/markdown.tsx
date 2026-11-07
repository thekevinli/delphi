"use client";

/**
 * Rendering a model answer.
 *
 * Markdown, maths, and the citations and Memory links the model writes into its
 * prose — the things that turn a stream of tokens into something a reader can
 * follow back to its evidence. Kept apart from the workspace because
 * `textual()`'s memoization is a genuine trap: it mints component types, and
 * React treats a new type as a different component, so building these inline
 * unmounted every paragraph of every answer on each render.
 */

import {
  Children,
  type ComponentPropsWithoutRef,
  createContext,
  createElement,
  Fragment,
  isValidElement,
  memo,
  type ReactNode,
  useContext,
  useMemo,
  useRef,
} from "react";
import ReactMarkdown, {
  type Components,
  type ExtraProps,
} from "react-markdown";

import { answerMarkdown } from "../lib/answer-references";
import {
  blockContext,
  type BlockContext,
  type CitationTarget,
  NO_BLOCK,
  type PaperAlias,
  paperAliases,
  libraryLink,
  segmentCitations,
  wholeCitation,
} from "../lib/citations";
import { type KnownPages, splitWikiLinks, wikiLinkWords } from "../lib/memory";
import { isWebUrl, sourceFor, type WebSource } from "../lib/web-sources";
import { MathSpan } from "./MathSpan";
import { InsideLink, MemoryLink } from "./MemoryLink";
import { WebCitation } from "./WebCitation";
import { ArtifactMarkdown, ArtifactPre } from "./InlineArtifact";
import { REMARK_PLUGINS, REHYPE_PLUGINS } from "../lib/markdown-pipeline";

/**
 * Walks rendered markdown children and turns any citation the model wrote into
 * an inline link that jumps the reader to that page. It stays a real inline
 * box, rather than a button, so a long locator can wrap with the sentence
 * instead of abandoning the unused half of a line. Only string children are
 * rewritten; nested elements are handled by their own renderer below.
 */
export function withCitations(
  children: ReactNode,
  onCitation?: (target: CitationTarget) => void,
  block: BlockContext = NO_BLOCK,
  /** Whether a citation has anywhere to go; one that has not stays prose. */
  followable: (target: CitationTarget) => boolean = () => true,
): ReactNode {
  if (!onCitation) return children;
  return Children.map(children, (child, childIndex) => {
    if (typeof child !== "string") return child;
    const pieces = segmentCitations(child, block.paper, block).map((piece): typeof piece =>
      piece.kind === "citation" && !followable(piece.target) ? { kind: "text", text: piece.target.text } : piece);
    if (pieces.length === 1 && pieces[0].kind === "text") return child;
    // A parenthetical that is one citation and nothing else loses its
    // parentheses: the chip already reads as an aside.
    const bracket = (index: number, text: string) => {
      const piece = pieces[index];
      return piece?.kind === "text" && piece.text === text;
    };
    const lone = (index: number) =>
      pieces[index - 1]?.kind === "citation" && bracket(index - 2, "(") && bracket(index, ")") ||
      pieces[index + 1]?.kind === "citation" && bracket(index, "(") && bracket(index + 2, ")");
    return pieces.map((piece, index) =>
      piece.kind === "text" ? (
        lone(index) ? null : (
          <Fragment key={`${childIndex}-${index}`}>{piece.text}</Fragment>
        )
      ) : (
        <CitationLink key={`${childIndex}-${index}`} target={piece.target} onCitation={onCitation} />
      ),
    );
  });
}

/** The words a link's children read as. */
export function plainText(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) => (typeof child === "string" || typeof child === "number" ? String(child) : isValidElement<{ children?: ReactNode }>(child) ? plainText(child.props.children) : ""))
    .join("");
}

export function CitationLink({ target, onCitation }: { target: CitationTarget; onCitation: (target: CitationTarget) => void }) {
  return (
    <span
      role="link"
      tabIndex={0}
      className="citation-link"
      title={citationHint(target)}
      onClick={() => onCitation(target)}
      onKeyDown={(event) => {
        if (event.key === "Enter") onCitation(target);
      }}
    >
      {target.text}
    </span>
  );
}

/**
 * Inline code that holds one citation and nothing else is that citation
 * (`wholeCitation`): the system prompt quotes the labels to write as code
 * spans, and a model may copy the quoting. Any other code stays code.
 */
export function CitedCode({
  onCitation,
  followable,
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<"code"> & {
  onCitation?: (target: CitationTarget) => void;
  followable?: (target: CitationTarget) => boolean;
}) {
  const block = useContext(BlockScope);
  const uncited = useContext(Uncited);
  const insideLink = useContext(InsideLink);
  const text = typeof children === "string" && !className && !children.includes("\n") ? children : null;
  const target = onCitation && text && !uncited && !insideLink ? wholeCitation(text, block.paper, block) : null;
  if (!onCitation || !target || (followable && !followable(target))) {
    return <code className={className} {...props}>{children}</code>;
  }
  return <CitationLink target={target} onCitation={onCitation} />;
}

/** `CitedCode` for this renderer, reading what changes between renders through `latest`, as `AnswerLink` does. */
function AnswerCode({ latest, ...props }: ComponentPropsWithoutRef<"code"> & { latest: { current: Scope } }) {
  const { onCitation, followable } = latest.current;
  return <CitedCode {...props} onCitation={onCitation} followable={followable} />;
}

/**
 * The paper the enclosing block was about, handed down to the inline elements
 * inside it.
 *
 * A citation's own element is the wrong unit to read context from: bold it, and
 * `**(pp. 5-8)**` is a `strong` whose source range holds the citation and
 * nothing else, so the sentence that named the paper falls outside it and
 * formatting alone decides which document opens. The enclosing block is the
 * right unit, and the markdown tree already knows where it ends — including the
 * cases a line-by-line guess gets wrong, such as a blockquote whose one
 * paragraph spans several `>` lines.
 */
export type LibraryPapers = ReadonlyArray<{ title: string; url?: string; sourceUrl?: string }>;

export const BlockScope = createContext<BlockContext>(NO_BLOCK);

/** Text under a heading or a header cell, bold or not: never a citation. */
export const Uncited = createContext(false);

const NO_PAGES: KnownPages = new Map();

/**
 * Renders a markdown element with its own props intact (table alignment, ids)
 * while rewriting the text inside it into citation links and Memory links.
 */
type HeadingTag = "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
type TextualTag = "p" | "li" | "em" | "strong" | "del" | "td" | "th" | HeadingTag;

/** Each tag whose text is rewritten: whether it is a block, and whether its text may cite. Struck text never cites. */
const TEXTUAL: Array<[TextualTag, boolean, boolean]> = [
  ["p", true, true],
  ["li", true, true],
  ["td", true, true],
  ["em", false, true],
  ["strong", false, true],
  ["del", false, false],
  ...(["th", "h1", "h2", "h3", "h4", "h5", "h6"] as const).map((tag): [TextualTag, boolean, boolean] => [tag, false, false]),
];

type Scope = {
  onCitation?: (target: CitationTarget) => void;
  /** The library, for a link to the address of a page it holds (`libraryLink`). */
  papers?: LibraryPapers;
  followable?: (target: CitationTarget) => boolean;
  source: string;
  aliases: PaperAlias[];
  sources?: WebSource[];
  /** The Memory pages a `[[slug]]` can open, and what opens one. */
  pages?: KnownPages;
  onOpenPage?: (slug: string) => void;
};

/**
 * `[[slug]]` in text that is already inside a link, as its words. The page's
 * name still reads; it just cannot be a second link.
 */
function memoryNames(children: ReactNode, pages: KnownPages): ReactNode {
  return Children.map(children, (child) => (typeof child === "string" ? wikiLinkWords(child, pages) : child));
}

/**
 * A link the answer wrote. One to the web opens outside the app; one whose
 * address is among the answer's sources is a citation chip.
 */
function AnswerLink({
  href,
  children,
  latest,
  ...props
}: ComponentPropsWithoutRef<"a"> & { latest: { current: Scope } }) {
  // Held as a plain boolean: the guard would otherwise narrow `href` away in
  // the branch that still has to read it.
  const web: boolean = isWebUrl(href);
  const label = memoryNames(children, latest.current.pages ?? NO_PAGES);
  if (!web || !href) return <a {...props} href={href}>{label}</a>;
  const { onCitation, papers } = latest.current;
  // A page the library holds opens in the reader, at the section it names.
  const kept = onCitation ? libraryLink(href, plainText(children), papers ?? []) : null;
  if (kept && onCitation) return <CitationLink target={kept} onCitation={onCitation} />;
  const cited = sourceFor(href, latest.current.sources);
  if (cited) return <WebCitation source={cited} />;
  return <a {...props} href={href} target="_blank" rel="noopener noreferrer">{label}</a>;
}

function textual<Tag extends TextualTag>(
  tag: Tag,
  latest: { current: Scope },
  /** Block elements read their own source range; inline ones inherit it. */
  block: boolean,
  /** A heading names things; it is not where an answer cites a page of a paper. */
  citations = true,
) {
  const Textual = ({
    node,
    children,
    ...rest
  }: ComponentPropsWithoutRef<Tag> & ExtraProps) => {
    const inherited = useContext(BlockScope);
    const insideLink = useContext(InsideLink);
    const uncited = useContext(Uncited) || !citations;
    const { source, aliases } = latest.current;
    const start = node?.position?.start?.offset, end = node?.position?.end?.offset;
    const context = useMemo(
      () => block ? blockContext(source, aliases, start, end) : inherited,
      [source, aliases, start, end, inherited],
    );
    // Read through the ref at call time, never captured: ChatPanel hands this
    // component a fresh closure per row, and baking one in would put its
    // identity into `components` and remount the answer on every token.
    const cited = (text: ReactNode) =>
      !uncited && !insideLink
        ? withCitations(text, (target) => latest.current.onCitation?.(target), context, latest.current.followable)
        : text;
    const pages = latest.current.pages ?? NO_PAGES;
    const open = latest.current.onOpenPage && !insideLink
      ? (slug: string) => latest.current.onOpenPage?.(slug)
      : undefined;
    // Only rendered prose is split: code, maths and links are elements of
    // their own and never arrive here as strings. A Memory link's name is not
    // read again as a citation of a paper.
    const content = Children.map(children, (child, childIndex) => {
      if (typeof child !== "string") return child;
      const pieces = splitWikiLinks(child);
      if (pieces.every((piece) => piece.kind === "text")) return cited(child);
      return pieces.map((piece, index) =>
        piece.kind === "text" ? (
          <Fragment key={`${childIndex}-${index}`}>{cited(piece.text)}</Fragment>
        ) : (
          <MemoryLink key={`${childIndex}-${index}`} link={piece} pages={pages} onOpen={open} />
        ),
      );
    });
    const scoped = block ? createElement(BlockScope.Provider, { value: context }, content) : content;
    return createElement(tag, rest, citations ? scoped : createElement(Uncited.Provider, { value: true }, scoped));
  };
  Textual.displayName = `Markdown_${tag}`;
  return Textual;
}

/** What following this citation will do, in the link's own tooltip. */
function citationHint(target: CitationTarget): string {
  if (target.anchor) return `Go to §${target.anchor}`;
  const where = target.locator?.label ?? null;
  const pages = target.pages.length
    ? `page${target.pages.length > 1 ? "s" : ""} ${target.pages.join(", ")}`
    : null;
  if (where && pages) return `Go to ${where} · ${pages}`;
  return `Go to ${where ?? pages ?? "the source"}`;
}

function MarkdownTable({ children }: { children?: ReactNode }) {
  return (
    <div className="markdown-table-scroll">
      <table>{children}</table>
    </div>
  );
}

// `textual()` mints a component type, and React treats a new type as a
// different component: it unmounts the old subtree and mounts a fresh one. Built
// inline, that rebuilt every paragraph of every answer on each render, which
// wiped any text the reader had selected (leaving the Reply button pointing at
// nothing) and re-mounted the whole answer on every streamed token. Memoizing
// the message *and* keeping `components` free of the citation callback's
// identity — ChatPanel passes a fresh closure per row — is what keeps the DOM
// in place when the Reply menu opens over a selection.
function AssistantMessage({
  content,
  onCitation,
  followable,
  papers = [],
  sources,
  pages,
  onOpenPage,
  streaming = false,
}: {
  content: string;
  /** Only a live answer may still finish an open visualization fence. */
  streaming?: boolean;
  /** The web pages this answer cites, so their links can say so. */
  sources?: WebSource[];
  onCitation?: (target: CitationTarget) => void;
  /** Whether a citation has anywhere to go in the library; one that has not stays prose. */
  followable?: (target: CitationTarget) => boolean;
  /** The library this answer may cite, so a nameless citation can be placed. */
  papers?: LibraryPapers;
  /** The Memory pages this answer may name as `[[slug]]`, and what opens one. */
  pages?: KnownPages;
  onOpenPage?: (slug: string) => void;
}) {
  /**
   * One normalized string, used for both the offsets and the render.
   *
   * `node.position` is measured against whatever ReactMarkdown was handed, so
   * computing block ranges from the raw `content` would line them up against a
   * string of a different length — every offset off by however much the
   * normalizers moved.
   */
  const source = useMemo(
    () => answerMarkdown(content, sources),
    [content, sources],
  );

  const aliasKey = papers.map((paper) => paper.title).join("\u0000");
  const aliases = useMemo(
    () => paperAliases(papers),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [aliasKey],
  );

  /**
   * Everything `linkify` needs that changes between renders, behind one ref.
   *
   * `components` must keep an empty dependency list: `textual()` mints a
   * component type, and React treats a new type as a different component, so a
   * `components` object rebuilt on each streamed token remounts the whole
   * answer and drops the reader's selection with it.
   */
  const latest = useRef<Scope>({ onCitation, followable, papers, source, aliases, sources, pages, onOpenPage });
  latest.current = { onCitation, followable, papers, source, aliases, sources, pages, onOpenPage };

  const components = useMemo<Components>(
    () => ({
      span: MathSpan,
      a: ({ href, children, node: _node, ...props }) => (
        <InsideLink.Provider value={true}>
          <AnswerLink {...props} href={href} latest={latest}>{children}</AnswerLink>
        </InsideLink.Provider>
      ),
      table: MarkdownTable,
      pre: ArtifactPre,
      code: ({ node: _node, ...props }) => <AnswerCode {...props} latest={latest} />,
      ...Object.fromEntries(TEXTUAL.map(([tag, block, cites]) => [tag, textual(tag, latest, block, cites)])),
    }),
    [],
  );

  return (
    <ArtifactMarkdown.Provider value={{ source, enabled: true, streaming }}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={components}
      >
        {source}
      </ReactMarkdown>
    </ArtifactMarkdown.Provider>
  );
}

// Finished messages do not change, so a re-render for unrelated state — opening
// the selection menu, a new message arriving — must not touch their DOM.
export const MemoAssistantMessage = memo(AssistantMessage);
