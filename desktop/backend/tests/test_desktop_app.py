"""
The app the shell launches is core's factory over the desktop's settings and the
local stores, and serves exactly core's API.

These are what the shell's choice of `delphi_desktop.main:app` rests on: the
interface and every desktop test talk to core's routes, so the desktop app must
publish the same ones, and a desktop must never open a database because the
environment named one.
"""
from importlib.metadata import version
import json
import os
from pathlib import Path
import subprocess
import sys
import tomllib

import delphi_core
from delphi_core.app import Stores
from delphi_core.settings import Settings
import delphi_desktop
from delphi_desktop.main import app
from delphi_desktop.settings import DesktopSettings

#: The repository root: core/ and desktop/ are beside each other there.
REPO = Path(__file__).resolve().parents[3]


def test_the_desktop_app_is_cores_factory_over_desktop_settings_and_the_local_stores():
    assert type(app.state.settings) is DesktopSettings
    assert app.state.stores == Stores.local()
    assert app.title == "Delphi API"
    assert app.version == version("delphi-core")


def test_the_desktop_serves_exactly_the_reference_api():
    """A4's precursor: same routes, operations, parameters and schemas as `delphi_core.main:app`."""
    from delphi_core.main import app as reference

    assert app.openapi() == reference.openapi()


def test_the_health_check_reports_the_local_store_even_when_the_environment_names_a_database(tmp_path):
    """
    Core's `Settings` ignores the cloud keys, and the desktop's stores are local
    whatever they say. Run in a child, as the shell runs it: a fresh import that
    reads this environment, from a working directory with no `.env`.
    """
    data = tmp_path / "data"
    code = "\n".join([
        "import json",
        "from fastapi.testclient import TestClient",
        "from delphi_desktop.main import app",
        "with TestClient(app) as client:",
        "    response = client.get('/api/health')",
        "print(json.dumps({'status': response.status_code, 'body': response.json(),",
        "                  'dataDir': str(app.state.settings.data_dir)}))",
    ])
    # The same delphi_core and delphi_desktop this process imported.
    path = [str(Path(module.__file__).parents[1]) for module in (delphi_desktop, delphi_core)]
    env = {
        **os.environ,
        "PYTHONPATH": os.pathsep.join([*path, os.environ.get("PYTHONPATH", "")]),
        "DATA_DIR": str(data),
        "DATABASE_URL": "postgresql+psycopg://nobody@127.0.0.1:9/nowhere",
        "GCS_BUCKET": "nowhere",
    }
    result = subprocess.run([sys.executable, "-c", code], cwd=tmp_path, env=env, capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stderr
    answer = json.loads(result.stdout.strip().splitlines()[-1])
    assert answer["status"] == 200
    assert answer["body"]["status"] == "ok"
    assert answer["body"]["storage"] == "local"
    assert answer["dataDir"] == str(data.resolve())


def test_desktop_settings_are_cores_with_no_key_added_and_nothing_overridden():
    """
    A6's precursor. The shell passes every setting in the environment under
    core's names, so the desktop restates no key, adds none, and keeps core's
    sources and configuration: the retired-name refusal and the env file.
    """

    class Bare(Settings):
        pass

    assert DesktopSettings.__bases__ == (Settings,)
    assert {name: repr(field) for name, field in DesktopSettings.model_fields.items()} == {
        name: repr(field) for name, field in Settings.model_fields.items()
    }
    # Its own namespace is an empty subclass's: no validator, method or source.
    assert set(vars(DesktopSettings)) == set(vars(Bare))
    assert DesktopSettings.model_config == Settings.model_config
    assert DesktopSettings.settings_customise_sources.__func__ is Settings.settings_customise_sources.__func__


def test_the_desktop_wheel_is_cores_version_and_requires_exactly_that_core():
    """The runtime build installs the two together and checks the same equality in the installed metadata."""
    core = tomllib.loads((REPO / "core" / "pyproject.toml").read_text(encoding="utf-8"))["project"]
    desktop = tomllib.loads((REPO / "desktop" / "backend" / "pyproject.toml").read_text(encoding="utf-8"))["project"]
    assert desktop["name"] == "delphi-desktop"
    assert desktop["version"] == core["version"]
    assert desktop["dependencies"] == [f"delphi-core=={core['version']}"]
    assert desktop["license"] == core["license"] and desktop["license-files"] == core["license-files"]
