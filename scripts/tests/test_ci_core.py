"""scripts/ci_core.sh, run in bash over a checkout of stubs: what it asks of gh, the release tooling and oasdiff.

Every command it runs is a stub that logs one line and does none of the work, so
these tests read the script's wiring (its `--release` argument, the catalog, the
previous release it downloads) and run in a second, never the suites it runs.
"""
from pathlib import Path
import shutil
import subprocess

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "ci_core.sh"
#: The catalog's latest release, as the stub `backend_release.py previous` answers it: none, before the first.
FIRST_RELEASE = ""


def stub(path, body):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/bash\n" + body)
    path.chmod(0o755)


def run_ci(tmp_path, *args, previous=FIRST_RELEASE, fail_on="", env=None):
    """`bash scripts/ci_core.sh ARGS` in a stub checkout; returns the result, the logged calls and its output directory."""
    root = tmp_path / "checkout"
    (root / "scripts").mkdir(parents=True)
    (root / "core").mkdir()
    shutil.copy2(SCRIPT, root / "scripts/ci_core.sh")
    stubs, log = tmp_path / "bin", tmp_path / "calls.log"
    record = f'echo "$(basename "$0") $*" >> "{log}"\n'
    # The interpreter: `previous` answers the catalog's latest v release; `context` writes the
    # policy the later steps read, naming that release as the previous one.
    stub(stubs / "python", record + """case "$1 $2" in
  "scripts/backend_release.py previous") echo "PREVIOUS" ;;
  "scripts/backend_release.py context")
    while [[ $# -gt 0 ]]; do
      [[ "$1" != --github-output ]] || printf 'previous_tag=%s\\ncompatibility_fail_on=%s\\n' "PREVIOUS" "FAILON" > "$2"
      shift
    done ;;
  "-m venv") mkdir -p "$3/bin" && ln -sf "$0" "$3/bin/python" && ln -sf "$0" "$3/bin/pip" ;;
esac
""".replace("PREVIOUS", previous).replace("FAILON", fail_on))
    stub(stubs / "gh", record + '[[ "$1" != api ]] || echo "[[]]"\n'
                                'while [[ $# -gt 0 ]]; do [[ "$1" != --dir ]] || mkdir -p "$2"; shift; done\n')
    stub(stubs / "shasum", record)
    stub(stubs / "oasdiff", record + 'echo "stub: 1 breaking change"\n')
    stub(stubs / "node", record)
    stub(stubs / "git", 'echo abc1234\n')
    stub(root / "scripts/core-env.sh", f'echo "{stubs}/python"\n')
    stub(root / "scripts/layering.sh", record)
    stub(root / "scripts/core_alone.sh", record)
    stub(root / "desktop/build/runtime.sh", "ensure_frontend_runtime() { :; }\n")
    environment = {"PATH": f"{stubs}:/usr/bin:/bin", "HOME": str(tmp_path), "DELPHI_PY311": str(stubs / "python"),
                   **(env or {})}
    result = subprocess.run(["bash", str(root / "scripts/ci_core.sh"), *args], cwd=root, env=environment,
                            capture_output=True, text=True, timeout=60)
    calls = log.read_text().splitlines() if log.exists() else []
    return result, calls, root / ".delphi-build/ci-core"


def private_names(tmp_path):
    names = tmp_path / "private-names.txt"
    names.write_text("a-private-name\n")
    return {"DELPHI_PRIVATE_NAMES": str(names)}


def test_the_first_release_builds_its_tag_compared_with_nothing(tmp_path):
    """`--release v0.1.0` with no earlier v release: nothing downloaded, no reopen, no API or surface diff, and it says so."""
    result, calls, out = run_ci(tmp_path, "--release", "v0.1.0", env=private_names(tmp_path))
    assert result.returncode == 0, result.stderr
    releases = f"{out}/releases.json"
    assert "gh api --paginate --slurp repos/thekevinli/delphi/releases?per_page=100" in calls
    assert f"python scripts/backend_release.py previous --releases-json {releases} --tag v0.1.0" in calls
    identity = f"--releases-json {releases} --tag v0.1.0"
    context = f"python scripts/backend_release.py context {identity} --github-output {out}/context.env"
    # The release identity is settled first, so a wrong cut fails in seconds, not after the suites.
    first_suite = next(index for index, call in enumerate(calls) if " -m pytest " in call)
    assert calls.index(context) < first_suite
    assert "node --test core/tests/web-annotations.test.mjs core/tests/artifact-inspector.test.mjs" in calls
    assert f"python scripts/backend_release.py build {identity} --output {out}/dist" in calls
    assert not [call for call in calls if call.startswith(("gh release", "shasum", "oasdiff"))
                or "--previous-artifacts" in call or " surface " in call]
    assert "No earlier vX.Y.Z release on thekevinli/delphi: a first release, compared with nothing." in result.stdout
    assert "compatibility: no previous release, so no API or surface diff to compare" in result.stdout
    assert "Core CI passed at abc1234, for v0.1.0." in result.stdout


def test_an_untagged_run_before_the_first_release_is_a_development_build(tmp_path):
    result, calls, out = run_ci(tmp_path)
    assert result.returncode == 0, result.stderr
    assert not [call for call in calls if "--tag" in call or call.startswith("gh release")]
    assert (f"python scripts/backend_release.py context --releases-json {out}/releases.json "
            f"--github-output {out}/context.env") in calls
    assert "Core CI passed at abc1234." in result.stdout


def test_once_the_catalog_has_a_v_release_it_is_the_one_compared_with(tmp_path):
    """Its assets downloaded and held to its SHA256SUMS; within a compatibility series an API warning fails the run."""
    result, calls, out = run_ci(tmp_path, "--release", "v0.1.1", previous="v0.1.0", fail_on="WARN",
                                env=private_names(tmp_path))
    assert result.returncode == 0, result.stderr
    download = (f"gh release download v0.1.0 -R thekevinli/delphi --pattern *.whl --pattern release.json "
                f"--pattern openapi.json --pattern SHA256SUMS --pattern public-surface.txt --dir {out}/baseline")
    identity = f"--releases-json {out}/releases.json --tag v0.1.1"
    context = f"python scripts/backend_release.py context {identity} --github-output {out}/context.env"
    # gh skips a pattern that matches nothing, so the assets are held to the release's own SHA256SUMS.
    assert calls.index(download) < calls.index("shasum -a 256 -c SHA256SUMS") < calls.index(context)
    assert f"python scripts/backend_release.py build {identity} --output {out}/dist" in calls
    # The reopen and the API diff read the release it downloaded; the diff's report is kept for the notes.
    assert f"python scripts/check_backend_wheel.py {out}/dist --previous-artifacts {out}/baseline" in calls
    assert f"oasdiff breaking {out}/baseline/openapi.json {out}/dist/openapi.json --fail-on WARN" in calls
    assert (out / "oasdiff-breaking.txt").read_text() == "stub: 1 breaking change\n"
    assert (f"python scripts/backend_release.py surface {identity} --current {out}/dist/public-surface.txt "
            f"--previous-surface {out}/baseline/public-surface.txt") in calls
    assert "Core CI passed at abc1234, for v0.1.1." in result.stdout


@pytest.mark.parametrize("args,refusal", [
    (["--release"], "--release needs a tag, vX.Y.Z"),
    (["--release", ""], "--release needs a tag, vX.Y.Z"),
    (["v0.1.0"], "usage: scripts/ci_core.sh [--release vX.Y.Z]"),
    (["--release", "v0.1.0"], "set DELPHI_PRIVATE_NAMES to the private list"),
], ids=["no-tag", "empty-tag", "bare-tag", "no-private-list"])
def test_a_run_it_cannot_do_is_refused_before_anything_starts(tmp_path, args, refusal):
    result, calls, out = run_ci(tmp_path, *args)
    assert result.returncode == 2 and refusal in result.stderr
    assert calls == [] and not out.exists()
