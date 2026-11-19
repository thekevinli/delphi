export type ArtifactNumberFormat = "auto" | "int" | "0.0" | "0.00" | "percent";

/** Labels never print float noise such as 0.7300000001. */
export function artifactNumber(value: unknown, format: unknown = "auto", unit: unknown = ""): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const suffix = typeof unit === "string" && unit ? (unit === "%" ? "%" : ` ${unit.slice(0, 12)}`) : "";
  const fixed = (digits: number, number: number) => number.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  if (format === "percent") return `${Number((value * 100).toPrecision(3)).toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;
  if (format === "int") return fixed(0, value) + suffix;
  if (format === "0.0") return fixed(1, value) + suffix;
  if (format === "0.00") return fixed(2, value) + suffix;
  const rounded = Math.abs(value) >= 1000 ? Math.round(value) : Number(value.toPrecision(3));
  return rounded.toLocaleString("en-US", { maximumFractionDigits: 3 }) + suffix;
}

/** Axis ticks: four or five round steps, or each decade (with 2 and 5 inside one or two decades) on a log axis. */
export function artifactTicks(low: number, high: number, scale: "linear" | "log" = "linear"): { domain: [number, number]; ticks: number[] } {
  if (!Number.isFinite(low) || !Number.isFinite(high)) return { domain: [0, 1], ticks: [0, 1] };
  if (scale === "log") {
    const bottom = Math.floor(Math.log10(Math.max(low, 1e-12))), top = Math.max(bottom + 1, Math.ceil(Math.log10(Math.max(high, 1e-12))));
    const ticks: number[] = [];
    for (let power = bottom; power <= top && ticks.length < 40; power++) {
      for (const step of top - bottom <= 2 ? [1, 2, 5] : [1]) if (power < top || step === 1) ticks.push(Number((step * 10 ** power).toPrecision(3)));
    }
    return { domain: [10 ** bottom, 10 ** top], ticks };
  }
  if (high < low) [low, high] = [high, low];
  if (high === low) { high = low + 1; low = Math.min(0, low); }
  const raw = (high - low) / 4, magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(factor => factor * magnitude).find(candidate => candidate >= raw)!;
  const start = Math.floor(low / step + 1e-9) * step, end = Math.ceil(high / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let tick = start; tick <= end + step / 2 && ticks.length < 12; tick += step) ticks.push(Number(tick.toPrecision(12)));
  return { domain: [start, end], ticks };
}

/**
 * Serialized into the opaque frame: building blocks a diagram declares rather
 * than draws. Host-drawn charts (`data-artifact-chart`), connectors between
 * HTML nodes (`data-artifact-connect`) and the header badge
 * (`data-artifact-badge`). Keep it self-contained; its collaborators are the
 * pure helpers above.
 */
function installArtifactKit(send: (data: { badge: string }) => void, number: typeof artifactNumber, axis: typeof artifactTicks) {
  const ns = "http://www.w3.org/2000/svg";
  let identity = 0;
  const draw = <K extends keyof SVGElementTagNameMap>(name: K, attributes: Record<string, string | number>, parent?: Element) => {
    const element = document.createElementNS(ns, name);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    parent?.append(element);
    return element;
  };
  const html = <K extends keyof HTMLElementTagNameMap>(name: K, className: string, text = "", parent?: Element) => {
    const element = document.createElement(name);
    if (className) element.className = className;
    if (text) element.textContent = text;
    parent?.append(element);
    return element;
  };
  const plain = (value: unknown, limit: number) => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim().slice(0, limit) : "";
  const ROLES = ["data", "light", "current", "once", "structure", "error"];
  const OWNERS = ["owner-0", "owner-1", "owner-2", "owner-3"];
  const color = (role: unknown, index: number) => OWNERS.includes(role as string) ? `var(--artifact-${role})`
    : `var(--artifact-role-${ROLES.includes(role as string) ? role : ["data", "structure", "once", "current"][index % 4]})`;
  // Text on a filled mark: dark on the light hues, the page colour on the rest.
  const onFill = (role: unknown) => ["light", "current", "once", "owner-1"].includes(role as string) ? "#241412" : "var(--artifact-bg)";

  type Series = { name: string; values: (number | null)[]; role?: string; notes?: string[] };
  type Spec = {
    type?: string; x?: (string | number)[]; series?: Series[]; stacked?: boolean; height?: number; highlight?: number | number[];
    y?: { label?: string; scale?: string; min?: number; max?: number; format?: string; unit?: string };
    xAxis?: { label?: string; scale?: string };
    rules?: { y: number; label?: string }[]; marks?: { x: number; label?: string }[];
    rows?: string[]; values?: (number | null)[][]; colors?: string; note?: string;
    blocks?: { row: number; start: number; length: number; label?: string; role?: string; note?: string }[]; end?: number;
  };

  const chart = (host: HTMLElement) => {
    let spec: Spec;
    try { spec = JSON.parse(host.getAttribute("data-artifact-chart") || "{}"); }
    catch { host.replaceChildren(); reportError(new Error("A data-artifact-chart value is not valid JSON.")); return; }
    // The content box: a padded host must not grow by its padding on every redraw.
    const box = getComputedStyle(host);
    const width = Math.max(200, Math.floor(host.clientWidth - parseFloat(box.paddingLeft) - parseFloat(box.paddingRight)));
    const height = Math.min(420, Math.max(140, Number(spec.height) || 220));
    const format = (value: number | null) => number(value, spec.y?.format, spec.y?.unit);
    const x = (spec.x ?? []).slice(0, 60).map(label => typeof label === "number" ? label : plain(label, 40));
    const series = (spec.series ?? []).slice(0, 6).map(item => ({ ...item, name: plain(item.name, 40), values: x.map((_, index) => {
      const value = item.values?.[index];
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    }) }));
    const id = `delphi-artifact-chart-${++identity}`;
    const nodes: Element[] = [];
    if (series.length > 1) {
      const legend = html("div", "artifact-legend");
      series.forEach((item, index) => {
        const key = html("span", "artifact-key", item.name, legend);
        key.style.setProperty("--artifact-key", color(item.role, index));
      });
      nodes.push(legend);
    }
    const svg = draw("svg", { width, height, viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": plain(spec.y?.label, 80) || "Chart" });
    const readout = html("p", "artifact-chart-readout", plain(spec.note, 160));
    readout.setAttribute("aria-live", "polite");
    // A table ignores a 1px height; its visually hidden wrapper does not.
    const hidden = html("div", "artifact-sr"), table = html("table", "", "", hidden);
    nodes.push(svg, readout, hidden);
    const defs = draw("defs", {}, svg);
    const hatch = draw("pattern", { id: `${id}-hatch`, width: 6, height: 6, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" }, defs);
    draw("rect", { width: 6, height: 6, fill: "var(--artifact-bg)" }, hatch);
    draw("line", { x1: 0, y1: 0, x2: 0, y2: 6, stroke: "var(--artifact-border)", "stroke-width": 3 }, hatch);
    const marks: { element: SVGElement; text: string }[] = [];
    const inspect = (index: number) => {
      marks.forEach((mark, position) => mark.element.classList.toggle("is-inspected", position === index));
      readout.textContent = index >= 0 ? marks[index].text : plain(spec.note, 160);
    };
    const mark = (element: SVGElement, text: string) => {
      const position = marks.push({ element, text }) - 1;
      element.classList.add("artifact-chart-mark");
      element.addEventListener("pointerenter", () => inspect(position));
      element.addEventListener("pointerleave", () => inspect(-1));
    };
    svg.setAttribute("tabindex", "0");
    let focused = -1;
    svg.addEventListener("keydown", event => {
      if (!marks.length || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      focused = event.key === "Home" ? 0 : event.key === "End" ? marks.length - 1 : Math.min(marks.length - 1, Math.max(0, focused + (event.key === "ArrowRight" ? 1 : -1)));
      inspect(focused);
    });
    svg.addEventListener("blur", () => { focused = -1; inspect(-1); });
    const text = (value: string, attributes: Record<string, string | number>, className = "") => {
      const node = draw("text", attributes, svg);
      if (className) node.setAttribute("class", className);
      node.textContent = value;
      return node;
    };
    // Room for the widest x label, so short labels are never thinned out.
    const gap = Math.max(28, 10 + 7 * Math.max(0, ...x.map(label => (typeof label === "number" ? number(label) : label).length)));
    const highlighted = (index: number) => Array.isArray(spec.highlight) ? false : spec.highlight === index;

    if (spec.type === "heatmap") {
      const rows = (spec.rows ?? []).slice(0, 30).map(row => plain(row, 40));
      const grid = rows.map((_, row) => x.map((__, column) => { const value = spec.values?.[row]?.[column]; return typeof value === "number" && Number.isFinite(value) ? value : null; }));
      const flat = grid.flat().filter((value): value is number => value !== null);
      const left = Math.min(width * .35, 12 + 7 * Math.max(0, ...rows.map(row => row.length))), bottom = 26 + (spec.xAxis?.label ? 18 : 0);
      const cell = { w: (width - left - 8) / Math.max(1, x.length), h: Math.min(34, Math.max(18, (height - bottom - 8) / Math.max(1, rows.length))) };
      const total = Math.ceil(rows.length * cell.h + bottom + 8);
      svg.setAttribute("height", String(total)); svg.setAttribute("viewBox", `0 0 ${width} ${total}`);
      const diverging = spec.colors === "diverging", extent = Math.max(1e-12, ...flat.map(Math.abs)), low = Math.min(...flat), high = Math.max(...flat);
      grid.forEach((cells, row) => {
        text(rows[row], { x: left - 6, y: 8 + row * cell.h + cell.h / 2, "text-anchor": "end", "dominant-baseline": "central" });
        cells.forEach((value, column) => {
          const share = value === null ? 0 : diverging ? Math.abs(value) / extent : (value - low) / Math.max(1e-12, high - low);
          const tone = diverging && value !== null && value < 0 ? "structure" : "data";
          const box = draw("rect", { x: left + column * cell.w + 1, y: 8 + row * cell.h + 1, width: Math.max(1, cell.w - 2), height: cell.h - 2, rx: 3,
            fill: value === null ? `url(#${id}-hatch)` : `color-mix(in srgb, var(--artifact-role-${tone}) ${Math.round(8 + share * 82)}%, var(--artifact-bg))` }, svg);
          const focus = Array.isArray(spec.highlight) && spec.highlight[0] === row && spec.highlight[1] === column;
          if (focus) box.setAttribute("class", "is-current");
          mark(box, `${rows[row]} · ${x[column]}: ${format(value)}`);
          if (value !== null && cell.w >= 34 && cell.h >= 18) text(format(value), { x: left + column * cell.w + cell.w / 2, y: 8 + row * cell.h + cell.h / 2, "text-anchor": "middle", "dominant-baseline": "central", "pointer-events": "none" }, share > .55 ? "artifact-chart-on" : "artifact-chart-value");
        });
      });
      const every = Math.ceil(x.length / Math.max(1, Math.floor((width - left) / gap)));
      x.forEach((label, column) => { if (column % every === 0) text(String(label), { x: left + column * cell.w + cell.w / 2, y: 8 + rows.length * cell.h + 16, "text-anchor": "middle" }); });
      if (spec.xAxis?.label) text(plain(spec.xAxis.label, 60), { x: left + (width - left) / 2, y: total - 4, "text-anchor": "middle" }, "artifact-chart-axis");
      const head = html("tr", "", "", table);
      html("th", "", "", head);
      x.forEach(label => html("th", "", String(label), head));
      grid.forEach((cells, row) => { const line = html("tr", "", "", table); html("th", "", rows[row], line); cells.forEach(value => html("td", "", format(value), line)); });
      host.replaceChildren(...nodes);
      return;
    }

    const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
    if (spec.type === "meter") {
      // One stacked bar on a fixed scale, its capacities as dashed rules: a
      // threshold stays put while the parts beneath it change.
      const parts = (spec.series ?? []).slice(0, 6).map(item => ({ ...item, name: plain(item.name, 40), value: Math.max(0, Number(item.values?.[0]) || 0) }));
      const total = parts.reduce((sum, part) => sum + part.value, 0);
      const rules = (spec.rules ?? []).filter(rule => Number.isFinite(rule.y) && rule.y > 0).slice(0, 4).sort((a, b) => a.y - b.y);
      const scale = finite(spec.y?.max) ?? (Math.max(total, ...rules.map(rule => rule.y)) * 1.08 || 1);
      const bar = { x: 0, y: 22, w: width, h: 28 };
      const xOf = (value: number) => bar.x + bar.w * Math.min(1, value / scale);
      const rows: number[] = [];
      const placed = rules.map(rule => {
        const label = plain(rule.label, 40) || format(rule.y), half = 3.6 * label.length + 4, at = xOf(rule.y);
        const left = Math.min(width - 2 * half, Math.max(0, at - half));
        let row = rows.findIndex(end => end < left);
        if (row < 0) row = rows.push(0) - 1;
        rows[row] = left + 2 * half + 8;
        return { rule, label, at, center: left + half, row };
      });
      const total_h = bar.y + bar.h + 8 + rows.length * 18;
      svg.setAttribute("height", String(total_h)); svg.setAttribute("viewBox", `0 0 ${width} ${total_h}`);
      draw("rect", { x: bar.x, y: bar.y, width: bar.w, height: bar.h, rx: 6, fill: "var(--artifact-surface)", stroke: "var(--artifact-border)" }, svg);
      let from = 0;
      parts.forEach((part, index) => {
        if (part.value <= 0 || from >= scale) { from += part.value; return; }
        const x0 = xOf(from), x1 = xOf(from + part.value);
        const segment = draw("rect", { x: x0, y: bar.y, width: Math.max(1, x1 - x0), height: bar.h, fill: color(part.role, index) }, svg);
        if (highlighted(index)) segment.setAttribute("class", "is-current");
        mark(segment, part.notes?.[0] ? plain(part.notes[0], 160) : `${part.name}: ${format(part.value)}`);
        if (x1 - x0 >= 8 * format(part.value).length + 10) text(format(part.value), { x: (x0 + x1) / 2, y: bar.y + bar.h / 2, "text-anchor": "middle", "dominant-baseline": "central", "pointer-events": "none", style: `fill:${onFill(part.role)}` }, "artifact-chart-value");
        from += part.value;
      });
      const end = xOf(total);
      text(total > scale ? `${format(total)}, beyond the scale` : format(total), { x: Math.min(width, Math.max(0, end)), y: 14, "text-anchor": end > width * .7 ? "end" : end < width * .3 ? "start" : "middle" }, "artifact-chart-value");
      for (const item of placed) {
        draw("line", { x1: item.at, x2: item.at, y1: bar.y - 5, y2: bar.y + bar.h + 5 + item.row * 18, class: "artifact-chart-rule" }, svg);
        text(item.label, { x: item.center, y: bar.y + bar.h + 18 + item.row * 18, "text-anchor": "middle" });
      }
      const head = html("tr", "", "", table);
      html("th", "", "Part", head); html("th", "", "Value", head);
      parts.forEach(part => { const row = html("tr", "", "", table); html("th", "", part.name, row); html("td", "", format(part.value), row); });
      rules.forEach(rule => { const row = html("tr", "", "", table); html("th", "", plain(rule.label, 40) || "Limit", row); html("td", "", format(rule.y), row); });
      host.replaceChildren(...nodes);
      return;
    }

    if (spec.type === "timeline") {
      // Blocks placed from a schedule's own numbers; an empty dashed lane is idle time.
      const rows = (spec.rows ?? []).slice(0, 12).map(row => plain(row, 24));
      const blocks = (spec.blocks ?? []).slice(0, 400).map((block, index) => ({ ...block, index })).filter(block => Number.isInteger(block.row) && block.row >= 0 && block.row < rows.length
        && Number.isFinite(block.start) && Number.isFinite(block.length) && block.length > 0 && block.start >= 0);
      const end = finite(spec.end) ?? Math.max(1, ...blocks.map(block => block.start + block.length));
      const left = Math.min(width * .3, 12 + 7 * Math.max(0, ...rows.map(row => row.length)));
      const lane = rows.length > 6 ? 20 : 28, gapY = 6, plotW = width - left - 4;
      const marks = (spec.marks ?? []).slice(0, 4).filter(item => Number.isFinite(item.x)), top = marks.some(item => item.label) ? 20 : 0;
      const bottom = 22 + (spec.xAxis?.label ? 18 : 0), total_h = top + rows.length * (lane + gapY) + bottom;
      svg.setAttribute("height", String(total_h)); svg.setAttribute("viewBox", `0 0 ${width} ${total_h}`);
      const xOf = (value: number) => left + plotW * Math.min(1, Math.max(0, value / end));
      rows.forEach((row, index) => {
        const y = top + index * (lane + gapY);
        text(row, { x: left - 8, y: y + lane / 2, "text-anchor": "end", "dominant-baseline": "central" });
        draw("rect", { x: left, y: y + .5, width: plotW, height: lane - 1, rx: 4, fill: "none", stroke: "var(--artifact-border)", "stroke-dasharray": "4 3" }, svg);
      });
      blocks.forEach(block => {
        const y = top + block.row * (lane + gapY), x0 = xOf(block.start), x1 = xOf(block.start + block.length);
        const role = block.role ?? "data", label = plain(block.label, 24);
        const rect = draw("rect", { x: x0 + .5, y: y + 1, width: Math.max(2, x1 - x0 - 1), height: lane - 2, rx: Math.min(4, (x1 - x0) / 4), fill: color(role, 0) }, svg);
        if (spec.highlight === block.index) rect.setAttribute("class", "is-current");
        mark(rect, block.note ? plain(block.note, 160) : `${rows[block.row]} · ${label || "block"}: ${number(block.start)} to ${number(block.start + block.length)}`);
        if (label && x1 - x0 >= 7 * label.length + 8) text(label, { x: (x0 + x1) / 2, y: y + lane / 2, "text-anchor": "middle", "dominant-baseline": "central", "pointer-events": "none", style: `fill:${onFill(role)}` }, "artifact-chart-value");
      });
      const { ticks } = axis(0, end, "linear");
      const baseline = top + rows.length * (lane + gapY);
      ticks.filter(tick => tick <= end).forEach(tick => text(number(tick), { x: xOf(tick), y: baseline + 12, "text-anchor": tick === 0 ? "start" : "middle" }));
      for (const item of marks) {
        const position = xOf(item.x), late = position > left + plotW * .7;
        draw("line", { x1: position, x2: position, y1: top ? 6 : 0, y2: baseline - gapY, class: "artifact-chart-mark-line" }, svg);
        if (item.label) text(plain(item.label, 40), { x: position, y: 12, "text-anchor": late ? "end" : "start", dx: late ? -4 : 4 }, "artifact-chart-value");
      }
      if (spec.xAxis?.label) text(plain(spec.xAxis.label, 60), { x: left + plotW / 2, y: total_h - 4, "text-anchor": "middle" }, "artifact-chart-axis");
      const head = html("tr", "", "", table);
      ["Row", "Block", "Start", "End"].forEach(name => html("th", "", name, head));
      blocks.forEach(block => { const row = html("tr", "", "", table); [rows[block.row], plain(block.label, 24), number(block.start), number(block.start + block.length)].forEach(cell => html("td", "", cell, row)); });
      host.replaceChildren(...nodes);
      return;
    }

    const line = spec.type === "line";
    const numericX = line && x.every(value => typeof value === "number");
    const totals = x.map((_, index) => series.reduce((sum, item) => sum + (item.values[index] ?? 0), 0));
    const values = spec.stacked ? totals : series.flatMap(item => item.values.filter((value): value is number => value !== null));
    const positive = values.filter(value => value > 0);
    // A log axis needs a positive value; without one the chart is linear.
    const log = spec.y?.scale === "log" && positive.length > 0;
    const given = (value: unknown) => typeof value === "number" && Number.isFinite(value) && (!log || value > 0) ? value : undefined;
    let low = given(spec.y?.min) ?? (log ? Math.min(...positive) : line ? Math.min(...values) : Math.min(0, ...values));
    let high = given(spec.y?.max) ?? Math.max(...values, ...(spec.rules ?? []).map(rule => rule.y).filter(Number.isFinite));
    if (!values.length) { low = log ? 1 : 0; high = log ? 10 : 1; }
    if (high <= low) high = log ? low * 10 : low + 1;
    if (line && !log && spec.y?.min === undefined && low > 0 && low < high * .5) low = 0;
    const { domain, ticks } = axis(low, high, log ? "log" : "linear");
    const labels = ticks.map(tick => format(tick));
    const left = Math.min(width * .3, 14 + 7 * Math.max(...labels.map(label => label.length)) + (spec.y?.label ? 16 : 0));
    const top = 12, right = 12, bottom = 26 + (spec.xAxis?.label ? 18 : 0);
    const plot = { w: width - left - right, h: height - top - bottom };
    const yOf = (value: number) => {
      const t = log ? (Math.log10(Math.max(value, domain[0])) - Math.log10(domain[0])) / (Math.log10(domain[1]) - Math.log10(domain[0])) : (value - domain[0]) / (domain[1] - domain[0]);
      return top + plot.h * (1 - Math.min(1, Math.max(0, t)));
    };
    const xLog = numericX && spec.xAxis?.scale === "log" && x.every(value => (value as number) > 0);
    const band = plot.w / Math.max(1, x.length);
    const xRange = numericX ? [Math.min(...(x as number[])), Math.max(...(x as number[]))] : [0, 1];
    const xOf = (index: number) => {
      if (!numericX) return left + band * index + band / 2;
      const value = x[index] as number;
      const t = xLog ? (Math.log10(value) - Math.log10(xRange[0])) / Math.max(1e-12, Math.log10(xRange[1]) - Math.log10(xRange[0])) : (value - xRange[0]) / Math.max(1e-12, xRange[1] - xRange[0]);
      return left + 6 + (plot.w - 12) * t;
    };
    ticks.forEach((tick, index) => {
      const y = yOf(tick);
      draw("line", { x1: left, x2: width - right, y1: y, y2: y, class: tick === 0 && !log ? "artifact-chart-base" : "artifact-chart-grid" }, svg);
      text(labels[index], { x: left - 6, y, "text-anchor": "end", "dominant-baseline": "central" });
    });
    if (spec.y?.label) text(plain(spec.y.label, 60), { x: 0, y: 0, transform: `translate(11 ${top + plot.h / 2}) rotate(-90)`, "text-anchor": "middle" }, "artifact-chart-axis");
    const every = Math.ceil(x.length / Math.max(1, Math.floor(plot.w / gap)));
    x.forEach((label, index) => { if (index % every === 0 || index === x.length - 1 && numericX) text(typeof label === "number" ? number(label) : label, { x: xOf(index), y: top + plot.h + 17, "text-anchor": "middle" }); });
    if (spec.xAxis?.label) text(plain(spec.xAxis.label, 60), { x: left + plot.w / 2, y: height - 4, "text-anchor": "middle" }, "artifact-chart-axis");
    const base = yOf(log ? domain[0] : Math.max(domain[0], Math.min(0, domain[1])));

    if (line) {
      series.forEach((item, position) => {
        let path = "", open = false;
        item.values.forEach((value, index) => {
          if (value === null || (log && value <= 0)) { open = false; return; }
          path += `${open ? "L" : "M"}${xOf(index).toFixed(1)} ${yOf(value).toFixed(1)}`;
          open = true;
        });
        draw("path", { d: path, fill: "none", stroke: color(item.role, position), "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
        item.values.forEach((value, index) => {
          if (value === null || (log && value <= 0)) return;
          const point = draw("circle", { cx: xOf(index), cy: yOf(value), r: highlighted(index) ? 5 : 3.5, fill: highlighted(index) ? "var(--artifact-role-current)" : color(item.role, position), stroke: "var(--artifact-bg)", "stroke-width": 1.5 }, svg);
          mark(point, item.notes?.[index] ? plain(item.notes[index], 160) : `${x[index]}${series.length > 1 ? ` · ${item.name}` : ""}: ${format(value)}`);
        });
      });
    } else {
      const inner = Math.min(band * .68, 64 * (spec.stacked ? 1 : series.length)), slot = spec.stacked ? inner : inner / Math.max(1, series.length);
      x.forEach((_, index) => {
        let stack = log ? domain[0] : 0;
        series.forEach((item, position) => {
          const value = item.values[index];
          const x0 = left + band * index + (band - inner) / 2 + (spec.stacked ? 0 : position * slot);
          const note = item.notes?.[index] ? plain(item.notes[index], 160) : `${x[index]}${series.length > 1 ? ` · ${item.name}` : ""}: ${format(value)}`;
          if (value === null) {
            const bar = draw("rect", { x: x0 + 1, y: top + plot.h * .4, width: Math.max(2, slot - 2), height: base - top - plot.h * .4, rx: 3, fill: `url(#${id}-hatch)`, class: "artifact-chart-undefined" }, svg);
            mark(bar, item.notes?.[index] ? note : `${x[index]}${series.length > 1 ? ` · ${item.name}` : ""}: undefined`);
            if (slot >= 40) text("undefined", { x: x0 + slot / 2, y: top + plot.h * .4 - 6, "text-anchor": "middle" });
            return;
          }
          const from = spec.stacked ? stack : log ? domain[0] : 0, to = spec.stacked ? stack + value : value;
          stack = to;
          const y0 = yOf(Math.max(from, to)), y1 = yOf(Math.min(from, to));
          const bar = draw("rect", { x: x0 + 1, y: y0, width: Math.max(2, slot - 2), height: Math.max(1, y1 - y0), rx: 3, fill: color(item.role, position) }, svg);
          if (highlighted(index)) bar.setAttribute("class", "is-current");
          mark(bar, note);
          if (!spec.stacked && slot >= 28) text(format(value), { x: x0 + slot / 2, y: y0 - 5, "text-anchor": "middle" }, "artifact-chart-value");
        });
        if (spec.stacked && inner >= 28 && series.some(item => item.values[index] !== null)) text(format(totals[index]), { x: left + band * index + band / 2, y: yOf(totals[index]) - 5, "text-anchor": "middle" }, "artifact-chart-value");
      });
    }
    for (const rule of (spec.rules ?? []).slice(0, 4)) {
      if (!Number.isFinite(rule.y)) continue;
      const y = yOf(rule.y);
      draw("line", { x1: left, x2: width - right, y1: y, y2: y, class: "artifact-chart-rule" }, svg);
      if (rule.label) text(plain(rule.label, 40), { x: width - right, y: y - 5, "text-anchor": "end" }, "artifact-chart-value");
    }
    for (const item of (spec.marks ?? []).slice(0, 4)) {
      const index = numericX ? (x as number[]).findIndex(value => value === item.x) : Number.isInteger(item.x) ? item.x : -1;
      if (index < 0 || index >= x.length) continue;
      const position = xOf(index);
      draw("line", { x1: position, x2: position, y1: top, y2: top + plot.h, class: "artifact-chart-mark-line" }, svg);
      if (item.label) text(plain(item.label, 40), { x: Math.min(width - right, Math.max(left, position)), y: top + 2, "text-anchor": position > left + plot.w * .7 ? "end" : "start", dx: position > left + plot.w * .7 ? -4 : 4, "dominant-baseline": "hanging" }, "artifact-chart-value");
    }
    const head = html("tr", "", "", table);
    html("th", "", "", head);
    series.forEach(item => html("th", "", item.name || "Value", head));
    x.forEach((label, index) => { const row = html("tr", "", "", table); html("th", "", String(label), row); series.forEach(item => html("td", "", item.values[index] === null ? "undefined" : format(item.values[index]), row)); });
    host.replaceChildren(...nodes);
  };

  // Connectors join real HTML nodes at their nearest sides and follow them
  // through every resize, where hand-placed SVG arrows break.
  let overlay: SVGSVGElement | null = null;
  const paths = new Map<Element, { path: SVGPathElement; label: SVGTextElement | null }>();
  // Only real changes are written, so an author's own observer is not fed one per redraw.
  const put = (element: Element, name: string, value: string | null) => {
    if (element.getAttribute(name) === value) return;
    if (value === null) element.removeAttribute(name); else element.setAttribute(name, value);
  };
  const shows = (element: SVGElement, shown: boolean) => { if ((element.style.display === "none") === shown) element.style.display = shown ? "" : "none"; };
  const connect = () => {
    const declarations = [...document.querySelectorAll("[data-artifact-connect]")].slice(0, 40);
    for (const [declaration, item] of paths) if (!declarations.includes(declaration)) { item.path.remove(); item.label?.remove(); paths.delete(declaration); }
    if (!declarations.length) return;
    const body = document.body;
    if (!overlay) {
      if (getComputedStyle(body).position === "static") body.style.position = "relative";
      overlay = draw("svg", { class: "artifact-connectors", "aria-hidden": "true" });
      const defs = draw("defs", {}, overlay);
      for (const role of ["", "data", "stream", "control", "once", "feedback"]) {
        const marker = draw("marker", { id: `delphi-artifact-arrow${role && `-${role}`}`, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 10, markerHeight: 10, markerUnits: "userSpaceOnUse", orient: "auto-start-reverse" }, defs);
        draw("path", { d: "M1 1L9 5L1 9z", class: `artifact-arrow${role && ` is-${role}`}` }, marker);
      }
      body.prepend(overlay);
    }
    const origin = body.getBoundingClientRect();
    const box = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left - origin.left, right: rect.right - origin.left, top: rect.top - origin.top, bottom: rect.bottom - origin.top, x: rect.left - origin.left + rect.width / 2, y: rect.top - origin.top + rect.height / 2, shown: rect.width > 0 && rect.height > 0 };
    };
    for (const declaration of declarations) {
      const [from, to] = (declaration.getAttribute("data-artifact-connect") ?? "").trim().split(/\s+/).map(name => name && document.getElementById(name));
      let item = paths.get(declaration);
      if (!item) {
        const path = draw("path", {}, overlay);
        const words = plain(declaration.getAttribute("data-label"), 40);
        item = { path, label: words ? draw("text", { class: "artifact-connector-label" }, overlay) : null };
        if (item.label) item.label.textContent = words;
        paths.set(declaration, item);
      }
      const role = ["data", "stream", "control", "once", "feedback"].find(name => name === declaration.getAttribute("data-artifact-edge")) ?? "";
      put(item.path, "data-artifact-edge", role);
      put(item.path, "data-artifact-step", declaration.getAttribute("data-artifact-step"));
      put(item.path, "marker-end", `url(#delphi-artifact-arrow${role && `-${role}`})`);
      const a = from ? box(from) : null, b = to ? box(to) : null;
      const hidden = !a?.shown || !b?.shown || declaration.closest("[hidden],.hidden") !== null;
      shows(item.path, !hidden);
      if (item.label) shows(item.label, !hidden);
      if (hidden || !a || !b) continue;
      let d: string, middle: { x: number; y: number }, anchor = "middle";
      const row = a.top < b.bottom && b.top < a.bottom;
      if (role === "feedback" && row) {
        const low = Math.max(a.bottom, b.bottom) + 18;
        d = `M${a.x} ${a.bottom}V${low}H${b.x}V${b.bottom + 2}`;
        middle = { x: (a.x + b.x) / 2, y: low - 6 };
      } else if (row) {
        // One row: leave the facing sides, bending once in the gap between.
        const forward = b.x >= a.x, start = forward ? a.right : a.left, end = forward ? b.left - 2 : b.right + 2, mid = (start + end) / 2;
        d = Math.abs(a.y - b.y) < 2 ? `M${start} ${a.y}H${end}` : `M${start} ${a.y}H${mid}V${b.y}H${end}`;
        middle = { x: mid, y: Math.min(a.y, b.y) - 6 };
      } else {
        // Different rows, as a wrapped flow puts them: run straight down where
        // the two overlap, or else turn only inside the gap between the rows.
        const down = b.top >= a.bottom, start = down ? a.bottom : a.top, end = down ? b.top - 2 : b.bottom + 2, mid = (start + end) / 2;
        const low = Math.max(a.left, b.left), high = Math.min(a.right, b.right);
        if (high - low >= 12) {
          const x = (low + high) / 2;
          d = `M${x} ${start}V${end}`;
          middle = { x: x + 6, y: mid + 4 };
          anchor = "start";
        } else {
          d = `M${a.x} ${start}V${mid}H${b.x}V${end}`;
          middle = { x: (a.x + b.x) / 2, y: mid - 4 };
        }
      }
      put(item.path, "d", d);
      if (item.label) { put(item.label, "x", String(middle.x)); put(item.label, "y", String(middle.y)); put(item.label, "text-anchor", anchor); }
    }
  };

  // A slot naming where it came from (data-artifact-from="id") glides in from
  // that element, so a transfer between devices is seen rather than inferred.
  const flown = new WeakMap<Element, string>();
  const fly = (animate: boolean) => {
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let order = 0;
    for (const element of [...document.querySelectorAll<HTMLElement>("[data-artifact-from]")].slice(0, 64)) {
      const from = element.getAttribute("data-artifact-from") ?? "";
      if (flown.get(element) === from) continue;
      // A slot not shown yet glides once it appears.
      const b = element.getBoundingClientRect();
      if (!b.width) continue;
      flown.set(element, from);
      const source = from ? document.getElementById(from) : null;
      if (!animate || still || !source || source === element) continue;
      const a = source.getBoundingClientRect();
      if (!a.width) continue;
      element.animate([{ transform: `translate(${a.left - b.left}px,${a.top - b.top}px)`, opacity: .4 }, { transform: "none", opacity: 1 }],
        { duration: 560, delay: 45 * order++, easing: "cubic-bezier(.2,.7,.2,1)", fill: "backwards" });
    }
  };

  let badge = "";
  const charts = new WeakMap<Element, string>();
  let queued = false;
  const update = (animate = true) => {
    queued = false;
    for (const host of document.querySelectorAll<HTMLElement>("[data-artifact-chart]")) {
      const key = `${host.getAttribute("data-artifact-chart")}|${host.clientWidth}`;
      if (charts.get(host) !== key) { charts.set(host, key); chart(host); }
    }
    fly(animate);
    connect();
    const next = plain(document.querySelector("[data-artifact-badge]")?.getAttribute("data-artifact-badge"), 24);
    if (next !== badge) { badge = next; send({ badge }); }
  };
  // Once a frame, or soon after where Chromium withholds frames from one it judges unseen.
  const schedule = () => {
    if (queued) return;
    queued = true;
    const run = () => { cancelAnimationFrame(frame); clearTimeout(timer); if (queued) update(); };
    const frame = requestAnimationFrame(run), timer = setTimeout(run, 50);
  };
  addEventListener("resize", schedule);
  addEventListener("DOMContentLoaded", () => {
    update(false);
    new ResizeObserver(schedule).observe(document.body);
    new MutationObserver(records => {
      if (records.some(record => !overlay?.contains(record.target) && !(record.target instanceof Element && record.target.closest("[data-artifact-chart]") && record.attributeName !== "data-artifact-chart"))) schedule();
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-artifact-chart", "data-artifact-connect", "data-artifact-badge", "data-artifact-from", "hidden", "class", "style"] });
    void document.fonts.ready.then(schedule);
  }, { once: true });
}

export function artifactKitBootstrap(): string {
  return `(${installArtifactKit.toString()})(send, ${artifactNumber.toString()}, ${artifactTicks.toString()});`;
}
