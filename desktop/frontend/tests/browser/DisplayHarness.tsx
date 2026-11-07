import { useEffect, useState, type CSSProperties } from "react";
import { MemoAssistantMessage } from "../../app/components/markdown";

/**
 * A finished answer holding one display, through the production Markdown
 * renderer and chat wrappers. The spec hands it the answer and the column's
 * width (the chat panel's own width: 460 is the rail, 800 the expanded chat).
 * Each call mounts a fresh answer.
 */
export default function DisplayHarness() {
  const [answer, setAnswer] = useState<{ content: string; width: number; mount: number } | null>(null);
  useEffect(() => {
    (window as unknown as { __showAnswer: (content: string, width: number) => void }).__showAnswer = (content, width) => setAnswer(last => ({ content, width, mount: (last?.mount ?? 0) + 1 }));
  }, []);
  if (!answer) return <div data-display-harness="waiting" />;
  return <div key={answer.mount} className="kb-chat-rail landed" data-display-harness="ready" style={{ width: answer.width, padding: "24px 20px 28px", boxSizing: "border-box", background: "#fff" }}>
    <div className="kb-ask-modal chat-surface" style={{ "--chat-measure": "none" } as CSSProperties}>
      <div className="messages"><div className="message assistant"><div className="kb-chat-turn"><div className="message-markdown prose-reading">
        <MemoAssistantMessage content={answer.content} papers={[]} onCitation={() => {}} />
      </div></div></div></div>
    </div>
  </div>;
}
