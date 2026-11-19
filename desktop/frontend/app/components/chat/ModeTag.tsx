import { ChatMode } from "../../lib/chat-mode";

/** Plan is drawn; Chat, the default, is said to a screen reader and nothing more. */
export function ModeTag({ mode }: { mode: ChatMode }) {
  return (
    <div className="composer-mode-label" role="status">
      {mode === ChatMode.Plan ? <span className="composer-mode-tag">Plan</span> : <span className="visually-hidden">Chat</span>}
    </div>
  );
}
