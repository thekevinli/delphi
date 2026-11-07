"""How a stored PDF reaches the model: a provider file, or inline bytes.

A provider with a Files API gets each PDF uploaded once and referenced by id
afterwards. A provider without one (`Settings.openai_files_enabled` off) is sent
the PDF inline on every request instead, and the stored id is left alone, so an
id only ever names a file in the store that minted it. A deployment that moves
between the two therefore never re-uploads on the way back and never strands a
file it can no longer delete.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass
from typing import Any

import httpx
from starlette.concurrency import run_in_threadpool

from .storage import ObjectStore, paper_key


@dataclass(frozen=True)
class InlinePdf:
    """A PDF sent as request bytes rather than by provider file id."""

    filename: str
    data_url: str


PdfSource = str | InlinePdf


def pdf_input_block(source: PdfSource, *, detail: str = "low") -> dict[str, Any]:
    if isinstance(source, InlinePdf):
        return {
            "type": "input_file",
            "filename": source.filename,
            "file_data": source.data_url,
            "detail": detail,
        }
    return {"type": "input_file", "file_id": source, "detail": detail}


async def inline_pdf(
    objects: ObjectStore, username: str, project_id: str, paper: dict[str, Any]
) -> InlinePdf:
    key = paper_key(username, project_id, paper["id"], "pdf")

    def read() -> bytes:
        path = objects.fetch_to_tempfile(key)
        try:
            return path.read_bytes()
        finally:
            path.unlink(missing_ok=True)

    payload = await run_in_threadpool(read)
    return InlinePdf(
        filename=paper.get("filename") or f"{paper['id']}.pdf",
        data_url="data:application/pdf;base64," + base64.b64encode(payload).decode("ascii"),
    )


def provider_file_missing(response: httpx.Response, file_ids: list[str]) -> bool:
    """Whether a refusal says one of these stored provider files is gone.

    Provider files expire and are deleted independently of Delphi's record, and
    an id minted by one provider means nothing to another. Either way the PDF
    itself is still here, so the answer is to upload it again, not to fail.
    """
    if response.status_code != 404 or not file_ids:
        return False
    detail = response.text
    return "file" in detail.casefold() or any(file_id in detail for file_id in file_ids)
