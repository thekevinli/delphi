import type { WebContents } from "electron";

/**
 * Inline visualizations may run scripts, but must stay inside their srcdoc.
 * A CSP blocks resource loads, not a document navigating its own frame. Keep
 * that last boundary in Electron, outside the generated document's control.
 */
interface Frame {
  readonly name: string;
  readonly url: string;
  readonly parent: Frame | null;
  readonly frameTreeNodeId?: number;
}

/** The reader names every artifact frame, preview or interactive, with this. */
const ARTIFACT_FRAME_PREFIX = "delphi-artifact-";

function isArtifactFrame(frame: Frame | null | undefined): boolean {
  for (let current = frame; current; current = current.parent) {
    // window.name is writable by the generated script. The current document
    // URL still identifies a srcdoc after its name has been changed.
    if (current.name.startsWith(ARTIFACT_FRAME_PREFIX) || /^about:srcdoc(?:#|$)/.test(current.url)) return true;
  }
  return false;
}

/** A frame keeps its identity even after a script renames it or opens blank. */
export function artifactNavigationGuard() {
  const owned = new Set<number>();
  const observe = (frame: Frame | null | undefined): boolean => {
    for (let current = frame; current; current = current.parent) {
      if (current.frameTreeNodeId !== undefined && owned.has(current.frameTreeNodeId)) return true;
      if (isArtifactFrame(current)) {
        if (current.frameTreeNodeId !== undefined) owned.add(current.frameTreeNodeId);
        return true;
      }
    }
    return false;
  };
  return {
    observe,
    blocks(event: { url: string; frame: Frame | null; initiator?: Frame | null }): boolean {
      // An artifact starts no navigation, and nothing inside one navigates.
      if (observe(event.initiator)) return true;
      if (!observe(event.frame)) return false;
      // Only the reader replacing an artifact's own srcdoc, as Reset does.
      return event.url !== "about:srcdoc" || observe(event.frame?.parent);
    },
  };
}

interface CreatedFrame extends Frame {
  readonly parent: CreatedFrame | null;
  readonly frameTreeNodeId: number;
  readonly osProcessId: number;
}

/**
 * Ends an artifact the moment it creates a frame of its own. A nested document
 * is a fresh realm the artifact runtime never touched, with WebRTC restored,
 * and Electron reports no navigation for srcdoc, so no callback can refuse its
 * commit. The child commits only in the artifact's own process, and
 * `frame-created` runs before the browser sees that navigation: killing the
 * process there means the nested document never runs. Chromium isolates
 * sandboxed frames, so this leaves the reader running; the validator already
 * refuses nested frames, so a reviewed artifact never reaches this.
 */
export function artifactFrameWatch(kill: (pid: number) => void, log: (message: string) => void) {
  const artifacts = new Set<number>();
  return (frame: CreatedFrame) => {
    const parent = frame.parent;
    if (!parent) return;
    // Identity is fixed as the reader creates the frame, before any script in
    // it runs; a page inside the web frame cannot mint one.
    if (!parent.parent && frame.name.startsWith(ARTIFACT_FRAME_PREFIX)) {
      artifacts.add(frame.frameTreeNodeId);
    } else if (artifacts.has(parent.frameTreeNodeId)) {
      const pid = parent.osProcessId;
      // Electron reports 0 for a frame with no process yet; signalling 0 would
      // reach Delphi's own process group.
      if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) {
        log(`[delphi] an inline visualization created a nested frame, but its renderer process (${pid}) cannot be ended`);
        return;
      }
      log(`[delphi] an inline visualization created a nested frame; ending its renderer process ${pid}`);
      kill(pid);
    }
  };
}

/**
 * Everything the reader window needs; applied before it loads anything.
 *
 * The validator's page (`browser-host.ts`) keeps the guard but not the frame
 * watch: it has no network to reach, and ending its renderer would tell the
 * model only that its draft "couldn't run", where the validator reports the
 * nested frame itself and the draft is refused either way.
 */
export function protectArtifactFrames(contents: WebContents, { endNestedFrames = true } = {}): void {
  // No reader surface uses WebRTC. Without a proxy this still permits TCP
  // relays, so it is defence in depth beside the frame watch, not the boundary.
  contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  const guard = artifactNavigationGuard();
  const watch = artifactFrameWatch(pid => process.kill(pid, "SIGKILL"), message => console.error(message));
  contents.on("frame-created", (_event, { frame }) => {
    if (!frame) return;
    guard.observe(frame);
    if (!endNestedFrames) return;
    try {
      watch(frame);
    } catch (error) {
      console.error("[delphi] could not end a visualization's renderer process:", error);
    }
  });
  contents.on("will-frame-navigate", event => {
    if (guard.blocks(event)) event.preventDefault();
  });
}
