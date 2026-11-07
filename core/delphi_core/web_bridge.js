/**
 * The half of the reader panel that lives inside the page.
 *
 * Delphi places proxied pages in a sandboxed iframe, which puts them in an
 * opaque origin unless they are served from the separately configured sandbox
 * host. They cannot read the app's cookies, call /api, or touch the parent
 * document. The parent cannot reach into them either, so everything the reader
 * panel needs crosses as postMessage.
 *
 * The parent must therefore authenticate by `event.source`, never `event.origin`,
 * because an opaque origin serialises as the string "null".
 */
(function () {
  "use strict";

  var CHANNEL = "delphi-page";
  var NONCE_BYTES = new Uint32Array(4);
  crypto.getRandomValues(NONCE_BYTES);
  var DOCUMENT_NONCE = Array.prototype.map.call(NONCE_BYTES, function (value) {
    return value.toString(16).padStart(8, "0");
  }).join("");
  var GUIDE_MS = 3000;
  // How long a place jumped to is held while the page settles (`settleOn`).
  var HOLD_MS = 6000;
  // Delphi never cuts a page's loading short — nothing here stops a fetch or a
  // render. These are only when to *look*, and looking repeatedly is what keeps
  // a slow or animation-heavy page from being written off on the first glance.
  var SETTLE_CHECKS = [1500, 4000, 9000, 20000];
  // Enough text on screen to call the document readable and drop the panel's
  // overlay. RENDERED_CHARS in PageViewer.tsx is the same number, which is all
  // the panel has to go on when the bridge is one that sends no verdict.
  var READABLE_CHARS = 200;
  // What a page must fall short of, on both counts, to be called empty: a line
  // of text, and drawn surfaces — images, frames, canvases — adding up to this
  // share of the view. Both are deliberately low. A short page is not a broken
  // one, and a logo or a tracking frame alone is under the share.
  var BLANK_CHARS = 40;
  var DRAWN_SHARE = 0.03;
  // Reflow zoom, driven by the panel's −/+ control.
  var ZOOM_MIN = 1;
  var ZOOM_MAX = 2.5;
  // Pinch magnification. The floor is the page at its own layout — pinching out
  // past that has nothing left to reveal, so it stretches and springs back.
  var MAGNIFY_MIN = 1;
  var MAGNIFY_MAX = 5;
  // Pulling past the floor stretches a rubber band: RUBBER_FLOOR is as small
  // as the page will ever get, RUBBER_RESIST how much accumulated pull spends
  // most of that range, PINCH_HOLD_MS how long a stretch is held before the
  // fingers count as lifted, and RUBBER_SETTLE_MS how slowly it lets go. Kept
  // in step with frontend/app/components/PdfViewer.tsx, which does the same
  // thing for PDFs — pinching a page and pinching a paper must feel identical.
  var RUBBER_FLOOR = 0.88;
  var RUBBER_RESIST = 120;
  var PINCH_HOLD_MS = 350;
  var RUBBER_SETTLE_MS = 520;

  function post(message) {
    message.source = CHANNEL;
    message.nonce = DOCUMENT_NONCE;
    parent.postMessage(message, "*");
  }

  /**
   * Announce, before anything else, that this document came from Delphi.
   *
   * The panel's guarantee is that the frame only ever shows a document Delphi
   * served, and enumerating the ways a page can leave — link clicks, a button
   * setting `location.href`, a form post, `window.open`, meta refresh, a client
   * router — is a list that will always be missing an entry. `window.location`
   * is unforgeable, so several of those cannot be intercepted at all.
   *
   * So the invariant is checked from the other side: every committed navigation
   * fires `load` on the frame, our documents say hello within milliseconds of
   * parsing, and a foreign one never does. That covers every escape route,
   * including the browser's own "refused to connect" page.
   */
  post({ type: "hello" });

  // The address Delphi framed this page at, read before any of the page's
  // scripts run: one of them can remove or replace the `<base>`, and then
  // `document.baseURI` is the frame's own URL — Delphi's, with its token.
  var SERVED_BASE = document.baseURI;

  /* ANNOTATION_IMPLEMENTATION */

  /**
   * Adopt the article's own path, before any of the page's scripts read it.
   *
   * `window.location` is unforgeable — it cannot be redefined — so a proxied
   * document normally reports Delphi's path, `/api/projects/…/page`. A
   * client-rendered site takes that as its route, asks its own API for a post
   * that does not exist, and replaces the perfectly good server-rendered
   * article with its own 404. Substack does exactly this.
   *
   * `history.replaceState` is the one part of `location` that *can* be changed,
   * and it is allowed as long as the new URL is same-origin with the document —
   * which it is, since both are on the sandbox origin. The path need not exist
   * on that server: nothing is fetched.
   *
   * It also drops the `?t=` token from the URL before the page can read it.
   */
  try {
    var wantedPath = (window.__DELPHI__ && window.__DELPHI__.path) || "";
    if (wantedPath) {
      history.replaceState(history.state, "", location.origin + wantedPath);
    }
  } catch (error) {
    /* Keep Delphi's path; the page may misroute, but it still renders. */
  }

  /**
   * Make the sandbox survivable for a page that expects an origin.
   *
   * Denying `allow-same-origin` is what keeps a proxied site away from Delphi's
   * session cookie, and it is not negotiable. But it also makes four ordinary
   * APIs throw, and every client-rendered framework touches at least one of them
   * while booting — so without this a React or Next site returns perfect HTML
   * and then dies during hydration, leaving a blank frame. A static blog never
   * notices, which is why this only shows up on the app-shaped half of the web.
   *
   * These shims do not grant anything back. Storage becomes per-session memory,
   * cookies go nowhere, and a history entry keeps its state but not its URL.
   * The page misbehaves slightly instead of not running at all.
   */
  function memoryStorage() {
    var data = Object.create(null);
    return {
      getItem: function (key) {
        return Object.prototype.hasOwnProperty.call(data, String(key))
          ? data[String(key)]
          : null;
      },
      setItem: function (key, value) {
        data[String(key)] = String(value);
      },
      removeItem: function (key) {
        delete data[String(key)];
      },
      clear: function () {
        data = Object.create(null);
      },
      key: function (index) {
        return Object.keys(data)[index] || null;
      },
      get length() {
        return Object.keys(data).length;
      },
    };
  }

  function shim(target, name, value) {
    try {
      // Reading the real property is itself what throws, so probe first.
      void target[name];
    } catch (error) {
      try {
        Object.defineProperty(target, name, {
          value: value,
          configurable: true,
          writable: true,
        });
      } catch (ignored) {
        /* Nothing more to try; the page will fail as it would have anyway. */
      }
    }
  }

  shim(window, "localStorage", memoryStorage());
  shim(window, "sessionStorage", memoryStorage());

  try {
    void document.cookie;
  } catch (error) {
    var jar = "";
    Object.defineProperty(document, "cookie", {
      configurable: true,
      get: function () {
        return jar;
      },
      set: function (value) {
        jar = jar ? jar + "; " + value : String(value);
      },
    });
  }

  // A relative URL here resolves against `<base href>`, which points at the
  // origin site — cross-origin from an opaque document, so the call throws.
  // Retrying with a null URL keeps the state entry and drops only the address.
  ["pushState", "replaceState"].forEach(function (name) {
    var original = History.prototype[name];
    if (typeof original !== "function") return;
    History.prototype[name] = function (state, title, url) {
      try {
        return original.call(this, state, title, url);
      } catch (error) {
        try {
          return original.call(this, state, title, null);
        } catch (ignored) {
          return undefined;
        }
      }
    };
  });

  /**
   * The nearest heading above a node, by its own id where it has one.
   *
   * Section anchors are the web equivalent of a page number here — they are what
   * the model cites and what the outline is keyed on — so a selection reports
   * the section it came from, letting a follow-up question be grounded without
   * re-reading the page.
   */
  function anchorFor(node) {
    var element = node instanceof Element ? node : node && node.parentElement;
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    var found = "";
    while (walker.nextNode()) {
      var current = walker.currentNode;
      if (element && (current === element || current.contains(element))) break;
      if (/^H[1-3]$/.test(current.tagName) && current.id) found = current.id;
    }
    return found;
  }

  var annotations = installAnnotations(post);
  var selectionTimer = null;
  function reportSelection() {
    var selection = window.getSelection();
    var text = selection ? String(selection).trim() : "";
    if (!text || !selection.rangeCount) {
      post({ type: "selection", text: "" });
      return;
    }
    var range = selection.getRangeAt(0);
    var box = range.getBoundingClientRect();
    post({
      type: "selection",
      annotation: annotations.selection(range),
      text: text,
      anchor: anchorFor(range.commonAncestorContainer),
      // Viewport coordinates inside the frame. The parent adds the frame's
      // offset and, for a stored DOM, the scale that fitted the layout to
      // the pane — otherwise Reply lands where the unscaled pixels say.
      rect: { x: box.left, y: box.top, w: box.width, h: box.height },
    });
  }

  // While a drag is under way the selection is reported once it pauses, so a
  // reader who stops mid-drag sees the menu. It is finished when the pointer
  // or key that made it is released, and is reported then rather than a pause
  // later: a menu opened by the pause would otherwise act on the passage as it
  // was mid-drag, and a quick Highlight saved half of what was selected.
  document.addEventListener("selectionchange", function () {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(reportSelection, 180);
  });
  function reportReleased() {
    clearTimeout(selectionTimer);
    reportSelection();
  }
  document.addEventListener("pointerup", reportReleased, true);
  document.addEventListener("keyup", reportReleased, true);

  /**
   * The box the reader's place is kept in: the document if it scrolls, or the
   * tallest page-sized element that scrolls in its place. A saved Notion page
   * scrolls `.notion-scroller`, its frame being the window's height, and its
   * window never moves. One box, reported and restored alike, so scrolling a
   * sidebar or a code block never stands in for the reader's place.
   */
  function placeBox() {
    var page = document.scrollingElement || document.documentElement;
    if (page.scrollHeight > page.clientHeight + 1 || !document.body) return page;
    var best = null, nodes = document.body.getElementsByTagName("*");
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (node.scrollHeight <= node.clientHeight || node.clientHeight < window.innerHeight / 2) continue;
      if ((!best || node.scrollHeight > best.scrollHeight) && /(auto|scroll)/.test(getComputedStyle(node).overflowY)) best = node;
    }
    return best || page;
  }

  var scrollTimer = null;
  // Captured, because a scroll does not bubble: an inner scroller's is heard
  // only on the way down. Read once it settles, so the scan runs once a gesture.
  document.addEventListener("scroll", function () {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(function () {
      post({ type: "scroll", scrollY: placeBox().scrollTop || 0 });
    }, 120);
  }, { capture: true, passive: true });

  /**
   * Follow a citation: scroll to its section, then point at the quoted line.
   *
   * Mirrors what the PDF reader does with a page number and a caption — jump
   * first, then draw a transient guide — so following a citation feels the same
   * whichever kind of document it lands in.
   */
  /**
   * The element a link's fragment names, as a browser resolves it — an id,
   * then an <a name> — and then as Notion does. Its links name a block by its
   * id without the dashes, and its own script, which a saved copy no longer
   * runs, is what scrolls there.
   */
  function fragmentTarget(fragment) {
    if (!fragment) return null;
    var node = document.getElementById(fragment) || document.getElementsByName(fragment)[0];
    if (node) return node;
    if (!/^[0-9a-f]{32}$/i.test(fragment)) return null;
    var id = fragment.toLowerCase();
    return document.querySelector('[data-block-id="' + id.slice(0, 8) + "-" + id.slice(8, 12) + "-" +
      id.slice(12, 16) + "-" + id.slice(16, 20) + "-" + id.slice(20) + '"]');
  }

  /**
   * Scroll to a place, and keep it there while the page settles.
   *
   * A page's lazy images take their height only as they near the view, so a
   * jump past them lands where a section *was*: the speedrun figures above
   * "The design of Muon" loaded as the reader arrived and pushed the heading
   * 1,245 px on, leaving the reader in the section before. A smooth scroll
   * fixes its destination when it starts, and the browser's own scroll
   * anchoring stands aside while one runs. Until the page stops changing size,
   * for at most HOLD_MS, each change aims the scroll at the place again — and
   * the moment the reader scrolls, presses or types, the page is theirs.
   */
  var releaseHold = null;
  function settleOn(node, block) {
    if (releaseHold) releaseHold();
    node.scrollIntoView({ behavior: "smooth", block: block });
    if (typeof ResizeObserver !== "function") return;
    var timer = 0, events = ["wheel", "touchstart", "keydown", "pointerdown"];
    var observer = new ResizeObserver(function () {
      node.scrollIntoView({ behavior: "smooth", block: block });
    });
    function release() {
      observer.disconnect();
      clearTimeout(timer);
      events.forEach(function (type) { window.removeEventListener(type, release, true); });
      if (releaseHold === release) releaseHold = null;
    }
    // The document's own box, and the body's: a page that pins its root to
    // the window grows only inside it.
    observer.observe(document.documentElement);
    if (document.body) observer.observe(document.body);
    events.forEach(function (type) { window.addEventListener(type, release, { capture: true, passive: true }); });
    timer = setTimeout(release, HOLD_MS);
    releaseHold = release;
  }

  function scrollTo(anchor, quote, fallbackQuote) {
    var target = anchor ? document.getElementById(anchor) : null;
    if (!target && anchor) {
      var heading = Array.prototype.find.call(
        document.querySelectorAll("h1,h2,h3"),
        function (node) {
          return (node.textContent || "").trim().toLowerCase() ===
            anchor.replace(/-/g, " ").toLowerCase();
        }
      );
      target = heading || null;
    }
    if (target) settleOn(target, "start");
    else if (!quote) window.scrollTo({ top: 0, behavior: "smooth" });
    if (quote && !highlightQuote(quote, !target) && fallbackQuote) highlightQuote(fallbackQuote, !target);
  }

  function highlightQuote(quote, shouldScroll) {
    var needle = quote.replace(/\s+/g, " ").trim().toLowerCase();
    if (needle.length < 3) return false;
    // Inline markup splits a sentence across text nodes, so match against
    // the body's text joined and whitespace-collapsed, mapped back to nodes.
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    var text = "", nodes = [], offsets = [];
    while (walker.nextNode()) {
      var node = walker.currentNode, value = node.nodeValue || "";
      for (var i = 0; i < value.length; i++) {
        var ch = /\s/.test(value[i]) ? " " : value[i].toLowerCase();
        if (ch === " " && text[text.length - 1] === " ") continue;
        text += ch; nodes.push(node); offsets.push(i);
      }
    }
    var index = text.indexOf(needle);
    if (index < 0) return false;
    var end = index + needle.length - 1;
    var range = document.createRange();
    range.setStart(nodes[index], offsets[index]);
    range.setEnd(nodes[end], offsets[end] + 1);
    if (shouldScroll) settleOn(nodes[index].parentElement, "center");
    if (!globalThis.CSS?.highlights || !globalThis.Highlight) return true;
    CSS.highlights.set("delphi-guide", new Highlight(range));
    setTimeout(function () { CSS.highlights.delete("delphi-guide"); }, GUIDE_MS);
    return true;
  }

  /**
   * Trusted reading navigation. A normal left click asks the parent for a
   * destination token.
   *
   * The parent remounts the iframe for each cross-document destination. Only a
   * real, unmodified left click may request that navigation; script never gets
   * a proxy primitive merely because it can manufacture a DOM event.
   */
  document.addEventListener(
    "click",
    function (event) {
      // A click inside a cross-origin frame never reaches the parent, so the
      // reader panel would otherwise be the one place in the app where reading
      // does not fold the library away. Selections are exempt, matching the
      // PDF reader: dragging out a quote is not a request for more room.
      if (
        event.isTrusted &&
        !String(window.getSelection() || "").trim() &&
        // A highlight answers the click itself, with the note it carries;
        // folding the library would reflow the page under that card.
        !annotations.isMark(event.clientX, event.clientY)
      ) {
        post({ type: "engaged" });
      }

      var importPdf = event.target && event.target.closest &&
        event.target.closest("[data-delphi-import-pdf]");
      if (importPdf && event.isTrusted && event.button === 0) {
        event.preventDefault();
        event.stopPropagation();
        post({ type: "import-pdf", href: importPdf.getAttribute("data-delphi-import-pdf") });
        return;
      }

      var link = event.target && event.target.closest && event.target.closest("a[href]");
      if (!link) return;
      var href = link.getAttribute("href") || "";
      // Left to the page: it runs script rather than going anywhere.
      if (href.indexOf("javascript:") === 0) return;

      var here = document.baseURI ? new URL(document.baseURI) : null;
      var there;
      try {
        there = new URL(link.href);
      } catch (error) {
        return;
      }
      if (!event.isTrusted) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      var external =
        event.button !== 0 ||
        event.metaKey || event.ctrlKey || event.shiftKey || event.altKey ||
        link.hasAttribute("download") ||
        (link.target && link.target.toLowerCase() === "_blank") ||
        !/^https?:$/.test(there.protocol);
      if (external) {
        event.preventDefault();
        event.stopPropagation();
        post({ type: "external-link", href: there.href });
        return;
      }
      var samePath = here &&
        there.origin === here.origin &&
        there.pathname === here.pathname;
      // Decoded only for a link that stays on this page, and never so as to
      // throw: an exception here would come before preventDefault, and the
      // frame would follow the link itself, past every check below.
      var fragment = "";
      if (samePath && there.hash) {
        try { fragment = decodeURIComponent(there.hash.slice(1)); }
        catch (error) { fragment = there.hash.slice(1); }
      }
      var target = samePath ? fragmentTarget(fragment) : null;
      // A copy holding only its first window while the rest is read has not
      // drawn most of its sections yet: a place on this page all the same.
      // The reader holds such a copy back unless asked to read what is there.
      var unread = samePath && fragment && !target &&
        document.documentElement.hasAttribute("data-delphi-render-partial");
      // A page linking its own sections may decorate the address — Notion
      // adds ?pvs=25 to every one — so a fragment this page holds is a place
      // on this page, whatever the query says. Fetched as an address of its
      // own, it would be the page's shell, which only its scripts can draw.
      if (samePath && (there.search === here.search || target || unread)) {
        event.preventDefault();
        event.stopPropagation();
        if (target) settleOn(target, "start");
        else if (!fragment) window.scrollTo({ top: 0, behavior: "smooth" });
        // This page's own address with the new fragment: the document is
        // unchanged, and so is what its annotations are anchored to.
        post({ type: "same-document", href: new URL(there.hash, here).href });
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      post({ type: "navigate", href: there.href });
    },
    true
  );

  document.addEventListener("submit", function (event) {
    var form = event.target;
    if (!(form instanceof HTMLFormElement) || !event.isTrusted) return;
    event.preventDefault();
    event.stopPropagation();
    var submitter = event.submitter;
    var method = ((submitter && submitter.formMethod) || form.method || "get").toLowerCase();
    var action = (submitter && submitter.formAction) || form.action || document.baseURI;
    var target = (submitter && submitter.formTarget) || form.target;
    if (method !== "get" || (target && target.toLowerCase() === "_blank")) {
      post({ type: "external-action", href: action, method: method.toUpperCase() });
      return;
    }
    var destination = new URL(action);
    if (!/^https?:$/.test(destination.protocol)) {
      post({ type: "external-action", href: destination.href, method: "GET" });
      return;
    }
    new FormData(form, submitter || undefined).forEach(function (value, key) {
      if (typeof value === "string") destination.searchParams.append(key, value);
    });
    post({ type: "navigate", href: destination.href });
  }, true);

  // Navigation API exposes whether a navigation came from a user gesture. It
  // closes scripted redirects in current browsers; the parent's hello/claim
  // recovery remains the backstop for older engines and non-cancelable cases.
  if (window.navigation && window.navigation.addEventListener) {
    window.navigation.addEventListener("navigate", function (event) {
      if (event.userInitiated || event.hashChange) return;
      if (event.cancelable) event.preventDefault();
    });
  }

  /**
   * A file dropped on the page is a file dropped on Delphi.
   *
   * Drag events are delivered to the innermost document under the pointer and
   * do not cross a frame boundary, so while a file is held over the reader the
   * app's own window-level listeners hear nothing at all: the drop lands here
   * or nowhere. Left alone the browser then navigates the frame to the dropped
   * file, which loses the page and strands the reader on a bare PDF.
   *
   * So the gesture is caught here and handed up — the state, so the app can
   * raise the same overlay it raises everywhere else, and the file itself,
   * which crosses postMessage as a structured clone like any other value. The
   * reader ends up accepting a drop anywhere in the window, whether the middle
   * panel is showing a paper or a page.
   *
   * Capture phase and stopped there, because a page with a dropzone of its own
   * would otherwise swallow a drop meant for Delphi — and it could not do
   * anything with it regardless, being cut off from its own origin.
   */
  function carriesFiles(event) {
    var types = event.dataTransfer && event.dataTransfer.types;
    return !!types && Array.prototype.indexOf.call(types, "Files") >= 0;
  }

  function carriesPdf(event) {
    var items = event.dataTransfer && event.dataTransfer.items;
    if (!items) return false;
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind !== "file") continue;
      var type = (items[i].type || "").toLowerCase();
      if (type === "application/pdf" || type === "application/x-pdf") return true;
      var file;
      try {
        file = items[i].getAsFile();
      } catch (error) {
        file = null;
      }
      if (file && file.name && /\.pdf$/i.test(file.name)) return true;
    }
    return false;
  }

  function dragging(event, over) {
    if (!carriesFiles(event)) return false;
    event.preventDefault();
    event.stopPropagation();
    // The overlay is a paper cue. An image over the frame used to paint it
    // and hide the composer the reader was aiming at.
    post({ type: "drag", over: over && carriesPdf(event) });
    return true;
  }

  window.addEventListener(
    "dragenter",
    function (event) {
      dragging(event, true);
    },
    true
  );

  window.addEventListener(
    "dragover",
    function (event) {
      // preventDefault on *this* event is what marks the frame a drop target;
      // without it the browser refuses the drop and falls back to navigating.
      if (dragging(event, true) && event.dataTransfer) {
        event.dataTransfer.dropEffect = "copy";
      }
    },
    true
  );

  window.addEventListener(
    "dragleave",
    function (event) {
      dragging(event, false);
    },
    true
  );

  window.addEventListener(
    "drop",
    function (event) {
      if (!dragging(event, false)) return;
      var files = event.dataTransfer && event.dataTransfer.files;
      var file = files && files.length ? files[0] : null;
      // What the file is — a PDF, too large, not a paper at all — is the app's
      // question to answer, in the one place it already answers it.
      if (file) post({ type: "file-drop", file: file });
    },
    true
  );

  /**
   * Two different things, deliberately kept apart.
   *
   * **Zoom** is the panel's −/+ control: it reflows, so text rewraps to the
   * column and the page is genuinely typeset larger. It arrives as a message.
   *
   * **Magnify** is the trackpad pinch, and it must *not* reflow. Pinching is a
   * request to look closer at one part of the page as it is laid out — the
   * layout holds still and you pan around it, exactly as pinching does on any
   * native surface. So it is a compositor transform, never a re-layout, which
   * is also the only way it stays smooth: a pinch arrives as a burst of wheel
   * events, and anything that reflows or re-rasterises per tick judders.
   *
   * Scaling the body rather than the root is what makes panning free: a
   * transformed child still contributes to its ancestor's scrollable overflow,
   * so the page simply becomes scrollable in both axes and native scrolling
   * does the panning.
   */
  var zoom = ZOOM_MIN;
  var magnify = MAGNIFY_MIN;
  // Accumulated pull past the floor, and the timer that decides the fingers
  // have left the trackpad.
  var pull = 0;
  var holdTimer = null;
  // The page's own values for the inline styles zoom and pinch take over, as
  // they were the first time either touched them — what a page copy is given
  // back, so it is saved as the page drew itself rather than as magnified.
  var pristine = null;

  function claimStyles() {
    if (pristine) return;
    var body = document.body;
    var root = document.documentElement;
    pristine = {
      zoom: root.style.zoom,
      body: body && {
        transform: body.style.transform,
        transformOrigin: body.style.transformOrigin,
        transition: body.style.transition,
      },
    };
  }

  function setZoom(next) {
    claimStyles();
    zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
    document.documentElement.style.zoom = String(zoom);
    // Reflowing the page moves every mark on it, and neither `zoom` nor a
    // transform fires the resize the margin icons are otherwise redrawn by.
    annotations.reflow();
  }

  function paintMagnify(scale, animate) {
    var body = document.body;
    if (!body) return;
    claimStyles();
    body.style.transformOrigin = "0 0";
    body.style.transition = animate ? "transform 220ms cubic-bezier(.2,.7,.3,1)" : "";
    body.style.transform = scale === 1 ? "" : "scale(" + scale + ")";
    annotations.reflow();
  }

  /**
   * Keep the point under the fingers pinned while the scale changes, which is
   * what makes a pinch feel like it is grabbing the page rather than resizing
   * it from some arbitrary corner.
   */
  function magnifyAt(next, clientX, clientY) {
    var previous = magnify;
    magnify = Math.min(MAGNIFY_MAX, Math.max(MAGNIFY_MIN, next));
    var scroller = document.scrollingElement || document.documentElement;
    var pageX = (scroller.scrollLeft + clientX) / previous;
    var pageY = (scroller.scrollTop + clientY) / previous;
    paintMagnify(magnify, false);
    scroller.scrollLeft = pageX * magnify - clientX;
    scroller.scrollTop = pageY * magnify - clientY;
  }

  /**
   * Pinching out at natural size has nothing left to show, so the page gives
   * like a rubber band instead of doing nothing: it follows the fingers down,
   * resisting harder the further it goes, holds there for as long as the
   * gesture lasts, and only then eases back. It lets go slowly and never
   * overshoots — a quick round trip is a flash, not an answer.
   *
   * A pinch is only ever a burst of ctrl+wheel events, and Chrome has no
   * gesturestart/gestureend, so fingers resting still on the trackpad look
   * exactly like fingers lifted. PINCH_HOLD_MS of silence is the stand-in.
   */
  function settleFloor() {
    var body = document.body;
    pull = 0;
    if (!body) return;
    claimStyles();
    body.style.transition =
      "transform " + RUBBER_SETTLE_MS + "ms cubic-bezier(.33,1,.68,1)";
    body.style.transform = "";
  }

  /**
   * Element-local coordinates of the middle of what is on screen.
   *
   * The box has to be measured with nothing scaling it. Clearing the inline
   * transform is not enough: a settle still in flight keeps animating the
   * element until it is cancelled, and `getBoundingClientRect` would report
   * whatever half-finished scale it is passing through — which is how a
   * re-grabbed band ends up anchored off-centre.
   */
  function viewportCentre(body) {
    claimStyles();
    var root = document.documentElement;
    if (body.getAnimations) {
      body.getAnimations().forEach(function (animation) {
        animation.cancel();
      });
    }
    body.style.transition = "";
    body.style.transform = "";
    var box = body.getBoundingClientRect();
    var width = root.clientWidth || window.innerWidth;
    var height = root.clientHeight || window.innerHeight;
    return width / 2 - box.left + "px " + (height / 2 - box.top) + "px";
  }

  window.addEventListener(
    "wheel",
    function (event) {
      if (!event.ctrlKey) return;
      // Without this the browser magnifies the whole of Delphi instead.
      event.preventDefault();

      var previous = magnify;
      // Positive delta pinches out; at the floor there is nothing left to
      // shrink, so it goes into the band instead.
      var delta = event.deltaY;
      var body = document.body;
      if (body && previous === MAGNIFY_MIN && (delta > 0 || pull > 0)) {
        if (!pull) {
          // Shrink towards the middle of the view rather than the top-left
          // corner, or the page reads as sliding away instead of giving. Set
          // once per gesture so the anchor cannot drift as the pull deepens.
          body.style.transformOrigin = viewportCentre(body);
        }
        clearTimeout(holdTimer);
        // Pinching back in pays the stretch off before it magnifies again, so
        // the band never snaps out from under the fingers.
        var paid = pull + delta;
        pull = Math.max(0, paid);
        if (pull > 0) {
          var stretch =
            RUBBER_FLOOR + (1 - RUBBER_FLOOR) * Math.exp(-pull / RUBBER_RESIST);
          body.style.transition = "";
          body.style.transform = "scale(" + stretch + ")";
          holdTimer = setTimeout(settleFloor, PINCH_HOLD_MS);
          return;
        }
        settleFloor();
        if (paid >= 0) return;
        // Only what is left of the pinch after the band goes slack magnifies,
        // or the tick that finishes paying it off would also lift the page off
        // natural size — a visible jump at the hand-over.
        delta = paid;
      }

      magnifyAt(
        previous * Math.exp(-delta / 180),
        event.clientX,
        event.clientY
      );
    },
    { passive: false, capture: true }
  );

  /**
   * The page as the reader sees it, for the copy an annotation keeps.
   *
   * A second fetch of the page by the server has none of what its scripts drew
   * — typeset formulas, embeds, anything built in the browser — so the copy
   * the cached view shows, and matches highlights against, is taken from here.
   * Only when the panel asks, which it does after an annotation and never on
   * open, reload or a view switch.
   *
   * What is serialised is the page's, not Delphi's: every node the frame
   * injected, the root's hover mark, and the zoom and pinch styles are taken
   * back out; the backend strips any other `data-delphi-*` attribute, so this
   * does not walk the tree for them. Rules a page built
   * through the CSSOM exist in no element's text — MathJax's CHTML glyphs are
   * all `insertRule` — so they are written into their element here. The width
   * is the one the page was laid out at, with the panel's reflow zoom divided
   * back out. Canvas, shadow roots and media state are not captured.
   */
  function sheetText(sheet) {
    var rules;
    try {
      rules = sheet.cssRules;
    } catch (error) {
      return "";
    }
    return Array.prototype.map.call(rules, function (rule) {
      return rule.cssText;
    }).join("\n");
  }

  function generatedRules(style) {
    var sheet = style.sheet;
    var rules;
    try {
      rules = sheet && sheet.cssRules;
    } catch (error) {
      return null;
    }
    if (!rules || !rules.length) return null;
    var text = style.textContent || "";
    if (text.trim()) {
      // Rules that are the ones its text declares were not built in script;
      // keep the page's own spelling of them.
      try {
        var parsed = new CSSStyleSheet();
        parsed.replaceSync(text);
        if (parsed.cssRules.length === rules.length) return null;
      } catch (error) {
        return null;
      }
    }
    return sheetText(sheet);
  }

  function shedDelphi(element) {
    for (var i = element.attributes.length - 1; i >= 0; i--) {
      if (element.attributes[i].name.indexOf("data-delphi-") === 0)
        element.removeAttribute(element.attributes[i].name);
    }
  }

  function restoreStyle(element, values) {
    for (var name in values) element.style[name] = values[name];
    if (!element.getAttribute("style")) element.removeAttribute("style");
  }

  function capturePage(request, maxBytes) {
    function answer(fields) {
      fields.type = "page-capture";
      fields.request = request;
      post(fields);
    }
    try {
      if (!annotations.allowed()) return answer({ error: "The page moved on before it could be kept." });
      var root = document.documentElement;
      var clone = root.cloneNode(true);
      var originals = root.querySelectorAll("style");
      var copies = clone.querySelectorAll("style");
      for (var i = 0; i < originals.length && i < copies.length; i++) {
        var rules = generatedRules(originals[i]);
        if (rules !== null) copies[i].textContent = rules;
      }
      (document.adoptedStyleSheets || []).forEach(function (sheet) {
        var text = sheetText(sheet);
        if (!text) return;
        var style = document.createElement("style");
        style.textContent = text;
        (clone.querySelector("head") || clone).appendChild(style);
      });
      clone.querySelectorAll("script, [data-delphi-frame], [data-delphi-annotation]").forEach(function (node) {
        node.remove();
      });
      shedDelphi(clone);
      if (pristine) {
        restoreStyle(clone, { zoom: pristine.zoom });
        var body = clone.querySelector("body");
        if (body && pristine.body) restoreStyle(body, pristine.body);
      }
      var html = (document.doctype ? new XMLSerializer().serializeToString(document.doctype) : "") + clone.outerHTML;
      // A UTF-16 unit is at most three UTF-8 bytes, so most pages need no count.
      if (html.length * 3 > maxBytes && new TextEncoder().encode(html).length > maxBytes)
        return answer({ error: "This page is too large to keep a copy of." });
      answer({
        html: html,
        width: Math.max(320, Math.min(10000, Math.round(window.innerWidth / zoom))),
        url: SERVED_BASE,
      });
    } catch (error) {
      answer({ error: String((error && error.message) || error) });
    }
  }

  window.addEventListener("message", function (event) {
    var data = event.data;
    // The nonce never travels back into the untrusted document, where page
    // script could observe an incoming message and replay it to the parent.
    // Commands instead authenticate the parent WindowProxy directly.
    if (event.source !== parent || !data || data.source !== "delphi-app") return;
    annotations.command(data);
    if (data.type === "scroll-to") scrollTo(data.anchor, data.quote, data.fallbackQuote);
    if (data.type === "set-zoom") setZoom(Number(data.scale) || ZOOM_MIN);
    if (data.type === "restore-scroll") {
      // The reader's own place, put back: no jump holds against it.
      if (releaseHold) releaseHold();
      // A fresh page is at its top already, wherever it scrolls.
      var y = Math.max(0, Number(data.y) || 0), box = y ? placeBox() : null;
      if (!box || box === (document.scrollingElement || document.documentElement)) window.scrollTo({ top: y, behavior: "instant" });
      else box.scrollTop = y;
    }
    if (data.type === "focus-entered") engagedInEmbed();
    if (data.type === "clear-selection" && window.getSelection) {
      window.getSelection().removeAllRanges();
    }
    if (data.type === "page-capture" && typeof data.request === "string" && data.request.length <= 64 &&
        Number.isSafeInteger(data.maxBytes) && data.maxBytes > 0) {
      capturePage(data.request, data.maxBytes);
    }
  });

  /**
   * Say whether anything actually rendered.
   *
   * The panel cannot look inside an opaque-origin document, so a page that
   * boots to a blank screen is indistinguishable from one still loading. Cross-
   * origin scripts report their failures as a bare "Script error." with no
   * detail, so what gets measured is the outcome rather than the cause: is
   * there text on the screen. Measured after a delay, because a client-rendered
   * page has nothing at load and everything a moment later.
   */
  function renderedChars() {
    return ((document.body && document.body.innerText) || "").trim().length;
  }

  /**
   * Say whether the page came up empty.
   *
   * This is the one verdict the panel shows a notice for, so it errs toward
   * silence: a reader can see an empty page for themselves, and a notice over a
   * working one contradicts what is in front of them. Text is only one way a
   * page shows itself — a hosted demo is a frame, a gallery is images, a tool
   * draws on a canvas — so a page is empty only when it has next to no text
   * *and* next to nothing drawn. What a frame or a canvas holds cannot be
   * inspected from here; that it takes up room can.
   */
  function blank() {
    if (renderedChars() >= BLANK_CHARS) return false;
    var enough = window.innerWidth * window.innerHeight * DRAWN_SHARE;
    var drawn = document.querySelectorAll("img, svg, canvas, video, iframe, embed, object");
    for (var i = 0, area = 0; i < drawn.length; i++) {
      var box = drawn[i].getBoundingClientRect();
      if (getComputedStyle(drawn[i]).visibility !== "hidden") area += box.width * box.height;
      if (area >= enough) return false;
    }
    return true;
  }

  /**
   * Report a click that landed in a frame the page embeds.
   *
   * Such a click is delivered to the embedded document and to nobody else, so
   * the click listener above never hears it. What this document can see is
   * where focus went: the embedding element becomes the active one. The window
   * loses focus to it when focus was here; when focus was in the app, nothing
   * fires in this document at all and the parent says so with `focus-entered`.
   */
  function engagedInEmbed() {
    var active = document.activeElement;
    if (active && /^(IFRAME|EMBED|OBJECT)$/.test(active.tagName)) post({ type: "engaged" });
  }

  window.addEventListener("blur", engagedInEmbed);

  var announced = false;

  function ready() {
    if (announced) return;
    announced = true;
    post({
      type: "ready",
      renderWidth: Number(document.documentElement.getAttribute("data-delphi-render-width")) || null,
      // Set only on the page Delphi serves when a view could not be; the
      // parent switches views on it and never shows text the frame supplied.
      unavailable: document.documentElement.getAttribute("data-delphi-unavailable") || null,
      unavailableReason: document.documentElement.getAttribute("data-delphi-unavailable-reason") || null,
      // This bridge answers `page-capture`; one that predates it never will.
      pageCapture: true,
      title: document.title,
      url: document.baseURI,
      favicon: (function () {
        var icon = document.querySelector('link[rel~="icon"][href]');
        try {
          return icon ? new URL(icon.href, document.baseURI).href :
            new URL("/favicon.ico", document.baseURI).href;
        } catch (error) {
          return "";
        }
      })(),
      kind: (window.__DELPHI__ && window.__DELPHI__.kind) || "html",
    });
    SETTLE_CHECKS.forEach(function (delay) {
      setTimeout(function () {
        post({
          type: "settled",
          title: document.title,
          url: document.baseURI,
          kind: (window.__DELPHI__ && window.__DELPHI__.kind) || "html",
          chars: renderedChars(),
          blank: blank(),
        });
      }, delay);
    });
  }

  /**
   * Readable is not the same as finished, and the panel wants the first one.
   *
   * `load` waits for every last thing a page pulls — MathJax, an analytics
   * beacon, a comment embed, a Twitter widget, thirty images below the fold. An
   * article is on screen and scrollable long before any of that, and a browser
   * tab shows it immediately; holding the panel's overlay until `load` is what
   * made a perfectly quick page look like a slow one, sometimes for ten seconds
   * after the reader could have started reading.
   *
   * So the moment the document has parsed and there is prose in it, say so. The
   * threshold is the panel's own idea of "something rendered", which is what
   * keeps this from announcing an empty shell: a page that is still assembling
   * itself in script has nothing here, falls through to `load`, and is then
   * judged by the settle checks exactly as before.
   */
  function announceWhenReadable() {
    if (renderedChars() >= READABLE_CHARS) ready();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", announceWhenReadable);
  } else {
    announceWhenReadable();
  }
  if (document.readyState === "complete") ready();
  else window.addEventListener("load", ready);
})();
