"""A2 (Plan 4 §3.2): core stands alone, installed from its wheel with nothing else of ours.

Run by `scripts/core_alone.sh`, as a copy in a temporary directory outside the
repository, with the clean virtualenv's interpreter, isolated (`-I`), so neither
the working directory nor PYTHONPATH can lend it a module:

    python -I core_alone.py probe               # imports, the app, the PDF worker
    python -I core_alone.py suite [pytest args] # the core suite, from a copy of core/tests

`probe` holds the venv to what A2 promises: core and its kit installed there and
nowhere else, no product package and no cloud SDK importable; every `delphi_core`
module imports without the kit's help; the reference app builds and answers its
health check; `-m delphi_core.pdf_worker` runs one operation in a child. `suite`
runs pytest in the current directory, then refuses the run if any `delphi_core`
or `delphi_core_testkit` module it imported came from outside the venv.
"""
import importlib
import importlib.util
import json
import os
from pathlib import Path
import pkgutil
import subprocess
import sys
import tempfile

CORE, KIT = "delphi_core", "delphi_core_testkit"
#: What the venv must not hold: either product, and the cloud SDKs only a product may use (rule 5).
ABSENT = ("delphi_desktop", "delphi_web", "sqlalchemy", "psycopg", "psycopg2", "google.cloud", "alembic", "hypercorn")


def ours(name):
    return any(name == top or name.startswith(top + ".") for top in (CORE, KIT))


def outside(modules, prefix):
    """Each of our loaded modules whose file is not under `prefix`, as `name: file`."""
    prefix = Path(prefix).resolve()
    found = []
    for name, module in sorted(modules.items()):
        if not ours(name) or module is None:
            continue
        where = getattr(module, "__file__", None)
        if where is None or not Path(where).resolve().is_relative_to(prefix):
            found.append(f"{name}: {where or 'no file'}")
    return found


def present(name):
    try:
        return importlib.util.find_spec(name) is not None
    except ModuleNotFoundError:  # a dotted name whose parent is absent
        return False


def import_everything(package):
    """(modules imported, failures as `name: error`) for every module under `package`."""
    root = importlib.import_module(package)
    imported, failures = [package], []
    for info in pkgutil.walk_packages(root.__path__, prefix=package + "."):
        try:
            importlib.import_module(info.name)
            imported.append(info.name)
        except Exception as error:  # noqa: BLE001 - every failure is the finding
            failures.append(f"{info.name}: {type(error).__name__}: {error}")
    return imported, failures


def probe():
    problems = [f"{name} is importable; the venv holds core and its kit alone" for name in ABSENT if present(name)]
    work = Path(tempfile.mkdtemp(prefix="delphi-core-alone-"))
    os.environ["DATA_DIR"] = str(work / "data")
    imported, failures = import_everything(CORE)
    problems += [f"does not import: {line}" for line in failures]
    problems += [f"a core module imported the test kit: {name}" for name in sorted(sys.modules)
                 if name == KIT or name.startswith(KIT + ".")]
    from fastapi.testclient import TestClient
    from delphi_core.main import app

    with TestClient(app) as client:
        health = client.get("/api/health")
    if health.status_code != 200 or health.json().get("status") != "ok":
        problems.append(f"the reference app's health check answered {health.status_code}: {health.text[:200]}")
    if not app.openapi().get("paths"):
        problems.append("the reference app publishes no paths")
    from pypdf import PdfWriter

    writer = PdfWriter()
    writer.add_blank_page(width=612, height=792)
    pdf, request, response = work / "blank.pdf", work / "request.json", work / "response.json"
    writer.write(pdf)
    request.write_text(json.dumps({"operation": "source_inventory", "payload": {"path": str(pdf), "extractedText": ""}}))
    worker = subprocess.run([sys.executable, "-I", "-m", f"{CORE}.pdf_worker", str(request), str(response)],
                            capture_output=True, text=True, timeout=60, cwd=work)
    answer = json.loads(response.read_text()) if response.is_file() else {}
    if worker.returncode != 0 or "result" not in answer:
        problems.append(f"-m {CORE}.pdf_worker exited {worker.returncode} with {answer or worker.stderr[-400:]}")
    problems += [f"loaded from outside the venv: {line}" for line in outside(sys.modules, sys.prefix)]
    for line in problems:
        print(f"FAIL: {line}", file=sys.stderr)
    print(f"core alone: {len(imported)} modules of {CORE} imported in {sys.prefix}; the reference app answered; "
          f"the PDF worker ran; {len(problems)} problems.")
    return 1 if problems else 0


def suite(arguments):
    import pytest

    code = pytest.main(list(arguments))
    stray = outside(sys.modules, sys.prefix)
    for line in stray:
        print(f"FAIL: the suite imported this from outside the venv: {line}", file=sys.stderr)
    if not any(name == CORE for name in sys.modules):
        print(f"FAIL: the suite never imported {CORE}", file=sys.stderr)
        return 1
    return 1 if stray else int(code)


def main(argv):
    if argv[:1] == ["probe"]:
        return probe()
    if argv[:1] == ["suite"]:
        return suite(argv[1:])
    print("usage: python -I scripts/core_alone.py probe | suite [pytest arguments]", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
