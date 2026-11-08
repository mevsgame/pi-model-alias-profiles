import type { ExtensionContext, ModelRouteRequest, ModelRoute } from "@earendil-works/pi-coding-agent";
import { ALIASES, type Alias, type Config } from "./config.ts";

export type Registry = Pick<ExtensionContext["modelRegistry"], "find" | "hasConfiguredAuth">;

export function resolveTarget(name: string | undefined, alias: Alias, config: Config, registry: Registry) {
  const target = name && config.profiles[name]?.[alias];
  const prefix = `Profile "${name ?? "(none)"}", tier/${alias} → ${target || "(missing mapping)"}`;
  if (!target) throw new Error(`${prefix}: configure this alias using /model-profiles.`);
  const slash = target.indexOf("/");
  const model = registry.find(target.slice(0, slash), target.slice(slash + 1));
  if (!model) throw new Error(`${prefix}: physical model is no longer in Pi's catalog. Edit the mapping.`);
  if (model.api === "pi-virtual") throw new Error(`${prefix}: virtual-to-virtual routing is unsupported.`);
  if (!registry.hasConfiguredAuth(model)) throw new Error(`${prefix}: provider has no configured credentials. Use /login or configure provider authentication.`);
  return model;
}

export function validateProfile(name: string, config: Config, registry: Registry): void {
  if (!Object.hasOwn(config.profiles, name)) throw new Error(`Unknown profile "${name}". Use /model-profiles.`);
  for (const alias of ALIASES) resolveTarget(name, alias, config, registry);
}

export function route(alias: Alias, name: string | undefined, config: Config, registry: Registry, request: ModelRouteRequest): ModelRoute {
  const sticky = request.reason === "retry" ? request.failed ?? request.previous : request.previous;
  if ((request.reason === "retry" || request.reason === "continuation") && sticky) {
    return { model: sticky.model, thinkingLevel: sticky.thinkingLevel ?? request.thinkingLevel };
  }
  return { model: resolveTarget(name, alias, config, registry), thinkingLevel: request.thinkingLevel };
}
