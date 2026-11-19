import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const python = fileURLToPath(new URL("../../../.delphi-build/python/bin/python3", import.meta.url));
const html = execFileSync(python, ["-c", `
from delphi_core.web_proxy import render_frame
print(render_frame('''<!doctype html><html><head>
<link rel="stylesheet" href="/style.css" crossorigin></head><body>
<h1 id="heading">Article</h1><div><video muted style="width:320px;height:180px"><source src="/tone.wav" type="audio/wav"></video>
<button id="play">Play</button><button id="pause">Pause</button><button id="seek">Seek</button></div>
<script>
const video=document.querySelector('video');
document.querySelector('#play').onclick=()=>video.play();
document.querySelector('#pause').onclick=()=>video.pause();
document.querySelector('#seek').onclick=()=>video.currentTime=2;
</script>
</body></html>''', 'https://article.example/read'))
`], { encoding: "utf8" });

test("live page keeps its own click handlers for play, pause and seek", async ({ page }) => {
  const wave = Buffer.alloc(44 + 16000 * 2 * 4);
  wave.write("RIFF"); wave.writeUInt32LE(wave.length - 8, 4); wave.write("WAVEfmt ", 8);
  wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(16000, 24); wave.writeUInt32LE(32000, 28);
  wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34);
  wave.write("data", 36); wave.writeUInt32LE(wave.length - 44, 40);
  await page.route("https://article.example/**", route => {
    if (route.request().url().endsWith("style.css")) return route.fulfill({ contentType: "text/css", body: "h1{color:rgb(12, 34, 56)}" });
    const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? "");
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Number(range[2]) : wave.length - 1;
    return route.fulfill({ status: range ? 206 : 200, contentType: "audio/wav", body: wave.subarray(start, end + 1),
      headers: { "accept-ranges": "bytes", ...(range ? { "content-range": `bytes ${start}-${end}/${wave.length}` } : {}) } });
  });
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("page-url")) return route.fulfill({ json: { url: "/api/page", view: "live", sandbox: "allow-scripts", allow: "autoplay; fullscreen", renderWidth: null } });
    if (path.endsWith("/page")) return route.fulfill({ contentType: "text/html", body: html });
    if (path.endsWith("annotation-revision")) return route.fulfill({ json: { texts: [], available: false } });
    return route.fulfill({ json: [] });
  });
  await page.goto("/tests/browser/harness.html");
  const frame = page.frameLocator("iframe");
  await expect(frame.locator("#heading")).toHaveCSS("color", "rgb(12, 34, 56)");
  const video = frame.locator("video");
  await frame.locator("#play").click();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0.1);
  await frame.locator("#pause").click();
  await frame.locator("#seek").click();
  await expect(video).toHaveJSProperty("paused", true);
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(2, 1);
});
