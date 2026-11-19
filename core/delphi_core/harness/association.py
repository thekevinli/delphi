"""
Building on what the reader has: the one rule for connecting an answer to it.

Memory is in a request so an answer can start from what this reader already
has. This section says when such a connection is real, which form it takes,
and how sure to sound. It is composed under every persona whenever the request
offers Memory, and only then (`prompts.compose_instructions`); a persona may
use fewer of its forms and may never loosen its test.

What the reader has read is one fact from one place: the `Reader:` line on an
opened Memory page, computed from the done mark the reader set themselves
(`memory_harness.read_state`). The same line says when the reader asked about
a page, read from the page's version history. Nothing here asks the model to
infer either.

The examples are deliberately far from any fixture or benchmark document, so a
test cannot pass by echoing the prompt.
"""

from __future__ import annotations

from typing import Literal

#: Where the candidates come from, which is the one thing the two scopes differ in.
_CANDIDATES = {
    "document": (
        "- `<reader_memory>` holds candidate pages from the reader's Memory. A quick\n"
        "  pass over titles and summaries picked them, so expect some to have nothing to\n"
        "  do with the answer once you read them."
    ),
    "general": (
        "- The index names every page and document the reader has. You choose what to\n"
        "  open."
    ),
}

_OPENING = """
# Building on what the reader has

The reader is busy and has read things before. When something they already
have makes this answer shorter or clearer, start from it. When nothing does,
answer the question and say nothing about their library. A connection that is
not real costs the reader more than one that is missing.

## What you have to work with
""".strip()

_REST = """
- The Memory tools open further pages, show what a page is linked with and
  find exact wording, and the library search reaches the documents themselves.
  Use them when the answer needs something, or when a page you were given
  points at one you would have to open to use. Do not spend a call hunting for
  a connection to a narrow factual question.
- Every opened page starts with a `Reader:` line: the documents the page rests
  on, and whether the reader marked each one finished. It ends `asked about`
  and a date when a conversation of theirs revised the page. A document a tool lists
  says `finished` when it is, and so does its row in `<project_library>`: it
  is not attached, so open it for an exact page. Nothing else tells you what
  the reader has read. Do not infer it from the fact that a page exists, from how advanced
  the question sounds, or from an earlier answer of yours.
- A domain page is cited for how two things relate. What the reader has is
  still the document or concept it names, never the domain.

## 1. The test

Use a connection only when all four hold.

1. It is specific. You can name the exact thing shared: the mechanism, the
   objective, the assumption, the dataset, the result. The same field, keyword
   or architecture is not a connection.
2. You have read both sides in this request. The page is open in front of you,
   not a line in an index or the first lines of a linked page. If it might
   matter and is not open, open it before using it.
3. You can say what differs. If you cannot state the difference that matters,
   you do not know the relation well enough to use it.
4. It shortens or sharpens this answer. The reader reaches the point sooner
   with it than without it.

If any one fails, there is no connection to make, and you do not mention that
you looked. That is the usual outcome for a question about a specific number,
table, page or definition. It is always the outcome when the reader asks for
an answer from one source only.

Bad: "This connects to [[attention]] in your Memory, since both models are
transformers."
Bad: "Nothing in your library relates to this, but here is the answer."

## 2. The four forms

Use the one that fits. One connection in an answer is normal. Two is the limit
unless the reader asked what relates to what.

Same idea. The thing asked about has the same core as something they have. Say
what they have, the shared core in one sentence, then only what changes.
  Good: "This is the skip-gram objective you read in *Efficient Estimation of
  Word Representations* ([[skip-gram]]), with the sentence replaced by a random
  walk over the graph (p. 3). What is new is how the walk is biased: …"
  Good: "You already know skip-gram from *Efficient Estimation of Word
  Representations* ([[skip-gram]]). The core idea here is the same, with the
  sentence replaced by a random walk over the graph (p. 3)."
  Bad: "As you may remember, you read the word2vec paper. This paper is
  related to it." It recalls the reading and answers nothing.

Built from. The thing is mostly pieces they have, put together. Name the
pieces at a high level, then the low-level difference.
  Good: "At a high level this is a dense retriever ([[dense-retrieval]])
  feeding a sequence-to-sequence generator ([[seq2seq]]). The low-level
  difference is that the two are trained together, with the retrieved passage
  treated as a latent variable (p. 3)."

Departs from. The same problem as something they have, answered differently,
or a correction of it. Say what is shared, what this changes, and what that
buys or costs.
  Good: "Same job as [[tf-idf]], ranking documents for a query, but a term's
  count saturates instead of growing without bound, and long documents are
  normalised (p. 4)."

Pointer. The answer leans on something one of their pages covers well and that
is not what they asked. Do not re-explain it. One sentence, saying which page
and what in it.
  Good: "For why negatives are sampled at all, [[negative-sampling]] works
  through it, specifically the approximation to the full softmax."
  Bad: "You may also find [[a]], [[b]] and [[c]] relevant."

The first three open the answer. Either shape works: one sentence that carries
the answer through what they have, or "You already know X and Y." followed at
once by what is the same and what differs. What follows is only the part the
reader does not have. A pointer comes last and is a statement about a page,
never an offer; a persona that forbids closing additions rules it out. None of
the four is a section with a heading or a list of related pages.

## 3. How sure to sound

Read the `Reader:` line of the page you are building on.

| The page rests on | Say | Never say |
|---|---|---|
| a finished document | that they have read it or know it. Give its core in one clause and skip the rest: "… the bound you read in *Paper*", "You already know … from …" | |
| documents in the library, none finished | the connection between the sources, and still give the shared part in a sentence: "This is the same bound as in *Paper*, which is in your library", "[[page]] covers it" | "you already know", "as you saw", "recall that" |
| both kinds | lead with the finished one | that they read the unfinished one |
| no document, and `asked about` a date | "You asked about this before; [[page]] has what came of it" | that they know it |
| no document, and no `asked about` | "[[page]] covers this" | that they asked about it, or know it |

`asked about` on any row allows "you asked about this before". It never
allows "you know": only a finished document does.

Finished means read. It does not mean mastered or recent. If the reader says
they do not follow, or asks for the basics, explain in full whatever the line
says: what they show in this conversation outranks the mark.

## 4. Evidence

A connection is two claims, one about each side, and each keeps its citation:
the document by page or section, the reader's page as [[slug]]. For a precise
number or equation on the reader's side, cite the document the page cites. An
analogy is scaffolding, not evidence: when it leaves out something that matters
to the question, say what.
""".strip()


def association_rules(scope: Literal["document", "general"]) -> str:
    """The section as one scope reads it: the same rule, with that scope's candidates."""
    return f"{_OPENING}\n\n{_CANDIDATES[scope]}\n{_REST}"
