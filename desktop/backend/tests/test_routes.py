"""
Every route the desktop names is one the app it launches serves.

The desktop names routes in its main process, its build and live-check scripts,
the fixtures that drive a real backend, and its interface. Most of those calls
run in no test, and no static check reads a path inside a string: a route
renamed on the server and missed here fails only when that caller next runs, as
a 404. So each literal is read out of its source and matched against
`delphi_desktop.main:app`'s own OpenAPI, where a `{param}` segment matches
anything. Core holds the same check over its own commands
(`core/tests/test_script_routes.py`).
"""

from pathlib import Path
import re

from delphi_desktop.main import app

#: desktop/, which the patterns below are relative to.
DESKTOP = Path(__file__).resolve().parents[2]
#: Where the desktop names a route.
SOURCES = (
    "main/**/*.ts",
    "build/*.mjs",
    "tests/fixtures/**/*.mts",
    "frontend/app/**/*.ts",
    "frontend/app/**/*.tsx",
)
#: A route in a JavaScript string: after its opening quote, or after an
#: interpolated origin (`${apiUrl}/api/...`), up to the first character that
#: is neither a path's nor an interpolation's. An interpolation is a segment.
JS_ROUTE = re.compile(r"""(?:["'`]|\})(/api/(?:\$\{[^}`]*\}|[\w\-.~/])*)""")
JS_INTERPOLATION = re.compile(r"\$\{[^}`]*\}")
DRAIN = "/api/memory/maintenance/drain"


def javascript_routes(path: Path):
    text = path.read_text(encoding="utf-8")
    for found in JS_ROUTE.finditer(text):
        yield text.count("\n", 0, found.start()) + 1, JS_INTERPOLATION.sub("{}", found[1])


def served(route: str, paths: list[str]) -> bool:
    """
    Whether a route names a path the app serves. A `{}` segment is a value the
    caller fills in; a trailing slash means the caller appends the rest.
    """
    route = route.split("?", 1)[0]
    prefix = route.endswith("/")
    wanted = route.strip("/").split("/")
    for path in paths:
        held = path.strip("/").split("/")
        if len(held) < len(wanted) if prefix else len(held) != len(wanted):
            continue
        if all(want == "{}" or have.startswith("{") or want == have for want, have in zip(wanted, held)):
            return True
    return False


def named_routes() -> list[tuple[str, str]]:
    named = []
    for pattern in SOURCES:
        files = sorted(DESKTOP.glob(pattern))
        assert files, f"{pattern} matches no file: the check would read nothing there"
        named += [(f"{path.relative_to(DESKTOP)}:{line}", route) for path in files for line, route in javascript_routes(path)]
    return named


def test_every_route_the_desktop_names_is_served():
    paths = list(app.openapi()["paths"])
    assert served("/api/projects/{}/papers", paths) and served("/api/projects/{}/papers/", paths)
    assert not served("/api/no-such-route", paths)

    named = named_routes()
    # The drain is the route the desktop's inference service waits on, a call
    # that runs in no test; the reader must find it where it is.
    assert any(where.startswith("main/inference/service.ts:") and route == DRAIN for where, route in named)
    unserved = [f"{where} {route}" for where, route in named if not served(route, paths)]
    assert not unserved, "Routes named in desktop source that the app does not serve:\n" + "\n".join(unserved)
