import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { resolveTarget, route, validateProfile, type Registry } from "../src/profiles.ts";
import { ALIASES, type Config } from "../src/config.ts";

const model = { provider: "p", id: "model/with/slashes", api: "openai-completions" } as ModelRouteRequest["model"];
const config: Config = { version: 1, profiles: { work: Object.fromEntries(ALIASES.map(a => [a, "p/model/with/slashes"])) } };
const registry: Registry = { find: (provider, id) => provider === "p" && id === model.id ? model : undefined, hasConfiguredAuth: () => true };
const request = (extra: Partial<ModelRouteRequest> = {}): ModelRouteRequest => ({ model, reason: "user", thinkingLevel: "high", messages: [], ...extra });

test("physical resolution preserves slashes and validates every alias", () => {
  for (const alias of ALIASES) assert.equal(resolveTarget("work", alias, config, registry), model);
  assert.doesNotThrow(() => validateProfile("work", config, registry));
  assert.throws(() => validateProfile("absent", config, registry), /Unknown profile/);
  for (const alias of ALIASES) {
    const broken = structuredClone(config);
    delete broken.profiles.work![alias];
    assert.throws(() => validateProfile("work", broken, registry), new RegExp(`tier/${alias}.*missing mapping`));
  }
});

test("resolution failures are actionable and never silently fall back", () => {
  assert.throws(() => resolveTarget(undefined, "large", config, registry), /\(none\).*missing mapping.*model-profiles/);
  assert.throws(() => resolveTarget("work", "large", config, { ...registry, find: () => undefined }), /catalog.*Edit/);
  assert.throws(() => resolveTarget("work", "large", config, { ...registry, find: () => ({ ...model, api: "pi-virtual" }) }), /virtual-to-virtual/);
  assert.throws(() => resolveTarget("work", "large", config, { ...registry, hasConfiguredAuth: () => false }), /credentials.*login/);
});

test("new user and direct requests resolve current profile, retaining requested thinking", () => {
  const old = { ...model, id: "old" };
  for (const reason of ["user", "direct"] as const) {
    assert.deepEqual(route("small", "work", config, registry, request({ reason, previous: { model: old, thinkingLevel: "low" } })), { model, thinkingLevel: "high" });
    assert.throws(() => route("large", "missing", config, registry, request({ reason, previous: { model: old } })), /missing mapping/);
  }
});

test("retry prefers failed route; continuation prefers previous; sticky routes bypass changed config/auth", () => {
  const previous = { model: { ...model, id: "previous" }, thinkingLevel: "low" as const };
  const failed = { model: { ...model, id: "failed" }, thinkingLevel: "off" as const, message: {} as NonNullable<ModelRouteRequest["failed"]>["message"] };
  const unavailable: Registry = { find: () => { throw new Error("must not resolve"); }, hasConfiguredAuth: () => false };
  assert.deepEqual(route("large", undefined, config, unavailable, request({ reason: "retry", previous, failed })), { model: failed.model, thinkingLevel: "off" });
  assert.deepEqual(route("large", undefined, config, unavailable, request({ reason: "continuation", previous, failed })), previous);
  assert.deepEqual(route("large", undefined, config, unavailable, request({ reason: "retry", previous })), previous);
  assert.deepEqual(route("large", undefined, config, unavailable, request({ reason: "retry", previous, failed: { model: failed.model, message: failed.message } })), { model: failed.model, thinkingLevel: "high" });
  for (const reason of ["retry", "continuation"] as const) {
    assert.deepEqual(route("large", undefined, config, unavailable, request({ reason, previous: { model } })), { model, thinkingLevel: "high" });
    assert.deepEqual(route("large", "work", config, registry, request({ reason })), { model, thinkingLevel: "high" });
    assert.throws(() => route("large", undefined, config, registry, request({ reason })), /missing mapping/);
  }
  assert.deepEqual(route("large", "work", config, registry, request({ reason: "continuation", failed })), { model, thinkingLevel: "high" });
});
