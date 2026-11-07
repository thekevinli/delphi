"""Plan 4's layering checks (§3.2): the split between core and its products, tested.

One module per check, each a function over its inputs and a `main(argv)`:

    a1_imports        A1  import direction: core never reaches up; products reach
                          core only through its public surface
    a3_surface        A3  the public surface rendered as text, compared with a
                          snapshot, each change classified additive or breaking
    a4_http           A4  a product's OpenAPI is the reference app's plus routes
                          under the product's own prefix
    a6_settings       A6  a product's Settings subclass keeps every core key's
                          annotation and default
    a7_same_code      A7  one version for app, core and its layers; an installed
                          core is the pinned wheel, never an editable checkout
    a8_private_names  A8  no tracked file names anything on a private list

    python -m delphi_core_testkit.abstraction <check> [options]
        # imports, surface, http, settings, versions, wheel, private-names; --help on each

They ship in the kit, so both repositories run the checks of the core they pin.
Every input is an argument: a path is read from where the command runs, never
from where the kit is installed. A2 (core alone in a clean environment) is
this repository's `scripts/core_alone.sh`, A5 the kit's `conformance.require_conformance`,
and A9 `scripts/check_vocabulary.py`; none of the three is here.
"""
from importlib import import_module
import sys

#: The core's import package (D4).
CORE = "delphi_core"
#: Each product's import package and the one HTTP prefix it may add routes under
#: (rule 3; decided in §7 Q7).
PRODUCTS = {"delphi_desktop": "/api/desktop/", "delphi_web": "/api/web/"}
#: The test kit: its own distribution, never installed where a product runs (D4).
TESTKIT = "delphi_core_testkit"
#: The modules a product may import, relative to CORE (§2.3).
SURFACE = ("app", "settings", "storage", "storage.rules", "backfill")


def within(name, prefix):
    """Whether dotted `name` is `prefix` or lies under it: `a.b` is within `a`, `ab` is not."""
    return name == prefix or name.startswith(prefix + ".")


def load_object(spec, paths=()):
    """`package.module:attribute.path` imported and looked up; `paths` go first on sys.path."""
    module_name, colon, attribute = spec.partition(":")
    if not colon or not module_name or not attribute:
        raise ValueError(f"expected module:attribute, got {spec!r}")
    for path in reversed(paths):
        if str(path) not in sys.path:
            sys.path.insert(0, str(path))
    found = import_module(module_name)
    for part in attribute.split("."):
        found = getattr(found, part)
    return found
