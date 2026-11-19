"""The suite sees no provider key and no cloud keys, as core's does (`core/tests/conftest.py`).

`Settings` also reads `../.env`, which from here is `desktop/.env`; without this,
a test that names no key would run with a configured provider. Core ignores the
cloud keys such a file may also name, and emptying them keeps them out of any
child a test starts. Set before any test module imports an app, whose settings
are read once.
"""
import os

os.environ["OPENAI_API_KEY"] = ""
os.environ["DIGEST_RESEARCH_ENABLED"] = "false"
os.environ["DATABASE_URL"] = ""
os.environ["GCS_BUCKET"] = ""
