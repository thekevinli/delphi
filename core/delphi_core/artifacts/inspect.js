// Executed only in a DevTools isolated world. Model input is data, never code.
(function inspectArtifact(command) {
  const MAX_NODES = 4000;
  const all = [];
  const walker = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT);
  while (walker.nextNode()) {
    all.push(walker.currentNode);
    if (all.length > MAX_NODES) return { fatal: 'dom_limit', count: all.length };
  }
  // The kit's visually hidden chart tables are for screen readers, not pixels.
  const visible = (el) => {
    if (el.closest('[hidden],.hidden,[inert],.artifact-sr')) return false;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };
  const selector = (el) => el.id ? '#' + CSS.escape(el.id) : el.tagName.toLowerCase() + (el.getAttribute('role') ? '[role="' + el.getAttribute('role') + '"]' : '');
  const finiteAnimations = () => document.getAnimations().filter((animation) => {
    const timing = animation.effect && animation.effect.getComputedTiming();
    return animation.playState === 'running' && timing && Number.isFinite(timing.endTime);
  }).length;
  const canvasPixels = (element) => {
    try {
      const sample = new OffscreenCanvas(32, 32);
      const context = sample.getContext('2d', { willReadFrequently: true });
      context.drawImage(element, 0, 0, 32, 32);
      let hash = 2166136261;
      for (const value of context.getImageData(0, 0, 32, 32).data) hash = Math.imul(hash ^ value, 16777619);
      return hash >>> 0;
    } catch { return null; }
  };
  // What a reader sees, word by word: separate text nodes keep their
  // boundaries ("10 18", never "1018"), and hidden steps, scripts and the
  // kit's screen-reader tables are not read.
  const words = (element) => {
    const parts = [], texts = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    while (texts.nextNode() && parts.length < 400) {
      const parent = texts.currentNode.parentElement;
      if (parent && !parent.closest('script,style') && visible(parent)) parts.push(texts.currentNode.textContent);
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 500);
  };
  const isControl = (element) => !!element.closest('button,input,select,textarea,[role="button"],[role="tab"]');
  const outputElements = () => all.filter((element) => visible(element) && !isControl(element) && !element.closest('script,style,defs,mask,clipPath'));
  const directText = (element) => Array.from(element.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join('').trim();
  const svgGeometry = (element) => ['d', 'points', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height', 'transform']
    .map((name) => (element.getAttribute(name) || '').slice(0, 1000));
  const appearance = (style) => [
    'color', 'backgroundColor', 'backgroundImage', 'opacity',
    'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'borderTopStyle', 'borderRightStyle', 'borderBottomStyle', 'borderLeftStyle',
    'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius',
    'boxShadow', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontStretch',
    'lineHeight', 'letterSpacing', 'wordSpacing', 'textDecorationLine', 'textDecorationColor',
    'fill', 'fillOpacity', 'fillRule', 'stroke', 'strokeWidth', 'strokeOpacity',
    'strokeDasharray', 'strokeDashoffset', 'strokeLinecap', 'strokeLinejoin',
    'transform', 'filter', 'clipPath', 'maskImage',
  ].map((key) => (style[key] || '').slice(0, 200));
  const pseudoAppearance = (element, pseudo) => {
    const style = getComputedStyle(element, pseudo);
    if (!style.content || ['none', 'normal'].includes(style.content) || style.display === 'none' || style.visibility === 'hidden') return null;
    return [style.content.slice(0, 200), ...['width', 'height', 'top', 'right', 'bottom', 'left'].map((key) => style[key]), appearance(style)];
  };
  const textStates = () => {
    const elements = outputElements();
    const priority = elements.filter((element) => element.matches('output,[role="status"],[aria-live]')).map((element) => element.textContent.trim());
    return [...new Set([...priority, ...elements.map(directText)].filter(Boolean))].slice(0, 120).map((text) => text.slice(0, 160));
  };
  // Native input values deliberately do not count as diagram output. A slider
  // without a handler must not pass simply because its thumb moved. Geometry,
  // paint and canvas samples also recognize CSS-only and graphical effects.
  // Compare the rendered result, not class/style spelling: a completed
  // animation may leave its class in place without changing the restored view.
  // Animation names/timing are intentionally absent, while forwards-filled
  // opacity, borders, typography and stroke changes remain observable.
  const effectFingerprint = () => JSON.stringify(outputElements().slice(0, 180).map((element) => {
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    return [element.tagName, element.id, directText(element).slice(0, 160),
      ...[rect.x + scrollX, rect.y + scrollY, rect.width, rect.height].map((value) => Math.round(value * 10) / 10),
      appearance(style), pseudoAppearance(element, '::before'), pseudoAppearance(element, '::after'),
      element instanceof SVGGraphicsElement ? svgGeometry(element) : null,
      element instanceof HTMLCanvasElement ? canvasPixels(element) : null];
  }));
  const fingerprint = () => JSON.stringify({
    text: (document.body.innerText || '').slice(0, 12000),
    inputs: all.filter((el) => /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)).slice(0, 50).map((el) => [el.id, el.value, el.checked, el.disabled]),
    selected: all.filter((el) => el.matches('[aria-selected],[aria-expanded],[aria-current],svg path')).slice(0, 80).map((el) => [el.id, el.getAttribute('aria-selected'), el.getAttribute('aria-expanded'), el.getAttribute('aria-current'), (el.getAttribute('d') || '').slice(0, 500)]),
    geometry: all.filter((el) => visible(el) && el instanceof SVGGraphicsElement).slice(0, 120).map((el) => [el.id, ...['x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height', 'transform', 'points', 'fill', 'stroke', 'opacity'].map((name) => (el.getAttribute(name) || '').slice(0, 300))]),
    canvases: all.filter((el) => visible(el) && el instanceof HTMLCanvasElement).slice(0, 8).map((el) => [el.width, el.height, canvasPixels(el)]),
  });
  if (command.kind === 'scroll-bottom') {
    window.scrollTo(0, Math.max(document.documentElement.scrollHeight, document.body.scrollHeight));
    return { scrollTop: window.scrollY };
  }
  if (command.kind === 'act' || command.kind === 'read') {
    let matches;
    try { matches = Array.from(document.querySelectorAll(command.target)).filter(visible); }
    catch { return { error: 'invalid_selector', message: 'The interaction selector is invalid.' }; }
    if (matches.length !== 1) return { error: 'ambiguous_control', message: `The selector matched ${matches.length} visible elements; use exactly one.` };
    const element = matches[0];
    const valued = element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement || element instanceof HTMLOutputElement;
    if (command.kind === 'read') return { value: element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type) ? String(element.checked) : valued ? String(element.value) : '',
      text: words(element) };
    if (element.matches(':disabled') || element.closest('[aria-disabled="true"],[inert]')) return { error: 'disabled_control', message: 'The requested control is disabled.' };
    element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (command.action === 'click') {
      if (!element.matches('button,input[type="button"],input[type="submit"],input[type="checkbox"],input[type="radio"],[role="button"],[role="tab"]')) {
        return { error: 'unsupported_control', message: 'Click checks must target a button, tab, checkbox or radio control.' };
      }
      element.focus();
      element.click();
    } else if (command.action === 'set') {
      if (element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type)) {
        if (!['true', 'false'].includes(command.value)) return { error: 'invalid_value', message: 'Checkbox values must be true or false.' };
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked').set.call(element, command.value === 'true');
      } else if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
        const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLTextAreaElement.prototype;
        if (element instanceof HTMLSelectElement && !Array.from(element.options).some((option) => option.value === command.value)) return { error: 'invalid_value', message: 'The select has no option with that value.' };
        if (element instanceof HTMLInputElement && ['file', 'password', 'hidden'].includes(element.type)) return { error: 'unsupported_control', message: 'This input type is not an artifact control.' };
        Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, command.value);
      } else return { error: 'unsupported_control', message: 'Set checks must target a native input, select or textarea.' };
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    } else return { error: 'unsupported_action', message: 'Only click and set actions are supported.' };
    return { animations: finiteAnimations(),
      requiresOutput: element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type) };
  }
  const issues = [];
  const add = (code, message, el, severity = 'error') => {
    if (issues.length < 16 && !issues.some((item) => item.code === code && item.target === selector(el))) issues.push({ code, severity, message, target: selector(el) });
  };
  const root = document.documentElement;
  if (Math.max(root.scrollWidth, document.body.scrollWidth) > root.clientWidth + 2) add('horizontal_overflow', 'The artifact page is wider than its viewport.', root);
  const text = [];
  for (const element of all) {
    if (!visible(element) || element.closest('script,style,defs,mask,clipPath')) continue;
    const style = getComputedStyle(element);
    if (element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 2 && ['hidden', 'clip'].includes(style.overflowX)) add('clipped_content', 'Content is clipped horizontally by this element.', element);
    if (element.clientHeight > 0 && element.scrollHeight > element.clientHeight + 2 && ['hidden', 'clip'].includes(style.overflowY)) add('clipped_content', 'Content is clipped vertically by this element.', element);
    const content = directText(element);
    if (content.length < 2 || element.closest('sup,sub,[aria-hidden="true"]')) continue;
    let size = parseFloat(style.fontSize);
    if (element instanceof SVGGraphicsElement) {
      const matrix = element.getScreenCTM();
      if (matrix) size *= Math.min(Math.hypot(matrix.a, matrix.b), Math.hypot(matrix.c, matrix.d));
      const textRect = element.getBoundingClientRect();
      let viewport = element.ownerSVGElement;
      while (viewport) {
        const box = viewport.getBoundingClientRect();
        const overflow = getComputedStyle(viewport);
        const clippedX = ['hidden', 'clip', 'scroll', 'auto'].includes(overflow.overflowX) && (textRect.left < box.left - 1 || textRect.right > box.right + 1);
        const clippedY = ['hidden', 'clip', 'scroll', 'auto'].includes(overflow.overflowY) && (textRect.top < box.top - 1 || textRect.bottom > box.bottom + 1);
        if (clippedX || clippedY) add('svg_label_clipped', 'An SVG text label extends outside its clipping viewport.', element);
        viewport = viewport.ownerSVGElement;
      }
    }
    if (Number.isFinite(size) && size < 11.5) add('small_text', `Rendered text is ${size.toFixed(1)}px; readable diagram labels should be at least 12px.`, element);
    if (text.length < 60) text.push({ text: content.slice(0, 100), size: Math.round(size * 10) / 10 });
  }
  const visualCount = all.filter((el) => visible(el) && el.matches('svg,canvas,img')).length;
  for (const frame of all.filter(el => el.matches('iframe,frame'))) add('nested_frame', 'Nested frames are not supported in artifacts.', frame);
  if (!text.length && !visualCount) add('blank_artifact', 'The artifact has no visible text or graphics.', document.body);
  return {
    width: root.clientWidth, height: root.clientHeight,
    scrollWidth: Math.max(root.scrollWidth, document.body.scrollWidth), scrollHeight: Math.max(root.scrollHeight, document.body.scrollHeight),
    issues, text, visualCount,
    animations: finiteAnimations(), fingerprint: fingerprint(), effectFingerprint: effectFingerprint(),
    textStates: textStates(), stateText: textStates().join(' · ').slice(0, 500),
    violations: (globalThis.__delphiArtifactViolations || []).slice(0, 10),
  };
})
