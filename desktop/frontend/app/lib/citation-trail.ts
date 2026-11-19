/**
 * The way back out of a citation jump.
 *
 * Following a citation into another document is the one navigation the reader did
 * not choose a destination for — they clicked a claim, not a paper — so the reader
 * is owed a way back. This is that memory.
 *
 * It is a stack because it used to be a single slot: A → B → C overwrote the note
 * that said "you came from A", so the trail led back exactly one step no matter how
 * far you had followed it. Chains of two are common — an answer cites a paper, that
 * paper's own chat cites a third — and losing the start of one is the difference
 * between a trail and a breadcrumb.
 *
 * Pure on purpose. The component holds it in state, but every rule about how it
 * moves lives here, where it can be tested without a browser.
 */

export type TrailEntry = {
  /** Where the reader was, complete with query, so returning restores the thread. */
  path: string;
  /** What to call it on the button. */
  title: string;
  /**
   * Which project it belongs to, so a trail can be scoped to the one being read
   * rather than cleared by an effect watching for the project to change. A step
   * back into a document that is no longer in the library is not a step anyone
   * wants, and filtering says so without a second render pass.
   */
  projectId: string;
  /** Internal identity lets a return survive a title/slug rename mid-trail. */
  paperId?: string;
};

/**
 * Record where the reader is leaving from.
 *
 * A jump that arrives back somewhere already on the trail unwinds to it rather
 * than stacking a second copy — following A → B → A → B forever should not build
 * an unbounded pile of alternating entries, and the honest way back from the
 * second B is still A.
 */
export function pushTrail(
  trail: TrailEntry[],
  from: TrailEntry,
  destination: string,
): TrailEntry[] {
  const seen = trail.findIndex((entry) => entry.path === destination);
  if (seen >= 0) return trail.slice(0, seen);
  return [...trail, from];
}

/** Step back one. Returns where to go, and the trail with that step spent. */
export function popTrail(trail: TrailEntry[]): {
  to: TrailEntry | null;
  rest: TrailEntry[];
} {
  if (!trail.length) return { to: null, rest: trail };
  return { to: trail[trail.length - 1], rest: trail.slice(0, -1) };
}

/**
 * Whatever the reader does deliberately replaces the trail.
 *
 * Picking a document from the library means the path that led here is no longer
 * the path they are on. Leaving a stale entry is how the old code offered
 * "Back to X" for an X that was not in the library any more — and then handed the
 * viewers a paper id that answered 404.
 */
export function clearTrail(trail: TrailEntry[]): TrailEntry[] {
  return trail.length ? [] : trail;
}

/**
 * The part of the trail that belongs to the project being read.
 *
 * Leaving a project hides its trail without anything having to notice the change
 * and react to it — which is the same guarantee the old clear-on-change effect
 * gave, minus the effect.
 */
export function trailWithin(
  trail: TrailEntry[],
  projectId: string | null,
): TrailEntry[] {
  if (!projectId) return [];
  return trail.filter((entry) => entry.projectId === projectId);
}
