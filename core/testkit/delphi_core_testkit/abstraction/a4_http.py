"""A4 · HTTP superset: a product's API is core's, plus routes under the product's own prefix.

Plan 4 §2.4 rule 3: core owns the HTTP API. A product adds routes only under its
prefix (`/api/desktop/`, `/api/web/`), never removes, replaces or reshapes a core
route, and core declares nothing under either prefix. Compared through OpenAPI:

- every core path and operation is in the product's document, unchanged:
  parameters, request body, responses and the rest of the operation object;
- every component core declares (schemas, security schemes, ...) is in the
  product's document, unchanged, since a core operation's shape lives there;
- every path or operation the product adds lies under its prefix;
- the reference document declares no path under any product's prefix.

Only `paths`, `webhooks` and `components` are compared. `info` (whose version
follows the package's) and the other top-level keys describe the document, not
the API.

OpenAPI shows only what an app publishes. When both sides are apps, their route
tables are compared too, hidden routes (`include_in_schema=False`) and mounts
included: each route by kind, path, methods and endpoint, in order. Leaving out
the product's routes under its prefix, the product's table must be the
reference's, route for route: nothing added elsewhere, removed, replaced, put in
front of a core route to shadow it, or reordered. A route table names nothing
under a product's prefix in the reference either.

    python -m delphi_core_testkit.abstraction http --reference delphi_core.main:app --product delphi_desktop.main:app
    python -m delphi_core_testkit.abstraction http --reference core.json --product web.json --prefix /api/web/
    python -m delphi_core_testkit.abstraction http --reference delphi_core.main:app   # core alone

A document is a `.json` file or `module:attribute` naming a FastAPI app (its
`openapi()`), a callable returning one, or a dict. The prefix defaults to the
product package's own (from `module:attribute`); give it for a file.

Rule 3 also says the Node shell's `/desktop/*` endpoints are never forwarded to
Python. That is the shell's worker host (`desktop/main/worker-host.ts`), so it is a
shell test, `desktop/tests/worker-host.test.mts`: a `/desktop/*` request the host
does not serve itself never reaches the backend's origin.
"""
import argparse
import json
from pathlib import Path
import sys

from . import PRODUCTS, load_object

METHODS = ("get", "put", "post", "delete", "options", "head", "patch", "trace")


def normal_prefix(prefix):
    return prefix if prefix.endswith("/") else prefix + "/"


def under(path, prefix):
    prefix = normal_prefix(prefix)
    return path.startswith(prefix) or path == prefix.rstrip("/")


def operation_change(before, after):
    """What differs between two operation objects, in words."""
    keys = sorted(set(before) | set(after))
    parts = []
    for key in keys:
        if before.get(key) == after.get(key):
            continue
        if key == "responses" and isinstance(before.get(key), dict) and isinstance(after.get(key), dict):
            old, new = before[key], after[key]
            codes = [f"{code} removed" for code in sorted(old.keys() - new.keys())]
            codes += [f"{code} added" for code in sorted(new.keys() - old.keys())]
            codes += [f"{code} changed" for code in sorted(old.keys() & new.keys()) if old[code] != new[code]]
            parts.append(f"responses ({', '.join(codes)})")
        elif key not in after:
            parts.append(f"{key} removed")
        elif key not in before:
            parts.append(f"{key} added")
        else:
            parts.append(f"{key} changed")
    return "; ".join(parts)


def core_declares_product_routes(reference, prefixes=tuple(PRODUCTS.values())):
    """Each reference path that lies under a product's prefix."""
    found = []
    for section in ("paths", "webhooks"):
        for path in sorted(reference.get(section) or {}):
            for prefix in prefixes:
                if under(path, prefix):
                    found.append(f"core declares {path} under the product prefix {normal_prefix(prefix)}")
    return found


def superset_violations(reference, product, prefix, prefixes=tuple(PRODUCTS.values())):
    """Every way `product` is not `reference` plus routes under `prefix`, in words."""
    found = core_declares_product_routes(reference, prefixes)
    for section in ("paths", "webhooks"):
        ours, theirs = reference.get(section) or {}, product.get(section) or {}
        for path in sorted(ours):
            if path not in theirs:
                found.append(f"{path}: the core path is missing")
                continue
            for key in sorted(set(ours[path]) | set(theirs[path])):
                method = key.upper()
                if key not in theirs[path]:
                    found.append(f"{method} {path}: the core operation is missing" if key in METHODS
                                 else f"{path}: the path's {key} is missing")
                elif key not in ours[path]:
                    if key in METHODS:
                        found.append(f"{method} {path}: added to a core path, outside {normal_prefix(prefix)}")
                    else:
                        found.append(f"{path}: the path's {key} was added")
                elif ours[path][key] != theirs[path][key]:
                    if key in METHODS:
                        found.append(f"{method} {path}: the core operation is altered: "
                                     f"{operation_change(ours[path][key], theirs[path][key])}")
                    else:
                        found.append(f"{path}: the path's {key} is altered")
        for path in sorted(theirs.keys() - ours.keys()):
            if not under(path, prefix):
                methods = ", ".join(key.upper() for key in theirs[path] if key in METHODS) or "a path"
                found.append(f"{methods} {path}: added outside {normal_prefix(prefix)}")
    ours, theirs = reference.get("components") or {}, product.get("components") or {}
    for kind in sorted(ours):
        for name in sorted(ours[kind]):
            if name not in theirs.get(kind, {}):
                found.append(f"components.{kind}.{name}: the core component is missing")
            elif ours[kind][name] != theirs[kind][name]:
                found.append(f"components.{kind}.{name}: the core component is altered")
    return found


def flat_routes(routes):
    """Each route an app matches, in order, with included routers opened.

    FastAPI from 0.160 keeps an included router as one lazy entry whose
    `effective_route_contexts()` are its routes as included; earlier versions
    copy them into the app's list. A mount stays one entry: its own app is
    behind its path, not beside core's routes.
    """
    for route in routes:
        contexts = getattr(route, "effective_route_contexts", None)
        if callable(contexts):
            yield from contexts()
        else:
            yield route


def route_table(app):
    """(kind, path, methods, endpoint) for each route of an app, in the order it matches them."""
    rows = []
    # Matched after every other route, where the framework keeps such a list.
    late = getattr(getattr(app, "router", None), "_low_priority_routes", None) or []
    for route in flat_routes([*app.routes, *late]):
        target = getattr(route, "endpoint", None) or getattr(route, "app", None)
        named = (f"{getattr(target, '__module__', None) or type(target).__module__}."
                 f"{getattr(target, '__qualname__', None) or type(target).__qualname__}")
        place = getattr(route, "path", None) or getattr(route, "host", None) or ""
        methods = ",".join(sorted(getattr(route, "methods", None) or ()))
        kind = type(getattr(route, "original_route", None) or route).__name__
        rows.append((kind, place, methods, named))
    return rows


def shown(row):
    kind, place, methods, named = row
    return f"{kind} {methods + ' ' if methods else ''}{place} -> {named}"


def core_routes_under_products(reference, prefixes=tuple(PRODUCTS.values())):
    """Each route in the reference app's table, hidden ones included, under a product's prefix."""
    return [f"core's route table holds {shown(row)} under the product prefix {normal_prefix(each)}"
            for row in route_table(reference) for each in prefixes if under(row[1], each)]


def route_violations(reference, product, prefix, prefixes=tuple(PRODUCTS.values())):
    """Every way an app's route table is not the reference's plus routes under `prefix`, in words."""
    ours, theirs = route_table(reference), route_table(product)
    found = core_routes_under_products(reference, prefixes)
    rest = [row for row in theirs if not under(row[1], prefix)]
    if rest == ours:
        return found
    missing = [row for row in ours if row not in rest]
    added = [row for row in rest if row not in ours]
    found += [f"the core route {shown(row)} is missing or replaced" for row in missing]
    found += [f"the route {shown(row)} is added outside {normal_prefix(prefix)}"
              + (", ahead of a core route" if rest.index(row) < len(rest) - 1 else "") for row in added]
    if not missing and not added:
        at = next(index for index, (one, other) in enumerate(zip(ours, rest)) if one != other)
        found.append(f"core's routes are reordered: {shown(rest[at])} stands where {shown(ours[at])} does in core")
    return found


def load(spec, paths=()):
    """(OpenAPI document, the app or None) from a .json file or a `module:attribute`."""
    if spec.endswith(".json") or Path(spec).is_file():
        return json.loads(Path(spec).read_text()), None
    found = load_object(spec, paths)
    if isinstance(found, dict):
        return found, None
    if not hasattr(found, "openapi") and callable(found):
        found = found()
    if hasattr(found, "openapi"):
        return found.openapi(), (found if hasattr(found, "routes") else None)
    if isinstance(found, dict):
        return found, None
    raise TypeError(f"{spec} is not an app, a factory or a document")


def load_document(spec, paths=()):
    """An OpenAPI document from a .json file or a `module:attribute`."""
    return load(spec, paths)[0]


def main(argv=None):
    parser = argparse.ArgumentParser(prog="abstraction http", description=__doc__.split("\n")[0])
    parser.add_argument("--reference", required=True, help="the reference app or its OpenAPI document")
    parser.add_argument("--product", help="a product app or its OpenAPI document")
    parser.add_argument("--prefix", help="the product's own route prefix (default: its package's)")
    parser.add_argument("--product-prefixes", default=",".join(PRODUCTS.values()),
                        help="every product's prefix, which core may not use (default %(default)s)")
    parser.add_argument("--path", action="append", default=[], help="a directory to put first on sys.path")
    args = parser.parse_args(argv)

    prefixes = tuple(filter(None, args.product_prefixes.split(",")))
    prefix = args.prefix
    if args.product and not prefix:
        package = args.product.partition(":")[0].split(".")[0]
        prefix = PRODUCTS.get(package)
        if not prefix:
            print(f"http superset: no prefix known for {args.product}; pass --prefix", file=sys.stderr)
            return 2
    reference, reference_app = load(args.reference, args.path)
    if args.product:
        product, product_app = load(args.product, args.path)
        found = superset_violations(reference, product, prefix, prefixes)
        if reference_app is not None and product_app is not None:
            found += route_violations(reference_app, product_app, prefix, prefixes)
        else:
            print("http superset: a document is not an app, so the route tables (hidden routes) are not compared.",
                  file=sys.stderr)
    else:
        found = core_declares_product_routes(reference, prefixes)
        if reference_app is not None:
            found += core_routes_under_products(reference_app, prefixes)
    for line in found:
        print(f"not a superset: {line}", file=sys.stderr)
    checked = f"{args.product} against {args.reference}" if args.product else args.reference
    print(f"http superset: {checked}; {len(found)} problems.")
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main())
