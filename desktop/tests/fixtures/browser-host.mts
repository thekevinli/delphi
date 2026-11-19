/**
 * Run by browser-host.test.mts as Electron's main script, in a throwaway
 * profile: the real browser host, with core's own capture, preview and
 * validator code driving it from a Python child. Prints one JSON line.
 */
import { spawn } from "node:child_process";
import { app, BrowserWindow } from "electron";
import { startBrowserHost } from "../../main/browser-host.ts";

async function main() {
  app.setPath("userData", process.env.DELPHI_BROWSER_PROFILE!);
  app.dock?.hide();
  app.on("window-all-closed", () => {});
  await app.whenReady();
  const logged: string[] = [];
  const host = await startBrowserHost(message => logged.push(message));
  // What the reader would see while the jobs run: any window shown or focused.
  let shown = 0, focused = 0, peakWindows = 0;
  const watch = setInterval(() => {
    const windows = BrowserWindow.getAllWindows();
    peakWindows = Math.max(peakWindows, windows.length);
    shown = Math.max(shown, windows.filter(window => window.isVisible()).length);
    if (BrowserWindow.getFocusedWindow()) focused += 1;
  }, 25);
  const python = spawn(process.env.DELPHI_BROWSER_PYTHON!, [process.env.DELPHI_BROWSER_JOBS!], {
    env: { ...process.env, BROWSER_HOST_SOCKET: host.socket, BROWSER_HOST_TOKEN: host.token },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let output = "";
  python.stdout.on("data", chunk => { output += chunk; });
  const code = await new Promise<number | null>(resolve => python.on("exit", resolve));
  // Every page is gone once its job is: nothing lingers between jobs.
  await new Promise(resolve => setTimeout(resolve, 500));
  const lingering = BrowserWindow.getAllWindows().length;
  clearInterval(watch);
  await host.close();
  const jobs = output.trim() ? JSON.parse(output.trim().split("\n").pop()!) : null;
  process.stdout.write(JSON.stringify({ code, jobs, shown, focused, peakWindows, lingering, logged }) + "\n");
  app.exit(0);
}

main().catch(error => { console.error(error); app.exit(1); });
