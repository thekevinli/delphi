"""
Generate every document preview the lazy path has not reached yet.

    backend/.venv/bin/python -m delphi_core.backfill.thumbnails --dry-run
    backend/.venv/bin/python -m delphi_core.backfill.thumbnails
    backend/.venv/bin/python -m delphi_core.backfill.thumbnails --user ada

A thumbnail is derived, so this is a rebuild rather than a repair. It keeps
earning its place three ways:

  * A document's preview is otherwise generated on its **first Reader open** and
    nowhere else, so a library nobody has re-opened shows the flat fallback card
    on every Dashboard until each document is visited.
  * `WEB_THUMBNAIL_VERSION` advances with renderer fixes. `ensure_document_thumbnail`
    treats an older version as missing, so a renderer change makes every web
    capture stale and this is how they are refreshed without opening 55 tabs.
  * A bulk import lands documents nobody has opened yet.

It writes only `thumbnailAvailable`, `thumbnailVersion` and
`thumbnailAttemptedAt` on a paper. A capture that failed is retried on the
next Reader open (a new engagement resets the three-attempt budget);
`--force` retries every one of them now, which is the deliberate answer to
"the host was down when I imported these".

No model calls. A PDF renders locally through pypdfium2; a web document re-fetches
its page and drives headless Chromium, so `--dry-run` is worth running first to
see the split before spending the wall clock.
"""

import argparse
import asyncio

from ..config import Settings
from ..dashboard import ensure_document_thumbnail_safely, thumbnail_is_due
from ..storage import ObjectStore, Storage
from . import accounts, build_parser, documents, footer, open_stores


async def backfill_account(
    storage: Storage,
    objects: ObjectStore,
    settings: Settings,
    username: str,
    *,
    dry_run: bool,
    force: bool,
    verbose: bool,
) -> tuple[int, int]:
    """Returns (documents considered, thumbnails generated)."""
    considered = generated = 0
    for project, paper in documents(storage, username):
        considered += 1
        kind = paper.get("kind")
        # The same predicate the engagement's follow-up retries apply, so what
        # a dry run reports and what a real run does cannot disagree. A new
        # Reader open resets the attempt count first; this pass does not.
        if not force and not thumbnail_is_due(paper):
            continue
        if dry_run:
            generated += 1
            if verbose:
                how = "chromium" if kind == "web" else "pypdfium2"
                print(f"  · would capture [{how}] {project['name']} / {paper['title']}")
            continue
        # Not `ensure_document_thumbnail`: a web capture reaches a third party,
        # and one host that hangs or serves something Pillow cannot read must
        # not take the rest of the library down with it.
        made = await ensure_document_thumbnail_safely(
            storage, objects, settings, username, project["id"], paper, force
        )
        if made:
            generated += 1
        if verbose:
            print(
                f"  · {project['name']} / {paper['title']}: "
                f"{'captured' if made else 'skipped or unavailable'}"
            )
    return considered, generated


async def run(args: argparse.Namespace) -> int:
    settings, storage, objects = open_stores()
    verbose = not args.quiet

    counted = made = 0
    for username in accounts(storage, args):
        seen, captured = await backfill_account(
            storage, objects, settings, username,
            dry_run=args.dry_run, force=args.force, verbose=verbose,
        )
        counted += seen
        made += captured
    prefix = "would capture " if args.dry_run else ""
    return footer(storage, f"{counted} documents · {prefix}{made} thumbnails")


def main(argv: list[str] | None = None) -> int:
    return asyncio.run(
        run(
            build_parser(
                __doc__,
                dry_run="report the work; capture nothing",
                force="re-capture documents that already have a preview",
            ).parse_args(argv)
        )
    )


if __name__ == "__main__":
    raise SystemExit(main())
