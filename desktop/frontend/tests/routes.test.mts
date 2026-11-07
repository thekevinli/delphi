import assert from "node:assert/strict";
import test from "node:test";

import {
  documentPath,
  focusBox,
  parseReaderPath,
  projectPath,
  readerApiPath,
  readFocusBox,
} from "../app/lib/routes.ts";

const project = {
  id: "fdd2a418659f",
  name: "Pixel Diffusion & Semantic Representation",
  slug: "pixel-diffusion-semantic-representation",
};
const paper = {
  id: "7d8fc68ed50a",
  title: "Pixel DiT (2511.20645v2)",
  slug: "pixel-dit-2511-20645v2",
};

test("builds canonical paths only from server-issued slugs", () => {
  assert.equal(
    projectPath("Reader_Name", project),
    "/@Reader_Name/pixel-diffusion-semantic-representation",
  );
  assert.equal(
    documentPath("Reader_Name", project, paper),
    "/@Reader_Name/pixel-diffusion-semantic-representation/pixel-dit-2511-20645v2",
  );
  assert.equal(
    documentPath("Reader_Name", project, paper, { chat: "project" }),
    "/@Reader_Name/pixel-diffusion-semantic-representation/pixel-dit-2511-20645v2?chat=project",
  );
  assert.throws(() =>
    projectPath("Reader_Name", { ...project, slug: "Unicode-Title" }),
  );
});

test("parses project and document routes while preserving username case", () => {
  const projectRoute = parseReaderPath(
    "/@Reader_Name/pixel-diffusion-semantic-representation",
  );
  assert.deepEqual(projectRoute, {
    kind: "project",
    username: "Reader_Name",
    projectSlug: "pixel-diffusion-semantic-representation",
  });
  assert.equal(
    projectRoute ? readerApiPath(projectRoute)
      : null,
    "/api/reader/Reader_Name/pixel-diffusion-semantic-representation",
  );

  const documentRoute = parseReaderPath(
    "/@Reader_Name/pixel-diffusion-semantic-representation/pixel-dit-2511-20645v2",
  );
  assert.deepEqual(documentRoute, {
    kind: "document",
    username: "Reader_Name",
    projectSlug: "pixel-diffusion-semantic-representation",
    paperSlug: "pixel-dit-2511-20645v2",
  });
  assert.equal(
    documentRoute ? readerApiPath(documentRoute)
      : null,
    "/api/reader/Reader_Name/pixel-diffusion-semantic-representation/pixel-dit-2511-20645v2",
  );
});

test("accepts backend fallbacks and collision suffixes as opaque slugs", () => {
  assert.deepEqual(parseReaderPath("/@reader/project-2/document-3"), {
    kind: "document",
    username: "reader",
    projectSlug: "project-2",
    paperSlug: "document-3",
  });
});

test("rejects malformed, legacy, escaped, and over-deep paths", () => {
  const malformed = [
    "relative",
    "/reader/project/paper",
    "/old-project-fdd2a418659f/old-paper-7d8fc68ed50a",
    "/@ab/project",
    "/@reader/Project",
    "/@reader/project/",
    "/@reader/project/paper/extra",
    "/@reader/project%2Fescape",
    "/@reader/project\u0000",
    "/@reader/" + "x".repeat(61),
    "/brand/delphi-mark.svg",
    "/fonts/plus-jakarta-sans-variable.woff2",
  ];
  for (const path of malformed) {
    assert.equal(parseReaderPath(path), null, JSON.stringify(path));
  }
  assert.deepEqual(parseReaderPath("/"), { kind: "root" });
});

test("a caption box survives the address a citation from outside the reader travels by", () => {
  const box = { x: 0.1234567, y: 0.28, w: 0.8, h: 0.05 };
  assert.deepEqual(readFocusBox(focusBox(box)), { x: 0.1235, y: 0.28, w: 0.8, h: 0.05 });
  for (const value of [null, "", "1,2,3", "0.1,0.2,0.3,1.5", "0.1,0.2,0,0.1", "a,b,c,d"]) assert.equal(readFocusBox(value), null, String(value));
});
