/** Shared by the desktop picker, backend configuration and native transport. */
export const CLAUDE_EFFORTS = ["xhigh", "high", "medium", "low"];
export const CLAUDE_DEFAULT_MODEL = "claude-opus-5-5";
export const CLAUDE_MODELS: Record<string, { label: string; efforts: string[] }> = {
  "claude-haiku-5-5": { label: "Haiku 5.5", efforts: CLAUDE_EFFORTS },
  "claude-sonnet-5-5": { label: "Sonnet 5.5", efforts: CLAUDE_EFFORTS },
  "claude-opus-5-5": { label: "Opus 5.5", efforts: CLAUDE_EFFORTS },
};
