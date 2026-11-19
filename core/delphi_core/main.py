"""The reference app: core's API on the local stores.

    uvicorn delphi_core.main:app

A product builds its own with `delphi_core.app.create_app`, on its own stores;
this one is what core's tests and a self-hosted install run.
"""
from .app import create_app
from .config import load_settings
from .stores import Stores

app = create_app(load_settings(), stores=Stores.local())
