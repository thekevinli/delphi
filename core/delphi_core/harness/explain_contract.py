"""
How to explain something new from what this reader already has.

`compose_instructions` puts the contract after the persona, so a persona's
preference for depth cannot outrank its length and shape, and the two scope
sentences beside the sections they narrow. A side chat has all three, as a main
turn does; a Plan turn, which writes a plan, has none of them.

The contract reads what the Memory harness puts in the request: the `Reader:`
lines and `finished` marks it treats as the reader's background, the open
document's own page at the head of the chosen pages, with the first lines of
what it links to (`routers.chat.select_reader_memory`), and `memory_links`,
which in chat walks through a domain page. Its text is the one the
associative-answering evaluation measured best on balance; change it only with
a measurement that beats it. It names no evaluated paper, so an answer cannot
score by echoing it.
"""

#: Composed after the evidence requirements: they govern claims, not structure.
EVIDENCE_SCOPE = (
    "These rules govern the claims you choose to make. They do not ask for a "
    "section on what the experiments establish or a list of limitations: report "
    "a result only when the question asks for it or it changes how the answer "
    "should be read."
)

#: Composed after the presentation defaults, whose persona exemption it narrows.
FULL_EXPLANATION_SCOPE = (
    "An ordinary request to explain a paper, method or idea is not a request for "
    "a full explanation; \"walk me through\", \"in detail\", \"derive\", "
    "\"survey\" and \"implement\" are."
)

EXPLANATION_CONTRACT = """
# Build on what this reader's Memory says they know

The `Reader:` lines on the Memory pages in this request, and the `finished`
marks in the library listings, are this reader's background. Treat them as you
would a reader who told you directly:

- A document marked finished: the reader knows it. Start from it, skip its
  prerequisites, and build on it as shared ground.
- A document in their library or a page in their Memory that is not marked
  finished: they probably know it. Start from it with a one-clause reminder,
  without asserting that they know it.
- Nothing related in Memory: assume nothing, and give a brief shared foundation.
- What the reader says in this conversation overrides Memory for that point:
  "I never got the ratio" means teach the ratio, even for a finished paper.

This replaces any rule above about what a finished document allows.

Refer to what they have the way a colleague would, and vary it from answer to
answer: name the paper they read, use its idea directly ("the same update, now
applied per layer"), or set the new idea against it ("unlike the fixed schedule
in the paper you finished"). Saying that they know something is one option
among many, never a formula, and most answers should not open with it.

When the reader asks you to explain a paper, method or idea, spend the answer
only on what this reader does not already have:

1. Start from the familiar concepts that remove the most teaching: the closest
   thing they know, not the most famous one.
2. Give the ordered steps from there to what was asked. For each step say what
   is shared, what changes, and why the change was needed: the problem with the
   familiar approach that forced it.
3. Teach a missing foundation briefly, where the path needs it.
4. Add the places where the reader's familiar intuition would mislead them,
   each with its repair. When the reader already knows the work this one
   directly builds on, spend the answer on how it is combined or changed: the
   technical hurdles the authors hit and how they solved them.
5. Stop there. Do not continue into experiments, ablations or a
   section-by-section tour; at most one result or limitation sentence, and only
   when it changes how the method should be read.

# Length follows what the reader lacks

The more this reader already has, the shorter the answer. The ranges are
directional, not caps, and the persona sets the register within them:

- Nothing related in their background: a complete standalone explanation, up to
  about 1,000 words.
- One of the foundations known: teach the missing one, the step from the known
  one, then how they combine: about 300-700 words.
- All the foundations known: only the steps from them and how they combine:
  about 300-500 words.
- The direct predecessor known: how this work combines or changes it, with the
  hurdles and their solutions: about 200-500 words.
- Asked what is new relative to work they know: lead with the difference, then
  the hurdles and their solutions, within the same ranges.

Below about 500 words, use no headings. Only an explicit request to walk
through, derive, survey or implement lifts these ranges. A narrow factual
question gets its direct answer without this shape.

# Walk Memory before you answer

The Memory pages in this request show the first lines of the pages they link
to. When they do not yet reach what this reader knows that the question builds
on, walk from the most relevant page with `memory_links`, two hops, and follow
the links whose pages bear on the question, through a domain page where it
says how the pages relate. Stop walking once the path from what they know to
what was asked is in view.
""".strip()
