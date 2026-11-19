/**
 * Desktop chat choices, intersected with the installed backend's capabilities:
 * an effort appears only once the backend offers it for that model.
 */
import { CLAUDE_MODELS } from "./claude-models.ts";

// OpenAI effort ladder, strongest first.
const CHAT_EFFORTS = ["max", "xhigh", "high", "medium", "low"];
const CHAT_MODELS: Record<string, { label: string; efforts: string[] }> = {
  ...CLAUDE_MODELS,
  "gpt-6-luna": { label: "GPT-6 Luna", efforts: CHAT_EFFORTS },
  "gpt-6.1-sol": { label: "GPT-6.1 Sol", efforts: CHAT_EFFORTS },
};
/** Every model the desktop can label; which of them a chat offers is /api/config's list. */
export const SUPPORTED_MODELS = Object.keys(CHAT_MODELS);
/** The API connection's choices, shown until /api/config answers. */
const DEFAULT_MODELS = ["gpt-6-luna", "gpt-6.1-sol"];
/** The composer's efforts per model, before the backend's capabilities narrow them. */
export const CHAT_MODEL_EFFORTS: Record<string, string[]> = Object.fromEntries(
  Object.entries(CHAT_MODELS).map(([model, policy]) => [model, policy.efforts]));

export function modelLabel(model: string): string {
  return CHAT_MODELS[model]?.label ?? model;
}

/** Each model the backend offers, narrowed to the efforts both sides allow. */
export function chatModelEfforts(available: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(CHAT_MODELS).filter(([model]) => model in available).map(([model, policy]) =>
    [model, policy.efforts.filter(effort => available[model].includes(effort))]));
}
export function chatEffort(model: string, requested: string, available: Record<string, string[]>, fallback = DEFAULT_CHAT_CONFIG.defaultReasoningEffort): string {
  const offered = chatModelEfforts(available)[model] ?? [];
  return offered.includes(requested) ? requested : offered.includes(fallback) ? fallback : offered.at(-1) ?? "";
}

// Capabilities until /api/config answers: the pinned backend's full ladder.
const FALLBACK_EFFORTS = CHAT_EFFORTS;
export const DEFAULT_CHAT_CONFIG = {
  defaultModel: "gpt-6.1-sol",
  models: DEFAULT_MODELS,
  defaultReasoningEffort: "medium",
  reasoningEfforts: FALLBACK_EFFORTS,
  modelReasoningEfforts: chatModelEfforts(Object.fromEntries(
    DEFAULT_MODELS.map(model => [model, FALLBACK_EFFORTS]),
  )),
};
