/** Per-account memory for the last wiki page, tolerant of unavailable storage. */
import { isMemorySlug } from "./memory.ts";

const MEMORY_PREFIX = "delphi:last-memory-page:";

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Remember the wiki page `username` last had open. */
export function rememberMemoryPage(username: string, slug: string): void {
  if (!username || !slug || !isMemorySlug(slug)) return;
  try {
    storage()?.setItem(`${MEMORY_PREFIX}${username}`, slug);
  } catch {
    // Same trade as above: a convenience, never a correctness property.
  }
}

/**
 * The wiki page `username` last had open, or null. Re-validated on the way
 * out because it has been sitting in a store the
 * page's own scripts can write, and it is about to become an address.
 */
export function recallMemoryPage(username: string): string | null {
  if (!username) return null;
  let value: string | null = null;
  try {
    value = storage()?.getItem(`${MEMORY_PREFIX}${username}`) ?? null;
  } catch {
    return null;
  }
  return value && isMemorySlug(value) ? value : null;
}
