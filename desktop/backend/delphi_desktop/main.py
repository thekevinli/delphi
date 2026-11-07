"""The app the desktop shell runs.

    uvicorn delphi_desktop.main:app

Core's API on the local stores, whatever the environment says: a desktop has
one library on disk and no database.
"""
from delphi_core.app import Stores, create_app
from delphi_core.settings import load_settings

from .settings import DesktopSettings

app = create_app(load_settings(DesktopSettings), stores=Stores.local())
