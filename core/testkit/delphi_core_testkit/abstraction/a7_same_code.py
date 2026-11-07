"""A7 · same code everywhere: one version for app and core, and the pinned core wheel or nothing.

Plan 4 §5 (Releases) and rule 10. Two checks:

- **versions**: the desktop's `package.json` version is the version of every
  `pyproject.toml` given: core's, the test kit's and the desktop layer's. npm writes semver (`0.7.0-dev.0`, `0.7.0-rc.1`) and Python PEP 440
  (`0.7.0.dev0`, `0.7.0rc1`), so both are read into one form and compared there.
  A semver pre-release maps only when PEP 440 can say it: `dev.N`, `alpha.N` or
  `a.N`, `beta.N` or `b.N`, `rc.N`, a pre-release followed by `dev.N`. Build
  metadata, PEP 440 epochs and local versions are refused, not guessed at. A
  project that requires delphi-core (the kit, the layer) pins exactly that
  version, and `package-lock.json` names it where npm writes it, so a bump left
  half done on any of those lines is refused too.
- **wheel**: the installed core is the pinned wheel. An editable or directory
  install is refused (the web's deploy and gate refuse the development override);
  the wheel's SHA-256 must equal the pin, taken from the wheel file when one is
  given and otherwise from what pip recorded at install (`direct_url.json`); and
  every installed file must still hash as the wheel's RECORD says.

    python -m delphi_core_testkit.abstraction versions --package-json desktop/package.json \
        [--package-lock desktop/package-lock.json] --pyproject core/pyproject.toml --pyproject desktop/backend/pyproject.toml
    python -m delphi_core_testkit.abstraction wheel --distribution delphi-core --sha256 HEX [--version 0.7.0] [--wheel FILE]

The desktop's other half of A7, the runtime receipt naming the commit and tree it
was built from, is enforced by `desktop/build/check-backend-runtime.sh` and
`npm run dist` (root CLAUDE.md, invariant 12). The `wheel` half is the web's: its
gate and deploy run it against the wheel its pin names.
"""
import argparse
import base64
import csv
from dataclasses import dataclass
import hashlib
from importlib import metadata
import io
import json
from pathlib import Path
import re
import sys
import tomllib
import zipfile

SEMVER = re.compile(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?"
                    r"(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?")
PEP440 = re.compile(r"""v?(?:(?P<epoch>[0-9]+)!)?(?P<release>[0-9]+(?:\.[0-9]+)*)
    (?:[-_.]?(?P<pre_l>alpha|a|beta|b|preview|pre|c|rc)[-_.]?(?P<pre_n>[0-9]+)?)?
    (?:-(?P<post_n1>[0-9]+)|[-_.]?(?P<post_l>post|rev|r)[-_.]?(?P<post_n2>[0-9]+)?)?
    (?:[-_.]?(?P<dev_l>dev)[-_.]?(?P<dev_n>[0-9]+)?)?
    (?:\+(?P<local>[a-z0-9]+(?:[-_.][a-z0-9]+)*))?""", re.VERBOSE | re.IGNORECASE)
WHEEL_DATA = re.compile(r"[^/]+\.data/")
PRE = {"a": "a", "alpha": "a", "b": "b", "beta": "b", "c": "rc", "rc": "rc", "pre": "rc", "preview": "rc"}


@dataclass(frozen=True)
class Version:
    release: tuple
    pre: tuple | None = None   # ("a" | "b" | "rc", n)
    post: int | None = None
    dev: int | None = None

    def key(self):
        release = list(self.release)
        while len(release) > 1 and release[-1] == 0:
            release.pop()  # 1.0 is 1.0.0, as PEP 440 compares them
        return tuple(release), self.pre, self.post, self.dev

    def __eq__(self, other):
        return isinstance(other, Version) and self.key() == other.key()

    def __hash__(self):
        return hash(self.key())

    def __str__(self):
        written = ".".join(map(str, self.release + (0,) * (3 - len(self.release))))
        if self.pre:
            written += f"{self.pre[0]}{self.pre[1]}"
        if self.post is not None:
            written += f".post{self.post}"
        if self.dev is not None:
            written += f".dev{self.dev}"
        return written


def parse_pep440(text):
    """A PEP 440 version, as Python's packaging writes it; epochs and local versions refused."""
    match = PEP440.fullmatch(text.strip())
    if not match:
        raise ValueError(f"{text!r} is not a PEP 440 version")
    if match["epoch"] or match["local"]:
        raise ValueError(f"{text!r} has an epoch or a local part, which no npm version can match")
    pre = (PRE[match["pre_l"].lower()], int(match["pre_n"] or 0)) if match["pre_l"] else None
    post = match["post_n1"] or match["post_n2"]
    post = int(post) if post is not None else (0 if match["post_l"] else None)
    dev = int(match["dev_n"] or 0) if match["dev_l"] else None
    return Version(tuple(int(part) for part in match["release"].split(".")), pre, post, dev)


def parse_semver(text):
    """A semver version read as PEP 440 would write it; a pre-release PEP 440 cannot say is refused."""
    match = SEMVER.fullmatch(text.strip())
    if not match:
        raise ValueError(f"{text!r} is not a semver version (X.Y.Z[-pre-release])")
    if match[5]:
        raise ValueError(f"{text!r} has build metadata, which no PEP 440 version can match")
    release = tuple(int(match[i]) for i in (1, 2, 3))
    if not match[4]:
        return Version(release)
    words = []
    for identifier in match[4].split("."):
        split = re.fullmatch(r"([A-Za-z]+)(\d*)", identifier)
        if split:
            words.append(split[1].lower())
            if split[2]:
                words.append(int(split[2]))
        elif identifier.isdigit():
            words.append(int(identifier))
        else:
            raise ValueError(f"{text!r}: the pre-release identifier {identifier!r} has no PEP 440 spelling")
    pre = dev = None
    at = 0
    if at < len(words) and words[at] in ("alpha", "a", "beta", "b", "rc"):
        label = PRE[words[at]]
        at += 1
        number = words[at] if at < len(words) and isinstance(words[at], int) else 0
        at += at < len(words) and isinstance(words[at], int)
        pre = (label, number)
    if at < len(words) and words[at] == "dev":
        at += 1
        dev = words[at] if at < len(words) and isinstance(words[at], int) else 0
        at += at < len(words) and isinstance(words[at], int)
    if at != len(words) or (pre is None and dev is None):
        raise ValueError(f"{text!r}: the pre-release {match[4]!r} has no PEP 440 spelling "
                         "(expected dev.N, alpha.N, beta.N or rc.N, optionally followed by dev.N)")
    return Version(release, pre, None, dev)


def same_version(npm, python):
    """Whether an npm (semver) version and a Python (PEP 440) version name the same release."""
    return parse_semver(npm) == parse_pep440(python)


#: A requirement as `[project] dependencies` writes it: a name in any PEP 503
#: spelling, optional extras, then a specifier up to an environment marker.
REQUIREMENT = re.compile(r"\s*(?P<name>[A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(?P<specifier>[^;]*?)\s*(?:;.*)?")


def core_requirements(project):
    """(requirement, specifier) for each requirement on delphi-core in a `[project]` table."""
    for requirement in project.get("dependencies") or []:
        match = REQUIREMENT.fullmatch(requirement)
        if match and re.sub(r"[-_.]+", "-", match["name"]).lower() == "delphi-core":
            yield requirement, match["specifier"]


def pin_violations(path, project, app):
    """A project that requires delphi-core pins exactly the app's version: the kit and the layer are that core's."""
    found = []
    for requirement, specifier in core_requirements(project):
        pin = re.fullmatch(r"==\s*([^\s,]+)", specifier)
        try:
            pinned = parse_pep440(pin[1]) if pin else None
        except ValueError:
            pinned = None
        if pinned != app:
            found.append(f"{path} requires {requirement!r}, not delphi-core=={app}: "
                         "the kit and the layers pin exactly the core of the app's version (§5)")
    return found


def lockfile_violations(package_json, package_lock, npm):
    """The lockfile names the app's version where `npm install` writes it: at its top and as its root package."""
    try:
        lock = json.loads(Path(package_lock).read_text())
    except (OSError, ValueError) as error:
        return [f"cannot read {package_lock}: {error}"]
    named = {"version": lock.get("version")}
    if "packages" in lock or lock.get("lockfileVersion", 1) >= 2:
        named['packages[""].version'] = ((lock.get("packages") or {}).get("") or {}).get("version")
    return [f"{Path(package_lock).name}'s {where} says {version}, {Path(package_json).name} says {npm}: "
            "the lockfile carries the app's version too" for where, version in named.items() if version != npm]


def versions_violations(package_json, pyprojects, package_lock=None):
    """The problems with the versions of the app and its Python projects in one checkout, in words.

    `pyprojects` is one path or several; each must name the app's version, and
    any of them that requires delphi-core must pin exactly that version. With
    `package_lock`, the lockfile must name the app's version as package.json does.
    """
    pyprojects = [pyprojects] if isinstance(pyprojects, (str, Path)) else list(pyprojects)
    if not pyprojects:
        return ["no pyproject.toml to compare the app's version with"]
    try:
        npm = json.loads(Path(package_json).read_text())["version"]
        projects = [(Path(path), tomllib.loads(Path(path).read_text())["project"]) for path in pyprojects]
        pythons = [(path, project["version"]) for path, project in projects]
    except (OSError, KeyError, ValueError) as error:
        return [f"cannot read the versions: {error}"]
    found = []
    for path, python in pythons:
        try:
            if same_version(npm, python):
                continue
        except ValueError as error:
            found.append(f"{path}: {error}")
            continue
        found.append(f"{Path(package_json).name} says {npm} ({parse_semver(npm)} in PEP 440), "
                     f"{path} says {python}: one version for app and core (§5)")
    try:
        app = parse_semver(npm)
    except ValueError:
        app = None  # already reported against every project above
    if app is not None:
        for path, project in projects:
            found += pin_violations(path, project, app)
    if package_lock is not None:
        found += lockfile_violations(package_json, package_lock, npm)
    return found


def main_versions(argv=None):
    parser = argparse.ArgumentParser(prog="abstraction versions",
                                     description="A7: the app's version is core's and its layers'")
    parser.add_argument("--package-json", type=Path, required=True, help="the app's package.json")
    parser.add_argument("--package-lock", type=Path, help="its package-lock.json, which must name the same version")
    parser.add_argument("--pyproject", type=Path, action="append", required=True,
                        help="a Python project whose version, and pin on delphi-core if any, must be the app's; repeat")
    args = parser.parse_args(argv)
    found = versions_violations(args.package_json, args.pyproject, args.package_lock)
    for line in found:
        print(f"FAIL: {line}", file=sys.stderr)
    print(f"versions: {len(found)} problems.")
    return 1 if found else 0


# ---------------------------------------------------------------- the pinned wheel

def record_hash(data):
    """A file's hash as a wheel's RECORD writes it."""
    return "sha256=" + base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()


def read_record(text):
    """{path: hash} for each RECORD row that carries a hash."""
    return {row[0]: row[1] for row in csv.reader(io.StringIO(text)) if len(row) >= 2 and row[1]}


def where(dist):
    """The metadata directory a distribution was found in, so a path listed twice is one install."""
    record = next((file for file in dist.files or [] if str(file).endswith(".dist-info/RECORD")), None)
    return Path(dist.locate_file(record)).resolve().parent if record else id(dist)


def recorded_sha256(direct_url):
    archive = direct_url.get("archive_info") or {}
    found = (archive.get("hashes") or {}).get("sha256")
    if not found and str(archive.get("hash", "")).startswith("sha256="):
        found = archive["hash"].split("=", 1)[1]
    return found


def installed_wheel_violations(distribution, sha256, *, version=None, wheel=None, path=None):
    """Every reason the installed `distribution` is not the wheel pinned by `sha256`, in words.

    `path` lists the directories to look in (default sys.path); `wheel` is the wheel
    file, when it is at hand, whose own hash and RECORD are then the reference.
    """
    found = list(metadata.distributions(name=distribution, path=path)) if path else \
        list(metadata.distributions(name=distribution))
    if not found:
        return [f"{distribution} is not installed"]
    if len({where(dist) for dist in found}) > 1:
        return [f"{distribution} is installed more than once on the path; one copy shadows the other"]
    dist = found[0]
    problems = []
    if version and dist.version != version:
        problems.append(f"{distribution} {dist.version} is installed, the pin says {version}")
    direct_url = json.loads(dist.read_text("direct_url.json") or "{}")
    files = [str(file) for file in dist.files or []]
    if (direct_url.get("dir_info") or {}).get("editable") or any("__editable__" in file for file in files):
        return problems + [f"{distribution} is an editable install ({direct_url.get('url', 'a local checkout')}); "
                           "the pinned wheel is required, never the development override"]
    if "dir_info" in direct_url or "vcs_info" in direct_url:
        return problems + [f"{distribution} was installed from {direct_url.get('url', 'a directory')}, not from the pinned wheel"]
    if wheel is not None:
        data = Path(wheel).read_bytes()
        if hashlib.sha256(data).hexdigest() != sha256.lower():
            return problems + [f"{Path(wheel).name} has SHA-256 {hashlib.sha256(data).hexdigest()}, the pin says {sha256}"]
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            names = [name for name in archive.namelist() if name.endswith(".dist-info/RECORD")]
            reference = read_record(archive.read(names[0]).decode()) if names else {}
        if not reference:
            return problems + [f"{Path(wheel).name} has no RECORD to compare the install with"]
    else:
        recorded = recorded_sha256(direct_url)
        if not recorded:
            return problems + [f"{distribution}'s install records no wheel hash; pass the wheel to compare with"]
        if recorded.lower() != sha256.lower():
            return problems + [f"{distribution} was installed from a wheel with SHA-256 {recorded}, the pin says {sha256}"]
        reference = read_record(dist.read_text("RECORD") or "")
    changed = []
    for name, expected in sorted(reference.items()):
        if WHEEL_DATA.match(name) or name.endswith(".pyc"):
            continue  # installed outside the package directory, or derived at install
        if ".dist-info/" in name and wheel is not None:
            continue  # the installer rewrites its own metadata
        located = Path(dist.locate_file(name))
        if not located.is_file():
            changed.append(f"{name} is missing")
        elif record_hash(located.read_bytes()) != expected:
            changed.append(f"{name} differs from the wheel")
    if not reference:
        changed.append("the install has no RECORD to check its files against")
    return problems + [f"{distribution}: {line}" for line in changed]


def main_wheel(argv=None):
    parser = argparse.ArgumentParser(prog="abstraction wheel", description="A7: the installed core is the pinned wheel")
    parser.add_argument("--distribution", default="delphi-core")
    parser.add_argument("--sha256", required=True, help="the pinned wheel's SHA-256")
    parser.add_argument("--version", help="the pinned version")
    parser.add_argument("--wheel", type=Path, help="the wheel file, when it is at hand")
    parser.add_argument("--path", action="append", help="a directory to look for the install in; repeat")
    args = parser.parse_args(argv)
    found = installed_wheel_violations(args.distribution, args.sha256, version=args.version,
                                       wheel=args.wheel, path=args.path)
    for line in found:
        print(f"FAIL: {line}", file=sys.stderr)
    print(f"wheel: {args.distribution}; {len(found)} problems.")
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main_versions())
