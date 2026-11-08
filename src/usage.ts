import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { resolveTarget } from "./profiles.ts";
import type { Alias, Config } from "./config.ts";
import { queryUsage } from "./usage-query.ts";

// pi-usage has no global status switch. Its Anthropic status is explicitly opt-in;
// xAI is deliberately menu-only. Do not start a query for either when disabled.
function settings() {
  try {
    const value = JSON.parse(readFileSync(join(getAgentDir(), "pi-usage.json"), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

export function formatUsage(value: any, provider: string, opts: any): string | undefined {
  if (value?.status !== "ready" || value.providerId !== provider || value.report?.providerId !== provider ||
      !Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now() || !Array.isArray(value.report.buckets)) return;
  if (provider === "anthropic") {
    const metric = Array.isArray(value.report.metrics) && value.report.metrics.find((m: any) => m?.id === "extra-usage-remaining");
    return typeof metric?.value === "number" && Number.isFinite(metric.value) ? `anthropic $${metric.value.toFixed(2)} left` : undefined;
  }
  const buckets = value.report.buckets.filter((b: any) => b?.unit === "percent" && Number.isFinite(b.remaining));
  if (!buckets.length) return;
  const label = provider === "openai-codex" ? "codex" : provider.replace(/[^a-zA-Z0-9._-]/g, "");
  const parts = buckets.slice(0, 4).map((b: any) => {
    const amount = provider === "openai-codex" && opts.codexStatusPercentage === "used"
      ? (Number.isFinite(b.used) ? b.used : 100 - b.remaining) : b.remaining;
    const percent = `${Math.max(0, Math.min(100, amount)).toFixed(0)}%`;
    const mins = b.windowMinutes;
    const window = Number.isFinite(mins) && mins > 0 ? mins === 10080 ? "wk" : mins % 1440 === 0 ? `${mins / 1440}d` : mins % 60 === 0 ? `${mins / 60}h` : `${mins}m` : "";
    const reset = provider === "openai-codex" && opts.codexStatusResetCountdown !== false && Number.isFinite(b.resetsAt)
      ? Math.max(0, Math.ceil((b.resetsAt - Date.now()) / 60000)) : undefined;
    return reset !== undefined ? `${percent} ↻ ${reset >= 60 ? `${Math.floor(reset / 60)}h${reset % 60 ? `${reset % 60}m` : ""}` : `${reset}m`}` : `${window ? `${window} ` : ""}${percent}`;
  });
  return `${label} ${parts.join(" · ")}`;
}

export function createUsageBridge(pi: ExtensionAPI, getConfig: () => Config, getActive: () => string | undefined,
  timing: { timeoutMs?: number; retryBaseMs?: number; retryMaxMs?: number; minRefreshMs?: number } = {}) {
  let generation = 0;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let failures = 0;
  const clear = (ctx: ExtensionContext) => { if (ctx.hasUI) ctx.ui.setStatus("model-profiles-usage", undefined); };
  const cancel = () => { generation++; controller?.abort(); controller = undefined; if (timer) clearTimeout(timer); timer = undefined; };
  const update = (ctx: ExtensionContext) => {
    cancel();
    clear(ctx);
    if (!running || !ctx.hasUI || !pi.events || ctx.model?.provider !== "tier") return;
    let model;
    try { model = resolveTarget(getActive(), ctx.model.id as Alias, getConfig(), ctx.modelRegistry); } catch { return; }
    const opts = settings();
    if (model.provider === "xai" || (model.provider === "anthropic" && opts.anthropicExtraUsage !== true)) return;
    const session = ctx.sessionManager;
    if (typeof session.getSessionId !== "function") return;
    const sessionId = session.getSessionId();
    const current = generation;
    const abort = new AbortController(); controller = abort;
    void queryUsage(pi, session, sessionId, model.provider, abort, timing.timeoutMs).then(outcome => {
      if (!running || current !== generation || session.getSessionId() !== sessionId) return;
      if (ctx.model?.provider !== "tier" || JSON.stringify(settings()) !== JSON.stringify(opts)) return;
      try {
        const target = resolveTarget(getActive(), ctx.model.id as Alias, getConfig(), ctx.modelRegistry);
        if (target.provider !== model.provider || target.id !== model.id) return;
      } catch { return; }
      if (controller === abort) controller = undefined;
      const result = outcome.kind === "result" ? outcome.value : undefined;
      const value = formatUsage(result, model.provider, opts);
      if (value) {
        failures = 0;
        ctx.ui.setStatus("model-profiles-usage", value);
        const expiresAt = (result as any).expiresAt as number;
        const remaining = Math.max(0, expiresAt - Date.now());
        timer = setTimeout(() => {
          if (current !== generation) return;
          clear(ctx);
          const delay = Math.max(0, (timing.minRefreshMs ?? 1000) - remaining);
          if (delay) timer = setTimeout(() => { if (current === generation) update(ctx); }, delay);
          else update(ctx);
        }, Math.min(2147483647, remaining));
      } else {
        // No service and all unavailable/malformed results are retried with capped backoff.
        // External lifecycle/model changes can trigger an earlier attempt.
        const max = timing.retryMaxMs ?? 60_000;
        const delay = outcome.kind === "no-service" ? max : Math.min(max, (timing.retryBaseMs ?? 1000) * 2 ** Math.min(failures++, 16));
        timer = setTimeout(() => { if (current === generation) update(ctx); }, delay);
      }
    }).catch(() => {});
  };
  return {
    start(ctx: ExtensionContext) { running = true; const started = ++generation; queueMicrotask(() => { if (running && started === generation) update(ctx); }); },
    update,
    stop(ctx: ExtensionContext) { running = false; cancel(); clear(ctx); },
  };
}
