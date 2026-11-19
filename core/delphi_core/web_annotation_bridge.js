/* Called inside the bridge closure. Historical quotes and note bodies never enter. */
function installAnnotations(post) {
  const EXCLUDE = 'script,style,noscript,template,nav,aside,footer,form,dialog,[role="dialog"],[role="navigation"],[aria-modal="true"],iframe,video,audio,[data-ad],ins.adsbygoogle,lite-youtube,lite-vimeo';
  const BLOCK = 'p,li,h1,h2,h3,h4,h5,h6,pre,td,th,blockquote,figcaption,div,section,article,main';
  /**
   * How the page's text is read, the way Text Fragments and Hypothesis read it.
   *
   * Nothing here waits for the page to hold still. A highlight is taken from the
   * live selection at the moment the reader asks for it (`capture`), so a page
   * that is busy elsewhere cannot keep it from being made. The index that marks
   * are painted from is rebuilt `QUIET_MS` after the article's text stops
   * changing, and at most `MAX_WAIT_MS` after it first changed if it never does
   * — a simulation relabelling itself, or MathJax typesetting four hundred
   * formulas one at a time for a minute and a half. Painted marks are live
   * ranges and stay on their text between rebuilds.
   *
   * What is left out is decided by what an element is (`EXCLUDE`), never by how
   * it behaves: a ticking counter or a typeset formula is page text like any
   * other, and a reader can mark the prose around it.
   */
  const QUIET_MS = 1000, MAX_WAIT_MS = 2000, COMPLETE_AFTER_MS = 20000;
  let generation = 0, entries = [], root = null, timer = null, ready = false, pending = false, dirtySince = null;
  const started = performance.now();
  // The reader's current selection, and a number that changes whenever it does,
  // so a capture is of the passage the menu was opened for and no other.
  let selected = null, selectionSerial = 0;
  function excluded(node) { return node.matches(EXCLUDE); }
  /**
   * Whether a change touched the article's text, which is all the index is.
   *
   * A diagram that adds a dot every tick, a spinner, an image arriving, an ad
   * slot filling in: the observer reports each as a change, and none adds or
   * removes a character a highlight could be anchored to, so none is worth
   * reading the page again for. Scripts and styles are not the article's text
   * either, and nor is anything the index already leaves out.
   */
  function carriesText(node) {
    if (node.nodeType === 3)
      return node.data.trim() !== '';
    return node.nodeType === 1 && !node.matches(EXCLUDE) && (node.textContent || '').trim() !== '';
  }
  function changesText(record) {
    if (record.type === 'characterData')
      return true;
    for (const node of record.addedNodes)
      if (carriesText(node)) return true;
    for (const node of record.removedNodes)
      if (carriesText(node)) return true;
    return false;
  }
  function insideExcluded(node) {
    for (let parent = node; parent; parent = parent.parentElement)
      if (excluded(parent)) return true;
    return false;
  }
  let ranges = new Map(), paintSerial = 0;
  const yieldTask = () => new Promise(resolve => setTimeout(resolve, 0));
  const originalPath = location.pathname + location.search;
  function allowed() { return location.pathname + location.search === originalPath; }
  function clear() { paintSerial++; if (globalThis.CSS?.highlights)
    CSS.highlights.delete('delphi-annotations'); ranges.clear(); measured = [];
    // Marks the pointer was over have just stopped existing; leaving the flag
    // set would leave the page wearing a pointer cursor over ordinary prose.
    hovering = false; document.documentElement.removeAttribute('data-delphi-annotation-hover'); }
  const article = () => document.querySelector('article') || document.querySelector('main') || document.body;
  /**
   * The article's text as blocks, and where each text node sits in it.
   *
   * A generator, so the one walk serves both readers: the index drives it a
   * slice at a time and gives the page the thread in between, and a capture
   * runs it to the end in one go, so the text and the selection it measures are
   * read from the same page.
   */
  function* collect(from) {
    const walker = document.createTreeWalker(from, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === 1)
          return excluded(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
        return node.parentElement && insideExcluded(node.parentElement) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      }
    });
    let node, block = null, parts = [], texts = [], map = [], offset = 0, elapsed = performance.now();
    const flush = () => { if (parts.length) {
      texts.push(parts.join(''));
      offset += 1;
      parts = [];
    } };
    while ((node = walker.nextNode())) {
      if (node.nodeType !== 3 || !node.data.length)
        continue;
      const owner = node.parentElement.closest(BLOCK) || from;
      if (owner !== block) {
        flush();
        block = owner;
      }
      map.push({ node, start: offset, end: offset + node.data.length });
      parts.push(node.data);
      offset += node.data.length;
      if (offset > 600000 || map.length > 100000)
        throw Error('Page exceeds annotation limits');
      if (performance.now() - elapsed > 4) {
        yield;
        elapsed = performance.now();
      }
    }
    flush();
    return { texts, map };
  }
  async function scan() {
    // A reading already under way finishes first; this one follows it.
    if (pending) {
      dirtySince ??= performance.now();
      return;
    }
    pending = true;
    // Changes from here on are after this reading, and earn another.
    dirtySince = null;
    try {
      if (!allowed())
        return;
      const from = article();
      if (!from)
        return;
      const walk = collect(from);
      let step;
      while (!(step = walk.next()).done) {
        await yieldTask();
        if (!allowed())
          return;
      }
      root = from;
      entries = step.value.map;
      ready = true;
      generation++;
      post({ type: 'annotation-index', generation, texts: step.value.texts, complete: performance.now() - started >= COMPLETE_AFTER_MS });
    }
    catch (error) {
      // Nothing will repaint a page that cannot be indexed.
      ready = false;
      entries = [];
      clear();
      post({ type: 'annotation-unavailable', generation, message: String(error) });
    }
    finally {
      pending = false;
      if (dirtySince !== null)
        schedule();
    }
  }
  function schedule() {
    clearTimeout(timer);
    const wait = dirtySince === null ? QUIET_MS : Math.max(0, Math.min(QUIET_MS, dirtySince + MAX_WAIT_MS - performance.now()));
    timer = setTimeout(scan, wait);
  }
  function changed() {
    if (dirtySince === null)
      dirtySince = performance.now();
    schedule();
  }
  /**
   * Stop answering for the painted marks without taking them off the page.
   *
   * Invalidating used to clear the highlights outright, and they stayed gone
   * until the page had been re-indexed and the panel had painted them again —
   * a couple of seconds of blank page every time the article changed, and
   * every time the library folding away reflowed it. The marks are live
   * ranges, so they stay on the text they were painted on; the next paint
   * replaces them in one step. Until then nothing may act on them: no
   * pointer, no click, no measurement against an index that no longer exists.
   */
  function retire() { paintSerial++; ranges = new Map(); measured = []; }
  // Leaving the article's own address: no repaint will come for the page the
  // marks belonged to, so they go at once.
  function leave() { generation++; ready = false; entries = []; selected = null; clear(); post({ type: 'annotation-invalidated', generation }); }
  function point(map, node, offset, isEnd = false) {
    if (node.nodeType === 3) {
      const entry = map.find(e => e.node === node);
      return entry && offset <= node.length ? entry.start + offset : null;
    }
    const range = document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    if (isEnd) {
      for (let i = map.length - 1; i >= 0; i--) {
        const entry = map[i];
        if (range.comparePoint(entry.node, entry.node.length) <= 0)
          return entry.end;
      }
    }
    else
      for (const entry of map) {
        if (range.comparePoint(entry.node, 0) >= 0)
          return entry.start;
      }
    return null;
  }
  /**
   * Whether the reader's selection can become an annotation: it reaches into
   * the article and is not wholly inside something the article leaves out.
   * Nothing is measured here; `capture` measures when the reader asks.
   */
  function selection(range) {
    const from = article();
    const inside = from && !range.collapsed && allowed() && (from.contains(range.commonAncestorContainer) || range.intersectsNode(from));
    const common = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
    if (!inside || (common && insideExcluded(common))) {
      selected = null;
      return null;
    }
    const same = selected && selected.startContainer === range.startContainer && selected.startOffset === range.startOffset &&
      selected.endContainer === range.endContainer && selected.endOffset === range.endOffset;
    if (!same) {
      selected = range.cloneRange();
      selectionSerial++;
    }
    return { selection: selectionSerial };
  }
  /**
   * The reader's selection as the parent's worker needs it: the article's text
   * as it is now, and where the selection sits in it, read in one pass so the
   * two cannot disagree however busy the page is.
   */
  function capture(request, serial) {
    const answer = fields => post({ type: 'annotation-capture', request, ...fields });
    try {
      if (!allowed() || !selected || serial !== selectionSerial || selected.collapsed)
        return answer({ error: 'The passage changed. Select it again.' });
      const walk = collect(article());
      let step;
      while (!(step = walk.next()).done);
      const { texts, map } = step.value;
      const start = point(map, selected.startContainer, selected.startOffset), end = point(map, selected.endContainer, selected.endOffset, true);
      if (start === null || end === null || end <= start || end - start > 20000)
        return answer({ error: 'Select a passage of the article.' });
      answer({ texts, start, end });
    }
    catch (error) {
      answer({ error: String(error.message || error) });
    }
  }
  function makeRange(start, end) {
    function containing(offset) {
      let lo = 0, hi = entries.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (entries[mid].start <= offset)
          lo = mid + 1;
        else
          hi = mid;
      }
      return entries[lo - 1];
    }
    const a = containing(start), b = containing(end - 1);
    // An entry can be older than its node's text: the index is rebuilt a
    // moment after the page changes, not as it does.
    if (!a || !b || start >= a.end || end > b.end || !a.node.isConnected || !b.node.isConnected || start - a.start > a.node.length || end - b.start > b.node.length)
      return null;
    const range = document.createRange();
    range.setStart(a.node, start - a.start);
    range.setEnd(b.node, end - b.start);
    return range;
  }
  /**
   * Take the reader to a mark: scroll until it sits in the middle of the view.
   *
   * The panel names the mark by where it is in the current text — the offsets
   * it was painted from — so this arrives at the painted passage itself. The
   * citation guide's search for the quoted words cannot do that: it looks in
   * one text node at a time, so a passage with a footnote marker or a styled
   * word in it is never found, and a sentence that appears twice is found
   * wherever it appears first.
   */
  function reveal(data) {
    if (!ready || !allowed() || data.generation !== generation || !Number.isSafeInteger(data.start) || !Number.isSafeInteger(data.end))
      return;
    const range = makeRange(data.start, data.end);
    if (!range)
      return;
    const box = range.getBoundingClientRect();
    const scroller = document.scrollingElement || document.documentElement;
    if (scroller.scrollHeight > scroller.clientHeight + 1)
      window.scrollTo({ top: window.scrollY + box.top + box.height / 2 - window.innerHeight / 2, behavior: 'smooth' });
    else
      // An article that scrolls in a container of its own, not the window.
      (range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  async function command(data) {
    if (data.type === 'annotation-capture') {
      if (typeof data.request === 'string' && data.request.length <= 64 && Number.isSafeInteger(data.selection))
        capture(data.request, data.selection);
      return;
    }
    if (data.type === 'annotation-reveal') {
      reveal(data);
      return;
    }
    if (data.type !== 'annotation-paint' || !ready || !allowed() || data.generation !== generation)
      return;
    // The old marks stay painted until the new set is ready, then are replaced
    // in one step, so a repaint never blinks.
    retire();
    if (!globalThis.CSS?.highlights || !globalThis.Highlight || !Array.isArray(data.ranges) || data.ranges.length > 10000) {
      clear();
      return;
    }
    const nextRanges = new Map(), nextMeasured = [], ticket = paintSerial;
    let slice = performance.now();
    for (const item of data.ranges) {
      if (typeof item.handle !== 'string' || item.handle.length > 64 || !Number.isSafeInteger(item.start) || !Number.isSafeInteger(item.end))
        continue;
      const range = makeRange(item.start, item.end);
      if (range) {
        nextRanges.set(item.handle, range);
        if (item.measure === true && nextMeasured.length < 200)
          nextMeasured.push(item.handle);
      }
      if (performance.now() - slice > 4) {
        await yieldTask();
        slice = performance.now();
        if (ticket !== paintSerial || data.generation !== generation || !ready)
          return;
      }
    }
    if (ticket !== paintSerial || data.generation !== generation || !ready)
      return;
    ranges = nextRanges;
    measured = nextMeasured;
    CSS.highlights.set('delphi-annotations', new Highlight(...ranges.values()));
    reflow();
  }
  const boxesOf = range => Array.from(range.getClientRects()).filter(box => box.width > 0.5 && box.height > 0.5);
  const holds = (box, x, y) => x >= box.left - 1 && x <= box.right + 1 && y >= box.top - 1 && y <= box.bottom + 1;
  /**
   * The marks under a point, and the box the pointer is standing in.
   *
   * The caret lookup is a filter, not the answer. Past the end of a highlighted
   * line it names that line's last offset, which *is* inside the range, so the
   * whole strip of white to the right of a short highlighted line behaved as if
   * it were the mark — a click in the margin opened somebody's note. The
   * painted boxes decide; the caret is only what keeps this from measuring
   * every range in the document on every pointer move.
   */
  function hit(x, y) {
    const position = document.caretPositionFromPoint?.(x, y);
    const fallback = !position && document.caretRangeFromPoint?.(x, y);
    const caret = position || (fallback && { offsetNode: fallback.startContainer, offset: fallback.startOffset });
    if (!caret)
      return { handles: [], box: null };
    const handles = [];
    let box = null;
    for (const [handle, range] of ranges) {
      let candidate = null;
      try {
        if (range.isPointInRange(caret.offsetNode, caret.offset))
          candidate = boxesOf(range).find(item => holds(item, x, y)) ?? null;
      }
      catch (error) {
        // A range whose nodes have been replaced under it. The next repaint
        // rebuilds it; nothing here is worth an exception.
      }
      if (!candidate)
        continue;
      handles.push(handle);
      if (!box || candidate.top < box.top)
        box = candidate;
    }
    return { handles, box };
  }
  document.addEventListener('click', event => {
    if (!event.isTrusted || !allowed() || String(window.getSelection() || '').trim())
      return;
    const { handles, box } = hit(event.clientX, event.clientY);
    if (!handles.length)
      return;
    post({ type: 'annotation-click', generation, handles, rect: { x: box.left, y: box.top, w: box.width, h: box.height } });
  });
  /**
   * A mark is a control, so the pointer has to say so before it is clicked.
   *
   * `::highlight()` styles text and nothing else — cursor is not one of the
   * properties it accepts — so the state goes on the root element and a rule
   * that only matches while it is set does the rest. The attribute is hidden
   * from the archive by the same `data-delphi` filter as everything else here,
   * and attribute changes are not what the observer watches, so this cannot
   * make the page look like it changed.
   */
  let hoverAt = 0, hoverTimer = null, hovering = false;
  function hover(x, y) {
    hoverAt = performance.now();
    const over = allowed() && ready && hit(x, y).handles.length > 0;
    if (over === hovering)
      return;
    hovering = over;
    document.documentElement.toggleAttribute('data-delphi-annotation-hover', over);
  }
  window.addEventListener('pointermove', event => {
    // A held button is a selection being dragged, not a pointer looking around.
    if (event.buttons || (!ranges.size && !hovering))
      return;
    const x = event.clientX, y = event.clientY;
    clearTimeout(hoverTimer);
    // At most one hit test every 50ms while the pointer moves, and always one
    // for wherever it comes to rest. A timer, not an animation frame: no frame
    // comes while the window is hidden, and one that was requested and never
    // delivered used to hold every later move off — leaving the pointer a hand
    // over ordinary prose until the page was reloaded.
    if (performance.now() - hoverAt >= 50)
      hover(x, y);
    else
      hoverTimer = setTimeout(() => hover(x, y), 50);
  }, { passive: true, capture: true });
  /**
   * Where the marks the panel is pointing at are: the ones with a margin icon,
   * and the one with a card open over it.
   *
   * Which marks those are is the parent's to say, as one `measure` bit per
   * range in the paint instruction — not why, and nothing about any note. Only
   * positions come back. Measuring is confined to that handful: a page can
   * hold a thousand highlights, and asking every one of them for its boxes on
   * every scroll is a layout the reader would feel.
   *
   * Sent after a repaint and once the page settles from a scroll, a resize or
   * a zoom — which is when an icon or an open card would otherwise be left
   * pointing at the line the text used to be on.
   */
  let measured = [], geometryTimer = null;
  function reportGeometry() {
    if (!allowed() || !ready || !measured.length)
      return;
    const items = [];
    for (const handle of measured) {
      const range = ranges.get(handle);
      if (!range || !range.startContainer.isConnected)
        continue;
      const boxes = boxesOf(range);
      if (!boxes.length)
        continue;
      let top = Infinity, bottom = -Infinity;
      for (const box of boxes) {
        top = Math.min(top, box.top);
        bottom = Math.max(bottom, box.bottom);
      }
      // The middle of the first line, which is where a menu over the mark sits.
      items.push({ handle, top, bottom, x: boxes[0].left + boxes[0].width / 2 });
    }
    post({ type: 'annotation-geometry', generation, height: document.documentElement.clientHeight, items });
  }
  function reflow() {
    if (!measured.length)
      return;
    clearTimeout(geometryTimer);
    geometryTimer = setTimeout(reportGeometry, 120);
  }
  // Capture, because an article that scrolls in its own container never fires
  // a scroll event at the window.
  window.addEventListener('scroll', reflow, { passive: true, capture: true });
  window.addEventListener('resize', reflow, { passive: true });
  function start() {
    const style = document.createElement('style');
    style.dataset.delphiAnnotation = 'true';
    style.textContent = '::highlight(delphi-annotations){background:rgba(246,160,107,.42);color:inherit}::highlight(delphi-guide){background:rgba(246,160,107,.6);color:inherit}' +
      'html[data-delphi-annotation-hover],html[data-delphi-annotation-hover] *{cursor:pointer!important}';
    document.head.append(style);
    new MutationObserver(records => {
      if (!allowed()) {
        if (ready)
          leave();
        return;
      }
      const relevant = records.some(r => {
        const target = r.target.nodeType === 1 ? r.target : r.target.parentElement;
        // Losing the article itself is always a change, whatever it held.
        if (root && Array.from(r.removedNodes).some(n => n === root || n.contains?.(root)))
          return true;
        if (!target || (root && !root.contains(target)) || insideExcluded(target) || target.closest('[data-delphi-annotation]'))
          return false;
        return changesText(r);
      });
      if (relevant)
        changed();
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
    schedule();
    // One more reading once the page has had time to finish arriving, which
    // is when a quote that appears twice can be told apart.
    setTimeout(schedule, COMPLETE_AFTER_MS);
  }
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', start, { once: true });
  else
    start();
  // `reflow` is also the page bridge's to call: zooming and pinching move
  // every mark on the page without firing a resize. So is `isMark`: a click
  // on a highlight is the reader answering a note, not reading on, and must
  // not fold the library away and reflow the page under the card it opens.
  const isMark = (x, y) => allowed() && ranges.size > 0 && hit(x, y).handles.length > 0;
  // `allowed` too: a page copy is only of the article this bridge was served
  // for, never of wherever a client router has since taken the frame.
  return { selection, command, reflow, isMark, allowed };
}
