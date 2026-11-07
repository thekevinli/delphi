"""
Core is local: it holds no cloud store, imports no cloud SDK and reads no cloud key.

A product's stores (records in a database, bytes in a bucket) live in the
product, which hands them to `create_app` and `backfill.run` (`Stores`), with
the settings, migrations and container they need. Core installs and runs with
no extras. So nothing in `delphi_core` imports a cloud SDK, core's distribution
declares none, and core's `Settings` neither declares nor reads a cloud key: a
product's `.env` may still name `DATABASE_URL` and `GCS_BUCKET`, and core
ignores both. The reference app, and a bulk command run without a product,
open the local store whatever the environment names.

These fail if the cloud store, its settings or its migrations come back.
"""
import ast
from functools import lru_cache
import importlib.metadata
import importlib.util
import re
import tomllib
from pathlib import Path

from fastapi.testclient import TestClient

import delphi_core
import delphi_core.backfill as backfill
import delphi_core_testkit
import delphi_core.config as config
import delphi_core.main as main
from delphi_core.config import Settings
from delphi_core.stores import Stores

PACKAGE = Path(delphi_core.__file__).parent
#: The test kit, a distribution of its own that every product installs beside core.
TESTKIT = Path(delphi_core_testkit.__file__).parent
#: The cloud SDKs, as a module names them and as a distribution does (normalized, `distribution`).
SDK_MODULES = ("sqlalchemy", "psycopg", "psycopg2", "google.cloud", "google.api_core", "alembic", "hypercorn")
SDK_DISTRIBUTIONS = {"sqlalchemy", "psycopg", "psycopg-binary", "psycopg2", "psycopg2-binary",
                     "google-cloud-storage", "google-api-core", "alembic", "hypercorn"}
CLOUD_KEY = re.compile(r"database_url|gcs_bucket", re.IGNORECASE)
CLOUD = {"DATABASE_URL": "postgresql+psycopg://nobody@127.0.0.1:9/nowhere", "GCS_BUCKET": "nowhere"}


def sources(package=PACKAGE):
    found = sorted(package.rglob("*.py"))
    assert package / "__init__.py" in found and len(found) > 1, f"the walk found the modules of {package}"
    return found


def imported_modules(path: Path) -> set[str]:
    """Every absolute module one file imports, nested imports too."""
    names = set()
    for node in ast.walk(ast.parse(path.read_text())):
        if isinstance(node, ast.Import):
            names |= {alias.name for alias in node.names}
        elif isinstance(node, ast.ImportFrom) and not node.level and node.module:
            names.add(node.module)
    return names


def test_no_module_of_core_or_its_test_kit_imports_a_cloud_sdk():
    assert PACKAGE / "storage" / "local.py" in sources() and TESTKIT / "conformance" / "plans.py" in sources(TESTKIT)
    found = {
        f"{path.relative_to(package.parent)}: {module}"
        for package in (PACKAGE, TESTKIT) for path in sources(package) for module in imported_modules(path)
        if any(module == sdk or module.startswith(f"{sdk}.") for sdk in SDK_MODULES)
    }
    assert not found, sorted(found)


def test_the_cloud_store_its_settings_and_its_migrations_are_not_in_core():
    gone = [PACKAGE / "cloud.py", *(PACKAGE / "storage" / f"{name}.py"
                                    for name in ("sql", "models", "engine", "gcs", "conversations_sql"))]
    project = PACKAGE.parent
    if (project / "pyproject.toml").is_file():  # a checkout, not an installed wheel
        gone += [project / "alembic", project / "alembic.ini", project / "Dockerfile", project / ".dockerignore"]
    assert [str(path) for path in gone if path.exists()] == []


def declared_requirements() -> list[str]:
    """Every requirement core's distribution declares, its extras' included."""
    pyproject = PACKAGE.parent / "pyproject.toml"
    if pyproject.is_file():
        project = tomllib.loads(pyproject.read_text())["project"]
        assert "cloud" not in project.get("optional-dependencies", {})
        return [*project["dependencies"], *(r for extra in project.get("optional-dependencies", {}).values() for r in extra)]
    return importlib.metadata.requires("delphi-core") or []


def distribution(requirement: str) -> str:
    """A requirement's distribution name, normalized as an index compares names (PEP 503)."""
    name = re.split(r"[\s\[(<>=!~;@]", requirement.strip(), maxsplit=1)[0]
    return re.sub(r"[-_.]+", "-", name).lower()


def test_core_declares_no_cloud_dependency_in_any_extra():
    assert {distribution(spelled) for spelled in ("google.cloud.storage>=2", "Google_Cloud_Storage", "google-cloud-storage")} \
        == {"google-cloud-storage"}
    names = {distribution(requirement) for requirement in declared_requirements()}
    assert "fastapi" in names, "the requirements were read"
    assert not names & SDK_DISTRIBUTIONS, sorted(names & SDK_DISTRIBUTIONS)


def test_core_settings_neither_declare_nor_read_a_cloud_key():
    assert not [name for name in Settings.model_fields if CLOUD_KEY.fullmatch(name)]
    assert not hasattr(Settings, "use_cloud_storage")
    named = Settings(_env_file=None, database_url=CLOUD["DATABASE_URL"], gcs_bucket=CLOUD["GCS_BUCKET"])
    assert not hasattr(named, "database_url") and not hasattr(named, "gcs_bucket")
    mentioned = [f"{path.relative_to(PACKAGE)}:{number}" for path in sources()
                 for number, line in enumerate(path.read_text().splitlines(), 1) if CLOUD_KEY.search(line)]
    assert mentioned == [], "core names a cloud key"


def environment_naming_the_cloud(tmp_path, monkeypatch):
    """A process environment and a `../.env` that both name a database and a bucket; settings read afresh."""
    (tmp_path / ".env").write_text("".join(f"{key}={value}\n" for key, value in CLOUD.items()))
    (tmp_path / "work").mkdir()
    monkeypatch.chdir(tmp_path / "work")
    for key, value in CLOUD.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(config, "_loaded", lru_cache(config._loaded.__wrapped__))


def test_the_reference_app_runs_on_the_local_stores_whatever_its_environment_names(tmp_path, monkeypatch):
    environment_naming_the_cloud(tmp_path, monkeypatch)
    # `delphi_core/main.py` run afresh as a module of its own, so the suite's
    # reference app and its cached settings are left as they were.
    spec = importlib.util.spec_from_file_location("delphi_core._reference_probe", main.__file__)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    app = module.app
    assert type(app.state.settings) is Settings and app.state.stores == Stores.local()
    with TestClient(app) as client:
        assert client.get("/api/health").json()["storage"] == "local"
    assert (tmp_path / "data").is_dir()


def test_a_bulk_command_run_without_a_product_opens_the_local_store(tmp_path, monkeypatch):
    environment_naming_the_cloud(tmp_path, monkeypatch)
    settings, stores = backfill.default_stores()
    assert type(settings) is Settings and stores == Stores.local()
    assert settings.data_dir == (tmp_path / "data").resolve()
