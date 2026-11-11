import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import modelProfiles from "../index.ts";
import { ALIASES, type Config } from "../src/config.ts";
import { STATE_ENTRY } from "../src/state.ts";
import { DirectoryStore } from "../src/directory.ts";

type Handler = (args: string, ctx: ExtensionContext) => Promise<void>;
function harness(t: { after(fn: () => void): void }, initial?: Config | string, shared?: string) {
  const dir = shared ?? mkdtempSync(join(tmpdir(), "profiles-integration-"));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; if (!shared) rmSync(dir, { recursive: true, force: true }); });
  const path = join(dir, "model-profiles.json");
  const cwd = mkdtempSync(join(tmpdir(), "profiles-cwd-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const directories = new DirectoryStore(join(dir, "model-profile-directories.json"));
  const agentDir = dir;
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
    hasUI: true, mode: "tui", cwd, model: { provider: "tier", id: "large" },
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
  return { path, cwd, agentDir, ctx, entries, notices, statuses, choices, inputs, virtuals, commands, shortcuts, selected,
    branch: (name: string | null) => { branch = [{ type: "custom", customType: STATE_ENTRY, data: { profile: name } }]; },
    emit: (name: string) => events.get(name)!({}, ctx),
    run: (name: string, args = "") => commands.get(name)!.handler(args, ctx),
    disk: () => JSON.parse(readFileSync(path, "utf8")) as Config,
    dir: () => directories.read(cwd),
    setDir: (name: string | null) => directories.write(cwd, name),
  };
}
const profile = { large: "p/m", medium: "p/m", small: "p/m" };
const config = (): Config => ({ version: 1, defaultProfile: "alpha", profiles: { alpha: { ...profile }, beta: { ...profile }, draft: {} } });

test("registers stable aliases, commands and shortcuts; activation persists without selecting another model", async t => {
  const h = harness(t, config());
  assert.deepEqual(h.virtuals.map(v => `${v.provider}/${v.id}`), ["tier/large", "tier/medium", "tier/small"]);
  assert.deepEqual([...h.commands.keys()], ["model-profile", "model-profiles", "tier"]);
  assert.equal(h.shortcuts.size, 2);
  assert.ok(h.virtuals.every(v => v.thinkingLevels.includes("off") && v.thinkingLevels.includes("xhigh")));
  h.setDir("beta");
  h.emit("session_start");
  assert.equal(h.dir(), "beta");
  await h.run("model-profile", " alpha ");
  assert.equal(h.dir(), "alpha");
  assert.equal(h.selected.length, 0);
  assert.match(h.statuses.at(-1)!, /alpha · tier\/large → p\/m/);
  assert.deepEqual(h.commands.get("model-profile")!.getArgumentCompletions!("a"), [{ value: "alpha", label: "alpha" }]);
  await h.run("model-profile", "next");
  assert.equal(h.dir(), "beta");
  await h.run("model-profile", "next");
  assert.equal(h.dir(), "alpha");
  await h.run("model-profile", "draft");
  assert.match(h.notices.at(-1)!, /missing mapping/);
  await h.run("tier", "small");
  assert.equal(h.selected.length, 1);
  await h.run("tier", "bogus");
  assert.match(h.notices.at(-1)!, /Unknown alias/);
});

test("directory profile restores, reports deleted profiles, and routes against the restored state", t => {
  const h = harness(t, config());
  h.setDir("alpha");
  h.emit("session_start");
  assert.match(h.statuses.at(-1)!, /^alpha/);
  h.setDir("deleted"); h.emit("session_tree");
  assert.match(h.statuses.at(-1)!, /^deleted/);
  assert.match(h.notices.at(-1)!, /Unknown profile/);
  const req = { reason: "user", thinkingLevel: "high", messages: [] } as unknown as ModelRouteRequest;
  assert.throws(() => h.virtuals[0]!.route(req, h.ctx), /Unknown profile|missing mapping/);
  h.setDir("beta"); h.emit("session_tree");
  assert.equal((h.virtuals[0]!.route(req, h.ctx) as { model: { id: string } }).model.id, "m");
});

test("two directories keep independent profiles and session entries do not override them", async t => {
  const shared = mkdtempSync(join(tmpdir(), "profiles-shared-"));
  t.after(() => rmSync(shared, { recursive: true, force: true }));
  const a = harness(t, config(), shared);
  const b = harness(t, config(), shared);
  a.setDir("alpha"); b.setDir("beta");
  a.emit("session_start"); b.emit("session_start");
  assert.match(a.statuses.at(-1)!, /^alpha/);
  assert.match(b.statuses.at(-1)!, /^beta/);
  a.branch("beta"); a.emit("session_tree");
  assert.match(a.statuses.at(-1)!, /^alpha/, "session entry must not override the directory");
  await b.run("model-profile", "alpha");
  assert.equal(b.dir(), "alpha");
  assert.equal(a.dir(), "alpha", "a switches only when it is asked to");
  assert.match(a.statuses.at(-1)!, /^alpha/);
});

test("legacy lastActiveProfile is ignored; invalid directory choice falls back to nothing, not to global state", t => {
  const legacy = { ...config(), lastActiveProfile: "beta" } as Config;
  const h = harness(t, legacy);
  h.setDir("draft");
  h.emit("session_start");
  assert.match(h.notices.at(-1)!, /missing mapping/);
  assert.match(h.statuses.at(-1)!, /^draft/);
  const fresh = harness(t, legacy);
  fresh.emit("session_start");
  assert.match(fresh.statuses.at(-1)!, /^alpha/, "no directory choice falls back to defaultProfile");
});

test("explicit null directory choice pins no profile instead of falling back to global defaults", t => {
  const h = harness(t, config());
  h.setDir(null);
  h.emit("session_start");
  assert.match(h.statuses.at(-1)!, /^no profile/);
  const req = { reason: "user", thinkingLevel: "high", messages: [] } as unknown as ModelRouteRequest;
  assert.throws(() => h.virtuals[0]!.route(req, h.ctx), /missing mapping/);
  h.setDir("alpha"); h.emit("session_tree");
  assert.match(h.statuses.at(-1)!, /^alpha/);
  h.setDir(null); h.emit("session_tree");
  assert.match(h.statuses.at(-1)!, /^no profile/);
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
  assert.equal(h.dir(), "alpha");
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
  assert.equal(h.dir(), "renamed");
  assert.equal(h.disk().lastActiveProfile, undefined, "global file never stores the active profile");
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
  // Switching a profile touches only the directory file, so it cannot conflict with the global file.
  await h.run("model-profile", "beta");
  assert.equal(h.dir(), "beta");
  assert.equal(h.disk().defaultProfile, "beta");
  // Editing the global file still conflicts and must not change the active profile.
  await h.run("model-profile", "alpha");
  assert.equal(h.dir(), "alpha");
  const external = config(); external.defaultProfile = "draft";
  writeFileSync(h.path, JSON.stringify(external));
  h.choices.push("Set default", "beta", "Close");
  await h.run("model-profiles");
  assert.match(h.notices.at(-1)!, /conflict/);
  assert.equal(h.entries.length, count + 2);
  assert.match(h.statuses.at(-1)!, /^alpha/);
  assert.equal(h.disk().defaultProfile, "draft");
});

test("renaming and deleting active profiles update persisted references and branch pins", async t => {
  const h = harness(t, config()); h.emit("session_start");
  h.inputs.push("renamed");
  h.setDir("alpha"); h.emit("session_tree");
  h.inputs.push("renamed");
  h.choices.push("Rename", "alpha", "Close");
  await h.run("model-profiles");
  assert.equal(h.dir(), "renamed");
  h.choices.push("Delete", "renamed", "beta", "Close");
  await h.run("model-profiles");
  assert.ok(!Object.hasOwn(h.disk().profiles, "renamed"));
  assert.equal(h.dir(), "beta");
});
