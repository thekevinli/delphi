/**
 * The browser the backend borrows: a page of the Chromium inside Electron.
 *
 * Page capture, document previews and artifact validation each need a real
 * browser engine, and the backend used to launch whichever Chrome was
 * installed — which put a second Chrome in the Dock on every capture and every
 * draft, and left the features off on a Mac without one. Here the backend
 * instead asks this process for one disposable page per job, over a Unix
 * socket only it is told about (`BROWSER_HOST_SOCKET`, with a per-launch
 * token), and drives that page over DevTools exactly as it drove Chrome
 * (`core/delphi_core/browser_host.py` holds the wire format). The backend keeps
 * every policy it already tests: what to load, when a page is built, the
 * validating proxy a capture goes through, and every check run on a draft.
 * This process owns only what Chrome's process tree used to: where the page
 * lives, how long, how much memory, and that nothing of it survives the job.
 *
 * A job page is an offscreen window. A merely hidden one is not enough: its
 * renderer stops producing frames, so `requestAnimationFrame` never fires,
 * a draft's entrance animations never settle and a screenshot takes seconds.
 * Offscreen rendering paints at a steady rate without ever showing a window,
 * taking focus or adding a Dock item. Each page lives in an in-memory session
 * of its own slot, never the reader's, so it carries none of the reader's
 * cookies or storage and its renderer processes are never shared with the
 * reader's; a slot is cleared before its next job, because Electron cannot
 * free a session once made.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { app, BrowserWindow, session as sessions, type Session, type WebContents } from "electron";
import { protectArtifactFrames } from "./artifacts/navigation.ts";
import { lineReader, parseOpening, permitted, Slots, SLOTS, type Opening } from "./browser-jobs.ts";

/** A port nothing listens on: an artifact page reaches no network through it. */
const DEAD_PROXY = "http://127.0.0.1:9";
/**
 * `disableDialogs` answers alert, confirm and prompt, but print opens its
 * panel on screen and blocks the page until someone closes it.
 */
const NO_PRINT = "window.print = () => {};";


export interface BrowserHost {
  readonly socket: string;
  readonly token: string;
  /** False for `unavailableBrowserHost`: no page will ever be lent. */
  readonly available: boolean;
  close(): Promise<void>;
}

interface Job { end(reason: string, message: string): void }

/** Owned for the app's life: backend restarts reconnect to the same host. */
export async function startBrowserHost(log: (message: string) => void = console.error): Promise<BrowserHost> {
  const token = randomBytes(32).toString("hex");
  const expected = Buffer.from(token);
  // A directory only this user can enter, under the per-user temporary
  // directory: short enough for a socket path, and gone with the app.
  const directory = mkdtempSync(join(app.getPath("temp"), "delphi-browser-"));
  const path = join(directory, "host.sock");
  const slots = new Slots(SLOTS);
  const prepared = new Set<number>();
  const jobs = new Set<Job>();
  /** The webContents ids of job pages, for the app-wide events that name one. */
  const pages = new Set<number>();
  // A site asking for a client certificate gets none: Electron would otherwise
  // present the first match from the user's Keychain, for a page they never saw.
  app.on("select-client-certificate", (event, contents, _url, _list, callback) => {
    if (!contents || !pages.has(contents.id)) return;
    event.preventDefault();
    callback();
  });

  const slotSession = (slot: number): Session => {
    // In memory: nothing a job leaves reaches the disk, and nothing of the
    // reader's reaches the job.
    const ses = sessions.fromPartition(`delphi-browser-${slot}`);
    if (!prepared.has(slot)) {
      prepared.add(slot);
      ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      ses.setPermissionCheckHandler(() => false);
      ses.setDevicePermissionHandler(() => false);
      ses.on("will-download", (event, item) => { event.preventDefault(); item.cancel(); });
      ses.setSpellCheckerEnabled(false);
      // A preview is a prepared file:// document, and Electron lets a file://
      // page read any other file. The document itself is the one file a job
      // loads; whatever it then asks of file:// is refused.
      ses.webRequest.onBeforeRequest({ urls: ["file://*/*"] }, (details, callback) => {
        callback({ cancel: details.resourceType !== "mainFrame" });
      });
    }
    return ses;
  };

  /** Every connection, a job still queued for a page included, for `close`. */
  const connections = new Set<Socket>();

  const serve = (socket: Socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
    const started = Date.now();
    const cancel = new AbortController();
    let opening: Opening | undefined;
    let ended = false;
    let finish: ((reason: string, message: string) => void) | undefined;
    const write = (message: unknown) => { if (!socket.destroyed) socket.write(JSON.stringify(message) + "\n"); };
    let relay: ((line: string) => void) | undefined;
    // One opening per connection: whatever follows a refusal is ignored.
    const refuse = (message: string) => { relay = () => {}; write({ error: message }); socket.end(); };
    const lines = lineReader(line => {
      if (relay) { relay(line); return; }
      if (opening) return; // still being set up; the backend waits for `opened`
      let request: { token?: unknown; open?: unknown };
      try { request = JSON.parse(line); } catch { refuse("malformed opening"); return; }
      const given = Buffer.from(typeof request.token === "string" ? request.token : "");
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) { refuse("not authorised"); return; }
      try { opening = parseOpening(request.open); } catch (error) { refuse((error as Error).message); return; }
      void open(opening);
    });
    socket.on("data", chunk => {
      try { lines(chunk); } catch { socket.destroy(); }
    });
    socket.on("error", () => {});
    socket.on("close", () => { cancel.abort(); finish?.("closed", ""); });
    // The opening line is the first thing a client says; a silent one is dropped.
    const greeting = setTimeout(() => { if (!opening) socket.destroy(); }, 5_000);

    const open = async (request: Opening) => {
      clearTimeout(greeting);
      // Waiting for a slot spends the job's own deadline, never more.
      const remaining = () => request.deadlineSeconds * 1000 - (Date.now() - started);
      const queued = setTimeout(() => cancel.abort(), Math.max(0, remaining()));
      let slot: number;
      try { slot = await slots.acquire(cancel.signal); }
      catch { clearTimeout(queued); refuse("no browser page became free before the job's deadline"); return; }
      finally { clearTimeout(queued); }
      if (socket.destroyed) { slots.release(slot); return; }

      const ses = slotSession(slot);
      let window: BrowserWindow | undefined;
      let contents: WebContents | undefined;
      let peak = 0;
      let deadline: NodeJS.Timeout | undefined;
      let sampler: NodeJS.Timeout | undefined;
      const job: Job = {
        end: (reason, message) => {
          if (ended) return;
          ended = true;
          if (reason !== "closed") {
            // Said before the stream ends, so the backend reports the cause.
            write({ method: "Host.ended", params: { reason, message, peakBytes: peak } });
            if (reason !== "shutdown") log(`[delphi] browser job ended: ${message || reason}`);
          }
          socket.end();
          clearTimeout(deadline);
          clearTimeout(sampler);
          jobs.delete(job);
          if (contents) pages.delete(contents.id);
          void (async () => {
            try {
              if (contents && !contents.isDestroyed()) {
                if (contents.debugger.isAttached()) contents.debugger.detach();
                if (reason === "memory_limit") contents.forcefullyCrashRenderer();
              }
              if (window && !window.isDestroyed()) window.destroy();
              // The next job in this slot starts from nothing this one left.
              await ses.clearStorageData();
              await ses.clearCache();
              await ses.clearAuthCache();
              await ses.closeAllConnections();
              await ses.clearHostResolverCache();
            } catch (error) {
              log(`[delphi] a browser job's page could not be fully cleared: ${(error as Error).message}`);
            } finally { slots.release(slot); }
          })();
        },
      };
      jobs.add(job);
      finish = job.end;
      deadline = setTimeout(() => job.end("deadline", `The browser job exceeded its ${request.deadlineSeconds}s deadline.`), Math.max(0, remaining()));

      try {
        await ses.setProxy({ proxyRules: request.purpose === "page" ? `http://${request.proxy}` : DEAD_PROXY, proxyBypassRules: "<-loopback>" });
        ses.setUserAgent(request.userAgent ?? app.userAgentFallback);
        if (ended) return;
        window = new BrowserWindow({
          show: false, focusable: false, skipTaskbar: true, width: request.width, height: request.height,
          useContentSize: true, enableLargerThanScreen: true, paintWhenInitiallyHidden: true,
          webPreferences: {
            session: ses, offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false,
            webSecurity: true, backgroundThrottling: false, spellcheck: false,
            autoplayPolicy: "user-gesture-required",
            // An alert would show this offscreen window, and hold the job
            // until someone dismissed it.
            disableDialogs: true,
            // What `--disable-blink-features=AutomationControlled` does for a
            // launched capture: a page sees a browser, not a robot.
            disableBlinkFeatures: "AutomationControlled",
          },
        });
        contents = window.webContents;
        pages.add(contents.id);
        contents.setAudioMuted(true);
        contents.setWindowOpenHandler(() => ({ action: "deny" }));
        if (request.userAgent) contents.setUserAgent(request.userAgent);
        if (request.purpose === "artifact") {
          // The reader's own navigation guard and WebRTC policy, so a draft is
          // held as the published artifact it becomes; behind a dead proxy.
          protectArtifactFrames(contents, { endNestedFrames: false });
        } else {
          contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
          // A captured page may navigate itself, but only to the web.
          contents.on("will-frame-navigate", event => {
            if (!/^(https?|about|data|blob):/i.test(event.url) && !(event.isMainFrame && /^file:/i.test(event.url) && !event.initiator)) event.preventDefault();
          });
        }
        const page = contents;
        page.on("render-process-gone", (_event, details) => job.end("renderer_gone", `The page's renderer ended (${details.reason}).`));
        page.debugger.on("detach", (_event, reason) => job.end("detached", `DevTools detached (${reason}).`));
        page.debugger.attach("1.3");
        await page.loadURL("about:blank");
        await page.debugger.sendCommand("Emulation.setDeviceMetricsOverride", { width: request.width, height: request.height, deviceScaleFactor: 1, mobile: false });
        // The stub runs only while Page is enabled, and every job enables it
        // first anyway. Events are relayed from here on, so the backend hears
        // nothing of this setup.
        await page.debugger.sendCommand("Page.enable");
        await page.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: NO_PRINT });
        page.debugger.on("message", (_event, method, params, sessionId) => {
          write(sessionId ? { method, params, sessionId } : { method, params });
        });
        if (ended) return;

        // The page's own renderers only: its main frame's and any frame moved
        // into a process of its own. The GPU and network processes are shared.
        const sample = () => {
          if (ended || page.isDestroyed()) return;
          try {
            const pids = new Set(page.mainFrame.framesInSubtree.map(frame => frame.osProcessId).filter(pid => pid > 0));
            const bytes = app.getAppMetrics().filter(metric => pids.has(metric.pid)).reduce((total, metric) => total + metric.memory.workingSetSize * 1024, 0);
            peak = Math.max(peak, bytes);
            if (request.memoryLimitBytes && bytes > request.memoryLimitBytes) {
              job.end("memory_limit", `Renderer exceeded its ${Math.round(request.memoryLimitBytes / 2 ** 20)} MiB memory limit.`);
              return;
            }
          } catch (error) {
            // A frame going away mid-read; the next sample sees what is left.
            if (!ended) log(`[delphi] could not measure a browser job's memory: ${(error as Error).message}`);
          }
          sampler = setTimeout(sample, 500);
        };
        sample();

        relay = line => {
          let message: { id?: unknown; method?: unknown; params?: unknown; sessionId?: unknown };
          try { message = JSON.parse(line); } catch { job.end("protocol", "A malformed DevTools message."); return; }
          const { id, method, params, sessionId } = message;
          if (typeof id !== "number" || typeof method !== "string") { job.end("protocol", "A DevTools message without an id or method."); return; }
          if (method === "Host.usage") { write({ id, result: { peakBytes: peak } }); return; }
          if (!permitted(method)) { write({ id, error: { message: `${method} is not available to a browser job.` } }); return; }
          page.debugger.sendCommand(method, (params && typeof params === "object" ? params : {}) as Record<string, unknown>, typeof sessionId === "string" && sessionId ? sessionId : undefined)
            .then(result => write({ id, result }), (error: Error) => write({ id, error: { message: String(error?.message ?? error).slice(0, 400) } }));
        };
        write({ opened: { engine: `Chromium/${process.versions.chrome}`, electron: process.versions.electron } });
      } catch (error) {
        job.end("failed", `The browser page could not be opened: ${(error as Error).message}`);
      }
    };
  };

  const server = createServer(serve);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => { server.removeListener("error", reject); resolve(); });
  });
  await chmod(path, 0o600);
  return {
    socket: path,
    token,
    available: true,
    close: async () => {
      for (const job of [...jobs]) job.end("shutdown", "Delphi is quitting.");
      // A job still waiting for a page has no page to end; until its
      // connection goes, the server never finishes closing.
      for (const socket of [...connections]) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
