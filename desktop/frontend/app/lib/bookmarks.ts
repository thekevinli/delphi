/**
 * Chrome's bookmark export, read into the projects onboarding offers.
 *
 * The export is the Netscape bookmark format: folders are `<H3>` headings each
 * followed by a `<DL>` list, and pages are `<A HREF>` links inside them. Every
 * page belongs to the folder closest to it, so the deepest folders become the
 * projects and a folder holding both pages and subfolders contributes its own
 * pages as one project and its subfolders as others.
 *
 * Read with a tag scanner rather than DOMParser so it runs, and is tested, in
 * Node as well as the browser. The file is never uploaded: only what the reader
 * confirms from the preview is sent, as ordinary project and page requests.
 */

export type BookmarkLink = { title: string; url: string };

export type BookmarkFolder = { name: string; links: BookmarkLink[] };

/** The names the server accepts; longer ones are cut rather than refused. */
export const PROJECT_NAME_MAX = 100;
export const DOCUMENT_TITLE_MAX = 200;

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X"
        ? Number.parseInt(name.slice(2), 16)
        : Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    return ENTITIES[name.toLowerCase()] ?? match;
  });
}

function cleanText(text: string, max: number): string {
  return decodeEntities(text).replace(/\s+/g, " ").trim().slice(0, max);
}

function hrefOf(attributes: string): string {
  const match = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attributes);
  return decodeEntities(match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
}

/** Only pages Delphi can fetch: `javascript:`, `chrome://` and the like are not documents. */
export function isImportableUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * The folders that directly hold importable pages, in the order they appear,
 * each cut to `perProject` pages. Folders are keyed by their whole path, so two
 * folders that happen to share a name in different places stay two projects.
 */
export function parseBookmarks(html: string, perProject = 10): BookmarkFolder[] {
  const tag = /<(\/?)(dl|h3|a)\b([^>]*)>/gi;
  const textAfter = (index: number) => {
    const end = html.indexOf("<", index);
    return html.slice(index, end < 0 ? undefined : end);
  };

  const path: string[] = [];
  let pendingFolder: string | null = null;
  const folders = new Map<string, { name: string; urls: Set<string>; links: BookmarkLink[] }>();

  for (let match = tag.exec(html); match; match = tag.exec(html)) {
    const closing = match[1] === "/";
    const name = match[2].toLowerCase();
    if (name === "h3" && !closing) {
      pendingFolder = cleanText(textAfter(tag.lastIndex), PROJECT_NAME_MAX) || "Untitled folder";
    } else if (name === "dl") {
      if (closing) path.pop();
      // The outermost list has no heading; its loose pages are "Bookmarks".
      else path.push(pendingFolder ?? path.at(-1) ?? "Bookmarks");
      pendingFolder = null;
    } else if (name === "a" && !closing) {
      const url = hrefOf(match[3]);
      if (!isImportableUrl(url)) continue;
      const key = path.join("\u0000") || "Bookmarks";
      let folder = folders.get(key);
      if (!folder) {
        folder = { name: path.at(-1) ?? "Bookmarks", urls: new Set(), links: [] };
        folders.set(key, folder);
      }
      if (folder.urls.has(url)) continue;
      folder.urls.add(url);
      folder.links.push({
        url,
        title: cleanText(textAfter(tag.lastIndex), DOCUMENT_TITLE_MAX) || hostOf(url),
      });
    }
  }

  return Array.from(folders.values(), (folder) => ({
    name: folder.name,
    links: folder.links.slice(0, perProject),
  }));
}

/**
 * Run `worker` over `items` with at most `limit` in flight, in order of start:
 * a first run's uploads and digests, which would otherwise all start at once.
 */
export async function runPool<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      await worker(items[index], index);
    }
  });
  await Promise.all(lanes);
}
