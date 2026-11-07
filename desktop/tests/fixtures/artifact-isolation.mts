/**
 * Run by artifact-isolation.test.mts as Electron's main script, in a throwaway
 * profile. Every sink is loopback and every text synthetic; it prints only
 * what each window observed, one JSON line per window.
 */
import { createSocket } from "node:dgram";
import { createServer } from "node:http";
import { createServer as createTCPServer } from "node:net";
import { app, BrowserWindow, type WebContents } from "electron";
import { protectArtifactFrames } from "../../main/artifacts/navigation.ts";
import { artifactDocument } from "../../frontend/app/lib/inline-artifact.ts";

const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const logged: string[] = [];
const report = console.error;
console.error = (...values: unknown[]) => { logged.push(values.map(String).join(" ")); report(...values); };

async function main() {
  app.setPath("userData", process.env.DELPHI_ISOLATION_PROFILE!);
  app.dock?.hide();
  app.on("window-all-closed", () => {});
  const udp = createSocket("udp4");
  let udpPackets = 0, tcpConnections = 0;
  udp.on("message", () => udpPackets++);
  const tcp = createTCPServer(socket => { tcpConnections++; socket.destroy(); });
  await new Promise<void>(resolve => udp.bind(0, "127.0.0.1", resolve));
  await new Promise<void>(resolve => tcp.listen(0, "127.0.0.1", resolve));
  const turn = (tcp.address() as { port: number }).port, stun = udp.address().port;

  // A STUN query over UDP and a TURN allocation over TCP, which a UDP-only
  // policy still lets through: either would carry text out in a hostname or
  // a username.
  const probe = `<script>top.postMessage({nested:typeof RTCPeerConnection},'*');const pc=new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:${stun}'},{urls:'turn:127.0.0.1:${turn}?transport=tcp',username:'synthetic',credential:'probe'}]});pc.createDataChannel('probe');pc.createOffer().then(o=>pc.setLocalDescription(o));<\/script>`;
  const literal = JSON.stringify(probe).replaceAll("<", "\\u003c");
  // Created only after load, as a reviewed artifact would have to.
  const hostile = `<p>Loaded</p><script>setTimeout(()=>{const f=document.createElement('iframe');f.srcdoc=${literal};document.body.append(f)},300)<\/script>`;
  const ordinary = `<button id="count" onclick="this.textContent='Worked'">Click</button>`;
  const html = '<body><script>window.reports=[];addEventListener("message",e=>reports.push(e.data))</script>';
  const web = `<body><p>Article</p><script>const f=document.createElement('iframe');f.srcdoc=${JSON.stringify(`<script>top.postMessage({webNested:true},'*')<\/script>`).replaceAll("<", "\\u003c")};document.body.append(f)</script>`;
  const host = createServer((req, res) => {
    res.writeHead(200, { "content-type": req.url === "/data" ? "text/plain" : "text/html" });
    res.end(req.url === "/data" ? "reader fetch works" : req.url === "/web" ? web : html);
  });
  await new Promise<void>(resolve => host.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(host.address() as { port: number }).port}`;

  const mount = (contents: WebContents, name: string, source: string) => contents.executeJavaScript(`new Promise(resolve=>{
    const f=document.createElement('iframe');f.name=${JSON.stringify(name)};f.sandbox='allow-scripts';f.onload=resolve;
    f.srcdoc=${JSON.stringify(artifactDocument(source))};document.body.append(f)})`);
  const frame = (contents: WebContents, name: string) => contents.mainFrame.frames.find(child => child.name === name);
  const sinks = () => [udpPackets, tcpConnections];

  await app.whenReady();
  try {
    for (const guarded of [false, true]) {
      const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
      const contents = win.webContents;
      if (guarded) protectArtifactFrames(contents);
      try {
        await win.loadURL(origin);
        const result: Record<string, unknown> = { guarded, policy: contents.getWebRTCIPHandlingPolicy() };
        if (guarded) {
          await mount(contents, "delphi-artifact-ordinary", ordinary);
          const visual = frame(contents, "delphi-artifact-ordinary")!;
          result.ownProcess = visual.osProcessId !== contents.mainFrame.osProcessId;
          result.clicked = await visual.executeJavaScript("document.querySelector('#count').click();document.querySelector('#count').textContent");
          // Reset: the reader replaces the srcdoc of the frame it owns.
          await contents.executeJavaScript(`new Promise(resolve=>{const f=document.querySelector('iframe');f.onload=resolve;f.srcdoc=${JSON.stringify(artifactDocument('<p id="reset">Reset worked</p>'))}})`);
          result.reset = await frame(contents, "delphi-artifact-ordinary")!.executeJavaScript("document.querySelector('#reset').textContent");
          await contents.executeJavaScript(`new Promise(resolve=>{const f=document.createElement('iframe');f.name='delphi-frame-web';f.sandbox='allow-scripts allow-same-origin';f.onload=resolve;f.src='/web';document.body.append(f)})`);
        }
        const before = sinks();
        await mount(contents, "delphi-artifact-hostile", hostile);
        await settle(2500);
        const reports = await contents.executeJavaScript("window.reports");
        Object.assign(result, {
          nestedRan: reports.some((row: { nested?: string }) => row.nested),
          udpPackets: sinks()[0] - before[0], tcpConnections: sinks()[1] - before[1],
          webNestedRan: reports.some((row: { webNested?: boolean }) => row.webNested),
          readerFetch: await contents.executeJavaScript("fetch('/data').then(r=>r.text())"),
          ended: logged.some(line => line.includes("nested frame")),
        });
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } finally { win.destroy(); }
    }
  } finally {
    udp.close(); tcp.close(); host.close(); host.closeAllConnections();
  }
}
main().then(() => app.exit(0), error => { report(error); app.exit(1); });
