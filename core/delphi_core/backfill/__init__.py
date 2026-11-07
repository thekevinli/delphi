"""
Bulk maintenance commands, and the small amount of scaffolding they share.

    backend/.venv/bin/python -m delphi_core.backfill.digests --dry-run
    backend/.venv/bin/python -m delphi_core.backfill.thumbnails --dry-run
    backend/.venv/bin/python -m delphi_core.backfill.memory
    backend/.venv/bin/python -m delphi_core.backfill.index

Each module here is the bulk half of something the product also does lazily, one
document at a time, in the foreground: `index` to `index_paper_sections_safely`,
`thumbnails` to `ensure_document_thumbnail` on Reader engagement, `memory` to the durable queue a reader's tab drains, and
`digests` to the rebuild a filing performs when it finds a digest older than
`RESEARCH_DIGEST_VERSION`.
They exist because the lazy half only reaches a document somebody opens, and a
renderer version bump, a bulk import or a field added after the fact leaves a
whole library behind at once.

Two rules hold for all of them, and both are the reason re-running is safe:

  * Call the shipped routine, never a second copy of it. A skip test or a
    wording rule that exists twice will differ eventually, and the bulk copy is
    the one nobody reads again.
  * Write only the field being backfilled, and never delete. A document the
    pass cannot handle is reported and left alone, so it stays eligible for the
    next run instead of being stamped with a failure.

A product runs them on its own stores through `run`:

    run("memory", settings, stores, ["--force", "--dry-run"])

Run as `python -m`, a command opens the reference app's stores: the local
store under `DATA_DIR`, whatever else the environment names. A product's
stores are reached only through `run`, from that product's own command, so a
deployment's maintenance goes through the product and never through these.
"""

import argparse
from collections.abc import Iterator, Sequence
from contextvars import ContextVar
from importlib import import_module
from typing import Any

from ..config import Settings, load_settings
from ..storage import ObjectStore, Storage, local_format
from ..stores import Stores

__all__ = ["COMMANDS", "run"]

#: The commands `run` runs: each opens its stores through `open_stores`, and
#: its `main(argv)` takes the flags its `python -m` form does.
COMMANDS = ("index", "thumbnails", "digests", "memory", "memory_rebuild")

#: The settings and stores `run` bound for the command running in this context.
_BOUND: ContextVar[tuple[Settings, Stores] | None] = ContextVar("backfill_stores", default=None)


def run(command: str, settings: Settings, stores: Stores, argv: Sequence[str] = ()) -> int:
    """Run one of `COMMANDS` on these stores, with these flags; its exit status.

    The binding lasts for the command and is undone after it, however it ends.
    """
    if command not in COMMANDS:
        raise ValueError(f"{command!r} is not a backfill command; one of {', '.join(COMMANDS)}")
    token = _BOUND.set((settings, stores))
    try:
        return import_module(f"{__name__}.{command}").main(list(argv))
    finally:
        _BOUND.reset(token)


def default_stores() -> tuple[Settings, Stores]:
    """What a command opens when no product bound its stores: the reference app's, the local ones."""
    return load_settings(), Stores.local()


def build_parser(
    description: str, *, dry_run: str | None = None, force: str | None = None
) -> argparse.ArgumentParser:
    """The flags every command in this package answers to, spelled once."""
    # Raw, because the description is the module's own docstring and reflowing
    # it collapses the command lines at the top into one unusable paragraph.
    parser = argparse.ArgumentParser(
        description=description, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--user", action="append", dest="users", default=None)
    if dry_run:
        parser.add_argument("--dry-run", action="store_true", help=dry_run)
    if force:
        parser.add_argument("--force", action="store_true", help=force)
    parser.add_argument("--quiet", action="store_true")
    return parser


def open_stores() -> tuple[Settings, Storage, ObjectStore]:
    """The settings and stores this command runs on: the ones `run` bound, or the default.

    One place decides which backend is in play, and a maintenance command that
    decided for itself would be the obvious way to rewrite the wrong store.

    A local store is opened only at the format this code writes. Opening one
    that is behind would migrate it here, and the step to format 5 renames the
    Memory directory under an app that may have the same profile open; one
    that is ahead was written by a newer release. Both are refused, before
    anything is opened.
    """
    settings, stores = _BOUND.get() or default_stores()
    if stores.is_local:
        refused = local_format.not_current(settings.data_dir)
        if refused:
            raise SystemExit(
                f"Not run: this command works only on a local store at format {local_format.LOCAL_FORMAT}.\n"
                + "\n".join(f"  {username}: {why}" for username, why in refused.items())
            )
    return settings, stores.storage(settings), stores.objects(settings)


def accounts(storage: Storage, args: argparse.Namespace) -> Iterator[str]:
    """Every account, or the ones `--user` named, announcing each as it starts."""
    for username in args.users or storage.list_usernames():
        print(f"user {username}")
        yield username


def documents(
    storage: Storage, username: str
) -> Iterator[tuple[dict[str, Any], dict[str, Any]]]:
    """Every (project, paper) this account holds, in one read.

    `list_projects` followed by `get_project` per row is the same N+1 that cost
    the Dashboard four seconds against Cloud SQL (invariant 57a). A command that
    walks the whole library is the last place that should pay it.
    """
    for project in storage.list_projects_with_papers(username):
        for paper in project.get("papers", []):
            yield project, paper


def footer(storage: Storage, summary: str) -> int:
    """The closing lines every command prints, including which store was touched."""
    print(f"\n{summary}")
    print(f"storage {storage.kind}")
    return 0
