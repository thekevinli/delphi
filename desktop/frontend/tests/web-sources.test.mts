import assert from "node:assert/strict";
import test from "node:test";

import { cleanSourceTitle, isWebUrl, normalizeSources, pageName, SITE_TINTS, siteLetter, siteName, sourceFor, unwrapCitedLinks } from "../app/lib/web-sources.ts";

test("only an http or https address is something a reader may be sent to", () => {
  assert.equal(isWebUrl("https://arxiv.org/abs/2203.03466"), true);
  assert.equal(isWebUrl("http://example.org/a?b=c#d"), true);
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "mailto:a@b.c", "ftp://x.org/y",
    "//arxiv.org/abs/1", "/api/plans/x/view", "figure:abc", "", " https://padded.example ", "https://", `https://x.org/${"y".repeat(2100)}`, null, 7, undefined]) {
    assert.equal(isWebUrl(bad), false, String(bad));
  }
});

test("a source is said by its site, and an opened page by its site and path", () => {
  assert.equal(siteName("https://www.arxiv.org/abs/2203.03466?utm_source=openai"), "arxiv.org");
  assert.equal(siteName("not a url"), "not a url");
  assert.equal(pageName("https://www.arxiv.org/abs/2203.03466?utm_source=openai"), "arxiv.org/abs/2203.03466");
  assert.equal(pageName("https://github.com/microsoft/mup/"), "github.com/microsoft/mup");
  assert.equal(pageName("https://example.org"), "example.org");
});

test("stored sources are read back bounded, once each, and never as anything but web addresses", () => {
  const arxiv = "https://arxiv.org/abs/2203.03466";
  assert.deepEqual(normalizeSources([
    { url: arxiv, title: "  Tensor Programs V  " },
    { url: arxiv, title: "The same page again" },
    { url: "javascript:alert(1)", title: "Nope" },
    { url: "https://github.com/microsoft/mup" },
    { title: "No address" }, null, "https://a.string.example/",
  ]), [
    { url: arxiv, title: "Tensor Programs V" },
    { url: "https://github.com/microsoft/mup", title: "github.com" },
  ]);
  assert.deepEqual(normalizeSources(undefined), []);
  assert.deepEqual(normalizeSources({ url: arxiv }), []);
  assert.equal(normalizeSources(Array.from({ length: 90 }, (_, n) => ({ url: `https://example.org/${n}`, title: "t" }))).length, 40);
  assert.equal(normalizeSources([{ url: arxiv, title: "x".repeat(500) }])[0].title.length, 200);
});

test("a link in an answer is a citation exactly when its address is one of the answer's sources", () => {
  const sources = [{ url: "https://arxiv.org/abs/2203.03466?utm_source=openai", title: "Tensor Programs V" }];
  assert.equal(sourceFor("https://arxiv.org/abs/2203.03466?utm_source=openai", sources)?.title, "Tensor Programs V");
  // Matched by the whole address, as the provider wrote it in both places.
  assert.equal(sourceFor("https://arxiv.org/abs/2203.03466", sources), undefined);
  assert.equal(sourceFor(undefined, sources), undefined);
  assert.equal(sourceFor("https://arxiv.org/abs/2203.03466", undefined), undefined);
});

test("a source's title says what the page is, without the site's name the row already shows", () => {
  const clean = (url: string, title: string) => cleanSourceTitle({ url, title });
  assert.deepEqual(clean("https://github.com/sgl-project/sglang-omni", "GitHub - sgl-project/sglang-omni: SGLang-Omni is a serving framework · GitHub"),
    { title: "sgl-project/sglang-omni", detail: "SGLang-Omni is a serving framework" });
  assert.deepEqual(clean("https://docs.vllm.ai/en/latest/x.html", "Disaggregated Prefilling - vLLM"), { title: "Disaggregated Prefilling", detail: "" });
  assert.deepEqual(clean("https://arxiv.org/abs/2203.03466", "[2203.03466] Tensor Programs V · arXiv"), { title: "[2203.03466] Tensor Programs V", detail: "" });
  assert.deepEqual(clean("https://example.org/a", "Release notes · v2.1 · Stable"), { title: "Release notes", detail: "v2.1 · Stable" });
  // A dash inside the title is the title's own, not a separator to cut at.
  assert.deepEqual(clean("https://example.org/a", "Mixture-of-Experts - a survey"), { title: "Mixture-of-Experts - a survey", detail: "" });
  assert.deepEqual(clean("https://github.com/x/y", "GitHub"), { title: "GitHub", detail: "" });
});

test("a site with no icon keeps one letter and one tint wherever it is cited", () => {
  assert.deepEqual(siteLetter("https://docs.vllm.ai/en/latest"), siteLetter("https://docs.vllm.ai/other"));
  assert.equal(siteLetter("https://docs.vllm.ai/en/latest").letter, "V");
  assert.equal(siteLetter("https://www.github.com/x").letter, "G");
  assert.equal(siteLetter("https://sgl-project.github.io/").letter, "S");
  assert.equal(siteLetter("https://en.wikipedia.org/wiki/Cache").letter, "W");
  const tints = new Set(["a.org", "b.org", "c.org", "d.org", "e.org", "f.org", "g.org", "h.org"].map((host) => siteLetter(`https://${host}/`).tint));
  assert.ok(tints.size > 1 && [...tints].every((tint) => tint >= 0 && tint < SITE_TINTS));
});

test("only a cited link standing alone in parentheses loses them", () => {
  const sources = [{ url: "https://arxiv.org/abs/1", title: "A" }];
  assert.equal(unwrapCitedLinks("Shown ([arxiv.org](https://arxiv.org/abs/1)).", sources), "Shown [arxiv.org](https://arxiv.org/abs/1).");
  assert.equal(unwrapCitedLinks("Shown ( [arxiv.org](https://arxiv.org/abs/1) ).", sources), "Shown [arxiv.org](https://arxiv.org/abs/1).");
  for (const kept of ["Shown ([other](https://example.org/x)).", "Shown (see [arxiv.org](https://arxiv.org/abs/1)).", "Shown [arxiv.org](https://arxiv.org/abs/1)."]) {
    assert.equal(unwrapCitedLinks(kept, sources), kept);
  }
  assert.equal(unwrapCitedLinks("Shown ([arxiv.org](https://arxiv.org/abs/1)).", undefined), "Shown ([arxiv.org](https://arxiv.org/abs/1)).");
});

test("a cited link written out in code or mathematics keeps its parentheses", () => {
  const sources = [{ url: "https://arxiv.org/abs/1", title: "A" }];
  const quoted = "([arxiv.org](https://arxiv.org/abs/1))";
  for (const kept of [
    `Cite it as \`${quoted}\`.`,
    `\`\`\`md\nShown ${quoted}.\n\`\`\``,
    `A list:\n\n    ${quoted}`,
    `A set $f${quoted}$ here.`,
    `$$\nf${quoted}\n$$`,
    `Math \\(f${quoted}\\) here.`,
    `\\[ ${quoted} \\]`,
    `Shown \\${quoted}.`,
  ]) assert.equal(unwrapCitedLinks(kept, sources), kept);
  assert.equal(
    unwrapCitedLinks(`Shown ${quoted}, written \`${quoted}\`, and again ${quoted}.`, sources),
    `Shown [arxiv.org](https://arxiv.org/abs/1), written \`${quoted}\`, and again [arxiv.org](https://arxiv.org/abs/1).`,
  );
});
