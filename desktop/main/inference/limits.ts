/**
 * ChatGPT plan usage, as the subscription endpoint reports it on every response.
 *
 * A usage-limit rejection carries its reset time. Until then the bridge answers
 * locally with the same message instead of sending another request, so a job
 * retry, a drained queue or a reader pressing Retry cannot hammer the account.
 */
export interface UsageWindow { usedPercent: number; resetAt?: number; windowMinutes?: number }
export interface UsageSnapshot { plan?: string; primary?: UsageWindow; secondary?: UsageWindow; blockedUntil?: number }
export interface LimitRejection { status: 429; retryAfter: number; message: string; code: "usage_limit_reached" }

function window(headers: Headers, name: "primary" | "secondary"): UsageWindow | undefined {
  const used = Number(headers.get(`x-codex-${name}-used-percent`));
  const minutes = Number(headers.get(`x-codex-${name}-window-minutes`));
  if (!Number.isFinite(used) || !minutes) return undefined;
  const reset = Number(headers.get(`x-codex-${name}-reset-at`));
  return { usedPercent: used, windowMinutes: minutes, ...(reset > 0 ? { resetAt: reset * 1000 } : {}) };
}

/** One window of the usage endpoint's `rate_limit`, as Codex reads it. */
function reportedWindow(value: any): UsageWindow | undefined {
  const used = Number(value?.used_percent);
  const seconds = Number(value?.limit_window_seconds);
  if (!value || !Number.isFinite(used) || !(seconds > 0)) return undefined;
  const reset = Number(value.reset_at);
  return { usedPercent: used, windowMinutes: Math.round(seconds / 60), ...(reset > 0 ? { resetAt: reset * 1000 } : {}) };
}

export function resetText(at: number): string {
  return new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function limitMessage(resetAt: number | undefined, plan?: string, provider = "ChatGPT"): string {
  const which = plan ? `your ${provider} ${plan} plan` : `your ${provider} plan`;
  return resetAt
    ? `You have reached the usage limit for ${which}. It resets ${resetText(resetAt)}; Delphi will not send AI requests before then. Your library and queued work are kept.`
    : `You have reached the usage limit for ${which}. Delphi will retry later; your library and queued work are kept.`;
}

export class SubscriptionLimits {
  private usage: UsageSnapshot = {};
  private now: () => number;
  private provider: string;
  constructor(now: () => number = Date.now, provider = "ChatGPT") { this.now = now; this.provider = provider; }

  /** A different account cannot inherit the previous account’s quota or plan. */
  reset(): void { this.usage = {}; }

  observe(headers: Headers): void {
    const plan = headers.get("x-codex-plan-type") ?? undefined;
    const primary = window(headers, "primary");
    const secondary = window(headers, "secondary");
    if (plan || primary || secondary) this.usage = { ...this.usage, ...(plan ? { plan } : {}), ...(primary ? { primary } : {}), ...(secondary ? { secondary } : {}) };
  }

  /** The usage endpoint's answer: the whole current picture, so a window it omits is gone. */
  report(body: unknown): void {
    if (!body || typeof body !== "object") return;
    const { plan_type: plan, rate_limit: limit } = body as { plan_type?: unknown; rate_limit?: any };
    if (!limit || typeof limit !== "object") return;
    const { blockedUntil } = this.usage;
    const primary = reportedWindow(limit.primary_window);
    const secondary = reportedWindow(limit.secondary_window);
    this.usage = { ...(typeof plan === "string" && plan ? { plan } : this.usage.plan ? { plan: this.usage.plan } : {}),
      ...(primary ? { primary } : {}), ...(secondary ? { secondary } : {}), ...(blockedUntil ? { blockedUntil } : {}) };
  }

  /** Record a usage-limit rejection and return what the backend should see. */
  reject(body: unknown, headers: Headers): LimitRejection {
    this.observe(headers);
    const error = (body && typeof body === "object" ? (body as any).error : undefined) ?? {};
    const now = this.now();
    const at = Number(error.resets_at) > 0 ? Number(error.resets_at) * 1000
      : Number(error.resets_in_seconds) > 0 ? now + Number(error.resets_in_seconds) * 1000
      : [this.usage.primary, this.usage.secondary].filter(w => w && w.usedPercent >= 100 && w.resetAt).map(w => w!.resetAt!).sort((a, b) => b - a)[0];
    if (at && at > now) this.usage.blockedUntil = at;
    return this.check() ?? { status: 429, retryAfter: 60, message: limitMessage(undefined, this.usage.plan, this.provider), code: "usage_limit_reached" };
  }

  /** A rejection to return without contacting the provider, while a known limit lasts. */
  check(): LimitRejection | undefined {
    const until = this.usage.blockedUntil;
    if (!until) return undefined;
    const now = this.now();
    if (now >= until) { delete this.usage.blockedUntil; return undefined; }
    return { status: 429, retryAfter: Math.ceil((until - now) / 1000), message: limitMessage(until, this.usage.plan, this.provider), code: "usage_limit_reached" };
  }

  snapshot(): UsageSnapshot { this.check(); return structuredClone(this.usage); }
}

/** Whether a 429 body is the plan limit rather than a short-lived rate limit. */
export function isUsageLimit(body: unknown): boolean {
  const error = body && typeof body === "object" ? (body as any).error : undefined;
  return Boolean(error && [error.type, error.code].some(value => value === "usage_limit_reached" || value === "usage_not_included"));
}
