import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeEntities, isImportableUrl, parseBookmarks, runPool,
} from "../app/lib/bookmarks.ts";

// The shape Chrome exports, trimmed of its base64 favicons.
const CHROME_EXPORT = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1788222894" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks Bar</H3>
    <DL><p>
        <DT><H3 ADD_DATE="1789756828">World Action Models</H3>
        <DL><p>
            <DT><A HREF="https://arxiv.org/pdf/2607.08639v1" ICON="data:image/png;base64,AAA=">Native Video-Action Pretraining</A>
            <DT><A HREF="https://www.pi.website/blog/pi07">A Steerable Model with Emergent Capabilities</A>
        </DL><p>
        <DT><H3>Infra 101</H3>
        <DL><p>
            <DT><A HREF="https://jax-ml.github.io/scaling-book/">How To Scale Your Model</A>
            <DT><A HREF="https://fleetwood.dev/posts/domain-specific-architectures#google-tpu">Domain specific architectures &amp; AI inference</A>
        </DL><p>
        <DT><A HREF="https://example.com/loose">A loose page on the bar</A>
    </DL><p>
</DL><p>
`;

test("each page becomes part of the folder closest to it", () => {
  const folders = parseBookmarks(CHROME_EXPORT);
  assert.deepEqual(folders.map((folder) => folder.name), [
    "World Action Models", "Infra 101", "Bookmarks Bar",
  ]);
  assert.deepEqual(folders[0].links, [
    { url: "https://arxiv.org/pdf/2607.08639v1", title: "Native Video-Action Pretraining" },
    { url: "https://www.pi.website/blog/pi07", title: "A Steerable Model with Emergent Capabilities" },
  ]);
  // A folder holding pages beside its subfolders keeps its own pages.
  assert.deepEqual(folders[2].links, [{ url: "https://example.com/loose", title: "A loose page on the bar" }]);
  assert.equal(folders[1].links[1].title, "Domain specific architectures & AI inference");
});

test("a folder is cut to the project limit", () => {
  const links = Array.from({ length: 13 }, (_, index) =>
    `<DT><A HREF="https://example.com/${index}">Page ${index}</A>`).join("\n");
  const [folder] = parseBookmarks(`<DL><p><DT><H3>Big</H3><DL><p>${links}</DL><p></DL>`);
  assert.equal(folder.links.length, 10);
  assert.equal(folder.links[9].title, "Page 9");
});

test("pages Delphi cannot fetch, and repeats, are left out", () => {
  const folders = parseBookmarks(`<DL><p><DT><H3>Mixed</H3><DL><p>
    <DT><A HREF="javascript:void(0)">Bookmarklet</A>
    <DT><A HREF="chrome://settings">Settings</A>
    <DT><A HREF="https://example.com/a">A</A>
    <DT><A HREF="https://example.com/a">A again</A>
    <DT><A HREF="https://example.com/b"></A>
  </DL><p><DT><H3>Only bookmarklets</H3><DL><p><DT><A HREF="javascript:alert(1)">x</A></DL><p></DL>`);
  assert.equal(folders.length, 1);
  assert.deepEqual(folders[0].links, [
    { url: "https://example.com/a", title: "A" },
    // An untitled bookmark is named for its site rather than left blank.
    { url: "https://example.com/b", title: "example.com" },
  ]);
});

test("same-named folders in different places stay separate projects", () => {
  const folders = parseBookmarks(`<DL><p>
    <DT><H3>Work</H3><DL><p><DT><H3>Reading</H3><DL><p><DT><A HREF="https://a.com">A</A></DL><p></DL><p>
    <DT><H3>Home</H3><DL><p><DT><H3>Reading</H3><DL><p><DT><A HREF="https://b.com">B</A></DL><p></DL><p>
  </DL>`);
  assert.deepEqual(folders.map((folder) => [folder.name, folder.links[0].url]), [
    ["Reading", "https://a.com"], ["Reading", "https://b.com"],
  ]);
});

test("a file with no bookmarks gives no projects", () => {
  assert.deepEqual(parseBookmarks("<html><body>Not an export</body></html>"), []);
});

test("entities and URL schemes", () => {
  assert.equal(decodeEntities("Q&amp;A &#8212; &#x2019;s &lt;b&gt; &bogus;"), "Q&A — ’s <b> &bogus;");
  assert.ok(isImportableUrl("https://arxiv.org/abs/1"));
  assert.ok(!isImportableUrl("file:///Users/me/paper.pdf"));
  assert.ok(!isImportableUrl("not a url"));
});

test("the pool never has more than its limit in flight and visits everything", async () => {
  let inFlight = 0;
  let peak = 0;
  const seen: number[] = [];
  await runPool([1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    seen.push(item);
    inFlight -= 1;
  });
  assert.equal(peak, 3);
  assert.deepEqual(seen.sort(), [1, 2, 3, 4, 5, 6, 7]);
  await runPool([], 3, async () => assert.fail("no items, no calls"));
});
