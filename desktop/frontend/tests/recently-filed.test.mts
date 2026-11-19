import assert from "node:assert/strict";
import test from "node:test";

import type { Paper } from "../app/lib/api.ts";
import { mentionablePages, recentlyFiled } from "../app/lib/recently-filed.ts";

const page = (slug: string, kind: "source" | "concept" | "domain", createdAt: string, sourcePaperId?: string) =>
  ({ slug, title: slug, kind, createdAt, ...(sourcePaperId ? { sourcePaperId } : {}) });
const paper = (id: string, extra: Partial<Paper> = {}) => ({ id, title: id, filename: `${id}.pdf`, ...extra }) as Paper;

test("offers document pages only, newest filed first", () => {
  const pages = [
    page("older", "source", "2026-11-10T09:00:00Z", "a"),
    page("idea", "concept", "2026-11-16T09:00:00Z"),
    page("ml", "domain", "2026-11-16T10:00:00Z"),
    page("newer", "source", "2026-11-15T09:00:00Z", "b"),
  ];
  assert.deepEqual(recentlyFiled(pages, []).map((item) => item.slug), ["newer", "older"]);
  assert.equal(recentlyFiled(pages, [], 1).length, 1);
});

test("marks each with its document's kind and project colour, and a gone document with neither", () => {
  const pages = [
    page("web", "source", "2026-11-16T09:00:00Z", "w"),
    page("pdf", "source", "2026-11-15T09:00:00Z", "p"),
    page("gone", "source", "2026-11-14T09:00:00Z", "missing"),
  ];
  const library = [
    { ...paper("w", { kind: "web", filename: "page.html" }), accentIndex: 3 },
    { ...paper("p"), accentIndex: 1 },
  ];
  assert.deepEqual(
    recentlyFiled(pages, library).map(({ slug, mark, accentIndex }) => ({ slug, mark, accentIndex })),
    [
      { slug: "web", mark: "web", accentIndex: 3 },
      { slug: "pdf", mark: "pdf", accentIndex: 1 },
      { slug: "gone", mark: "pdf", accentIndex: undefined },
    ],
  );
});

test("the @ menu offers every page, newest first, a document's page in its document's mark", () => {
  const pages = [
    page("older", "source", "2026-11-10T09:00:00Z", "w"),
    page("idea", "concept", "2026-11-16T09:00:00Z"),
    page("ml", "domain", "2026-11-12T10:00:00Z"),
    page("gone", "source", "2026-11-15T09:00:00Z", "missing"),
  ];
  const library = [{ ...paper("w", { kind: "web", filename: "page.html" }), accentIndex: 3 }];
  assert.deepEqual(mentionablePages(pages, library), [
    { slug: "idea", title: "idea", kind: "concept" },
    { slug: "gone", title: "gone", kind: "source" },
    { slug: "ml", title: "ml", kind: "domain" },
    { slug: "older", title: "older", kind: "source", mark: "web" },
  ]);
});
