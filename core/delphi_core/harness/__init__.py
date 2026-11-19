"""
The model harness: one provider client, one tool registry, one loop.

Every model call in the backend goes through `provider.ResponsesClient`, and
every call that offers the model a tool gets its `tools` from a `Toolset` built
by a named profile (`profiles`). A tool is one module under `tools/`; the loop
that serves its calls (`loop.run_turn`) knows no tool by name and no task by
name, so chat, a digest's research pass and Memory maintenance run on the same
code and differ only in the profile they name.

    provider.py   the Responses client and the one SSE parser
    replay.py     what a stateless next round is handed back
    tool.py       the types a tool is written against
    tools/        one module per tool, and nothing else
    registry.py   the catalogue, a request's toolset, and dispatch
    profiles.py   which tools each task offers, and when
    budget.py     what one turn may spend
    loop.py       the agentic loop
    prompts.py    instruction assembly and the prompt blocks tasks share

The layout is a rule, not a habit: `tests/test_harness_structure.py` fails when
a tool is defined outside `tools/`, when a module here imports a router or a
task, or when a file outgrows its ceiling.
"""
