import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import modelProfiles from "../index.ts";
import { ALIASES, type Config } from "../src/config.ts";
import { STATE_ENTRY } from "../src/state.ts";

type Handler = (args: string, ctx: ExtensionContext) => Promise<void>;
function harness(t: { after(fn: () => void): void }, initial?: Config | string) {
  const dir = mkdtempSync(join(tmpdir(), "profiles-integration-"));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; rmSync(dir, { recursive: true, force: true }); });
  const path = join(dir, "model-profiles.json");
  if (initial !== undefined) writeFileSync(path, typeof initial === "string" ? initial : JSON.stringify(initial));
  const commands = new Map<string, { handler: Handler; getArgumentCompletions?: (prefix: string) => unknown }>();
  const events = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
  const shortcuts = new Map<string, { handler(ctx: ExtensionContext): Promise<void> }>();
  type Virtual = { provider: string; id: string; thinkingLevels: string[]; route(request: ModelRouteRequest, ctx: ExtensionContext): unknown };
  const virtuals: Virtual[] = [];
  const entries: { type: string; customType: string; data: unknown }[] = [];
  let branch = entries;
  const notices: string[] = [];
  const statuses: (string | undefined)[] = [];
  const choices: (string | undefined)[] = [];
  const inputs: (string | undefined)[] = [];
  const physical = { provider: "p", id: "m", name: "Physical", api: "openai-completions" } as ModelRouteRequest["model"];
  const selected: unknown[] = [];
  const ctx = {
    hasUI: true, mode: "tui", model: { provider: "tier", id: "large" },
    sessionManager: { getBranch: () => branch },
    modelRegistry: {
      find: (p: string, id: string) => p === "p" && id === "m" ? physical : p === "tier" && ALIASES.includes(id as typeof ALIASES[number]) ? { provider: p, id, api: "pi-virtual" } : undefined,
      hasConfiguredAuth: () => true,
      getAll: () => [physical], getAvailable: () => [physical],
    },
    ui: {
      notify: (message: string) => notices.push(message),
      setStatus: (_key: string, value: string | undefined) => statuses.push(value),
      select: async (_title: string, options: string[]) => {
        const choice = choices.shift();
        if (choice === undefined) return undefined;
        const match = options.find(option => option === choice || option.startsWith(`○ ${choice}`) || option.startsWith(`● ${choice}`));
        assert.ok(match, `Missing UI option ${choice} in ${options}`);
        return match;
      },
      input: async () => inputs.shift(), confirm: async () => true,
    },
  } as unknown as ExtensionContext;
  const pi = {
    on: (name: string, handler: typeof events extends Map<string, infer H> ? H : never) => events.set(name, handler),
    registerCommand: (name: string, command: typeof commands extends Map<string, infer C> ? C : never) => commands.set(name, command),
    registerShortcut: (name: string, shortcut: { handler(ctx: ExtensionContext): Promise<void> }) => shortcuts.set(name, shortcut),
    registerVirtualModel: (definition: Virtual) => virtuals.push(definition),
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    setModel: async (model: unknown) => { selected.push(model); return true; },
  } as unknown as ExtensionAPI;
  modelProfiles(pi);
  return { path, ctx, entries, notices, statuses, choices, inputs, virtuals, commands, shortcuts, selected,
    branch: (name: string | null) => { branch = [{ type: "custom", customType: STATE_ENTRY, data: { profile: name } }]; },
    emit: (name: string) => events.get(name)!({}, ctx),
    run: (name: string, args = "") => commands.get(name)!.handler(args, ctx),
    disk: () => JSON.parse(readFileSync(path, "utf8")) as Config,
  };
}
const profile = { large: "p/m", medium: "p/m", small: "p/m" };
const config = (): Config => ({ version: 1, defaultProfile: "alpha", lastActiveProfile: "beta", profiles: { alpha: { ...profile }, beta: { ...profile }, draft: {} } });

test("registers stable aliases, commands and shortcuts; activation persists without selecting another model", async t => {
  const h = harness(t, config());
  assert.deepEqual(h.virtuals.map(v => `${v.provider}/${v.id}`), ["tier/large", "tier/medium", "tier/small"]);
  assert.deepEqual([...h.commands.keys()], ["model-profile", "model-profiles", "tier"]);
  assert.equal(h.shortcuts.size, 2);
  assert.ok(h.virtuals.every(v => v.thinkingLevels.includes("off") && v.thinkingLevels.includes("xhigh")));
  h.emit("session_start");
  assert.deepEqual(h.entries.at(-1)?.data, { profile: "beta" });
  await h.run("model-profile", " alpha ");
  assert.equal(h.disk().lastActiveProfile, "alpha");
  assert.equal(h.selected.length, 0);
  assert.match(h.statuses.at(-1)!, /alpha · large → p\/m/);
  assert.deepEqual(h.commands.get("model-profile")!.getArgumentCompletions!("a"), [{ value: "alpha", label: "alpha" }]);
  await h.run("model-profile", "next");
  assert.equal(h.disk().lastActiveProfile, "beta");
  await h.run("model-profile", "next");
  assert.equal(h.disk().lastActiveProfile, "alpha");
  await h.run("model-profile", "draft");
  assert.match(h.notices.at(-1)!, /missing mapping/);
  await h.run("tier", "small");
  assert.equal(h.selected.length, 1);
  await h.run("tier", "bogus");
  assert.match(h.notices.at(-1)!, /Unknown alias/);
});

test("branch restores pin exact profiles, report deleted profiles, and route against restored state", t => {
  const h = harness(t, config());
  h.emit("session_start");
  h.branch("alpha"); h.emit("session_tree");
  assert.match(h.statuses.at(-1)!, /^alpha/);
  h.branch("deleted"); h.emit("session_tree");
  assert.match(h.statuses.at(-1)!, /^deleted/);
  assert.match(h.notices.at(-1)!, /Unknown profile/);
  assert.equal(h.entries.length, 1);
  const req = { reason: "user", thinkingLevel: "high", messages: [] } as unknown as ModelRouteRequest;
  assert.throws(() => h.virtuals[0]!.route(req, h.ctx), /missing mapping/);
  h.branch("beta"); h.emit("session_tree");
  assert.equal((h.virtuals[0]!.route(req, h.ctx) as { model: { id: string } }).model.id, "m");
});

test("invalid last selection falls back to valid default", t => {
  const c = config(); c.lastActiveProfile = "draft";
  const h = harness(t, c); h.emit("session_start");
  assert.deepEqual(h.entries.at(-1)?.data, { profile: "alpha" });
});

test("restored null branch pins no selection instead of falling back to global profiles", t => {
  const h = harness(t, config());
  h.branch(null);
  h.emit("session_start");
  assert.match(h.statuses.at(-1)!, /^no profile/);
  assert.equal(h.entries.length, 0);
  assert.equal(h.disk().lastActiveProfile, "beta");
  const req = { reason: "user", thinkingLevel: "high", messages: [] } as unknown as ModelRouteRequest;
  assert.throws(() => h.virtuals[0]!.route(req, h.ctx), /missing mapping/);
  h.branch("alpha"); h.emit("session_tree");
  assert.match(h.statuses.at(-1)!, /^alpha/);
  h.branch(null); h.emit("session_tree");
  assert.match(h.statuses.at(-1)!, /^no profile/);
  assert.equal(h.entries.length, 0);
  assert.throws(() => h.virtuals[0]!.route(req, h.ctx), /missing mapping/);
});

test("malformed configuration blocks routing and writes until explicit successful reload", async t => {
  const h = harness(t, "{broken"); h.emit("session_start");
  assert.match(h.notices.at(-1)!, /preserved/);
  assert.throws(() => h.virtuals[0]!.route({} as ModelRouteRequest, h.ctx), /preserved/);
  writeFileSync(h.path, JSON.stringify(config()));
  h.choices.push("Reload configuration from disk", "Close");
  await h.run("model-profiles");
  await h.run("model-profile", "alpha");
  assert.equal(h.disk().lastActiveProfile, "alpha");
});

test("UI drives create, duplicate, rename, default, edit, delete and quick activation through real controller", async t => {
  const h = harness(t, config()); h.emit("session_start");
  h.inputs.push("new", "copy", "renamed");
  h.choices.push("Create", "Save", "Duplicate", "alpha", "Rename", "copy", "Set default", "renamed", "Edit", "renamed", "Save", "Delete", "new", "Close");
  await h.run("model-profiles");
  const saved = h.disk();
  assert.equal(saved.defaultProfile, "renamed");
  assert.deepEqual(saved.profiles.renamed, profile);
  assert.ok(!Object.hasOwn(saved.profiles, "copy"));
  assert.ok(!Object.hasOwn(saved.profiles, "new"));
  h.choices.push("renamed");
  await h.run("model-profile");
  assert.equal(h.disk().lastActiveProfile, "renamed");
  assert.deepEqual(h.entries.at(-1)?.data, { profile: "renamed" });
});

test("empty configuration reports setup guidance and cycle failure", async t => {
  const h = harness(t); h.emit("session_start");
  assert.match(h.notices.at(-1)!, /No model profiles configured/);
  await h.run("model-profile", "next");
  assert.match(h.notices.at(-1)!, /No valid profiles/);
});

test("failed persistence does not change active profile or append a branch entry", async t => {
  const h = harness(t, config()); h.emit("session_start");
  const changed = config(); changed.defaultProfile = "beta";
  writeFileSync(h.path, JSON.stringify(changed));
  const count = h.entries.length;
  await h.run("model-profile", "alpha");
  assert.match(h.notices.at(-1)!, /conflict/);
  assert.equal(h.entries.length, count);
  h.emit("model_select");
  assert.match(h.statuses.at(-1)!, /^beta/);
  assert.equal(h.disk().defaultProfile, "beta");
});

test("renaming and deleting active profiles update persisted references and branch pins", async t => {
  const h = harness(t, config()); h.emit("session_start");
  h.inputs.push("renamed");
  h.choices.push("Rename", "beta", "Close");
  await h.run("model-profiles");
  assert.equal(h.disk().lastActiveProfile, "renamed");
  assert.deepEqual(h.entries.at(-1)?.data, { profile: "renamed" });
  h.choices.push("Delete", "renamed", "alpha", "Close");
  await h.run("model-profiles");
  assert.ok(!Object.hasOwn(h.disk().profiles, "renamed"));
  assert.equal(h.disk().lastActiveProfile, "alpha");
  assert.deepEqual(h.entries.at(-1)?.data, { profile: "alpha" });
});
