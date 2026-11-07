"""Core's settings, as a product reads and extends them.

A product subclasses `Settings` to add keys of its own and never restates a core
key: the same name keeps the same type, default and environment name. It reads
them once with `load_settings(ItsSettings)`, and its routes depend on
`get_settings`, which answers with the settings the app was created with.
"""
from .config import Settings, get_settings, load_settings

__all__ = ["Settings", "load_settings", "get_settings"]
