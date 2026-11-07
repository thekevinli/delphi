import { ARTIFACT_MAX_LENGTH } from "./inline-artifact.ts";

export const ARTIFACT_VALIDATOR_HEIGHT = 600;
export type ArtifactValidatorRequest = { title: string; source: string; width: number };

/** A renderer job is data, never an arbitrary host script or selector. */
export function artifactValidatorRequest(value: unknown): ArtifactValidatorRequest {
  if (!value || typeof value !== "object") throw new Error("Expected an artifact render request");
  const input = value as Record<string, unknown>;
  if (typeof input.source !== "string" || !input.source.trim() || input.source.length > ARTIFACT_MAX_LENGTH) {
    throw new Error("Artifact source must contain 1–128000 characters");
  }
  if (typeof input.title !== "string" || input.title.length > 160 || /[\u0000-\u001f\u007f]/.test(input.title)) {
    throw new Error("Artifact title must be plain text of at most 160 characters");
  }
  if (typeof input.width !== "number" || !Number.isInteger(input.width) || input.width < 270 || input.width > 1200) {
    throw new Error("Artifact width must be an integer from 270 to 1200 pixels");
  }
  return { title: input.title || "Interactive visualization", source: input.source, width: input.width };
}
