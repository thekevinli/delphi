/* Shared by the untrusted DOM bridge and the trusted reader worker. No storage. */
(function (scope) {
  "use strict";
  const MAX_TEXT = 600000;
  const VERSION = 1;
  async function hash(text) {
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), x => x.toString(16).padStart(2, "0")).join("");
  }
  async function index(texts, reuse) {
    if (!Array.isArray(texts) || texts.length > MAX_TEXT || texts.some(t => typeof t !== "string" || (t.isWellFormed && !t.isWellFormed())) || texts.reduce((n, t) => n + t.length + 1, 0) > MAX_TEXT)
      throw Error("Page text exceeds annotation limits");
    let offset = 0;
    const blocks = [];
    // Bounded batches avoid hundreds of thousands of simultaneous crypto jobs.
    for (let i = 0; i < texts.length; i += 128) {
      const hashes = await Promise.all(texts.slice(i, i + 128).map(hash));
      for (let j = 0; j < hashes.length; j++) {
        const prior = reuse?.byHash.get(hashes[j])?.[0]?.text;
        blocks.push({ hash: hashes[j], start: offset, text: prior === texts[i + j] ? prior : texts[i + j] });
        offset += texts[i + j].length + 1;
      }
    }
    let text = blocks.map(b => b.text).join("\n");
    if (reuse?.text === text)
      text = reuse.text;
    const byHash = new Map();
    for (const block of blocks) {
      if (!byHash.has(block.hash))
        byHash.set(block.hash, []);
      byHash.get(block.hash).push(block);
    }
    return { blocks, byHash, text, revision: await hash(VERSION + "\n" + text) };
  }
  function anchor(idx, start, end) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > idx.text.length || end - start > 20000)
      throw Error("Invalid selection");
    const ordinal = idx.blocks.findIndex(b => start >= b.start && start <= b.start + b.text.length);
    if (ordinal < 0)
      throw Error("Selection is outside article text");
    const b = idx.blocks[ordinal];
    const splitsPair = offset => offset > 0 && offset < idx.text.length && /[\uD800-\uDBFF]/.test(idx.text[offset - 1]) && /[\uDC00-\uDFFF]/.test(idx.text[offset]);
    if (splitsPair(start) || splitsPair(end))
      throw Error("Selection splits a Unicode character");
    let before = Math.max(0, start - 128), after = Math.min(idx.text.length, end + 128);
    if (splitsPair(before))
      before++;
    if (splitsPair(after))
      after--;
    return { version: VERSION, revision: idx.revision, blockHash: b.hash, blockOrdinalHint: ordinal,
      startInBlock: start - b.start, start, end, prefix: idx.text.slice(before, start), suffix: idx.text.slice(end, after) };
  }
  function contextScore(text, start, end, a) {
    let left = 0, right = 0;
    while (left < a.prefix.length && start - left > 0 && a.prefix[a.prefix.length - left - 1] === text[start - left - 1])
      left++;
    while (right < a.suffix.length && end + right < text.length && a.suffix[right] === text[end + right])
      right++;
    return left + right;
  }
  function resolve(idx, annotation, complete, deadline = performance.now() + 20) {
    const a = annotation.anchor, quote = annotation.text;
    if (!a || a.version !== VERSION || typeof quote !== "string" || !quote.length || quote.length > 20000)
      return { status: "unavailable" };
    const place = (start) => ({ status: "placed", start, end: start + quote.length });
    const previous = annotation.placement;
    if (previous?.revision === idx.revision && Number.isSafeInteger(previous.start) && previous.start >= 0 && previous.end - previous.start === quote.length && idx.text.slice(previous.start, previous.end) === quote)
      return place(previous.start);
    if (a.revision === idx.revision && idx.text.slice(a.start, a.end) === quote)
      return place(a.start);
    // A hash identifies content, never the identity of repeated identical blocks.
    const blocks = idx.byHash.get(a.blockHash) || [];
    if (blocks.length === 1) {
      const b = blocks[0], start = b.start + a.startInBlock;
      if (a.startInBlock + quote.length <= b.text.length && idx.text.slice(start, start + quote.length) === quote)
        return place(start);
    }
    let found = -1, count = 0, best = -1, bestScore = -1, tied = false, from = 0;
    while (from <= idx.text.length - quote.length) {
      if (performance.now() > deadline)
        return { status: "unknown" };
      const at = idx.text.indexOf(quote, from);
      if (at < 0)
        break;
      found = at;
      count++;
      const score = contextScore(idx.text, at, at + quote.length, a);
      if (score > bestScore) {
        best = at;
        bestScore = score;
        tied = false;
      }
      else if (score === bestScore)
        tied = true;
      from = at + 1;
    }
    // Until acquisition settles another equal occurrence can still arrive.
    if (!complete)
      return { status: "unknown" };
    if (count === 1)
      return place(found);
    if (count > 1 && bestScore > 0 && !tied)
      return place(best);
    return { status: count ? "ambiguous" : "missing" };
  }
  /**
   * A login, subscription or error page standing where the article should be.
   * Its text is still text, and matching a mark against it would only find
   * nothing, so no placement is final while it is on screen. Kept in step with
   * `walled` in `web_revision.py`.
   */
  function walled(idx) {
    const boundary = idx.text.slice(0, 500) + "\n" + idx.text.slice(-800);
    return /subscribe to (continue|read)|sign in to (continue|read)|log in to (continue|read)|access denied|404[ :—-]*not found/i.test(boundary);
  }
  scope.DelphiAnnotations = { VERSION, MAX_TEXT, hash, index, anchor, resolve, walled };
})(globalThis);
