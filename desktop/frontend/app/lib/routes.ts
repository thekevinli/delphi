/**
 * Canonical reader addresses.
 *
 * Slugs come from the backend and are opaque here. The visible `@username`
 * chooses a namespace but grants no access; the signed session remains the only
 * credential, and `/api/reader/*` is the policy boundary that resolves a route
 * to Delphi's internal ids.
 */

const USERNAME = /^[A-Za-z0-9_-]{3,40}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

type SluggedProject = { slug: string };
type SluggedPaper = { slug: string };

/**
 * Which conversation the address has docked, if any.
 *
 * **Absence is the meaningful case**: no `?chat=` means no conversation is
 * open, which is what the Reader arrives at. That is why `"paper"` is now a
 * value like the others rather than the empty one — a document chat had no way
 * to say "and it is open", so a link to one opened the document with the panel
 * shut and looked broken.
 *
 * `"general"` is legal on any route including a document one: docking the
 * account-wide conversation while a paper is open is a normal thing to want,
 * and the URL still records both.
 */
export type ChatScope = "paper" | "project" | "general";

export type ReaderRoute =
  | { kind: "root" }
  | { kind: "project"; username: string; projectSlug: string }
  | {
      kind: "document";
      username: string;
      projectSlug: string;
      paperSlug: string;
    };

function isSlug(value: string): boolean {
  return value.length <= 60 && SLUG.test(value);
}

export function projectPath(
  username: string,
  project: SluggedProject,
): string {
  if (!USERNAME.test(username) || !isSlug(project.slug)) {
    throw new Error("Cannot build a reader path without server-issued route metadata");
  }
  return `/@${username}/${project.slug}`;
}

/**
 * Where a document lives. `chat` says which conversation is docked beside it;
 * `"project"` is only read from older links, and opens the document's own.
 */
export function documentPath(
  username: string,
  project: SluggedProject,
  paper: SluggedPaper,
  options: { chat?: ChatScope } = {},
): string {
  if (!isSlug(paper.slug)) {
    throw new Error("Cannot build a reader path without a server-issued paper slug");
  }
  const path = `${projectPath(username, project)}/${paper.slug}`;
  // No `chat` is a document open with no conversation docked — the Reader's
  // resting state, and the commonest address there is.
  return options.chat ? `${path}?chat=${options.chat}` : path;
}

/**
 * Where a library search hit actually points — the document, and the exact
 * page or section it was found on. A hit that only opens the document and
 * leaves the reader to find the page themselves is a search result in name
 * only; `focusPage`/`focusSection` are one-shot, read once by the reader on
 * load and then stripped, the same way a citation jump is a state change
 * rather than a permanent part of the address.
 */
export function libraryHitPath(
  username: string,
  hit: {
    projectSlug: string;
    paperSlug: string;
    kind: "page" | "section";
    locator: string;
  },
): string {
  const path = documentPath(
    username,
    { slug: hit.projectSlug },
    { slug: hit.paperSlug },
  );
  const param =
    hit.kind === "page"
      ? `focusPage=${encodeURIComponent(hit.locator)}`
      : `focusSection=${encodeURIComponent(hit.locator)}`;
  return `${path}?${param}`;
}

/** The authenticated resolver call corresponding to a parsed visible route. */
export function readerApiPath(
  route: Exclude<ReaderRoute, { kind: "root" }>,
): string {
  const base = `/api/reader/${route.username}/${route.projectSlug}`;
  return route.kind === "document" ? `${base}/${route.paperSlug}` : base;
}

/**
 * Parse only paths Delphi itself can mint.
 *
 * Empty/trailing segments, percent escapes, controls, assets, and the retired
 * id-suffixed routes are all rejected. Usernames keep their registered case.
 */
export function parseReaderPath(pathname: string): ReaderRoute | null {
  if (!pathname.startsWith("/") || CONTROL.test(pathname)) return null;
  if (pathname === "/" || pathname === "/reader") return { kind: "root" };
  if (pathname.includes("%") || pathname.endsWith("/")) return null;
  const parts = pathname.slice(1).split("/");
  if (parts.length !== 2 && parts.length !== 3) return null;
  if (!parts[0].startsWith("@")) return null;
  const username = parts[0].slice(1);
  const projectSlug = parts[1];
  if (!USERNAME.test(username) || !isSlug(projectSlug)) return null;
  if (parts.length === 2) return { kind: "project", username, projectSlug };
  const paperSlug = parts[2];
  return isSlug(paperSlug)
    ? { kind: "document", username, projectSlug, paperSlug }
    : null;
}

type FocusRect = { x: number; y: number; w: number; h: number };

/**
 * The caption box a citation resolved, carried in a one-shot focus address
 * (`focusBox`) beside `focusPage`. A jump made inside the reader hands the box
 * over in state; one from another surface, such as the Memory page's chat,
 * can only hand over an address, and without the box it landed on the page
 * with nothing marked.
 */
export function focusBox(rect: FocusRect): string {
  return [rect.x, rect.y, rect.w, rect.h].map((value) => Number(value.toFixed(4))).join(",");
}

/** A `focusBox` read back, or null for anything that is not four fractions of a page. */
export function readFocusBox(value: string | null): FocusRect | null {
  const parts = value?.split(",").map(Number) ?? [];
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part) || part < 0 || part > 1)) return null;
  const [x, y, w, h] = parts;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}
