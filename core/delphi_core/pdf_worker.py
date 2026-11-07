"""
The child process every PDFium pass runs in.

`python -m delphi_core.pdf_worker <request.json> <response.json>`, one operation per
invocation, spawned by `pdf_figures.run_isolated`. It exists because PDFium can
abort the interpreter natively — see that function's docstring for the crash
this was written against — and the only defence against a native abort is for
the process that dies to be one nobody is waiting on.

Two rules keep it that way:

* **Nothing here is imported by the server.** The imports below are the ones a
  fresh interpreter pays for on every figure, so the module-level set stays
  tiny and the real work imports lazily, exactly as `pdf_figures` already does
  with `pypdfium2`.
* **It never writes anything but its response file.** No storage, no object
  store, no network. It is handed a path to a PDF that has already been fetched
  to a temporary file and it hands back bytes.

An operation that raises answers with `{"error": …}` and exit code 0: a PDF
with no figures is a normal answer, not a crash, and the parent already
distinguishes the two. A crash needs no protocol — the exit code is the signal.
"""

from __future__ import annotations

import base64
import json
import sys
from pathlib import Path
from typing import Any


def _encode(value: Any) -> Any:
    """JSON-safe form of a result. `bytes` is the only thing JSON cannot hold."""
    if isinstance(value, bytes):
        return {"__bytes__": base64.b64encode(value).decode("ascii")}
    if isinstance(value, dict):
        return {key: _encode(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_encode(item) for item in value]
    return value


def _capture_candidate(payload: dict[str, Any]) -> Any:
    from .pdf_figures import capture_candidate

    return capture_candidate(
        Path(payload["path"]),
        str(payload["identifier"]),
        max_side=int(payload["maxSide"]),
    )


def _source_inventory(payload: dict[str, Any]) -> Any:
    from .source_inventory import pdf_source_inventory

    return pdf_source_inventory(Path(payload["path"]), str(payload["extractedText"]))


#: The whole of what a child may be asked to do. A name that is not here exits
#: non-zero, which the parent reports as a failed pass rather than a bad
#: request — there is no caller that can send one by accident.
def _plan_page(payload):
    import io
    import pypdfium2 as pdfium
    document = pdfium.PdfDocument(str(payload["path"]))
    try:
        index = int(payload["page"]) - 1
        if not 0 <= index < len(document):
            raise ValueError("Page outside document")
        page = document[index]
        try:
            scale = min(2.0, 1600 / max(page.get_size()))
            bitmap = page.render(scale=scale)
            try:
                output = io.BytesIO()
                bitmap.to_pil().save(output, format="PNG")
                value = output.getvalue()
                if len(value) > 8_000_000:
                    raise ValueError("Rendered page exceeds capture limit")
                return value
            finally:
                bitmap.close()
        finally:
            page.close()
    finally:
        document.close()


def _pdf_thumbnail(payload: dict[str, Any]) -> Any:
    """The first page as a library card's WebP: rendered, fitted and encoded here.

    `dashboard.make_pdf_thumbnail` used to render in the server, on a worker
    thread per upload. Two PDFs uploaded together rendered at once, PDFium is
    not thread-safe, and the backend died in `FPDF_RenderPageBitmap →
    CFX_Face::RenderGlyph → TT_Load_Context` freeing a pointer it never
    allocated. Only bytes leave, so the encoding is the card's own.
    """
    import pypdfium2 as pdfium

    from .pdf_figures import encode_thumbnail

    document = pdfium.PdfDocument(str(payload["path"]))
    try:
        page = document[0]
        try:
            bitmap = page.render(scale=1.35)
            try:
                return encode_thumbnail(bitmap.to_pil())
            finally:
                bitmap.close()
        finally:
            page.close()
    finally:
        document.close()


def _source_pdf(payload: dict[str, Any]) -> Any:
    """A linked PDF's page count, title and page text; no text past the page limit."""
    from pypdf import PdfReader

    reader = PdfReader(str(payload["path"]))
    count = len(reader.pages)
    if count > int(payload["maxPages"]):
        return {"pageCount": count, "pages": None, "title": ""}
    budget, pages, truncated = int(payload["maxChars"]), [], False
    for page in reader.pages:
        if budget <= 0:
            # Past the cap a page is not extracted at all: None, unknown, never
            # read as a page without text.
            truncated = True
            pages.append(None)
            continue
        try:
            text = (page.extract_text() or "").strip()
        except Exception:
            # A page that will not extract is unknown, not absent: it reads as
            # empty and the rest of the document is still served.
            text = ""
        truncated = truncated or len(text) > budget
        text = text[:budget]
        budget -= len(text)
        pages.append(text)
    title = str(reader.metadata.title or "").strip() if reader.metadata else ""
    return {"pageCount": count, "pages": pages, "title": title[:240], "truncated": truncated}


def _page_figure(payload: dict[str, Any]) -> Any:
    from .pdf_figures import capture_page_figure

    return capture_page_figure(
        Path(payload["path"]), int(payload["page"]), str(payload["label"]), str(payload.get("opening", "")), max_side=int(payload["maxSide"])
    )


OPERATIONS = {
    "plan_page": _plan_page,
    "source_pdf": _source_pdf,
    "page_figure": _page_figure,
    "pdf_thumbnail": _pdf_thumbnail,
    "capture_candidate": _capture_candidate,
    "source_inventory": _source_inventory,
}


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("usage: python -m delphi_core.pdf_worker <request> <response>", file=sys.stderr)
        return 64
    request = json.loads(Path(argv[1]).read_text(encoding="utf-8"))
    operation = OPERATIONS.get(str(request.get("operation")))
    if operation is None:
        print(f"unknown operation {request.get('operation')!r}", file=sys.stderr)
        return 64
    try:
        body = {"result": _encode(operation(request.get("payload") or {}))}
    except Exception as exc:
        body = {"error": f"{type(exc).__name__}: {exc}"}
    Path(argv[2]).write_text(json.dumps(body), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
