import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ALIASES, type Config, type Profile, validateName } from "./config.ts";
import { validateProfile } from "./profiles.ts";

export interface Controller {
  getConfig(): Config;
  getActive(): string | undefined;
  activate(name: string, ctx: ExtensionContext): void;
  commit(config: Config, active: string | undefined, ctx: ExtensionContext): void;
  reload(ctx: ExtensionContext): void;
}

function error(ctx: ExtensionContext, cause: unknown): void {
  ctx.ui.notify(cause instanceof Error ? cause.message : String(cause), "error");
}

function interactive(ctx: ExtensionContext): boolean {
  if (ctx.mode === "tui") return true;
  throw new Error("Profile dialogs require an interactive TUI. Use /model-profile <name> instead.");
}

function names(config: Config): string[] {
  return Object.keys(config.profiles).sort();
}

function valid(name: string, config: Config, ctx: ExtensionContext): boolean {
  try { validateProfile(name, config, ctx.modelRegistry); return true; }
  catch { return false; }
}

async function chooseProfile(ctx: ExtensionContext, config: Config, active: string | undefined, title: string, candidates = names(config)): Promise<string | undefined> {
  const labels = candidates.map(name => `${name === active ? "●" : "○"} ${name}${valid(name, config, ctx) ? "" : " [incomplete/unavailable]"}`);
  const picked = await ctx.ui.select(title, labels);
  return picked === undefined ? undefined : candidates[labels.indexOf(picked)];
}

export async function quickPicker(ctx: ExtensionContext, controller: Controller): Promise<void> {
  if (!interactive(ctx)) return;
  try {
    const config = controller.getConfig();
    if (!names(config).length) {
      ctx.ui.notify("No profiles yet. Use /model-profiles to create one.", "info");
      return;
    }
    const name = await chooseProfile(ctx, config, controller.getActive(), "Switch model profile");
    if (name !== undefined) {
      validateProfile(name, config, ctx.modelRegistry);
      controller.activate(name, ctx);
    }
  } catch (cause) { error(ctx, cause); }
}

async function newName(ctx: ExtensionContext, config: Config): Promise<string | undefined> {
  for (;;) {
    const name = await ctx.ui.input("Profile name (1–64 letters, digits, . _ -)");
    if (name === undefined) return undefined;
    try {
      validateName(name);
      if (Object.hasOwn(config.profiles, name)) throw new Error(`Profile "${name}" already exists.`);
      return name;
    } catch (cause) { error(ctx, cause); }
  }
}

/** Built-in input + paged selection keeps even very large registries usable without a custom TUI. */
async function modelPicker(ctx: ExtensionContext): Promise<string | undefined> {
  const models = ctx.modelRegistry.getAll()
    .filter(model => model.api !== "pi-virtual" && model.provider !== "tier")
    .sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
  const available = new Set(ctx.modelRegistry.getAvailable().map(model => `${model.provider}/${model.id}`));
  for (;;) {
    const query = await ctx.ui.input("Search physical models by provider, name or ID (blank = all)");
    if (query === undefined) return undefined;
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = models.filter(model => terms.every(term => `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(term)));
    if (!matches.length) { ctx.ui.notify("No matching physical models. Try another search.", "info"); continue; }
    let page = 0;
    for (;;) {
      const items = matches.slice(page * 15, (page + 1) * 15);
      const labels = items.map(model => `${model.name} — ${model.provider}/${model.id} [${available.has(`${model.provider}/${model.id}`) ? "available/authenticated" : "unavailable/no credentials"}]`);
      const options = [...labels, "Search again", ...(page > 0 ? ["Previous page"] : []), ...((page + 1) * 15 < matches.length ? ["Next page"] : [])];
      const choice = await ctx.ui.select(`Physical models (${matches.length} matches, page ${page + 1})`, options);
      if (choice === undefined) return undefined;
      if (choice === "Search again") break;
      if (choice === "Next page") { page++; continue; }
      if (choice === "Previous page") { page--; continue; }
      const model = items[labels.indexOf(choice)];
      if (model) return `${model.provider}/${model.id}`;
    }
  }
}

async function edit(ctx: ExtensionContext, name: string, source: Profile): Promise<Profile | undefined> {
  const draft = { ...source };
  for (;;) {
    const mappings = ALIASES.map(alias => `${alias} → ${draft[alias] ?? "(not set)"}`);
    const choice = await ctx.ui.select(`Edit ${name} (unsaved)`, [...mappings, "Save", "Cancel"]);
    if (choice === undefined || choice === "Cancel") return undefined;
    if (choice === "Save") return draft;
    const alias = ALIASES[mappings.indexOf(choice)];
    if (alias) {
      const target = await modelPicker(ctx);
      if (target !== undefined) draft[alias] = target;
    }
  }
}

export async function manage(ctx: ExtensionContext, controller: Controller): Promise<void> {
  if (!interactive(ctx)) return;
  for (;;) {
    try {
      const config = structuredClone(controller.getConfig());
      let active = controller.getActive();
      const action = await ctx.ui.select(`Model profiles — Active: ${active ?? "(none)"}`, [
        "Activate", "Create", "Edit", "Duplicate", "Rename", "Delete", "Set default", "Reload configuration from disk", "Close",
      ]);
      if (action === undefined || action === "Close") return;
      if (action === "Reload configuration from disk") {
        if (await ctx.ui.confirm("Reload configuration?", "Accept external file changes. This discards the current in-memory configuration.")) controller.reload(ctx);
        continue;
      }
      if (action === "Create") {
        const name = await newName(ctx, config);
        if (name === undefined) continue;
        const draft = await edit(ctx, name, {});
        if (draft === undefined) continue;
        config.profiles[name] = draft;
      } else {
        if (!names(config).length) { ctx.ui.notify("Create a profile first.", "info"); continue; }
        const name = await chooseProfile(ctx, config, active, `${action} profile`);
        if (name === undefined) continue;
        if (action === "Activate") {
          validateProfile(name, config, ctx.modelRegistry);
          controller.activate(name, ctx);
          continue;
        }
        if (action === "Edit") {
          const draft = await edit(ctx, name, config.profiles[name]!);
          if (draft === undefined) continue;
          config.profiles[name] = draft;
          if (active === name) validateProfile(name, config, ctx.modelRegistry);
        } else if (action === "Duplicate" || action === "Rename") {
          const next = await newName(ctx, config);
          if (next === undefined) continue;
          config.profiles[next] = { ...config.profiles[name] };
          if (action === "Rename") {
            delete config.profiles[name];
            if (active === name) active = next;
            if (config.defaultProfile === name) config.defaultProfile = next;
            if (config.lastActiveProfile === name) config.lastActiveProfile = next;
          }
        } else if (action === "Delete") {
          if (active === name) {
            const candidates = names(config).filter(other => other !== name && valid(other, config, ctx));
            if (!candidates.length) throw new Error("Cannot delete the active profile: create another valid profile first.");
            const replacement = await chooseProfile(ctx, config, active, "Choose replacement active profile", candidates);
            if (replacement === undefined) continue;
            active = replacement;
          }
          if (!await ctx.ui.confirm(`Delete "${name}"?`, "This permanently removes the profile and its mappings.")) continue;
          delete config.profiles[name];
          if (config.defaultProfile === name) {
            if (active) config.defaultProfile = active;
            else delete config.defaultProfile;
          }
          if (config.lastActiveProfile === name) {
            if (active) config.lastActiveProfile = active;
            else delete config.lastActiveProfile;
          }
        } else if (action === "Set default") {
          validateProfile(name, config, ctx.modelRegistry);
          config.defaultProfile = name;
        }
      }
      controller.commit(config, active, ctx);
      ctx.ui.notify("Profile configuration saved.", "info");
    } catch (cause) { error(ctx, cause); }
  }
}
