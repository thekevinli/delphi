import { isWebPaper, isWebPdf, type Paper } from "./api.ts";
import {
  citationCandidates,
  identifiedPaper,
  type CitationTarget,
} from "./citations.ts";
import { probe, type LocatorHit } from "./locator-index.ts";

/**
 * Which document a citation meant, and where in it.
 *
 * Two thirds of real citations name no paper, and the reader used to answer
 * those with whatever was on screen — so an answer comparing two papers sent
 * every one of its cross-references into the wrong one. The rules below are
 * ordered, and the order is the whole design: the locator index can *rule a
 * paper out*, never vote one in. Two papers can each contain an "Equation 7";
 * finding one proves nothing about which was meant.
 */

export type CitationRoute = { paper: Paper; hit: LocatorHit | null };

/**
 * How long a click may spend deciding, across every paper it asks about.
 *
 * Resolving before navigating is what makes a citation land in the right
 * document, but it also means a slow document load or a stalled extraction is a
 * click that visibly does nothing — the same silence this work set out to
 * remove, arriving by a different route. When the budget runs out every
 * remaining verdict is `unknown`, which lands the reader on the cited page of
 * the paper we already believed in. A warm document answers in a few
 * milliseconds and never comes near this.
 */
const BUDGET_MS = 2000;

/** Only a paged document has a locator index to ask (`citationCandidates`). */
const findable = (paper: Paper) => !isWebPaper(paper) || isWebPdf(paper);

export async function routeCitation(
  target: CitationTarget,
  papers: Paper[],
  current: Paper | null,
  fileUrl: (paper: Paper) => string,
  /**
   * Papers this answer actually named. The candidate list ends here rather than
   * running on through the library: a nameless citation whose locator is absent
   * from the open paper must not be handed to some unrelated document that
   * happens to have a table of the same number. Nothing pointed at it.
   */
  mentioned: Paper[] = [],
  /** True once a newer click, or a change of paper, has superseded this one. */
  cancelled?: () => boolean,
  /**
   * Which documents own a `§anchor` (`anchor-index`), or null when that cannot
   * be known before the deadline. Absent, anchors route as they always did.
   */
  sectionOwners?: (anchor: string, deadline: number) => Promise<Set<string> | null>,
): Promise<CitationRoute | null> {
  const limit = { deadline: Date.now() + BUDGET_MS, cancelled };
  const locate = async (paper: Paper) =>
    target.locator && findable(paper)
      ? await probe({ id: paper.id, fileUrl: fileUrl(paper) }, target.locator, target.pages, limit)
      : ({ state: "unknown" } as const);

  // 1. A paper the model named and the library identifies beyond doubt is
  //    final. The index may only say *where* in it to land: a locator it cannot
  //    find yields a page-level guide in that paper and never a redirect,
  //    because a gap in our own text extraction must not move the reader to a
  //    document the model was not talking about.
  const named = identifiedPaper(target.paperName, papers);
  if (named) {
    const verdict = await locate(named);
    return { paper: named, hit: verdict.state === "found" ? verdict.hit : null };
  }

  // 2. Everything else is a candidate list, in order of how much reason there
  //    is to believe it: a weak or tied name match, then the paper the
  //    surrounding prose was about, then the one on screen, then the rest.
  const candidates = citationCandidates(target, papers, current, mentioned);

  // 3. A bare `§anchor` names a section, and a section belongs to exactly the
  //    documents whose snapshot has it — so here the index may vote a paper
  //    in, unlike a table number two papers can share. Among several owners
  //    the candidate order still decides; an owner nothing in the answer
  //    pointed at is still the only place that section exists. An unknown or
  //    empty answer relocates nothing.
  if (target.anchor && sectionOwners && !cancelled?.()) {
    const owners = await sectionOwners(target.anchor, limit.deadline);
    if (owners?.size) {
      const owning = candidates.find((paper) => owners.has(paper.id))
        ?? papers.find((paper) => owners.has(paper.id));
      if (owning) return { paper: owning, hit: null };
    }
  }

  // 4. A page number has already ruled out a document that has no pages
  //    (`citationCandidates`). Nothing left means nowhere to go, and the
  //    renderer draws such a citation as prose.
  if (!candidates.length) return null;

  if (!target.locator) return { paper: candidates[0], hit: null };

  // 5. Ask each in turn and take the first that is not ruled out. `unknown`
  //    keeps its place rather than stepping aside: it means we could not read
  //    the document, not that the document lacks the locator.
  for (const paper of candidates) {
    const verdict = await locate(paper);
    if (verdict.state === "found") return { paper, hit: verdict.hit };
    if (verdict.state === "unknown") return { paper, hit: null };
  }
  // 6. Every candidate we could check genuinely lacks it. Nothing has been
  //    learned about where to go, so go where we would have gone anyway.
  return { paper: candidates[0], hit: null };
}
