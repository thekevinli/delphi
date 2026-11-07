const byId = id => document.getElementById(id);
let managing = false;
let polling;
let busy = false;
let transitioning = false;
let checking = false;
let replacingKey = false;
let initialStatus = true;
let asked = 0;
let error = "";
let statusError = "";
let selected = "chatgpt-oauth";
let snapshot;
const providers = { "chatgpt-oauth": { key: "chatgpt", name: "ChatGPT", button: "choose-chatgpt", detail: "Plus or above" }, "claude-subscription": { key: "claude", name: "Claude", button: "choose-claude", detail: "Pro or above" } };
const keyPlaceholders = { openai: "Paste your OpenAI key (sk-…)", claude: "Paste your Claude API key (sk-ant-…)" };
// The API key card stands for either key connection; the provider menu picks which.
const keyConnections = { openai: "openai-api", claude: "claude-api" };
const isKeyConnection = id => Object.values(keyConnections).includes(id);
const keyProvider = () => byId("provider").value;
// A signed-in card names its plan, and a reached limit, in place of the plan it asks for.
function planDetail(account, fallback) {
  if (!account?.connected) return fallback;
  const plan = account.usage?.plan ? `${account.usage.plan} plan` : "Signed in";
  return account.usage?.blockedUntil ? `${plan} · limit reached until ${account.usage.blockedUntil}` : plan;
}
function render() {
  const provider = providers[selected];
  const account = provider ? snapshot?.[provider.key] ?? {} : {};
  const locked = busy || transitioning;
  const working = managing ? "Switching…" : "Starting Delphi…";
  const go = managing ? "Switch" : "Continue";
  byId("form").hidden = Boolean(provider);
  byId("subscription-panel").hidden = !provider;
  for (const [id, p] of Object.entries(providers)) {
    byId(p.button).setAttribute("aria-pressed", String(selected === id));
    const detail = byId(`${p.key}-detail`);
    detail.textContent = planDetail(snapshot?.[p.key], p.detail);
    detail.classList.toggle("is-limited", Boolean(snapshot?.[p.key]?.connected && snapshot[p.key].usage?.blockedUntil));
  }
  byId("choose-api").setAttribute("aria-pressed", String(isKeyConnection(selected)));
  // Each provider keeps its own key; this one's is the one that matters here.
  const savedKey = Boolean(snapshot?.keys?.[keyProvider()]) && !replacingKey;
  byId("api-detail").textContent = savedKey ? "Saved on this Mac" : "OpenAI or Claude, pay per use";
  for (const id of ["choose-chatgpt", "choose-claude", "choose-api"]) byId(id).disabled = locked;
  const missing = selected === "claude-subscription" && account.installed === false;
  // A status message is a failure to report only while nothing else explains the state.
  const message = error || statusError || (provider && !account.connected && !missing ? account.message ?? "" : "");
  if (byId("error").textContent !== message) byId("error").textContent = message;
  if (provider) {
    const install = missing ? account.install : undefined;
    byId("claude-install").hidden = !install;
    if (install) {
      byId("claude-install-lead").textContent = install.problem === "outdated" ? "Claude Code needs an update:" : "Claude Code installation is required:";
      byId("claude-install-command").textContent = install.command;
    }
    const main = byId("subscription-go");
    main.hidden = missing;
    main.textContent = transitioning ? working : account.connected ? go : account.signingIn ? "Finish in your browser…" : `Continue with ${provider.name}`;
    main.disabled = locked || Boolean(account.signingIn);
    main.classList.toggle("is-busy", transitioning || Boolean(account.signingIn));
    announce(main);
    const alt = byId("subscription-alt");
    alt.hidden = transitioning || !(account.connected || account.signingIn);
    alt.textContent = account.connected ? "Sign out" : "Cancel";
    alt.disabled = busy;
    byId("install-guide").disabled = locked;
    return;
  }
  // The provider menu stays: a saved key for one provider must not hide the other.
  byId("key").hidden = savedKey;
  byId("key").placeholder = keyPlaceholders[keyProvider()];
  byId("new-key").hidden = !savedKey || transitioning;
  const submit = byId("go");
  submit.textContent = transitioning ? working : checking ? "Checking key…" : go;
  submit.disabled = locked;
  submit.classList.toggle("is-busy", transitioning || checking);
  announce(submit);
  // Read-only rather than disabled, so a refused key keeps the caret where it was.
  byId("key").readOnly = locked;
  for (const id of ["provider", "new-key"]) byId(id).disabled = locked;
}
// Work in progress lives on the button; say it aloud as well.
function announce(button) {
  const text = button.classList.contains("is-busy") ? button.textContent : "";
  if (byId("progress").textContent !== text) byId("progress").textContent = text;
}
function select(id) {
  // A choice made before the first status arrives is kept over the stored one.
  selected = id; initialStatus = false; replacingKey = false; error = ""; render();
  if (isKeyConnection(id)) (byId("key").hidden ? byId("go") : byId("key")).focus();
  else if (id === "claude-subscription" && !busy && !transitioning) void refresh();
}
byId("choose-api").onclick = () => select(keyConnections[keyProvider()]);
for (const [id, provider] of Object.entries(providers)) byId(provider.button).onclick = () => select(id);
async function command(action) {
  const result = await window.delphi.connection({ action, to: selected });
  if (!result.ok) throw new Error(result.message || "Could not update the connection.");
  return result;
}
// A failed read is reported until the next one succeeds.
async function refresh() {
  const asking = ++asked;
  let status;
  try { status = await command("status"); }
  catch (e) { status = e instanceof Error ? e : new Error(String(e)); }
  // A reply overtaken by a later one (a sign-in started meanwhile) is out of date.
  if (asking !== asked) return;
  if (status instanceof Error) { statusError = status.message; render(); return; }
  statusError = "";
  snapshot = status;
  managing = snapshot.managing;
  if (initialStatus) {
    selected = snapshot.selected ?? "chatgpt-oauth"; initialStatus = false;
    if (selected === "claude-api") byId("provider").value = "claude";
  }
  if (managing) { byId("heading").textContent = "AI connection"; document.title = "AI connection"; }
  byId("lede").hidden = managing;
  render();
  if (!snapshot.chatgpt?.signingIn && !snapshot.claude?.signingIn) clearInterval(polling);
}
async function run(action) {
  if (busy || transitioning) return;
  busy = true; error = ""; render();
  try { await action(); } catch (e) { error = e.message || String(e); }
  finally { busy = false; render(); }
}
byId("subscription-go").onclick = () => {
  const account = snapshot?.[providers[selected].key];
  if (account?.connected) return run(async () => {
    try { await command("save"); transitioning = true; }
    catch (e) { await refresh(); throw e; }
  });
  return run(async () => {
    await command("login"); await refresh();
    clearInterval(polling);
    polling = setInterval(() => refresh(), 2000);
  });
};
byId("subscription-alt").onclick = () => {
  const signingIn = snapshot?.[providers[selected].key]?.signingIn;
  return run(async () => { await command(signingIn ? "cancel" : "logout"); await refresh(); });
};
byId("install-guide").onclick = () => run(() => command("install"));
byId("copy-install").onclick = async () => {
  const text = byId("claude-install-command").textContent;
  try { await navigator.clipboard.writeText(text); byId("copy-install").textContent = "Copied"; }
  catch { getSelection()?.selectAllChildren(byId("claude-install-command")); byId("copy-install").textContent = "Press ⌘C"; }
  setTimeout(() => { byId("copy-install").textContent = "Copy"; }, 2000);
};
// Claude Code is installed, updated or removed in Terminal while this window
// waits: look again whenever the reader comes back, rather than asking them to restart.
window.addEventListener("focus", () => {
  if (selected === "claude-subscription" && !busy && !transitioning && !snapshot?.claude?.signingIn) void refresh();
});
byId("provider").onchange = () => {
  error = ""; replacingKey = false; selected = keyConnections[keyProvider()]; render();
  (byId("key").hidden ? byId("go") : byId("key")).focus();
};
byId("new-key").onclick = () => { replacingKey = true; render(); byId("key").focus(); };
byId("form").addEventListener("submit", event => {
  event.preventDefault();
  if (!byId("key").hidden) {
    if (!byId("key").value.trim()) { error = "Paste a key first."; render(); byId("key").focus(); return; }
    void run(async () => {
      checking = true; render();
      try {
        const result = await window.delphi.saveSetup({ provider: keyProvider(), apiKey: byId("key").value.trim() });
        if (!result.ok) throw new Error(result.message || "That key was refused.");
        byId("key").value = "";
        transitioning = true;
      } finally { checking = false; }
    }).then(() => { if (error) byId("key").focus(); });
  } else void run(async () => { await command("use-saved-key"); transitioning = true; });
});
window.addEventListener("unload", () => clearInterval(polling));
void refresh();
