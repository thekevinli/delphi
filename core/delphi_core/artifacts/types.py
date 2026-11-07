"""The renderer's bounded result, independent of the model harness."""

from dataclasses import dataclass, field
from typing import Any

#: The most authored source a draft may hold; chat's frame takes the same (`ARTIFACT_MAX_LENGTH`).
SOURCE_MAX = 128_000


@dataclass
class RenderReport:
    passed: bool
    diagnostics: list[dict[str, Any]] = field(default_factory=list)
    image: dict[str, Any] | None = None
    views: list[dict[str, Any]] = field(default_factory=list)
    interactions: list[dict[str, Any]] = field(default_factory=list)
    elapsed_ms: int = 0
    renderer_version: str = ""
    # Measured by a browser host, which owns the renderer's processes (`browser_host`).
    renderer_peak_bytes: int = 0
