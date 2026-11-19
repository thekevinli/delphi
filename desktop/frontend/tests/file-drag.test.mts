import assert from "node:assert/strict";
import test from "node:test";

import {
  carriesFiles,
  carriesImage,
  carriesPdf,
  imageDropHint,
  isAcceptedImageFile,
  isPdfFile,
} from "../app/lib/file-drag.ts";

function drag(options: {
  types?: string[];
  items?: { kind: string; type: string; name?: string }[];
  files?: { type: string; name: string; size?: number }[];
}) {
  const items = (options.items ?? []).map((item) => ({
    kind: item.kind,
    type: item.type,
    getAsFile: () =>
      item.name
        ? ({ name: item.name, type: item.type } as File)
        : null,
  }));
  return {
    dataTransfer: {
      types: options.types ?? ["Files"],
      items,
      files: options.files ?? [],
    } as unknown as DataTransfer,
  };
}

test("a file drag is distinct from a text selection", () => {
  assert.equal(carriesFiles(drag({ types: ["Files"] })), true);
  assert.equal(carriesFiles(drag({ types: ["text/plain"] })), false);
});

test("a PDF is recognised from its MIME type or its name", () => {
  assert.equal(
    carriesPdf(
      drag({ items: [{ kind: "file", type: "application/pdf" }] }),
    ),
    true,
  );
  assert.equal(
    carriesPdf(
      drag({
        items: [{ kind: "file", type: "", name: "paper.PDF" }],
      }),
    ),
    true,
  );
  assert.equal(isPdfFile({ type: "application/x-pdf", name: "notes" }), true);
  assert.equal(isPdfFile({ type: "", name: "notes.pdf" }), true);
});

test("an image drag is not a paper drop", () => {
  const png = drag({ items: [{ kind: "file", type: "image/png" }] });
  assert.equal(carriesImage(png), true);
  assert.equal(carriesPdf(png), false);
  assert.equal(
    carriesImage(
      drag({ items: [{ kind: "file", type: "", name: "figure.webp" }] }),
    ),
    true,
  );
});

test("a file whose type is unknown yet is not treated as a PDF", () => {
  // Until drop, some browsers give `Files` and an empty item type. Painting
  // the library overlay on that would cover the composer an image was aimed at.
  const unknown = drag({ items: [{ kind: "file", type: "" }] });
  assert.equal(carriesPdf(unknown), false);
  assert.equal(carriesImage(unknown), false);
});

test("chat images stay PNG, JPEG, or static WebP under the published cap", () => {
  const png = new File([new Uint8Array(16)], "shot.png", { type: "image/png" });
  const gif = new File([new Uint8Array(16)], "shot.gif", { type: "image/gif" });
  assert.equal(isAcceptedImageFile(png, 20), true);
  assert.equal(isAcceptedImageFile(gif, 20), false);
  assert.equal(
    imageDropHint(2),
    "Drop to attach · PNG, JPEG, or WebP · up to 2 per question",
  );
});
