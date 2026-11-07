/**
 * The single source of truth for the words the composer types out while it
 * waits for the model's first token. Add or reword here and every surface that
 * shows a waiting state follows.
 */
export const LOADING_PHRASES = [
  "Thinking",
  "Digesting",
  "Comprehending",
  "Considering",
  "Parsing",
  "Reasoning",
  "Connecting",
  "Weighing",
  "Distilling",
  "Reflecting",
];

/**
 * A fresh random order of the phrases. Drawing from a permutation rather than
 * picking at random each time means no phrase repeats until the list is spent,
 * so a long wait never stutters on the same word twice in a row.
 */
export function shuffledPhrases(): string[] {
  const items = [...LOADING_PHRASES];
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [items[index], items[swap]] = [items[swap], items[index]];
  }
  return items;
}
