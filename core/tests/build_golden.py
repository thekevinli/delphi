"""
The golden Memory library: one account's Memory as a release wrote it, and
what every Memory, conversation and plan route answered for it.

A migration of stored Memory (a local format step) is proven on data an
older release wrote, not on data the new code writes for itself. This is that data, small and synthetic: three self-made documents
filed by the shipped pipeline against the journey rig's scripted provider
(`rig_library`), with every kind of thing Memory stores:

    pages of all three kinds     source pages from digests, concept pages the
                                 agent wrote, a domain page its job composed
    links and a figure           `[[links]]` among them; a figure captured
                                 from a republished digest
    page versions                a concept page edited by a second document,
                                 by a document chat and by a reader's note
    a pending job                the document job that republish queued
    conversations                a document chat, a Memory chat
                                 (`memory_chat`) and the plan it saved
    notes                        a highlight and a note, filed by its session

The steps run through `LocalStorage`, and what they wrote is kept as written:

    data/golden/local/           the local store, a whole data directory
    data/golden/manifest.json    the release and local format that wrote it

with the kit's `delphi_core_testkit/data/golden/snapshot.json`, every route's
answer, normalized (`delphi_core_testkit.golden`). `test_golden_memory.py`
opens the library and asks for the snapshot, and a product reads its own
store's copy of the library against the same snapshot. Ids and times differ
from one build to the next, so the snapshot names them by placeholder.

Rebuild only when the golden should be written by a newer release; it writes
a new library and a new snapshot, and a product's copy is then held to the
new snapshot. Run from `core/`:

    python -m tests.build_golden

When a route's answer changed on purpose and the library should stay as it
was written, record the snapshot again from the committed library, and read
its diff as the change it is:

    python -m tests.build_golden --snapshot-only
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any

# How a library is asked, and what the snapshot holds, are the kit's: a product
# reads its own copy of the library the same way (`delphi_core_testkit.golden`).
from delphi_core_testkit.golden import SECRET, SNAPSHOT, USERNAME, golden_settings, normalize, responses, signed_in

GOLDEN = Path(__file__).resolve().parent / "data" / "golden"
#: The documents, by id and title. The rig's provider files a "Shared Idea
#: Study <t>" series into one concept page and any other title into a page of
#: its own (`rig_library`). Ids carry letters outside hex, so `normalize`
#: never mistakes one for a generated id.
PAPERS = (
    ("goldenpapera", "Shared Idea Study g7 A"),
    ("goldenpaperb", "Shared Idea Study g7 B"),
    ("goldenpaperc", "Cache Notes"),
)
FIGURE_PAPER = "goldenpaperb"
NOTE_PAPER = "goldenpaperc"


# --- reading a library ------------------------------------------------------


def read_local(library: Path) -> dict[str, Any]:
    """Open a copy of a local library and ask it everything. A store migrates on open, so never the original."""
    from delphi_core.storage import LocalObjectStore, LocalStorage

    with tempfile.TemporaryDirectory(prefix="delphi-golden-") as scratch:
        data = Path(scratch) / "data"
        shutil.copytree(library, data)
        settings = golden_settings(data)
        storage = LocalStorage(settings)
        with signed_in(settings, storage, LocalObjectStore(data, settings.chat_image_retention_days)) as client:
            return normalize(responses(client, storage))


# --- writing a library --------------------------------------------------------


def _stream(client, body: dict[str, Any]) -> None:
    """Ask one question through `/api/chat/stream` and insist the answer was whole."""
    response = client.post("/api/chat/stream", json=body)
    frames = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: {")]
    assert response.status_code == 200 and frames, response.text[:2000]
    failed = [frame for frame in frames if frame.get("type") == "error"]
    assert not failed, failed


async def _drain(rig) -> list[dict[str, Any]]:
    from delphi_core.backfill.memory import drain_account

    runs = await drain_account(rig.storage, rig.objects, rig.settings, USERNAME, verbose=False, workers=1)
    failed = [run for run in runs if run["outcome"] == "failed"]
    assert not failed, failed
    return runs


async def _republish_with_a_figure(rig) -> None:
    """
    Publish the figure paper's digest again with one captured picture.

    The rig's documents hold text and no picture, so its digests capture
    none. This is what `generate_digest` does with a captured asset: the
    asset's bytes under its digest key, the envelope written with it, then
    `file_republished_digest`, which rewrites the source page with the
    figure and queues the document's job for the new digest. That job is the
    library's pending one: nothing drains it.
    """
    from PIL import Image

    from delphi_core.memory import file_republished_digest
    from delphi_core.research_digest import DigestAsset, digest_asset_key, load_digest
    from delphi_core.storage import paper_key

    key = paper_key(USERNAME, rig.project, FIGURE_PAPER, "digest")
    envelope = json.loads(rig.objects.get_text(key))
    picture = io.BytesIO()
    image = Image.new("RGB", (24, 12), "white")
    for column in range(4, 9):
        for row in range(4, 12):
            image.putpixel((column, row), (40, 90, 160))
    for column in range(14, 19):
        for row in range(8, 12):
            image.putpixel((column, row), (200, 120, 40))
    image.save(picture, format="WEBP", lossless=True)
    payload = picture.getvalue()
    asset = DigestAsset(
        id="goldenfigurone", inventoryId="pdf-figure-1", caption="Median latency, stable against shuffled prefix.",
        alt="Two bars: the stable prefix is half the height of the shuffled one.",
        teachingValue="Shows the one comparison the document reports.", afterEvidenceId=1,
        kind="source-figure", page=2, mimeType="image/webp", width=24, height=12, bytes=len(payload),
    ).model_dump()
    with tempfile.NamedTemporaryFile(suffix=".webp") as handle:
        handle.write(payload)
        handle.flush()
        rig.objects.put_file(digest_asset_key(USERNAME, rig.project, FIGURE_PAPER, asset["id"], asset["mimeType"]),
                             Path(handle.name), asset["mimeType"])
    envelope["digest"]["assets"] = [asset]
    rig.objects.put_text(key, json.dumps(envelope, ensure_ascii=False))
    paper = rig.storage.get_paper(USERNAME, rig.project, FIGURE_PAPER)
    digest = load_digest(rig.objects, USERNAME, rig.project, FIGURE_PAPER)
    await file_republished_digest(rig.objects, rig.storage, USERNAME, rig.project, paper, digest, rig.settings)


def write_library(rig) -> None:
    """
    The library's steps, the same whichever store `rig` writes to.

    Each step is a shipped path: the drain (`drain_account`) files the
    documents and then the sessions; questions go through `/api/chat/stream`;
    notes through the notes route.
    """
    from delphi_core.storage import paper_key
    from delphi_core.storage.base import utc_now
    from tests.rig_library import TEXT, provider

    rig.storage.session_idle_seconds = 0
    rig.storage.domain_settle_seconds = 0
    for paper_id, title in PAPERS:
        # `rig.pdf`, with the time the upload route stamps on its record.
        rig.storage.add_paper(USERNAME, rig.project, {
            "id": paper_id, "title": title, "filename": f"{paper_id}.pdf", "pages": 2, "tokens": 20, "bytes": 100,
            "createdAt": utc_now(),
        })
        rig.objects.put_text(paper_key(USERNAME, rig.project, paper_id, "txt"), TEXT)
        rig.storage.set_openai_file(USERNAME, rig.project, paper_id, f"file-{paper_id}")
    asyncio.run(_drain(rig))

    with signed_in(rig.settings, rig.storage, rig.objects) as client:
        where = f"/api/projects/{rig.project}/papers/{NOTE_PAPER}"
        stroke = client.post(f"{where}/highlights", json={
            "type": "pdf", "page": 2, "text": "Stable prefix: 120 ms. Shuffled prefix: 240 ms.", "color": "yellow",
            "rects": [{"x": 0.1, "y": 0.2, "w": 0.5, "h": 0.03}],
        })
        assert stroke.status_code == 201, stroke.text
        note = client.post(f"{where}/notes", json={
            "highlightId": stroke.json()["id"], "page": 2, "anchorY": 0.2,
            "quotedText": "Stable prefix: 120 ms. Shuffled prefix: 240 ms.",
            "body": "One comparison, twenty requests: too few to call it a speedup.",
        })
        assert note.status_code == 201, note.text

        document = {"scope": "document", "project_id": rig.project, "paper_id": NOTE_PAPER}
        chat = client.post("/api/chat/conversations", json={**document, "creation_key": "golden_document_chat"}).json()
        _stream(client, {**document, "conversation_id": chat["id"], "generation": chat["generation"],
                         "request_id": "golden_ask_document", "prompt": "Worth keeping: does the prefix survive a new question?"})

        memory = client.post("/api/chat/conversations", json={"scope": "general", "creation_key": "golden_memory_chat"}).json()
        general = {"scope": "general", "conversation_id": memory["id"], "generation": memory["generation"]}
        _stream(client, {**general, "request_id": "golden_ask_memory", "prompt": "What have I read about prefix reuse?"})
        _stream(client, {**general, "request_id": "golden_ask_plan", "mode": "plan",
                         "prompt": "Plan an experiment that measures prefix reuse."})
    asyncio.run(_drain(rig))
    asyncio.run(_republish_with_a_figure(rig))
    assert provider.refusals == [], provider.refusals

    # A wait still running when the golden was written ends some day later,
    # and the snapshot would change under it. Only jobs due now stay.
    from datetime import UTC, datetime

    later = [job for job in rig.storage.list_memory_jobs(USERNAME)
             if job.get("retryAt") and datetime.fromisoformat(job["retryAt"]) > datetime.now(UTC)]
    assert not later, later
    pending = [(job["kind"], job["marker"]) for job in rig.storage.list_memory_jobs(USERNAME)]
    assert pending == [("document", f"paper:{FIGURE_PAPER}")], pending


@contextlib.contextmanager
def rig_over(data_dir: Path):
    """The journey rig's provider and a local store, wired as `Rig` wires them, outside pytest."""
    import importlib

    import pytest

    # Before the rig replaces `httpx.AsyncClient` with a function: a module
    # imported after it annotates with that function and fails, which a test
    # never sees because pytest imports the app first.
    for module in ("delphi_core.main", "delphi_core.backfill.memory"):
        importlib.import_module(module)
    from tests.rig_library import Rig, provider

    with pytest.MonkeyPatch.context() as patch:
        from itertools import count

        # The fixture numbers its calls and responses from one module-level
        # counter. From one, so every build numbers them alike.
        patch.setattr(provider, "sequence", count(1))
        yield Rig(data_dir, patch, memory_drain_workers=1, session_secret=SECRET, digest_research_enabled=False)


def build_local(into: Path) -> None:
    with tempfile.TemporaryDirectory(prefix="delphi-golden-") as scratch:
        data = Path(scratch) / "data"
        with rig_over(data) as rig:
            write_library(rig)
        shutil.rmtree(into, ignore_errors=True)
        shutil.copytree(data, into)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--snapshot-only", action="store_true",
                        help="record the snapshot again from the committed library, writing no library")
    args = parser.parse_args()

    if not args.snapshot_only:
        import tomllib

        from delphi_core.memory import MEMORY_VERSION
        from delphi_core.storage.local_format import LOCAL_FORMAT

        build_local(GOLDEN / "local")
        # The checkout's version, not an installed package's: the two differ in a shared venv.
        release = tomllib.loads((Path(__file__).resolve().parents[1] / "pyproject.toml").read_text())["project"]["version"]
        manifest = {"backend": release, "localFormat": LOCAL_FORMAT, "memoryVersion": MEMORY_VERSION, "username": USERNAME}
        (GOLDEN / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")

    local = read_local(GOLDEN / "local")
    SNAPSHOT.write_text(json.dumps(local, indent=1, sort_keys=True, ensure_ascii=False) + "\n")
    print(f"Wrote {SNAPSHOT}: {len(local)} routes")
    return 0


if __name__ == "__main__":
    # What conftest sets for the suite: no provider unless one is named, and
    # no research pass a digest did not ask for.
    for name in list(os.environ):
        if name.startswith(("OPENAI_", "MODEL_", "KNOWLEDGE_", "MEMORY_")):
            os.environ.pop(name)
    os.environ["OPENAI_API_KEY"] = ""
    os.environ["DIGEST_RESEARCH_ENABLED"] = "false"
    sys.exit(main())
