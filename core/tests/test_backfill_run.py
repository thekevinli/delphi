"""
`backfill.run`: a product's stores, bound for one bulk command and released after it.

A command decides nothing about stores; it asks `open_stores`, which answers
with what `run` bound or, run as `python -m`, with the reference app's. The
binding must not outlive the command, however it ends, or the next command in
the same process would rewrite the wrong library.
"""
import json
import sys

import pytest

import delphi_core.backfill as backfill
from delphi_core.config import Settings
from delphi_core.storage import LocalStorage, local_format
from delphi_core.stores import Stores


def unbound():
    raise AssertionError("opened the default stores")


def recording(opened):
    local = Stores.local()

    def storage(settings):
        opened.append(("storage", settings))
        return local.storage(settings)

    def objects(settings):
        opened.append(("objects", settings))
        return local.objects(settings)

    return Stores(storage, objects, is_local=True)


def test_run_binds_a_products_stores_for_one_command_and_restores_the_default_after(tmp_path, monkeypatch, capsys):
    settings = Settings(_env_file=None, data_dir=tmp_path)
    LocalStorage(settings).create_account("reader", None, "salt", "hash")
    monkeypatch.setattr(backfill, "default_stores", unbound)
    # The flags are the ones `run` was given, never the process's own.
    monkeypatch.setattr(sys, "argv", ["delphi", "--no-such-flag"])
    opened = []

    assert backfill.run("index", settings, recording(opened), ["--quiet"]) == 0
    assert opened == [("storage", settings), ("objects", settings)]
    assert "storage local" in capsys.readouterr().out
    with pytest.raises(AssertionError, match="default stores"):
        backfill.open_stores()

    # A command that ends in a refusal releases its binding too.
    with pytest.raises(SystemExit):
        backfill.run("index", settings, recording(opened), ["--no-such-flag"])
    with pytest.raises(AssertionError, match="default stores"):
        backfill.open_stores()


@pytest.mark.parametrize("command", backfill.COMMANDS)
def test_each_command_runs_on_the_flags_it_is_given(tmp_path, monkeypatch, capsys, command):
    monkeypatch.setattr(backfill, "default_stores", unbound)
    with pytest.raises(SystemExit) as helped:
        backfill.run(command, Settings(_env_file=None, data_dir=tmp_path), Stores.local(), ["--help"])
    assert helped.value.code == 0
    assert "--quiet" in capsys.readouterr().out


def test_run_refuses_a_module_that_is_not_a_command(tmp_path):
    with pytest.raises(ValueError, match="not a backfill command"):
        backfill.run("chat_benchmark", Settings(_env_file=None, data_dir=tmp_path), Stores.local())


def test_a_bound_local_store_is_held_to_the_current_format_and_another_store_is_not(tmp_path, capsys):
    settings = Settings(_env_file=None, data_dir=tmp_path)
    LocalStorage(settings).create_account("reader", None, "salt", "hash")
    marker = local_format.marker_path(tmp_path / "users" / "reader")
    marker.write_text(json.dumps({"format": local_format.LOCAL_FORMAT + 1}))

    with pytest.raises(SystemExit, match="newer than this release"):
        backfill.run("index", settings, Stores.local(), ["--quiet"])

    class Elsewhere:
        kind = "elsewhere"

        def list_usernames(self):
            return []

    assert backfill.run("index", settings, Stores(lambda s: Elsewhere(), lambda s: None), ["--quiet"]) == 0
    assert "storage elsewhere" in capsys.readouterr().out
