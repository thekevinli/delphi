/**
 * Model-written TeX delimiters, read in the one Markdown parse.
 *
 * remark-math reads `$…$`. Models also write `$$…$$`, `\(…\)`, `\[…\]` and
 * bare `\begin{env}…\end{env}`, and this gives those the grammar dollars
 * already have. There are two rules, one per place Markdown can hold math:
 *
 *   text  An opener inside a paragraph is math through its closer. As with
 *         `$`, the leftmost opener wins and the span cannot leave its
 *         paragraph; an opener whose closer is not there is ordinary text.
 *   flow  A display opener that starts a line (`\[`, `\begin{env}`, `$$`) is a
 *         block through its closer, blank lines included, provided the closer
 *         exists. Prose after the closer on that line is its own paragraph.
 *
 * A closer inside code, HTML or a link target the formula opened is not one,
 * for dollars too, so an unfinished formula leaves the Markdown after it as
 * written.
 *
 * Containers, code, HTML and link destinations stay CommonMark's: it reads
 * them before, or instead of, the text these rules see. Values and positions
 * refer to the original input; nothing is rewritten before the parse.
 */
import { unified, type Plugin } from 'unified';
import remarkParse from 'remark-parse';
import type { Root, Nodes } from 'mdast';
import type { Code, Construct, State } from 'micromark-util-types';
import { visit, SKIP } from 'unist-util-visit';
import katex from 'katex';
import { escapedAt, repairMathOperators } from './latex.ts';

type Span = { open: number; close: number; end: number; display: boolean; environment?: string };

declare module 'micromark-util-types' {
  interface TokenTypeMap { latexMath: 'latexMath'; latexMathMarker: 'latexMathMarker'; latexMathData: 'latexMathData' }
  interface Token { latex?: Span }
}

type MathNode = Extract<Nodes, { type: 'math' | 'inlineMath' }>;

// The node shape remark-math emits, which is the contract rehype-katex reads.
function math(value: string, display: boolean): MathNode {
  return { type: display ? 'math' : 'inlineMath', value, data: {
    hName: 'code', hProperties: { className: ['language-math', display ? 'math-display' : 'math-inline'] },
    hChildren: [{ type: 'text', value }],
  } };
}

/**
 * Repairs for what models write and papers print, applied while drawing rather
 * than in a prompt, so every answer, digest and page already stored is fixed
 * too. A repair stands only where KaTeX accepts it and is confined to a
 * recognized formula, never prose or code.
 */
export function repairMath(original: string, displayMode: boolean): string {
  // Inside a TeX environment `\\\\beta` may be a row break before "beta";
  // both parse, so validity cannot justify changing the matrix.
  const hasEnvironment = [...original.matchAll(/\\begin\{/g)].some(match => !escapedAt(original, match.index));
  const repaired = repairMathOperators(hasEnvironment ? original : original.replace(/\\\\(?=[A-Za-z])/g, '\\'));
  if (original === repaired) return original;
  const options = { displayMode, strict: false as const, throwOnError: true };
  try {
    katex.renderToString(repaired, options);
  } catch {
    try {
      katex.renderToString(original, options);
      return original;
    } catch { /* Both fail: MathSpan exposes the source locally. */ }
  }
  return repaired;
}

/** A formula recognized by a compatibility rule, repaired like any other. */
export function mathNode(value: string, display = false): MathNode {
  return math(repairMath(value, display), display);
}

const OPENER = /\\\(|\\\[|\$\$(?!\$)|\\begin\{(equation\*?|displaymath|align\*?|aligned|gathered|cases|matrix|pmatrix|bmatrix)\}/y;
// `equation` only says "display"; KaTeX has no `align` outside a display.
const WRAPPER = /^(?:equation\*?|displaymath)$/;
const lineEnding = (code: Code) => code !== null && code < -2;
const space = (code: Code) => code === -2 || code === -1 || code === 32;

const commonMark = unified().use(remarkParse);
/** Where CommonMark, reading no math, holds text literally: code spans and
 * fences, HTML, definitions and link targets. */
function literalRanges(source: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  visit(commonMark.parse(source), node => {
    const start = node.position!.start.offset!, end = node.position!.end.offset!;
    if (node.type === 'link' || node.type === 'linkReference') ranges.push([node.children.at(-1)?.position?.end.offset ?? start, end]);
    else if (node.type === 'code' ? /[`~]/.test(source[start]) : ['inlineCode', 'html', 'definition', 'image', 'imageReference'].includes(node.type)) ranges.push([start, end]);
  });
  return ranges;
}

/** A `$NAME…$NAME` pair wholly inside one shell assignment word is not math:
 * `PATH="$HOME/bin:$PATH"`, nor is a lone `$NAME` that a path continues:
 * `JAVA_HOME=$HOME/jdk`. A formula such as `k=$K - 1$` leaves the word and
 * `x=$a+b$` closes on a dollar that names nothing, so neither qualifies. */
function shellDollars(source: string): Set<number> {
  const literal = new Set<number>();
  if (!source.includes('$')) return literal;
  for (const word of source.matchAll(/\b[A-Za-z_]\w*=(?:"[^"\n]*"|'[^'\n]*'|[^\s`"']+)/g)) {
    const dollars = [...word[0].matchAll(/\$/g)].filter(dollar => !escapedAt(word[0], dollar.index));
    const named = (pattern: RegExp) => dollars.every(dollar => pattern.test(word[0].slice(dollar.index)));
    if (dollars.length === 1 ? !named(/^\$(?:[A-Za-z_]\w+|\{[A-Za-z_]\w*\})[/:]/) : !dollars.length || !named(/^\$(?:[A-Za-z_]|\{[A-Za-z_]\w*\})/)) continue;
    for (const dollar of dollars) literal.add(word.index + dollar.index);
  }
  return literal;
}

export const remarkLatex: Plugin<[], Root> = function () {
  // Block structure is decided a line at a time, so "is this opener closed?"
  // cannot be answered by reading ahead in the tokenizer. Keep the document.
  let source = '';
  let literalDollars = new Set<number>();
  let literal: Array<[number, number]> | undefined;
  const nextCloser = new Map<string, [from: number, at: number]>();
  const lastCloser = new Map<string, number>();
  const parse = this.parser!;
  this.parser = (document, file) => {
    // Token offsets start after a byte-order mark; index the same text.
    source = String(document).replace(/^\uFEFF/, '');
    literalDollars = shellDollars(source);
    nextCloser.clear(); lastCloser.clear(); literal = undefined;
    return parse(document, file);
  };

  /** The first unescaped `close` at or after `from`; nested `reopen`s pair off. */
  function closerIndex(from: number, close: string, reopen?: string): number {
    // Strays must stay linear: nothing closes after the last closer, and one
    // answer serves every opener up to the closer it found.
    let last = lastCloser.get(close);
    if (last === undefined) lastCloser.set(close, last = source.lastIndexOf(close));
    if (from > last) return -1;
    const known = reopen ? undefined : nextCloser.get(close);
    if (known && known[0] <= from && (known[1] < 0 || from <= known[1])) return known[1];
    let depth = 0, at = -1;
    for (let cursor = from; ; cursor = at + close.length) {
      at = source.indexOf(close, cursor);
      if (at < 0) break;
      if (reopen) {
        for (let inner = source.indexOf(reopen, cursor); inner >= 0 && inner < at; inner = source.indexOf(reopen, inner + 1)) {
          if (!escapedAt(source, inner)) depth += 1;
        }
      }
      if (escapedAt(source, at)) continue;
      if (!depth) break;
      depth -= 1;
    }
    if (!reopen) nextCloser.set(close, [from, at]);
    return at;
  }

  /** Whether the closer at `at` sits in literal text that opened at or after `from`. */
  function inLiteral(from: number, at: number): boolean {
    if (!/[`<]|~~~|\][([:]/.test(source.slice(from, at))) return false;
    literal ??= literalRanges(source);
    return literal.some(([start, end]) => from <= start && start <= at && at < end);
  }

  /** The length of the dollar run at `start` when the run remark-math would close it with is literal. */
  function strandedDollars(start: number): number {
    const runs = /\$+/g;
    runs.lastIndex = start;
    const size = runs.exec(source)![0].length;
    for (let run = runs.exec(source); run; run = runs.exec(source)) {
      if (run[0].length === size) return inLiteral(start + size, run.index) ? size : 0;
    }
    return 0;
  }

  function spanAt(start: number): Span | null {
    OPENER.lastIndex = start;
    const opener = OPENER.exec(source);
    if (!opener) return null;
    const [open, environment] = opener;
    const close = environment ? `\\end{${environment}}` : open === '\\(' ? '\\)' : open === '\\[' ? '\\]' : '$$';
    const at = closerIndex(start + open.length, close, environment && open);
    return at < 0 || inLiteral(start + open.length, at) ? null : { open: open.length, close: close.length, end: at + close.length, display: open !== '\\(', environment };
  }

  // As a fenced block does: a line the container only lazily continues ends it.
  const continuation: Construct = { partial: true, tokenize(effects, ok, nok) {
    return code => {
      effects.enter('lineEnding'); effects.consume(code); effects.exit('lineEnding');
      return next => this.parser.lazy[this.now().line] ? nok(next) : ok(next);
    };
  } };

  function formula(flow: boolean): Construct {
    return { name: flow ? 'latexFlow' : 'latexText', concrete: flow, tokenize(effects, ok, nok) {
      const offset = () => this.now().offset;
      let span: Span, inData = false;
      const start: State = code => {
        const found = spanAt(offset());
        if (!found || (flow && !found.display)) return nok(code);
        // Like a fence, the opener alone is enough to end a paragraph.
        if (flow && this.interrupt) return ok(code);
        span = found;
        effects.enter('latexMath').latex = span;
        return marker(offset() + span.open, body)(code);
      };
      function marker(end: number, after: State): State {
        effects.enter('latexMathMarker');
        const consume: State = code => {
          if (code !== null && offset() < end) { effects.consume(code); return consume; }
          effects.exit('latexMathMarker');
          return after(code);
        };
        return consume;
      }
      const body: State = code => {
        if (code !== null && offset() < span.end - span.close && !lineEnding(code)) {
          if (!inData) { effects.enter('latexMathData'); inData = true; }
          effects.consume(code);
          return body;
        }
        if (inData) { effects.exit('latexMathData'); inData = false; }
        // A paragraph that ends first was never this formula's; a container
        // that ends first closes its block, as it closes an open fence.
        if (code === null) return flow ? end(code) : nok(code);
        if (offset() >= span.end - span.close) return marker(span.end, end)(code);
        if (flow) return effects.attempt(continuation, body, end)(code);
        effects.enter('lineEnding'); effects.consume(code); effects.exit('lineEnding');
        return body;
      };
      const end: State = code => {
        effects.exit('latexMath');
        return flow ? tail(code) : ok(code);
      };
      const tail: State = code => {
        if (code === null || lineEnding(code)) return ok(code);
        if (space(code)) { effects.enter('whitespace'); return blank(code); }
        effects.enter('paragraph'); effects.enter('chunkText', { contentType: 'text' });
        return prose(code);
      };
      const blank: State = code => {
        if (space(code)) { effects.consume(code); return blank; }
        effects.exit('whitespace');
        return tail(code);
      };
      const prose: State = code => {
        if (code !== null && !lineEnding(code)) { effects.consume(code); return prose; }
        effects.exit('chunkText'); effects.exit('paragraph');
        return ok(code);
      };
      return start;
    } };
  }

  // As remark-math's own: no break inside a dollar run, or its math is tried mid-run.
  const literalDollar: Construct = { name: 'latexLiteralDollar', previous(code) {
    return code !== 36 || this.events.at(-1)?.[1].type === 'characterEscape';
  }, tokenize(effects, ok, nok) {
    return code => {
      const offset = this.now().offset;
      let rest = literalDollars.has(offset) ? 1 : strandedDollars(offset);
      if (!rest) return nok(code);
      effects.enter('data');
      const dollar: State = next => {
        if (!rest--) { effects.exit('data'); return ok(next); }
        effects.consume(next);
        return dollar;
      };
      return dollar(code);
    };
  } };

  const data = this.data();
  (data.micromarkExtensions ||= []).push({
    text: { 92: formula(false), 36: literalDollar },
    flow: { 92: formula(true), 36: formula(true) },
    // A `$$` display is this grammar's, so one with no closer is text.
    disable: { null: ['mathFlow'] },
  });
  (data.fromMarkdownExtensions ||= []).push({
    enter: { latexMath(token) { this.enter(math('', token.latex!.display), token); this.buffer(); } },
    exit: {
      latexMathData(token) { this.config.enter.data.call(this, token); this.config.exit.data.call(this, token); },
      latexMath(token) {
        const { display, environment } = token.latex!;
        const body = this.resume();
        const name = environment?.replace(/^align\*?$/, 'aligned');
        const value = !name || WRAPPER.test(name) ? body.trim() : `\\begin{${name}}${body}\\end{${name}}`;
        Object.assign(this.stack.at(-1)!, math(value, display));
        this.exit(token);
      },
    },
  });
  // Operator and over-escaping repairs apply to every formula, however spelled.
  return tree => visit(tree, node => {
    if (node.type === 'math' || node.type === 'inlineMath') Object.assign(node, mathNode(node.value, node.type === 'math'));
  });
};

const CODE_TELLS = /(^|\s)(def|class|function|return|import|export|const|let|var|if|for|while|print|public|void)[\s(]|=>|->|<-|;|\/\/|^#\s|\$[A-Za-z_{]/m;
const MATH_TELLS = /[\\^_]|^\s*[A-Za-z]\s*[=<>]/;
// Prose and settings: two plain words in a row, or a `%` TeX reads as a comment.
const PROSE_TELLS = /(?<![\\A-Za-z])[A-Za-z]{2,}\s+[A-Za-z]{2,}|(?<!\\)%/;
/** Memory's bounded rule for complete legacy formula fences: pages filed before
 * the prompt asked for `$…$`. A wrong guess turns prose or code into italic
 * notation, which is worse than monospace, so anything uncertain stays code. */
export const remarkLegacyMath: Plugin<[], Root> = function () {
  return (tree, file) => {
    const source = String(file);
    visit(tree, (node, index, parent) => {
      if (node.type === 'blockquote') return SKIP;
      if (node.type !== 'code' || !parent || index === undefined || !node.position) return;
      const raw = source.slice(node.position.start.offset, node.position.end.offset);
      const opening = raw.match(/^(`{3,}|~{3,})[^\n]*\n/);
      if (!opening || !new RegExp(`^${opening[1][0]}{${opening[1].length},}$`).test(raw.slice(raw.lastIndexOf('\n') + 1).trim())) return;
      if (node.lang && !['text', 'math', 'latex', 'tex', 'plaintext'].includes(node.lang.toLowerCase())) return;
      const value = node.value.trim();
      if (!value || value.length > 400 || value.split('\n').length > 4 || CODE_TELLS.test(value) || PROSE_TELLS.test(value) || !MATH_TELLS.test(value)) return;
      const formula = value.includes('\n') && !/\\begin\{/.test(value) ? `\\begin{aligned}\n${value.split('\n').join(' \\\\\n')}\n\\end{aligned}` : value;
      try { katex.renderToString(formula, { displayMode: true, throwOnError: true, strict: false }); } catch { return; }
      parent.children[index] = { ...mathNode(formula, true), position: node.position };
    });
  };
};
