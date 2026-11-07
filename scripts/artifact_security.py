"""Opt-in installed-renderer check with a synthetic, loopback-only WebRTC sink.

Run with the bundled interpreter, --renderer pointing to its validator assets,
and --browser pointing to the test browser, or with BROWSER_HOST_SOCKET and
BROWSER_HOST_TOKEN naming a browser host to check that instead. The normal
memory watchdog belongs outside this command, as it does for other browser checks.
"""
import argparse
import asyncio
import json
import os
from pathlib import Path
import socket
from types import SimpleNamespace

from delphi_core.artifacts.render import render_artifact


async def check(renderer: Path) -> None:
    settings = SimpleNamespace(artifact_renderer_path=str(renderer),
                               artifact_render_timeout_seconds=45, artifact_render_memory_mb=768)
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sink:
        sink.bind(("127.0.0.1", 0))
        sink.setblocking(False)
        port = sink.getsockname()[1]
        ordinary = '<h2>Two stages</h2><p>Input becomes output.</p><svg viewBox="0 0 240 70"><path d="M20 35H220" stroke="currentColor"/></svg>'
        inner = (
            f"<script>const p=new RTCPeerConnection({{iceServers:[{{urls:'stun:127.0.0.1:{port}'}}]}});"
            "p.createDataChannel('synthetic');p.createOffer().then(o=>p.setLocalDescription(o));</script>"
        )
        source_literal = json.dumps(inner).replace("<", "\\u003c")
        nested = ('<script>const f=document.createElement("iframe");f.width=1;f.height=1;'
                  f'f.srcdoc={source_literal};document.body.append(f);')
        hostile = ordinary + nested + "</script>"
        # Gone before the first inspection: only the realm it created is left.
        transient = ordinary + nested + "setTimeout(()=>f.remove(),30);</script>"
        for name, source, expected in [("ordinary", ordinary, True), ("nested-webrtc", hostile, False),
                                       ("transient-nested-webrtc", transient, False)]:
            report = await render_artifact(settings, name, source, [])
            packets = 0
            while True:
                try:
                    sink.recvfrom(65536)
                    packets += 1
                except BlockingIOError:
                    break
            print(json.dumps({"case": name, "passed": report.passed, "elapsed_ms": report.elapsed_ms,
                              "diagnostics": report.diagnostics, "udpPackets": packets}), flush=True)
            assert packets == 0, "validator reached the loopback STUN sink"
            assert report.passed == expected, "unexpected render verdict"
            if not expected:
                assert any(d.get("code") == "nested_frame" for d in report.diagnostics)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--renderer", type=Path, required=True)
    parser.add_argument("--browser", type=Path, required=not os.environ.get("BROWSER_HOST_SOCKET"))
    args = parser.parse_args()
    if args.browser:
        os.environ["CHROME_PATH"] = str(args.browser.resolve())
    asyncio.run(check(args.renderer.resolve()))
