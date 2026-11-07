"""Build the backend artifacts and validate their release identity, without publishing.

The Python package owns its version. A vX.Y.Z Git tag selects a tested commit of
this repository, whose GitHub releases are the catalog a build compares with: the
latest published vX.Y.Z before it is the previous release. The first release, with
no earlier one in the catalog, is built compared with nothing, and says so.
Only this module knows the tag convention and the wheels' layout and allowed payloads.

A build makes two wheels from one commit: core's, and the test kit's
(`core/testkit`), at core's version and pinned to exactly that core. A product
proves itself against the kit of the core it pins. Beside them it publishes
`public-surface.txt`, what a product may import from that core (Plan 4 A3);
`surface` classifies this build's against the previous release's, as oasdiff
does the HTTP API: a breaking change needs a compatibility boundary.
"""
from __future__ import annotations

import argparse
from email.parser import BytesParser
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import tomllib
import zipfile

ROOT = Path(__file__).resolve().parents[1]
VERSION = re.compile(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\Z")
TAG_PREFIX = "v"
#: A core wheel's (package, dist-info stem, distribution name).
CORE_LAYOUT = ("delphi_core", "delphi_core", "delphi-core")
#: What a core wheel must carry that no import of its package would miss: the PDF
#: and artifact workers a child process runs by module name, with what the artifact
#: worker imports and the inspector it injects, the scripts injected into a framed
#: page, and the contracts the maintenance stages read at import. Each one, missing
#: from the wheel, passes every test in the checkout and fails the installed app.
RUNTIME_FILES = {f"{CORE_LAYOUT[0]}/{name}" for name in (
    "main.py", "pdf_worker.py", "web_bridge.js", "web_revision.py",
    "web_annotations.js", "web_annotation_worker.js", "web_annotation_bridge.js",
    *(f"artifacts/{name}" for name in ("render.py", "worker.py", "cdp.py", "types.py", "inspect.js")),
    *(f"memory_maintenance/contracts/{stage}.md" for stage in ("select", "maintain", "verify", "domain")),
)}
# The repository's licence and its Apache-2.0 NOTICE, at the root: copied beside
# pyproject.toml for the build, which records them under the wheel's dist-info.
LICENCE_FILES = ("LICENSE", "NOTICE")


#: The version between releases: a release's X.Y.Z, or one with a .devN or rcN suffix.
DEVELOPMENT = re.compile(r"((0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*))(?:\.dev(0|[1-9]\d*)|rc(0|[1-9]\d*))?\Z")


def development_key(value: str) -> tuple[int, int, int, int, int]:
    """A version between releases, ordered as PEP 440 orders it: X.Y.Z.devN < X.Y.ZrcN < X.Y.Z."""
    match = DEVELOPMENT.fullmatch(value)
    if not match:
        raise ValueError(f"Expected X.Y.Z, X.Y.Z.devN or X.Y.ZrcN, got {value!r}")
    release = tuple(int(match.group(i)) for i in (2, 3, 4))
    if match.group(5) is not None:
        return (*release, 0, int(match.group(5)))
    if match.group(6) is not None:
        return (*release, 1, int(match.group(6)))
    return (*release, 2, 0)


#: The test kit's (package, dist-info stem, distribution), released beside core.
TESTKIT_LAYOUT = ("delphi_core_testkit", "delphi_core_testkit", "delphi-core-testkit")
#: What a kit must carry. The snapshot is package data, the one file whose absence
#: no import would notice: a product would then have nothing to compare against.
#: `abstraction` is the layering checks a product's gate runs from its pinned kit.
TESTKIT_FILES = {f"delphi_core_testkit/{name}" for name in (
    "__init__.py", "golden.py", "contracts.py", "provider.py", "matrix.py", "data/golden/snapshot.json",
    *(f"conformance/{module}.py" for module in (
        "__init__", "_support", "storage_contract", "memory_commit", "memory_lint", "memory_routes",
        "memory_sessions", "memory_web_evidence", "multiple_conversations", "plans", "prompts")),
    *(f"abstraction/{module}.py" for module in (
        "__init__", "__main__", "a1_imports", "a3_surface", "a4_http", "a6_settings", "a7_same_code",
        "a8_private_names")),
)}
#: Core's public surface (A3), committed at `core/` and published beside the wheels
#: by every release, for the next one to compare with.
SURFACE_FILE = "public-surface.txt"
#: The private list A8 scans for (scripts/layering.sh), kept outside every repository.
#: Day-to-day gates skip A8 without it; a release does not start without it.
PRIVATE_NAMES = "DELPHI_PRIVATE_NAMES"


def version_tuple(value: str) -> tuple[int, int, int]:
    if not VERSION.fullmatch(value):
        raise ValueError(f"Expected a stable X.Y.Z backend version, got {value!r}")
    return tuple(map(int, value.split(".")))


def tag_version(tag: str) -> str:
    """The version a release tag names: `vX.Y.Z`."""
    if not tag.startswith(TAG_PREFIX):
        raise ValueError(f"Expected a {TAG_PREFIX}X.Y.Z tag, got {tag!r}")
    return tag[len(TAG_PREFIX):]


def released_tags(releases: list[dict]) -> list[str]:
    """
    The catalog's releases: published, stable and tagged `vX.Y.Z`.

    A tag records an attempt, not a successful publication. In particular,
    failed builds and partially uploaded drafts must not strand later builds
    looking for baseline assets that have never been released. A tag under any
    other prefix is not this repository's release.
    """
    return [release["tag_name"] for release in releases
            if not release["draft"] and not release["prerelease"] and release["published_at"]
            and release["tag_name"].startswith(TAG_PREFIX)
            and VERSION.fullmatch(release["tag_name"][len(TAG_PREFIX):])]


def previous_tag(releases: list[dict], current_tag: str | None) -> str | None:
    candidates = [tag for tag in released_tags(releases) if tag != current_tag]
    return max(candidates, key=lambda tag: version_tuple(tag_version(tag)), default=None)


def release_policy(version: str, tag: str | None, previous: str | None) -> dict:
    """
    `previous` is the release this one is compared with, the catalog's latest; None
    for the first release, which has no version to move past and nothing to diff.
    """
    # A tagged release is a stable X.Y.Z; between releases the version may be a pre-release.
    current = version_tuple(version) if tag is not None else development_key(version)[:3]
    if tag is not None and tag != TAG_PREFIX + version:
        raise ValueError(f"Tag {tag!r} must match {TAG_PREFIX + version!r}")
    old = version_tuple(tag_version(previous)) if previous else None
    if old and (development_key(version) < (*old, 2, 0) or (tag is not None and current == old)):
        raise ValueError(f"A release must increase the latest backend version ({previous}); "
                         "versions cannot go backwards")
    # During 0.x, the minor series is the compatibility boundary. After 1.0,
    # only a major increase permits an intentional API break.
    boundary = bool(old and (current[0] > old[0] or
                            (old[0] == current[0] == 0 and current[1] > old[1])))
    return {"version": version, "tag": tag or "", "previous_tag": previous or "",
            "breaking_allowed": str(boundary).lower(),
            "compatibility_fail_on": "" if boundary else "WARN"}


def git(*args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True).strip()


def read_catalog(releases_json: Path) -> list[dict]:
    # gh api --paginate --slurp captures every page once. Both context and build
    # consume that same snapshot, so their baseline cannot change mid-job.
    pages = json.loads(releases_json.read_text())
    if not isinstance(pages, list) or not all(isinstance(page, list) for page in pages):
        raise ValueError("Expected release pages from gh api --paginate --slurp")
    releases = [release for page in pages for release in page]
    # A stable tag published as a prerelease is invisible to `released_tags`: the next
    # release would compare with the one before it, or, behind the first, with nothing.
    misfiled = sorted(release["tag_name"] for release in releases if release["prerelease"] and not release["draft"]
                      and release["tag_name"] in released_tags([{**release, "prerelease": False}]))
    if misfiled:
        raise ValueError(f"{', '.join(misfiled)} is published as a prerelease, but its tag is a stable release's, "
                         "which no build would see: mark it a release, or delete it")
    return releases


def context(tag: str | None, releases_json: Path) -> dict:
    """
    The release identity of this checkout, compared with the previous release.

    That is the catalog's latest vX.Y.Z before `tag`. With none, this is the
    repository's first release, or a development build leading to it (check.sh's
    A2 builds from an empty catalog on purpose): `previous_tag` is empty, and
    there is no library to reopen, no API to diff and no surface to classify.
    """
    project = tomllib.loads((ROOT / "core/pyproject.toml").read_text())["project"]
    releases = read_catalog(releases_json)
    if tag is not None and tag in released_tags(releases):
        raise ValueError(f"{tag} is already published: a released tag is never rebuilt or moved, "
                         "and a fix is the next patch version")
    previous = previous_tag(releases, tag)
    policy = release_policy(project["version"], tag, previous)
    # gh skips a download pattern that matches nothing, so a previous release missing
    # its surface must be refused here rather than read as "nothing to compare".
    if previous and not any(asset.get("name") == SURFACE_FILE for release in releases
                            if release["tag_name"] == previous for asset in release.get("assets") or []):
        raise ValueError(f"{previous} published no {SURFACE_FILE}, which every release publishes: "
                         "its assets are incomplete, and its surface cannot be compared with")
    if tag:
        if git("rev-parse", f"refs/tags/{tag}^{{commit}}") != git("rev-parse", "HEAD"):
            raise ValueError("Release tag does not identify this checkout")
        if git("status", "--porcelain", "--untracked-files=no"):
            raise ValueError("Release builds require a clean tracked worktree")
        if previous:
            try:
                subprocess.run(["git", "merge-base", "--is-ancestor", previous, "HEAD"], cwd=ROOT, check=True)
            except subprocess.CalledProcessError:
                raise ValueError(f"The previous release {previous} is not an ancestor of this checkout") from None
    return policy


def inspect_wheel(path: Path, version: str, *, testkit: bool = False) -> None:
    """`testkit=True` for the test kit's wheel, which has a layout of its own."""
    package, stem, distribution = TESTKIT_LAYOUT if testkit else CORE_LAYOUT
    payload = {".py", ".json"} if testkit else {".py", ".js", ".md"}
    dist_info = f"{stem}-{version}.dist-info/"
    licences = {f"{dist_info}licenses/{name}" for name in LICENCE_FILES}
    with zipfile.ZipFile(path) as wheel:
        names = set(wheel.namelist())
        if not licences <= names:
            raise ValueError(f"Wheel is missing its licence files: {sorted(licences - names)}")
        required = TESTKIT_FILES if testkit else RUNTIME_FILES
        if not required <= names:
            raise ValueError(f"Wheel is missing runtime files: {sorted(required - names)}")
        for name in names:
            parts = Path(name).parts
            if name.startswith("/") or ".." in parts or "__pycache__" in parts:
                raise ValueError(f"Unexpected wheel path: {name}")
            # Its own package only: a module under another top-level name would be
            # importable from the installed wheel, and accounted for by nothing here.
            if name.startswith(f"{package}/") and Path(name).suffix in payload:
                continue
            if (name.startswith(dist_info) and len(parts) == 2) or name in licences:
                continue
            raise ValueError(f"Unexpected wheel payload: {name}")
        metadata = BytesParser().parsebytes(wheel.read(dist_info + "METADATA"))
        if metadata["Name"] != distribution or metadata["Version"] != version:
            raise ValueError(f"Wheel metadata does not name {distribution} {version}")
        # The kit is core's contract at one release: against any other core it passes or fails for nothing.
        pin = f"{CORE_LAYOUT[2]}=={version}"
        if testkit and pin not in (metadata.get_all("Requires-Dist") or []):
            raise ValueError(f"The test kit does not pin {pin}")
        if metadata["License-Expression"] != "Apache-2.0":
            raise ValueError("Wheel metadata does not declare the Apache-2.0 licence")
        if "Tag: py3-none-any" not in wheel.read(dist_info + "WHEEL").decode():
            raise ValueError("Expected a platform-independent backend wheel")


def checksums(directory: Path) -> None:
    paths = sorted(p for p in directory.iterdir() if p.is_file() and p.name != "SHA256SUMS")
    (directory / "SHA256SUMS").write_text("".join(
        f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n" for p in paths))


def build_wheel(output: Path, project: Path, package: str, prefix: str, root: Path | None = None) -> Path:
    """
    Build `project`'s wheel into `output`, and return it.

    From a fresh directory holding only the project's pyproject.toml, the
    licence files of `root` (the checkout's, or a tag's tree) and `package`: old
    egg metadata, tests, frontend assets and local data cannot hitchhike in a wheel.
    """
    root = ROOT if root is None else root
    before = set(output.glob("*.whl"))
    with tempfile.TemporaryDirectory(prefix=prefix) as temp:
        source = Path(temp)
        shutil.copy2(project / "pyproject.toml", source)
        for name in LICENCE_FILES:
            shutil.copy2(root / name, source)
        shutil.copytree(project / package, source / package,
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        subprocess.run([sys.executable, "-m", "build", "--wheel", "--outdir", str(output),
                        str(source)], check=True)
    built = set(output.glob("*.whl")) - before
    if len(built) != 1:
        raise ValueError("Expected exactly one wheel")
    return built.pop()


def require_private_names(tag: str | None) -> None:
    """A tagged build fails closed on A8: it refuses unless the private list is named and there."""
    if tag is None:
        return
    named = os.environ.get(PRIVATE_NAMES, "").strip()
    if not named or not Path(named).is_file():
        raise ValueError(f"A release scans the tree for private names (A8): set {PRIVATE_NAMES} to the "
                         "private list, kept outside every repository"
                         + (f"; {named} is not a file" if named else ""))


def tag_tree(tag: str, directory: Path) -> Path:
    """
    What the wheels are built from, as `tag` committed it: `core/` and the licence files.

    The clean-tree check reads tracked files only, and a copy of the checkout would
    carry an untracked or ignored module into the release; the tag's own tree cannot.
    """
    archive, tree = directory / "sources.tar", directory / "tree"
    subprocess.run(["git", "archive", "--format=tar", "-o", str(archive), f"{tag}^{{commit}}", "--",
                    "core", *LICENCE_FILES], cwd=ROOT, check=True)
    tree.mkdir()
    subprocess.run(["tar", "-xf", str(archive), "-C", str(tree)], check=True)
    return tree


def build(output: Path, tag: str | None, releases_json: Path) -> None:
    require_private_names(tag)
    policy = context(tag, releases_json)
    if output.exists() and any(output.iterdir()):
        raise ValueError("Output directory must be empty; do not mix artifacts from different builds")
    output.mkdir(parents=True, exist_ok=True)
    version = policy["version"]
    with tempfile.TemporaryDirectory(prefix="delphi-release-sources-") as temp:
        # A release from its tag's tree; a development build from the checkout, dirty or not.
        source = tag_tree(tag, Path(temp)) if tag else ROOT
        core = build_wheel(output, source / "core", CORE_LAYOUT[0], "delphi-core-build-", source)
        inspect_wheel(core, version)
        kit = build_wheel(output, source / "core/testkit", TESTKIT_LAYOUT[0], "delphi-core-testkit-build-", source)
        inspect_wheel(kit, version, testkit=True)
        # The committed surface; `check.sh` holds it to the checkout's rendering and
        # `scripts/core_alone.sh` to the installed wheel's.
        shutil.copy2(source / "core" / SURFACE_FILE, output / SURFACE_FILE)
    for wheel in (core, kit):
        subprocess.run([sys.executable, "-m", "twine", "check", "--strict", str(wheel)], check=True)
    manifest = {**policy, "commit": git("rev-parse", "HEAD"),
                "source_dirty": bool(git("status", "--porcelain", "--untracked-files=no")),
                "wheel": core.name,
                "sha256": hashlib.sha256(core.read_bytes()).hexdigest(),
                "testkit_wheel": kit.name,
                "testkit_sha256": hashlib.sha256(kit.read_bytes()).hexdigest()}
    (output / "release.json").write_text(json.dumps(manifest, indent=2) + "\n")
    checksums(output)


def surface_check(policy: dict, current: Path, previous_surface: Path | None) -> int:
    """
    0 unless this build's surface breaks the previous release's without a
    compatibility boundary: during 0.x a new minor version, after 1.0 a new major
    (`release_policy`'s `breaking_allowed`, the rule the OpenAPI diff follows).
    The first release has no previous one, so nothing to compare, and says so.
    """
    previous = policy["previous_tag"]
    if not previous:
        print(f"public surface: no previous release, so nothing to compare; "
              f"this build's {SURFACE_FILE} is the first a later release compares with.")
        return 0
    if previous_surface is None or not previous_surface.is_file():
        raise ValueError(f"Every release publishes {SURFACE_FILE}: pass {previous}'s as --previous-surface")
    sys.path.insert(0, str(ROOT / "core/testkit"))
    try:
        from delphi_core_testkit.abstraction import a3_surface
    finally:
        sys.path.remove(str(ROOT / "core/testkit"))
    allowed = policy["breaking_allowed"] == "true"
    code = a3_surface.report(a3_surface.classify(previous_surface.read_text(), current.read_text()), allowed)
    if code:
        print(f"public surface: a breaking change against {previous} needs a compatibility boundary: "
              f"a new minor version during 0.x, a new major after 1.0.", file=sys.stderr)
    return code


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)

    def identity(name: str, summary: str | None = None) -> argparse.ArgumentParser:
        command = commands.add_parser(name, help=summary)
        command.add_argument("--tag", help=f"the release's tag, {TAG_PREFIX}X.Y.Z; untagged, a development build")
        command.add_argument("--releases-json", type=Path, required=True,
                             help="this repository's release catalog, from gh api --paginate --slurp")
        return command

    ctx = identity("context")
    ctx.add_argument("--github-output", type=Path)
    wheel = identity("build")
    wheel.add_argument("--output", type=Path, required=True)
    identity("previous", f"the catalog's latest {TAG_PREFIX}X.Y.Z release before --tag; nothing before the first")
    sums = commands.add_parser("checksums")
    sums.add_argument("directory", type=Path)
    surface = identity("surface", "classify this build's public surface against the previous release's")
    surface.add_argument("--current", type=Path, required=True, help=f"this build's {SURFACE_FILE}")
    surface.add_argument("--previous-surface", type=Path,
                         help=f"the previous release's {SURFACE_FILE}; none for the first release")
    args = parser.parse_args()
    if args.command == "context":
        policy = context(args.tag, args.releases_json)
        print(json.dumps(policy, indent=2))
        if args.github_output:
            with args.github_output.open("a") as stream:
                stream.writelines(f"{key}={value}\n" for key, value in policy.items())
    elif args.command == "build":
        build(args.output.resolve(), args.tag, args.releases_json)
    elif args.command == "previous":
        print(previous_tag(read_catalog(args.releases_json), args.tag) or "")
    elif args.command == "surface":
        sys.exit(surface_check(context(args.tag, args.releases_json), args.current, args.previous_surface))
    else:
        checksums(args.directory)


def run() -> int:
    """The command line: a refusal is one line on stderr and exit status 1, never a traceback."""
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(f"backend_release.py: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(run())
