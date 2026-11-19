/**
 * What a drag is carrying, as far as the drag events themselves will say.
 *
 * `dataTransfer.files` is empty until the drop, so the window-level paper
 * overlay used to light up for every file — including an image aimed at the
 * composer. The overlay is `z-index: 300` over the composer's 80, so that
 * painted the library cue on top of the field the reader was dropping onto.
 * MIME type (and the name, when the browser will give it) is the one signal
 * that can tell a PDF from a PNG while the pointer is still moving.
 */

export const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const ACCEPTED_IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"];

const PDF_TYPES = new Set(["application/pdf", "application/x-pdf"]);
const IMAGE_TYPES = new Set(ACCEPTED_IMAGE_TYPES);

export type FileDragLike = { dataTransfer: DataTransfer | null };

export function imageDropHint(maxPerQuestion: number): string {
  return `Drop to attach · PNG, JPEG, or WebP · up to ${maxPerQuestion} per question`;
}

export function carriesFiles(event: FileDragLike): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

export function isPdfFile(file: { type: string; name: string }): boolean {
  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  return PDF_TYPES.has(type) || name.endsWith(".pdf");
}

export function isAcceptedImageFile(file: File, maxSourceMb: number): boolean {
  const type = file.type.toLowerCase();
  const extension = file.name.toLowerCase().match(/\.[^.]+$/)?.[0] ?? "";
  return (
    IMAGE_TYPES.has(type) &&
    (!extension || ACCEPTED_IMAGE_EXTENSIONS.includes(extension)) &&
    file.size <= maxSourceMb * 1024 * 1024
  );
}

export function carriesPdf(event: FileDragLike): boolean {
  return (
    mimeTypesOf(event).some((type) => PDF_TYPES.has(type)) ||
    namesOf(event).some((name) => name.endsWith(".pdf"))
  );
}

export function carriesImage(event: FileDragLike): boolean {
  return (
    mimeTypesOf(event).some((type) => IMAGE_TYPES.has(type)) ||
    namesOf(event).some((name) =>
      ACCEPTED_IMAGE_EXTENSIONS.some((extension) => name.endsWith(extension)),
    )
  );
}

function mimeTypesOf(event: FileDragLike): string[] {
  const data = event.dataTransfer;
  if (!data) return [];
  const fromItems = Array.from(data.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.type.toLowerCase())
    .filter(Boolean);
  const fromTypes = Array.from(data.types ?? [])
    .map((type) => type.toLowerCase())
    .filter((type) => type !== "files" && type.includes("/"));
  const fromFiles = Array.from(data.files ?? []).flatMap((file) =>
    file.type ? [file.type.toLowerCase()] : [],
  );
  return [...fromItems, ...fromTypes, ...fromFiles];
}

function namesOf(event: FileDragLike): string[] {
  const data = event.dataTransfer;
  if (!data) return [];
  const names: string[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file") continue;
    const file = fileFromItem(item);
    if (file?.name) names.push(file.name.toLowerCase());
  }
  for (const file of Array.from(data.files ?? [])) {
    if (file.name) names.push(file.name.toLowerCase());
  }
  return names;
}

function fileFromItem(item: DataTransferItem): File | null {
  try {
    return item.getAsFile();
  } catch {
    return null;
  }
}
