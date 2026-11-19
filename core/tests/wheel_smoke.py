"""Installed-artifact contract, executed with -I in a clean virtualenv.

Keep this independent of pytest and source fixtures: otherwise a missing runtime
file or dependency can be supplied by the checkout while the wheel stays broken.
Two processes prove that a wheel can reopen the library it wrote, not just return
an in-memory response. No provider calls or external services are used.

The "create" phase also runs against the previous release's published wheel
(`scripts/check_backend_wheel.py --previous-artifacts`), so it asserts only what
every release since 0.1.0 has; a check for something newer is gated on the
expected version.
"""
import importlib
import importlib.metadata
import json
import os
from pathlib import Path
import subprocess
import sys


#: The package and distribution the wheel installs; `scripts/backend_release.py::CORE_LAYOUT`
#: is the release tooling's copy, and this probe imports nothing from the checkout.
PACKAGE, DISTRIBUTION = "delphi_core", "delphi-core"


def math_font_pdf() -> bytes:
    """
    One character in a CFF Type 1 font whose own encoding puts theta at 0x12,
    with no ToUnicode: how TeX's math fonts reach a PDF. pypdf reads that
    encoding only with fontTools installed, and without it extracts "\\x12";
    measured on the NTK paper, 954 control characters for its symbols.
    """
    from fontTools.fontBuilder import FontBuilder
    from fontTools.pens.t2CharStringPen import T2CharStringPen

    builder = FontBuilder(1000, isTTF=False)
    builder.setupGlyphOrder([".notdef", "theta"])
    builder.setupCharacterMap({0x03B8: "theta"})
    strings = {}
    for name in (".notdef", "theta"):
        pen = T2CharStringPen(500, None)
        pen.moveTo((50, 0)), pen.lineTo((450, 0)), pen.lineTo((450, 700)), pen.closePath()
        strings[name] = pen.getCharString()
    builder.setupCFF("DelphiProbe", {"FullName": "DelphiProbe"}, strings, {})
    builder.font["CFF "].cff.topDictIndex[0].Encoding = [".notdef"] * 0x12 + ["theta"] + [".notdef"] * (255 - 0x12)
    font = builder.font["CFF "].compile(builder.font)
    content = b"BT /F1 12 Tf 72 720 Td <12> Tj ET"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /DelphiProbe /FirstChar 18 /LastChar 18 /Widths [500] /FontDescriptor 6 0 R >>",
        b"<< /Length %d >>\nstream\n%s\nendstream" % (len(content), content),
        b"<< /Type /FontDescriptor /FontName /DelphiProbe /Flags 4 /FontBBox [0 0 500 700] /ItalicAngle 0 /Ascent 700 "
        b"/Descent 0 /CapHeight 700 /StemV 80 /FontFile3 7 0 R >>",
        b"<< /Subtype /Type1C /Length %d >>\nstream\n%s\nendstream" % (len(font), font),
    ]
    out, offsets = bytearray(b"%PDF-1.4\n"), []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n%s\nendobj\n" % (number, body)
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1) + b"".join(b"%010d 00000 n \n" % at for at in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)
    return bytes(out)


def main() -> None:
    expected, phase, spec = sys.argv[1:]
    work = Path.cwd()
    for key in list(os.environ):
        if key.startswith(("OPENAI_", "MODEL_", "GCS_", "KNOWLEDGE_", "MEMORY_")):
            os.environ.pop(key)
    os.environ.update({"DATA_DIR": str(work / "data"), "DATABASE_URL": "",
                       "SESSION_SECRET": "wheel-test-session-secret", "SIGNUP_CODE": "",
                       "COOKIE_SECURE": "false", "FRONTEND_ORIGINS": "http://localhost:3000",
                       "WEB_SANDBOX_ORIGIN": "http://127.0.0.1:8000"})
    # Imported only now, once the environment above is the one its settings read.
    core = importlib.import_module(PACKAGE)
    import httpx
    from fastapi.testclient import TestClient
    api = importlib.import_module(f"{PACKAGE}.main").app
    bridge_source = importlib.import_module(f"{PACKAGE}.web_proxy").bridge_source
    from pypdf import PdfWriter

    assert Path(core.__file__).resolve().is_relative_to(Path(sys.prefix).resolve())
    assert importlib.metadata.version(DISTRIBUTION) == expected
    assert api.version == expected
    assert bridge_source().strip()
    # Each stage reads its contract from the package at import.
    domain, maintain, select, verify = (importlib.import_module(f"{PACKAGE}.memory_maintenance.{name}")
                                        for name in ("domain", "maintain", "select", "verify"))
    assert maintain.CONTRACT.strip() and domain.CONTRACT.strip() and select and verify
    with httpx.Client(http2=True):
        pass  # Runtime metadata must supply h2, not just the developer environment.
    # A paper's mathematics is read as its symbols: the runtime's pypdf and fontTools together.
    from io import BytesIO

    from pypdf import PdfReader

    assert PdfReader(BytesIO(math_font_pdf())).pages[0].extract_text() == "\u03b8"
    with TestClient(api) as client:
        response = client.get("/api/health")
        assert response.status_code == 200 and response.json()["storage"] == "local"
        credentials = {"username": "wheel-reader", "password": "wheel-test-password"}
        if phase == "create":
            response = client.post("/api/auth/register", json=credentials)
            assert response.status_code == 200, response.text
            cookie = response.headers["set-cookie"]
            assert "httponly" in cookie.lower() and "domain=" not in cookie.lower()
            response = client.post("/api/projects", json={"name": "Wheel contract"})
            assert response.status_code == 201, response.text
            (work / "project-id").write_text(response.json()["id"])
        else:
            response = client.post("/api/auth/login", json=credentials)
            assert response.status_code == 200, response.text
            response = client.get("/api/projects")
            assert response.status_code == 200, response.text
            assert any(p["id"] == (work / "project-id").read_text() for p in response.json())
        assert client.get("/api/auth/me").json()["username"] == "wheel-reader"
        worker = client.get("/api/projects/annotation-worker.js")
        assert worker.status_code == 200 and "javascript" in worker.headers["content-type"]
        config = importlib.import_module(f"{PACKAGE}.config")
        # `get_settings` reads the request's app; the environment's settings are `load_settings`.
        settings = config.load_settings()
        LocalStorage = importlib.import_module(f"{PACKAGE}.storage").LocalStorage
        storage = LocalStorage(settings)
        project = (work / "project-id").read_text()
        if not any(p["id"] == "html-wheel" for p in storage.get_project("wheel-reader", project)["papers"]):
            storage.add_paper("wheel-reader", project, {"id":"html-wheel", "title":"Web", "filename":"example.org", "kind":"web", "url":"https://example.org/article"})
        path = f"/api/projects/{project}/papers/html-wheel"
        payload = {"type":"html", "text":"quote", "requestId":"wheel-annotation-request", "anchor":{
            "version":1, "revision":"a"*64, "blockHash":"b"*64, "blockOrdinalHint":0,
            "start":0, "end":5, "startInBlock":0, "prefix":"", "suffix":""}}
        marked = client.post(path+"/highlights", json=payload)
        assert marked.status_code == 201, marked.text
        note = client.post(path+"/notes", json={"highlightId":marked.json()["id"], "page":None, "anchorY":None, "quotedText":"quote", "body":"Survives reopening"})
        assert note.status_code == 201, note.text
        assert len(client.get(path+"/highlights").json()) == 1
        assert client.get(path+"/notes").json()[0]["body"] == "Survives reopening"
        Path(spec).write_text(json.dumps(api.openapi(), sort_keys=True, indent=2) + "\n")

    writer = PdfWriter()
    writer.add_blank_page(width=612, height=792)
    pdf = work / "blank.pdf"
    writer.write(pdf)
    request, response = work / "request.json", work / "response.json"
    request.write_text(json.dumps({"operation": "source_inventory",
                                  "payload": {"path": str(pdf), "extractedText": ""}}))
    subprocess.run([sys.executable, "-I", "-m", f"{PACKAGE}.pdf_worker", str(request), str(response)],
                   check=True, timeout=30)
    result = json.loads(response.read_text())
    assert "result" in result and "error" not in result, result
    print(f"Wheel contract passed: {phase}")


if __name__ == "__main__":
    main()
