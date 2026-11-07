import { artifactMotionBootstrap } from "./artifact-motion.ts";
import { artifactKitBootstrap } from "./artifact-kit.ts";
import { installArtifactControls } from "./artifact-controls.ts";
import { ARTIFACT_THEME_PROPERTIES } from "./artifact-theme.ts";

/**
 * Resize writes belong outside native observer delivery. Defer authored
 * callbacks one frame instead of filtering loop errors: opaque WebKit reports
 * those benign warnings as the same "Script error." as genuine exceptions.
 * This installer is serialized into interactive frames; keep it self-contained.
 */
export function installArtifactResizeObserver() {
  const NativeObserver = window.ResizeObserver;
  const states = new WeakMap<ResizeObserver, { entries: Map<Element, ResizeObserverEntry>; frame: number }>();
  window.ResizeObserver = class extends NativeObserver {
    constructor(callback: ResizeObserverCallback) {
      if (typeof callback !== "function") throw new TypeError("ResizeObserver requires a callback");
      const state = { entries: new Map<Element, ResizeObserverEntry>(), frame: 0 };
      super((entries, observer) => {
        for (const entry of entries) state.entries.set(entry.target, entry);
        if (state.frame || !state.entries.size) return;
        state.frame = requestAnimationFrame(() => {
          state.frame = 0;
          const batch = [...state.entries.values()];
          state.entries.clear();
          // Clearing before delivery permits callback writes to queue the next
          // frame. Do not catch exceptions: real author failures stay visible.
          if (batch.length) callback.call(observer, batch, observer);
        });
      });
      states.set(this, state);
    }
    unobserve(target: Element) {
      super.unobserve(target);
      const state = states.get(this)!;
      state.entries.delete(target);
      if (!state.entries.size && state.frame) { cancelAnimationFrame(state.frame); state.frame = 0; }
    }
    disconnect() {
      super.disconnect();
      const state = states.get(this)!;
      state.entries.clear();
      if (state.frame) cancelAnimationFrame(state.frame);
      state.frame = 0;
    }
  };
}

/** Bounded theme/size and local button mirroring; never application actions. */
export function artifactBootstrap(preview: boolean, kit = true): string {
  return `(() => {
  "use strict";
  const report = parent.postMessage.bind(parent);
  const send = data => report({type:"delphi-artifact",...data}, "*");
  const themeProperties = new Set(${JSON.stringify(ARTIFACT_THEME_PROPERTIES)});
  const NativeResizeObserver = window.ResizeObserver;
  ${preview ? "" : `(${installArtifactResizeObserver.toString()})();`}
  ${preview ? "" : `(${installArtifactControls.toString()})(send);`}
  // WebRTC's transport is not covered consistently by connect-src.
  for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection"]) {
    try { Object.defineProperty(window, name, {value:undefined,writable:false,configurable:false}); } catch {}
  }
  let queued = false, previous = 0;
  const measure = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      const body = document.body;
      if (!body) return;
      const height = Math.ceil(Math.max(body.scrollHeight, body.getBoundingClientRect().height));
      if (height !== previous) { previous = height; send({height}); }
    });
  };
  ${preview ? "" : `addEventListener("error", event => send({error:String(event.message || "The visualization could not run.").slice(0,240)}));
  addEventListener("unhandledrejection", () => send({error:"The visualization encountered an error."}));
  addEventListener("securitypolicyviolation", () => send({error:"The visualization requested an unavailable resource."}));`}
  addEventListener("message", event => {
    if (event.source !== parent) return;
    if (event.data?.type === "delphi-artifact-measure") { previous = 0; measure(); }
    if (event.data?.type === "delphi-artifact-theme") {
      if (event.data.theme === "light" || event.data.theme === "dark") document.documentElement.dataset.theme = event.data.theme;
      const values = event.data.values;
      if (values && typeof values === "object") for (const key of themeProperties) {
        const value = values[key];
        if (typeof value === "string" && value.length < 500 && !/[{};<>]/.test(value)) document.documentElement.style.setProperty(key, value);
      }
    }
  });
  addEventListener("resize", measure);
  addEventListener("DOMContentLoaded", () => {
    new NativeResizeObserver(measure).observe(document.body);
    new MutationObserver(measure).observe(document.body, {subtree:true,childList:true,attributes:true,characterData:true});
    document.fonts.ready.then(measure);
    send({ready:true});
    measure();
  }, {once:true});
  ${kit ? artifactKitBootstrap() : ""}
  ${preview ? "" : artifactMotionBootstrap()}
})();`;
}
