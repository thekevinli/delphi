import { ARTIFACT_STYLES } from "./artifact-theme.ts";
import { artifactBootstrap } from "./artifact-runtime.ts";

/** The one executable Markdown fence. Ordinary HTML and code stay inert. */
export const ARTIFACT_LANGUAGE = "delphi-artifact";
export const ARTIFACT_MAX_LENGTH = 128_000;
export const ARTIFACT_MIN_HEIGHT = 96;
export const ARTIFACT_MAX_HEIGHT = 1400;

export type ArtifactFence = {
  title: string;
  source: string;
  closed: boolean;
  problem: "incomplete" | "empty" | "too-large" | null;
};

/**
 * Offsets and body come from Markdown's parsed code node. Only its delimiters
 * are read here: a second Markdown grammar would misread quoted examples and
 * nested fences. An unfinished fence is never an executable document.
 */
export function artifactFence(markdown: string, start: number | undefined, end: number | undefined, source: string): ArtifactFence | null {
  if (start === undefined || end === undefined) return null;
  const raw = markdown.slice(start, end);
  const first = /^(`{3,}|~{3,})delphi-artifact(?:[\t ]+([^\r\n]*))?(?:\r?\n|$)/.exec(raw);
  if (!first) return null;
  const marker = first[1];
  const lastLine = raw.slice(raw.lastIndexOf("\n") + 1).replace(/\r$/, "");
  const closing = new RegExp(`^[\\t >]*(${marker[0]}{${marker.length},})[\\t ]*$`).exec(lastLine);
  // An indented delimiter that the parser kept in `value` is source, not a
  // closing fence. This also covers unfinished fences inside quotes/lists.
  const sourceLastLine = source.trimEnd().split(/\r?\n/).at(-1)?.trim();
  const closed = Boolean(closing && sourceLastLine !== closing[1]);
  const metadata = first[2]?.trim() ?? "";
  const title = (metadata.replace(/^title=(?:"([^"]*)"|'([^']*)')$/, "$1$2")
    .replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 160) || "Interactive visualization");
  return {
    title, source, closed,
    problem: source.length > ARTIFACT_MAX_LENGTH ? "too-large" : !closed ? "incomplete" : !source.trim() ? "empty" : null,
  };
}

export function artifactHeight(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.min(ARTIFACT_MAX_HEIGHT, Math.max(ARTIFACT_MIN_HEIGHT, Math.ceil(value)));
}

const escapeAttribute = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

// Inline scripts/styles are the artifact's medium; all external resources and
// connections are denied. The opaque iframe sandbox is set by the component,
// and the desktop navigation guard denies self-navigation out of srcdoc.
const ARTIFACT_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'";

// The kit's script ships only to a diagram that may declare something it
// draws, by attribute, through `dataset` or by a name built in script; every
// frame parses what it is given.
const KIT = /artifact-?(?:chart|connect|badge|from)|data-artifact-(?!(?:controls|action|progress|step|edge)\b)/i;

type ArtifactDocumentOptions = { /** Only the trusted measuring script may run in a streamed preview. */ previewNonce?: string };

/** Model markup enters only this opaque document, never the application's DOM. */
export function artifactDocument(source: string, title = "Interactive visualization", options: ArtifactDocumentOptions = {}): string {
  const nonce = options.previewNonce;
  // Refuse malformed policy tokens rather than allowing a caller to widen CSP.
  if (nonce !== undefined && !/^[a-zA-Z0-9_-]{16,128}$/.test(nonce)) throw new Error("Invalid artifact preview nonce");
  const policy = nonce ? ARTIFACT_CSP.replace("script-src 'unsafe-inline'", `script-src 'nonce-${nonce}'`) : ARTIFACT_CSP;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeAttribute(policy)}"><meta name="referrer" content="no-referrer"><meta http-equiv="x-dns-prefetch-control" content="off"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeAttribute(title)}</title><style>${ARTIFACT_STYLES}</style></head><body><script${nonce ? ` nonce="${nonce}"` : ""}>${artifactBootstrap(Boolean(nonce), KIT.test(source))}</script>${source}</body></html>`;
}
