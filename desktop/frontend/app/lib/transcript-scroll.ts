/**
 * Where a conversation's transcript should scroll after a render, or null to
 * leave it where the reader has it.
 *
 * The first placement is instant — the saved position when this tab has been
 * here before, otherwise the latest turn — and waits for history: placing an
 * empty transcript would mark the placement done, and a long history landing
 * afterwards is more than a screen from the bottom, so nothing would follow
 * it. After that only a reader already within a screen of the end is kept
 * there as turns stream in; one who scrolled up to read is left alone.
 */
export function transcriptScroll(view: {
  placed: boolean;
  historyLoaded: boolean;
  saved?: number;
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
}): { top: number; placed: true } | null {
  if (!view.placed) {
    if (!view.historyLoaded) return null;
    return { top: view.saved ?? view.scrollHeight, placed: true };
  }
  return view.scrollHeight - view.clientHeight - view.scrollTop < view.clientHeight
    ? { top: view.scrollHeight, placed: true }
    : null;
}
