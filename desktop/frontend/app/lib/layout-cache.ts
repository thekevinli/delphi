/** Graph positions, cached per graph revision; every other revision is dead. */
export const LAYOUT_CACHE_PREFIX = "delphi:memory-layout:";
/** The prefix before 0.7.0. Browsers still hold layouts under it, and the sweep clears them too. */
const FORMER_PREFIX = "delphi:knowledge-layout:";

/** Keep `positions` as revision `key`'s layout, and sweep every other revision's. */
export function rememberLayout(key: string, positions: Float32Array): void {
  try {
    // The revision moves on every Memory write, so without this sweep
    // each write leaves its own dead copy of the layout behind until the
    // quota throws and the cache silently stops working for good.
    const current = `${LAYOUT_CACHE_PREFIX}${key}`;
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const held = localStorage.key(index);
      if (held && (held.startsWith(LAYOUT_CACHE_PREFIX) || held.startsWith(FORMER_PREFIX)) && held !== current) {
        localStorage.removeItem(held);
      }
    }
    localStorage.setItem(current, JSON.stringify(Array.from(positions)));
  } catch {
    // The graph remains fully usable without the revisit cache.
  }
}
