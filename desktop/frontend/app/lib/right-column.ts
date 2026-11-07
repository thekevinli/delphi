/**
 * How fast the right column grows with the window: a 700px column per 38% of
 * it. A fixed size suited only a laptop — 700px is nearly half of a 1512px
 * window but barely a quarter of a 2560px one — so past about 1840px, where
 * 38% overtakes 700px, every width below grows in step, and a 2560px display
 * gets columns about 40% wider than a laptop's.
 */
export const RIGHT_COLUMN_SHARE = 0.38;
const SHARE_BASE = 700;

/**
 * The Reader's ceiling on a laptop, which a large display lifts. 10% past the
 * 700px the growth was fitted to, so a dragged column has room to spare while
 * the opening width stays where it was.
 */
export const READER_CHAT_CEILING = 770;

/** The docked conversation's opening width on a laptop. */
export const CHAT_COLUMN = 460;

/** Memory's docked conversation: its floor, its fixed ceiling, and the room it leaves the page. */
export const MEMORY_CHAT = { min: 272, ceiling: 792, page: 520 };

/**
 * How much a large display grows the right column: 1 until about 1840px, then
 * in step with the window. Every width below — ceilings and opening widths —
 * is its laptop size times this, so each keeps its proportion to the others.
 */
export function rightColumnScale(viewport: number): number {
  return Math.max(1, (viewport * RIGHT_COLUMN_SHARE) / SHARE_BASE);
}

/**
 * The widest the right column may be dragged on a window `viewport` px wide:
 * the shell's laptop `floor`, grown with the window.
 *
 * Only a ceiling. Whether the window has room for it beside the reader is the
 * caller's other bound, and that one still wins.
 */
export function rightColumnCeiling(viewport: number, floor: number): number {
  return Math.round(floor * rightColumnScale(viewport));
}

/** The docked conversation's opening width: 460px on a laptop, then scaled. */
export function defaultChatColumn(viewport: number): number {
  return Math.round(CHAT_COLUMN * rightColumnScale(viewport));
}

/**
 * Memory's conversation `width` as a window `viewport` px wide can hold it.
 * Applied to a dragged width on every resize too: one dragged wide on a large
 * display must not keep that width when the window moves to a laptop.
 */
export function memoryChatColumn(width: number, viewport: number): number {
  return Math.max(
    MEMORY_CHAT.min,
    Math.min(width, rightColumnCeiling(viewport, MEMORY_CHAT.ceiling), viewport - MEMORY_CHAT.page),
  );
}
