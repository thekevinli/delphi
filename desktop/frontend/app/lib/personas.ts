/**
 * What the client knows about personas without asking the server.
 *
 * JSX-free so `node --test --experimental-strip-types` can unit-test it, and the
 * single place the element vocabulary is written down on this side — the icons,
 * the colour tokens and the editor's picker all read it from here rather than
 * each keeping their own list to fall out of step.
 *
 * What is deliberately *not* here any more is which personas the server ships.
 * There used to be an `OFFICIAL_PERSONA_IDS` list, and its only job was to split
 * one menu into "Official" and "Your personas" — which `PersonaSummary.official`
 * already answers, on the wire, for every row. Keeping the list meant the
 * catalogue was stated in two repositories and the client's copy went stale the
 * moment the backend's changed.
 */

export const PERSONA_ELEMENTS = [
  "fire",
  "water",
  "leaf",
  "bolt",
  "stone",
  "wind",
] as const;

export type PersonaElement = (typeof PERSONA_ELEMENTS)[number];

/**
 * What a conversation answers as until the reader picks otherwise.
 *
 * The pre-response placeholder only: the server publishes the real answer
 * through `/api/config` as `defaultPersona`, and it is the authority. This
 * exists so a menu rendered before that response lands names something, which
 * is a different job from classifying a catalogue — hence this staying while
 * the id list went.
 */
export const DEFAULT_PERSONA_ID = "mentor";

/** Kept for stored custom personas; chat no longer gates tools on it. */
export type PersonaCapability = "learner_memory";

export function isPersonaElement(value: unknown): value is PersonaElement {
  return (
    typeof value === "string" &&
    (PERSONA_ELEMENTS as readonly string[]).includes(value)
  );
}

/** Never trust a stored element to still exist; an unknown one would render as a gap. */
export function personaElement(value: unknown): PersonaElement {
  return isPersonaElement(value) ? value : "stone";
}
