/**
 * Why a filing failed, said the same way on every surface.
 *
 * The server names the cause from the error it caught (`failure` on a
 * maintenance job, from core's `memory_failure.py`), so nothing
 * here reads an error's wording. A cause is a short title and one line; the
 * error itself stays one press away, as technical detail.
 *
 * JSX-free so `node --test` can run it.
 */

import type { JobFailure } from "./api.ts";

export type FailureCause =
  | "check"
  | "answer"
  | "provider"
  | "signin"
  | "interrupted"
  | "document"
  | "unknown";

/** Saffron is the model's work, walnut the provider, sand Delphi's side. */
export type FailureTone = "saffron" | "walnut" | "sand";

/** What fixes it: filing it again, reconnecting the provider, or opening the document. */
export type FailureFix = "retry" | "connection" | "open";

export type FailureCopy = {
  title: string;
  line: string;
  tone: FailureTone;
  fix: FailureFix;
  /** A 16px stroke icon. */
  icon: string;
};

/** Every cause, in the order a reader can act on them. */
export const FAILURE_CAUSES: Record<FailureCause, FailureCopy> = {
  check: {
    title: "Failed the source check",
    line: "No page was written.",
    tone: "saffron",
    fix: "retry",
    icon: "M4 1.8h5.5L12.5 5v9.2H4zM9.3 1.8V5.2h3.2M6.2 9.5h4.1",
  },
  answer: {
    title: "Unusable answer",
    line: "The model’s reply came back cut off or garbled.",
    tone: "saffron",
    fix: "retry",
    icon: "M2.5 3h11v8H7l-3 2.5V11H2.5zM6.6 5.6a1.5 1.5 0 1 1 1.9 1.4c-.3.1-.5.4-.5.7M8 9.2v.1",
  },
  provider: {
    title: "Provider unavailable",
    line: "Busy, down or past your plan’s limit.",
    tone: "walnut",
    fix: "retry",
    icon: "M4.5 12.5h7a3 3 0 0 0 .4-6A4.2 4.2 0 0 0 3.9 7a2.8 2.8 0 0 0 .6 5.5zM8 7.6v2.2M8 11.3v.1",
  },
  signin: {
    title: "Sign-in refused",
    line: "Reconnect your AI provider.",
    tone: "walnut",
    fix: "connection",
    icon: "M4 7.5h8v6.5H4zM5.8 7.5V5.2a2.2 2.2 0 0 1 4.4 0v2.3",
  },
  interrupted: {
    title: "Interrupted",
    line: "Delphi quit, slept or collided with another filing.",
    tone: "sand",
    fix: "retry",
    icon: "M12.5 9.6A5 5 0 0 1 6.4 3.5a5 5 0 1 0 6.1 6.1z",
  },
  document: {
    title: "Document unreadable",
    line: "Its saved copy is missing or damaged.",
    tone: "sand",
    fix: "open",
    icon: "M4 1.8h5.5L12.5 5v9.2H4zM9.3 1.8V5.2h3.2M6.4 8.4l3.2 3.2M9.6 8.4l-3.2 3.2",
  },
  unknown: {
    title: "Unknown error",
    line: "See the technical detail.",
    tone: "sand",
    fix: "retry",
    icon: "M8 2.2a5.8 5.8 0 1 0 0 11.6A5.8 5.8 0 0 0 8 2.2ZM6.5 6.4a1.6 1.6 0 1 1 2.1 1.5c-.4.1-.6.5-.6.9M8 10.8v.1",
  },
};

/** A job that failed with tries left. Not a failure yet: nothing for the reader to do. */
export const RETRYING_COPY = {
  title: "Retrying soon",
  line: "Nothing to do.",
  icon: "M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3",
};

/** The cause the server recorded, or `unknown` for a row from before causes were. */
export function causeOf(job: { failure?: JobFailure | null }): FailureCause {
  const cause = job.failure?.cause;
  return cause && cause in FAILURE_CAUSES ? cause : "unknown";
}

/** The cause in one sentence pair, for a surface with room for no more: "Sign-in refused. Reconnect your AI provider." */
export function failureSentence(cause: FailureCause): string {
  const { title, line } = FAILURE_CAUSES[cause];
  return `${title}. ${line}`;
}

/** Items grouped by cause, in `FAILURE_CAUSES` order, leaving out the causes none has. */
export function groupByCause<T extends { cause: FailureCause }>(
  items: T[],
): Array<{ cause: FailureCause; items: T[] }> {
  return (Object.keys(FAILURE_CAUSES) as FailureCause[])
    .map((cause) => ({ cause, items: items.filter((item) => item.cause === cause) }))
    .filter((group) => group.items.length > 0);
}
