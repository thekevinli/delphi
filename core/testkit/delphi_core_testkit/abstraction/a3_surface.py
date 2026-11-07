"""A3 · public surface: what a product may import from core, rendered as text and compared.

Plan 4 §2.3 names the modules a product imports; this renders each one's exported
names and signatures, one line per name, into the text `core/public-surface.txt`
commits. The gate fails when the rendering and the file differ; the release check
classifies each change as additive or breaking.

    python -m delphi_core_testkit.abstraction surface render [--output FILE]     # write the snapshot
    python -m delphi_core_testkit.abstraction surface check [--snapshot FILE]    # gate: differ -> 1
    python -m delphi_core_testkit.abstraction surface diff OLD NEW [--breaking-allowed]   # release

`render` and `check` import the modules, so core must be importable (`--path DIR`
puts a directory first on sys.path); `--core` and `--module` name what to render,
defaulting to the target's. A module's exports are its `__all__`; without one, every
public name holding a value or defined in core, but no module and no class or
function imported from outside core. Define `__all__` on every surface module.

One line per name, `module:qualname kind: detail`, sorted. A class line lists its
bases and is followed by its members: methods, properties, annotated fields and
attributes, from every core class in its MRO. Of its bases, a class line names
only those a surface module exports and those from outside core: an internal base,
such as a mixin, is replaced by its own bases in turn, so renaming or reshaping it
changes no line while every member a product reaches through it is still rendered.
An annotation that names an exported class, or a dependency naming an exported
function, is written with the exported name, so moving one inside core changes no
line; a FastAPI dependency is written by what it declares, not by FastAPI's repr.
A constant on the surface (`COMMANDS`, a rule's job kinds) is written with its
value when that is simple (strings, numbers, paths, and tuples, frozensets, lists
and dicts of them), and a settings field with its default, so a removed command or
a changed default is a change to the surface. A tuple or frozenset that only gains
members is additive; any other changed value is breaking.

What counts as breaking (`diff`), conservatively: a name removed; a parameter
removed, renamed, reordered or retyped; a default changed; a new parameter without
a default; a return annotation changed; a new abstract member on an existing class
(every implementation must add it); a new required field; a field made required;
any other changed line. Additive: a new name; a new parameter with a default, after
the existing positional ones or keyword-only; a default gained; an abstract
member made concrete; a field made optional.
"""
import argparse
import ast
from dataclasses import dataclass
import dataclasses
import functools
import importlib
import inspect
from pathlib import Path, PurePath
import re
import sys
import typing

from . import CORE, SURFACE, within

#: Where a checkout commits the snapshot, from the repository root.
DEFAULT_SNAPSHOT = Path("core") / "public-surface.txt"
HEADER = ("# The public surface of {core} (Plan 4 §2.3): what a product may import.\n"
          "# Rendered by `python -m delphi_core_testkit.abstraction surface render` (A3); never edit it by hand.\n")
ADDRESS = re.compile(r" at 0x[0-9a-fA-F]+")


# ---------------------------------------------------------------- rendering

class NotSimple(Exception):
    """A value with no deterministic spelling of its own."""


def literal(value, depth=0):
    """A simple value spelled the same in every process (sets sorted, paths as `Path(...)`); else NotSimple."""
    kind = type(value)
    if value is None or kind in (str, int, float, bool):
        return repr(value)
    if isinstance(value, PurePath):
        return f"Path({str(value)!r})"
    if depth > 4:
        raise NotSimple
    if kind in (tuple, list):
        parts = [literal(item, depth + 1) for item in value]
        if kind is list:
            return "[" + ", ".join(parts) + "]"
        return "(" + ", ".join(parts) + ("," if len(parts) == 1 else "") + ")"
    if kind in (frozenset, set):
        parts = sorted(literal(item, depth + 1) for item in value)
        return f"{kind.__name__}({{{', '.join(parts)}}})" if parts else f"{kind.__name__}()"
    if kind is dict:
        items = sorted((literal(key, depth + 1), literal(item, depth + 1)) for key, item in value.items())
        return "{" + ", ".join(f"{key}: {item}" for key, item in items) + "}"
    raise NotSimple


class Renderer:
    def __init__(self, core, modules):
        self.core = core
        self.modules = {name: importlib.import_module(name) for name in modules}
        self.exports = {name: self.exported(module) for name, module in self.modules.items()}
        # An exported class or function is written by its exported name: from the
        # surface module nearest to where it is defined, else the first that exports it.
        exporting = {}
        for name, exports in self.exports.items():
            for export, value in exports:
                if (inspect.isclass(value) or inspect.isfunction(value)) and self.in_core(value):
                    exporting.setdefault(f"{value.__module__}.{value.__qualname__}", []).append(
                        (value.__module__, name, export))
        self.public = {}
        for internal, options in exporting.items():
            near = [option for option in options if within(option[0], option[1])]
            _, name, export = max(near, key=lambda option: len(option[1])) if near else options[0]
            self.public[internal] = f"{name}.{export}"
        self.rewrite = (re.compile(r"(?<![\w.])(" + "|".join(
            re.escape(internal) for internal in sorted(self.public, key=len, reverse=True)) + r")(?![\w])")
            if self.public else None)

    def in_core(self, value):
        return within(getattr(value, "__module__", None) or "", self.core)

    def exported(self, module):
        names = getattr(module, "__all__", None)
        if names is not None:
            missing = [name for name in names if not hasattr(module, name)]
            if missing:
                raise AttributeError(f"{module.__name__}.__all__ names what it does not define: {', '.join(missing)}")
            return [(name, getattr(module, name)) for name in sorted(set(names))]
        found = []
        for name, value in sorted(vars(module).items()):
            if name.startswith("_") or inspect.ismodule(value):
                continue
            if (inspect.isclass(value) or inspect.isroutine(value)) and not self.in_core(value):
                continue
            found.append((name, value))
        return found

    def text(self, written):
        return self.rewrite.sub(lambda match: self.public[match.group(1)], written) if self.rewrite else written

    def annotation(self, value):
        if isinstance(value, str):
            return value
        if value is None or value is type(None):
            return "None"
        if inspect.isclass(value) and not typing.get_args(value) and type(value).__name__ != "GenericAlias":
            if value.__module__ == "builtins":
                return value.__qualname__
            internal = f"{value.__module__}.{value.__qualname__}"
            return self.public.get(internal, internal)
        return self.text(ADDRESS.sub("", repr(value)))

    def default(self, value):
        if inspect.isclass(value):
            return self.annotation(value)
        if type(value).__module__.split(".")[0] == "fastapi":
            # A dependency's marker, written by what it declares rather than by
            # FastAPI's repr, which gains a field with each release.
            kind = type(value).__name__
            if getattr(value, "dependency", None) is not None:
                target = value.dependency
                return f"{kind}({self.text(f'{target.__module__}.{target.__qualname__}')})"
            if hasattr(value, "default"):
                return f"{kind}({self.default(value.default)})"
        return self.text(ADDRESS.sub("", repr(value)))

    def signature(self, function):
        try:
            signature = inspect.signature(function, eval_str=True)
        except Exception:  # an annotation only a type checker can resolve
            try:
                signature = inspect.signature(function)
            except (TypeError, ValueError):
                return "(...)"
        parts, positional_only, keyword_only = [], False, False
        for parameter in signature.parameters.values():
            kind = parameter.kind
            if positional_only and kind != parameter.POSITIONAL_ONLY:
                parts.append("/")
                positional_only = False
            if kind == parameter.POSITIONAL_ONLY:
                positional_only = True
            if kind == parameter.KEYWORD_ONLY and not keyword_only:
                parts.append("*")
            if kind in (parameter.VAR_POSITIONAL, parameter.KEYWORD_ONLY):
                keyword_only = True
            written = {parameter.VAR_POSITIONAL: "*", parameter.VAR_KEYWORD: "**"}.get(kind, "") + parameter.name
            if parameter.annotation is not parameter.empty:
                written += ": " + self.annotation(parameter.annotation)
            if parameter.default is not parameter.empty:
                written += " = " + self.default(parameter.default)
            parts.append(written)
        if positional_only:
            parts.append("/")
        rendered = f"({', '.join(parts)})"
        if signature.return_annotation is not signature.empty:
            rendered += " -> " + self.annotation(signature.return_annotation)
        return rendered

    def routine(self, key, raw):
        """The line for a function, or for a method as its class holds it."""
        prefix = ""
        if isinstance(raw, staticmethod):
            prefix, raw = "staticmethod ", raw.__func__
        elif isinstance(raw, classmethod):
            prefix, raw = "classmethod ", raw.__func__
        kind = ("async def" if inspect.iscoroutinefunction(raw) else "def")
        if getattr(raw, "__isabstractmethod__", False):
            prefix = "abstract " + prefix
        return f"{key} {prefix}{kind}: {self.signature(raw)}"

    def value(self, key, value):
        if typing.get_origin(value) is not None or type(value).__module__ == "typing":
            return f"{key} alias: {self.annotation(value)}"
        try:
            return f"{key} value: {self.annotation(type(value))} = {literal(value)}"
        except NotSimple:
            return f"{key} value: {self.annotation(type(value))}"

    def field_default(self, field):
        """` = <default>` for a pydantic field that has one; nothing for a required one."""
        from pydantic_core import PydanticUndefined

        if field.default_factory is not None:
            return f" = <factory {getattr(field.default_factory, '__qualname__', '?')}>"
        if field.default is PydanticUndefined:
            return ""
        try:
            return f" = {literal(field.default)}"
        except NotSimple:
            return f" = {self.default(field.default)}"

    def required_fields(self, klass):
        """The fields a caller must give, for the kinds of class that say so; None for the others."""
        if is_pydantic(klass):
            return {name for name, field in klass.model_fields.items() if field.is_required()}
        if dataclasses.is_dataclass(klass):
            return {field.name for field in dataclasses.fields(klass)
                    if field.default is dataclasses.MISSING and field.default_factory is dataclasses.MISSING}
        if hasattr(klass, "__required_keys__"):
            return set(klass.__required_keys__)
        if hasattr(klass, "_field_defaults") and hasattr(klass, "_fields"):
            return set(klass._fields) - set(klass._field_defaults)
        return None

    def bases(self, cls):
        """The bases a class line names: exported or from outside core; an internal one by its own bases."""
        named = []

        def visit(base):
            if base is object:
                return
            if self.in_core(base) and f"{base.__module__}.{base.__qualname__}" not in self.public:
                for above in base.__bases__:
                    visit(above)
            elif base not in named:
                named.append(base)

        for base in cls.__bases__:
            visit(base)
        return ", ".join(self.annotation(base) for base in named)

    def klass(self, key, cls):
        lines = [f"{key} class: ({self.bases(cls)})"]
        required = self.required_fields(cls)
        seen = set()
        if is_pydantic(cls):
            for name, field in cls.model_fields.items():
                seen.add(name)
                kind = "required field" if name in required else "field"
                lines.append(f"{key}.{name} {kind}: {self.annotation(field.annotation)}{self.field_default(field)}")
        for owner in cls.__mro__:
            if not self.in_core(owner):
                continue
            for name, annotation in inspect.get_annotations(owner).items():
                if name in seen or name.startswith("_") or (is_pydantic(cls) and name.startswith("model_")):
                    continue
                seen.add(name)
                written = self.annotation(annotation)
                if written.startswith(("typing.ClassVar", "ClassVar")):
                    lines.append(f"{key}.{name} attribute: {written}")
                else:
                    kind = "required field" if required is not None and name in required else "field"
                    lines.append(f"{key}.{name} {kind}: {written}")
            for name, raw in vars(owner).items():
                if name in seen or (name.startswith("_") and name not in ("__init__", "__call__")):
                    continue
                if is_pydantic(cls) and name.startswith("model_"):
                    continue
                seen.add(name)
                lines.append(self.member(f"{key}.{name}", raw))
        return lines

    def member(self, key, raw):
        if isinstance(raw, (staticmethod, classmethod)) or inspect.isfunction(raw):
            return self.routine(key, raw)
        if isinstance(raw, (property, functools.cached_property)):
            getter = raw.fget if isinstance(raw, property) else raw.func
            returned = inspect.signature(getter).return_annotation if getter else inspect.Signature.empty
            kind = "abstract property" if getattr(raw, "__isabstractmethod__", False) else "property"
            if isinstance(raw, functools.cached_property):
                kind = "cached property"
            shown = "(unannotated)" if returned is inspect.Signature.empty else self.annotation(returned)
            return f"{key} {kind}: {shown}"
        if inspect.isclass(raw):
            return f"{key} class: ({self.bases(raw)})"
        return f"{key} attribute: {self.annotation(type(raw))}"

    def render(self):
        lines = [HEADER.format(core=self.core)]
        for name, exports in self.exports.items():
            body = []
            for export, value in exports:
                key = f"{name}:{export}"
                if inspect.isclass(value):
                    body.extend(self.klass(key, value))
                elif inspect.isroutine(value):
                    body.append(self.routine(key, value))
                else:
                    body.append(self.value(key, value))
            lines.extend(sorted(body, key=lambda line: line.split(" ", 1)[0]))
        return "\n".join(lines) + "\n"


def is_pydantic(cls):
    return inspect.isclass(cls) and isinstance(getattr(cls, "model_fields", None), dict) and hasattr(cls, "model_config")


def render(core=CORE, modules=None):
    """The surface of `core` as text; `modules` default to §2.3's, relative names taken under core."""
    modules = [module if within(module, core) else f"{core}.{module}" for module in (modules or SURFACE)]
    return Renderer(core, modules).render()


# ---------------------------------------------------------------- classifying

@dataclass(frozen=True)
class Change:
    key: str
    breaking: bool
    what: str

    def __str__(self):
        return f"{'breaking' if self.breaking else 'additive'}: {self.key}: {self.what}"


@dataclass(frozen=True)
class Parameter:
    name: str
    kind: str  # positional-only, positional, *args, keyword-only, **kwargs
    annotation: str | None
    default: str | None


def parse(text):
    """{key: (kind, detail)} from a rendering; comments and blank lines skipped."""
    lines = {}
    for line in text.splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        key, _, rest = line.partition(" ")
        kind, _, detail = rest.partition(": ")
        lines[key] = (kind.strip(), detail.strip())
    return lines


def split_top(text, separator):
    """`text` split at each `separator` outside brackets and quotes."""
    parts, depth, quote, start, at = [], 0, None, 0, 0
    while at < len(text):
        char = text[at]
        if quote:
            if char == "\\":
                at += 1
            elif char == quote:
                quote = None
        elif char in "'\"":
            quote = char
        elif char in "([{":
            depth += 1
        elif char in ")]}":
            depth -= 1
        elif depth == 0 and text.startswith(separator, at):
            parts.append(text[start:at])
            at += len(separator)
            start = at
            continue
        at += 1
    parts.append(text[start:])
    return parts


def parse_signature(detail):
    """(parameters, return annotation or None) from `(a: int, *, b = 1) -> R`."""
    inside, returned = detail, None
    if detail.startswith("("):
        depth = 0
        for at, char in enumerate(detail):
            depth += char in "([{"
            depth -= char in ")]}"
            if depth == 0:
                inside, rest = detail[1:at], detail[at + 1:].strip()
                returned = rest[3:].strip() if rest.startswith("->") else None
                break
    parameters, kind = [], "positional"
    for raw in (part.strip() for part in split_top(inside, ",")):
        if not raw:
            continue
        if raw == "/":
            parameters = [Parameter(p.name, "positional-only", p.annotation, p.default) for p in parameters]
            continue
        if raw == "*":
            kind = "keyword-only"
            continue
        head, *default = split_top(raw, " = ")
        name, *annotation = split_top(head, ": ")
        this = kind
        if name.startswith("**"):
            name, this = name[2:], "**kwargs"
        elif name.startswith("*"):
            name, this, kind = name[1:], "*args", "keyword-only"
        parameters.append(Parameter(name.strip(), this, ": ".join(annotation).strip() or None,
                                    " = ".join(default).strip() or None))
    return parameters, returned


def signature_change(old, new):
    """Why changing signature `old` into `new` breaks a caller, or None when every old call still works."""
    old_parameters, old_return = parse_signature(old)
    new_parameters, new_return = parse_signature(new)
    if old_return != new_return:
        return f"returns {new_return or 'unannotated'} instead of {old_return or 'unannotated'}"

    def same(a, b):
        if a.annotation != b.annotation:
            return f"parameter {a.name} is {b.annotation or 'unannotated'}, was {a.annotation or 'unannotated'}"
        if a.default is not None and a.default != b.default:
            return f"parameter {a.name}'s default is {b.default or 'gone'}, was {a.default}"
        return None

    positional = ("positional-only", "positional")
    old_positional = [p for p in old_parameters if p.kind in positional]
    new_positional = [p for p in new_parameters if p.kind in positional]
    for index, before in enumerate(old_positional):
        if index >= len(new_positional):
            return f"positional parameter {before.name} is gone"
        after = new_positional[index]
        if before.kind == "positional" and (after.kind != "positional" or after.name != before.name):
            return f"parameter {index} is {after.name} ({after.kind}), was {before.name} ({before.kind})"
        problem = same(before, after)
        if problem:
            return problem
    for after in new_positional[len(old_positional):]:
        if after.default is None:
            return f"new positional parameter {after.name} has no default"
    by_name = {p.name: p for p in new_parameters if p.kind in ("positional", "keyword-only")}
    old_keyword = {p.name: p for p in old_parameters if p.kind == "keyword-only"}
    for name, before in old_keyword.items():
        if name not in by_name:
            return f"keyword parameter {name} is gone"
        problem = same(before, by_name[name])
        if problem:
            return problem
    for after in new_parameters:
        if after.kind == "keyword-only" and after.name not in old_keyword and after.default is None:
            return f"new keyword parameter {after.name} has no default"
    for variadic in ("*args", "**kwargs"):
        before = [p for p in old_parameters if p.kind == variadic]
        after = [p for p in new_parameters if p.kind == variadic]
        if before and not after:
            return f"no longer takes {variadic}"
        if before and after and before[0].annotation != after[0].annotation:
            return f"{variadic} is {after[0].annotation or 'unannotated'}, was {before[0].annotation or 'unannotated'}"
    return None


def members(detail):
    """(type, the members) of a `tuple = (...)` or `frozenset = frozenset({...})` value line, else None."""
    kind, _, written = detail.partition(" = ")
    if kind not in ("tuple", "frozenset") or not written:
        return None
    if kind == "frozenset":
        written = written.removeprefix("frozenset(").removesuffix(")") or "()"
    try:
        found = ast.literal_eval(written)
    except (ValueError, SyntaxError):
        return None
    return kind, [found] if not isinstance(found, (tuple, set, frozenset, list)) else list(found)


def members_gained(old, new):
    """The members a tuple or frozenset value only gained, as written; None for any other change."""
    before, after = members(old), members(new)
    if not before or not after or before[0] != after[0]:
        return None
    if not all(member in after[1] for member in before[1]):
        return None
    if before[0] == "tuple" and [member for member in after[1] if member in before[1]] != before[1]:
        return None  # reordered: a caller indexing it reads another member
    return [repr(member) for member in after[1] if member not in before[1]] or None


def definition(kind):
    """(abstract, the rest of the kind) for a definition kind."""
    return kind.startswith("abstract "), kind.removeprefix("abstract ")


def classify(old_text, new_text):
    """Every difference between two renderings, each additive or breaking."""
    old, new = parse(old_text), parse(new_text)
    changes = []
    for key in sorted(old.keys() - new.keys()):
        changes.append(Change(key, True, f"removed (was {old[key][0]}: {old[key][1]})"))
    for key in sorted(new.keys() - old.keys()):
        kind, detail = new[key]
        owner = key.rpartition(".")[0] if "." in key.partition(":")[2] else None
        if kind.startswith("abstract") and owner in old:
            changes.append(Change(key, True, f"a new {kind} on an existing class: every implementation must add it"))
        elif kind == "required field" and owner in old:
            changes.append(Change(key, True, f"a new required field: {detail}"))
        else:
            changes.append(Change(key, False, f"added ({kind}: {detail})"))
    for key in sorted(old.keys() & new.keys()):
        if old[key] == new[key]:
            continue
        (old_kind, old_detail), (new_kind, new_detail) = old[key], new[key]
        changes.append(Change(key, *judge_change(old_kind, old_detail, new_kind, new_detail)))
    return changes


def judge_change(old_kind, old_detail, new_kind, new_detail):
    """(breaking, what) for one changed line."""
    shown = f"{old_kind}: {old_detail} -> {new_kind}: {new_detail}"
    if old_kind.endswith("def") and new_kind.endswith("def"):
        (was_abstract, was), (is_abstract, now) = definition(old_kind), definition(new_kind)
        if was != now:
            return True, f"{was} became {now}"
        if is_abstract and not was_abstract:
            return True, "became abstract: every implementation must define it"
        problem = signature_change(old_detail, new_detail)
        if problem:
            return True, problem
        return False, shown
    if {old_kind, new_kind} <= {"field", "required field"}:
        (old_type, _, old_default), (new_type, _, new_default) = (old_detail.partition(" = "),
                                                                   new_detail.partition(" = "))
        if old_type == new_type and old_kind != new_kind:
            required = new_kind == "required field"
            return required, ("became required" if required else "became optional")
        if old_type == new_type:
            return True, f"its default is {new_default or 'gone'}, was {old_default or 'none'}"
    if old_kind == new_kind == "value":
        gained = members_gained(old_detail, new_detail)
        if gained is not None:
            return False, f"gained {', '.join(gained)}"
        return True, f"its value changed: {shown}"
    if old_kind == "abstract property" and new_kind == "property" and old_detail == new_detail:
        return False, "no longer abstract"
    return True, shown


# ---------------------------------------------------------------- command line

def main(argv=None):
    parser = argparse.ArgumentParser(prog="abstraction surface", description=__doc__.split("\n")[0])
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("render", "check"):
        command = commands.add_parser(name)
        command.add_argument("--core", default=CORE, help=f"core's import package (default {CORE})")
        command.add_argument("--module", action="append", help="a module to render; repeat (default §2.3's)")
        command.add_argument("--path", action="append", default=[], help="a directory to put first on sys.path")
        if name == "render":
            command.add_argument("--output", type=Path, help="write here instead of stdout")
        else:
            command.add_argument("--snapshot", type=Path, default=DEFAULT_SNAPSHOT, help="the committed rendering")
    diff = commands.add_parser("diff")
    diff.add_argument("old", type=Path)
    diff.add_argument("new", type=Path)
    diff.add_argument("--breaking-allowed", action="store_true",
                      help="the version bump allows a break (0.x: a new minor; after 1.0: a new major)")
    args = parser.parse_args(argv)

    if args.command == "diff":
        changes = classify(args.old.read_text(), args.new.read_text())
        return report(changes, args.breaking_allowed)
    for path in reversed(args.path):
        sys.path.insert(0, str(path))
    try:
        rendered = render(args.core, args.module)
    except (ImportError, AttributeError) as error:
        print(f"public surface: cannot render: {error}", file=sys.stderr)
        return 1
    if args.command == "render":
        if args.output:
            args.output.write_text(rendered)
        else:
            sys.stdout.write(rendered)
        return 0
    if not args.snapshot.exists():
        print(f"public surface: no snapshot at {args.snapshot}; write one with `surface render --output`", file=sys.stderr)
        return 1
    committed = args.snapshot.read_text()
    if committed == rendered:
        print(f"public surface: {len(parse(rendered))} lines, equal to {args.snapshot.name}.")
        return 0
    changes = classify(committed, rendered)
    for change in changes:
        print(f"differs, {change}", file=sys.stderr)
    print(f"public surface: the rendering differs from {args.snapshot.name} in {len(changes)} names "
          f"({sum(change.breaking for change in changes)} breaking). If that is intended, render it again "
          f"with `python -m delphi_core_testkit.abstraction surface render --output {args.snapshot}` and commit it.",
          file=sys.stderr)
    return 1


def report(changes, breaking_allowed):
    for change in changes:
        print(change)
    breaking = sum(change.breaking for change in changes)
    print(f"public surface: {len(changes) - breaking} additive, {breaking} breaking"
          + ("; the version bump allows breaking changes." if breaking and breaking_allowed else "."))
    return 1 if breaking and not breaking_allowed else 0


if __name__ == "__main__":
    sys.exit(main())
