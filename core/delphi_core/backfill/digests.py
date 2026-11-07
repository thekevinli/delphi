"""
Rebuild the research digest for every document behind the current version.

    backend/.venv/bin/python -m delphi_core.backfill.digests --dry-run
    backend/.venv/bin/python -m delphi_core.backfill.digests
    backend/.venv/bin/python -m delphi_core.backfill.digests --user ada
    backend/.venv/bin/python -m delphi_core.backfill.digests --force

The bulk half of the rebuild a `document` job already does for one document:
the job checks `digest_is_current` first and, finding a digest from an older
prompt, rebuilds it before it files anything. That is correct and it is also
invisible: the reader presses *File it now* on one paper and waits through a
full generation they did not ask for and were not told about, once per stale
document, forever.

The wait is not small. `RESEARCH_DIGEST_VERSION` is `research-digest-v6`, which
targets 2,000–2,800 words at `DIGEST_REASONING_EFFORT`; on the library this was
written for, v6 digests averaged ~7,000 estimated tokens against ~1,700 for the
v2 ones they replaced. Four times the artifact, and minutes of it.

So this exists to move that cost off the reader's click and into a run they
started deliberately. **It spends real money** — one digest per stale document,
at the orchestrator's effort and output budget. `--dry-run` first; it prints
what is stale and at which version, and writes nothing.

**A rebuilt digest is filed.** Publishing a digest derives the document's
source page from it and queues the document's `document` job with the digest's
fingerprint (`memory.file_republished_digest`), so every digest this
rebuilds leaves a job behind, and the run says how many are waiting. They are
drained by a reader's tab or by `delphi_core.backfill.memory --drain`, which finds
each job under the document's marker and adds no second one: a digest
backfill followed by a filing backfill files each document once. A republish
that came out the same as the digest the document's last job read queues
nothing, so `--force` over a library that is already filed costs the digests
and files only the documents whose digest changed.

Two shipped routines do the work, per this package's first rule:

  * `digest_metadata_is_current` is the skip test, the same one the filing route
    consults. A second copy would drift, and the drift would show up as a
    library this command reported clean and filing rebuilt anyway.
  * `generate_digest` builds it, so claims, provider retries, the one
    correction attempt and the reuse path all behave exactly as they do in the
    foreground. It takes `current`/`total` because it was already written to be
    driven in a batch.

Safe to repeat and safe to interrupt. A digest is claimed for the length of its
build and released on the way out, so Ctrl-C leaves a claim that expires rather
than a half-written digest; a document that fails is reported and left alone,
which keeps it eligible for the next run instead of stamped with a failure. A
document whose extracted text is unreadable can never produce a digest and is
skipped with a reason rather than retried forever.

Running it while a reader has the app open is fine — `generate_digest` waits out
another tab's claim rather than fighting it — but the two are spending on the
same account at the same time.
"""

import argparse
import asyncio
import sys
from typing import Any

import httpx

from ..config import Settings
from ..memory_maintenance.jobs import DOCUMENT
from ..research_digest import (
    RESEARCH_DIGEST_VERSION,
    digest_metadata_is_current,
    generate_digest,
)
from ..storage import ObjectStore, Storage
from . import accounts, build_parser, documents, footer, open_stores


def stale_documents(
    storage: Storage, settings: Settings, username: str, *, force: bool
) -> list[tuple[dict[str, Any], dict[str, Any]]]:
    """Every document this account holds whose digest is not current.

    Materialised rather than streamed so the run knows its own denominator:
    `generate_digest` takes `current`/`total` and puts them on the progress it
    yields, and "document 4 of 17" is the only thing that makes a multi-minute
    per-document wait legible.
    """
    pending = []
    for project, paper in documents(storage, username):
        if digest_metadata_is_current(paper, settings) and not force:
            continue
        pending.append((project, paper))
    return pending


def describe(paper: dict[str, Any]) -> str:
    """Which version a stale document is on, for the dry run's tally."""
    digest = paper.get("digest") or {}
    if not digest:
        return "(none)"
    if digest.get("status") != "ready":
        return f"({digest.get('status') or 'unbuilt'})"
    return str(digest.get("version") or "(unversioned)")


async def rebuild_account(
    storage: Storage,
    objects: ObjectStore,
    settings: Settings,
    username: str,
    *,
    dry_run: bool,
    force: bool,
    verbose: bool,
) -> tuple[int, int, int]:
    """Returns (considered, rebuilt, failed)."""
    account = storage.get_account(username) or {}
    use_standard_tier = bool(account.get("useStandardTier", True))
    pending = stale_documents(storage, settings, username, force=force)
    total = len(pending)
    if not total:
        return 0, 0, 0

    if dry_run:
        for project, paper in pending:
            if verbose:
                print(
                    f"  · would rebuild {describe(paper):>22} → "
                    f"{RESEARCH_DIGEST_VERSION}: {project['name']} / {paper['title']}"
                )
        return total, total, 0

    rebuilt = failed = 0
    timeout = httpx.Timeout(settings.digest_timeout_seconds, connect=20)
    async with httpx.AsyncClient(timeout=timeout) as client:
        for index, (project, paper) in enumerate(pending, start=1):
            was = describe(paper)
            try:
                reused = False
                async for event in generate_digest(
                    client,
                    storage,
                    objects,
                    username,
                    project["id"],
                    paper["id"],
                    settings,
                    force=force,
                    current=index,
                    total=total,
                    use_standard_tier=use_standard_tier,
                ):
                    if event["type"] == "_digest_ready":
                        reused = bool(event.get("reused"))
                    elif verbose and event.get("type") == "progress":
                        # The stage line, rewritten to fit one row of a batch:
                        # every frame names the document, which is what the
                        # single-document stream needs and what a numbered list
                        # already says.
                        message = str(event.get("message") or "")
                        title = str(paper.get("title") or "")
                        if title:
                            message = message.replace(title, "it")
                        print(f"    {index}/{total} {message}", flush=True)
            except Exception as exc:  # noqa: BLE001 - reported, never fatal
                failed += 1
                print(
                    f"  ! {project['name']} / {paper['title']}: {exc}",
                    file=sys.stderr,
                    flush=True,
                )
                # Left exactly as it was, so the next run picks it up again.
                continue
            rebuilt += 1
            if verbose:
                outcome = "reused" if reused else f"{was} → {RESEARCH_DIGEST_VERSION}"
                print(f"  · {project['name']} / {paper['title']}: {outcome}")
    return total, rebuilt, failed


async def run(args: argparse.Namespace) -> int:
    settings, storage, objects = open_stores()
    verbose = not args.quiet

    if not args.dry_run and not settings.api_key:
        print("No API key is configured; building digests needs one.", file=sys.stderr)
        return 2

    considered = rebuilt = failed = queued = 0
    for username in accounts(storage, args):
        seen, built, lost = await rebuild_account(
            storage,
            objects,
            settings,
            username,
            dry_run=args.dry_run,
            force=args.force,
            verbose=verbose,
        )
        considered += seen
        rebuilt += built
        failed += lost
        if not args.dry_run:
            queued += sum(job["kind"] == DOCUMENT for job in storage.list_memory_jobs(username))

    prefix = "would rebuild " if args.dry_run else "rebuilt "
    summary = (
        f"{considered} stale documents · {prefix}{rebuilt} "
        f"digests at {RESEARCH_DIGEST_VERSION}"
    )
    if failed:
        summary += f"\n{failed} left for a later run"
    if not args.dry_run and settings.memory_enabled:
        summary += (
            f"\n{queued} document jobs are queued for Memory; "
            "`delphi_core.backfill.memory --drain` runs them here"
        )
    return footer(storage, summary)


def main(argv: list[str] | None = None) -> int:
    return asyncio.run(
        run(
            build_parser(
                __doc__,
                dry_run="report what is stale and at which version; write nothing",
                force="rebuild every document, including ones already current",
            ).parse_args(argv)
        )
    )


if __name__ == "__main__":
    raise SystemExit(main())
