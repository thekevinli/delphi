/**
 * How an answer that did not finish says so.
 *
 * The backend never stores a cut-off response as a finished answer: it keeps
 * what was written and marks the message `incomplete` with the reason. This is
 * the one place that reason becomes words.
 *
 * JSX-free so `node --test --experimental-strip-types` can load it.
 */

const NOTICES: Record<string, string> = {
  // The provider stopped at its output ceiling, thinking included.
  max_output_tokens: "This answer was cut off before it finished.",
  // Delphi stopped waiting: the whole turn has a time limit.
  deadline: "This answer ran out of time before it finished.",
};

/** What to say under an answer that was cut off. Never empty. */
export function cutOffNotice(reason: string | undefined): string {
  return NOTICES[reason ?? ""] ?? NOTICES.max_output_tokens;
}

/** The stored `incomplete` field, if it is one. Anything else is not a cut-off. */
export function incompleteOf(value: unknown): { reason: string } | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const reason = (value as { reason?: unknown }).reason;
  return typeof reason === "string" && reason ? { reason: reason.slice(0, 80) } : undefined;
}
