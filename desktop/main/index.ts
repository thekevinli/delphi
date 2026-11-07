/**
 * Delphi for macOS: app lifecycle, the window, and the order things start in.
 *
 * The renderer loads delphi's real build output over HTTP from a loopback
 * server this process runs (`worker-host.ts`), so the page is the same page the
 * web app serves — same origin model, same cookies, same fetches. That is why
 * there is no preload on the main window and no IPC surface behind it.
 */
import "./profile-override.ts";
import { app, BrowserWindow, clipboard, dialog, Menu, safeStorage, session, shell } from "electron";
import { appendFileSync, existsSync, renameSync, rmSync, statSync } from "node:fs";
import { ClaudeConnection, CLAUDE_INSTALL_URL } from "./inference/claude-runtime.ts";
import { ClaudeTransport } from "./inference/claude-transport.ts";
import { AnthropicTransport, CLAUDE_API_MAX_INLINE, verifyClaudeKey } from "./inference/anthropic-api.ts";
import { SubscriptionLimits } from "./inference/limits.ts";
import { AiServiceController, type AiService } from "./inference/service.ts";
import { desktopConnectionHandler } from "./inference/connection-handler.ts";
import { isConnectionId, isSubscription, type SubscriptionId } from "../frontend/app/lib/ai-connection.ts";
import { SubscriptionConnection } from "./inference/connection.ts";
import { oauthStore } from "./inference/oauth-store.ts";
import { startInferenceBridge, type BridgeLogEntry, type InferenceBridge } from "./inference/bridge.ts";
import { createHash } from "node:crypto";
import { PlanStore } from "./research/store.ts";
import { startMcpSocket, pairPlans } from "./research/mcp.ts";
import { LocalPlans } from "./research/plans.ts";
import { chatPlansHandler } from "./research/chat-plans.ts";
import { installLauncher, launcherInstructions, mcpSetup } from "./research/launcher.ts";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { sameOrigin, parseSetup } from "./browser-policy.ts";
import type { Server } from "node:http";

import { startWorkerHost, type HostActivity } from "./worker-host.ts";
import { startBackend, KEY_CHECK, type ConnectionId } from "./backend.ts";
import { protectArtifactFrames } from "./artifacts/navigation.ts";
import { choosePorts, UI_HOST, API_HOST } from "./ports.ts";
import { ensureSession } from "./session.ts";
import { startBrowserHost, type BrowserHost } from "./browser-host.ts";
import { unavailableBrowserHost } from "./browser-jobs.ts";
import { collectDiagnostics, DIAGNOSTICS_COPIED } from "./diagnostics.ts";
import { bugReportUrl, reportBug } from "./report-bug.ts";
import { fullScreenScript } from "./fullscreen.ts";
import { pageZoomDirection, pageZoomScript } from "./page-zoom.ts";
import { readerFindHandler } from "./reader-find.ts";
import { faviconHandler } from "./favicons.ts";
import {
  appDir, accountPassword, dataDir, faviconsDir, logsDir,
  readConfig, sessionSecret, writeConfig, localUsername, type StoredConfig,
} from "./config.ts";

/** Packaged: files live in Resources. Development: the build directory. */
const resource = (...parts: string[]): string =>
  app.isPackaged
    ? join(process.resourcesPath, ...parts)
    : join(app.getAppPath(), ".delphi-build", ...parts);

const PYTHON = () => resource("python", "bin", "python3");
const DIST = () => resource("dist");

let phase: "starting" | "setup" | "launching" | "ready" | "stopping" = "starting";
let readerOrigin: string | undefined;
let prepareMcp: (() => Promise<string>) | undefined;
let startupWindow: BrowserWindow | undefined;
const shutdown = new AbortController();
let host: Server | undefined;
let ai: AiServiceController | undefined;
let plans: LocalPlans | undefined;
let researchSocket: Awaited<ReturnType<typeof startMcpSocket>> | undefined;
let mainWindow: BrowserWindow | undefined;
let onboardingWindow: BrowserWindow | undefined;
let subscription: SubscriptionConnection | undefined;
let claude: ClaudeConnection | undefined;
/** What the AI side is started with, fixed for the life of the window. */
let services: { apiPort: number; uiOrigin: string; sessionSecret: string; browserHost: BrowserHost } | undefined;
/** Requests in flight through the host; a switch waits for foreground ones only. */
const activity: HostActivity = { inflight: new Map(), paused: false };
function subscriptionConnection(): SubscriptionConnection {
  subscription ??= new SubscriptionConnection(oauthStore(join(appDir(), "inference"), safeStorage), async url => { await shell.openExternal(url); });
  return subscription;
}

function claudeConnection(): ClaudeConnection {
  claude ??= new ClaudeConnection();
  return claude;
}

function planConnection(id: SubscriptionId): SubscriptionConnection | ClaudeConnection {
  if (id === "chatgpt-oauth") return subscriptionConnection();
  return claudeConnection();
}


/** Request metadata only — route, model, sizes, token counts — never content. */
function inferenceLog(path: string): (entry: BridgeLogEntry) => void {
  return entry => {
    try { if (statSync(path).size > 5 * 1024 * 1024) renameSync(path, `${path}.1`); } catch { /* First entry. */ }
    appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", { mode: 0o600 });
  };
}

/*
 * The two windows that are ours rather than the application's — the splash and
 * the first-run prompt — are copied beside the app when packaged and live in the
 * checkout otherwise.
 */
function onboardingFile(name: string): string {
  const root = app.isPackaged ? process.resourcesPath : app.getAppPath();
  return join(root, "onboarding", name);
}

/*
 * One instance only. Two would race a single DATA_DIR — the local storage layer
 * serialises writes with in-process locks and takes no file lock, so a second
 * process is not merely wasteful, it can interleave writes to one meta.json.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("activate", () => {
    if (phase === "ready" && readerOrigin && !mainWindow) openReader(readerOrigin);
    (mainWindow ?? onboardingWindow ?? startupWindow)?.show();
  });
  app.on("second-instance", () => {
    if (phase === "ready" && readerOrigin && !mainWindow) openReader(readerOrigin);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(main).catch(fail);
}

async function main(): Promise<void> {
  /*
   * Packaged, the name and icon come from Info.plist and the .icns that
   * electron-builder stamps in. Unpackaged they do not, so a developer run says
   * "Electron" in the menu bar and shows Electron's icon in the Dock — which
   * makes every screenshot of a work-in-progress look like the wrong app.
   */
  if (!app.isPackaged) {
    // Cosmetic, and therefore wrapped: an app that refuses to start because it
    // could not set its Dock icon is a worse app than one with the wrong icon.
    // (This is not hypothetical — it is what happened when it was written bare.)
    try {
      app.setName("Delphi");
      // A PNG, not the .icns: nativeImage refuses the iconutil archive here,
      // and electron-builder reads the .icns itself when packaging, so this
      // path only has to satisfy the Dock during development.
      const icon = join(app.getAppPath(), ".delphi-build", "icon", "Delphi.iconset", "icon_512x512.png");
      if (existsSync(icon)) app.dock?.setIcon(icon);
    } catch (error) {
      console.error("[delphi] could not set the development Dock icon:", error);
    }
  }

  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  // Downloads are a real feature here: the account export and "Download PDF"
  // are plain <a href> links, which in a browser would just work. In Electron
  // they need somewhere to go.
  session.defaultSession.on("will-download", (_event, item) => {
    item.setSaveDialogOptions({ defaultPath: join(app.getPath("downloads"), item.getFilename()) });
  });
  startupWindow = new BrowserWindow({ width: 560, height: 400, resizable: false, title: "", titleBarStyle: "hiddenInset", backgroundColor: "#ffffff", webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  startupWindow.on("closed", () => { startupWindow = undefined; if (phase === "starting" || phase === "launching") app.quit(); });
  // A data: URL is decoded as US-ASCII, which turned the ellipsis into mojibake;
  // the splash is a real file so it has a charset, the palette and the mark.
  await startupWindow.loadFile(onboardingFile("starting.html"));
  buildMenu();
  app.setAboutPanelOptions({ applicationName: "Delphi", applicationVersion: app.getVersion() });

  for (const [what, path] of [["Python runtime", PYTHON()], ["frontend build", DIST()]] as const) {
    if (!existsSync(path)) throw new Error(`The ${what} is missing at ${path}. Run npm run build.`);
  }
  shutdown.signal.throwIfAborted();
  let config = readConfig();
  let apiKey = savedKey(config, config.connectionId);
  if (!apiKey && (!config.connectionId || !isSubscription(config.connectionId))) {
    const setup = await askForSetup(false, config.connectionId);
    if (!setup) { app.quit(); return; }
    config = setup.config;
    apiKey = setup.apiKey;
  }

  await launch(config, apiKey);
}

async function launch(initial: StoredConfig, apiKey: string): Promise<void> {
  phase = "launching";
  shutdown.signal.throwIfAborted();
  let config = initial;
  ({ config } = sessionSecret(config));
  const password = accountPassword(config);
  config = localUsername(password.config).config;

  const { uiPort, apiPort } = await choosePorts();
  const uiOrigin = `http://${UI_HOST}:${uiPort}`;

  let browserHost: BrowserHost;
  // Capture, previews and diagrams need it; reading and chat do not, so a
  // host that cannot start turns those off rather than stopping the app.
  try { browserHost = await startBrowserHost(); }
  catch (error) {
    console.error("[delphi] the browser host could not start; page capture, previews and diagrams are off:", error);
    browserHost = unavailableBrowserHost();
  }
  services = { apiPort, uiOrigin, sessionSecret: config.sessionSecret!, browserHost };
  // Earlier builds kept a second copy of every PDF sent over ChatGPT here. The
  // bridge now receives documents inline, so the copies serve nothing.
  try { rmSync(join(appDir(), "inference", "files"), { recursive: true, force: true }); }
  catch (error) { console.error("Could not remove old inference file copies:", error); }
  ai = new AiServiceController({ activity, start: createAi, save: writeConfig, changed: () => mainWindow?.webContents.reload() });
  await ai.start(config, apiKey);
  // Fixed for the window's life: a connection switch restarts the backend on
  // this same port, so nothing that captured the address has to be told.
  const apiUrl = `http://${API_HOST}:${apiPort}`;

  shutdown.signal.throwIfAborted();
  const researchDir = join(appDir(), "research");
  plans = new LocalPlans(new PlanStore(researchDir), join(researchDir, "plans"), Number(process.env.DELPHI_PLAN_PORT ?? 8730));
  await plans.start();
  const socketPath = `/tmp/delphi-research-${process.getuid?.() ?? 0}-${createHash("sha256").update(appDir()).digest("hex").slice(0, 12)}.sock`;
  researchSocket = await startMcpSocket(plans, socketPath);
  const authenticate = async (request: Request) => {
    const cookie = request.headers.get("cookie");
    if (!cookie) return false;
    const response = await fetch(`${apiUrl}/api/auth/me`, { headers: { cookie }, signal: AbortSignal.timeout(5000) });
    await response.body?.cancel(); return response.ok;
  };
  const mcpToken = join(researchDir, "mcp-token");
  const pair = () => installLauncher(app.getPath("home"), resource("native", "delphi-mcp"), socketPath, pairPlans(plans!, mcpToken), mcpToken);
  if (plans.store.objects("grants").some(grant => grant.kind === "plans" && !grant.revoked)) {
    // Refresh moved app paths, and repair a missing token, without making an
    // optional launcher block startup.
    try { pair(); } catch (error) { console.error("MCP launcher refresh failed:", error); }
  }
  prepareMcp = async () => { pair(); return launcherInstructions; };
  const chatHandler = chatPlansHandler({ plans, python: PYTHON(), backendUrl: apiUrl, origin: uiOrigin, authenticate,
    installation: prepareMcp,
  });
  const findHandler = readerFindHandler({ origin: uiOrigin, authenticate, run: async (name, script) => {
    const frame = mainWindow?.webContents.mainFrame.frames.find(frame => frame.name === name);
    if (!frame || !sameOrigin(frame.url, apiUrl)) throw new Error("Reader frame unavailable");
    return frame.executeJavaScript(script);
  } });
  const connectionHandler = desktopConnectionHandler({
    origin: uiOrigin, authenticate, read: readConfig, busy: aiBusy, change: switchConnection,
    manage: target => { void openConnectionWindow(target); },
    statuses: async () => {
      const [chatgpt, claude] = await Promise.all([planConnection("chatgpt-oauth").status({ refreshUsage: true }), planConnection("claude-subscription").status({ refreshUsage: true })]);
      return { chatgpt, claude };
    },
  });
  const iconHandler = faviconHandler({ dir: faviconsDir(), authenticate });
  host = await startWorkerHost({
    distDir: DIST(),
    activity,
    desktopHandler: async request => await connectionHandler(request) ?? await iconHandler(request) ?? await findHandler(request) ?? await chatHandler(request),
    backendUrl: apiUrl,
    uiHost: UI_HOST,
    uiPort,
  });

  // The window must open already signed in; the reader never sees /login.
  await ensureSession(uiOrigin, password.password);

  shutdown.signal.throwIfAborted();
  phase = "ready";
  readerOrigin = uiOrigin;
  startupWindow?.close();
  onboardingWindow?.close();
  onboardingWindow = undefined;
  openReader(uiOrigin);
}

/** Every provider serves the same backend contract; failed starts own cleanup. */
async function createAi(config: StoredConfig, apiKey: string): Promise<AiService> {
  if (!services) throw new Error("Delphi has not finished starting.");
  let bridge: InferenceBridge | undefined;
  try {
    const log = () => inferenceLog(join(logsDir(), "inference.log"));
    if (config.connectionId === "chatgpt-oauth") {
      const connection = subscriptionConnection();
      bridge = await startInferenceBridge({ upstream: connection.oauth, limits: connection.limits, log: log() });
    } else if (config.connectionId === "claude-subscription") {
      const claude = claudeConnection();
      bridge = await startInferenceBridge({ upstream: new ClaudeTransport(claude), limits: claude.limits, provider: "Claude", prime: false, log: log() });
    } else if (config.connectionId === "claude-api") {
      // The backend speaks only the Responses API, so a Claude key is served
      // like a plan: through the bridge, which hands it the request unshaped.
      // Anthropic reports no plan limits; the key's own rate limits arrive as 429s.
      bridge = await startInferenceBridge({ upstream: new AnthropicTransport(apiKey), limits: new SubscriptionLimits(Date.now, "Claude"),
        provider: "Claude", prime: false, maxInline: CLAUDE_API_MAX_INLINE, shape: payload => payload, log: log() });
    }
    // Start even when a saved sign-in has expired: the library remains usable.
    const backend = await startBackend({
      signal: shutdown.signal, python: PYTHON(), dataDir: dataDir(), logsDir: logsDir(),
      apiHost: API_HOST, apiPort: services.apiPort, uiOrigin: services.uiOrigin,
      // A bridge serves with its own per-launch token; the key stays in the shell.
      sessionSecret: services.sessionSecret, apiKey: bridge ? "" : apiKey, apiBaseUrl: config.apiBaseUrl,
      connection: config.connectionId, inference: bridge ? { url: bridge.url, token: bridge.token } : undefined,
      browserHost: { socket: services.browserHost.socket, token: services.browserHost.token },
      artifactRendererPath: services.browserHost.available ? resource("artifact-validator") : undefined,
    });
    return { backend, bridge };
  } catch (error) { await bridge?.stop(); throw error; }
}

function aiBusy(): string | undefined { return ai?.busy(); }

async function applyConnection(config: StoredConfig, apiKey: string): Promise<void> {
  if (phase !== "ready" || !ai) throw new Error("Delphi is still starting.");
  try { await ai.change(config, apiKey); }
  catch (error) { if (!ai.backend) fail(error); throw error; }
}

/** The key a connection is served with: a plan has none, and an unversioned
 * profile's key is OpenAI's. Each provider keeps its own. */
function savedKey(config: StoredConfig, id: ConnectionId | undefined): string {
  if (id && isSubscription(id)) return "";
  return (id === "claude-api" ? config.claudeApiKey : config.apiKey) ?? "";
}

/** Switching retains each provider's credentials and the entire local profile. */
async function switchConnection(target: ConnectionId): Promise<void> {
  const busy = aiBusy();
  if (busy) throw new Error(busy);
  const stored = readConfig();
  if (stored.connectionId === target) return;
  let apiKey = "";
  if (!isSubscription(target)) {
    apiKey = savedKey(stored, target);
    if (!apiKey) throw Object.assign(new Error(`Add ${target === "claude-api" ? "a Claude" : "an OpenAI"} API key first.`), { setup: true });
  } else {
    const status = await planConnection(target).status();
    if (!status.connected) throw Object.assign(new Error(status.message ?? "Sign in before switching."), { setup: true });
  }
  await applyConnection({ ...stored, version: 2, connectionId: target }, apiKey);
}

function closeConnectionWindow(): void { onboardingWindow?.close(); }

/** The AI Connection window, opened from the menu or from Settings. */
async function openConnectionWindow(preferred?: ConnectionId): Promise<void> {
  if (onboardingWindow) { onboardingWindow.show(); return; }
  if (phase !== "ready") return;
  try {
    const next = await askForSetup(true, preferred);
    if (!next) return;
    try { await applyConnection(next.config, next.apiKey); }
    finally { closeConnectionWindow(); }
  } catch (error) { dialog.showErrorBox("AI connection could not be changed", error instanceof Error ? error.message : String(error)); }
}

function openReader(uiOrigin: string): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: "#f5f3f1",
    // The window chrome carries no text. A title would be drawn by macOS in the
    // auto-hiding full-screen title bar, where the page cannot paint over it,
    // and a browser-style "Dashboard · Delphi" there reads as a web page
    // rather than an app.
    title: "",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 18 },
    webPreferences: {
      // No preload and no node integration: this window runs the local desktop
      // frontend, which has no need for either and should not be handed them.
      contextIsolation: true,
      nodeIntegration: false,
      // `webSecurity` stays on. The sandboxed web frame's isolation is the
      // ordinary same-origin policy, and turning this off would dissolve it.
      webSecurity: true,
      spellcheck: true,
    },
  });

  // The frontend is also a web app, so its documents set a <title>. Electron
  // would adopt each one as the window title; the window keeps its own (empty).
  mainWindow.on("page-title-updated", event => event.preventDefault());
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => { mainWindow = undefined; });

  const contents = mainWindow.webContents;
  protectArtifactFrames(contents);

  /*
   * A stray drop, or a link in a proxied page, must not navigate the window off
   * the app — there is no address bar to get back with. Anything that is not
   * our own origin opens in the real browser instead.
   */
  contents.on("will-navigate", (event, url) => {
    if (!sameOrigin(url, uiOrigin)) {
      event.preventDefault();
      openExternally(url);
    }
  });
  contents.on("will-redirect", (event, url) => { if (!sameOrigin(url, uiOrigin)) event.preventDefault(); });
  contents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: "deny" };
  });

  /*
   * Chromium's own zoom would fight the reader's per-document PDF zoom, and the
   * two are different gestures: one re-lays-out the page, the other is the
   * document's own scale.
   */
  contents.on("did-finish-load", () => { contents.setZoomFactor(1); });
  contents.setVisualZoomLevelLimits(1, 1);
  contents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && input.key === "Escape") {
      void contents.executeJavaScript('window.dispatchEvent(new Event("delphi-reader-find-close"))').catch(console.error);
    }
    if (input.type === "keyDown" && input.meta && !input.control && !input.alt && input.key.toLowerCase() === "f") {
      event.preventDefault();
      void contents.executeJavaScript('window.dispatchEvent(new Event("delphi-reader-find"))').catch(console.error);
      return;
    }
    const direction = pageZoomDirection(input);
    if (direction === null) return;
    event.preventDefault();
    contents.executeJavaScript(pageZoomScript(direction)).catch((error: unknown) => {
      console.error("[delphi] could not change webpage zoom:", error);
    });
  });

  // The header drops the room it keeps for the traffic lights while they are
  // hidden. Re-marked on every load, because a reload starts a clean document.
  const reader = mainWindow;
  const markFullScreen = () => {
    if (reader.isDestroyed()) return;
    contents.executeJavaScript(fullScreenScript(reader.isFullScreen())).catch((error: unknown) => {
      console.error("[delphi] could not mark the full-screen state:", error);
    });
  };
  reader.on("enter-full-screen", markFullScreen);
  reader.on("leave-full-screen", markFullScreen);
  contents.on("dom-ready", markFullScreen);

  mainWindow.loadURL(uiOrigin);
}

function openExternally(url: string): void {
  // Only real web links. A `file:`, `javascript:` or custom scheme handed to
  // the OS is a way to run something the page chose.
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
}

/**
 * The standard menu.
 *
 * Without one, ⌘C/⌘V/⌘A/⌘Z are dead in the renderer — the classic "the app is
 * broken" first-run report. ⌘F is left to the page, which has its own find.
 */
function buildMenu(): void {
  // Copy Diagnostics and Report a Bug… put the same block on the clipboard.
  const diagnostics = () => collectDiagnostics({
    appVersion: app.getVersion(), packaged: app.isPackaged, home: app.getPath("home"),
    receipt: resource("python", "backend-wheel.receipt"), profile: join(appDir(), "config.json"),
    backendLog: join(logsDir(), "backend.log"), state: phase,
    claude: () => claudeConnection().runtime(), secrets: [services?.sessionSecret, ai?.bridge?.token, services?.browserHost.token],
  });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      // The stock appMenu adds macOS Services contributed by other apps.
      // Keep standard app actions without advertising those unrelated services.
      { label: "Delphi", submenu: [
        { role: "about" },
        { label: "AI Connection…", click: () => { void openConnectionWindow(); } },
        { type: "separator" },
        { role: "hide" }, { role: "hideOthers" }, { role: "unhide" },
        { type: "separator" }, { role: "quit" },
      ] },
      { role: "fileMenu" },
      { role: "editMenu" },
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { role: "forceReload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      { role: "windowMenu" },
      {
        role: "help",
        submenu: [
          {
            label: "Set Up Delphi MCP",
            click: async () => {
              try {
                if (!prepareMcp) throw new Error("Delphi is still starting. Try again once your library opens.");
                await prepareMcp();
                const result = await dialog.showMessageBox({
                  type: "info", title: "Set Up Delphi MCP", message: "Connect Delphi to Codex",
                  detail: ["The local launcher is ready. Run this in Terminal, then open a new Codex session:", mcpSetup.command, mcpSetup.troubleshooting, mcpSetup.completion].join("\n\n"),
                  buttons: ["Copy install command", "Done"], defaultId: 0, cancelId: 1,
                });
                if (result.response === 0) clipboard.writeText(mcpSetup.command);
              } catch (error) {
                console.error("MCP setup failed:", error);
                dialog.showErrorBox("MCP setup could not finish", error instanceof Error ? error.message : String(error));
              }
            },
          },
          {
            label: "Show Logs",
            click: () => { void shell.openPath(logsDir()); },
          },
          {
            label: "Copy Diagnostics",
            click: async () => {
              try {
                clipboard.writeText(await diagnostics());
                await dialog.showMessageBox({ type: "info", title: "Copy Diagnostics", message: "Diagnostics copied", detail: DIAGNOSTICS_COPIED, buttons: ["Done"] });
              } catch (error) {
                console.error("Copy Diagnostics failed:", error);
                dialog.showErrorBox("Diagnostics could not be copied", error instanceof Error ? error.message : String(error));
              }
            },
          },
          {
            label: "Report a Bug…",
            click: async () => {
              try {
                await reportBug({
                  appVersion: app.getVersion(), diagnostics, copy: text => clipboard.writeText(text),
                  confirm: async detail => (await dialog.showMessageBox({
                    type: "info", title: "Report a Bug", message: "Report a bug on GitHub", detail,
                    buttons: ["Open the Form", "Cancel"], defaultId: 0, cancelId: 1,
                  })).response === 0,
                  openExternal: url => shell.openExternal(url),
                });
              } catch (error) {
                console.error("Report a Bug failed:", error);
                dialog.showErrorBox("The bug report form could not be opened",
                  `${error instanceof Error ? error.message : String(error)}\n\nOpen ${bugReportUrl(app.getVersion())} in your browser instead.`);
              }
            },
          },
          {
            label: "Show Data Folder",
            click: () => { void shell.openPath(dataDir()); },
          },
        ],
      },
    ]),
  );
}

/** The only credential surface; the reader never receives a secret or IPC. */
async function askForSetup(managing = false, preferred?: ConnectionId): Promise<{ config: StoredConfig; apiKey: string } | undefined> {
  if (!managing) { phase = "setup"; startupWindow?.close(); }
  const { ipcMain } = await import("electron");
  const setupPath = onboardingFile("index.html");
  let saving = false;
  let completed = false;

  return await new Promise((resolve, reject) => {
    onboardingWindow = new BrowserWindow({
      width: 560,
      height: 860,
      resizable: false,
      show: false,
      backgroundColor: "#ffffff",
      title: "",
      titleBarStyle: "hiddenInset",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: app.isPackaged
          ? join(process.resourcesPath, "preload.cjs")
          : join(app.getAppPath(), ".delphi-build", "app", "preload.cjs"),
      },
    });
    onboardingWindow.webContents.on("will-navigate", event => event.preventDefault());
    onboardingWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    onboardingWindow.once("ready-to-show", () => onboardingWindow?.show());
    onboardingWindow.on("closed", () => {
      ipcMain.removeHandler("delphi:save-setup");
      ipcMain.removeHandler("delphi:connection");
      void subscription?.cancel().catch(() => {});
      void claude?.cancel().catch(() => {});
      if (!completed) resolve(undefined);
      // Closing the first-run window before finishing is a decision to quit,
      // not an error to report.
      onboardingWindow = undefined;
      if (!managing && phase !== "ready" && phase !== "stopping") app.quit();
    });

    ipcMain.handle("delphi:save-setup", async (event, setup: unknown) => {
      const contents = onboardingWindow?.webContents;
      if (!contents || event.sender !== contents || event.senderFrame !== contents.mainFrame || event.senderFrame.url !== pathToFileURL(setupPath).href) throw new Error("Untrusted setup sender");
      if (saving || completed || (!managing && phase !== "setup")) return { ok: false, message: "Setup is already in progress." };
      saving = true;
      try {
        const { provider, apiKey } = parseSetup(setup);
        const busy = managing ? aiBusy() : undefined;
        if (busy) return { ok: false, message: busy };

        const verified = provider === "claude" ? await verifyClaudeKey(apiKey) : await verifyKey(apiKey);
        if (!verified.ok) return verified;

        let config: StoredConfig;
        try {
          const stored = readConfig();
          if (provider === "claude") config = { ...stored, version: 2, connectionId: "claude-api", claudeApiKey: apiKey };
          else {
            // A new OpenAI key is OpenAI's: a provider URL an earlier build saved goes with the key it served.
            config = { ...stored, version: 2, connectionId: "openai-api", apiKey };
            delete config.apiBaseUrl;
          }
        } catch (error) {
          return { ok: false, message: (error as Error).message };
        }
        shutdown.signal.throwIfAborted();
        if (!managing) writeConfig(config);
        completed = true;
        resolve({ config, apiKey });
        return { ok: true };
      } catch (error) { return { ok: false, message: (error as Error).message }; }
      finally { saving = false; }
    });

    ipcMain.handle("delphi:connection", async (event, command: unknown) => {
      const contents = onboardingWindow?.webContents;
      if (!contents || event.sender !== contents || event.senderFrame !== contents.mainFrame || event.senderFrame.url !== pathToFileURL(setupPath).href) throw new Error("Untrusted setup sender");
      if (!command || typeof command !== "object" || Array.isArray(command)) return { ok: false, message: "Invalid connection command." };
      const value = command as { action?: string; to?: unknown };
      if (Object.keys(value).some(key => key !== "action" && key !== "to")) return { ok: false, message: "Unknown connection field." };
      if (value.to !== undefined && !isConnectionId(value.to)) return { ok: false, message: "That connection is not enabled." };
      try {
        if (value.action === "status") {
          const stored = readConfig();
          // A profile that already holds an API key keeps that connection until the reader changes it.
          const selected = preferred ?? stored.connectionId ?? (stored.apiKey ? "openai-api" : undefined);
          const [chatgpt, claude] = await Promise.all([planConnection("chatgpt-oauth").status(), planConnection("claude-subscription").status()]);
          return { ok: true, managing, selected, keys: { openai: managing && Boolean(stored.apiKey), claude: managing && Boolean(stored.claudeApiKey) }, chatgpt, claude };
        }
        if (saving || completed) return { ok: false, message: "A connection change is already in progress." };
        const busy = managing && ["save", "use-saved-key"].includes(String(value.action)) ? aiBusy() : undefined;
        if (busy) return { ok: false, message: busy };
        saving = true;
        const target = value.to ?? "chatgpt-oauth";
        if (!isConnectionId(target)) throw new Error("Unknown connection.");
        if (value.action === "install" && target === "claude-subscription") { await shell.openExternal(CLAUDE_INSTALL_URL); return { ok: true }; }
        const connection = isSubscription(target) ? planConnection(target) : undefined;
        if (!connection && value.action !== "use-saved-key") throw new Error("Choose a subscription connection.");
        if (["login", "logout"].includes(String(value.action)) && (aiBusy() || (readConfig().connectionId === target && ai?.bridge?.active))) throw new Error("Wait for active AI work to finish before changing sign-in.");
        if (value.action === "login") {
          await connection!.login();
        } else if (value.action === "cancel") await connection!.cancel();
        else if (value.action === "logout") {
          await connection!.logout();
        } else if (value.action === "use-saved-key") {
          if (isSubscription(target)) throw new Error("Choose a provider key.");
          const stored = readConfig();
          const apiKey = managing ? savedKey(stored, target) : "";
          if (!apiKey) throw new Error("No API key is saved for this provider yet.");
          const config: StoredConfig = { ...stored, version: 2, connectionId: target };
          shutdown.signal.throwIfAborted();
          if (!managing) writeConfig(config); completed = true; resolve({ config, apiKey });
        } else if (value.action === "save") {
          await connection!.ready();
          const config: StoredConfig = { ...readConfig(), version: 2, connectionId: target };
          shutdown.signal.throwIfAborted();
          if (!managing) writeConfig(config); completed = true; resolve({ config, apiKey: "" });
        } else throw new Error("Unknown connection action.");
        return { ok: true };
      } catch (error) { return { ok: false, message: error instanceof Error ? error.message : "Connection failed." }; }
      finally { if (value.action !== "status") saving = false; }
    });

    onboardingWindow.loadFile(setupPath).catch(reject);
  });
}

/**
 * Check the key against the capability Delphi actually needs.
 *
 * `/models` alone is the wrong test, and it was wrong in a way that would have
 * shipped: a key can be scoped to the Responses API and still get 403 from the
 * models listing, so a perfectly good key was rejected at first launch with
 * "That key was refused by the provider" — for an app that does nothing else
 * until it is accepted. Delphi only ever calls `/responses` (plus `/files`), so
 * that is what a refusal has to be measured against.
 *
 * The ladder: `/models` is free and settles the common case; only if it refuses
 * do we spend a single minimal `/responses` call. A key is rejected only when
 * *both* say 401/403. Anything else — a 400, a 404, an offline machine — means
 * we do not know, and not knowing is not a reason to block someone from their
 * own app.
 */
async function verifyKey(apiKey: string): Promise<{ ok: boolean; message?: string }> {
  const base = "https://api.openai.com/v1";
  const headers = { authorization: `Bearer ${apiKey}` };

  let refused = false;
  try {
    const listed = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(15_000) });
    if (listed.ok) return { ok: true };
    refused = listed.status === 401 || listed.status === 403;
  } catch {
    return { ok: true }; // offline, or no such endpoint: let the first real request judge
  }
  if (!refused) return { ok: true };

  try {
    const answered = await fetch(`${base}/responses`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      // A tiny authentication probe; no conversation context is needed.
      body: JSON.stringify({ model: KEY_CHECK.model, reasoning: { effort: KEY_CHECK.effort }, input: "hi", max_output_tokens: KEY_CHECK.maxOutputTokens, store: false }),
      signal: AbortSignal.timeout(30_000),
    });
    if (answered.status === 401 || answered.status === 403) {
      return { ok: false, message: "That key was refused." };
    }
    return { ok: true };
  } catch {
    return { ok: true };
  }
}

function fail(error: unknown): void {
  if (phase === "stopping") return;
  const message = error instanceof Error ? error.message : String(error);
  const detail = ai?.backend?.recentErrors().slice(-1500) ?? "";
  // Logged *as well as* shown. A modal error box can open on another Space, or
  // behind a full-screen window, and then the app looks like it hung rather
  // than like it failed — which is exactly how this was misdiagnosed once.
  console.error("[delphi] startup failed:", message, detail ? `\n${detail}` : "");
  dialog.showErrorBox("Delphi could not start", detail ? `${message}\n\n${detail}` : message);
  app.quit();
}

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
let servicesStopped = false;
app.on("before-quit", event => {
  phase = "stopping"; shutdown.abort();
  if (ai && !servicesStopped) {
    event.preventDefault();
    void ai.stop().finally(() => {
      servicesStopped = true; app.quit();
      setTimeout(() => app.exit(0), 1_000);
    });
    return;
  }
  subscription?.stop(); claude?.stop(); host?.close(); host?.closeAllConnections();
  // After the backend, whose exit already closed every page it held.
  void services?.browserHost.close().catch(error => console.error("[delphi] the browser host did not close cleanly:", error));
  researchSocket?.close(); researchSocket = undefined;
  plans?.close(); plans?.store.close(); plans = undefined;
});
