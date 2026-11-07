"""
The harness's layout, as a rule rather than a habit.

`delphi_core/harness/` is one provider client, one registry, one loop, and one module
per tool. That is only worth having while it stays true, and every way it
stops being true is quiet: a tool defined in a router "just this once", a
harness module that reaches back into a task, a tool module that grows the
work it was meant to adapt. Each guard below reads the source and fails on one
of those, and each is run once against a deliberately broken tree to prove it
fires.

A file over its ceiling is paid for out of itself: move the work to the domain
module that owns the data, or split by responsibility. Raising a number is the
last resort, and is done here with the reason beside it.
"""

import ast
from pathlib import Path

import delphi_core
from delphi_core.harness import profiles
from delphi_core.harness.registry import CATALOGUE
from delphi_core.harness.tool import BudgetClass, Tool, ToolArguments, TraceProjection

APP = Path(delphi_core.__file__).parent
HARNESS = APP / "harness"
MAINTENANCE = APP / "memory_maintenance"

#: Code lines a tool module may hold. A tool module is an adapter: what the
#: model needs to call it, how the call appears in the trace, and a short run.
TOOL_MODULE_MAX = 150
#: Code lines any other harness module may hold, and any module of the
#: maintenance pipeline.
HARNESS_MODULE_MAX = 300
#: The longest a tool's "when to reach for it" line may be. It is one line of
#: every request's instructions, on every turn.
GUIDANCE_MAX_CHARS = 600
#: The only names a tool module may define for others to use.
TOOL_MODULE_NAMES = {"NAME", "Options", "Arguments", "tool"}
#: The modules of the maintenance pipeline that the harness's write tools are
#: built on: pure code that applies and checks an edit. The harness imports
#: nothing that imports the harness, so these import none of what is built on
#: it, and of their own package only each other. Every other module of the
#: package is a stage, and a stage does use the harness.
BELOW_THE_HARNESS = {"blocks", "ops", "validate", "staging", "cite", "reader_notes", "admit"}
#: The stages of the maintenance pipeline, with the module that puts them in
#: order. A stage is built on the harness and the domain modules, and on no
#: other stage: what one hands the next is a type of `run.py`. A stage split by
#: responsibility keeps its name in front (`maintain_prompt.py`), and its parts
#: are held to the same rules as part of that stage.
STAGES = {"gather", "select", "maintain", "verify", "commit", "domain", "pipeline"}
#: The one module that imports the stages.
ORDERS_THE_STAGES = "pipeline"
#: What the stages share that the write tools do not stand on: the types one
#: stage hands the next, a job's names and hashes, the event a job leaves.
#: Pure code, so it imports no stage, no router and nothing of the harness.
SHARED_BY_THE_STAGES = {"run", "jobs", "event", "brief"}
#: What the stages that run a model in the tool loop share: the run to its
#: end and how its conversation is read. Built on the harness, as a stage is,
#: and like the other shared modules it imports no stage and no router.
SHARED_ON_THE_HARNESS = {"agent"}
#: The module a write is staged through. A tool module that imports it writes.
STAGES_A_WRITE = "delphi_core.memory_maintenance.admit"
#: A store method a tool module calls by one of these names changes something.
STORE_WRITE_PREFIXES = ("upsert_", "delete_", "put_", "write_", "save_", "append_", "set_")
#: Where an entry of a request's `tools` may be written, besides a tool module.
MAY_BUILD_A_TOOL_ENTRY = {
    # The one generator: a function tool's entry is built from its `Arguments`
    # here, so that no tool module writes one by hand.
    "harness/tool.py",
}


def code_lines(source: str) -> int:
    """Lines that are code: not blank, not a comment, not a docstring."""
    documented: set[int] = set()
    tree = ast.parse(source)
    for node in ast.walk(tree):
        if not isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        first = node.body[0] if node.body else None
        if (
            isinstance(first, ast.Expr)
            and isinstance(first.value, ast.Constant)
            and isinstance(first.value.value, str)
        ):
            documented.update(range(first.lineno, first.end_lineno + 1))
    return sum(
        1
        for number, line in enumerate(source.splitlines(), start=1)
        if line.strip() and not line.lstrip().startswith("#") and number not in documented
    )


def imported_modules(path: Path, package: tuple[str, ...]) -> set[str]:
    """Every module a file imports, as an absolute dotted name."""
    found: set[str] = set()
    for node in ast.walk(ast.parse(path.read_text())):
        if isinstance(node, ast.Import):
            found.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            base = package[: len(package) - (node.level - 1)] if node.level else ()
            module = ".".join([*base, *([node.module] if node.module else [])])
            found.add(module)
            # `from . import x` names modules in its alias list.
            found.update(f"{module}.{alias.name}" for alias in node.names)
    return found


def package_of(path: Path, root: Path) -> tuple[str, ...]:
    return ("delphi_core", *path.relative_to(root).parent.parts)


def catalogue_problems(tools_dir: Path, catalogue: tuple[str, ...]) -> list[str]:
    """G1: the directory and the catalogue are the same set, and a module is named for its tool."""
    problems: list[str] = []
    modules = {path.stem for path in tools_dir.glob("*.py") if path.stem != "__init__"}
    for name in sorted(modules - set(catalogue)):
        problems.append(f"tools/{name}.py is not in CATALOGUE")
    for name in sorted(set(catalogue) - modules):
        problems.append(f"CATALOGUE names {name!r}, which has no module")
    for path in sorted(tools_dir.glob("*.py")):
        if path.stem == "__init__":
            continue
        names = [
            node.value.value
            for node in ast.parse(path.read_text()).body
            if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == "NAME" for target in node.targets)
            and isinstance(node.value, ast.Constant)
        ]
        if names != [path.stem]:
            problems.append(f"tools/{path.name} must define NAME = {path.stem!r}, found {names}")
    return problems


def harness_users(app_dir: Path) -> set[str]:
    """Modules outside the harness that import it: the tasks and routers it serves."""
    users: set[str] = set()
    for path in app_dir.rglob("*.py"):
        if (app_dir / "harness") in path.parents:
            continue
        package = package_of(path, app_dir)
        if any(name == "delphi_core.harness" or name.startswith("delphi_core.harness.") for name in imported_modules(path, package)):
            users.add(".".join([*package, path.stem]))
    return users


def import_problems(app_dir: Path) -> list[str]:
    """G3: the harness imports no router and nothing that uses it; a tool imports no tool and no registry."""
    problems: list[str] = []
    users = harness_users(app_dir)
    harness = app_dir / "harness"
    above_a_tool = {"delphi_core.harness.registry", "delphi_core.harness.profiles", "delphi_core.harness.loop"}
    for path in sorted(harness.rglob("*.py")):
        relative = path.relative_to(app_dir).as_posix()
        is_tool = path.parent.name == "tools" and path.stem != "__init__"
        flagged: dict[str, str] = {}
        for name in imported_modules(path, package_of(path, app_dir)):
            if name == "delphi_core.routers" or name.startswith("delphi_core.routers."):
                flagged[name] = f"{relative} imports a router: {name}"
            elif any(name == user or name.startswith(user + ".") for user in users):
                flagged[name] = f"{relative} imports {name}, which is built on the harness"
            elif is_tool and name.startswith("delphi_core.harness.tools.") and not (
                name == f"delphi_core.harness.tools.{path.stem}"
            ):
                flagged[name] = f"{relative} imports another tool: {name}"
            elif is_tool and any(name == above or name.startswith(above + ".") for above in above_a_tool):
                flagged[name] = f"{relative} imports {name}; a tool knows nothing of who offers it"
        # `from x import y` is read as both `x` and `x.y`; one line says it.
        problems.extend(
            message
            for name, message in sorted(flagged.items())
            if not any(name.startswith(other + ".") for other in flagged)
        )
    return problems


def tool_entry_problems(app_dir: Path) -> list[str]:
    """G4: only a module under `harness/tools/` writes an entry of a request's `tools`."""
    problems: list[str] = []
    for path in sorted(app_dir.rglob("*.py")):
        relative = path.relative_to(app_dir).as_posix()
        if relative.startswith("harness/tools/") or relative in MAY_BUILD_A_TOOL_ENTRY:
            continue
        for node in ast.walk(ast.parse(path.read_text())):
            if not isinstance(node, ast.Dict):
                continue
            pairs = {
                key.value: value.value
                for key, value in zip(node.keys, node.values)
                if isinstance(key, ast.Constant) and isinstance(value, ast.Constant)
            }
            keys = {key.value for key in node.keys if isinstance(key, ast.Constant)}
            hosted = pairs.get("type") == "web_search"
            function = pairs.get("type") == "function" and "name" in keys
            if hosted or function:
                problems.append(f"{relative}:{node.lineno} builds a tool entry outside harness/tools/")
    return problems


def size_problems(harness_dir: Path) -> list[str]:
    """G5: a tool module stays an adapter, and no harness module becomes a second router."""
    problems: list[str] = []
    for path in sorted(harness_dir.rglob("*.py")):
        ceiling = TOOL_MODULE_MAX if path.parent.name == "tools" else HARNESS_MODULE_MAX
        lines = code_lines(path.read_text())
        if lines > ceiling:
            problems.append(
                f"{path.relative_to(harness_dir).as_posix()} has {lines} code lines; the ceiling is {ceiling}"
            )
    return problems


def maintenance_problems(app_dir: Path) -> list[str]:
    """G9: the pipeline's package says nothing itself, and what the write tools stand on stands on no task."""
    problems: list[str] = []
    package = app_dir / "memory_maintenance"
    init = package / "__init__.py"
    if not init.exists() or init.read_text().strip():
        # An import of any one module runs this file. Left empty, importing
        # `ops` for a tool can never pull in a stage, and with it the harness.
        problems.append("memory_maintenance/__init__.py must exist and be empty")
    forbidden = {
        "delphi_core.harness": "the harness, which is built on this module",
        "delphi_core.routers": "a router",
        "delphi_core.memory": "memory.py, which is built on the harness",
    }
    for stem in sorted(BELOW_THE_HARNESS):
        path = package / f"{stem}.py"
        if not path.exists():
            continue
        flagged: dict[str, str] = {}
        for name in imported_modules(path, package_of(path, app_dir)):
            for root, what in forbidden.items():
                if name == root or name.startswith(root + "."):
                    flagged[name] = f"memory_maintenance/{stem}.py imports {what}: {name}"
            inside = name.removeprefix("delphi_core.memory_maintenance.").split(".")[0]
            if name.startswith("delphi_core.memory_maintenance.") and inside not in BELOW_THE_HARNESS:
                what = "a stage of its own pipeline" if stage_of(inside) else "a module the write tools do not stand on"
                flagged[name] = f"memory_maintenance/{stem}.py imports {what}: {name}"
        # `from x import y` is read as both `x` and `x.y`; one line says it.
        problems.extend(
            message
            for name, message in sorted(flagged.items())
            if not any(name.startswith(other + ".") for other in flagged)
        )
    return problems


def stage_of(stem: str) -> str | None:
    """The stage a module of the pipeline's package is, or is a part of."""
    if stem in STAGES:
        return stem
    head = stem.split("_", 1)[0]
    return head if head in STAGES else None


def stage_problems(app_dir: Path) -> list[str]:
    """
    G11: a stage imports no router and no other stage; only `pipeline` imports
    stages; what the stages share imports none of them, and nothing of the
    harness but for the one module that runs its loop for them.

    Written over the files that exist, so it holds a stage from the day its
    module appears. A module that is none of the three kinds is refused until
    this file says which it is.
    """
    problems: list[str] = []
    package = app_dir / "memory_maintenance"
    for path in sorted(package.glob("*.py")):
        stem = path.stem
        if stem == "__init__" or stem in BELOW_THE_HARNESS:
            continue
        own = stage_of(stem)
        if own is None and stem not in SHARED_BY_THE_STAGES | SHARED_ON_THE_HARNESS:
            problems.append(
                f"memory_maintenance/{stem}.py is not a stage, a part of one (`<stage>_<part>.py`) or a module "
                "the stages share; say which it is in this file"
            )
            continue
        flagged: dict[str, str] = {}
        for name in imported_modules(path, package_of(path, app_dir)):
            if name == "delphi_core.routers" or name.startswith("delphi_core.routers."):
                flagged[name] = f"memory_maintenance/{stem}.py imports a router: {name}"
            elif own is None and stem not in SHARED_ON_THE_HARNESS and (name == "delphi_core.harness" or name.startswith("delphi_core.harness.")):
                flagged[name] = f"memory_maintenance/{stem}.py is shared by the stages and imports the harness: {name}"
            elif name.startswith("delphi_core.memory_maintenance."):
                other = stage_of(name.removeprefix("delphi_core.memory_maintenance.").split(".")[0])
                if other is None or other == own or own == ORDERS_THE_STAGES:
                    continue
                flagged[name] = (
                    f"memory_maintenance/{stem}.py is shared by the stages and imports one: {name}"
                    if own is None
                    else f"memory_maintenance/{stem}.py imports another stage; only {ORDERS_THE_STAGES} does: {name}"
                )
        # `from x import y` is read as both `x` and `x.y`; one line says it.
        problems.extend(
            message
            for name, message in sorted(flagged.items())
            if not any(name.startswith(other + ".") for other in flagged)
        )
    return problems


def contract_problems(app_dir: Path) -> list[str]:
    """
    G12: every prompt file under `contracts/` is loaded by exactly one stage,
    and a stage names no prompt file that is not there.

    A module loads a contract when it holds the file's name as a string of its
    own, `"verify.md"` or `"contracts/verify.md"`: a path built from one is
    how a stage reads its prompt. A name inside a longer sentence is prose.
    """
    problems: list[str] = []
    package = app_dir / "memory_maintenance"
    contracts = {path.name for path in (package / "contracts").glob("*.md")}
    named: dict[str, list[str]] = {name: [] for name in contracts}
    for path in sorted(package.glob("*.py")):
        strings = {
            node.value.rsplit("/", 1)[-1]
            for node in ast.walk(ast.parse(path.read_text()))
            if isinstance(node, ast.Constant) and isinstance(node.value, str)
            and node.value.endswith(".md") and node.value.islower()
            and node.value.removeprefix("contracts/").replace("_", "").removesuffix(".md").isalnum()
        }
        for name in sorted(strings):
            if name in named:
                named[name].append(path.stem)
            elif stage_of(path.stem):
                problems.append(f"memory_maintenance/{path.stem}.py loads contracts/{name}, which does not exist")
    for name, loaders in sorted(named.items()):
        stages = [stem for stem in loaders if stage_of(stem)]
        for stem in sorted(set(loaders) - set(stages)):
            problems.append(f"contracts/{name} is loaded by memory_maintenance/{stem}.py, which is not a stage")
        if not stages:
            problems.append(f"contracts/{name} is loaded by no stage")
        elif len(stages) > 1:
            problems.append(f"contracts/{name} is loaded by {', '.join(stages)}; a stage owns its contract alone")
    return problems


def shape_problems(tools_dir: Path) -> list[str]:
    """G2: a tool module is one tool, in the contract's shape, with no schema written by hand."""
    problems: list[str] = []
    for path in sorted(tools_dir.glob("*.py")):
        if path.stem == "__init__":
            continue
        tree = ast.parse(path.read_text())
        defined: set[str] = set()
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                defined.add(node.name)
            elif isinstance(node, ast.Assign):
                defined.update(target.id for target in node.targets if isinstance(target, ast.Name))
            elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
                defined.add(node.target.id)
        public = {name for name in defined if not name.startswith("_")}
        for name in sorted(public - TOOL_MODULE_NAMES):
            problems.append(f"tools/{path.name} makes {name!r} public; a tool module offers only {sorted(TOOL_MODULE_NAMES)}")
        for name in sorted({"NAME", "tool"} - public):
            problems.append(f"tools/{path.name} does not define {name}")
        built = sum(
            1 for node in ast.walk(tree)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "Tool"
        )
        if built != 1:
            problems.append(f"tools/{path.name} builds {built} tools; a module is exactly one")
        for node in ast.walk(tree):
            keys = {key.value for key in node.keys if isinstance(key, ast.Constant)} if isinstance(node, ast.Dict) else set()
            if keys & {"parameters", "properties", "additionalProperties"}:
                problems.append(f"tools/{path.name}:{node.lineno} writes a schema by hand; it is generated from Arguments")
    return problems


def completeness_problems(tools: list[Tool], offered: list[tuple[str, list[Tool]]]) -> list[str]:
    """G6: every tool says when to use it, what it costs and what it keeps; every tool is offered, and only catalogue tools are."""
    problems: list[str] = []
    for tool in tools:
        if not tool.guidance.strip():
            problems.append(f"{tool.name} has no guidance line")
        elif len(tool.guidance) > GUIDANCE_MAX_CHARS:
            problems.append(f"{tool.name}'s guidance is {len(tool.guidance)} characters; the ceiling is {GUIDANCE_MAX_CHARS}")
        if not isinstance(tool.budget, BudgetClass):
            problems.append(f"{tool.name} has no budget class")
        if not isinstance(tool.trace, TraceProjection):
            problems.append(f"{tool.name} has no trace projection")
        if not tool.label.strip():
            problems.append(f"{tool.name} has no status label")
        if tool.hosted:
            if not tool.hosted_spec or not tool.item_type:
                problems.append(f"{tool.name} is hosted and does not say what it is or how its calls arrive")
        elif tool.arguments is None or not issubclass(tool.arguments, ToolArguments) or not tool.description.strip():
            problems.append(f"{tool.name} has no Arguments or no description")
    names = {tool.name for tool in tools}
    everywhere = {tool.name for _, held in offered for tool in held}
    for name in sorted(names - everywhere):
        problems.append(f"{name} is in the catalogue and no profile offers it")
    for profile, held in offered:
        for tool in held:
            if tool.name not in names:
                problems.append(f"profile {profile} offers {tool.name}, which is not in the catalogue")
    return problems


def options_problems(offered: list[tuple[str, list[Tool]]]) -> list[str]:
    """G7: options may vary a tool's wording, never what the model may say to it."""
    problems: list[str] = []
    seen: dict[str, tuple[str, object]] = {}
    for profile, held in offered:
        for tool in held:
            said = tool.spec.get("parameters", tool.spec)
            first = seen.setdefault(tool.name, (profile, said))
            if first[1] != said:
                problems.append(
                    f"{tool.name} takes different arguments in {first[0]} and {profile}; one name is one schema"
                )
    return problems


def write_problems(
    tools: list[Tool], chat: list[tuple[str, list[Tool]]], tools_dir: Path, app_dir: Path
) -> list[str]:
    """
    G10: no chat profile offers a tool that writes Memory, and a tool that
    writes says so.

    The first half is the rule (invariant 29). The other two are what make it
    more than a tool's word for itself: a tool charged to the write budget is
    marked, and so is a tool module that imports the staging path or calls a
    store method that changes something.
    """
    problems: list[str] = []
    for profile, held in chat:
        for tool in held:
            if tool.writes:
                problems.append(f"chat profile {profile} offers {tool.name}, which writes Memory")
    marked = {tool.name for tool in tools if tool.writes}
    for tool in tools:
        if tool.writes != (tool.budget is BudgetClass.WRITE):
            problems.append(
                f"{tool.name} is {'marked as writing' if tool.writes else 'charged as a write'} and is "
                f"{'not charged as a write' if tool.writes else 'not marked `writes`'}"
            )
    for path in sorted(tools_dir.glob("*.py")):
        if path.stem == "__init__" or path.stem in marked:
            continue
        if STAGES_A_WRITE in imported_modules(path, package_of(path, app_dir)):
            problems.append(f"tools/{path.name} imports the staging path and its tool is not marked `writes`")
        for node in ast.walk(ast.parse(path.read_text())):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr.startswith(STORE_WRITE_PREFIXES)
            ):
                problems.append(
                    f"tools/{path.name}:{node.lineno} calls {node.func.attr}, and its tool is not marked `writes`"
                )
    return problems


def _offered(among: tuple[profiles.Profile, ...] = profiles.PROFILES) -> list[tuple[str, list[Tool]]]:
    return [(profile.name, [offer.tool for offer in profile.offers]) for profile in among]


def chat_tools() -> list[str]:
    """The names of the tools a chat profile offers: what a reader's own turn can call."""
    return sorted({tool.name for _, held in _offered(profiles.CHAT_PROFILES) for tool in held})


def test_every_tool_module_is_one_tool_in_the_contracts_shape():
    assert shape_problems(HARNESS / "tools") == []


def test_every_tool_is_complete_and_every_profile_offers_only_catalogue_tools():
    assert completeness_problems([module.tool() for module in CATALOGUE], _offered()) == []


def test_one_tool_name_is_one_schema_in_every_profile():
    assert options_problems(_offered()) == []


def test_the_tools_directory_and_the_catalogue_are_one_list():
    assert catalogue_problems(HARNESS / "tools", tuple(module.NAME for module in CATALOGUE)) == []


def test_the_harness_imports_no_router_and_nothing_built_on_it():
    assert import_problems(APP) == []


def test_only_a_tool_module_writes_a_tool_entry():
    assert tool_entry_problems(APP) == []


def test_no_harness_module_outgrows_its_ceiling():
    assert size_problems(HARNESS) == []


def test_no_maintenance_module_outgrows_its_ceiling():
    """The pipeline is a package so that no module becomes the next `memory.py`."""
    assert MAINTENANCE.is_dir()
    assert size_problems(MAINTENANCE) == []


def test_what_the_write_tools_stand_on_imports_no_task_and_the_package_init_is_empty():
    assert {path.stem for path in MAINTENANCE.glob("*.py")} >= BELOW_THE_HARNESS
    assert maintenance_problems(APP) == []


def test_no_stage_imports_a_router_or_another_stage_and_only_the_pipeline_orders_them():
    assert stage_problems(APP) == []


def test_every_contract_is_loaded_by_exactly_one_stage():
    assert contract_problems(APP) == []
    # Each contract that exists is some stage's: the guard is not vacuous once one is written.
    assert {path.stem for path in (MAINTENANCE / "contracts").glob("*.md")} == {"select", "maintain", "verify", "domain"}


def test_each_frontend_draws_a_row_for_every_tool_a_chat_profile_offers():
    """
    G8, core's half. The trace's wording lives in each frontend, one row per
    tool, keyed by the tool's name, and each frontend holds its list of rows
    against the tools a chat profile offers, in its own suite (the desktop's is
    `desktop/backend/tests/test_frontend_contracts.py`). A chat tool renamed or
    added on either side alone fails there.

    It is the chat profiles' tools and not the catalogue: a tool only a
    maintenance run is offered appears in no answer's trace, so it has no row
    to draw and no journey to be played in. What core holds is that the chat
    profiles are every `chat.` profile, so that list is a reader's whole turn.
    """
    assert chat_tools()
    assert {profile.name for profile in profiles.CHAT_PROFILES} == {
        profile.name for profile in profiles.PROFILES if profile.name.startswith("chat.")
    }


def test_no_chat_profile_offers_a_tool_that_writes_memory():
    """G10, and how invariant 29 is held: the two write tools are maintenance's alone."""
    tools = [module.tool() for module in CATALOGUE]
    assert write_problems(tools, _offered(profiles.CHAT_PROFILES), HARNESS / "tools", APP) == []
    writing = {tool.name for tool in tools if tool.writes}
    assert writing == {"edit_memory", "create_memory"}
    offering = {name for name, held in _offered() if any(tool.writes for tool in held)}
    assert offering == {"memory.maintain"}
    # A profile that is not a chat profile and not a maintenance one writes nothing either.
    assert not writing & set(chat_tools())


def test_the_maintenance_profiles_offer_what_they_are_meant_to():
    held = {name: [tool.name for tool in tools] for name, tools in _offered()}
    # The readers are offered only to a run about one document, and read only that document.
    assert held["memory.maintain"] == [
        "open_memory", "grep_memory", "memory_links", "read_paper", "read_webpage", "search_library",
        "edit_memory", "create_memory"]
    assert held["memory.domain"] == ["open_memory", "grep_memory", "memory_links"]


def _tree(root: Path, files: dict[str, str]) -> Path:
    for name, source in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(source)
    return root


def test_each_guard_fires_on_a_tree_that_breaks_it(tmp_path):
    """A guard that cannot fail is a comment. Each is shown a tree that breaks its rule."""
    tools = _tree(tmp_path / "g1", {
        "listed.py": 'NAME = "listed"\n',
        "unlisted.py": 'NAME = "unlisted"\n',
        "misnamed.py": 'NAME = "something_else"\n',
    })
    assert catalogue_problems(tools, ("listed", "misnamed", "missing")) == [
        "tools/unlisted.py is not in CATALOGUE",
        "CATALOGUE names 'missing', which has no module",
        "tools/misnamed.py must define NAME = 'misnamed', found ['something_else']",
    ]

    app_dir = _tree(tmp_path / "g3", {
        "routers/chat.py": "from ..harness.loop import run_turn\n",
        "filing.py": "from .harness import profiles\n",
        "harness/__init__.py": "",
        "harness/profiles.py": "",
        "harness/registry.py": "",
        "harness/loop.py": "from ..routers.chat import something\nfrom ..filing import other\n",
        "harness/tools/__init__.py": "",
        "harness/tools/one.py": "from .two import helper\nfrom ..registry import CATALOGUE\n",
        "harness/tools/two.py": "from ..tool import Tool\n",
    })
    assert import_problems(app_dir) == [
        "harness/loop.py imports delphi_core.filing, which is built on the harness",
        "harness/loop.py imports a router: delphi_core.routers.chat",
        "harness/tools/one.py imports delphi_core.harness.registry; a tool knows nothing of who offers it",
        "harness/tools/one.py imports another tool: delphi_core.harness.tools.two",
    ]

    app_dir = _tree(tmp_path / "g4", {
        "harness/tools/fine.py": 'SPEC = {"type": "function", "name": "fine"}\n',
        "routers/chat.py": 'tools = [{"type": "web_search"}]\n',
        "filing.py": 'def spec():\n    return {"type": "function", "name": "sneaky", "parameters": {}}\n',
        "schema.py": 'FORMAT = {"type": "json_schema", "name": "not_a_tool"}\n',
    })
    assert tool_entry_problems(app_dir) == [
        "filing.py:2 builds a tool entry outside harness/tools/",
        "routers/chat.py:1 builds a tool entry outside harness/tools/",
    ]

    long_module = '"""Docstrings are free."""\n# So are comments.\n\n' + "x = 1\n" * (HARNESS_MODULE_MAX + 1)
    harness = _tree(tmp_path / "g5", {
        "loop.py": long_module,
        "ok.py": '"""' + "explanation\n" * 400 + '"""\n' + "x = 1\n" * HARNESS_MODULE_MAX,
        "tools/big.py": "y = 2\n" * (TOOL_MODULE_MAX + 1),
    })
    assert size_problems(harness) == [
        f"loop.py has {HARNESS_MODULE_MAX + 1} code lines; the ceiling is {HARNESS_MODULE_MAX}",
        f"tools/big.py has {TOOL_MODULE_MAX + 1} code lines; the ceiling is {TOOL_MODULE_MAX}",
    ]


def test_the_maintenance_guards_fire_on_a_tree_that_breaks_them(tmp_path):
    app_dir = _tree(tmp_path / "g9", {
        "memory_maintenance/__init__.py": "from .pipeline import run\n",
        "memory_maintenance/blocks.py": "import re\n",
        "memory_maintenance/ops.py": "from .blocks import split_blocks\nfrom ..harness.loop import run_turn\nfrom . import maintain\n",
        "memory_maintenance/validate.py": "from ..storage.base import memory_slug\nfrom ..memory import MARKER\nfrom delphi_core.routers import memory\nfrom .verify import blocking\n",
        # A stage is built on the harness, and that is what a stage is for.
        "memory_maintenance/maintain.py": "from ..harness.loop import run_turn\nfrom ..memory import MemoryCitation\n",
    })
    assert maintenance_problems(app_dir) == [
        "memory_maintenance/__init__.py must exist and be empty",
        "memory_maintenance/ops.py imports the harness, which is built on this module: delphi_core.harness.loop",
        "memory_maintenance/ops.py imports a stage of its own pipeline: delphi_core.memory_maintenance.maintain",
        "memory_maintenance/validate.py imports memory.py, which is built on the harness: delphi_core.memory",
        "memory_maintenance/validate.py imports a stage of its own pipeline: delphi_core.memory_maintenance.verify",
        "memory_maintenance/validate.py imports a router: delphi_core.routers",
    ]
    (app_dir / "memory_maintenance" / "__init__.py").unlink()
    assert maintenance_problems(app_dir)[0] == "memory_maintenance/__init__.py must exist and be empty"

    fine = _tree(tmp_path / "g9-fine", {
        "memory_maintenance/__init__.py": "\n",
        "memory_maintenance/ops.py": "from .blocks import split_blocks\nfrom ..storage.base import memory_slug\n",
        # A module named like a forbidden one is not that module.
        "memory_maintenance/validate.py": "from ..memory_graph import walk\nfrom ..harness_notes import x\n",
    })
    assert maintenance_problems(fine) == []

    # The size ceiling is `size_problems`, the harness's own, pointed at this package.
    package = _tree(tmp_path / "g9-size", {
        "__init__.py": "",
        "ops.py": '"""Docstrings are free."""\n' + "x = 1\n" * (HARNESS_MODULE_MAX + 1),
        "validate.py": "x = 1\n" * HARNESS_MODULE_MAX,
    })
    assert size_problems(package) == [
        f"ops.py has {HARNESS_MODULE_MAX + 1} code lines; the ceiling is {HARNESS_MODULE_MAX}",
    ]


def test_the_stage_guard_fires_on_a_tree_that_breaks_it(tmp_path):
    app_dir = _tree(tmp_path / "g11", {
        "memory_maintenance/__init__.py": "",
        "memory_maintenance/ops.py": "from ..harness.loop import run_turn\n",
        "memory_maintenance/run.py": "from .staging import MemoryDraft\nfrom .verify import is_blocking\nfrom ..harness.provider import Usage\n",
        "memory_maintenance/jobs.py": "import hashlib\nfrom delphi_core.routers import memory\n",
        "memory_maintenance/event.py": "from .run import Verdicts\nfrom .jobs import SESSION\nfrom . import commit\n",
        "memory_maintenance/gather.py": "from ..harness.evidence import load_sections\nfrom .run import EvidenceSet\nfrom .jobs import DOCUMENT\n",
        "memory_maintenance/select.py": "from ..routers.chat import index_arguments\nfrom ..memory_harness import memory_index\n",
        "memory_maintenance/maintain.py": "from ..harness.loop import run_turn\nfrom .select import same_idea\nfrom .maintain_prompt import CONTRACT\n",
        "memory_maintenance/maintain_prompt.py": "from ..harness.prompts import UNTRUSTED_TEXT_RULE\nfrom .verify_text import shown\n",
        "memory_maintenance/verify.py": "from ..memory import MEMORY_VERSION\nfrom .validate import repair_links\nfrom .verify_text import shown\n",
        "memory_maintenance/verify_text.py": "from . import verify\nfrom .blocks import split_blocks\n",
        "memory_maintenance/commit.py": "from .event import build_event\nfrom .pipeline import run_job\n",
        "memory_maintenance/pipeline.py": "from . import gather, select\nfrom .maintain import author\nfrom .verify import verify\nfrom .commit import commit\n",
        "memory_maintenance/helpers.py": "from .commit import commit\n",
        "memory_maintenance/agent.py": "from ..harness.loop import run_turn\nfrom .maintain import author\nfrom ..routers import chat\n",
    })
    assert stage_problems(app_dir) == [
        "memory_maintenance/agent.py is shared by the stages and imports one: delphi_core.memory_maintenance.maintain",
        "memory_maintenance/agent.py imports a router: delphi_core.routers",
        "memory_maintenance/commit.py imports another stage; only pipeline does: delphi_core.memory_maintenance.pipeline",
        "memory_maintenance/event.py is shared by the stages and imports one: delphi_core.memory_maintenance.commit",
        "memory_maintenance/helpers.py is not a stage, a part of one (`<stage>_<part>.py`) or a module the stages "
        "share; say which it is in this file",
        "memory_maintenance/jobs.py imports a router: delphi_core.routers",
        "memory_maintenance/maintain.py imports another stage; only pipeline does: delphi_core.memory_maintenance.select",
        "memory_maintenance/maintain_prompt.py imports another stage; only pipeline does: delphi_core.memory_maintenance.verify_text",
        "memory_maintenance/run.py is shared by the stages and imports the harness: delphi_core.harness.provider",
        "memory_maintenance/run.py is shared by the stages and imports one: delphi_core.memory_maintenance.verify",
        "memory_maintenance/select.py imports a router: delphi_core.routers.chat",
    ]

    # The stages as they are meant to be, with some not written yet.
    fine = _tree(tmp_path / "g11-fine", {
        "memory_maintenance/__init__.py": "",
        "memory_maintenance/run.py": "from .staging import MemoryDraft\n",
        "memory_maintenance/event.py": "from .run import Verdicts\nfrom .staging import StagedPage\n",
        "memory_maintenance/verify.py": "from ..harness.provider import ResponsesClient\nfrom .run import Verdicts\nfrom .blocks import split_blocks\n",
        "memory_maintenance/commit.py": "from ..memory import MEMORY_VERSION\nfrom .event import build_event\nfrom .validate import repair_links\n",
        # A module named like a router or a stage is neither.
        "memory_maintenance/gather.py": "from ..routers_notes import x\nfrom ..selection import y\n",
        "memory_maintenance/pipeline.py": "from . import commit, gather, verify\n",
    })
    assert stage_problems(fine) == []

    # What the write tools stand on stays below all of it (G9), whatever else is in the package.
    below = _tree(tmp_path / "g11-below", {
        "memory_maintenance/__init__.py": "",
        "memory_maintenance/staging.py": "from .run import Verdicts\nfrom .commit import commit\n",
    })
    assert maintenance_problems(below) == [
        "memory_maintenance/staging.py imports a stage of its own pipeline: delphi_core.memory_maintenance.commit",
        "memory_maintenance/staging.py imports a module the write tools do not stand on: delphi_core.memory_maintenance.run",
    ]


def test_the_contract_guard_fires_on_a_tree_that_breaks_it(tmp_path):
    app_dir = _tree(tmp_path / "g12", {
        "memory_maintenance/__init__.py": "",
        "memory_maintenance/contracts/verify.md": "# Checking\n",
        "memory_maintenance/contracts/select.md": "# Choosing\n",
        "memory_maintenance/contracts/domain.md": "# Composing\n",
        "memory_maintenance/contracts/orphan.md": "# Nobody reads this\n",
        "memory_maintenance/verify.py": 'from pathlib import Path\nCONTRACT = (Path(__file__).parent / "contracts" / "verify.md").read_text()\n',
        "memory_maintenance/select.py": 'from importlib import resources\nTEXT = resources.files(__package__).joinpath("contracts/select.md").read_text()\n',
        "memory_maintenance/maintain.py": '"""Its prompt is contracts/maintain.md, which says what to write."""\nTEXT = open("contracts/maintain.md").read()\nOLD = "SKILL.md"\n',
        "memory_maintenance/maintain_prompt.py": 'OTHER = "select.md"\n',
        "memory_maintenance/event.py": 'TEXT = "domain.md"\n',
    })
    assert contract_problems(app_dir) == [
        "memory_maintenance/maintain.py loads contracts/maintain.md, which does not exist",
        "contracts/domain.md is loaded by memory_maintenance/event.py, which is not a stage",
        "contracts/domain.md is loaded by no stage",
        "contracts/orphan.md is loaded by no stage",
        "contracts/select.md is loaded by maintain_prompt, select; a stage owns its contract alone",
    ]

    fine = _tree(tmp_path / "g12-fine", {
        "memory_maintenance/__init__.py": "",
        "memory_maintenance/contracts/verify.md": "# Checking\n",
        # Naming a contract in a sentence is not loading it.
        "memory_maintenance/commit.py": '"""The checker is told what `contracts/verify.md` says."""\nWHY = "see contracts/verify.md for the rule"\n',
        "memory_maintenance/verify.py": 'CONTRACT = open("contracts/verify.md").read()\n',
    })
    assert contract_problems(fine) == []
    # A package with no contracts yet has nothing to load.
    assert contract_problems(_tree(tmp_path / "g12-none", {"memory_maintenance/__init__.py": ""})) == []


def test_the_shape_completeness_and_options_guards_fire(tmp_path):
    tools = _tree(tmp_path / "g2", {
        "fine.py": 'NAME = "fine"\nclass Arguments: ...\n_PRIVATE = 1\ndef tool():\n    return Tool(name=NAME)\nasync def _run(args, ctx): ...\n',
        "leaky.py": 'NAME = "leaky"\nSPEC = 1\ndef helper(): ...\ndef tool():\n    return Tool(name=NAME)\n',
        "two.py": 'NAME = "two"\ndef tool():\n    return Tool(name=NAME) or Tool(name="other")\n',
        "handmade.py": 'NAME = "handmade"\ndef tool():\n    return Tool(name=NAME, spec={"type": "function", "parameters": {"type": "object"}})\n',
        "nameless.py": 'def tool():\n    return Tool(name="nameless")\n',
    })
    assert shape_problems(tools) == [
        "tools/handmade.py:3 writes a schema by hand; it is generated from Arguments",
        "tools/leaky.py makes 'SPEC' public; a tool module offers only ['Arguments', 'NAME', 'Options', 'tool']",
        "tools/leaky.py makes 'helper' public; a tool module offers only ['Arguments', 'NAME', 'Options', 'tool']",
        "tools/nameless.py does not define NAME",
        "tools/two.py builds 2 tools; a module is exactly one",
    ]

    class Asks(ToolArguments):
        query: str

    class AsksMore(ToolArguments):
        query: str
        scope: str

    async def run(args, ctx): ...

    def made(name: str, **changed) -> Tool:
        return Tool(**{
            "name": name, "budget": BudgetClass.DOCUMENT, "label": "Working", "guidance": "Use it.",
            "trace": TraceProjection(), "arguments": Asks, "description": "A tool.", "run": run, **changed,
        })

    good = made("good")
    assert completeness_problems([good], [("p", [good])]) == []
    silent, wordy, hosted = made("silent", guidance=" "), made("wordy", guidance="x" * 601), made("hosted", run=None, arguments=None)
    undescribed, unoffered, stray = made("undescribed", description=""), made("unoffered"), made("stray")
    assert completeness_problems(
        [silent, wordy, hosted, undescribed, unoffered],
        [("p", [silent, wordy, hosted, undescribed, stray])],
    ) == [
        "silent has no guidance line",
        "wordy's guidance is 601 characters; the ceiling is 600",
        "hosted is hosted and does not say what it is or how its calls arrive",
        "undescribed has no Arguments or no description",
        "unoffered is in the catalogue and no profile offers it",
        "profile p offers stray, which is not in the catalogue",
    ]

    # Wording may differ between profiles; the arguments may not.
    reworded = made("good", description="Said another way.", guidance="Another line.")
    assert options_problems([("a", [good]), ("b", [reworded])]) == []
    assert options_problems([("a", [good]), ("b", [made("good", arguments=AsksMore)])]) == [
        "good takes different arguments in a and b; one name is one schema"
    ]


def test_the_write_guard_fires(tmp_path):
    async def run(args, ctx): ...

    class Asks(ToolArguments):
        slug: str

    def made(name: str, **changed) -> Tool:
        return Tool(**{
            "name": name, "budget": BudgetClass.MEMORY, "label": "Working", "guidance": "Use it.",
            "trace": TraceProjection(), "arguments": Asks, "description": "A tool.", "run": run, **changed,
        })

    reads = made("reads")
    writes = made("writes", budget=BudgetClass.WRITE, writes=True)
    unmarked = made("unmarked", budget=BudgetClass.WRITE)
    uncharged = made("uncharged", writes=True)
    app_dir = _tree(tmp_path / "g10", {
        "harness/tools/__init__.py": "",
        "harness/tools/reads.py": "from ...memory_maintenance.staging import ShownPage\nasync def _run(args, ctx):\n    ctx.draft.show(1)\n    ctx.storage.get_memory_page(1)\n",
        "harness/tools/writes.py": "from ...memory_maintenance.admit import stage_edit\nasync def _run(args, ctx):\n    ctx.storage.upsert_memory_page(1)\n",
        "harness/tools/stages.py": "from ...memory_maintenance.admit import stage_edit\n",
        "harness/tools/stores.py": "async def _run(args, ctx):\n    ctx.storage.upsert_memory_page(1)\n",
    })
    tools_dir = app_dir / "harness" / "tools"
    assert write_problems([reads, writes], [("chat.a", [reads])], tmp_path / "none", app_dir) == []
    assert write_problems(
        [reads, writes, unmarked, uncharged],
        [("chat.a", [reads, writes]), ("chat.b", [uncharged])],
        tools_dir,
        app_dir,
    ) == [
        "chat profile chat.a offers writes, which writes Memory",
        "chat profile chat.b offers uncharged, which writes Memory",
        "unmarked is charged as a write and is not marked `writes`",
        "uncharged is marked as writing and is not charged as a write",
        "tools/stages.py imports the staging path and its tool is not marked `writes`",
        "tools/stores.py:2 calls upsert_memory_page, and its tool is not marked `writes`",
    ]
