import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Every class the stylesheet styles is one the app can put on an element.
 *
 * A rule for a class nothing renders is dead weight that still costs a read:
 * it looks like a live contract, it gets "fixed" when palettes change, and it
 * hides which rules actually shape the screen. The exceptions are classes
 * third-party code writes into the DOM (pdf.js's text layer, KaTeX).
 */
const EXTERNAL = new Set(["endOfContent", "markedContent", "selecting", "katex-display"]);

async function sources(dir) {
  const entries = await readdir(new URL(dir, import.meta.url), { withFileTypes: true });
  const texts = await Promise.all(entries.map(async (entry) => {
    const path = `${dir}${entry.name}`;
    if (entry.isDirectory()) return sources(`${path}/`);
    return /\.(tsx?|html|js)$/.test(entry.name) ? readFile(new URL(path, import.meta.url), "utf8") : "";
  }));
  return texts.join("\n");
}

test("the stylesheet styles no class the app never renders", async () => {
  const [css, app, publicFiles] = await Promise.all([
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    sources("../app/"),
    sources("../public/"),
  ]);
  const code = `${app}\n${publicFiles}`;
  const selectors = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{[^{}]*\}/g, "{}");
  const classes = new Set([...selectors.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((match) => match[1]));
  // Classes built from a template (`kb-kind-${kind}`) count by their prefix.
  const prefixes = [...code.matchAll(/([A-Za-z][\w-]*-)\$\{/g)].map((match) => match[1]);
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const unused = [...classes].filter((name) =>
    !EXTERNAL.has(name) &&
    !new RegExp(`(?<![\\w-])${escape(name)}(?![\\w-])`).test(code) &&
    !prefixes.some((prefix) => name.startsWith(prefix)));
  assert.deepEqual(unused, []);
});
