export type ArtifactControlAction = "back" | "next";
export type ArtifactControls = {
  revision: number;
  back: { label: string; disabled: boolean };
  next: { label: string; disabled: boolean };
  progress: string;
};

export type ArtifactStep = { current: number; total: number; name: string };

/**
 * The step a diagram's progress text names: "3 / 6 · Normalize", "Step 3 of 6:
 * Normalize" or "L1 hit · 2 / 4 · Return", whose name is every word around the
 * count. Anything else stays plain text in the header.
 */
export function artifactStep(progress: string): ArtifactStep | null {
  const match = /^(.{0,40}?)(\d{1,2})\s*(?:\/|of)\s*(\d{1,2})(?!\d)(.*)$/i.exec(progress.trim());
  if (!match) return null;
  const current = Number(match[2]), total = Number(match[3]);
  if (total < 2 || current < 1 || current > total) return null;
  const trim = (text: string) => text.replace(/^[\s·:–—()\[\]|,-]+|[\s·:–—()\[\]|,-]+$/g, "");
  return { current, total, name: [trim(match[1].replace(/\bstep\b/i, "")), trim(match[4])].filter(Boolean).join(" · ") };
}

/** The header states only these disclosures; a diagram cannot label itself "Verified". */
const BADGES = ["Schematic", "Toy data", "Illustrative", "Simplified", "Not to scale"];
export function artifactBadge(value: unknown): string {
  return typeof value === "string" ? BADGES.find(badge => badge.toLowerCase() === value.trim().toLowerCase()) ?? "" : "";
}

/** Untrusted frame messages become only text, native disabled state and two actions. */
export function artifactControls(value: unknown): ArtifactControls | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (!Number.isSafeInteger(input.revision) || (input.revision as number) < 1) return null;
  const text = (value: unknown, maximum: number) => typeof value === "string" && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
  const button = (value: unknown) => {
    if (!value || typeof value !== "object") return null;
    const item = value as Record<string, unknown>;
    return text(item.label, 32) && (item.label as string).trim() && typeof item.disabled === "boolean"
      ? { label: item.label as string, disabled: item.disabled } : null;
  };
  const back = button(input.back), next = button(input.next);
  if (!back || !next || !text(input.progress, 64)) return null;
  return { revision: input.revision as number, back, next, progress: input.progress as string };
}

/** Serialized into the opaque frame. Native HTML remains usable without a host. */
export function installArtifactControls(send: (data: { controls: ArtifactControls | null }) => void) {
  type Group = { element: HTMLElement; back: HTMLButtonElement; next: HTMLButtonElement; progress: string };
  let group: Group | null = null, current: ArtifactControls | null = null;
  let revision = 0, queued = 0;
  const text = (value: string | null, limit: number) => (value ?? "").replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim().slice(0, limit);
  const shown = (element: Element) => {
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (node.hasAttribute("hidden") || node.hasAttribute("inert") || style.display === "none" || style.visibility === "hidden") return false;
    }
    return true;
  };
  const read = (): Group | null => {
    const groups = document.querySelectorAll('[data-artifact-controls="header"]');
    if (groups.length !== 1 || !(groups[0] instanceof HTMLElement)) return null;
    const element = groups[0];
    // Temporarily remove only our hiding rule to inspect the author's own
    // visibility. The synchronous read never paints a duplicate control row.
    const docked = element.hasAttribute("data-artifact-docked");
    if (docked) element.removeAttribute("data-artifact-docked");
    try {
      const controls = element.querySelectorAll('button,input,select,textarea,a,[role="button"],[contenteditable]');
      const back = element.querySelectorAll('button[data-artifact-action="back"]');
      const next = element.querySelectorAll('button[data-artifact-action="next"]');
      const progress = element.querySelectorAll("output[data-artifact-progress]");
      if (controls.length !== 2 || back.length !== 1 || next.length !== 1 || progress.length > 1) return null;
      if (!(back[0] instanceof HTMLButtonElement) || !(next[0] instanceof HTMLButtonElement)) return null;
      if (back[0].type !== "button" || next[0].type !== "button" || !shown(back[0]) || !shown(next[0])) return null;
      return { element, back: back[0], next: next[0], progress: text(progress[0]?.textContent ?? "", 64) };
    } finally {
      if (docked) element.setAttribute("data-artifact-docked", "");
    }
  };
  const publish = (force = false) => {
    const found = read();
    const descriptor = (button: HTMLButtonElement, fallback: string) => ({
      label: text(button.getAttribute("aria-label") || button.textContent, 32) || fallback,
      disabled: button.matches(":disabled") || Boolean(button.closest('[aria-disabled="true"]')),
    });
    const next = found ? { revision, back: descriptor(found.back, "Back"), next: descriptor(found.next, "Next"), progress: found.progress } : null;
    const changed = found?.element !== group?.element || found?.back !== group?.back || found?.next !== group?.next
      || JSON.stringify(next) !== JSON.stringify(current);
    if (!changed && !force) return;
    if (group && group.element !== found?.element) group.element.removeAttribute("data-artifact-docked");
    group = found;
    current = next ? { ...next, revision: ++revision } : null;
    send({ controls: current });
  };
  // Once a frame, or soon after where Chromium withholds frames from one it thinks unseen.
  const schedule = () => {
    if (queued) return;
    const run = () => { cancelAnimationFrame(frame); clearTimeout(timer); queued = 0; publish(); };
    const frame = requestAnimationFrame(run), timer = window.setTimeout(run, 50);
    queued = timer;
  };
  addEventListener("resize", schedule);
  addEventListener("message", event => {
    if (event.source !== parent || !event.data) return;
    if (event.data.type === "delphi-artifact-controls-request") { publish(true); return; }
    if (!group || !current || event.data.revision !== current.revision) return;
    if (event.data.type === "delphi-artifact-controls-ack") {
      group.element.toggleAttribute("data-artifact-docked", event.data.accepted === true);
      return;
    }
    if (event.data.type !== "delphi-artifact-control" || !group.element.hasAttribute("data-artifact-docked")) return;
    const action: unknown = event.data.action;
    if (action !== "back" && action !== "next") return;
    // A stale host click must not reach a replaced, hidden or newly disabled
    // button. Re-read the declaration synchronously before dispatching it.
    const answered = revision;
    publish();
    if (group && current && event.data.revision === current.revision && !current[action].disabled) {
      const button = group[action];
      if (button.isConnected && group.element.contains(button)) { button.click(); publish(); }
    }
    // Every press is answered, even one that changed nothing, so the host's
    // next press is never left waiting on it.
    if (revision === answered) publish(true);
  });
  // Arrow keys step from inside the diagram too, unless a control there or the
  // author's own key handling (seen as a changed progress) already used them.
  let before = "";
  addEventListener("keydown", () => { before = read()?.progress ?? ""; }, true);
  addEventListener("keydown", event => {
    if (!(event instanceof KeyboardEvent) || event.defaultPrevented || event.altKey || event.metaKey || event.ctrlKey || event.shiftKey || event.isComposing) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    if (event.target instanceof Element && event.target.closest('input,select,textarea,[contenteditable],[role="radio"],[role="tab"],[role="slider"],[role="listbox"],[role="menu"],[role="menubar"],[role="toolbar"],[role="grid"],[role="tree"],[role="spinbutton"],[role="combobox"]')) return;
    for (let node = event.target instanceof Element ? event.target : null; node && node !== document.body; node = node.parentElement) {
      if (node.scrollWidth > node.clientWidth && /auto|scroll/.test(getComputedStyle(node).overflowX)) return;
    }
    publish();
    if (current?.progress !== before) return;
    const action = event.key === "ArrowLeft" ? "back" : "next";
    if (!group || !current || current[action].disabled || !group.element.hasAttribute("data-artifact-docked")) return;
    event.preventDefault();
    group[action].click();
    publish();
  });
  addEventListener("DOMContentLoaded", () => {
    // A change to the controls is published as it lands, so the header never
    // waits for a frame; any other change waits for the next one. Bounded, so
    // an author's observer answering each change still lets the frame yield.
    let burst = 0;
    const declares = (node: Node) => node instanceof Element && (node.matches("[data-artifact-controls]") || node.querySelector("[data-artifact-controls]") !== null);
    const observed = (records: MutationRecord[]) => {
      const element = group?.element;
      const near = records.some(record => element && (element.contains(record.target) || (record.type === "attributes" && record.target.contains(element)))
        || [...record.addedNodes, ...record.removedNodes].some(declares));
      if (!near || burst >= 20) { schedule(); return; }
      if (!burst++) setTimeout(() => { burst = 0; });
      publish();
    };
    new MutationObserver(observed).observe(document.body, {
      subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ["disabled", "aria-disabled", "aria-label", "hidden", "inert", "class", "style", "type", "data-artifact-controls", "data-artifact-action", "data-artifact-progress"],
    });
    publish();
  }, { once: true });
}
