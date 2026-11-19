/**
 * Markdown in and out of the note editor.
 *
 * A note is stored as markdown, not as HTML and not as the editor's own
 * document format. Two reasons, and both are about somewhere else in the
 * system: Memory is shown the note's text as reader-authored
 * evidence, and markdown is what every other body of text in Delphi already is;
 * and an editor library is an implementation detail the stored record should be
 * able to outlive.
 *
 * The bridge goes through ProseMirror's JSON rather than through HTML. Parsing
 * HTML back into a document means owning a sanitiser, and the round trip
 * markdown → HTML → markdown loses exactly the details (which emphasis
 * character, how a list was indented) that make a diff of the stored body
 * readable. The node vocabulary here is deliberately the toolbar's and nothing
 * more: anything richer that arrives by paste degrades to its text.
 *
 * Kept JSX-free and dependency-free so `node --test` can strip the types and
 * run it directly — the editor component is a shell around this.
 */

export type Mark = { type: string; attrs?: Record<string, unknown> };
export type Node = {
  type: string;
  text?: string;
  marks?: Mark[];
  attrs?: Record<string, unknown>;
  content?: Node[];
};

/** Characters that would otherwise be read back as syntax. */
const escapeText = (value: string) => value.replace(/([\\`*_[\]])/g, "\\$1");

const unescapeText = (value: string) => value.replace(/\\([\\`*_[\]])/g, "$1");

/**
 * Outermost first. `code` is last because a backtick span is literal by
 * definition — emphasis inside one is shown rather than applied — and `link`
 * is first because its label is allowed to carry every other mark.
 */
const MARK_NESTING = ["link", "bold", "italic", "strike", "code"] as const;

const MARK_WRAPPERS: Record<string, [string, string]> = {
  bold: ["**", "**"],
  italic: ["_", "_"],
  strike: ["~~", "~~"],
  code: ["`", "`"],
};

/** Two marks are the same wrapper only if their attributes agree too. */
const markKey = (mark: Mark) =>
  mark.type === "link" ? `link:${String(mark.attrs?.href ?? "")}` : mark.type;

const outerness = (mark: Mark) => {
  const index = MARK_NESTING.indexOf(mark.type as (typeof MARK_NESTING)[number]);
  return index < 0 ? MARK_NESTING.length : index;
};

/**
 * A mark spans a *run* of text nodes, not one node.
 *
 * ProseMirror stores "**bold with _italic_ inside**" as three adjacent text
 * nodes, two of them carrying `bold` and the middle one carrying both. Wrapping
 * each node on its own produced `**bold with **_**italic**_** inside**` — valid
 * markdown that renders correctly and is unreadable as a stored record. So the
 * longest run sharing the outermost unopened mark is wrapped once, and the
 * inside is rendered again with that mark treated as already open.
 */
function inlineToMarkdown(nodes: Node[] | undefined, open: Set<string> = new Set()): string {
  if (!nodes?.length) return "";
  let out = "";
  let index = 0;

  while (index < nodes.length) {
    const node = nodes[index];
    if (node.type === "hardBreak") {
      // Two trailing spaces is the only line break markdown keeps inside a
      // paragraph, and a note is where someone writes two short lines.
      out += "  \n";
      index += 1;
      continue;
    }
    if (node.type !== "text" || !node.text) {
      index += 1;
      continue;
    }

    const marks = node.marks ?? [];
    const pending = marks.filter((mark) => !open.has(markKey(mark)));
    if (!pending.length) {
      // Inside a backtick span the escapes would be shown, not consumed.
      out += open.has("code") || marks.some((mark) => mark.type === "code")
        ? node.text
        : escapeText(node.text);
      index += 1;
      continue;
    }

    const chosen = pending.reduce((a, b) => (outerness(b) < outerness(a) ? b : a));
    const key = markKey(chosen);
    let end = index;
    while (
      end < nodes.length &&
      nodes[end].type === "text" &&
      (nodes[end].marks ?? []).some((mark) => markKey(mark) === key)
    ) {
      end += 1;
    }

    const inner = inlineToMarkdown(nodes.slice(index, end), new Set([...open, key]));
    if (chosen.type === "link") {
      out += `[${inner}](${String(chosen.attrs?.href ?? "")})`;
    } else {
      const [prefix, suffix] = MARK_WRAPPERS[chosen.type] ?? ["", ""];
      out += `${prefix}${inner}${suffix}`;
    }
    index = end;
  }
  return out;
}

function blockToMarkdown(node: Node, depth: number): string[] {
  const indent = "  ".repeat(depth);
  switch (node.type) {
    case "bulletList":
    case "orderedList": {
      const ordered = node.type === "orderedList";
      return (node.content ?? []).flatMap((item, index) => {
        const bullet = ordered ? `${index + 1}. ` : "- ";
        const lines = (item.content ?? []).flatMap((child) =>
          blockToMarkdown(child, depth + 1),
        );
        const [first = "", ...rest] = lines;
        // The marker replaces the child's own indent; continuation lines keep it.
        return [`${indent}${bullet}${first.trim()}`, ...rest];
      });
    }
    case "blockquote":
      return (node.content ?? [])
        .flatMap((child) => blockToMarkdown(child, depth))
        .map((line) => `> ${line}`);
    case "codeBlock":
      return ["```", inlineToMarkdown(node.content).replace(/\\(.)/g, "$1"), "```"];
    case "heading": {
      const level = Number(node.attrs?.level ?? 1);
      return [`${"#".repeat(Math.min(6, Math.max(1, level)))} ${inlineToMarkdown(node.content)}`];
    }
    default:
      return [`${indent}${inlineToMarkdown(node.content)}`];
  }
}

/** A ProseMirror document to the markdown that gets stored. */
export function docToMarkdown(doc: Node | null | undefined): string {
  if (!doc?.content?.length) return "";
  const blocks: string[] = [];
  for (const node of doc.content) {
    const lines = blockToMarkdown(node, 0);
    // Lists are one block; paragraphs are separated by a blank line.
    blocks.push(lines.join("\n"));
  }
  return blocks
    .map((block) => block.replace(/[ \t]+$/gm, (match) => (match === "  " ? match : "")))
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const INLINE_PATTERN =
  /(`[^`]+`)|(\[(?:[^\]\\]|\\.)*\]\([^)\s]*\))|(\*\*(?:[^*\\]|\\.)+?\*\*)|(~~(?:[^~\\]|\\.)+?~~)|((?:\*|_)(?:[^*_\\]|\\.)+?(?:\*|_))/;

function inlineFromMarkdown(source: string): Node[] {
  const nodes: Node[] = [];
  let rest = source;

  const push = (text: string, marks?: Mark[]) => {
    if (!text) return;
    nodes.push(marks?.length ? { type: "text", text, marks } : { type: "text", text });
  };

  while (rest) {
    const match = INLINE_PATTERN.exec(rest);
    if (!match || match.index === undefined) {
      push(unescapeText(rest));
      break;
    }
    push(unescapeText(rest.slice(0, match.index)));
    const token = match[0];
    if (token.startsWith("`")) {
      push(token.slice(1, -1), [{ type: "code" }]);
    } else if (token.startsWith("[")) {
      const split = token.lastIndexOf("](");
      const label = token.slice(1, split);
      const href = token.slice(split + 2, -1);
      const inner = inlineFromMarkdown(label);
      const link: Mark = { type: "link", attrs: { href } };
      for (const node of inner) node.marks = [...(node.marks ?? []), link];
      nodes.push(...inner);
    } else if (token.startsWith("**")) {
      applyMark(nodes, token.slice(2, -2), "bold");
    } else if (token.startsWith("~~")) {
      applyMark(nodes, token.slice(2, -2), "strike");
    } else {
      applyMark(nodes, token.slice(1, -1), "italic");
    }
    rest = rest.slice(match.index + token.length);
  }
  return nodes;
}

function applyMark(nodes: Node[], inner: string, type: string) {
  const parsed = inlineFromMarkdown(inner);
  for (const node of parsed) node.marks = [...(node.marks ?? []), { type }];
  nodes.push(...parsed);
}

const paragraph = (line: string): Node => ({
  type: "paragraph",
  content: inlineFromMarkdown(line),
});

/** Stored markdown back into a document the editor can mount. */
export function markdownToDoc(markdown: string): Node {
  const lines = (markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  const content: Node[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ordered = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (bullet || ordered) {
      const wanted = bullet ? /^\s*[-*+]\s+(.*)$/ : /^\s*\d+\.\s+(.*)$/;
      const items: Node[] = [];
      while (index < lines.length) {
        const entry = wanted.exec(lines[index]);
        if (!entry) break;
        items.push({ type: "listItem", content: [paragraph(entry[1])] });
        index += 1;
      }
      content.push({ type: bullet ? "bulletList" : "orderedList", content: items });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      content.push({
        type: "heading",
        attrs: { level: heading[1].length },
        content: inlineFromMarkdown(heading[2]),
      });
      index += 1;
      continue;
    }

    if (line.startsWith("```")) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith("```")) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1;
      content.push({
        type: "codeBlock",
        content: body.length ? [{ type: "text", text: body.join("\n") }] : undefined,
      });
      continue;
    }

    // A run of plain lines is one paragraph; a trailing double space inside it
    // is the hard break it was written as.
    const run: string[] = [];
    while (index < lines.length && lines[index].trim() && !/^(\s*[-*+]\s|\s*\d+\.\s|#{1,6}\s|```)/.test(lines[index])) {
      run.push(lines[index]);
      index += 1;
    }
    const parts: Node[] = [];
    run.forEach((entry, position) => {
      parts.push(...inlineFromMarkdown(entry.replace(/\s+$/, "")));
      if (position < run.length - 1) parts.push({ type: "hardBreak" });
    });
    content.push({ type: "paragraph", content: parts });
  }

  return { type: "doc", content: content.length ? content : [{ type: "paragraph" }] };
}

/**
 * The one-line form shown on a collapsed note, with the syntax taken back out.
 * Not a markdown renderer — a label.
 */
export function noteSummary(markdown: string, limit = 90): string {
  const flat = (markdown ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^[>#\s]*[-*+]?\s*/gm, "")
    .replace(/\[((?:[^\]\\]|\\.)*)\]\([^)\s]*\)/g, "$1")
    .replace(/[*_~`]/g, "")
    .replace(/\\(.)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1).trimEnd()}…` : flat;
}
