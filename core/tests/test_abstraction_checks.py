"""Plan 4's layering checks (§3.2) must pass a clean case and fail a planted violation, naming it.

The checks ship in the test kit (`delphi_core_testkit.abstraction`), so a product's
gate runs the checks of the core it pins. Every case builds its own synthetic
input: a package tree, a pair of OpenAPI documents, a few pydantic-settings
classes, a wheel, a git checkout. Nothing here reads the checkout around it: the
gates run each check against the real tree (`check.sh --core`), and this suite
also runs from a copy of itself against the installed wheels (A2,
`scripts/ci_core.sh`). Some cases run the shipped command as a process, because
its exit status is what the gates act on.
"""
import copy
import json
from pathlib import Path
import shutil
import subprocess
import sys
import textwrap
from typing import Optional

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
import pytest

from delphi_core_testkit import abstraction
from delphi_core_testkit.abstraction import (
    a1_imports as a1,
    a3_surface as a3,
    a4_http as a4,
    a6_settings as a6,
    a7_same_code as a7,
)


def run(*args, cwd=None):
    """The shipped command, as a gate runs it."""
    return subprocess.run([sys.executable, "-m", "delphi_core_testkit.abstraction", *map(str, args)],
                          capture_output=True, text=True, timeout=120, cwd=cwd)


def write(root, files):
    for name, text in files.items():
        path = Path(root) / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(textwrap.dedent(text).lstrip("\n"))
    return Path(root)


@pytest.fixture
def importable(tmp_path, monkeypatch):
    """Write a package under a folder of its own, put it first on sys.path, and forget earlier imports of it."""
    made = []

    def forget(name):
        for module in [module for module in sys.modules if abstraction.within(module, name)]:
            del sys.modules[module]

    def make(name, files, folder):
        root = write(tmp_path / folder, {f"{name}/{path}": text for path, text in files.items()})
        forget(name)
        monkeypatch.syspath_prepend(str(root))
        made.append(name)
        return root

    yield make
    for name in made:
        forget(name)


def test_the_command_lists_its_checks():
    result = run()
    assert result.returncode == 2
    for name in ("imports", "surface", "http", "settings", "versions", "wheel", "private-names"):
        assert name in result.stderr


# ---------------------------------------------------------------- A1 · import direction

LAYERED = {
    "delphi_core/__init__.py": "",
    "delphi_core/app.py": """
        from .settings import Settings
        from .routers import chat
        from .storage import LocalStorage
        CORE_ROUTERS = (chat,)
        __all__ = ["create_app", "Stores"]
        """,
    "delphi_core/settings.py": "from pydantic_settings import BaseSettings\n__all__ = ['Settings']\n",
    "delphi_core/main.py": "from .app import create_app\nfrom .routers import chat, memory\n",
    "delphi_core/deps.py": "from .storage import LocalStorage, Storage\n",
    "delphi_core/routers/__init__.py": "",
    "delphi_core/routers/chat.py": "from ..harness import loop\nfrom ..storage import Storage\nimport openai\n",
    "delphi_core/routers/memory.py": "from delphi_core.memory_maintenance import pipeline\n",
    "delphi_core/harness/__init__.py": "",
    "delphi_core/harness/loop.py": "import httpx\nfrom ..storage.base import Storage\nfrom ..storage import rules\n",
    "delphi_core/memory_maintenance/__init__.py": "",
    "delphi_core/memory_maintenance/pipeline.py": "from ..harness import loop\nfrom delphi_core.storage.base import Storage\n",
    "delphi_core/storage/__init__.py": "from .base import Storage\nfrom .local import LocalStorage\n__all__ = ('Storage',)\n__all__ += ('LocalStorage',)\n",
    "delphi_core/storage/base.py": "import abc\n",
    "delphi_core/storage/local.py": "from .base import Storage\nfrom . import rules\n",
    "delphi_core/storage/rules.py": "from ..harness.loop import score\n__all__ = ['lexical_score', 'tsquery_all']\n",
    "delphi_core/backfill/__init__.py": "from ..routers import memory\nfrom ..deps import get_storage\n",
    "delphi_desktop/__init__.py": "",
    "delphi_desktop/main.py": """
        from delphi_core.app import create_app, Stores
        from delphi_core.storage import LocalStorage, Storage
        from delphi_core import backfill, settings
        from .settings import DesktopSettings
        """,
    "delphi_desktop/settings.py": "from delphi_core.settings import Settings\n",
    "delphi_web/__init__.py": "",
    "delphi_web/stores.py": """
        import sqlalchemy
        from google.cloud import storage
        from delphi_core.storage import Storage
        from delphi_core.storage.rules import lexical_score, tsquery_all
        """,
    "delphi_web/settings.py": "from delphi_core.settings import Settings\n",
}
PACKAGES = ("delphi_core", "delphi_desktop", "delphi_web")


def layered(tmp_path, extra=None):
    root = write(tmp_path / "tree", {**LAYERED, **(extra or {})})
    return [(root / name, None) for name in PACKAGES]


def package_args(tmp_path):
    return [argument for name in PACKAGES for argument in ("--package", tmp_path / "tree" / name)]


def test_a1_a_layered_tree_passes(tmp_path):
    violations, unreadable = a1.check(layered(tmp_path))
    assert violations == [] and unreadable == []


@pytest.mark.parametrize("path, source, rule, line, imported", [
    ("delphi_core/deps.py", "def stores():\n    from delphi_web.stores import SqlStorage\n",
     "core-imports-product", 2, "delphi_web.stores"),
    ("delphi_core/sql.py", "import sqlalchemy\n", "core-imports-cloud-sdk", 1, "sqlalchemy"),
    ("delphi_core/sql.py", "from sqlalchemy.orm import Session\n", "core-imports-cloud-sdk", 1, "sqlalchemy.orm"),
    ("delphi_core/gcs.py", "from google.cloud import storage\n", "core-imports-cloud-sdk", 1, "google.cloud"),
    ("delphi_core/gcs.py", "from google import cloud\n", "core-imports-cloud-sdk", 1, "google.cloud"),
    ("delphi_core/engine.py", "import psycopg\n", "core-imports-cloud-sdk", 1, "psycopg"),
    ("delphi_core/migrate.py", "from alembic import op\n", "core-imports-cloud-sdk", 1, "alembic"),
    ("delphi_core/serve.py", "import hypercorn.asyncio\n", "core-imports-cloud-sdk", 1, "hypercorn.asyncio"),
    ("delphi_core/lazy.py", "import importlib\nengine = importlib.import_module('sqlalchemy.engine')\n",
     "core-imports-cloud-sdk", 2, "sqlalchemy.engine"),
    ("delphi_core/typed.py", "from typing import TYPE_CHECKING\nif TYPE_CHECKING:\n    from sqlalchemy.orm import Session\n",
     "core-imports-cloud-sdk", 3, "sqlalchemy.orm"),
    ("delphi_core/kit.py", "from delphi_core_testkit import conformance\n", "imports-testkit", 1, "delphi_core_testkit"),
    ("delphi_core/harness/tool.py", "from ..routers.chat import stream\n",
     "core-layer-imports-routers", 1, "delphi_core.routers.chat"),
    ("delphi_core/memory_maintenance/commit.py", "from delphi_core.routers import memory\n",
     "core-layer-imports-routers", 1, "delphi_core.routers.memory"),
    ("delphi_core/storage/sql.py", "from .. import routers\n", "core-layer-imports-routers", 1, "delphi_core.routers"),
    ("delphi_desktop/stores.py", "from delphi_core.storage.local import LocalStorage\n",
     "product-imports-internal", 1, "delphi_core.storage.local"),
    ("delphi_desktop/stores.py", "from delphi_core import deps\n", "product-imports-internal", 1, "delphi_core.deps"),
    ("delphi_desktop/stores.py", "import delphi_core.main\n", "product-imports-internal", 1, "delphi_core.main"),
    ("delphi_desktop/stores.py", "import delphi_core\n", "product-imports-internal", 1, "delphi_core"),
    ("delphi_web/routes.py", "from delphi_core.routers import chat\n", "product-imports-internal", 1, "delphi_core.routers.chat"),
    ("delphi_web/backfill.py", "from delphi_core.backfill.memory import run\n",
     "product-imports-internal", 1, "delphi_core.backfill.memory"),
    ("delphi_web/tools.py", "from delphi_core.harness.loop import run_turn\n", "product-imports-harness-or-memory", 1, "delphi_core.harness.loop"),
    ("delphi_web/tools.py", "from delphi_core import memory_maintenance\n",
     "product-imports-harness-or-memory", 1, "delphi_core.memory_maintenance"),
    ("delphi_desktop/tools.py", "import delphi_core.harness\n", "product-imports-harness-or-memory", 1, "delphi_core.harness"),
    ("delphi_desktop/model.py", "import openai\n", "product-imports-provider-sdk", 1, "openai"),
    ("delphi_web/model.py", "from anthropic import Anthropic\n", "product-imports-provider-sdk", 1, "anthropic"),
    ("delphi_desktop/web.py", "from delphi_web import stores\n", "product-imports-product", 1, "delphi_web.stores"),
    # A surface module's own imports and constants are not its surface: only its __all__ is.
    ("delphi_desktop/routes.py", "from delphi_core.app import chat\n",
     "product-imports-unexported-name", 1, "delphi_core.app"),
    ("delphi_web/routes.py", "from delphi_core.app import create_app, CORE_ROUTERS\n",
     "product-imports-unexported-name", 1, "delphi_core.app"),
    ("delphi_web/store.py", "from delphi_core.storage.rules import score\n",
     "product-imports-unexported-name", 1, "delphi_core.storage.rules"),
    ("delphi_web/engine.py", "import psycopg2\n", None, 1, "psycopg2"),
    ("delphi_core/engine.py", "import psycopg2.extras\n", "core-imports-cloud-sdk", 1, "psycopg2.extras"),
    ("delphi_web/kit.py", "from delphi_core_testkit.provider import FakeProvider\n",
     "imports-testkit", 1, "delphi_core_testkit.provider"),
])
def test_a1_a_planted_import_fails_and_is_named(tmp_path, path, source, rule, line, imported):
    violations, _ = a1.check(layered(tmp_path, {path: source}))
    if rule is None:  # a product may use a cloud SDK; core may not
        assert violations == []
        return
    assert [(v.rule, v.found.path, v.found.line, v.found.imported) for v in violations] == [(rule, path, line, imported)]
    assert f"{path}:{line}: " in str(violations[0]) and f"imports {imported}" in str(violations[0])


def test_a1_a_name_not_in_all_is_named_and_a_name_in_it_passes(tmp_path):
    violations, _ = a1.check(layered(tmp_path, {
        "delphi_web/routes.py": "from delphi_core.app import create_app, CORE_ROUTERS, Stores\n"}))
    assert [str(v) for v in violations] == [
        "delphi_web/routes.py:1: delphi_web.routes imports delphi_core.app.CORE_ROUTERS: "
        "CORE_ROUTERS is not in delphi_core.app.__all__ (rule 4)"]


def test_a1_without_cores_package_a_name_cannot_be_shown_to_be_on_the_surface(tmp_path):
    """Fails closed: core's source is where each surface module's __all__ is read."""
    products = [entry for entry in layered(tmp_path) if entry[0].name != "delphi_core"]
    violations, _ = a1.check(products)
    assert violations and {v.rule for v in violations} == {"product-imports-unexported-name"}
    assert "has no literal __all__ in the core package given" in str(violations[0])


def test_a1_a_computed_all_is_not_trusted(tmp_path):
    violations, _ = a1.check(layered(tmp_path, {
        "delphi_core/settings.py": "names = ['Settings']\n__all__ = list(names)\n"}))
    assert [(v.rule, v.found.importer) for v in violations] == [
        ("product-imports-unexported-name", "delphi_desktop.settings"),
        ("product-imports-unexported-name", "delphi_web.settings")]


@pytest.mark.parametrize("folder", ["alembic", "scripts"])
def test_a1_a_package_no_rule_judges_is_refused_not_passed(tmp_path, folder):
    """A product's migrations or scripts given under their own name would be read and judged by nothing."""
    layered(tmp_path)
    stray = write(tmp_path / "web", {f"{folder}/__init__.py": "", f"{folder}/env.py": "import openai\n"})
    refused = run("imports", *package_args(tmp_path), "--package", stray / folder)
    assert refused.returncode == 2
    assert f"no rule judges {folder} (" in refused.stderr and "forbidden" not in refused.stderr
    named = run("imports", *package_args(tmp_path), "--package", f"delphi_web.{folder}={stray / folder}")
    assert named.returncode == 1
    assert (f"forbidden (product-imports-provider-sdk): {folder}/env.py:1: "
            f"delphi_web.{folder}.env imports openai") in named.stderr


def test_a1_the_layering_names_are_parameters(tmp_path):
    """Another core package name (`app`, as before Stage 6a): the layer rule follows it."""
    root = write(tmp_path, {"app/__init__.py": "", "app/storage/__init__.py": "from ..routers import chat\n",
                            "app/routers/__init__.py": "", "app/routers/chat.py": ""})
    violations, _ = a1.check([(root / "app", None)], a1.Layering(core="app"))
    assert [(v.rule, v.found.importer, v.found.imported) for v in violations] == [
        ("core-layer-imports-routers", "app.storage", "app.routers.chat")]


def test_a1_from_import_of_a_name_is_an_import_of_its_module(tmp_path):
    """`from sqlalchemy import Integer, Text` is one import of sqlalchemy, not of `sqlalchemy.Integer`."""
    violations, _ = a1.check(layered(tmp_path, {"delphi_core/sql.py": "from sqlalchemy import Integer, Text\n"}))
    assert [v.found.imported for v in violations] == ["sqlalchemy"]


def test_a1_a_file_that_does_not_parse_fails(tmp_path):
    _, unreadable = a1.check(layered(tmp_path / "syntax", {"delphi_core/broken.py": "def (:\n"}))
    assert len(unreadable) == 1 and unreadable[0].startswith("delphi_core/broken.py: ")
    _, unreadable = a1.check(layered(tmp_path / "climb", {"delphi_core/climb.py": "from ... import x\n"}))
    assert unreadable == ["delphi_core/climb.py: line 1: a relative import climbs above the top-level package"]


def test_a1_command_passes_a_layered_tree_and_fails_a_planted_import(tmp_path):
    layered(tmp_path / "a")
    clean = run("imports", *package_args(tmp_path / "a"))
    assert clean.returncode == 0, clean.stderr
    assert "0 forbidden imports" in clean.stdout
    layered(tmp_path / "b", {"delphi_core/storage/sql.py": "import sqlalchemy\n"})
    planted = run("imports", *package_args(tmp_path / "b"))
    assert planted.returncode == 1
    assert ("forbidden (core-imports-cloud-sdk): delphi_core/storage/sql.py:1: "
            "delphi_core.storage.sql imports sqlalchemy") in planted.stderr
    reported = run("imports", "--report", *package_args(tmp_path / "b"))
    assert reported.returncode == 0 and "delphi_core/storage/sql.py:1" in reported.stderr


@pytest.mark.parametrize("entries, code, message", [
    ("delphi_core.storage.sql : sqlalchemy : the SQL store leaves core at 6d\n", 0, "1 excused"),
    ("delphi_core.storage.* : sqlalchemy : the SQL store leaves core at 6d\n", 0, "1 excused"),
    ("delphi_core.storage.sql : sqlalchemy : moves at 6d\ndelphi_core.harness.loop : openai : never used\n",
     1, "excuses nothing; remove it: delphi_core.harness.loop : openai"),
    ("delphi_core.storage.sql : sqlalchemy.orm : too narrow\n", 1, "forbidden (core-imports-cloud-sdk)"),
    ("delphi_core.storage.sql : sqlalchemy\n", 1, "not `importer : imported : reason`"),
    ("delphi_core.storage.sql : not a module : why\n", 1, "not module names"),
])
def test_a1_exceptions_excuse_with_a_reason_and_go_stale(tmp_path, entries, code, message):
    layered(tmp_path, {"delphi_core/storage/sql.py": "import sqlalchemy\n"})
    exceptions = tmp_path / "exceptions.txt"
    exceptions.write_text("# a comment\n\n" + entries)
    result = run("imports", "--exceptions", exceptions, *package_args(tmp_path))
    assert result.returncode == code, result.stderr
    assert message in result.stderr + result.stdout


def test_a1_require_empty_fails_on_any_entry(tmp_path):
    layered(tmp_path, {"delphi_core/storage/sql.py": "import sqlalchemy\n"})
    exceptions = tmp_path / "exceptions.txt"
    exceptions.write_text("delphi_core.storage.sql : sqlalchemy : moves at 6d\n")
    result = run("imports", "--exceptions", exceptions, "--require-empty", *package_args(tmp_path))
    assert result.returncode == 1
    assert "the exceptions file must be empty: delphi_core.storage.sql : sqlalchemy" in result.stderr


def test_a1_an_exceptions_file_that_is_not_there_fails(tmp_path):
    layered(tmp_path)
    result = run("imports", "--exceptions", tmp_path / "none.txt", *package_args(tmp_path))
    assert result.returncode == 1 and "no exceptions file at" in result.stderr


def test_a1_with_no_package_the_command_refuses():
    result = run("imports")
    assert result.returncode == 2 and "no package to read" in result.stderr


# ---------------------------------------------------------------- A3 · public surface

SURFACE_PACKAGE = "w3a_surface"
SURFACE_SOURCES = {
    "__init__.py": "",
    "app.py": """
        from collections.abc import Sequence

        from .settings import Settings
        from .storage.base import Storage

        __all__ = ["Stores", "create_app", "get_current_user"]


        class Stores:
            def __init__(self, storage: Storage, objects: object = None):
                self.storage = storage


        def create_app(settings: Settings, *, stores: Stores, routers: Sequence[str] = ()) -> dict:
            return {}


        async def get_current_user(token: str | None = None) -> str:
            return ""
        """,
    "settings.py": """
        from pydantic import Field
        from pydantic_settings import BaseSettings

        __all__ = ["Settings"]


        class Settings(BaseSettings):
            app_name: str = "Delphi"
            max_pages: int = Field(default=200, ge=1)
        """,
    "storage/__init__.py": """
        from .base import PAGE_KINDS, Storage
        from .local import LocalStorage

        __all__ = ["LocalStorage", "PAGE_KINDS", "Storage"]
        """,
    "storage/base.py": """
        import abc

        PAGE_KINDS = ("concept", "source")
        _MISSING = object()


        class Storage(abc.ABC):
            @abc.abstractmethod
            def get_page(self, user: str, slug: str) -> dict:
                ...

            def page_count(self, user: str, since=_MISSING) -> int:
                return 0
        """,
    "storage/catalog.py": """
        class LocalCatalog:
            \"\"\"An internal mixin, as LocalConversationCatalog is today: its name is not on the surface.\"\"\"

            def list_conversations(self, user: str) -> list[str]:
                return []
        """,
    "storage/local.py": """
        from pathlib import Path

        from .base import Storage
        from .catalog import LocalCatalog


        class LocalStorage(LocalCatalog, Storage):
            def __init__(self, root: Path):
                self.root = root

            def get_page(self, user: str, slug: str) -> dict:
                return {}
        """,
    "storage/rules.py": """
        from .base import PAGE_KINDS

        __all__ = ["PAGE_KINDS", "lexical_score"]


        def lexical_score(text: str, terms: list[str], *, weight: float = 1.0) -> float:
            return 0.0
        """,
    "backfill/__init__.py": """
        from dataclasses import dataclass


        @dataclass
        class Command:
            name: str
            user: str | None = None


        def run(command: Command, settings, stores) -> int:
            return 0
        """,
}
SURFACE = {name: textwrap.dedent(text).lstrip("\n") for name, text in SURFACE_SOURCES.items()}


def surface(importable, folder, changes=None):
    """The rendering of the synthetic surface, with `changes` {file: (old, new)} applied first."""
    files = dict(SURFACE)
    for name, (old, new) in (changes or {}).items():
        assert old in files[name], (name, old)
        files[name] = files[name].replace(old, new)
    importable(SURFACE_PACKAGE, files, folder)
    return a3.render(SURFACE_PACKAGE)


def test_a3_the_surface_renders_names_signatures_and_members(importable):
    rendered = surface(importable, "base")
    p = SURFACE_PACKAGE
    for line in (
        f"{p}.app:create_app def: (settings: {p}.settings.Settings, *, stores: {p}.app.Stores, "
        "routers: collections.abc.Sequence[str] = ()) -> dict",
        f"{p}.app:get_current_user async def: (token: str | None = None) -> str",
        f"{p}.app:Stores.__init__ def: (self, storage: {p}.storage.Storage, objects: object = None)",
        f"{p}.settings:Settings class: (pydantic_settings.main.BaseSettings)",
        f"{p}.settings:Settings.max_pages field: int = 200",
        # An internal class is written by its exported name.
        f"{p}.storage:LocalStorage class: ({p}.storage.Storage)",
        f"{p}.storage:LocalStorage.__init__ def: (self, root: pathlib.Path)",
        f"{p}.storage:Storage.get_page abstract def: (self, user: str, slug: str) -> dict",
        f"{p}.storage:Storage.page_count def: (self, user: str, since = <object object>) -> int",
        f"{p}.storage:PAGE_KINDS value: tuple = ('concept', 'source')",
        f"{p}.storage.rules:lexical_score def: (text: str, terms: list[str], *, weight: float = 1.0) -> float",
        f"{p}.backfill:Command.name required field: str",
        f"{p}.backfill:Command.user field: str | None",
        f"{p}.settings:Settings.app_name field: str = 'Delphi'",
        f"{p}.backfill:run def: (command: {p}.backfill.Command, settings, stores) -> int",
    ):
        assert line in rendered.splitlines(), line
    assert "0x" not in rendered
    assert f"{p}.backfill:dataclass" not in rendered, "imported from outside core, so not exported"
    assert rendered == a3.render(SURFACE_PACKAGE), "the rendering is deterministic"


@pytest.mark.parametrize("changes, key, breaking, what", [
    ({"storage/rules.py": ('"lexical_score"]', '"lexical_score", "rank"]\n\n\ndef rank(x: int) -> int:\n    return x')},
     "storage.rules:rank", False, "added (def"),
    ({"storage/rules.py": ('"PAGE_KINDS", ', "")}, "storage.rules:PAGE_KINDS", True, "removed"),
    ({"storage/rules.py": ("weight: float = 1.0)", "weight: float = 1.0, floor: float = 0.0)")},
     "storage.rules:lexical_score", False, "def"),
    ({"storage/rules.py": ("weight: float = 1.0)", "weight: float = 1.0, floor: float)")},
     "storage.rules:lexical_score", True, "new keyword parameter floor has no default"),
    ({"storage/rules.py": ("terms: list[str]", "terms: tuple[str, ...]")},
     "storage.rules:lexical_score", True, "parameter terms is tuple[str, ...], was list[str]"),
    ({"storage/rules.py": ("text: str, terms: list[str]", "terms: list[str], text: str")},
     "storage.rules:lexical_score", True, "parameter 0 is terms"),
    ({"storage/rules.py": ("weight: float = 1.0", "weight: float = 2.0")},
     "storage.rules:lexical_score", True, "weight's default is 2.0, was 1.0"),
    ({"storage/rules.py": (") -> float:", ") -> int:")}, "storage.rules:lexical_score", True, "returns int instead of float"),
    ({"storage/rules.py": ("*, weight: float = 1.0", "weight: float = 1.0")},
     "storage.rules:lexical_score", False, "def"),
    ({"storage/base.py": ("    def page_count", "    @abc.abstractmethod\n    def page_total(self) -> int:\n        ...\n\n    def page_count")},
     "storage:Storage.page_total", True, "a new abstract def on an existing class"),
    ({"storage/base.py": ("    def page_count", "    @abc.abstractmethod\n    def page_count")},
     "storage:Storage.page_count", True, "became abstract"),
    ({"storage/base.py": ("    def page_count", "    def page_total(self) -> int:\n        return 0\n\n    def page_count")},
     "storage:Storage.page_total", False, "added"),
    ({"settings.py": ('app_name: str = "Delphi"', 'app_name: str = "Delphi"\n    region: str = "eu"')},
     "settings:Settings.region", False, "added (field: str = 'eu')"),
    ({"settings.py": ('app_name: str = "Delphi"', 'app_name: str = "Delphi"\n    region: str')},
     "settings:Settings.region", True, "a new required field: str"),
    ({"settings.py": ('app_name: str = "Delphi"', "app_name: str")}, "settings:Settings.app_name", True, "became required"),
    ({"backfill/__init__.py": ("name: str\n", "name: str = 'all'\n")}, "backfill:Command.name", False, "became optional"),
    ({"app.py": ('"get_current_user"]', '"get_current_user", "Settings"]')}, "app:Settings", False, "added (class"),
    # Values and defaults: a changed default and a removed member break; a member gained does not.
    ({"settings.py": ("default=200", "default=100")}, "settings:Settings.max_pages", True,
     "its default is 100, was 200"),
    ({"settings.py": ('app_name: str = "Delphi"', 'app_name: str = "Delphos"')}, "settings:Settings.app_name", True,
     "its default is 'Delphos', was 'Delphi'"),
    ({"storage/base.py": ('PAGE_KINDS = ("concept", "source")', 'PAGE_KINDS = ("concept",)')},
     "storage:PAGE_KINDS", True, "its value changed"),
    ({"storage/base.py": ('PAGE_KINDS = ("concept", "source")', 'PAGE_KINDS = ("concept", "source", "domain")')},
     "storage:PAGE_KINDS", False, "gained 'domain'"),
    ({"storage/base.py": ('PAGE_KINDS = ("concept", "source")', 'PAGE_KINDS = ("source", "concept")')},
     "storage:PAGE_KINDS", True, "its value changed"),
])
def test_a3_each_change_is_classified(importable, changes, key, breaking, what):
    before = surface(importable, "before")
    after = surface(importable, "after", changes)
    found = {change.key: change for change in a3.classify(before, after)}
    change = found[f"{SURFACE_PACKAGE}.{key}"]
    assert change.breaking is breaking, change
    assert what in change.what, change


def test_a3_a_simple_value_is_spelled_the_same_in_every_process():
    """Sets and dicts sorted, paths platform-free; anything else is written by its type alone."""
    from pathlib import PurePosixPath

    assert a3.literal(frozenset({"session", "document"})) == "frozenset({'document', 'session'})"
    assert a3.literal({"b": (1,), "a": [None, True]}) == "{'a': [None, True], 'b': (1,)}"
    assert a3.literal(PurePosixPath(".data")) == "Path('.data')"
    with pytest.raises(a3.NotSimple):
        a3.literal((1, object()))


def test_a3_an_unchanged_surface_classifies_to_nothing(importable):
    assert a3.classify(surface(importable, "one"), surface(importable, "two")) == []


def test_a3_an_internal_base_is_not_named_but_what_it_gives_is(importable):
    rendered = surface(importable, "base").splitlines()
    p = SURFACE_PACKAGE
    assert f"{p}.storage:LocalStorage class: ({p}.storage.Storage)" in rendered
    assert f"{p}.storage:LocalStorage.list_conversations def: (self, user: str) -> list[str]" in rendered
    assert not any("LocalCatalog" in line for line in rendered)


def test_a3_renaming_an_internal_base_leaves_the_snapshot_unchanged(importable):
    before = surface(importable, "before")
    after = surface(importable, "after", {"storage/catalog.py": ("LocalCatalog", "LocalConversationIndex"),
                                          "storage/local.py": ("LocalCatalog", "LocalConversationIndex")})
    assert after == before


def test_a3_removing_what_a_product_reaches_through_an_internal_base_changes_the_snapshot(importable):
    before = surface(importable, "before")
    after = surface(importable, "after", {"storage/catalog.py": (
        "    def list_conversations(self, user: str) -> list[str]:\n        return []\n", "")})
    assert after != before
    assert [str(change) for change in a3.classify(before, after)] == [
        f"breaking: {SURFACE_PACKAGE}.storage:LocalStorage.list_conversations: "
        "removed (was def: (self, user: str) -> list[str])"]


def test_a3_an_internal_base_is_replaced_by_the_exported_class_above_it(importable):
    """`class Cached(InternalStore)`, with `class InternalStore(Storage)` internal, still reads as a Storage."""
    after = surface(importable, "intermediate", {
        "storage/catalog.py": ("class LocalCatalog:",
                               "from .base import Storage\n\n\nclass InternalStore(Storage):\n    pass\n\n\n"
                               "class Cached(InternalStore):\n    pass\n\n\nclass LocalCatalog:"),
        "storage/__init__.py": ('from .local import LocalStorage\n\n__all__ = ["LocalStorage", ',
                                'from .catalog import Cached\nfrom .local import LocalStorage\n\n'
                                '__all__ = ["Cached", "LocalStorage", '),
    })
    assert f"{SURFACE_PACKAGE}.storage:Cached class: ({SURFACE_PACKAGE}.storage.Storage)" in after.splitlines()
    assert "InternalStore" not in after


def test_a3_signatures_parse_around_brackets_quotes_and_defaults():
    parameters, returned = a3.parse_signature(
        "(self, kinds: typing.Literal['a, b', 'c: d'] = 'a, b', /, *args: int, "
        "options: dict[str, int] = {'x': 1, 'y': 2}, **rest) -> tuple[int, str]")
    assert [(p.name, p.kind) for p in parameters] == [
        ("self", "positional-only"), ("kinds", "positional-only"), ("args", "*args"),
        ("options", "keyword-only"), ("rest", "**kwargs")]
    assert parameters[1].annotation == "typing.Literal['a, b', 'c: d']" and parameters[1].default == "'a, b'"
    assert parameters[3].default == "{'x': 1, 'y': 2}" and returned == "tuple[int, str]"
    assert a3.signature_change("(a, /, b)", "(renamed, /, b, c = 1)") is None
    assert a3.signature_change("(a, *args)", "(a)") == "no longer takes *args"


def test_a3_all_must_name_what_the_module_defines(importable):
    files = dict(SURFACE, **{"storage/rules.py": '__all__ = ["lexical_score"]\n'})
    importable(SURFACE_PACKAGE, files, "missing")
    with pytest.raises(AttributeError, match="__all__ names what it does not define: lexical_score"):
        a3.render(SURFACE_PACKAGE)


def test_a3_a_dependency_is_written_by_what_it_declares_under_its_exported_name(importable):
    """FastAPI's repr of `Depends` gains a field with each release; the surface names the function, as a product imports it."""
    importable("w3a_depends", {
        "__init__.py": "",
        "config.py": "def get_settings():\n    return {}\n",
        "app.py": """
            from fastapi import Cookie, Depends
            from .config import get_settings
            __all__ = ["get_settings", "get_current_user"]
            def get_current_user(session: str | None = Cookie(None), settings: dict = Depends(get_settings)) -> str:
                return ""
            """,
    }, "depends")
    rendered = a3.render("w3a_depends", ["app"])
    assert ("w3a_depends.app:get_current_user def: (session: str | None = Cookie(None), "
            "settings: dict = Depends(w3a_depends.app.get_settings)) -> str") in rendered
    assert "dependency=" not in rendered and "w3a_depends.config" not in rendered


def surface_command(tmp_path, folder, changes=None):
    files = dict(SURFACE)
    for name, (old, new) in (changes or {}).items():
        files[name] = files[name].replace(old, new)
    return write(tmp_path / folder, {f"{SURFACE_PACKAGE}/{path}": text for path, text in files.items()})


def test_a3_command_checks_against_the_snapshot_and_names_a_change(tmp_path):
    snapshot = tmp_path / "public-surface.txt"
    base = surface_command(tmp_path, "base")
    written = run("surface", "render", "--core", SURFACE_PACKAGE, "--path", base, "--output", snapshot)
    assert written.returncode == 0, written.stderr
    assert snapshot.read_text().startswith(f"# The public surface of {SURFACE_PACKAGE}")
    same = run("surface", "check", "--core", SURFACE_PACKAGE, "--path", base, "--snapshot", snapshot)
    assert same.returncode == 0, same.stderr
    changed = surface_command(tmp_path, "changed", {"storage/rules.py": ("terms: list[str]", "terms: set[str]")})
    differs = run("surface", "check", "--core", SURFACE_PACKAGE, "--path", changed, "--snapshot", snapshot)
    assert differs.returncode == 1
    assert (f"differs, breaking: {SURFACE_PACKAGE}.storage.rules:lexical_score: "
            "parameter terms is set[str], was list[str]") in differs.stderr
    missing = run("surface", "check", "--core", SURFACE_PACKAGE, "--path", base, "--snapshot", tmp_path / "none.txt")
    assert missing.returncode == 1 and "no snapshot" in missing.stderr


def test_a3_diff_fails_on_a_breaking_change_unless_the_version_allows_it(tmp_path):
    old = tmp_path / "old.txt"
    old.write_text("m:f def: (a: int) -> int\nm:g def: (a: int) -> int\n")
    additive = tmp_path / "additive.txt"
    additive.write_text("m:f def: (a: int, b: int = 0) -> int\nm:g def: (a: int) -> int\nm:h value: str\n")
    breaking = tmp_path / "breaking.txt"
    breaking.write_text("m:f def: (a: int) -> int\n")
    result = run("surface", "diff", old, additive)
    assert result.returncode == 0 and "2 additive, 0 breaking" in result.stdout
    result = run("surface", "diff", old, breaking)
    assert result.returncode == 1 and "breaking: m:g: removed" in result.stdout
    assert run("surface", "diff", old, breaking, "--breaking-allowed").returncode == 0


# ---------------------------------------------------------------- A4 · HTTP superset

def reference_app(*, extra=None, project_fields=("id", "name"), limit=10):
    from fastapi import FastAPI
    from pydantic import create_model

    Project = create_model("Project", **{field: (str, ...) for field in project_fields})
    app = FastAPI(title="Delphi", version="0.7.0")

    @app.get("/api/projects", response_model=list[Project])
    def list_projects(limit: int = limit):
        return []

    @app.post("/api/projects", response_model=Project, status_code=201)
    def create_project(project: Project):
        return project

    @app.get("/api/health")
    def health():
        return {}

    if extra:
        extra(app)
    return app.openapi()


def desktop_routes(app):
    @app.get("/api/desktop/connection")
    def connection():
        return {}


REFERENCE = reference_app()
DESKTOP = reference_app(extra=desktop_routes)


def test_a4_core_plus_routes_under_the_prefix_passes():
    assert a4.superset_violations(REFERENCE, DESKTOP, "/api/desktop/") == []
    assert a4.superset_violations(REFERENCE, REFERENCE, "/api/web/") == []


def test_a4_the_version_in_info_is_ignored():
    product = copy.deepcopy(DESKTOP)
    product["info"]["version"] = "0.7.1"
    assert a4.superset_violations(REFERENCE, product, "/api/desktop/") == []


def without(document, *keys):
    changed = copy.deepcopy(document)
    target = changed
    for key in keys[:-1]:
        target = target[key]
    del target[keys[-1]]
    return changed


@pytest.mark.parametrize("product, message", [
    (without(DESKTOP, "paths", "/api/health"), "/api/health: the core path is missing"),
    (without(DESKTOP, "paths", "/api/projects", "post"), "POST /api/projects: the core operation is missing"),
    (without(DESKTOP, "paths", "/api/projects", "post", "responses", "201"),
     "POST /api/projects: the core operation is altered: responses (201 removed)"),
    (reference_app(extra=desktop_routes, limit=50),
     "GET /api/projects: the core operation is altered: parameters changed"),
    (reference_app(extra=desktop_routes, project_fields=("id", "name", "owner")),
     "components.schemas.Project: the core component is altered"),
    (without(DESKTOP, "components", "schemas", "Project"), "components.schemas.Project: the core component is missing"),
    (reference_app(extra=lambda app: app.get("/api/extra")(lambda: {})), "GET /api/extra: added outside /api/desktop/"),
    (reference_app(extra=lambda app: app.get("/api/web/accounts")(lambda: {})),
     "GET /api/web/accounts: added outside /api/desktop/"),
    (reference_app(extra=lambda app: app.delete("/api/projects")(lambda: {})),
     "DELETE /api/projects: added to a core path, outside /api/desktop/"),
])
def test_a4_a_planted_difference_fails_and_is_named(product, message):
    found = a4.superset_violations(REFERENCE, product, "/api/desktop/")
    assert message in found, found


@pytest.mark.parametrize("path", ["/api/desktop/connection", "/api/web/billing", "/api/desktop"])
def test_a4_core_declaring_a_product_route_fails(path):
    core = reference_app(extra=lambda app: app.get(path)(lambda: {}))
    expected = f"core declares {path} under the product prefix"
    assert any(line.startswith(expected) for line in a4.core_declares_product_routes(core))
    assert any(line.startswith(expected) for line in a4.superset_violations(core, core, "/api/web/"))


def test_a4_command_reads_documents_and_apps(tmp_path):
    files = {name: tmp_path / f"{name}.json" for name in ("core", "desktop", "outside")}
    files["core"].write_text(json.dumps(REFERENCE))
    files["desktop"].write_text(json.dumps(DESKTOP))
    files["outside"].write_text(json.dumps(reference_app(extra=lambda app: app.get("/api/extra")(lambda: {}))))
    clean = run("http", "--reference", files["core"], "--product", files["desktop"], "--prefix", "/api/desktop/")
    assert clean.returncode == 0, clean.stderr
    planted = run("http", "--reference", files["core"], "--product", files["outside"], "--prefix", "/api/desktop/")
    assert planted.returncode == 1 and "not a superset: GET /api/extra: added outside /api/desktop/" in planted.stderr
    alone = run("http", "--reference", files["core"])
    assert alone.returncode == 0, alone.stderr

    write(tmp_path / "apps", {"w3a_core_app.py": """
        from fastapi import FastAPI
        app = FastAPI()

        @app.get("/api/desktop/status")
        def status():
            return {}
        """})
    app = run("http", "--reference", "w3a_core_app:app", "--path", tmp_path / "apps")
    assert app.returncode == 1 and "core declares /api/desktop/status under the product prefix /api/desktop/" in app.stderr
    unknown = run("http", "--reference", files["core"], "--product", "w3a_core_app:app", "--path", tmp_path / "apps")
    assert unknown.returncode == 2 and "pass --prefix" in unknown.stderr


def routed_core():
    """A core app as `create_app` builds one: an included router, then routes of its own."""
    from fastapi import APIRouter, FastAPI

    app = FastAPI()
    projects = APIRouter(prefix="/api/projects")

    @projects.get("")
    def list_projects():
        return []

    app.include_router(projects)

    @app.get("/api/health")
    def health():
        return {"status": "ok"}

    # One core route OpenAPI never shows, as the framing proxy is.
    @app.get("/api/projects/frame", include_in_schema=False)
    def frame():
        return {}

    return app


def hidden(app, path, *, first=False):
    """A route OpenAPI never shows, appended or put in front of every other."""
    from fastapi.routing import APIRoute

    def answer():
        return {"status": "ok"}

    route = APIRoute(path, answer, methods=["GET"], include_in_schema=False)
    app.router.routes.insert(0, route) if first else app.router.routes.append(route)
    return app


@pytest.mark.parametrize("plant, message", [
    (lambda app: hidden(app, "/api/extra"), "the route APIRoute GET /api/extra -> "),
    (lambda app: hidden(app, "/api/health", first=True), "is added outside /api/desktop/, ahead of a core route"),
    (lambda app: app.router.routes.reverse() or app, "core's routes are reordered"),
    (lambda app: hidden(app.router.routes.pop() and app, "/api/projects/frame"),
     "the core route APIRoute GET /api/projects/frame -> tests.test_abstraction_checks.routed_core.<locals>.frame "
     "is missing or replaced"),
], ids=["hidden-outside-the-prefix", "hidden-shadow-first", "reordered", "replaced-hidden"])
def test_a4_a_route_openapi_does_not_show_still_fails(plant, message):
    """Planted: what `include_in_schema=False` hides from the document, and route order, which it never shows."""
    reference, product = routed_core(), plant(routed_core())
    assert a4.superset_violations(reference.openapi(), product.openapi(), "/api/desktop/") == []
    found = a4.route_violations(reference, product, "/api/desktop/")
    assert found and any(message in line for line in found), found


def test_a4_hidden_routes_under_the_prefix_pass_and_core_may_hold_none():
    product = hidden(hidden(routed_core(), "/api/desktop/secret"), "/api/desktop/first", first=True)
    assert a4.route_violations(routed_core(), product, "/api/desktop/") == []
    core = hidden(routed_core(), "/api/web/hidden")
    assert a4.core_routes_under_products(core) == [
        "core's route table holds APIRoute GET /api/web/hidden -> "
        "tests.test_abstraction_checks.hidden.<locals>.answer under the product prefix /api/web/"]


def test_a4_command_compares_route_tables_when_both_sides_are_apps(tmp_path):
    write(tmp_path / "apps", {"w3a_routed.py": """
        from fastapi import FastAPI
        from fastapi.routing import APIRoute

        def build():
            app = FastAPI()
            @app.get("/api/health")
            def health():
                return {"status": "ok"}
            return app

        def shadow():
            return {"status": "shadowed"}

        reference = build()
        product = build()
        product.router.routes.insert(0, APIRoute("/api/health", shadow, include_in_schema=False))
        """})
    result = run("http", "--reference", "w3a_routed:reference", "--product", "w3a_routed:product",
                 "--prefix", "/api/desktop/", "--path", tmp_path / "apps")
    assert result.returncode == 1
    assert "not a superset: the route APIRoute GET /api/health -> w3a_routed.shadow is added outside" in result.stderr


# ---------------------------------------------------------------- A6 · settings

def localhost():
    return ["http://127.0.0.1:3000"]


class CoreSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    app_name: str = "Delphi"
    max_pages: int = Field(default=200, ge=1)
    origins: list[str] = Field(default_factory=localhost)
    data_dir: str | None = None
    memory_review_model: str = Field(default="luna", validation_alias="MEMORY_REVIEW_MODEL")

    @field_validator("app_name")
    @classmethod
    def app_name_is_set(cls, value):
        return value


class WebSettings(CoreSettings):
    database_url: str = ""
    gcs_bucket: str = ""
    # Restated exactly as core says it: allowed.
    app_name: str = "Delphi"
    data_dir: Optional[str] = None
    origins: list[str] = Field(default_factory=lambda: ["http://127.0.0.1:3000"])

    @field_validator("gcs_bucket")
    @classmethod
    def bucket_is_named(cls, value):
        return value


def test_a6_a_subclass_that_only_adds_keys_passes():
    assert a6.settings_violations(CoreSettings, WebSettings) == []


def planted_settings(case):
    """One product subclass per planted change."""
    if case == "annotation":
        class Product(CoreSettings):
            max_pages: float = Field(default=200, ge=1)
    elif case == "default":
        class Product(CoreSettings):
            max_pages: int = Field(default=100, ge=1)
    elif case == "constraint":
        class Product(CoreSettings):
            max_pages: int = 200
    elif case == "factory":
        class Product(CoreSettings):
            origins: list[str] = Field(default_factory=list)
    elif case == "factory-to-value":
        class Product(CoreSettings):
            origins: list[str] = ["http://127.0.0.1:3000"]
    elif case == "alias":
        class Product(CoreSettings):
            memory_review_model: str = "luna"
    elif case == "env-prefix":
        class Product(CoreSettings):
            model_config = SettingsConfigDict(env_prefix="WEB_")
    elif case == "field-validator":
        class Product(CoreSettings):
            @field_validator("max_pages")
            @classmethod
            def at_most_fifty(cls, value):
                return min(value, 50)
    elif case == "replaced-validator":
        class Product(CoreSettings):
            @field_validator("app_name")
            @classmethod
            def app_name_is_set(cls, value):
                return value.upper()
    elif case == "sources":
        class Product(CoreSettings):
            @classmethod
            def settings_customise_sources(cls, settings_cls, init_settings, *sources):
                return (init_settings,)
    return Product


@pytest.mark.parametrize("case, message", [
    ("annotation", "max_pages: annotated float, core says int"),
    ("default", "max_pages: defaults to 100, core says 200"),
    ("constraint", "max_pages: constraints [], core says [Ge(ge=1)]"),
    ("factory", "origins: defaults to what list makes, core says what localhost makes"),
    ("factory-to-value", "origins: defaults to ['http://127.0.0.1:3000'], core says what localhost makes"),
    ("alias", "memory_review_model: validation_alias None, core says 'MEMORY_REVIEW_MODEL'"),
    ("env-prefix", "model_config['env_prefix'] is 'WEB_', core says ''"),
    ("field-validator", "validator at_most_fifty validates core keys max_pages"),
    ("replaced-validator", "validator app_name_is_set replaces core's"),
    ("sources", "tests.test_abstraction_checks.planted_settings.<locals>.Product overrides settings_customise_sources"),
])
def test_a6_a_planted_change_to_a_core_key_fails_and_is_named(case, message):
    found = a6.settings_violations(CoreSettings, planted_settings(case))
    assert len(found) == 1 and found[0].startswith(message), found


def test_a6_a_class_that_does_not_subclass_core_fails():
    class Elsewhere(BaseSettings):
        app_name: str = "Delphi"

    assert a6.settings_violations(CoreSettings, Elsewhere) == [
        f"{Elsewhere.__module__}.{Elsewhere.__qualname__} does not subclass {CoreSettings.__module__}.CoreSettings"]


SETTINGS_TREE = {
    "w3a_core/__init__.py": "",
    "w3a_core/settings.py": """
        from pydantic import Field
        from pydantic_settings import BaseSettings


        class Settings(BaseSettings):
            app_name: str = "Delphi"
            max_pages: int = Field(default=200, ge=1)
        """,
    "w3a_web/__init__.py": "",
    "w3a_web/settings.py": """
        from w3a_core.settings import Settings


        class WebSettings(Settings):
            database_url: str = ""
        """,
    "w3a_desktop/__init__.py": "",
    "w3a_desktop/main.py": "APP = 'no settings of its own'\n",
}


def test_a6_command_discovers_each_subclass_and_names_a_change(tmp_path):
    clean = write(tmp_path / "clean", SETTINGS_TREE)
    args = ("settings", "--base", "w3a_core.settings:Settings", "--discover", "w3a_web")
    result = run(*args, "--path", clean)
    assert result.returncode == 0, result.stderr
    assert "1 subclasses (w3a_web.settings.WebSettings); 0 changed keys" in result.stdout
    planted = write(tmp_path / "planted", {**SETTINGS_TREE, "w3a_web/settings.py": """
        from pydantic import Field
        from w3a_core.settings import Settings


        class WebSettings(Settings):
            database_url: str = ""
            max_pages: int = Field(default=20, ge=1)
        """})
    result = run(*args, "--path", planted)
    assert result.returncode == 1
    assert "changes a core key: w3a_web.settings.WebSettings: max_pages: defaults to 20, core says 200" in result.stderr
    none = run("settings", "--base", "w3a_core.settings:Settings", "--discover", "w3a_desktop", "--path", clean)
    assert none.returncode == 1 and "w3a_desktop: no subclass of w3a_core.settings.Settings" in none.stderr
    named = run("settings", "--base", "w3a_core.settings:Settings", "--product", "w3a_web.settings:WebSettings",
                "--path", clean)
    assert named.returncode == 0, named.stderr


# ---------------------------------------------------------------- A7 · same code everywhere

@pytest.mark.parametrize("npm, python", [
    ("0.7.0-dev.0", "0.7.0.dev0"),
    ("0.7.0-rc.1", "0.7.0rc1"),
    ("0.7.0", "0.7.0"),
    ("0.7.0-alpha.1", "0.7.0a1"),
    ("1.2.3-beta.2", "1.2.3b2"),
    ("0.7.0-rc.1.dev.2", "0.7.0rc1.dev2"),
    ("0.7.0-dev", "0.7.0.dev0"),
    ("0.7.0-rc1", "0.7.0-rc.1"),
    ("0.7.0-dev.0", "0.7.0dev0"),
    ("0.7.0", "0.7"),
])
def test_a7_the_two_spellings_of_one_version_match(npm, python):
    assert a7.same_version(npm, python)


@pytest.mark.parametrize("npm, python", [
    ("0.7.0-dev.0", "0.7.0rc0"),
    ("0.7.0-rc.1", "0.7.0rc2"),
    ("0.7.0-rc.1", "0.7.0"),
    ("0.7.0", "0.7.0.dev0"),
    ("0.7.0", "0.7.0.post1"),
    ("0.6.9", "0.7.0"),
    ("0.7.0-dev.0", "0.7.0.dev1"),
    ("0.7.0-rc.1", "0.7.0.dev1"),
    ("0.7.0-beta.1", "0.7.0a1"),
])
def test_a7_different_versions_do_not_match(npm, python):
    assert not a7.same_version(npm, python)


@pytest.mark.parametrize("npm, python, message", [
    ("0.7", "0.7.0", "not a semver version"),
    ("0.7.0-nightly.3", "0.7.0", "has no PEP 440 spelling"),
    ("0.7.0+build.5", "0.7.0", "build metadata"),
    ("0.7.0", "1!0.7.0", "an epoch or a local part"),
    ("0.7.0", "0.7.0+desktop", "an epoch or a local part"),
    ("0.7.0", "seven", "not a PEP 440 version"),
])
def test_a7_a_version_with_no_counterpart_is_refused(npm, python, message):
    with pytest.raises(ValueError, match=message):
        a7.same_version(npm, python)


def versions(tmp_path, npm, python):
    tmp_path.mkdir(parents=True)
    package_json = tmp_path / "package.json"
    package_json.write_text(json.dumps({"name": "delphi", "version": npm}))
    pyproject = tmp_path / "pyproject.toml"
    pyproject.write_text(f'[project]\nname = "delphi-core"\nversion = "{python}"\n')
    return package_json, pyproject


def test_a7_command_compares_package_json_with_pyproject(tmp_path):
    package_json, pyproject = versions(tmp_path / "same", "0.7.0-rc.1", "0.7.0rc1")
    same = run("versions", "--package-json", package_json, "--pyproject", pyproject)
    assert same.returncode == 0, same.stderr
    package_json, pyproject = versions(tmp_path / "apart", "0.7.0-rc.1", "0.7.0rc2")
    apart = run("versions", "--package-json", package_json, "--pyproject", pyproject)
    assert apart.returncode == 1
    assert "package.json says 0.7.0-rc.1 (0.7.0rc1 in PEP 440), " in apart.stderr
    assert "pyproject.toml says 0.7.0rc2: one version for app and core" in apart.stderr


def test_a7_every_pyproject_given_must_name_the_apps_version(tmp_path):
    """Core's, the test kit's and the desktop layer's: one release, one version (`0.7.0-rc.1` is `0.7.0rc1`)."""
    package_json, core = versions(tmp_path / "core", "0.7.0-rc.1", "0.7.0rc1")
    layer = tmp_path / "layer.toml"
    layer.write_text('[project]\nname = "delphi-desktop"\nversion = "0.7.0rc1"\n')
    same = run("versions", "--package-json", package_json, "--pyproject", core, "--pyproject", layer)
    assert same.returncode == 0, same.stderr
    layer.write_text('[project]\nname = "delphi-desktop"\nversion = "0.7.0.dev0"\n')
    apart = run("versions", "--package-json", package_json, "--pyproject", core, "--pyproject", layer)
    assert apart.returncode == 1
    assert f"{layer} says 0.7.0.dev0" in apart.stderr and str(core) not in apart.stderr
    assert a7.versions_violations(package_json, []) == ["no pyproject.toml to compare the app's version with"]


def bumped(directory, reverted=None):
    """The app's version lines bumped to 0.7.0, the one `reverted` names left at the development version."""
    def version(line, development):
        return development if line == reverted else "0.7.0"

    directory.mkdir(parents=True)
    package_json = directory / "package.json"
    package_json.write_text(json.dumps({"name": "delphi-macos", "version": "0.7.0"}))
    lock = directory / "package-lock.json"
    lock.write_text(json.dumps({"name": "delphi-macos", "version": version("lock-version", "0.7.0-dev.0"),
                                "lockfileVersion": 3, "requires": True,
                                "packages": {"": {"name": "delphi-macos",
                                                  "version": version("lock-root-package", "0.7.0-dev.0")}}}))
    core, kit, layer = directory / "core.toml", directory / "kit.toml", directory / "layer.toml"
    core.write_text('[project]\nname = "delphi-core"\nversion = "0.7.0"\n')
    kit.write_text('[project]\nname = "delphi-core-testkit"\nversion = "0.7.0"\n'
                   f'dependencies = ["delphi-core=={version("kit-pin", "0.7.0.dev0")}", "pytest>=8.4,<9"]\n')
    layer.write_text('[project]\nname = "delphi-desktop"\nversion = "0.7.0"\n'
                     f'dependencies = ["delphi-core=={version("layer-pin", "0.7.0.dev0")}"]\n')
    return ["--package-json", package_json, "--package-lock", lock,
            "--pyproject", core, "--pyproject", kit, "--pyproject", layer]


@pytest.mark.parametrize("reverted, refusal", [
    ("kit-pin", "kit.toml requires 'delphi-core==0.7.0.dev0', not delphi-core==0.7.0"),
    ("layer-pin", "layer.toml requires 'delphi-core==0.7.0.dev0', not delphi-core==0.7.0"),
    ("lock-version", "package-lock.json's version says 0.7.0-dev.0, package.json says 0.7.0"),
    ("lock-root-package", "package-lock.json's packages[\"\"].version says 0.7.0-dev.0, package.json says 0.7.0"),
], ids=["kit-pin", "layer-pin", "lock-version", "lock-root-package"])
def test_a7_a_bump_left_undone_on_one_pin_or_lockfile_line_is_refused(tmp_path, reverted, refusal):
    """The release bump's eight lines: the four versions are compared already, and these four lines with them."""
    done = run("versions", *bumped(tmp_path / "done"))
    assert done.returncode == 0, done.stderr
    left = run("versions", *bumped(tmp_path / reverted, reverted))
    assert left.returncode == 1 and refusal in left.stderr and "versions: 1 problems." in left.stdout


@pytest.mark.parametrize("requirement, refused", [
    ("delphi-core==0.7.0", False), ("delphi_core == 0.7.0", False), ("Delphi.Core[cloud]==0.7.0 ; python_version >= '3.11'", False),
    ("delphi-core>=0.7.0", True), ("delphi-core", True), ("delphi-core==0.7.0,<1", True), ("delphi-corex==0.6.9", False),
], ids=["exact", "underscore-spaced", "extras-and-marker", "range", "unpinned", "pin-and-range", "another-name"])
def test_a7_a_requirement_on_core_is_an_exact_pin_in_any_spelling(tmp_path, requirement, refused):
    project = {"name": "delphi-desktop", "version": "0.7.0", "dependencies": [requirement]}
    found = a7.pin_violations(tmp_path / "layer.toml", project, a7.parse_semver("0.7.0"))
    assert bool(found) == refused, found


WHEEL_NAME = "w3a_pinned"


def build_wheel(folder, body="VALUE = 1\n"):
    """A minimal pure-Python wheel, as a build backend would write it."""
    import base64
    import hashlib
    import zipfile

    info = f"{WHEEL_NAME}-0.7.0.dist-info"
    files = {
        f"{WHEEL_NAME}/__init__.py": body.encode(),
        f"{WHEEL_NAME}/rules.py": b"def score():\n    return 1\n",
        f"{info}/METADATA": f"Metadata-Version: 2.1\nName: {WHEEL_NAME}\nVersion: 0.7.0\n".encode(),
        f"{info}/WHEEL": b"Wheel-Version: 1.0\nGenerator: test\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
    }

    def digest(data):
        return "sha256=" + base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()

    record = "".join(f"{path},{digest(data)},{len(data)}\n" for path, data in files.items()) + f"{info}/RECORD,,\n"
    wheel = Path(folder) / f"{WHEEL_NAME}-0.7.0-py3-none-any.whl"
    wheel.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(wheel, "w") as archive:
        for path, data in files.items():
            archive.writestr(path, data)
        archive.writestr(f"{info}/RECORD", record)
    return wheel, hashlib.sha256(wheel.read_bytes()).hexdigest()


@pytest.fixture(scope="module")
def installed(tmp_path_factory):
    """The wheel installed by pip into a folder of its own: (site folder, wheel, its SHA-256)."""
    folder = tmp_path_factory.mktemp("pinned")
    wheel, sha256 = build_wheel(folder / "dist")
    result = subprocess.run([sys.executable, "-m", "pip", "install", "--quiet", "--no-index", "--no-deps",
                             "--no-compile", "--disable-pip-version-check", "--target", str(folder / "site"),
                             str(wheel)], capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        pytest.skip(f"pip cannot install a local wheel here: {result.stderr.strip()}")
    return folder / "site", wheel, sha256


@pytest.fixture
def site(installed, tmp_path):
    """A copy of the installed folder this test may damage."""
    folder, wheel, sha256 = installed
    copied = tmp_path / "site"
    shutil.copytree(folder, copied)
    return copied, wheel, sha256


def test_a7_the_pinned_wheel_installed_passes(site):
    folder, wheel, sha256 = site
    assert a7.installed_wheel_violations(WHEEL_NAME, sha256, version="0.7.0", path=[str(folder)]) == []
    assert a7.installed_wheel_violations(WHEEL_NAME, sha256.upper(), wheel=wheel, path=[str(folder)]) == []


def test_a7_another_wheel_or_version_fails(site, tmp_path):
    folder, wheel, sha256 = site
    found = a7.installed_wheel_violations(WHEEL_NAME, "0" * 64, path=[str(folder)])
    assert found == [f"{WHEEL_NAME} was installed from a wheel with SHA-256 {sha256}, the pin says {'0' * 64}"]
    found = a7.installed_wheel_violations(WHEEL_NAME, sha256, version="0.7.1", path=[str(folder)])
    assert found == [f"{WHEEL_NAME} 0.7.0 is installed, the pin says 0.7.1"]
    other, other_sha256 = build_wheel(tmp_path / "other", body="VALUE = 2\n")
    found = a7.installed_wheel_violations(WHEEL_NAME, other_sha256, wheel=other, path=[str(folder)])
    assert found == [f"{WHEEL_NAME}: {WHEEL_NAME}/__init__.py differs from the wheel"]
    found = a7.installed_wheel_violations(WHEEL_NAME, sha256, wheel=other, path=[str(folder)])
    assert found == [f"{other.name} has SHA-256 {other_sha256}, the pin says {sha256}"]


def test_a7_an_installed_file_changed_or_removed_fails(site):
    folder, wheel, sha256 = site
    (folder / WHEEL_NAME / "__init__.py").write_text("VALUE = 'patched'\n")
    (folder / WHEEL_NAME / "rules.py").unlink()
    for found in (a7.installed_wheel_violations(WHEEL_NAME, sha256, path=[str(folder)]),
                  a7.installed_wheel_violations(WHEEL_NAME, sha256, wheel=wheel, path=[str(folder)])):
        assert found == [f"{WHEEL_NAME}: {WHEEL_NAME}/__init__.py differs from the wheel",
                         f"{WHEEL_NAME}: {WHEEL_NAME}/rules.py is missing"]


def test_a7_an_editable_install_is_refused(site):
    folder, _, sha256 = site
    info = next(folder.glob("*.dist-info"))
    (info / "direct_url.json").write_text(json.dumps({"url": "file:///checkout/core", "dir_info": {"editable": True}}))
    found = a7.installed_wheel_violations(WHEEL_NAME, sha256, path=[str(folder)])
    assert found == [f"{WHEEL_NAME} is an editable install (file:///checkout/core); "
                     "the pinned wheel is required, never the development override"]
    (info / "direct_url.json").unlink()
    # An install with no direct_url.json, as older installers leave one; the finder it
    # puts on the path still says what it is (importlib lists only files that exist).
    (folder / f"__editable__.{WHEEL_NAME}-0.7.0.pth").write_text("/checkout/core\n")
    with (info / "RECORD").open("a") as record:
        record.write(f"__editable__.{WHEEL_NAME}-0.7.0.pth,,\n")
    found = a7.installed_wheel_violations(WHEEL_NAME, sha256, path=[str(folder)])
    assert found and "is an editable install" in found[0]


def test_a7_a_directory_install_or_none_at_all_is_refused(site, tmp_path):
    folder, _, sha256 = site
    info = next(folder.glob("*.dist-info"))
    (info / "direct_url.json").write_text(json.dumps({"url": "file:///checkout/core", "dir_info": {}}))
    assert a7.installed_wheel_violations(WHEEL_NAME, sha256, path=[str(folder)]) == [
        f"{WHEEL_NAME} was installed from file:///checkout/core, not from the pinned wheel"]
    (info / "direct_url.json").unlink()
    assert a7.installed_wheel_violations(WHEEL_NAME, sha256, path=[str(folder)]) == [
        f"{WHEEL_NAME}'s install records no wheel hash; pass the wheel to compare with"]
    (tmp_path / "empty").mkdir()
    assert a7.installed_wheel_violations(WHEEL_NAME, sha256, path=[str(tmp_path / "empty")]) == [
        f"{WHEEL_NAME} is not installed"]


def test_a7_wheel_command_exits_on_the_verdict(site):
    folder, wheel, sha256 = site
    good = run("wheel", "--distribution", WHEEL_NAME, "--sha256", sha256, "--path", folder)
    assert good.returncode == 0, good.stderr
    bad = run("wheel", "--distribution", WHEEL_NAME, "--sha256", "f" * 64, "--path", folder)
    assert bad.returncode == 1 and f"the pin says {'f' * 64}" in bad.stderr


# ---------------------------------------------------------------- A8 · private names

# Made up for these tests; the real list is private and never committed.
NAMES = "# the private list\nacme-hidden-project\n\nsecret-bucket-7\ninvite-xyzzy\n"


def checkout(tmp_path, files, untracked=None, binary=None):
    tree = tmp_path / "tree"
    tree.mkdir(parents=True)
    subprocess.run(["git", "init", "-q", str(tree)], check=True, capture_output=True)
    write(tree, files)
    for name, data in (binary or {}).items():
        (tree / name).parent.mkdir(parents=True, exist_ok=True)
        (tree / name).write_bytes(data)
    subprocess.run(["git", "-C", str(tree), "add", "-A"], check=True, capture_output=True)
    write(tree, untracked or {})
    return tree


def scan(tmp_path, tree, names=NAMES, *extra):
    listed = tmp_path / "names.txt"
    listed.write_text(names)
    return run("private-names", "--names", listed, "--root", tree, *extra)


def test_a8_a_checkout_naming_nothing_private_passes(tmp_path):
    tree = checkout(tmp_path, {"README.md": "Delphi, a reading workspace.\n", "core/app.py": "BUCKET = ''\n"})
    result = scan(tmp_path, tree)
    assert result.returncode == 0, result.stderr
    assert "3 names" in result.stdout and "0 found" in result.stdout


def test_a8_a_planted_name_fails_and_is_named_by_its_entry_only(tmp_path):
    tree = checkout(tmp_path, {"core/app.py": "import os\nBUCKET = 'Secret-Bucket-7'\n"})
    result = scan(tmp_path, tree)
    assert result.returncode == 1
    assert "private name: core/app.py:2: entry on line 4 of names.txt" in result.stderr
    assert "secret-bucket-7" not in (result.stderr + result.stdout).lower(), "the output names no private name"
    shown = scan(tmp_path, tree, NAMES, "--show-names")
    assert "core/app.py:2: entry on line 4 of names.txt: secret-bucket-7" in shown.stderr


def test_a8_paths_and_binary_files_are_read(tmp_path):
    tree = checkout(tmp_path, {"deploy/acme-hidden-project.yaml": "region: eu\n"},
                    binary={"assets/logo.png": b"\x89PNG\r\n\x00\x00INVITE-XYZZY\x00"})
    result = scan(tmp_path, tree)
    assert result.returncode == 1
    assert "private name: in a path: entry on line 2" in result.stderr
    assert "acme-hidden-project" not in result.stderr + result.stdout, "the path spells the name"
    assert "private name: assets/logo.png:2: entry on line 5" in result.stderr
    shown = scan(tmp_path, tree, NAMES, "--show-names")
    assert "private name: deploy/acme-hidden-project.yaml (its path): entry on line 2" in shown.stderr


def test_a8_untracked_files_are_not_read(tmp_path):
    tree = checkout(tmp_path, {"README.md": "Delphi\n"}, untracked={"notes.txt": "acme-hidden-project\n"})
    assert scan(tmp_path, tree).returncode == 0


@pytest.mark.parametrize("names, message", [
    ("# nothing but a comment\n\n", "holds no names, so the scan would check nothing"),
    ("acme-hidden-project\nab\n", "names.txt:2: a name shorter than 3 characters"),
])
def test_a8_an_empty_or_too_loose_list_fails(tmp_path, names, message):
    tree = checkout(tmp_path, {"README.md": "Delphi\n"})
    result = scan(tmp_path, tree, names)
    assert result.returncode == 1 and message in result.stderr


def test_a8_a_list_committed_to_the_checkout_fails(tmp_path):
    tree = checkout(tmp_path, {"README.md": "Delphi\n", "private/names.txt": "invite-xyzzy\n"})
    result = run("private-names", "--names", tree / "private" / "names.txt", "--root", tree)
    assert result.returncode == 1
    assert "names.txt is tracked by the checkout it scans; the list must never be committed" in result.stderr


def test_a8_outside_a_checkout_the_scan_refuses(tmp_path):
    (tmp_path / "plain").mkdir()
    listed = tmp_path / "names.txt"
    listed.write_text(NAMES)
    result = run("private-names", "--names", listed, "--root", tmp_path / "plain")
    assert result.returncode == 2 and "is not a git checkout" in result.stderr
