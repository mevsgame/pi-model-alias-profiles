import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Runtime } from "../src/prompt-profiles/adapter/runtime.ts";

test("prompt profiles match physical model and refresh when the alias mapping changes", t => {
  const dir = mkdtempSync(join(tmpdir(), "prompt-compat-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "system-prompts");
  mkdirSync(join(root, "profiles"), { recursive: true });
  writeFileSync(join(root, "profiles", "haiku.md"), "Haiku instructions");
  writeFileSync(join(root, "config.json"), JSON.stringify({ version: 1, selection: { mode: "auto" }, profiles: { haiku: {} }, bindings: [{ id: "haiku", profile: "global:haiku", match: [{ provider: "claude-code", model: "claude-haiku-5-5" }] }] }));
  let physical = { provider: "claude-code", id: "claude-haiku-5-5" } as ExtensionContext["model"];
  const ctx = { cwd: dir, model: { provider: "tier", id: "small" }, isProjectTrusted: () => true } as unknown as ExtensionContext;
  const runtime = new Runtime({} as ExtensionAPI, dir, ".pi", () => physical);
  runtime.ensure(ctx);
  runtime.applyConfigSelection();
  assert.match(runtime.compose("base", runtime.resolve(ctx)).systemPrompt!, /Haiku instructions/);
  physical = { provider: "openai-codex", id: "gpt-6-luna" } as ExtensionContext["model"];
  assert.equal(runtime.resolve(ctx).profile, undefined);
  physical = { provider: "claude-code", id: "claude-haiku-5-5" } as ExtensionContext["model"];
  assert.ok(runtime.resolve(ctx).profile);
  runtime.selection = { mode: "off" }; runtime.invalidate();
  assert.equal(runtime.resolve(ctx).mode, "off");
});
