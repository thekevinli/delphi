/** How many tabs fit the navigation strip (tabs and "+", after the context
 * button and before the window controls) with every tab at least its readable
 * width. Chats past that wait in the context menu's list. */
const TAB_MIN_ACTIVE = 160;
const TAB_MIN_OTHER = 128;
const STRIP_CHROME = 4 + 4 + 24; // tabs' inset, gap, "+"

export function visibleConversationCount(width: number, total: number): number {
  if (total <= 1) return Math.max(0, total);
  const fit = 1 + Math.floor((width - STRIP_CHROME - TAB_MIN_ACTIVE) / TAB_MIN_OTHER);
  return Math.max(1, Math.min(total, fit));
}

/** Whether the context button can spell out its name, `cost` px wider, in a
 * strip `width` px wide beside its icon alone: only while the tab on screen
 * keeps its readable width and no open tab loses its place. */
export function contextNameFits(width: number, cost: number, total: number): boolean {
  return width - cost >= STRIP_CHROME + TAB_MIN_ACTIVE && visibleConversationCount(width - cost, total) === visibleConversationCount(width, total);
}
