"""Release identity and artifact boundaries must fail closed before upload."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
import zipfile

import pytest

SCRIPTS = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("backend_release", SCRIPTS / "backend_release.py")
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


@pytest.mark.parametrize("version", ["01.2.3", "1.2", "1.2.3rc1", "1.2.3+local", "v1.2.3", "1.2.3\n"])
def test_release_versions_have_one_canonical_tag_spelling(version):
    with pytest.raises(ValueError):
        release.version_tuple(version)


#: A release's assets as the catalog lists them: every release publishes its surface.
ASSETS = [{"name": "openapi.json"}, {"name": "public-surface.txt"}]


def published(tag, **overrides):
    return {"tag_name": tag, "draft": False, "prerelease": False,
            "published_at": "2026-09-09T00:00:00Z", "assets": ASSETS, **overrides}


def checkout(tmp_path, monkeypatch, version):
    """A checkout whose core is at `version`, as `context` reads it."""
    root = tmp_path / "checkout"
    (root / "core").mkdir(parents=True, exist_ok=True)
    (root / "core/pyproject.toml").write_text(f'[project]\nversion = "{version}"\n')
    monkeypatch.setattr(release, "ROOT", root)
    return root


def at_tag(monkeypatch, tag):
    """git as a clean checkout of `tag` answers it; returns the commands `subprocess.run` was given."""
    answers = {("rev-parse", f"refs/tags/{tag}^{{commit}}"): "candidate", ("rev-parse", "HEAD"): "candidate",
               ("status", "--porcelain", "--untracked-files=no"): ""}
    monkeypatch.setattr(release, "git", lambda *args: answers[args])
    runs = []
    monkeypatch.setattr(release.subprocess, "run", lambda args, **kwargs: runs.append(args))
    return runs


def catalog_of(tmp_path, *releases):
    catalog = tmp_path / "releases.json"
    catalog.write_text(json.dumps([list(releases)]))
    return catalog


def test_the_previous_release_is_the_latest_published_stable_v_tag():
    """Another prefix, a pre-release spelling, a draft and a prerelease are not releases here."""
    releases = [published(tag) for tag in ("frontend-v20.0.0", "release-0.99.0", "v0.7.1-rc.1", "v0.7.1rc1",
                                          "v01.0.0", "v0.7", "v0.7.0", "v0.10.0", "v0.9.0")]
    releases += [published("v0.11.0", draft=True), published("v0.12.0", prerelease=True),
                 published("v0.13.0", published_at=None)]
    assert release.previous_tag(releases, None) == "v0.10.0"
    assert release.previous_tag(releases, "v0.10.0") == "v0.9.0"
    # A catalog holding only other prefixes and pre-releases has no release of this repository.
    assert release.previous_tag([published("frontend-v0.6.9"), published("v0.1.1-rc.1")], None) is None


@pytest.mark.parametrize("tag", [None, "v0.1.3"])
def test_failed_release_does_not_strand_next_pr_or_release(tmp_path, monkeypatch, tag):
    checkout(tmp_path, monkeypatch, "0.1.3")
    catalog = tmp_path / "releases.json"
    # 0.1.1 has a tag but no release; 0.1.2 failed during draft publication.
    # The successful baseline is on a later API page, behind other releases.
    catalog.write_text(json.dumps([
        [published("v0.1.2", draft=True),
         published("v2.0.0-rc.1", prerelease=True),
         published("v3.0.0", published_at=None)],
        [published("frontend-v9.0.0"), published("release-0.9.0"), published("v0.1.0")],
    ]))
    ancestry_checks = at_tag(monkeypatch, tag)
    policy = release.context(tag, catalog)
    assert policy["previous_tag"] == "v0.1.0"
    assert policy["compatibility_fail_on"] == "WARN"
    assert ancestry_checks == ([
        ["git", "merge-base", "--is-ancestor", "v0.1.0", "HEAD"]
    ] if tag else [])


def test_the_catalog_is_read_or_the_build_stops(tmp_path, monkeypatch):
    """A missing or failed API answer is never read as an empty catalog, which would make any build a first release."""
    checkout(tmp_path, monkeypatch, "0.1.0")
    catalog = tmp_path / "releases.json"
    with pytest.raises(FileNotFoundError):
        release.context(None, catalog)
    catalog.write_text('{"message": "API request failed"}')
    with pytest.raises(ValueError, match="Expected release pages"):
        release.context(None, catalog)


@pytest.mark.parametrize("version,tag", [("0.1.0", "v0.1.0"), ("0.1.0.dev0", None), ("0.1.0rc1", None)])
def test_the_first_release_is_compared_with_nothing(tmp_path, monkeypatch, capsys, version, tag):
    """No earlier vX.Y.Z in the catalog: no baseline asked for, no version to move past, no ancestry, no diff."""
    checkout(tmp_path, monkeypatch, version)
    runs = at_tag(monkeypatch, tag)
    # An earlier failed attempt left a draft, and other prefixes are not this repository's releases.
    catalog = catalog_of(tmp_path, published("v0.1.0", draft=True), published("frontend-v1.0.0"))
    policy = release.context(tag, catalog)
    assert policy["previous_tag"] == "" and policy["tag"] == (tag or "")
    assert runs == []
    # The command ci_core.sh runs writes the same policy for the later steps.
    env = tmp_path / "context.env"
    monkeypatch.setattr(sys, "argv", ["backend_release.py", "context", "--releases-json", str(catalog),
                                      "--github-output", str(env), *(["--tag", tag] if tag else [])])
    release.main()
    assert "previous_tag=\n" in env.read_text()
    capsys.readouterr()
    # And the surface check says there is nothing to compare, rather than asking for a file.
    current = tmp_path / "current.txt"
    current.write_text(SURFACE)
    monkeypatch.setattr(sys, "argv", ["backend_release.py", "surface", "--releases-json", str(catalog),
                                      "--current", str(current), *(["--tag", tag] if tag else [])])
    with pytest.raises(SystemExit) as ended:
        release.main()
    assert ended.value.code == 0
    assert "public surface: no previous release, so nothing to compare" in capsys.readouterr().out


def test_published_release_with_missing_assets_is_still_the_baseline():
    # Asset validation belongs to the download/install gates. Never fall back
    # to an older release just because a published release has lost its assets.
    assert release.previous_tag([
        published("v0.1.0"), published("v0.1.1", assets=[]),
    ], "v0.1.2") == "v0.1.1"


@pytest.mark.parametrize("version", ["0.2.0.dev0", "0.2.0rc1", "0.2.0"])
def test_a_development_version_may_carry_a_pre_release_suffix_but_a_release_tag_may_not(version):
    assert release.release_policy(version, None, "v0.1.0")["breaking_allowed"] == "true"
    assert release.release_policy(version, None, None)["previous_tag"] == ""
    if version != "0.2.0":
        with pytest.raises(ValueError):
            release.release_policy(version, "v" + version, "v0.1.0")


def test_pre_releases_order_before_their_release_and_never_go_backwards():
    assert release.development_key("0.1.0.dev1") < release.development_key("0.1.0rc1") < release.development_key("0.1.0")
    assert release.development_key("0.1.0") < release.development_key("0.1.1.dev0")
    with pytest.raises(ValueError):
        release.release_policy("0.2.0.dev0", None, "v0.2.0")
    assert release.release_policy("0.1.1.dev0", None, "v0.1.0")["breaking_allowed"] == "false"
    for spelling in ("0.1.0-dev.0", "0.1.0.dev", "0.1.0a1", "0.1.0.post1"):
        with pytest.raises(ValueError):
            release.development_key(spelling)


def test_tags_must_match_metadata_and_releases_must_advance():
    for tag in ("v0.2.1", "0.2.0", "release-0.2.0"):
        with pytest.raises(ValueError, match="must match 'v0.2.0'"):
            release.release_policy("0.2.0", tag, None)
    with pytest.raises(ValueError):
        release.release_policy("0.1.0", "v0.1.0", "v0.2.0")
    # Normal development can validate the last released version without a tag.
    assert release.release_policy("0.2.0", None, "v0.2.0")


@pytest.mark.parametrize("version,tag", [("0.1.0", "v0.1.0"), ("0.1.1.dev0", None), ("0.2.0", "v0.2.0")])
def test_a_release_never_goes_backwards_from_the_catalogs_latest(tmp_path, monkeypatch, version, tag):
    """Against the catalog, not one policy call: v0.2.0 is published, so 0.1.x is behind it and v0.2.0 is taken."""
    checkout(tmp_path, monkeypatch, version)
    at_tag(monkeypatch, tag)
    catalog = catalog_of(tmp_path, published("v0.2.0"))
    refusal = ("v0.2.0 is already published" if tag == "v0.2.0"
               else r"latest backend version \(v0.2.0\); versions cannot go backwards")
    with pytest.raises(ValueError, match=refusal):
        release.context(tag, catalog)


@pytest.mark.parametrize("old,new,allowed", [
    ("0.1.0", "0.1.1", "false"), ("0.1.1", "0.2.0", "true"),
    ("0.2.0", "1.0.0", "true"), ("1.0.0", "1.1.0", "false"),
    ("1.1.0", "1.1.1", "false"), ("1.1.1", "2.0.0", "true"),
])
def test_only_an_explicit_compatibility_boundary_permits_api_breaks(old, new, allowed):
    assert release.release_policy(new, "v" + new, "v" + old)["breaking_allowed"] == allowed


def make_wheel(path, *, extra=None, missing=None, version="0.1.0", metadata_version=None, licence="Apache-2.0",
               package=None, stem=None, distribution=None):
    """A core wheel at `version` carrying RUNTIME_FILES, in core's layout unless a name is given."""
    package, stem, distribution = (package or release.CORE_LAYOUT[0], stem or release.CORE_LAYOUT[1],
                                   distribution or release.CORE_LAYOUT[2])
    files = {f"{package}/{name.split('/', 1)[1]}": "runtime" for name in release.RUNTIME_FILES}
    files = {name: body for name, body in files.items() if name != missing}
    files.update({f"{stem}-{version}.dist-info/licenses/{name}": "text"
                  for name in release.LICENCE_FILES if name != missing})
    files.update({
        f"{stem}-{version}.dist-info/METADATA": f"Name: {distribution}\nVersion: {metadata_version or version}\n"
                                                + (f"License-Expression: {licence}\n" if licence else ""),
        f"{stem}-{version}.dist-info/WHEEL": "Tag: py3-none-any\n",
    })
    if extra:
        files[extra] = "unwanted"
    with zipfile.ZipFile(path, "w") as wheel:
        for name, body in files.items():
            wheel.writestr(name, body)


def make_testkit_wheel(path, *, version="0.1.0.dev0", missing=None, extra=None, requires=None, distribution=None):
    """The test kit's wheel at `version`, pinning `delphi-core==<version>` unless `requires` says otherwise."""
    package, stem, name = release.TESTKIT_LAYOUT
    files = {file: "kit" for file in release.TESTKIT_FILES if file != missing}
    files.update({f"{stem}-{version}.dist-info/licenses/{licence}": "text" for licence in release.LICENCE_FILES})
    pins = [f"delphi-core=={version}", "pytest<9,>=8.4"] if requires is None else requires
    files.update({
        f"{stem}-{version}.dist-info/METADATA": f"Name: {distribution or name}\nVersion: {version}\n"
                                                "License-Expression: Apache-2.0\n"
                                                + "".join(f"Requires-Dist: {pin}\n" for pin in pins),
        f"{stem}-{version}.dist-info/WHEEL": "Tag: py3-none-any\n",
    })
    if extra:
        files[extra] = "unwanted"
    with zipfile.ZipFile(path, "w") as wheel:
        for file, body in files.items():
            wheel.writestr(file, body)


@pytest.mark.parametrize("extra", ["frontend/public/icon.svg", ".env", "tests/test_app.py", "other_package/main.py",
                                   "delphi_core/__pycache__/main.pyc", "delphi_core/data.json",
                                   "delphi_core/../secret.py", "delphi_core-0.1.0.dist-info/licenses/THIRD_PARTY.txt"])
def test_wheel_rejects_checkout_files_and_generated_data(tmp_path, extra):
    path = tmp_path / "backend.whl"
    make_wheel(path, extra=extra)
    with pytest.raises(ValueError):
        release.inspect_wheel(path, "0.1.0")


@pytest.mark.parametrize("missing", sorted(release.RUNTIME_FILES))
def test_wheel_cannot_omit_runtime_assets_or_subprocess_entrypoint(tmp_path, missing):
    path = tmp_path / "backend.whl"
    make_wheel(path, missing=missing)
    with pytest.raises(ValueError, match="missing runtime files"):
        release.inspect_wheel(path, "0.1.0")


def test_a_development_wheel_carries_what_its_release_does(tmp_path):
    path = tmp_path / "backend.whl"
    make_wheel(path, version="0.1.1.dev0")
    release.inspect_wheel(path, "0.1.1.dev0")
    make_wheel(path, version="0.1.1.dev0", missing="delphi_core/memory_maintenance/contracts/verify.md")
    with pytest.raises(ValueError, match="missing runtime files"):
        release.inspect_wheel(path, "0.1.1.dev0")


@pytest.mark.parametrize("names", [
    {"package": "delphi_other"},
    {"stem": "delphi_other", "distribution": "delphi-other"},
    {"distribution": "delphi-other"},
], ids=["package", "dist-info", "metadata"])
def test_a_core_wheel_is_named_delphi_core_throughout(tmp_path, names):
    path = tmp_path / "core.whl"
    make_wheel(path, **names)
    with pytest.raises(ValueError):
        release.inspect_wheel(path, "0.1.0")


def test_a_build_copies_delphi_core_and_nothing_else(tmp_path, monkeypatch):
    """Each wheel from a source of its own: core's holds `delphi_core` and nothing beside it, the kit's the kit alone."""
    root = tmp_path / "checkout"
    for name in ("core/pyproject.toml", "core/delphi_core/main.py", "core/stray/main.py", *release.LICENCE_FILES,
                 "core/testkit/pyproject.toml", "core/testkit/delphi_core_testkit/golden.py", "core/public-surface.txt"):
        (root / name).parent.mkdir(parents=True, exist_ok=True)
        (root / name).write_text("source")
    monkeypatch.setattr(release, "ROOT", root)
    monkeypatch.setattr(release, "context", lambda *args, **kwargs: {"version": "0.1.0.dev0", "tag": ""})
    monkeypatch.setattr(release, "git", lambda *args: "")
    sources = []

    def run(args, **kwargs):
        if args[1:4] == ["-m", "build", "--wheel"]:
            source = Path(args[-1])
            sources.append((source.name, sorted(path.name for path in source.iterdir())))
            if (source / "delphi_core_testkit").is_dir():
                make_testkit_wheel(Path(args[5]) / "delphi_core_testkit-0.1.0.dev0-py3-none-any.whl")
            else:
                make_wheel(Path(args[5]) / "delphi_core-0.1.0.dev0-py3-none-any.whl", version="0.1.0.dev0")

    monkeypatch.setattr(release.subprocess, "run", run)
    inspected, inspect = [], release.inspect_wheel
    monkeypatch.setattr(release, "inspect_wheel", lambda path, version, **given: (
        inspected.append((Path(path).name, given.get("testkit", False))), inspect(path, version, **given))[1])
    release.build(tmp_path / "dist", None, tmp_path / "releases.json")
    # Both inspected, the kit as the kit: its exact pin on core is checked only there.
    assert sorted(inspected) == [("delphi_core-0.1.0.dev0-py3-none-any.whl", False),
                                 ("delphi_core_testkit-0.1.0.dev0-py3-none-any.whl", True)]
    [(core, core_contents), (kit, kit_contents)] = sources
    assert core.startswith("delphi-core-build-") and kit.startswith("delphi-core-testkit-build-")
    assert core_contents == sorted(["pyproject.toml", "delphi_core", *release.LICENCE_FILES])
    assert kit_contents == sorted(["pyproject.toml", "delphi_core_testkit", *release.LICENCE_FILES])
    manifest = json.loads((tmp_path / "dist/release.json").read_text())
    assert manifest["wheel"] == "delphi_core-0.1.0.dev0-py3-none-any.whl"
    assert manifest["testkit_wheel"] == "delphi_core_testkit-0.1.0.dev0-py3-none-any.whl"
    for name, digest in ((manifest["wheel"], manifest["sha256"]), (manifest["testkit_wheel"], manifest["testkit_sha256"])):
        assert hashlib.sha256((tmp_path / "dist" / name).read_bytes()).hexdigest() == digest
    # The committed public surface is published beside the wheels, for the next release to compare with.
    assert (tmp_path / "dist" / release.SURFACE_FILE).read_text() == "source"
    assert release.SURFACE_FILE in (tmp_path / "dist/SHA256SUMS").read_text()


SURFACE = ("# The public surface\n"
           "delphi_core.app:create_app def: (settings: delphi_core.settings.Settings) -> fastapi.applications.FastAPI\n"
           "delphi_core.storage:Storage class: (abc.ABC)\n"
           "delphi_core.storage:Storage.get_project abstract def: (self, username: str, project_id: str) -> dict\n")
#: A planted change of each kind: a new name is additive; a parameter without a
#: default, a removed name and a new abstract member each break a product.
PLANTED = {
    "additive": SURFACE + "delphi_core.app:Stores class: ()\n",
    "new-required-parameter": SURFACE.replace("(settings: delphi_core.settings.Settings)",
                                              "(settings: delphi_core.settings.Settings, *, stores: object)"),
    "removed": SURFACE.replace("delphi_core.storage:Storage.get_project abstract def: "
                               "(self, username: str, project_id: str) -> dict\n", ""),
    "new-abstract-member": SURFACE + "delphi_core.storage:Storage.list_plans abstract def: (self, username: str) -> list\n",
}


def surfaces(tmp_path, current):
    (tmp_path / "baseline.txt").write_text(SURFACE)
    (tmp_path / "current.txt").write_text(current)
    return tmp_path / "current.txt", tmp_path / "baseline.txt"


@pytest.mark.parametrize("planted", PLANTED)
def test_a_breaking_surface_change_needs_a_compatibility_boundary(tmp_path, capsys, planted):
    """A3 in the release check, the rule oasdiff applies to the HTTP API: during 0.x a break needs a new minor."""
    current, baseline = surfaces(tmp_path, PLANTED[planted])
    breaking = planted != "additive"
    assert release.surface_check(release.release_policy("0.1.1", None, "v0.1.0"), current, baseline) == int(breaking)
    out = capsys.readouterr()
    assert ("0 additive, 1 breaking" if breaking else "1 additive, 0 breaking") in out.out
    if breaking:
        assert "needs a compatibility boundary" in out.err
    # Across a minor version the same change is allowed, and still reported.
    assert release.surface_check(release.release_policy("0.2.0", None, "v0.1.0"), current, baseline) == 0
    assert ("1 breaking" if breaking else "1 additive") in capsys.readouterr().out


def test_an_unchanged_surface_passes_with_nothing_to_report(tmp_path, capsys):
    current, baseline = surfaces(tmp_path, SURFACE)
    assert release.surface_check(release.release_policy("0.1.1", None, "v0.1.0"), current, baseline) == 0
    assert "0 additive, 0 breaking" in capsys.readouterr().out


def test_the_first_release_has_no_surface_to_compare_and_says_so(tmp_path, capsys):
    current, _ = surfaces(tmp_path, PLANTED["removed"])
    assert release.surface_check(release.release_policy("0.1.0", "v0.1.0", None), current, None) == 0
    assert "no previous release, so nothing to compare" in capsys.readouterr().out


def test_a_previous_release_surface_must_be_given_to_compare_with(tmp_path):
    current, _ = surfaces(tmp_path, SURFACE)
    for given in (None, tmp_path / "not-downloaded.txt"):
        with pytest.raises(ValueError, match="pass v0.1.0's as --previous-surface"):
            release.surface_check(release.release_policy("0.1.1", None, "v0.1.0"), current, given)


def test_a_previous_release_that_published_no_surface_is_refused(tmp_path, monkeypatch):
    """gh skips a pattern that matches nothing, so a surface missing from a release must not read as 'nothing to compare'."""
    checkout(tmp_path, monkeypatch, "0.1.2.dev0")
    catalog = catalog_of(tmp_path, published("v0.1.1", assets=[{"name": "openapi.json"}]), published("v0.1.0"))
    with pytest.raises(ValueError, match="v0.1.1 published no public-surface.txt, which every release publishes"):
        release.context(None, catalog)
    catalog = catalog_of(tmp_path, published("v0.1.1"), published("v0.1.0", assets=[]))
    assert release.context(None, catalog)["previous_tag"] == "v0.1.1"


@pytest.mark.parametrize("version,code", [("0.1.1.dev0", 1), ("0.2.0.dev0", 0)])
def test_the_surface_command_diffs_against_the_previous_release(tmp_path, monkeypatch, capsys, version, code):
    """Through the command ci_core.sh runs: within 0.1 a removed name fails; across a minor it is reported, and allowed."""
    root = checkout(tmp_path, monkeypatch, version)
    # The kit `surface_check` imports a3_surface from, as in this checkout.
    (root / "core/testkit").symlink_to(SCRIPTS.parent / "core/testkit")
    current, previous = surfaces(tmp_path, PLANTED["removed"])
    monkeypatch.setattr(sys, "argv", ["backend_release.py", "surface", "--releases-json",
                                      str(catalog_of(tmp_path, published("v0.1.0"))),
                                      "--current", str(current), "--previous-surface", str(previous)])
    with pytest.raises(SystemExit) as ended:
        release.main()
    assert ended.value.code == code and "0 additive, 1 breaking" in capsys.readouterr().out


@pytest.mark.parametrize("defect", [
    {},
    {"missing": "delphi_core_testkit/data/golden/snapshot.json"},
    {"extra": "delphi_core/main.py"},
    {"extra": "delphi_core_testkit/data/golden/library.sqlite"},
    {"requires": ["delphi-core==0.0.9", "pytest<9,>=8.4"]},
    {"requires": ["delphi-core>=0.1.0.dev0"]},
    {"distribution": "delphi-core"},
], ids=["well-formed", "no-snapshot", "core-package", "other-payload", "other-core", "unpinned", "core-name"])
def test_a_testkit_wheel_carries_its_snapshot_and_pins_exactly_its_core(tmp_path, defect):
    path = tmp_path / "delphi_core_testkit-0.1.0.dev0-py3-none-any.whl"
    make_testkit_wheel(path, **defect)
    if not defect:
        release.inspect_wheel(path, "0.1.0.dev0", testkit=True)
        # The kit is not a core wheel, and a core wheel is not a kit.
        with pytest.raises(ValueError):
            release.inspect_wheel(path, "0.1.0.dev0")
        core = tmp_path / "core.whl"
        make_wheel(core, version="0.1.0.dev0")
        with pytest.raises(ValueError):
            release.inspect_wheel(core, "0.1.0.dev0", testkit=True)
    else:
        with pytest.raises(ValueError):
            release.inspect_wheel(path, "0.1.0.dev0", testkit=True)


def artifacts(directory, version):
    """A build's output as `check_backend_wheel.py` reads it: the wheel, its test kit, and release.json."""
    directory.mkdir()
    wheel = directory / f"delphi_core-{version}-py3-none-any.whl"
    make_wheel(wheel, version=version)
    kit = directory / f"delphi_core_testkit-{version}-py3-none-any.whl"
    make_testkit_wheel(kit, version=version)
    (directory / "release.json").write_text(json.dumps({
        "version": version, "wheel": wheel.name, "sha256": hashlib.sha256(wheel.read_bytes()).hexdigest(),
        "testkit_wheel": kit.name, "testkit_sha256": hashlib.sha256(kit.read_bytes()).hexdigest()}))
    return directory


def wheel_checker(monkeypatch):
    """`check_backend_wheel.py`, loaded beside this checkout's `backend_release`."""
    monkeypatch.setitem(sys.modules, "backend_release", release)
    spec = importlib.util.spec_from_file_location("check_backend_wheel", SCRIPTS / "check_backend_wheel.py")
    checker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(checker)
    return checker


@pytest.mark.parametrize("previous,current", [(None, "0.1.1.dev0"), ("0.1.0", "0.1.1.dev0"), ("0.1.0", "0.1.0")],
                         ids=["first-release", "after-0.1.0", "same-version-candidate"])
def test_a_build_reopens_the_library_its_previous_release_wrote(tmp_path, monkeypatch, previous, current):
    """With a previous release its wheel writes the library and this one upgrades over it; the first writes its own.
    The build is forced in before the reopen and the kit, so one at the released version never tests the published wheel."""
    checker = wheel_checker(monkeypatch)
    steps = []

    def run(args, **kwargs):
        if args[1:4] == ["-m", "pip", "install"]:
            verb = "reinstall" if "--force-reinstall" in args else "install"
            steps.append((verb, *(Path(arg).name for arg in args[4:] if not arg.startswith("-"))))
        elif args[1:4] == ["-m", "pip", "uninstall"]:
            steps.append(("uninstall", args[-1]))
        elif args[1:3] == ["-I", "-c"]:
            steps.append(("testkit", "imported"))
        elif args[1] == "-I":
            steps.append((args[4], args[3]))

    monkeypatch.setattr(checker.subprocess, "run", run)
    monkeypatch.setattr(checker.venv, "EnvBuilder", lambda **kwargs: SimpleNamespace(create=lambda path: None))
    baseline = ["--previous-artifacts", str(artifacts(tmp_path / "baseline", previous))] if previous else []
    monkeypatch.setattr(sys, "argv", ["check_backend_wheel.py", str(artifacts(tmp_path / "dist", current)), *baseline])
    checker.main()
    wheel = f"delphi_core-{current}-py3-none-any.whl"
    created = previous or current
    # The build's test kit goes in last, named beside the wheel it pins.
    assert steps == [
        ("install", f"delphi_core-{created}-py3-none-any.whl"), ("create", created),
        *([("install", wheel), ("reinstall", wheel)] if previous else []), ("reopen", current),
        ("reinstall", wheel), ("install", wheel, f"delphi_core_testkit-{current}-py3-none-any.whl"), ("testkit", "imported"),
    ]


@pytest.mark.parametrize("fault", ["no-testkit", "testkit-digest"])
def test_a_build_is_refused_without_the_test_kit_it_made(tmp_path, monkeypatch, fault):
    checker = wheel_checker(monkeypatch)
    directory = artifacts(tmp_path / "dist", "0.1.0.dev0")
    manifest = json.loads((directory / "release.json").read_text())
    assert checker.testkit(directory, manifest).name == manifest["testkit_wheel"]
    if fault == "no-testkit":
        del manifest["testkit_wheel"], manifest["testkit_sha256"]
    else:
        manifest["testkit_sha256"] = manifest["sha256"]
    (directory / "release.json").write_text(json.dumps(manifest))
    monkeypatch.setattr(checker.venv, "EnvBuilder", lambda **kwargs: pytest.fail("a refused build was installed"))
    monkeypatch.setattr(sys, "argv", ["check_backend_wheel.py", str(directory)])
    with pytest.raises(ValueError, match="test kit|digest"):
        checker.main()


def test_wheel_metadata_must_agree_with_the_release(tmp_path):
    path = tmp_path / "backend.whl"
    make_wheel(path)
    release.inspect_wheel(path, "0.1.0")
    make_wheel(path, metadata_version="0.2.0")
    with pytest.raises(ValueError):
        release.inspect_wheel(path, "0.1.0")


@pytest.mark.parametrize("missing", release.LICENCE_FILES)
def test_wheel_carries_the_repository_licence_and_notice(tmp_path, missing):
    path = tmp_path / "backend.whl"
    make_wheel(path, missing=missing)
    with pytest.raises(ValueError, match="licence files"):
        release.inspect_wheel(path, "0.1.0")


@pytest.mark.parametrize("licence", [None, "MIT"])
def test_wheel_metadata_declares_apache_2(tmp_path, licence):
    path = tmp_path / "backend.whl"
    make_wheel(path, licence=licence)
    with pytest.raises(ValueError, match="Apache-2.0"):
        release.inspect_wheel(path, "0.1.0")


@pytest.mark.parametrize("previous", [None, "v0.1.0"], ids=["first-release", "after-0.1.0"])
def test_a_build_records_the_release_it_was_compared_with(tmp_path, monkeypatch, previous):
    """release.json names the previous release, or none for the first, through the command ci_core.sh runs."""
    version, tag = ("0.1.1", "v0.1.1") if previous else ("0.1.0", "v0.1.0")
    root = checkout(tmp_path, monkeypatch, version)
    (root / "core" / release.SURFACE_FILE).write_text(SURFACE)
    names = tmp_path / "private-names.txt"
    names.write_text("a-private-name\n")
    monkeypatch.setenv("DELPHI_PRIVATE_NAMES", str(names))
    runs = at_tag(monkeypatch, tag)
    # The tag's tree is this checkout here; test_a_release_is_built_from_its_tags_tree_alone builds from a real one.
    monkeypatch.setattr(release, "tag_tree", lambda tag, directory: root)

    def build_wheel(output, project, package, prefix, root=None):
        if package == release.TESTKIT_LAYOUT[0]:
            path = output / f"delphi_core_testkit-{version}-py3-none-any.whl"
            make_testkit_wheel(path, version=version)
        else:
            path = output / f"delphi_core-{version}-py3-none-any.whl"
            make_wheel(path, version=version)
        return path

    monkeypatch.setattr(release, "build_wheel", build_wheel)
    catalog = catalog_of(tmp_path, *([published(previous)] if previous else []))
    monkeypatch.setattr(sys, "argv", ["backend_release.py", "build", "--releases-json", str(catalog),
                                      "--output", str(tmp_path / "dist"), "--tag", tag])
    release.main()
    manifest = json.loads((tmp_path / "dist/release.json").read_text())
    assert manifest["tag"] == tag and manifest["previous_tag"] == (previous or "")
    assert manifest["compatibility_fail_on"] == "WARN"
    assert not {"baseline_sha256", "baseline_source", "previous_surface"} & set(manifest)
    assert [run for run in runs if run[1:2] == ["merge-base"]] == (
        [["git", "merge-base", "--is-ancestor", previous, "HEAD"]] if previous else [])


def test_a_published_release_is_never_rebuilt_and_says_so(tmp_path, monkeypatch):
    checkout(tmp_path, monkeypatch, "0.1.0")
    at_tag(monkeypatch, "v0.1.0")
    catalog = catalog_of(tmp_path, published("v0.1.0"))
    with pytest.raises(ValueError, match="^v0.1.0 is already published: a released tag is never rebuilt or moved"):
        release.context("v0.1.0", catalog)


def test_check_sh_builds_the_wheels_alone_from_an_empty_catalog():
    """check.sh's A2 tests the wheels offline, so as a first release would build: compared with nothing."""
    check = (SCRIPTS.parent / "check.sh").read_text()
    a2 = check[check.index("if [[ $run_alone == 1 ]]"):check.index("if [[ $run_parity == 1 ]]")]
    assert 'scripts/backend_release.py" build' in a2 and "printf '[[]]\\n'" in a2


def test_a_stable_tag_published_as_a_prerelease_is_refused(tmp_path, monkeypatch):
    """A v0.1.0 marked prerelease by mistake is invisible to `previous_tag`: the next build would think itself the first."""
    checkout(tmp_path, monkeypatch, "0.1.1.dev0")
    catalog = catalog_of(tmp_path, published("v0.1.0", prerelease=True))
    with pytest.raises(ValueError, match="v0.1.0 is published as a prerelease, but its tag is a stable release's"):
        release.context(None, catalog)
    with pytest.raises(ValueError, match="v0.1.0 is published as a prerelease"):
        release.read_catalog(catalog)
    # A prerelease spelled as one, and a draft of a stable tag, are what they say.
    catalog = catalog_of(tmp_path, published("v0.1.1-rc.1", prerelease=True), published("v0.1.0", draft=True, prerelease=True))
    assert release.context(None, catalog)["previous_tag"] == ""


def test_the_previous_command_leaves_out_the_release_being_built(tmp_path, monkeypatch, capsys):
    """ci_core.sh asks `previous --tag` which release to download: never the one it is building, and none before the first."""
    catalog = catalog_of(tmp_path, published("v0.1.0"), published("v0.1.1"))
    for args, answer in ((["--tag", "v0.1.1"], "v0.1.0"), ([], "v0.1.1"), (["--tag", "v0.1.2"], "v0.1.1")):
        monkeypatch.setattr(sys, "argv", ["backend_release.py", "previous", "--releases-json", str(catalog), *args])
        release.main()
        assert capsys.readouterr().out == f"{answer}\n"
    monkeypatch.setattr(sys, "argv", ["backend_release.py", "previous", "--releases-json", str(catalog_of(tmp_path)),
                                      "--tag", "v0.1.0"])
    release.main()
    assert capsys.readouterr().out == "\n"


def test_a_refusal_is_one_line_and_a_failing_exit_never_a_traceback(tmp_path):
    """What the release operator reads: the rule that refused, on stderr, and exit status 1."""
    (tmp_path / "releases.json").write_text("[[]]")
    for args, refusal in ((["context", "--releases-json", str(tmp_path / "releases.json"), "--tag", "v9.9.9"], "must match"),
                          (["previous", "--releases-json", str(tmp_path / "missing.json")], "No such file")):
        result = subprocess.run([sys.executable, str(SCRIPTS / "backend_release.py"), *args],
                                capture_output=True, text=True, timeout=60)
        assert result.returncode == 1 and result.stdout == ""
        assert result.stderr.startswith("backend_release.py: ") and refusal in result.stderr
        assert len(result.stderr.splitlines()) == 1 and "Traceback" not in result.stderr


def git_repository(root, files):
    """A repository of `files`, committed and tagged v0.1.0 alone, its git configured by nothing outside it."""
    for name, text in files.items():
        (root / name).parent.mkdir(parents=True, exist_ok=True)
        (root / name).write_text(text)
    env = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}
    for command in (["init", "-q"], ["add", "-A"],
                    ["-c", "user.name=release-test", "-c", "user.email=release-test@example.invalid",
                     "commit", "-q", "-m", "the release"], ["tag", "v0.1.0"]):
        subprocess.run(["git", *command], cwd=root, env=env, check=True, capture_output=True)


def test_a_release_is_built_from_its_tags_tree_alone(tmp_path, monkeypatch):
    """The review's probe: a module beside the tagged sources, untracked or ignored, never reaches a release's wheel."""
    root = tmp_path / "checkout"
    git_repository(root, {
        ".gitignore": "ignored_probe.py\n", "LICENSE": "licence", "NOTICE": "notice",
        "core/pyproject.toml": '[project]\nversion = "0.1.0"\n', "core/public-surface.txt": "surface\n",
        "core/delphi_core/main.py": "tracked", "core/testkit/pyproject.toml": "[project]\n",
        "core/testkit/delphi_core_testkit/golden.py": "tracked"})
    for package in ("core/delphi_core", "core/testkit/delphi_core_testkit"):
        (root / package / "zz_untracked_probe.py").write_text("untracked")
        (root / package / "ignored_probe.py").write_text("ignored")
    monkeypatch.setattr(release, "ROOT", root)
    names = tmp_path / "private-names.txt"
    names.write_text("a-private-name\n")
    monkeypatch.setenv("DELPHI_PRIVATE_NAMES", str(names))
    run, sources = subprocess.run, {}

    def stand_in(args, **kwargs):
        """`python -m build` and twine stand-ins; git archive and tar run for real."""
        if args[1:4] == ["-m", "build", "--wheel"]:
            source = Path(args[-1])
            package = next(path for path in source.iterdir() if path.is_dir())
            sources.setdefault(package.name, []).append(sorted(path.name for path in package.rglob("*.py")))
            if package.name == release.TESTKIT_LAYOUT[0]:
                make_testkit_wheel(Path(args[5]) / f"delphi_core_testkit-{version}-py3-none-any.whl", version=version)
            else:
                make_wheel(Path(args[5]) / f"delphi_core-{version}-py3-none-any.whl", version=version)
            return None
        if args[1:3] == ["-m", "twine"]:
            return None
        return run(args, **kwargs)

    monkeypatch.setattr(release.subprocess, "run", stand_in)
    for version, tag in (("0.1.0", "v0.1.0"), ("0.1.0.dev0", None)):
        monkeypatch.setattr(release, "context", lambda *args, **kwargs: {"version": version, "tag": tag or ""})
        release.build(tmp_path / f"dist-{tag}", tag, tmp_path / "releases.json")
    # The release holds what v0.1.0 committed; a development build is the checkout as it stands.
    assert sources == {"delphi_core": [["main.py"], ["ignored_probe.py", "main.py", "zz_untracked_probe.py"]],
                       "delphi_core_testkit": [["golden.py"], ["golden.py", "ignored_probe.py", "zz_untracked_probe.py"]]}
    assert (tmp_path / "dist-v0.1.0" / release.SURFACE_FILE).read_text() == "surface\n"


class Started(Exception):
    """Raised where a build that passed its A8 gate would begin."""


@pytest.mark.parametrize("named", [None, "", "missing"], ids=["unset", "empty", "not-a-file"])
def test_a_tagged_build_refuses_without_the_private_names_list(tmp_path, monkeypatch, named):
    """A8 fails closed on the release path, though day-to-day gates skip it."""
    if named is None:
        monkeypatch.delenv("DELPHI_PRIVATE_NAMES", raising=False)
    else:
        monkeypatch.setenv("DELPHI_PRIVATE_NAMES", str(tmp_path / named) if named else "")
    monkeypatch.setattr(release, "context", lambda *args, **kwargs: pytest.fail("a refused build went on"))
    with pytest.raises(ValueError, match="A release scans the tree for private names .* DELPHI_PRIVATE_NAMES"):
        release.build(tmp_path / "dist", "v0.1.0", tmp_path / "releases.json")


def test_a_build_goes_on_with_the_list_or_without_a_tag(tmp_path, monkeypatch):
    def started(*args, **kwargs):
        raise Started

    monkeypatch.setattr(release, "context", started)
    monkeypatch.delenv("DELPHI_PRIVATE_NAMES", raising=False)
    with pytest.raises(Started):
        release.build(tmp_path / "dist", None, tmp_path / "releases.json")
    names = tmp_path / "names.txt"
    names.write_text("a-private-name\n")
    monkeypatch.setenv("DELPHI_PRIVATE_NAMES", str(names))
    with pytest.raises(Started):
        release.build(tmp_path / "dist", "v0.1.0", tmp_path / "releases.json")


def test_the_kit_wheel_must_carry_every_module_of_the_kit():
    """A module added to the kit, such as one of its layering checks, is required of its wheel too."""
    kit = release.ROOT / "core/testkit"
    modules = {path.relative_to(kit).as_posix() for path in (kit / "delphi_core_testkit").rglob("*.py")
               if "__pycache__" not in path.parts}
    assert modules == {name for name in release.TESTKIT_FILES if name.endswith(".py")}


def test_the_core_wheel_requires_files_the_package_has():
    """Every runtime file required of the wheel is one core's package holds, so a rename fails here, not at a release."""
    assert all((release.ROOT / "core" / name).is_file() for name in release.RUNTIME_FILES)


def test_the_core_declares_the_licence_its_wheel_carries():
    project = release.tomllib.loads((release.ROOT / "core/pyproject.toml").read_text())["project"]
    assert project["license"] == "Apache-2.0"
    assert tuple(project["license-files"]) == release.LICENCE_FILES
    assert all((release.ROOT / name).is_file() for name in release.LICENCE_FILES)


def test_the_previous_releases_wheel_is_held_to_its_digest_not_to_todays_file_list(tmp_path, monkeypatch):
    """A file this release adds to RUNTIME_FILES must not fail the reopen against a wheel already published."""
    checker = wheel_checker(monkeypatch)
    previous = artifacts(tmp_path / "baseline", "0.1.0")
    inspected = []
    monkeypatch.setattr(checker, "inspect_wheel", lambda path, version, **kwargs: inspected.append(version))
    checker.artifact(previous, published=True)
    assert inspected == []
    checker.artifact(previous)
    assert inspected == ["0.1.0"]
    # The digest is still checked.
    manifest = json.loads((previous / "release.json").read_text())
    (previous / manifest["wheel"]).write_bytes(b"tampered")
    with pytest.raises(ValueError, match="digest"):
        checker.artifact(previous, published=True)
