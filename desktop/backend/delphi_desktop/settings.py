"""The desktop's settings: core's, every one, as the shell sets them.

The shell passes each value in the environment (`backendEnv` in
`desktop/main/backend.ts`), so this class adds no key and changes no default.
A key the desktop needed would be added here under a name core does not use;
a core key is never restated.
"""
from delphi_core.settings import Settings


class DesktopSettings(Settings):
    """Core's settings, read from the environment the shell gives the backend."""
