"""Install and exercise a wheel without source-checkout imports or developer extras.

Run with the Python version being tested. The temporary virtualenv deliberately
has no system site-packages, and the probe runs with -I from outside the repo.
The test kit built beside the wheel is installed last, over the wheel it pins.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import venv

from backend_release import inspect_wheel

ROOT = Path(__file__).resolve().parents[1]
#: What a product imports from the kit, and the snapshot it reads, from the installed wheel.
TESTKIT_PROBE = (
    "import importlib.util\n"
    "from delphi_core_testkit import contracts, golden\n"
    "assert golden.snapshot() and contracts.chat_tool_names() and contracts.READABLE_CHARS\n"
    "for name in ('conformance', 'provider', 'matrix'):\n"
    "    assert importlib.util.find_spec(f'delphi_core_testkit.{name}'), name\n"
    "# What a product's suite imports: every conformance module, nothing of core's own tests.\n"
    "from delphi_core_testkit import conformance\n"
    "assert conformance.TESTS and len(conformance.TESTS) == len(set(conformance.TESTS))\n"
    "# The layering checks a product's gate runs from its pinned kit, as a command.\n"
    "import subprocess, sys\n"
    "from delphi_core_testkit.abstraction import a1_imports, a3_surface, a4_http, a6_settings, a7_same_code, a8_private_names\n"
    "listed = subprocess.run([sys.executable, '-m', 'delphi_core_testkit.abstraction'], capture_output=True, text=True)\n"
    "assert listed.returncode == 2 and 'private-names' in listed.stderr, listed.stderr\n"
)


def held(directory: Path, name: str, digest: str) -> Path:
    """A file release.json names, in its directory, with the digest it records."""
    path = directory / name
    if path.parent != directory or path.suffix != ".whl":
        raise ValueError("Invalid wheel filename")
    if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
        raise ValueError(f"{name} digest does not match release.json")
    return path


def artifact(directory: Path, *, published: bool = False) -> tuple[Path, dict]:
    """`published=True` for the previous release's wheel: what it carries was fixed
    when it shipped, so only its digest is checked, never today's file list."""
    directory = directory.resolve()
    manifest = json.loads((directory / "release.json").read_text())
    wheel = held(directory, manifest["wheel"], manifest["sha256"])
    if not published:
        inspect_wheel(wheel, manifest["version"])
    return wheel, manifest


def testkit(directory: Path, manifest: dict) -> Path:
    """The test kit a build makes beside its wheel."""
    if "testkit_wheel" not in manifest:
        raise ValueError("release.json names no test kit, which every build makes")
    kit = held(directory.resolve(), manifest["testkit_wheel"], manifest["testkit_sha256"])
    inspect_wheel(kit, manifest["version"], testkit=True)
    return kit


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifacts", type=Path)
    parser.add_argument("--openapi", type=Path)
    parser.add_argument("--previous-artifacts", type=Path)
    args = parser.parse_args()
    wheel, manifest = artifact(args.artifacts)
    kit = testkit(args.artifacts, manifest)
    initial, initial_manifest = artifact(args.previous_artifacts, published=True) if args.previous_artifacts else (wheel, manifest)
    with tempfile.TemporaryDirectory(prefix="delphi-wheel-test-") as temp:
        work = Path(temp)
        environment = work / "venv"
        venv.EnvBuilder(with_pip=True).create(environment)
        python = environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        subprocess.run([str(python), "-m", "pip", "install", str(initial)], check=True, cwd=work)
        subprocess.run([str(python), "-m", "pip", "check"], check=True, cwd=work)
        # The probe sets its own config before importing the app. Its parent is
        # also temporary, so the legacy ../.env lookup cannot find user secrets.
        run = work / "run"
        run.mkdir()
        # The create phase runs this checkout's probe against the previous release's
        # wheel: it may assert only what every release has shipped (see the probe).
        probe = ROOT / "core/tests/wheel_smoke.py"
        spec = work / "openapi.json"
        for phase in ("create", "reopen"):
            expected = initial_manifest["version"] if phase == "create" else manifest["version"]
            if phase == "reopen" and args.previous_artifacts:
                # --upgrade brings any new dependency; the forced reinstall makes sure
                # the build is what reopens, also when it carries the released version
                # (main right after a release), which pip would otherwise skip.
                subprocess.run([str(python), "-m", "pip", "install", "--upgrade", str(wheel)],
                               check=True, cwd=work)
                subprocess.run([str(python), "-m", "pip", "install", "--force-reinstall", "--no-deps", str(wheel)],
                               check=True, cwd=work)
                subprocess.run([str(python), "-m", "pip", "check"], check=True, cwd=work)
            subprocess.run([str(python), "-I", str(probe), expected, phase,
                            str(spec)], check=True, cwd=run)
        # Named beside the wheel it pins, so `delphi-core` can only come from
        # that file: a pin that missed it fails here rather than reaching an index.
        # The build is forced in first, so the kit's probe never runs a published
        # wheel of the same version.
        subprocess.run([str(python), "-m", "pip", "install", "--force-reinstall", "--no-deps", str(wheel)], check=True, cwd=work)
        subprocess.run([str(python), "-m", "pip", "install", str(wheel), str(kit)], check=True, cwd=work)
        subprocess.run([str(python), "-m", "pip", "check"], check=True, cwd=work)
        subprocess.run([str(python), "-I", "-c", TESTKIT_PROBE], check=True, cwd=run)
        if args.openapi:
            args.openapi.resolve().write_bytes(spec.read_bytes())
    print("Installed wheel passed isolated startup, package-data, PDF-worker and persistence checks; "
          "its test kit installed over it")


if __name__ == "__main__":
    main()
