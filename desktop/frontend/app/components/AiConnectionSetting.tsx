"use client";

import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";

import { API_KEYS, CLAUDE_CODE, KEY_PROVIDER, isSubscription, type ApiConnectionId, type ClaudeCodeProblem, type ConnectionId, type SavedKeys, type SubscriptionId } from "../lib/ai-connection";
import { Segmented } from "./Segmented";
export type { ConnectionId } from "../lib/ai-connection";

/** `/desktop/connection` as the shell reports it; it never carries a secret. */
export type ConnectionState = {
  connection: ConnectionId;
  keys: SavedKeys;
  chatgpt: { connected: boolean; usage?: PlanUsage; message?: string };
  claude: { connected: boolean; usage?: PlanUsage; message?: string; install?: ClaudeCodeInstall };
  busy?: string;
};

/** Present only while the reader's Claude Code cannot serve: what to run. */
export type ClaudeCodeInstall = { problem: ClaudeCodeProblem; command: string };

/** The plan's longest window, refreshed when Settings opens. */
export type PlanUsage = { plan?: string; percentLeft?: number; weekly?: boolean; resets?: string; blockedUntil?: string };

function UsageLine({ usage }: { usage: PlanUsage }) {
  const plan = usage.plan ? `${usage.plan} plan` : null;
  const status = usage.blockedUntil
    ? <>Usage limit reached until {usage.blockedUntil}</>
    : usage.percentLeft !== undefined
      ? <><strong>{usage.percentLeft}%</strong> of {usage.weekly ? "weekly " : ""}usage left{usage.resets ? `, resets ${usage.resets}` : ""}</>
      : null;
  if (!plan && !status) return null;
  return <>{plan}{plan && status ? " · " : null}{status}</>;
}

/** The last answer stands when the shell cannot be reached. */
/** Which connection is in use, known at once; the plans' statuses come later. */
export type ConnectionBasics = Pick<ConnectionState, "connection" | "keys">;

async function readBasics(): Promise<ConnectionBasics | null> {
  try {
    const response = await fetch("/desktop/connection?quick", { cache: "no-store" });
    return response.ok ? (await response.json()) as ConnectionBasics : null;
  } catch { return null; }
}

async function readConnection(): Promise<ConnectionState | null> {
  try {
    const response = await fetch("/desktop/connection", { cache: "no-store" });
    return response.ok ? (await response.json()) as ConnectionState : null;
  } catch { return null; }
}

async function connectionRequest(body: { action: "switch" | "manage"; to?: ConnectionId }) {
  const response = await fetch("/desktop/connection", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await response.json().catch(() => ({}))) as { ok?: boolean; setup?: boolean; message?: string };
}

/**
 * The reader's subscription or API connection, as the shell reports it.
 * `null` until the shell answers, and for good outside the desktop app, where
 * there is no shell and nothing to switch. A connection whose credentials are
 * saved switches on one click; one that is not set up opens the AI Connection
 * window, the only surface that handles credentials. The shell reloads this
 * page once the new connection is serving.
 */
export function useAiConnection() {
  const [state, setState] = useState<ConnectionState | null>(null);
  const [basics, setBasics] = useState<ConnectionBasics | null>(null);
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const live = useRef(true);
  const refresh = useCallback(async () => {
    const value = await readConnection();
    if (live.current && value) setState(value);
  }, []);

  useEffect(() => {
    live.current = true;
    void readBasics().then((value) => { if (live.current && value) setBasics(value); });
    void readConnection().then((value) => { if (live.current && value) setState(value); });
    return () => { live.current = false; };
  }, []);

  // Claude Code is installed, updated, removed or signed in outside Delphi,
  // usually in Terminal while Settings stays open: look again on return.
  useEffect(() => {
    const again = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, [refresh]);

  const change = useCallback(async (to: ConnectionId) => {
    if (!state || to === state.connection || pending) return;
    setPending(true);
    setError("");
    setNote("Switching…");
    try {
      const result = await connectionRequest({ action: "switch", to });
      if (result.ok) return; // The shell reloads this page when it is ready.
      if (result.setup) setNote("Finish setting it up in the AI Connection window.");
      else { setNote(""); setError(result.message ?? "Could not switch the connection."); }
    } catch {
      setNote("");
      setError("Could not reach Delphi to switch the connection.");
    } finally {
      setPending(false);
    }
  }, [state, pending]);

  const manage = useCallback((to: ConnectionId) => {
    setError("");
    setNote("Continue in the AI Connection window.");
    void connectionRequest({ action: "manage", to }).catch(() => {
      setNote("");
      setError("Could not reach Delphi to open the AI Connection window.");
    });
  }, []);

  /** The connection in use, as soon as it is known: statuses or not. */
  const current: ConnectionBasics | null = state ?? basics;
  return { state, current, pending, note, error, change, manage, refresh };
}

export type AiConnection = ReturnType<typeof useAiConnection>;

/** Both account marks use the same bundled format and tile dimensions. */
function AccountGlyph({ provider }: { provider: "chatgpt" | "claude" }) {
  return <img src={`/brand/${provider}.png`} width="36" height="36" alt="" aria-hidden="true" />;
}

function KeyGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="8" cy="15" r="4" />
      <path d="m11 12 8-8M16 7l2.5 2.5M14 9l2 2" />
    </svg>
  );
}

const OPTIONS: Record<ConnectionId, {
  name: string;
  short: string;
  Glyph: () => ReactElement;
  about: string;
}> = {
  "chatgpt-oauth": {
    name: "ChatGPT plan",
    short: "ChatGPT",
    Glyph: () => <AccountGlyph provider="chatgpt" />,
    about: "Uses your ChatGPT plan’s limits. Your library stays as it is.",
  },
  "claude-subscription": {
    name: "Claude plan", short: "Claude",
    Glyph: () => <AccountGlyph provider="claude" />,
    about: "Uses your Claude subscription through Claude Code (requires installation separately).",
  },
  "openai-api": {
    name: "OpenAI API key",
    short: "OpenAI",
    Glyph: KeyGlyph,
    about: "Billed to your OpenAI account",
  },
  "claude-api": {
    name: "Claude API key",
    short: "Claude",
    Glyph: KeyGlyph,
    about: "Billed to your Anthropic account",
  },
};

/** The OpenAI service tier, which only an OpenAI key is billed by: a Claude key
 * and both plans have one way to be served. Settings owns the preference. */
export type ServiceTier = {
  value: "standard" | "flex";
  pending: boolean;
  error: string;
  change: (value: "standard" | "flex") => void;
};
const TIER_LABEL = { standard: "Standard", flex: "Flex" } as const;

/** The rail: each subscription, then every provider key under one entry. */
type RailId = SubscriptionId | "api-keys";
const RAIL: RailId[] = ["chatgpt-oauth", "claude-subscription", "api-keys"];
const isApiConnection = (id: ConnectionId) => !isSubscription(id);

function subscription(state: ConnectionState, id: ConnectionId) {
  return id === "claude-subscription" ? state.claude : id === "chatgpt-oauth" ? state.chatgpt : undefined;
}

const keySaved = (state: ConnectionState, id: ApiConnectionId) => Boolean(state.keys?.[KEY_PROVIDER[id]]);

function ready(state: ConnectionState, id: ConnectionId) {
  return isSubscription(id) ? Boolean(subscription(state, id)?.connected) : keySaved(state, id);
}

const INSTALL_LABEL: Record<ClaudeCodeProblem, string> = { missing: "Claude Code not installed", outdated: "Claude Code needs an update" };

function claudeInstall(state: ConnectionState, id: ConnectionId) {
  return id === "claude-subscription" ? state.claude?.install : undefined;
}

function railLabel(state: ConnectionState, id: RailId) {
  if (id !== "api-keys") return statusLabel(state, id);
  if (isApiConnection(state.connection)) return "In use";
  return Object.values(state.keys ?? {}).some(Boolean) ? "Key saved" : "No key saved";
}

function statusLabel(state: ConnectionState, id: ConnectionId) {
  const install = claudeInstall(state, id);
  if (install) return install.problem === "missing" ? "Not installed" : "Needs update";
  if (id === state.connection) return "In use";
  if (isSubscription(id)) return ready(state, id) ? "Signed in" : "Not signed in";
  return keySaved(state, id) ? "Key saved" : "No key saved";
}

function Messages({ connection }: { connection: AiConnection }) {
  return <>
    {connection.note ? <div className="account-setting-note" role="status">{connection.note}</div> : null}
    {connection.error ? <div className="form-error">{connection.error}</div> : null}
  </>;
}

/**
 * The one AI connection row in Advanced: what is serving, and the way to
 * change it. The switch itself lives in the sheet's AI connection view.
 */
export function AiConnectionRow({ connection, onOpen, tier }: {
  connection: AiConnection;
  onOpen: () => void;
  /** The OpenAI tier, stated where it applies; it is changed beside the key. */
  tier: ServiceTier["value"];
}) {
  const { state, current } = connection;
  // The plan's status asks Claude Code or ChatGPT for usage and takes a few
  // seconds; the connection itself is shown at once, its status as pending.
  if (!state) {
    const option = current ? OPTIONS[current.connection] : undefined;
    return (
      <div className="settings-row settings-connection-row" aria-busy="true">
        <span className={`settings-connection-tile${current ? ` is-${current.connection}` : ""}`}>{option ? <option.Glyph /> : null}</span>
        <span className="settings-row-text">
          <span className="settings-row-title">
            <strong>{option?.name ?? "AI connection"}</strong>
            <span className="settings-status-chip is-checking"><i />Checking…</span>
          </span>
          <small>{current && isSubscription(current.connection) ? "Checking plan and usage…" : "Checking…"}</small>
        </span>
        <button type="button" className="settings-primary-button" disabled>Change</button>
      </div>
    );
  }
  const option = OPTIONS[state.connection];
  const connected = ready(state, state.connection);
  const plan = subscription(state, state.connection);
  const detail = isSubscription(state.connection)
    ? plan?.usage ? <UsageLine usage={plan.usage} /> : plan?.message ?? `Uses your ${option.short} plan’s limits.`
    : state.connection === "openai-api"
      ? <>{OPTIONS[state.connection].about} · <b>{TIER_LABEL[tier]} tier</b></>
      : OPTIONS[state.connection].about;
  return (
    <div className="settings-row settings-connection-row">
      <span className={`settings-connection-tile is-${state.connection}`}><option.Glyph /></span>
      <span className="settings-row-text">
        <span className="settings-row-title">
          <strong>{option.name}</strong>
          <span className={`settings-status-chip${connected ? "" : " is-unavailable"}`}><i />{connected ? "Connected" : "Needs attention"}</span>
        </span>
        <small>{detail}</small>
      </span>
      <button type="button" className="settings-primary-button" onClick={onOpen}>Change</button>
    </div>
  );
}

/**
 * Claude Code is an outside dependency the reader installs and keeps; say so
 * before it is needed, and when it is missing, say exactly what to run.
 * Nothing restarts: returning to the window finds an install made meanwhile.
 */
function ClaudeCodeRequirement({ install }: { install: ClaudeCodeInstall }) {
  const [copied, setCopied] = useState("");
  const code = useRef<HTMLElement>(null);
  const copy = (command: string) => {
    void navigator.clipboard.writeText(command).then(() => setCopied("Copied"), () => {
      if (code.current) getSelection()?.selectAllChildren(code.current);
      setCopied("Press ⌘C");
    });
    window.setTimeout(() => setCopied(""), 2000);
  };
  return (
    <div className="settings-requirement is-unmet">
      <p>{install.problem === "outdated" ? "Claude Code needs an update:" : "Claude Code installation is required:"}</p>
      <div className="settings-command">
        <code ref={code}>{install.command}</code>
        <button type="button" className="settings-secondary-button" onClick={() => copy(install.command)}>{copied || "Copy"}</button>
      </div>
      {install.problem === "outdated" ? <small>Installed with Homebrew? Run <code>brew upgrade claude-code</code> instead.</small> : null}
      <a className="settings-requirement-guide" href={CLAUDE_CODE.guide} target="_blank" rel="noreferrer">Installation guide</a>
    </div>
  );
}

/**
 * Every provider key in one card, then what is coming in one beside it. Keys
 * are entered only in the AI Connection window. The service tier is nested in
 * OpenAI's row because it is OpenAI's: it bills that key and no other.
 */
function ApiKeyList({ connection, state, tier }: { connection: AiConnection; state: ConnectionState; tier: ServiceTier }) {
  const coming = API_KEYS.filter((key) => !key.available);
  return (
    <>
      <div className="settings-card settings-key-list">
        {API_KEYS.filter((key) => key.available).map((key) => {
          const id = key.id as ApiConnectionId;
          const inUse = id === state.connection;
          const saved = keySaved(state, id);
          return (
            <div key={id} className="settings-key-row">
              <div className="settings-row">
                <span className="settings-row-text">
                  <strong>{key.name}</strong>
                  <small>{saved ? "Key saved" : "No key saved"} · {key.billing}</small>
                </span>
                <span className="settings-key-actions">
                  <button type="button" className="settings-secondary-button" onClick={() => connection.manage(id)}>
                    {saved ? "Replace key…" : "Add a key…"}
                  </button>
                  {inUse ? (
                    <span className="settings-status-chip"><i />In use</span>
                  ) : saved ? (
                    // A mark rather than a sentence: the row already names the
                    // provider, so the button only has to say "use this one".
                    <button
                      type="button"
                      className="settings-primary-button settings-use-button"
                      aria-label={`Use ${key.name}`}
                      title={`Use ${key.name}`}
                      disabled={connection.pending}
                      onClick={() => void connection.change(id)}
                    >
                      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" /></svg>
                    </button>
                  ) : null}
                </span>
              </div>
              {/* Only once there is a key for it to bill, and settable before
                  switching, so the key starts on the tier the reader wants. */}
              {id === "openai-api" && saved ? (
                <div className="settings-tier">
                  <span className="settings-tier-elbow" aria-hidden="true" />
                  <span className="settings-row-text">
                    <strong>Service tier</strong>
                    <small>Flex costs less but response may be slower</small>
                  </span>
                  <Segmented
                    label="OpenAI service tier"
                    className="settings-tier-toggle"
                    value={tier.value}
                    disabled={tier.pending}
                    options={[
                      { value: "standard", label: TIER_LABEL.standard },
                      { value: "flex", label: TIER_LABEL.flex },
                    ]}
                    onChange={tier.change}
                  />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {tier.error ? <div className="form-error">{tier.error}</div> : null}
      {coming.length ? (
        <section className="settings-group settings-coming" aria-labelledby="settings-coming-label">
          <h4 id="settings-coming-label">Coming soon</h4>
          <div className="settings-card">
            {coming.map((key) => (
              <div key={key.id} className="settings-row" aria-disabled="true">
                <span className="settings-row-text">
                  <strong>{key.name}</strong>
                  <small>{key.billing}</small>
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}

/**
 * "Settings — AI connection": the sheet itself, rail included, turned over to
 * choosing a connection, rather than a dialog on top of a dialog. Credentials
 * are never typed here — secrets stay out of the reader's renderer — so
 * signing in or replacing a key hands off to the AI Connection window.
 */
export function AiConnectionView({
  connection,
  onBack,
  tier,
}: {
  connection: AiConnection;
  onBack: () => void;
  tier: ServiceTier;
}) {
  const { state } = connection;
  const [rail, setRail] = useState<RailId>(state && isApiConnection(state.connection) ? "api-keys" : (state?.connection as SubscriptionId | undefined) ?? "chatgpt-oauth");
  if (!state) return null;
  // The subscription panes below; "api-keys" renders its own list instead.
  const selected: ConnectionId = rail === "api-keys" ? "openai-api" : rail;
  const option = OPTIONS[selected];
  const inUse = selected === state.connection;
  const isReady = ready(state, selected);
  const plan = subscription(state, selected);
  const install = claudeInstall(state, selected);
  const statusTitle = install ? INSTALL_LABEL[install.problem] : isReady ? "Signed in" : "Not signed in";
  const statusDetail = isReady
    ? (plan?.usage ? <UsageLine usage={plan.usage} /> : `Your ${option.short} plan’s usage limits apply.`)
    : plan?.message ?? `Sign in with the ${option.short} account whose plan you want to use.`;
  const credentialAction = isReady ? "Manage sign-in…" : `Sign in to ${option.short}…`;

  return (
    <>
      <nav className="settings-nav settings-connection-nav" aria-label="Connection type">
        <button type="button" className="settings-back" onClick={onBack}>
          <svg viewBox="0 0 14 14" aria-hidden="true"><path d="m8.75 3.5-3.5 3.5 3.5 3.5" /></svg>
          Settings
        </button>
        <h2 id="account-modal-title" className="settings-connection-heading">AI connection</h2>
        {RAIL.map((id) => {
          const keys = id === "api-keys";
          const Glyph = keys ? KeyGlyph : OPTIONS[id].Glyph;
          const inUse = keys ? isApiConnection(state.connection) : id === state.connection;
          return (
            <button
              key={id}
              type="button"
              className={rail === id ? "settings-connection-option is-active" : "settings-connection-option"}
              aria-current={rail === id ? "page" : undefined}
              onClick={() => setRail(id)}
            >
              <span className={`settings-connection-tile is-${keys ? "openai-api" : id}`}><Glyph /></span>
              <span>
                <strong>{keys ? "API keys" : OPTIONS[id].name}</strong>
                <small className={inUse ? "is-in-use" : undefined}>
                  {inUse ? <i /> : null}{railLabel(state, id)}
                </small>
              </span>
            </button>
          );
        })}
        <span className="settings-connection-foot">
          <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></svg>
          Keys stay on this Mac
        </span>
      </nav>

      <div className="account-modal-body settings-pane settings-connection-pane">
        {rail === "api-keys" ? (
          <>
            <header className="settings-pane-heading">
              <h3>API keys</h3>
              <p>Pay per use with your own provider key.</p>
            </header>
            <ApiKeyList connection={connection} state={state} tier={tier} />
          </>
        ) : (
        <>
        <header className="settings-pane-heading">
          <h3>{option.name}</h3>
          <p>{option.about}</p>
        </header>
        {install ? <ClaudeCodeRequirement install={install} /> : null}
        <div className="settings-connection-status">
          <span className={`settings-connection-tile is-${selected}`}><option.Glyph /></span>
          <span className="settings-row-text">
            <strong>{statusTitle}</strong>
            <small>{statusDetail}</small>
          </span>
          {inUse ? (
            <span className="settings-status-chip"><i />In use</span>
          ) : isReady ? (
            <button
              type="button"
              className="settings-primary-button"
              disabled={connection.pending}
              onClick={() => void connection.change(selected)}
            >
              Use {option.short}
            </button>
          ) : null}
        </div>
        {install ? null : (
          <div className="settings-connection-manage">
            <button type="button" className="settings-secondary-button" onClick={() => connection.manage(selected)}>
              {credentialAction}
            </button>
            <small>Opens Delphi’s AI Connection window, where credentials are entered.</small>
          </div>
        )}
        </>
        )}
        {/* No Done: choosing a connection is the row's own button, and
            "‹ Settings" and the close button already leave. */}
        <Messages connection={connection} />
      </div>
    </>
  );
}
