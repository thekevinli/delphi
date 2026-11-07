import { createHash } from "node:crypto";

/** Every chat request names its conversation; tests get one per context, stable across their requests. */
export const conversationFor = (context: Record<string, unknown>) =>
  createHash("md5").update(JSON.stringify([context.scope ?? null, context.project_id ?? null, context.paper_id ?? null])).digest("hex");

export const withConversation = <T extends object>(body: T) =>
  ({ conversation_id: conversationFor(body as Record<string, unknown>), ...body });

export const chatUrl = (origin: string, query = "") => {
  const params = new URLSearchParams(query);
  params.set("conversation_id", conversationFor(Object.fromEntries(params)));
  return `${origin}/api/chat?${params}`;
};
