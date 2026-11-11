import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { ALIASES, ConfigStore, type Config, type Alias } from "./src/config.ts";
import { route, validateProfile, resolveTarget } from "./src/profiles.ts";
import promptProfiles from "./src/prompt-profiles/index.ts";
import { STATE_ENTRY } from "./src/state.ts";
import { DirectoryStore } from "./src/directory.ts";
import { manage, quickPicker, type Controller } from "./src/ui.ts";
import { createUsageBridge } from "./src/usage.ts";

export default function modelProfiles(pi: ExtensionAPI) {
  const store = new ConfigStore(join(getAgentDir(), "model-profiles.json"));
  const directories = new DirectoryStore(join(getAgentDir(), "model-profile-directories.json"));
  let config: Config = { version: 1, profiles: {} };
  let active: string | undefined;
  let loadError: unknown;
  try { config = store.load(); } catch (error) { loadError = error; }
  const report = (ctx: ExtensionContext, message: string, error = false) => {
    if (ctx.hasUI) ctx.ui.notify(message, error ? "error" : "info");
    else console.error(`[model-profiles] ${message}`);
  };
  const usage = createUsageBridge(pi, () => config, () => active);
  // Prompt-profile bindings follow the physical model, not the stable alias.
  if (typeof pi.registerFlag === "function") promptProfiles(pi, ctx => {
    if (ctx.model?.provider !== "tier" || !(ALIASES as readonly string[]).includes(ctx.model.id)) return ctx.model;
    if (loadError) throw loadError;
    return resolveTarget(active, ctx.model.id as Alias, config, ctx.modelRegistry);
  });
  const status = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    const alias = ctx.model?.provider === "tier" ? ctx.model.id as Alias : undefined;
    ctx.ui.setStatus("model-profiles", alias
      ? `${active ?? "no profile"} · tier/${alias} → ${active && config.profiles[active]?.[alias] || "(unconfigured)"}`
      : undefined);
    if (pi.events) usage.update(ctx);
  };
  const record = () => pi.appendEntry(STATE_ENTRY, { profile: active ?? null });
  const controller: Controller = {
    getConfig: () => config,
    getActive: () => active,
    activate(name, ctx) {
      validateProfile(name, config, ctx.modelRegistry);
      directories.write(ctx.cwd, name);
      active = name;
      record();
      status(ctx);
      const alias = ctx.model?.provider === "tier" ? ctx.model.id as Alias : undefined;
      report(ctx, `Profile: ${name}${alias ? `\ntier/${alias} → ${config.profiles[name]![alias]}` : ""}`);
    },
    commit(next, selection, ctx) {
      if (selection) validateProfile(selection, next, ctx.modelRegistry);
      store.save(next);
      const changed = active !== selection;
      if (changed) directories.write(ctx.cwd, selection ?? null);
      config = next;
      active = selection;
      if (changed) record();
      status(ctx);
    },
    reload(ctx) {
      config = store.load();
      loadError = undefined;
      status(ctx);
    },
  };
  // The starting directory decides the active profile; session entries are history only.
  const restore = (ctx: ExtensionContext) => {
    active = undefined;
    let saved: string | null | undefined;
    try { saved = directories.read(ctx.cwd); }
    catch (error) { report(ctx, String(error), true); status(ctx); return; }
    if (saved !== undefined) {
      active = saved ?? undefined; // Never silently replace a missing or invalid directory profile.
      try { if (saved) validateProfile(saved, config, ctx.modelRegistry); }
      catch (error) { report(ctx, String(error), true); }
    } else if (config.defaultProfile) {
      try { validateProfile(config.defaultProfile, config, ctx.modelRegistry); active = config.defaultProfile; } catch {}
    }
    status(ctx);
  };
  pi.on("session_start", (_event, ctx) => {
    restore(ctx);
    if (pi.events) usage.start(ctx);
    if (loadError) report(ctx, String(loadError), true);
    else if (!Object.keys(config.profiles).length) report(ctx, "No model profiles configured. Run /model-profiles to create your first profile.");
  });
  pi.on("session_shutdown", (_event, ctx) => { if (pi.events) usage.stop(ctx); });
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("model_select", (_event, ctx) => status(ctx));
  pi.on("agent_end", (_event, ctx) => { if (pi.events) usage.update(ctx); });
  for (const alias of ALIASES) pi.registerVirtualModel({
    provider: "tier", id: alias, name: `Tier ${alias}`,
    thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"],
    route(request, ctx) {
      if (loadError) throw loadError;
      return route(alias, active, config, ctx.modelRegistry, request);
    },
  });
  const guarded = (fn: (args: string, ctx: ExtensionContext) => Promise<void> | void) =>
    async (args: string, ctx: ExtensionContext) => {
      try { await fn(args.trim(), ctx); } catch (error) { report(ctx, String(error), true); }
    };
  const cycle = (ctx: ExtensionContext) => {
    const names = Object.keys(config.profiles).sort();
    const start = names.indexOf(active ?? "");
    for (let offset = 1; offset <= names.length; offset++) {
      const name = names[(start + offset) % names.length]!;
      try { validateProfile(name, config, ctx.modelRegistry); } catch { continue; }
      controller.activate(name, ctx);
      return;
    }
    throw new Error("No valid profiles to cycle to. Configure mappings and credentials using /model-profiles.");
  };
  pi.registerCommand("model-profile", {
    description: "Pick, activate, cycle or inspect model profiles",
    getArgumentCompletions: prefix => [...Object.keys(config.profiles).sort(), "next", "status"]
      .filter(name => name.startsWith(prefix)).map(name => ({ value: name, label: name })),
    handler: guarded(async (args, ctx) => {
      if (!args) return quickPicker(ctx, controller);
      if (args === "next") return cycle(ctx);
      if (args === "status") {
        report(ctx, `Profile: ${active ?? "(none)"}\n${ALIASES.map(alias => `tier/${alias} → ${active && config.profiles[active]?.[alias] || "(missing)"}`).join("\n")}`);
        return;
      }
      controller.activate(args, ctx);
    }),
  });
  pi.registerCommand("model-profiles", {
    description: "Create, edit, duplicate, rename and delete model profiles",
    handler: guarded((_args, ctx) => manage(ctx, controller)),
  });
  pi.registerCommand("tier", {
    description: "Select a stable model alias",
    handler: guarded(async (args, ctx) => {
      if (!args) {
        if (!ctx.hasUI) throw new Error("Use /tier large, medium or small in non-interactive modes.");
        args = await ctx.ui.select("Select model alias", [...ALIASES]) ?? "";
        if (!args) return;
      }
      if (!(ALIASES as readonly string[]).includes(args)) throw new Error(`Unknown alias "${args}". Choose large, medium or small.`);
      const model = ctx.modelRegistry.find("tier", args);
      if (!model || !await pi.setModel(model)) throw new Error(`Could not select tier/${args}.`);
      status(ctx);
    }),
  });
  pi.registerShortcut("ctrl+alt+p", {
    description: "Switch model profile",
    handler: ctx => quickPicker(ctx, controller),
  });
  pi.registerShortcut("ctrl+alt+shift+p", {
    description: "Cycle model profile",
    handler: ctx => guarded((_args, ctx) => cycle(ctx))("", ctx),
  });
}
