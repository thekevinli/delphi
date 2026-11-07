"""A6 · settings: a product's Settings subclass adds keys and never changes what a core key means.

Plan 4 §2.4 rule 8, one meaning per setting. For every key of core's `Settings`,
each product subclass must keep:

- the annotation, with its constraints (`Field(ge=1)`), unions compared as sets;
- the default, or the default factory (the same object, or one returning an equal value);
- the name it is read from: its alias and validation alias, and the class's
  `env_prefix`, `case_sensitive` and `env_nested_delimiter`;
- core's validators: the subclass replaces none of them by name, and adds no
  field validator on a core key, which could narrow or rewrite what it accepts;
- where every key is read from: the subclass, and any class it puts before core's
  in its MRO, does not override `settings_customise_sources`.

A model validator a product adds is not judged: it may read core keys, as the web's
cloud-signup check will, and a rewrite of a core key inside one is not visible
without running it.

    python -m delphi_core_testkit.abstraction settings --product delphi_web.settings:WebSettings
    python -m delphi_core_testkit.abstraction settings --discover delphi_desktop

`--discover PACKAGE` imports every module of the package and checks each subclass of
the base defined there; finding none fails, since a product that declares settings
of its own does so with a subclass.
"""
import argparse
import importlib
import pkgutil
import sys
import types
import typing

from . import CORE, load_object, within

DEFAULT_BASE = f"{CORE}.settings:Settings"
#: model_config keys that decide which environment name a key is read from.
NAMING = ("env_prefix", "case_sensitive", "env_nested_delimiter")


def name_of(cls):
    return f"{cls.__module__}.{cls.__qualname__}"


def shape(annotation):
    """An annotation in a form where `Optional[int]`, `int | None` and `Union[None, int]` are equal."""
    origin = typing.get_origin(annotation)
    if origin in (typing.Union, types.UnionType):
        return ("union", frozenset(shape(argument) for argument in typing.get_args(annotation)))
    if origin is not None:
        return (origin, tuple(shape(argument) for argument in typing.get_args(annotation)))
    return annotation


def shown(annotation):
    return annotation.__name__ if isinstance(annotation, type) and not typing.get_args(annotation) else repr(annotation)


def default_of(field):
    """('required',), ('value', v) or ('factory', f) for one pydantic field."""
    from pydantic_core import PydanticUndefined

    if field.default is not PydanticUndefined:
        return ("value", field.default)
    if field.default_factory is not None:
        return ("factory", field.default_factory)
    return ("required",)


def same_default(base, product):
    """Whether two fields default alike; a factory is compared by what it makes when it cannot be by identity."""
    ours, theirs = default_of(base), default_of(product)
    if ours[0] != theirs[0]:
        return False
    if ours[0] == "required":
        return True
    if ours[0] == "value":
        return type(ours[1]) is type(theirs[1]) and ours[1] == theirs[1]
    if ours[1] is theirs[1]:
        return True
    if getattr(base, "default_factory_takes_data", False) or getattr(product, "default_factory_takes_data", False):
        return False  # a factory that reads the other keys is compared as an object
    try:
        made, other = ours[1](), theirs[1]()
    except Exception:
        return False
    return type(made) is type(other) and made == other


def describe_default(field):
    kind, *value = default_of(field)
    if kind == "required":
        return "nothing (required)"
    if kind == "value":
        return repr(value[0])
    return f"what {getattr(value[0], '__qualname__', value[0])} makes"


def validators(cls):
    """{(kind, name): decorator} for every pydantic validator a class holds, its own and inherited."""
    infos = cls.__pydantic_decorators__
    found = {}
    for kind in ("validators", "field_validators", "root_validators", "model_validators"):
        for name, decorator in getattr(infos, kind, {}).items():
            found[(kind, name)] = decorator
    return found


def function_of(decorator):
    """The function a validator runs; pydantic rebinds an inherited one to each subclass."""
    return getattr(decorator.func, "__func__", decorator.func)


def settings_violations(base, product):
    """Every way `product` changes the meaning of one of `base`'s keys, in words."""
    if not (isinstance(product, type) and issubclass(product, base)):
        return [f"{name_of(product)} does not subclass {name_of(base)}"]
    found = []
    for name, field in base.model_fields.items():
        theirs = product.model_fields.get(name)
        if theirs is None:
            found.append(f"{name}: missing from {name_of(product)}")
            continue
        if shape(field.annotation) != shape(theirs.annotation):
            found.append(f"{name}: annotated {shown(theirs.annotation)}, core says {shown(field.annotation)}")
        if field.metadata != theirs.metadata:
            found.append(f"{name}: constraints {theirs.metadata!r}, core says {field.metadata!r}")
        if not same_default(field, theirs):
            found.append(f"{name}: defaults to {describe_default(theirs)}, core says {describe_default(field)}")
        for attribute in ("alias", "validation_alias"):
            if getattr(field, attribute) != getattr(theirs, attribute):
                found.append(f"{name}: {attribute} {getattr(theirs, attribute)!r}, core says {getattr(field, attribute)!r}")
    for owner in product.__mro__:
        if owner is base:
            break
        if "settings_customise_sources" in vars(owner):
            found.append(f"{name_of(owner)} overrides settings_customise_sources: every core key would be "
                         "read from other sources")
    for key in NAMING:
        if base.model_config.get(key) != product.model_config.get(key):
            found.append(f"model_config[{key!r}] is {product.model_config.get(key)!r}, core says "
                         f"{base.model_config.get(key)!r}: every core key would be read from another name")
    ours, theirs = validators(base), validators(product)
    for (kind, name), decorator in ours.items():
        replaced = theirs.get((kind, name))
        if replaced is not None and function_of(replaced) is not function_of(decorator):
            found.append(f"validator {name} replaces core's ({kind})")
    for (kind, name), decorator in theirs.items():
        if (kind, name) in ours or kind != "field_validators":
            continue
        fields = decorator.info.fields
        touched = sorted(base.model_fields) if "*" in fields else sorted(set(fields) & set(base.model_fields))
        if touched:
            found.append(f"validator {name} validates core keys {', '.join(touched)}: "
                         "a product may not narrow or rewrite what a core key accepts")
    return found


def discover(base, package, paths=()):
    """(subclasses of `base` defined under `package`, modules that would not import)."""
    for path in reversed(paths):
        if str(path) not in sys.path:
            sys.path.insert(0, str(path))
    root = importlib.import_module(package)
    failed = []
    for info in pkgutil.walk_packages(getattr(root, "__path__", []), prefix=package + "."):
        try:
            importlib.import_module(info.name)
        except Exception as error:  # a module that needs what this process lacks
            failed.append(f"{info.name}: {type(error).__name__}: {error}")
    found, queue = [], list(base.__subclasses__())
    while queue:
        cls = queue.pop()
        queue.extend(cls.__subclasses__())
        if within(cls.__module__, package) and cls not in found:
            found.append(cls)
    return sorted(found, key=name_of), failed


def main(argv=None):
    parser = argparse.ArgumentParser(prog="abstraction settings", description=__doc__.split("\n")[0])
    parser.add_argument("--base", default=DEFAULT_BASE, help="core's Settings (default %(default)s)")
    parser.add_argument("--product", action="append", default=[], help="a product's subclass, module:Class")
    parser.add_argument("--discover", action="append", default=[], help="a package whose subclasses to check")
    parser.add_argument("--path", action="append", default=[], help="a directory to put first on sys.path")
    parser.add_argument("--report", action="store_true", help="list what fails, and exit 0")
    args = parser.parse_args(argv)
    if not args.product and not args.discover:
        parser.error("name a --product or a package to --discover")

    base = load_object(args.base, args.path)
    classes, problems = [load_object(spec, args.path) for spec in args.product], []
    for package in args.discover:
        found, failed = discover(base, package, args.path)
        problems += [f"{package}: could not import {line}" for line in failed]
        if not found:
            problems.append(f"{package}: no subclass of {name_of(base)}")
        classes += [cls for cls in found if cls not in classes]

    failing = 0
    for cls in classes:
        found = settings_violations(base, cls)
        failing += len(found)
        for line in found:
            print(f"changes a core key: {name_of(cls)}: {line}", file=sys.stderr)
    for line in problems:
        print(f"FAIL: {line}", file=sys.stderr)
    print(f"settings: {len(base.model_fields)} core keys in {name_of(base)}; {len(classes)} subclasses "
          f"({', '.join(name_of(cls) for cls in classes) or 'none'}); {failing} changed keys, {len(problems)} problems.")
    if args.report:
        return 0
    return 1 if failing or problems else 0


if __name__ == "__main__":
    sys.exit(main())
