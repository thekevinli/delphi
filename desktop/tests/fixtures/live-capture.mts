/**
 * Run by live-capture.test.mts as Electron's main script: the app's backend on
 * a throwaway profile, given the app's own browser host exactly as `index.ts`
 * gives it, and real web pages added through the real routes. Nothing is
 * mocked. Each page is added, its whole read drained, and its saved copy
 * framed and measured as the reader's cached view would show it, before and
 * after. Prints one JSON line.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { BACKEND_APP, backendEnv, PARENT_WATCH } from "../../main/backend.ts";
import { startBrowserHost } from "../../main/browser-host.ts";
import { API_HOST, UI_HOST, freePort } from "../../main/ports.ts";

const PAGES = (process.env.DELPHI_LIVE_PAGES ?? "").split(/\s+/).filter(Boolean);

/**
 * What the reader sees of a saved copy, laid out at the width it was captured
 * at: how many blocks are drawn, how far the page scrolls, where the last
 * drawn text or media ends, and how many of its in-page links have a target.
 * Measured in the box the page scrolls in, the document or its tallest
 * scroller, as the bridge keeps the reader's place.
 */
const MEASURE = `(() => {
  const page = document.scrollingElement || document.documentElement;
  let box = page;
  if (page.scrollHeight <= page.clientHeight + 1) {
    for (const node of document.body.getElementsByTagName("*")) {
      if (node.scrollHeight > node.clientHeight && node.clientHeight >= innerHeight / 2
          && /(auto|scroll)/.test(getComputedStyle(node).overflowY) && (box === page || node.scrollHeight > box.scrollHeight)) box = node;
    }
  }
  const outer = box === page;
  const origin = outer ? -scrollY : box.getBoundingClientRect().top + box.clientTop - box.scrollTop;
  let bottom = 0;
  const reach = rect => { if (rect.width && rect.height) bottom = Math.max(bottom, rect.bottom - origin); };
  const walker = document.createTreeWalker(outer ? document.body : box, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node; (node = walker.nextNode());) {
    if (!node.data.trim() || node.parentElement.closest("script,style,noscript,[data-delphi-frame]")) continue;
    range.selectNodeContents(node); reach(range.getBoundingClientRect());
  }
  for (const media of (outer ? document.body : box).querySelectorAll("img,video,canvas,svg,iframe")) reach(media.getBoundingClientRect());
  // Links to this page only (the copy's <base> is its address); Notion names a
  // block in one without the dashes its data-block-id has.
  const here = new URL(document.baseURI);
  const bare = id => id.replace(/-/g, "");
  const ids = new Set([...document.querySelectorAll("[id],[data-block-id]")]
    .flatMap(node => [node.id, node.getAttribute("data-block-id")].filter(Boolean).map(bare)));
  const fragments = [...document.querySelectorAll("a[href]")].map(a => {
    try {
      const to = new URL(a.getAttribute("href"), here);
      return to.origin === here.origin && to.pathname === here.pathname && to.hash.length > 1 ? decodeURIComponent(to.hash.slice(1)) : "";
    } catch { return ""; }
  }).filter(Boolean);
  const unlinked = fragments.filter(id => !ids.has(bare(id)));
  return { blocks: document.querySelectorAll("[data-block-id]").length, scrollHeight: box.scrollHeight,
    contentBottom: Math.round(bottom), blank: Math.max(0, box.scrollHeight - Math.round(bottom)),
    links: fragments.length, linked: fragments.length - unlinked.length, unlinked: unlinked.slice(0, 5),
    text: (document.body.innerText || "").length };
})()`;

async function main() {
  app.setPath("userData", mkdtempSync(join(tmpdir(), "delphi-live-electron-")));
  app.dock?.hide();
  app.on("window-all-closed", () => {});
  await app.whenReady();
  const hostLog: string[] = [];
  const host = await startBrowserHost(message => hostLog.push(message));
  const dataDir = mkdtempSync(join(tmpdir(), "delphi-live-capture-"));
  const apiPort = await freePort(API_HOST);
  const api = `http://${API_HOST}:${apiPort}`;
  const uiOrigin = `http://${UI_HOST}:${await freePort(UI_HOST)}`;
  const python = process.env.DELPHI_BROWSER_PYTHON!;
  const env = backendEnv({
    python, dataDir, logsDir: dataDir, apiHost: API_HOST, apiPort, uiOrigin,
    sessionSecret: "live-capture-".padEnd(64, "x"), apiKey: "live-capture-no-model",
    browserHost: { socket: host.socket, token: host.token },
  });
  let log = "";
  const backend = spawn(python, ["-I", "-c", PARENT_WATCH, BACKEND_APP, "--host", API_HOST, "--port", String(apiPort)],
    { env, cwd: dataDir, stdio: ["pipe", "ignore", "pipe"] });
  backend.stderr!.on("data", (chunk: Buffer) => { log = (log + chunk.toString()).slice(-20_000); });
  backend.stdin!.on("error", () => {});
  const results: Record<string, unknown>[] = [];
  try {
    for (const deadline = Date.now() + 60_000; ;) {
      try { if ((await fetch(`${api}/api/health`)).ok) break; } catch { /* starting */ }
      if (Date.now() > deadline) throw new Error("the backend never started");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const registered = await fetch(`${api}/api/auth/register`, {
      method: "POST", headers: { origin: uiOrigin, "content-type": "application/json" },
      body: JSON.stringify({ username: "reader", password: "p".repeat(40) }),
    });
    const cookie = registered.headers.getSetCookie().find((value) => value.startsWith("delphi_session="))!.split(";")[0];
    const call = async (path: string, init: RequestInit = {}) => {
      const response = await fetch(`${api}${path}`, {
        ...init, headers: { origin: uiOrigin, cookie, "content-type": "application/json", ...(init.headers ?? {}) },
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${response.status} ${text.slice(0, 400)}`);
      return text;
    };
    const project = JSON.parse(await call("/api/projects", { method: "POST", body: JSON.stringify({ name: "Live" }) })).id;
    const window = new BrowserWindow({ show: false, width: 1512, height: 1000, webPreferences: { offscreen: true } });
    const measure = async (paperId: string) => {
      // The cached view as the reader's frame is served it.
      const framed = await call(`/api/projects/${project}/papers/${paperId}/page?view=cached`, { headers: { "sec-fetch-dest": "iframe" } });
      const file = join(dataDir, `${paperId}.html`);
      writeFileSync(file, framed);
      await window.loadFile(file);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      return await window.webContents.executeJavaScript(MEASURE);
    };
    for (const url of PAGES) {
      const result: Record<string, unknown> = { url };
      results.push(result);
      try {
        let started = Date.now();
        const paper = JSON.parse(await call(`/api/projects/${project}/pages`, { method: "POST", body: JSON.stringify({ url }) }));
        result.addSeconds = (Date.now() - started) / 1000;
        result.partial = paper.capture === "partial";
        result.first = await measure(paper.id);
        started = Date.now();
        const drains: unknown[] = [];
        for (let round = 0; round < 5; round += 1) {
          const frames = (await call("/api/captures/drain", { method: "POST" })).split("\n")
            .filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5)));
          const last = frames.at(-1);
          drains.push(last);
          if (!last?.claimed && last?.type !== "error") break;
        }
        result.captureSeconds = (Date.now() - started) / 1000;
        result.drains = drains;
        result.whole = await measure(paper.id);
      } catch (error) {
        result.error = String(error);
      }
    }
    window.destroy();
  } catch (error) {
    results.push({ error: String(error) });
  } finally {
    backend.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await host.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
  process.stdout.write(JSON.stringify({ results, hostLog, log: log.split("\n").filter((line) => /render|capture|windowed/.test(line)).slice(-40) }) + "\n");
  app.exit(0);
}

main().catch((error) => { console.error(error); app.exit(1); });
