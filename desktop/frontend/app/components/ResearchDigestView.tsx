"use client";

import { Children, isValidElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import rehypeKatex from "rehype-katex";
import { REMARK_PLUGINS } from "../lib/markdown-pipeline";
import { API_BASE, type ResearchDigest } from "../lib/api";
import { digestCodeLocator, remarkDigestMarkdown, remarkDigestDocument, rehypeDigestMath } from "../lib/digest-markdown";
import { MathSpan } from "./MathSpan";
import ScrollingTitle from "./ScrollingTitle";
import CapturedSourceView from "./CapturedSourceView";

// Native MathML lays out equations with STIX's own math metrics, including
// fractions and stretchy operators, rather than swapping fonts under KaTeX HTML.
const MATH_PLUGINS: Options["rehypePlugins"] = [[rehypeKatex, { output: "mathml", strict: false, trust: false }], rehypeDigestMath];
function textContent(children: ReactNode): string {
  return Children.toArray(children).map(child => typeof child === "string" || typeof child === "number" ? String(child) : isValidElement<{ children?: ReactNode }>(child) ? textContent(child.props.children) : "").join("");
}

/** Small, lossless token coloring for examples; unsupported languages stay plain. */
function colorCode(source: string, language: string): ReactNode {
  if (!/^(python|py|javascript|js|typescript|ts|json|bash|sh)$/.test(language)) return source;
  const python = /^(python|py)$/.test(language);
  const tokens = python
    ? /("""[\s\S]*?"""|'''[\s\S]*?'''|#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|@[\w.]+|\b(?:def|class|for|in|if|else|elif|return|import|from|as|with|while|try|except|yield|lambda|True|False|None|and|or|not|async|await)\b|\b\d+(?:\.\d+)?\b|\b[A-Za-z_]\w*(?=\())/g
    : /(\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:const|let|var|function|class|return|if|else|for|while|import|from|export|async|await|true|false|null|undefined|throw|new)\b|\b\d+(?:\.\d+)?\b|\b[A-Za-z_]\w*(?=\())/g;
  return source.split(tokens).map((token, index) => {
    if (!(index % 2)) return token;
    const kind = /^(#|\/\/|\/\*)/.test(token) ? "comment" : /^["'`\d]/.test(token) ? "string" : token.startsWith("@") || source.includes(`${token}(`) ? "function" : "keyword";
    return <span className={`digest-syntax-${kind}`} key={index}>{token}</span>;
  });
}

function DigestCodeBlock({ children }: { children?: ReactNode }) {
  const code = Children.toArray(children).find(child => isValidElement(child));
  const props = isValidElement<{ className?: string; children?: ReactNode }>(code) ? code.props : {};
  const source = textContent(props.children ?? children).replace(/\n$/, "");
  const language = props.className?.match(/language-([^\s]+)/)?.[1] ?? "";
  const [copy, setCopy] = useState("Copy");
  useEffect(() => {
    if (copy === "Copy") return;
    const timer = window.setTimeout(() => setCopy("Copy"), 2000);
    return () => window.clearTimeout(timer);
  }, [copy]);
  return <figure className="digest-code-block">
    <figcaption><span>{language || "Code"}</span><button type="button" aria-label="Copy code" onClick={async () => {
      try { await navigator.clipboard.writeText(source); setCopy("Copied"); } catch { setCopy("Copy failed"); }
    }}><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" /></svg><span aria-live="polite">{copy}</span></button></figcaption>
    <pre><code>{colorCode(source, language.toLowerCase())}</code></pre>
  </figure>;
}

export default function ResearchDigestView({ digest, headerTitle, projectId, paperId, documentHref, zoom = 100, onNavigate }: {
  digest: ResearchDigest; headerTitle?: string; projectId: string; paperId: string; documentHref: string;
  /** The reader's text size, in percent: the contents and the article are zoomed, each reflowing in its own column. */
  zoom?: number;
  onNavigate: () => void;
}) {
  const pathname = documentHref;
  const router = useRouter();
  const article = useRef<HTMLElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const [headings, setHeadings] = useState<Array<{ id: string; title: string }>>([]);
  const [active, setActive] = useState("digest-overview");
  /** The captured outside source a reader opened from a citation, and the section cited. */
  const [outside, setOutside] = useState<{ evidenceId: string; section: string | null } | null>(null);
  const source = digest.contentMarkdown;
  // Read at click time, so a parent's fresh callback never rebuilds the rendered Markdown.
  const navigate = useRef(onNavigate);
  useEffect(() => { navigate.current = onNavigate; }, [onNavigate]);
  /** A place in this document: back to the document, at that place. A modified click keeps its browser meaning. */
  const follow = useCallback((event: MouseEvent<HTMLAnchorElement>, href: string) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    // The rest of the address (an open chat, its conversation) stays as it is; only the place changes.
    const target = new URL(href, window.location.href), params = new URLSearchParams(window.location.search);
    params.delete("focusPage"); params.delete("focusSection");
    target.searchParams.forEach((value, key) => params.set(key, value));
    router.push(`${target.pathname}?${params}`); navigate.current();
  }, [router]);
  const plugins = useMemo<Options["remarkPlugins"]>(() => [...REMARK_PLUGINS, [remarkDigestMarkdown, { citations: digest.citations, headerTitle }], [remarkDigestDocument, { assets: digest.assets ?? [] }]], [digest.assets, digest.citations, headerTitle]);
  const components = useMemo<Components>(() => {
    const locator = (label: ReactNode, page?: number | null, section?: string | null) => {
      const query = page ? `focusPage=${page}` : section ? `focusSection=${encodeURIComponent(section.replace(/^#|^§/, ""))}` : "";
      return query ? <a className="digest-citation" href={`${pathname}?${query}`} onClick={event => follow(event, `${pathname}?${query}`)}>{label}</a> : <span className="digest-citation">{label}</span>;
    };
    return {
      span: MathSpan,
      pre: DigestCodeBlock,
      table: ({ children }) => <div className="markdown-table-scroll"><table>{children}</table></div>,
      a: ({ href, children }) => {
        if (href?.startsWith("#digest-evidence-")) {
          const ids = href.slice("#digest-evidence-".length).split("-").map(Number);
          const cited = ids.map(id => digest.citations.find(item => item.id === id));
          const external = cited.find(item => item?.claimType === "external" && item.evidenceId);
          if (external?.evidenceId) {
            // Not a place in this document: it opens what the outside page said when it was captured.
            const evidenceId = external.evidenceId;
            return <button type="button" className="digest-citation digest-citation-external" onClick={() => setOutside({ evidenceId, section: external.section })}>{children}</button>;
          }
          const evidence = cited.find(item => item?.page || item?.section);
          return locator(children, evidence?.page, evidence?.section);
        }
        return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
      },
      code: ({ node, className, children, ...props }) => {
        const value = textContent(children);
        const reference = !className && node?.position?.start.line === node?.position?.end.line ? digestCodeLocator(value) : null;
        return reference ? locator(reference.label, reference.page, reference.section) : <code className={className} {...props}>{children}</code>;
      },
      figure: ({ node }) => {
        const id = node?.properties?.["data-digest-asset"] ?? node?.properties?.dataDigestAsset;
        const asset = digest.assets?.find(item => item.id === id);
        return asset ? <DigestAssetVisual asset={asset} projectId={projectId} paperId={paperId} pathname={pathname} onFollow={follow} /> : null;
      },
    };
  }, [digest, pathname, projectId, paperId, follow]);

  useLayoutEffect(() => {
    const root = article.current;
    if (!root) return;
    const nodes = Array.from(root.querySelectorAll<HTMLElement>("h1, h2, h3"));
    // The title is what "Overview" stands for; every section is listed, an opening one too.
    setHeadings([{ id: "digest-overview", title: "Overview" }, ...nodes.filter(node => !node.classList.contains("digest-title")).map(node => ({ id: node.id, title: node.textContent ?? "" }))]);
    setActive("digest-overview");
    if (scroll.current) scroll.current.scrollTop = 0;
  }, [source, headerTitle]);
  useEffect(() => {
    const pane = scroll.current;
    if (!pane) return;
    const update = () => {
      let current = "digest-overview";
      const top = pane.getBoundingClientRect().top + 72;
      for (const heading of headings.slice(1)) {
        const node = document.getElementById(heading.id);
        if (node && node.getBoundingClientRect().top <= top) current = heading.id;
      }
      setActive(current);
    };
    pane.addEventListener("scroll", update, { passive: true });
    update();
    return () => pane.removeEventListener("scroll", update);
  }, [headings]);

  const markdown = useMemo(() => <ReactMarkdown remarkPlugins={plugins} rehypePlugins={MATH_PLUGINS} components={components}>{source}</ReactMarkdown>, [plugins, components, source]);

  // The reading column takes the keyboard when clicked; blank space beside it hands the keyboard to it too,
  // so Space and the arrows scroll the digest. A portalled source view bubbles here through React only.
  return <div className="digest-layout" style={{ "--digest-zoom": zoom / 100 } as CSSProperties} onMouseDown={event => {
    const target = event.target as Element;
    if (!event.currentTarget.contains(target) || scroll.current?.contains(target) || target.closest("a, button, input, textarea")) return;
    event.preventDefault();
    scroll.current?.focus({ preventScroll: true });
  }}>
    {outside ? <CapturedSourceView key={outside.evidenceId} evidenceId={outside.evidenceId} section={outside.section} onClose={() => setOutside(null)} /> : null}
    <nav className="digest-toc" aria-label="Contents">
      {headings.map(heading => <a key={heading.id} href={`#${heading.id}`} aria-current={active === heading.id ? "location" : undefined} onClick={event => {
        event.preventDefault();
        const node = document.getElementById(heading.id), pane = scroll.current;
        if (node && pane) {
          pane.scrollTo({ top: heading.id === "digest-overview" ? 0 : pane.scrollTop + node.getBoundingClientRect().top - pane.getBoundingClientRect().top - 28, behavior: "instant" });
          setActive(heading.id);
        }
      }}><ScrollingTitle title={heading.title} className="digest-toc-title" /></a>)}
    </nav>
    <div className="digest-reading-scroll" ref={scroll} tabIndex={-1}>
      <article ref={article} id="digest-overview" className="digest-document prose-reading message-markdown">{markdown}</article>
    </div>
  </div>;
}
function DigestAssetVisual({
  asset,
  projectId,
  paperId,
  pathname,
  onFollow,
}: {
  asset: ResearchDigest["assets"][number];
  projectId: string;
  paperId: string;
  pathname: string;
  onFollow: (event: MouseEvent<HTMLAnchorElement>, href: string) => void;
}) {
  const [broken, setBroken] = useState(false);
  if (broken) return null;
  const locator = asset.page
    ? `From p. ${asset.page}`
    : asset.section
      ? `From §${asset.section}`
      : "From the source";
  const focus = asset.page
    ? `focusPage=${encodeURIComponent(String(asset.page))}`
    : asset.section
      ? `focusSection=${encodeURIComponent(asset.section)}`
      : "";
  return (
    <figure className="digest-asset">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`${API_BASE}/api/projects/${projectId}/papers/${paperId}/digest/assets/${asset.id}?v=${asset.bytes}`}
        alt={asset.alt}
        loading="lazy"
        onError={() => setBroken(true)}
      />
      <figcaption>
        <span>{asset.caption}</span>
        {focus ? (
          <a href={`${pathname}?${focus}`} onClick={event => onFollow(event, `${pathname}?${focus}`)}>{locator}</a>
        ) : (
          <span>{locator}</span>
        )}
      </figcaption>
    </figure>
  );
}
