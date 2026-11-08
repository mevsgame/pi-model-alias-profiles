import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createUsageBridge, formatUsage } from "../src/usage.ts";

test("usage bridge queries physical provider and rejects stale responses", async () => {
  const requests: any[] = [], statuses: (string | undefined)[] = [];
  let resolve!: (result: unknown) => void;
  const pi = { events: { emit: (_: string, request: any) => { requests.push(request); request.respond(new Promise(r => { if (requests.length === 1) resolve = r; })); } } } as unknown as ExtensionAPI;
  const session = { getSessionId: () => "s" };
  const ctx = { hasUI: true, model: { provider: "tier", id: "large" }, sessionManager: session,
    modelRegistry: { find: (provider: string, id: string) => ({ provider, id, api: "real" }), hasConfiguredAuth: () => true },
    ui: { setStatus: (_: string, value: string | undefined) => statuses.push(value) } } as unknown as ExtensionContext;
  const config = { version: 1 as const, profiles: { a: { large: "openai-codex/model" } } };
  const bridge = createUsageBridge(pi, () => config, () => "a");
  bridge.start(ctx); await Promise.resolve();
  assert.equal(requests[0].providerId, "openai-codex");
  assert.equal(requests[0].session, session);
  bridge.update(ctx);
  assert.equal(requests[0].signal.aborted, true);
  resolve({ status: "ready", providerId: "openai-codex", expiresAt: Date.now() + 10000, report: { providerId: "openai-codex", buckets: [{ unit: "percent", remaining: 50 }] } });
  await Promise.resolve();
  assert.equal(statuses.at(-1), undefined);
  bridge.stop(ctx);
  assert.equal(requests[1].signal.aborted, true);
});

test("expiry refreshes and absent service retries with bounded delay", async () => {
  let count = 0;
  const statuses: (string | undefined)[] = [];
  const pi = { events: { emit: (_: string, request: any) => {
    count++;
    if (count === 1) request.respond({ status: "ready", providerId: "openai-codex", expiresAt: Date.now() + 10,
      report: { providerId: "openai-codex", buckets: [{ unit: "percent", remaining: 75 }] } });
  } } } as unknown as ExtensionAPI;
  const ctx = { hasUI: true, model: { provider: "tier", id: "large" }, sessionManager: { getSessionId: () => "s" },
    modelRegistry: { find: (provider: string, id: string) => ({ provider, id, api: "real" }), hasConfiguredAuth: () => true },
    ui: { setStatus: (_: string, value: string | undefined) => statuses.push(value) } } as unknown as ExtensionContext;
  const bridge = createUsageBridge(pi, () => ({ version: 1, profiles: { a: { large: "openai-codex/m" } } }), () => "a",
    { minRefreshMs: 1, retryMaxMs: 10 });
  bridge.start(ctx);
  await new Promise(resolve => setTimeout(resolve, 55));
  bridge.stop(ctx);
  assert.ok(count >= 3, `expected refresh and no-service retry, got ${count}`);
  assert.ok(statuses.some(value => value?.includes("75%")));
  assert.equal(statuses.at(-1), undefined);
});

test("usage formatter honors Codex percentage setting and rejects expired reports", () => {
  const result = { status: "ready", providerId: "openai-codex", expiresAt: Date.now() + 10000,
    report: { providerId: "openai-codex", buckets: [{ unit: "percent", remaining: 75, windowMinutes: 300 }] } };
  assert.equal(formatUsage(result, "openai-codex", { codexStatusPercentage: "used", codexStatusResetCountdown: false }), "codex 5h 25%");
  assert.equal(formatUsage({ ...result, expiresAt: 0 }, "openai-codex", {}), undefined);
});
