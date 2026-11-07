"""How an app opens its stores, chosen once by the product that creates it.

Core ships the local stores and nothing else. A product with stores of its own
(records in a database, bytes in a bucket) passes their factories to
`create_app` and to `backfill.run`; nothing in core decides between them.
"""
from collections.abc import Callable
from dataclasses import dataclass

from .config import Settings
from .storage import LocalObjectStore, LocalStorage, ObjectStore, Storage


def _local_objects(settings: Settings) -> ObjectStore:
    return LocalObjectStore(settings.data_dir, settings.chat_image_retention_days)


@dataclass(frozen=True)
class Stores:
    """How an app opens its stores: one factory per kind, each given the request's settings.

    A factory is called per request, with the settings that request resolved
    (`get_settings`, which a test may override), so a store that reads a setting
    reads the one the request sees.
    """

    storage: Callable[[Settings], Storage]
    objects: Callable[[Settings], ObjectStore]
    #: The local stores, which a bulk command opens only at the current format
    #: (`local_format.not_current`): a store behind it would be migrated under
    #: an app that may have the same profile open.
    is_local: bool = False

    @classmethod
    def local(cls) -> "Stores":
        """Records and bytes on the filesystem under `settings.data_dir`."""
        return cls(LocalStorage, _local_objects, is_local=True)
