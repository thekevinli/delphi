/**
 * The reader's ChatGPT sign-in, as the setup window sees it.
 *
 * Nothing here names a model: the requirement is what `desktopTaskModels`
 * asks of a subscription (the gpt-6 pair, or its named fallback while plans
 * lack it) plus the composer's efforts for those choices, so changing
 * Delphi's models changes both connections at once. A missing model is
 * reported, never silently swapped.
 */
import { DirectOAuth, type CredentialStore } from "./direct-oauth.ts";
import { parseCatalog, type CatalogModel } from "./direct-provider.ts";
import { resetText, SubscriptionLimits, type UsageSnapshot } from "./limits.ts";
import { desktopTaskModels, modelSettings } from "../backend.ts";
import { CHAT_MODEL_EFFORTS } from "../../frontend/app/lib/chat-model-policy.ts";

type Requirement = Record<string, string[]>;

/** Task models are required; composer choices a plan lacks are only reported. */
export function modelRequirements(): { required: Requirement; composer: Requirement } {
  const required: Requirement = {};
  for (const { model, effort } of Object.values(desktopTaskModels("chatgpt-oauth"))) required[model] = [...new Set([...(required[model] ?? []), effort])];
  const choices = modelSettings("chatgpt-oauth").MODEL_CHOICES.split(",");
  return { required, composer: Object.fromEntries(choices.map(model => [model, CHAT_MODEL_EFFORTS[model] ?? []])) };
}

export function missingModels(catalog: CatalogModel[], requirement: Requirement): string[] {
  return Object.entries(requirement).flatMap(([model, efforts]) => {
    const offered = catalog.find(entry => entry.model === model);
    if (!offered) return [model];
    const missing = efforts.filter(effort => !offered.efforts.includes(effort));
    return missing.length ? [`${model} at ${missing.join(", ")} effort`] : [];
  });
}

/** What the Model row shows of a plan: its longest window only, as remaining use. */
export interface UsageSummary { plan?: string; percentLeft?: number; weekly?: boolean; resets?: string; blockedUntil?: string }
export interface ConnectionStatus { connected: boolean; signingIn: boolean; message?: string; usage?: UsageSummary }

const PLAN_NAMES: Record<string, string> = { prolite: "Pro Lite" };

export function usageSummary(usage: UsageSnapshot): UsageSummary | undefined {
  const plan = usage.plan ? PLAN_NAMES[usage.plan] ?? usage.plan.charAt(0).toUpperCase() + usage.plan.slice(1) : undefined;
  const longest = [usage.primary, usage.secondary].filter(w => w !== undefined).sort((a, b) => (b.windowMinutes ?? 0) - (a.windowMinutes ?? 0))[0];
  const summary: UsageSummary = {
    ...(plan ? { plan } : {}),
    ...(longest ? { percentLeft: Math.max(0, Math.min(100, Math.round(100 - longest.usedPercent))), weekly: (longest.windowMinutes ?? 0) >= 7 * 1440 } : {}),
    ...(longest?.resetAt ? { resets: new Date(longest.resetAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) } : {}),
    ...(usage.blockedUntil ? { blockedUntil: resetText(usage.blockedUntil) } : {}),
  };
  return Object.keys(summary).length ? summary : undefined;
}

/** Node reports an unreachable host as a bare "fetch failed"; say what it means. */
function readerMessage(error: unknown): string {
  if (error instanceof TypeError || (error as Error)?.name === "TimeoutError") return "Can’t reach ChatGPT. Check your internet.";
  return error instanceof Error ? error.message : String(error);
}

export class SubscriptionConnection {
  readonly oauth: DirectOAuth;
  readonly limits = new SubscriptionLimits();
  private pending?: { cancel: () => void };
  private loginError?: string;
  private verified = false;
  private notice?: string;
  private openBrowser: (url: string) => Promise<void>;
  constructor(store: CredentialStore, openBrowser: (url: string) => Promise<void>) {
    this.oauth = new DirectOAuth(store);
    this.openBrowser = openBrowser;
  }

  /** Confirms the account offers every model Delphi uses; throws a reader-facing reason otherwise. */
  private async verify(): Promise<void> {
    if (this.verified) return;
    const response = await this.oauth.models();
    this.limits.observe(response.headers);
    if (!response.ok) { await response.body?.cancel(); throw new Error("Could not load this account's ChatGPT models. Retry, or sign in again."); }
    const catalog = parseCatalog(await response.json());
    const { required, composer } = modelRequirements();
    const missing = missingModels(catalog, required);
    if (missing.length) throw new Error(`This ChatGPT plan does not offer ${missing.join("; ")}, which Delphi's AI work needs. Use an API key instead.`);
    const unavailable = missingModels(catalog, composer);
    this.notice = unavailable.length ? `Not included in this plan: ${unavailable.join("; ")}. Choosing it in chat will explain that.` : undefined;
    this.verified = true;
  }

  /** Asks the plan for its usage now; a failure keeps what the last response reported. */
  private async refreshUsage(): Promise<void> {
    try {
      const response = await this.oauth.usage();
      if (response.ok) this.limits.report(await response.json());
      else await response.body?.cancel();
    } catch {}
  }

  /** `refreshUsage` is for a surface the reader just opened; polling callers leave it off. */
  async status({ refreshUsage = false } = {}): Promise<ConnectionStatus> {
    if (process.platform !== "darwin") return { connected: false, signingIn: false, message: "ChatGPT sign-in is available in Delphi for macOS." };
    if (this.pending) return { connected: false, signingIn: true };
    try { await this.oauth.credentials(); }
    catch (error) { return { connected: false, signingIn: false, message: this.loginError ?? (this.verified ? (error as Error).message : undefined) }; }
    try { await this.verify(); }
    catch (error) { return { connected: false, signingIn: false, message: readerMessage(error) }; }
    if (refreshUsage) await this.refreshUsage();
    const usage = usageSummary(this.limits.snapshot());
    return { connected: true, signingIn: false, usage, ...(this.notice ? { message: this.notice } : {}) };
  }

  async login(): Promise<void> {
    if (this.pending) throw new Error("A browser sign-in is already in progress.");
    this.loginError = undefined; this.verified = false;
    const login = await this.oauth.startLogin(this.openBrowser);
    this.pending = login;
    void login.completion.then(() => {}, error => {
      // A sign-in cancelled from Delphi is not a failure to report.
      if (this.pending === login) this.loginError = error instanceof Error ? error.message : "ChatGPT sign-in did not complete.";
    }).finally(() => { if (this.pending === login) this.pending = undefined; });
  }

  async cancel(): Promise<void> { this.pending?.cancel(); this.pending = undefined; }
  async logout(): Promise<void> { await this.cancel(); this.oauth.logout(); this.verified = false; }

  async ready(): Promise<void> {
    const status = await this.status();
    if (!status.connected) throw new Error(status.message ?? "Sign in with ChatGPT before continuing.");
  }

  stop(): void { this.pending?.cancel(); this.pending = undefined; }
}
