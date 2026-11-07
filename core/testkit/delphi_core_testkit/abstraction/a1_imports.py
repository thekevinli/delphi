"""A1 · import direction: core never reaches up, and products reach core only through its surface.

Plan 4 §2.4 rules 4, 5 and 12, checked over every module's syntax tree; nothing is
imported or run. The rules, first match wins for each import:

- core imports no product package, no cloud SDK and not the test kit (rule 5);
- inside core, `harness/`, `memory_maintenance/` and `storage/` never import
  `routers/` (rule 12);
- a product imports not the test kit and not the other product;
- a product imports no provider SDK and nothing from core's `harness` or
  `memory_maintenance`, so no product can define a tool, a prompt or a Memory stage;
- a product imports from core only the public surface (§2.3), module by module:
  `delphi_core.storage` is on it and `delphi_core.storage.local` is not;
- and name by name: `from delphi_core.app import X` names something in
  `delphi_core.app.__all__`, read from core's source, so a module-level name a
  surface module happens to hold (`chat`, `CORE_ROUTERS`) is not on the surface.

    python -m delphi_core_testkit.abstraction imports --package core/delphi_core \
        --package desktop/backend/delphi_desktop --exceptions core/abstraction-exceptions.txt --require-empty

`--package` is a package directory, at least one; the module names come from its
folder name, or from `NAME=DIR`. Each must be core's or a declared product's, so a
product's other code is named under it (`delphi_web.alembic=backend/alembic`); any
other name is refused, since no rule would judge it. Give core's package whenever a
product is checked: its module list is how `from delphi_core.storage import local`
is told apart from `from delphi_core.storage import Storage`, and its source holds
each surface module's `__all__`.

Read as an import: `import a.b`, `from a import b` (as `a.b` when that is a
module, else `a`), relative imports, imports inside functions and under
`if TYPE_CHECKING:`, and `importlib.import_module` or `__import__` called with a
literal absolute name. A file that does not parse fails the check.

The exceptions file holds `importer : imported : reason` entries, one per line,
`#` starting a comment. The importer is a module name, `*` and `?` allowed; the
imported name excuses that module and everything under it. The reason is
required, and an entry that excuses nothing fails the check, so the file can only
shrink. At the target it is empty (`--require-empty` fails on any entry).
"""
import argparse
import ast
from dataclasses import dataclass, field
from fnmatch import fnmatchcase
from pathlib import Path
import re
import sys

from . import CORE, PRODUCTS, SURFACE, TESTKIT, within

SEPARATOR = " : "
DOTTED = re.compile(r"[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\Z")
IMPORTER = re.compile(r"[\w.*?\[\]!-]+\Z")


@dataclass(frozen=True)
class Layering:
    """Who may import what. Each name is a parameter; the defaults are the target's."""

    core: str = CORE
    products: tuple = tuple(PRODUCTS)
    testkit: str = TESTKIT
    #: Relative to core: what a product may import (§2.3).
    surface: tuple = SURFACE
    #: Relative to core: what no product imports, surface or not.
    product_forbidden: tuple = ("harness", "memory_maintenance")
    provider_sdks: tuple = ("openai", "anthropic")
    cloud_sdks: tuple = ("sqlalchemy", "psycopg", "psycopg2", "google.cloud", "alembic", "hypercorn")
    #: Relative to core: the layers that sit below the HTTP API.
    below_routers: tuple = ("harness", "memory_maintenance", "storage")
    routers: str = "routers"

    def of_core(self, relative):
        return f"{self.core}.{relative}"

    def surface_modules(self):
        return {self.of_core(relative) for relative in self.surface}

    def named_modules(self):
        """The modules a rule names, known to be modules even when no package read holds them.

        So `from google import cloud` is an import of `google.cloud`, while
        `from sqlalchemy import Integer` stays an import of `sqlalchemy`.
        """
        return {*self.products, self.testkit, *self.provider_sdks, *self.cloud_sdks,
                *self.surface_modules(),
                *(self.of_core(relative) for relative in (*self.product_forbidden, self.routers))}


@dataclass(frozen=True)
class Import:
    importer: str
    imported: str
    path: str
    line: int
    #: For `from module import name` where `name` is not a module: that name.
    name: str | None = None


@dataclass(frozen=True)
class Violation:
    rule: str
    why: str
    found: Import

    def __str__(self):
        found = self.found
        imported = f"{found.imported}.{found.name}" if found.name else found.imported
        return f"{found.path}:{found.line}: {found.importer} imports {imported}: {self.why}"


@dataclass
class Excuse:
    importer: str
    imported: str
    reason: str
    text: str
    used: bool = field(default=False)

    def excuses(self, violation):
        return (fnmatchcase(violation.found.importer, self.importer)
                and within(violation.found.imported, self.imported))


def package_modules(directory, name=None):
    """{module name: (file, is a package, the package directory)} for every .py file under one package directory."""
    directory = Path(directory)
    name = name or directory.name
    modules = {}
    for path in sorted(directory.rglob("*.py")):
        parts = path.relative_to(directory).with_suffix("").parts
        if any(part.startswith(".") or part == "__pycache__" for part in parts):
            continue
        is_package = parts[-1] == "__init__"
        modules[".".join((name, *(parts[:-1] if is_package else parts)))] = (path, is_package, directory)
    return modules


def dynamic_import(node):
    """The literal absolute name an `importlib.import_module(...)` or `__import__(...)` call names."""
    function = node.func
    named = (function.attr if isinstance(function, ast.Attribute) else
             function.id if isinstance(function, ast.Name) else None)
    if named not in ("import_module", "__import__") or not node.args:
        return None
    first = node.args[0]
    if isinstance(first, ast.Constant) and isinstance(first.value, str) and DOTTED.match(first.value):
        return first.value
    return None


def imports_in(module, path, is_package, is_module):
    """
    (imported module, line, name or None) for each import in one file; the name is
    what `from module import name` takes when it is not a module itself. Raises
    SyntaxError or ValueError.
    """
    tree = ast.parse(Path(path).read_bytes(), filename=str(path))
    package = module if is_package else module.rpartition(".")[0]
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                yield alias.name, node.lineno, None
        elif isinstance(node, ast.ImportFrom):
            base = node.module or ""
            if node.level:
                parts = package.split(".") if package else []
                if node.level - 1 >= len(parts):
                    raise ValueError(f"line {node.lineno}: a relative import climbs above the top-level package")
                base = ".".join(parts[:len(parts) - (node.level - 1)] + ([node.module] if node.module else []))
            for alias in node.names:
                candidate = f"{base}.{alias.name}"
                if alias.name != "*" and is_module(candidate):
                    yield candidate, node.lineno, None
                else:
                    yield base, node.lineno, None if alias.name == "*" else alias.name
        elif isinstance(node, ast.Call):
            named = dynamic_import(node)
            if named:
                yield named, node.lineno, None


def modules_of(packages):
    """{module name: (file, is a package, its package's directory)} over a sequence of (directory, name or None)."""
    modules = {}
    for directory, name in packages:
        modules.update(package_modules(directory, name))
    return modules


def declared_exports(path):
    """The names a module's literal `__all__` lists, read from its source; None when it has none."""
    names = None
    for node in ast.parse(Path(path).read_bytes(), filename=str(path)).body:
        targets = (node.targets if isinstance(node, ast.Assign) else
                   [node.target] if isinstance(node, (ast.AugAssign, ast.AnnAssign)) else [])
        if not any(isinstance(target, ast.Name) and target.id == "__all__" for target in targets):
            continue
        try:
            value = ast.literal_eval(node.value)
        except (ValueError, TypeError, SyntaxError):
            return None  # computed: not something a static check can trust
        if isinstance(node, ast.AugAssign) and names is not None:
            names |= set(value)
        else:
            names = set(value)
    return names


def judge(importer, imported, layering, name=None, exports=None):
    """(rule, why) when this import is forbidden, else None. `exports` maps a surface module to its `__all__`."""
    core = layering.core
    top = importer.split(".")[0]
    if top == core:
        for product in layering.products:
            if within(imported, product):
                return "core-imports-product", "core never imports a product layer (rule 5)"
        for sdk in layering.cloud_sdks:
            if within(imported, sdk):
                return "core-imports-cloud-sdk", f"core never imports a cloud SDK; {sdk} belongs to a product (rule 5)"
        if within(imported, layering.testkit):
            return "imports-testkit", "the test kit is never installed where core runs (D4)"
        routers = layering.of_core(layering.routers)
        for layer in layering.below_routers:
            if within(importer, layering.of_core(layer)) and within(imported, routers):
                return ("core-layer-imports-routers",
                        f"{layering.of_core(layer)} sits below the HTTP API and never imports {routers} (rule 12)")
        return None
    if top not in layering.products:
        return None
    if within(imported, layering.testkit):
        return "imports-testkit", "the test kit is never installed where a product runs (D4)"
    for other in layering.products:
        if other != top and within(imported, other):
            return "product-imports-product", "a product never imports another product"
    for sdk in layering.provider_sdks:
        if within(imported, sdk):
            return "product-imports-provider-sdk", "a product never calls a model provider; core's harness does (rule 1)"
    for relative in layering.product_forbidden:
        if within(imported, layering.of_core(relative)):
            return ("product-imports-harness-or-memory",
                    f"a product never imports {layering.of_core(relative)}: tools, prompts and Memory stages are core's (rule 1)")
    if within(imported, core) and imported not in layering.surface_modules():
        surface = ", ".join(sorted(layering.surface_modules()))
        return "product-imports-internal", f"not on core's public surface ({surface}; rule 4)"
    if name is not None and imported in layering.surface_modules():
        listed = (exports or {}).get(imported)
        if listed is None:
            return ("product-imports-unexported-name",
                    f"{imported} has no literal __all__ in the core package given, so {name} cannot be shown "
                    "to be on the surface; give core's package (rule 4)")
        if name not in listed:
            return "product-imports-unexported-name", f"{name} is not in {imported}.__all__ (rule 4)"
    return None


def check(packages, layering=Layering()):
    """(violations, unreadable files) over the given packages: a sequence of (directory, name or None)."""
    modules = modules_of(packages)
    known = set(modules) | layering.named_modules()

    def is_module(name):
        return name in known

    violations, unreadable = [], []
    exports = {}
    surface = layering.surface_modules()
    for listed in surface & set(modules):
        try:
            exports[listed] = declared_exports(modules[listed][0])
        except (SyntaxError, ValueError, UnicodeDecodeError):
            exports[listed] = None  # reported below as unreadable, with its file
    for module, (path, is_package, directory) in sorted(modules.items()):
        # From the package's own folder name, whatever name it is judged under.
        shown = path.relative_to(directory.parent).as_posix()
        try:
            # A name taken from a module matters only where the surface is judged name by name.
            found = sorted({(imported, line, name if imported in surface else None)
                            for imported, line, name in imports_in(module, path, is_package, is_module)},
                           key=lambda found: (found[1], found[0], found[2] or ""))
        except (SyntaxError, ValueError, UnicodeDecodeError) as error:
            unreadable.append(f"{shown}: {error}")
            continue
        for imported, line, name in found:
            verdict = judge(module, imported, layering, name, exports)
            if verdict:
                violations.append(Violation(*verdict, Import(module, imported, shown, line, name)))
    return violations, unreadable


def read_exceptions(text, name):
    excuses, problems = [], []
    for number, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        importer, first, rest = line.partition(SEPARATOR)
        imported, second, reason = rest.partition(SEPARATOR)
        importer, imported, reason = importer.strip(), imported.strip(), reason.strip()
        if not (first and second and importer and imported and reason):
            problems.append(f"{name}:{number}: not `importer : imported : reason`: {line}")
        elif not IMPORTER.match(importer) or not DOTTED.match(imported):
            problems.append(f"{name}:{number}: not module names: {line}")
        else:
            excuses.append(Excuse(importer, imported, reason, f"{importer} : {imported}"))
    return excuses, problems


def parse_package(text):
    name, equals, directory = text.partition("=")
    return (Path(directory), name) if equals else (Path(text), None)


def main(argv=None):
    parser = argparse.ArgumentParser(prog="abstraction imports", description=__doc__.split("\n")[0])
    parser.add_argument("--package", action="append", default=[], metavar="[NAME=]DIR",
                        help="a package directory to read; repeat for each")
    parser.add_argument("--core", default=CORE, help=f"core's import package (default {CORE})")
    parser.add_argument("--products", default=",".join(PRODUCTS),
                        help="the product packages, comma-separated (default %(default)s)")
    parser.add_argument("--exceptions", type=Path, help="the exceptions file (none when not given)")
    parser.add_argument("--require-empty", action="store_true", help="fail on any exception entry")
    parser.add_argument("--report", action="store_true", help="list what fails, and exit 0")
    args = parser.parse_args(argv)

    packages = [parse_package(text) for text in args.package]
    if not packages:
        print("import direction: no package to read; pass --package", file=sys.stderr)
        return 2
    missing = [str(directory) for directory, _ in packages if not directory.is_dir()]
    if missing:
        print(f"import direction: not a directory: {', '.join(missing)}", file=sys.stderr)
        return 2
    layering = Layering(core=args.core, products=tuple(filter(None, args.products.split(","))))
    judged = (layering.core, *layering.products)
    stray = [f"{name or directory.name} ({directory})" for directory, name in packages
             if (name or directory.name).split(".")[0] not in judged]
    if stray:
        print(f"import direction: no rule judges {', '.join(stray)}: a package must be core's or a declared "
              f"product's ({', '.join(judged)}); name a product's other code under it, as "
              f"`delphi_web.alembic=backend/alembic`", file=sys.stderr)
        return 2

    excuses, problems = ([], [])
    if args.exceptions is not None and args.exceptions.is_file():
        excuses, problems = read_exceptions(args.exceptions.read_text(), args.exceptions.name)
    elif args.exceptions is not None:
        problems.append(f"no exceptions file at {args.exceptions}")
    if args.require_empty:
        problems += [f"the exceptions file must be empty: {excuse.text}" for excuse in excuses]

    violations, unreadable = check(packages, layering)
    failing = []
    for violation in violations:
        excusing = [excuse for excuse in excuses if excuse.excuses(violation)]
        for excuse in excusing:
            excuse.used = True
        if not excusing:
            failing.append(violation)
    stale = [f"excuses nothing; remove it: {excuse.text}" for excuse in excuses if not excuse.used]

    for violation in failing:
        print(f"forbidden ({violation.rule}): {violation}", file=sys.stderr)
    for line in unreadable:
        print(f"unreadable: {line}", file=sys.stderr)
    for line in problems + stale:
        print(f"FAIL: {line}", file=sys.stderr)
    modules = len(modules_of(packages))
    print(f"import direction: {modules} modules in {len(packages)} packages; {len(failing)} forbidden imports, "
          f"{len(violations) - len(failing)} excused, {len(stale)} stale exceptions, {len(unreadable)} unreadable.")
    if args.report:
        return 0
    return 1 if failing or unreadable or problems or stale else 0


if __name__ == "__main__":
    sys.exit(main())
