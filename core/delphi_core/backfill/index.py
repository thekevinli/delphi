"""
Rebuild the raw-layer search index from the stored documents.

    backend/.venv/bin/python -m delphi_core.backfill.index            # every account
    backend/.venv/bin/python -m delphi_core.backfill.index --user ada # one account

Run once after `b3e07c5a91d4` lands, and any time the index is suspected of
being stale. It is a rebuild, not a repair: every document's rows are replaced
by what its `.txt`/`.web` object says right now, so running it twice produces
exactly the same index as running it once. That idempotence is the point — the
index is derived, and a derived thing that cannot be safely rebuilt is a second
copy of the truth wearing a disguise.

A document whose bytes are missing is reported and skipped rather than emptying
its rows. The stored objects are the authority; a transient read failure must
not be allowed to quietly erase a paper from search.
"""

import argparse
import sys

from ..routers.projects import index_paper_sections
from ..storage import ObjectStore, Storage
from . import accounts, build_parser, documents, footer, open_stores


def backfill_account(
    storage: Storage, objects: ObjectStore, username: str, verbose: bool
) -> tuple[int, int]:
    """Rebuild every document this account holds. Returns (documents, sections)."""
    indexed = sections = 0
    for project, paper in documents(storage, username):
        try:
            count = index_paper_sections(
                storage, objects, username, project["id"], paper
            )
        except Exception as error:
            print(
                f"  ! {project['name']} / {paper.get('title')}: {error}",
                file=sys.stderr,
            )
            continue
        indexed += 1
        sections += count
        if verbose:
            print(f"  · {project['name']} / {paper.get('title')}: {count} sections")
    return indexed, sections


def run(args: argparse.Namespace) -> int:
    _, storage, objects = open_stores()
    verbose = not args.quiet

    counted = rows = 0
    for username in accounts(storage, args):
        indexed, sections = backfill_account(storage, objects, username, verbose)
        counted += indexed
        rows += sections
    return footer(storage, f"{counted} documents · {rows} sections")


def main(argv: list[str] | None = None) -> int:
    return run(build_parser(__doc__).parse_args(argv))


if __name__ == "__main__":
    raise SystemExit(main())
