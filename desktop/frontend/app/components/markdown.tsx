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
  chipLabels,
  type ChipLabel,
  blockContext,
  type BlockContext,
  type CitationTarget,
  NO_BLOCK,
  type DocumentOf,
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
 * a link that jumps the reader to that page. A citation set apart from the
 * sentence, in parentheses, is an aside: a chip, and a parenthetical holding
 * nothing but citations loses its brackets, since the chips already read as
 * asides. A place the sentence names is a word of the sentence, and stays one.
 * Only string children are rewritten; nested elements are handled by their own
 * renderer below.
 */
export function withCitations(
  children: ReactNode,
  onCitation?: (target: CitationTarget) => void,
  block: BlockContext = NO_BLOCK,
  /** Where a citation goes; one with nowhere to go stays prose. */
  documentOf: DocumentOf = unplaced,
): ReactNode {
  if (!onCitation) return children;
  return Children.map(children, (child, childIndex) => {
    if (typeof child !== "string") return child;
    const pieces = segmentCitations(child, block.paper, block);
    if (!pieces.some((piece) => piece.kind === "citation")) return child;
    // Each citation is resolved once; one with nowhere to go is its words.
    const cited = pieces.map((piece) => (piece.kind === "citation" ? documentOf(piece.target) : null));
    const drawn: ReactNode[] = [];
    for (let at = 0; at < pieces.length; at++) {
      const piece = pieces[at];
      if (!piece.aside) {
        const found = cited[at];
        drawn.push(piece.kind === "text" ? piece.text : found
          ? <CitationLink key={`${childIndex}-${at}`} target={piece.target} onCitation={onCitation} />
          : piece.target.text);
        continue;
      }
      // A parenthetical: drawn as written, unless it holds nothing but
      // citations that go somewhere, which are its chips, a space apart. The
      // marks between them stay in the text, unseen, so a copy or a quote of
      // the answer still reads "(A, p. 4; B, p. 7)".
      let end = at;
      while (pieces[end + 1]?.aside) end++;
      const run = pieces.slice(at, end + 1);
      const bare = run.every((item, offset) => (item.kind === "citation" ? cited[at + offset] : SEPARATORS.test(item.text)));
      const labels = chipLabels(run.flatMap((item, offset) =>
        item.kind === "citation" ? [{ target: item.target, cited: cited[at + offset] }] : []));
      const chips = labels.filter(Boolean).length;
      let citation = 0;
      let chip = 0;
      // A bare parenthetical's marks, gathered up to the next chip or its end.
      let marks = "";
      const flush = (key: string) => {
        if (marks) drawn.push(...unseenMarks(marks, key, chip > 0 && chip < chips));
        marks = "";
      };
      run.forEach((item, offset) => {
        const key = `${childIndex}-${at + offset}`;
        if (item.kind === "citation") {
          const label = labels[citation++];
          if (!label) {
            drawn.push(item.target.text);
            return;
          }
          flush(`${key}-marks`);
          drawn.push(<CitationLink key={key} target={item.target} onCitation={onCitation} label={label} />);
          chip++;
        } else if (!bare) {
          drawn.push(item.text);
        } else {
          marks += item.text;
        }
      });
      flush(`${childIndex}-${end}-marks`);
      at = end;
    }
    return drawn;
  });
}

/**
 * The marks around a bare parenthetical's chips, kept in the text but not
 * seen: their spaces stay as they are, and two chips are never drawn
 * touching — with none written between them, one follows the marks that
 * close the first, so ")(" copies as ") (".
 */
function unseenMarks(text: string, key: string, between: boolean): ReactNode[] {
  const spaced = between && !/\s/.test(text) ? text.replace(/^[^(]*/, (closing) => `${closing} `) : text;
  return spaced.split(/(\s+)/).filter(Boolean).map((part, index) =>
    /^\s+$/.test(part) ? part : <span key={`${key}-${index}`} className="visually-hidden">{part}</span>);
}

/** What stands between the citations of a parenthetical that holds nothing else. */
const SEPARATORS = /^(?:[\s();,&]|\band\b)*$/;

/** With no library to ask, a citation goes where it says, and its chip says it as written. */
const unplaced: DocumentOf = () => ({ title: "", held: false, open: true });

/** The words a link's children read as. */
export function plainText(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) => (typeof child === "string" || typeof child === "number" ? String(child) : isValidElement<{ children?: ReactNode }>(child) ? plainText(child.props.children) : ""))
    .join("");
}

/**
 * One citation. An aside (`aside` set) is a chip in the model's own words,
 * after the title of a document the library holds when that is not the one on
 * screen; a long title is clipped by its style, never in its text, so it
 * copies and is read whole. Without `aside` it is the words the sentence
 * already says, made followable.
 */
export function CitationLink({
  target,
  onCitation,
  label,
}: {
  target: CitationTarget;
  onCitation: (target: CitationTarget) => void;
  /** An aside's chip (`chipLabels`); without one, the sentence's own words. */
  label?: ChipLabel;
}) {
  return (
    <span
      role="link"
      tabIndex={0}
      className={label ? "citation-link is-aside" : "citation-link"}
      title={label?.document ?? citationHint(target)}
      onClick={() => onCitation(target)}
      onKeyDown={(event) => {
        if (event.key === "Enter") onCitation(target);
      }}
    >
      {label ? (
        <>
          {label.document ? <><b>{label.document}</b><span className="citation-sep"> · </span></> : null}
          <span className="citation-words">{label.words}</span>
        </>
      ) : target.text}
    </span>
  );
}

/** A citation set apart from the sentence on its own, as a chip, or as the prose it is when it has nowhere to go. */
export function AsideCitation({ target, onCitation, documentOf = unplaced, fallback }: {
  target: CitationTarget;
  onCitation: (target: CitationTarget) => void;
  documentOf?: DocumentOf;
  fallback: ReactNode;
}) {
  const cited = documentOf(target);
  if (!cited) return <>{fallback}</>;
  return <CitationLink target={target} onCitation={onCitation} label={chipLabels([{ target, cited }])[0]} />;
}

/**
 * Inline code that holds one citation and nothing else is that citation
 * (`wholeCitation`): the system prompt quotes the labels to write as code
 * spans, and a model may copy the quoting. Any other code stays code.
 */
export function CitedCode({
  onCitation,
  documentOf = unplaced,
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<"code"> & {
  onCitation?: (target: CitationTarget) => void;
  documentOf?: DocumentOf;
}) {
  const block = useContext(BlockScope);
  const uncited = useContext(Uncited);
  const insideLink = useContext(InsideLink);
  const text = typeof children === "string" && !className && !children.includes("\n") ? children : null;
  const target = onCitation && text && !uncited && !insideLink ? wholeCitation(text, block.paper, block) : null;
  const code = <code className={className} {...props}>{children}</code>;
  if (!onCitation || !target) return code;
  // A citation quoted as code is set apart from the sentence, as a parenthetical is.
  return <AsideCitation target={target} onCitation={onCitation} documentOf={documentOf} fallback={code} />;
}

/** `CitedCode` for this renderer, reading what changes between renders through `latest`, as `AnswerLink` does. */
function AnswerCode({ latest, ...props }: ComponentPropsWithoutRef<"code"> & { latest: { current: Scope } }) {
  const { onCitation, documentOf } = latest.current;
  return <CitedCode {...props} onCitation={onCitation} documentOf={documentOf} />;
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
  documentOf?: DocumentOf;
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
  const { onCitation, papers, documentOf } = latest.current;
  // A page the library holds opens in the reader, at the section it names, as
  // a web source's link is a chip.
  const kept = onCitation ? libraryLink(href, plainText(children), papers ?? []) : null;
  if (kept && onCitation) {
    const link = <a {...props} href={href} target="_blank" rel="noopener noreferrer">{label}</a>;
    return <AsideCitation target={kept} onCitation={onCitation} documentOf={documentOf} fallback={link} />;
  }
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
        ? withCitations(text, (target) => latest.current.onCitation?.(target), context, latest.current.documentOf)
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
  documentOf,
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
  /** Where a citation goes in the library (`citedDocument`); one with nowhere to go stays prose. */
  documentOf?: DocumentOf;
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
  const latest = useRef<Scope>({ onCitation, documentOf, papers, source, aliases, sources, pages, onOpenPage });
  latest.current = { onCitation, documentOf, papers, source, aliases, sources, pages, onOpenPage };

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
