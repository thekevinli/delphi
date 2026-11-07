import { api, type Paper } from "./api.ts";

/**
 * Which web document owns a `§anchor`, for one project.
 *
 * A model cites a web section as a bare slug, and in a project chat the slug
 * alone has to say which document to open: nothing else in the citation does.
 * The answer comes from the server's section index (`/api/projects/{id}/anchors`,
 * records only), fetched once per project and document set and kept here.
 *
 * Three rules keep it honest:
 *
 * - **A slow answer is no answer.** The lookup shares the click's budget; once
 *   the deadline passes the verdict is "unknown" and routing carries on as if
 *   there were no index. The request is left running so the next click is warm.
 * - **A failure is not remembered.** Nothing is cached for a request that
 *   failed, so the next click asks again instead of repeating an outage.
 * - **A re-snapshot forgets.** `/refresh` and store-in-place rewrite a
 *   document's sections under the same id, which no cache key would notice, so
 *   their callers drop the project's entry with `forgetProjectAnchors`.
 */

export type AnchorMap = Record<string, string[]>;
type Load = (projectId: string) => Promise<AnchorMap>;

const loadFromServer: Load = async (projectId) =>
  (await api<{ papers: AnchorMap }>(`/api/projects/${projectId}/anchors`)).papers;

const cache = new Map<string, { key: string; owners: Promise<Map<string, Set<string>>> }>();

/** Drop what is known about a project's anchors after one of its documents is re-snapshotted. */
export function forgetProjectAnchors(projectId: string) {
  cache.delete(projectId);
}

function byAnchor(map: AnchorMap): Map<string, Set<string>> {
  const owners = new Map<string, Set<string>>();
  for (const [paperId, anchors] of Object.entries(map)) {
    for (const anchor of anchors) {
      const set = owners.get(anchor) ?? new Set<string>();
      set.add(paperId);
      owners.set(anchor, set);
    }
  }
  return owners;
}

/**
 * The owners of an anchor, or null when that cannot be known in time. Keyed by
 * the project's document set as well as its id, so adding or removing a
 * document asks again.
 */
export function sectionOwnerLookup(projectId: string, papers: Paper[], load: Load = loadFromServer) {
  const key = papers.map((paper) => paper.id).sort().join(",");
  return async (anchor: string, deadline: number): Promise<Set<string> | null> => {
    let entry = cache.get(projectId);
    if (!entry || entry.key !== key) {
      const owners = load(projectId).then(byAnchor);
      entry = { key, owners };
      cache.set(projectId, entry);
      owners.catch(() => {
        if (cache.get(projectId) === entry) cache.delete(projectId);
      });
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), remaining); });
    try {
      const owners = await Promise.race([entry.owners, late]);
      return owners ? owners.get(anchor) ?? new Set<string>() : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * The same question asked of every project a library spans, for a Memory chat:
 * its answers cite web documents wherever they are filed. Each project keeps
 * its own cache and its own deadline rule; what any of them knows in time is
 * the answer, and only when none does is the verdict unknown.
 */
export function librarySectionOwners(
  documents: Array<Paper & { projectId: string }>,
  load: Load = loadFromServer,
) {
  const byProject = new Map<string, Paper[]>();
  for (const document of documents) byProject.set(document.projectId, [...(byProject.get(document.projectId) ?? []), document]);
  const lookups = [...byProject].map(([projectId, papers]) => sectionOwnerLookup(projectId, papers, load));
  return async (anchor: string, deadline: number): Promise<Set<string> | null> => {
    const answers = await Promise.all(lookups.map((lookup) => lookup(anchor, deadline)));
    if (answers.every((owners) => owners === null)) return null;
    return new Set(answers.flatMap((owners) => [...(owners ?? [])]));
  };
}
