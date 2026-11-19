"""Core's three browser jobs, run against the real browser host by browser-host.test.mts.

Every host this touches is loopback: the article server, and a sink that no
page may reach. The validating proxy is the backend's own, told only that the
article server counts as public. An installed browser is never consulted:
asking for one raises. Prints one JSON object with what each job produced.
"""
import asyncio
import http.server
import json
import os
import re
import socketserver
import sys
import threading
import time
import urllib.parse
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace

from PIL import Image

from delphi_core import browser_host, browser_render, dashboard
from delphi_core.artifacts import display, render

ARTICLE = """<!doctype html><html><head><title>Built</title><style>body{margin:0;background:rgb(20,120,60)}</style></head>
<body><main id="root">Loading</main><img src="http://127.0.0.1:%(sink)d/leak.png">
<script>setTimeout(()=>{fetch('/data').then(r=>r.text()).then(t=>{document.getElementById('root').innerHTML=
'<h1>A page that builds itself</h1>'+('<p>'+t+'</p>').repeat(30)})},300)</script></body></html>"""
DATA = "Rendered by the page's own script after a fetch, long enough to read as an article. " * 3
# Every dialog a page can raise, then the article it builds.
DIALOGS = ("<html><body><main id='root'>Loading</main><script>alert('a'); confirm('b'); prompt('c'); print();"
           "document.getElementById('root').innerHTML='<h1>Built after its dialogs</h1>'+'<p>'+'"
           + "A sentence of the article. " * 20 + "'+'</p>'</script></body></html>")
# A list in its own scroller that draws only the rows in view, as Notion's
# public pages do: a row holds a low estimate until drawn, and leaves the
# document once out of view, so scrolling past it collects nothing.
WINDOWED = """<!doctype html><html><head><title>Windowed</title><style>html,body{margin:0;height:100%%}
body{display:flex;flex-direction:column}header{height:44px}#scroller{flex:1;overflow-y:auto}.row{margin:0;height:54px}</style></head>
<body><header>Top bar</header><div id="scroller"><div id="list"></div></div><script>
const N = %(rows)d, ACTUAL = 54, size = new Array(N).fill(20);
const scroller = document.getElementById('scroller'), list = document.getElementById('list');
function draw() {
  for (;;) {
    const top = scroller.scrollTop, bottom = top + scroller.clientHeight;
    let y = 0, first = -1, last = -1, before = 0;
    for (let i = 0; i < N; i++) { if (y + size[i] > top && y < bottom) { if (first < 0) { first = i; before = y; } last = i; } y += size[i]; }
    let fresh = false;
    for (let i = first; i >= 0 && i <= last; i++) if (size[i] !== ACTUAL) { size[i] = ACTUAL; fresh = true; }
    if (fresh) continue;
    let after = 0;
    for (let i = last + 1; i < N; i++) after += size[i];
    let rows = '';
    for (let i = first; i <= last; i++) rows += '<p class="row">Row ' + i + ' of a list that draws only what is in view.</p>';
    list.innerHTML = '<div style="height:' + before + 'px"></div>' + rows + '<div style="height:' + after + 'px"></div>';
    return;
  }
}
setTimeout(() => { draw(); scroller.addEventListener('scroll', draw); addEventListener('resize', draw); }, 300);
</script></body></html>"""
WINDOWED_ROWS = 600
# An ordinary article under a banner its script sizes to the window and writes
# inline, with blank space below: it looks windowed, and is not.
SIZED = """<!doctype html><html><body style="margin:0"><div id="banner"></div><main id="root">Loading</main>
<div style="height:6000px"></div><script>const banner = document.getElementById('banner');
const fit = () => { banner.style.height = innerHeight + 'px'; }; fit(); addEventListener('resize', fit);
setTimeout(() => { document.getElementById('root').innerHTML = '<h1>An ordinary article</h1>'
  + '<p>A paragraph of the article itself, long enough to read as one.</p>'.repeat(40); }, 300);</script></body></html>"""
# A page its scripts assemble from chunks that say they never change, as
# Notion's 721 do, and one script that may: each chunk adds its part.
CHUNKS = 30
CHUNKED = ("<!doctype html><html><body><main id='root'></main>"
           + "".join(f"<script src='/chunk/{n}.js'></script>" for n in range(CHUNKS))
           + "<script src='/live.js'></script></body></html>")
CHUNK = "document.getElementById('root').insertAdjacentHTML('beforeend', '<p>Part %d of a page its chunks assemble, long enough to read as one.</p>');"
# A prepared document that would read a local file from file:// if a handler
# ran, through a worker, which no request filter sees: red when it read one,
# green when the read was refused, white when nothing ran.
HOSTILE = ("<html><body style='margin:0;background:#fff'><img src='x' onerror=\"const w=new Worker(window.URL"
           ".createObjectURL(new Blob(['fetch(\\'file:///etc/hosts\\').then(r=>r.text()).then(t=>postMessage(t.length),"
           "()=>postMessage(0))'])));w.onmessage=e=>{document.body.style.background=e.data?'#f00':'#0f0'}\">"
           "<p>Frozen</p></body></html>")


def serve(handler):
    server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, server.server_address[1]


sink_hits = []


class Sink(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        sink_hits.append(self.path)
        self.send_response(204)
        self.end_headers()

    def do_CONNECT(self):
        sink_hits.append(self.path)

    def log_message(self, *args):
        pass


sink, SINK = serve(Sink)


asked = []


class Article(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        # Through the proxy a request line carries the absolute URL.
        path = urllib.parse.urlsplit(self.path).path
        asked.append(path)
        caching = "no-cache"
        if path.startswith("/chunk/"):
            body, kind, caching = CHUNK % int(path[7:-3]), "text/javascript", "public, max-age=31536000, immutable"
        elif path == "/live.js":
            body, kind = "document.body.dataset.live = 'yes';", "text/javascript"
        elif path == "/chunked":
            body, kind = CHUNKED, "text/html"
        elif path == "/data":
            body, kind = DATA, "text/plain"
        elif path == "/dialogs":
            body, kind = DIALOGS, "text/html"
        elif path == "/windowed":
            body, kind = WINDOWED % {"rows": WINDOWED_ROWS}, "text/html"
        elif path == "/sized":
            body, kind = SIZED, "text/html"
        else:
            body, kind = ARTICLE % {"sink": SINK}, "text/html"
        payload = body.encode()
        self.send_response(200)
        self.send_header("content-type", kind)
        self.send_header("cache-control", caching)
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass


article, PORT = serve(Article)


def public_only_the_article(hostname, port):
    # Stands in for DNS and the public-address check: the article server is
    # "public", and every other address — the sink included — is not.
    return "127.0.0.1" if hostname == "127.0.0.1" and port in (PORT, 443) else None


def no_installed_browser():
    raise AssertionError("an installed browser was looked for while a browser host is configured")


browser_render._pinned_public_address = public_only_the_article
browser_render._chrome_executable = no_installed_browser
dashboard._pinned_public_address = public_only_the_article
dashboard._chrome_executable = no_installed_browser
render._chrome_executable = no_installed_browser

# render_dom pins the page's own host on 443 before starting; the proxy then
# checks each connection on the port it really uses.
url = f"http://127.0.0.1:{PORT}/"
result = {}

started = time.monotonic()
built = browser_render.render_dom(url, budget_seconds=15)
result["render"] = {
    "seconds": round(time.monotonic() - started, 1),
    "built": bool(built and "<h1>A page that builds itself</h1>" in built and built.count(DATA.strip()[:40]) >= 30),
    "stampedWidth": browser_render.render_width_of(built or "", 0),
}
source = browser_render.render_dom(url, budget_seconds=10, source_only=True)
# The response as served, before any script ran: no rendered text in it.
result["source"] = {"original": bool(source and 'id="root">Loading</main>' in source and DATA[:40] not in source)}


def picture(path):
    if not path:
        return None
    with Image.open(path) as image:
        pixel = image.convert("RGB").getpixel((image.width - 5, 5))
        size = image.size
    os.unlink(path)
    return {"size": list(size), "corner": list(pixel)}


started = time.monotonic()
result["preview"] = picture(dashboard._capture_webpage(url, budget_seconds=15))
result["preview_seconds"] = round(time.monotonic() - started, 1)
frozen = (built or "").replace("Loading", "")
result["frozen"] = picture(dashboard._capture_webpage(url, (), frozen, 15, 640, 480))
result["hostile"] = picture(dashboard._capture_webpage(url, (), HOSTILE, 15, 640, 480))
started = time.monotonic()
dialogs = browser_render.render_dom(f"http://127.0.0.1:{PORT}/dialogs", budget_seconds=15)
result["dialogs"] = {"built": bool(dialogs and "Built after its dialogs" in dialogs),
                     "seconds": round(time.monotonic() - started, 1)}
started = time.monotonic()
windowed = browser_render.render_dom(f"http://127.0.0.1:{PORT}/windowed", budget_seconds=15) or ""
result["windowed"] = {"rows": len(re.findall(r'<p class="row">Row \d+', windowed)), "expected": WINDOWED_ROWS,
                      "last": f"Row {WINDOWED_ROWS - 1} of a list" in windowed, "seconds": round(time.monotonic() - started, 1)}
# The add's read of the same list: its first window, and it says so.
first = browser_render.render_dom(f"http://127.0.0.1:{PORT}/windowed", budget_seconds=15, whole=False) or ""
result["first"] = {"rows": len(re.findall(r'<p class="row">Row \d+', first)), "partial": browser_render.render_is_partial(first)}
sized = browser_render.render_dom(f"http://127.0.0.1:{PORT}/sized", budget_seconds=15) or ""
# Rendered twice: the second is answered the chunks the first was told never change.
chunked = []
for _ in range(2):
    asked.clear()
    page = browser_render.render_dom(f"http://127.0.0.1:{PORT}/chunked", budget_seconds=15) or ""
    chunked.append({"parts": len(re.findall(r"<p>Part \d+ of a page", page)), "live": 'data-live="yes"' in page,
                    "chunksAsked": sum(path.startswith("/chunk/") for path in asked), "liveAsked": asked.count("/live.js")})
result["chunked"] = {"expected": CHUNKS, "renders": chunked}
result["sized"] = {"built": "<h1>An ordinary article</h1>" in sized,
                   "banner": next(iter(re.findall(r'id="banner" style="height: (\d+)px', sized)), None)}


async def artifacts():
    renderer = os.environ["DELPHI_ARTIFACT_RENDERER"]
    settings = SimpleNamespace(artifact_renderer_path=renderer, artifact_render_timeout_seconds=45, artifact_render_memory_mb=768)
    diagram = """<style>.box{padding:12px;background:var(--accent,#c33);color:#fff;border-radius:8px;transition:transform .3s}</style>
<div class="box" id="box">Step 1</div><button id="next" onclick="document.getElementById('box').textContent='Step 2'">Next</button>"""
    started = time.monotonic()
    good = await render.render_artifact(settings, "Diagram", diagram, [
        {"action": "click", "target": "#next", "expect_target": "#box", "expect_text": "Step 2"}])
    seconds = round(time.monotonic() - started, 1)
    # Mounts cleanly, then reaches for the network and nests a frame of its own.
    leaky = f"""<p>Leaky</p><script>setTimeout(()=>{{fetch('http://127.0.0.1:{SINK}/fetch').catch(()=>{{}});
new Image().src='http://127.0.0.1:{SINK}/image'}},50)</script>"""
    nested = """<p>Nested</p><script>setTimeout(()=>{const f=document.createElement('iframe');f.srcdoc='<p>inner</p>';document.body.append(f)},50)</script>"""
    leak = await render.render_artifact(settings, "Leaky", leaky, [])
    nest = await render.render_artifact(settings, "Nested", nested, [])
    greedy = """<p id="n">Greedy</p><script>window.keep=[];let i=0;const grow=()=>{for(let j=0;j<5;j++)keep.push(new Uint8Array(16e6).fill(++i));
document.getElementById('n').textContent=i;if(i<200)setTimeout(grow,20)};grow()</script>"""
    limited = SimpleNamespace(**{**vars(settings), "artifact_render_memory_mb": 256})
    heavy = await render.render_artifact(limited, "Greedy", greedy, [])
    # A library display: every state at every width, drawn by the reader from data.
    method, method_source = display.validate((Path(__file__).resolve().parents[3] / "core" / "tests" / "data" / "displays" / "correction.json").read_text())
    drawn = await render.render_artifact(settings, method["title"], method_source, [])
    # Valid data the narrowest column cannot hold, and a step that changes only a tooltip.
    _, crowded = display.validate(json.dumps({"display": 1, "title": "Crowded", "figures": [{"kind": "matrix", "cols": [f"C{i}" for i in range(8)],
        "rows": [{"label": "A", "cells": [{"value": "0.1234567890", "id": f"c{i}"} for i in range(8)]}]}],
        "steps": [{"name": "One", "note": "All."}, {"name": "Two", "note": "Only a tip.", "set": {"c0": {"tip": {"title": "First"}}}}]}))
    tight = await render.render_artifact(settings, "Crowded", crowded, [])
    codes = lambda report: sorted({item["code"] for item in report.diagnostics if item["severity"] == "error"})
    image = good.image and Image.open(BytesIO(__import__("base64").b64decode(good.image["image_url"].split(",", 1)[1])))
    return {
        "good": {"passed": good.passed, "errors": codes(good), "seconds": seconds, "views": len(good.views),
                 "interactions": [item.get("passed") for item in good.interactions],
                 "sheet": list(image.size) if image else None, "peakBytes": good.renderer_peak_bytes},
        "leaky": {"passed": leak.passed, "errors": codes(leak)},
        "nested": {"passed": nest.passed, "errors": codes(nest)},
        "greedy": {"passed": heavy.passed, "errors": codes(heavy)},
        "display": {"passed": drawn.passed, "errors": codes(drawn), "views": len(drawn.views), "interactions": [item.get("passed") for item in drawn.interactions],
                    "states": next((item.get("stateText") for item in drawn.interactions), "")},
        "crowded": {"passed": tight.passed, "errors": codes(tight)},
    }


if os.environ.get("DELPHI_ARTIFACT_RENDERER"):
    result["artifacts"] = asyncio.run(artifacts())


def concurrently():
    # Two captures and a preview at once share the pool; none waits for another to finish.
    from concurrent.futures import ThreadPoolExecutor
    started = time.monotonic()
    with ThreadPoolExecutor(3) as pool:
        pages = [pool.submit(browser_render.render_dom, url, budget_seconds=15) for _ in range(2)]
        preview = pool.submit(dashboard._capture_webpage, url, (), None, 15)
        built = [bool(job.result() and "<h1>A page that builds itself</h1>" in job.result()) for job in pages]
        shot = preview.result()
    if shot:
        os.unlink(shot)
    return {"built": built, "preview": bool(shot), "seconds": round(time.monotonic() - started, 1)}


result["concurrent"] = concurrently()
host = browser_host.configured()
try:
    browser_host.HostPage(browser_host.BrowserHost(host.socket, "not-the-token"), "artifact", width=850, height=700, deadlineSeconds=5)
    result["wrongToken"] = "opened"
except browser_host.BrowserHostError as error:
    result["wrongToken"] = str(error)
result["sinkHits"] = sink_hits
print(json.dumps(result))
sys.stdout.flush()
