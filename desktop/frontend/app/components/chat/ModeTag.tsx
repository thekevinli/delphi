import { ChatMode } from "../../lib/chat-mode";

/** The placeholder explains the shortcut; this badge reports the current mode. */
export function ModeTag({ mode }: { mode: ChatMode }) {
  const plan = mode === ChatMode.Plan;
  return (
    <div className="composer-mode-label">
      <span className={`composer-mode-tag${plan ? " active" : ""}`} role="status">
        {plan ? "Plan" : "Chat"}
      </span>
    </div>
  );
}
