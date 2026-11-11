import {
	SELECTION_MODES,
	SUBAGENT_POLICIES,
	type ConfigV1,
	type Scope,
} from "./types.js";

/** Scalar configuration keys that `/sp set` and `/sp unset` can touch. */
export type SettingKey =
	| "subagents"
	| "inheritGlobalBindings"
	| "selection"
	| "defaultProfile";

export interface SettingSpec {
	key: SettingKey;
	description: string;
	/** Scope where `set` is allowed. `unset` is allowed in both scopes. */
	setScope: "both" | "project";
	settable: boolean;
	values?: readonly string[];
}

/** The editable subset of the selection modes: `manual` has its own command. */
const SELECTION_SETTING_MODES = SELECTION_MODES.filter(
	(mode) => mode !== "manual",
);

const SPECS: ReadonlyMap<string, SettingSpec> = new Map([
	[
		"subagents",
		{
			key: "subagents",
			description: "Whether the profile applies inside a subagent.",
			setScope: "both",
			settable: true,
			values: SUBAGENT_POLICIES,
		},
	],
	[
		"inheritglobalbindings",
		{
			key: "inheritGlobalBindings",
			description: "Project-only. false ignores global bindings.",
			setScope: "project",
			settable: true,
		},
	],
	[
		"selection",
		{
			key: "selection",
			description: "Baseline selection stored in the config.",
			setScope: "both",
			settable: true,
			values: SELECTION_SETTING_MODES,
		},
	],
	[
		"defaultprofile",
		{
			key: "defaultProfile",
			description: "Profile used in auto mode when no binding matches.",
			setScope: "both",
			settable: false,
		},
	],
]);

/** `selection.mode` is accepted as a spelling of the whole `selection` object. */
const ALIASES: ReadonlyMap<string, SettingKey> = new Map([
	["selection.mode", "selection"],
]);

export interface ParsedSetting {
	spec: SettingSpec;
	value: string | boolean;
}

export type ParseResult =
	| { ok: true; setting: ParsedSetting }
	| { ok: false; message: string };

export function settingSpec(input: string): SettingSpec | undefined {
	const normalized = input.trim().toLowerCase();
	const key = ALIASES.get(normalized) ?? normalized;
	return SPECS.get(key);
}

export function settingKeys(): SettingKey[] {
	return [...SPECS.values()].map((spec) => spec.key);
}

/**
 * Looks up the key through a Map, so `__proto__`, `constructor` or `toString`
 * are unknown settings instead of inherited object members.
 */
export function parseSetting(input: string, value: string): ParseResult {
	const spec = settingSpec(input);
	if (!spec) {
		return {
			ok: false,
			message: `Unknown setting "${input.trim()}". Known: ${settingKeys().join(", ")}.`,
		};
	}
	if (!spec.settable) {
		return {
			ok: false,
			message: `${spec.key} is set with its own command; use "/sp unset ${spec.key}" to remove it.`,
		};
	}
	const trimmed = value.trim();
	if (spec.key === "inheritGlobalBindings") {
		if (trimmed === "true" || trimmed === "false") {
			return { ok: true, setting: { spec, value: trimmed === "true" } };
		}
		return { ok: false, message: `${spec.key} must be true or false.` };
	}
	const values = spec.values ?? [];
	if (!values.includes(trimmed)) {
		return {
			ok: false,
			message: `${spec.key} must be one of: ${values.join(", ")}.`,
		};
	}
	return { ok: true, setting: { spec, value: trimmed } };
}

export function settingScopeError(
	spec: SettingSpec,
	scope: Scope,
): string | undefined {
	if (spec.setScope === "project" && scope === "global") {
		return `${spec.key} is only meaningful in the project config; pass --scope project.`;
	}
	return undefined;
}

/** Mutates a raw config object. `selection` is always replaced whole. */
export function applySetting(
	config: Record<string, unknown>,
	setting: ParsedSetting,
): void {
	switch (setting.spec.key) {
		case "subagents":
			config.subagents = setting.value;
			return;
		case "inheritGlobalBindings":
			config.inheritGlobalBindings = setting.value;
			return;
		case "selection":
			config.selection = { mode: setting.value };
			return;
		default:
			return;
	}
}

export function unsetSetting(
	config: Record<string, unknown>,
	input: string,
): { ok: true; key: SettingKey } | { ok: false; message: string } {
	const spec = settingSpec(input);
	if (!spec) {
		return {
			ok: false,
			message: `Unknown setting "${input.trim()}". Known: ${settingKeys().join(", ")}.`,
		};
	}
	if (Object.hasOwn(config, spec.key)) {
		delete config[spec.key];
		return { ok: true, key: spec.key };
	}
	return { ok: false, message: `${spec.key} is not set in this config.` };
}

function present(config: ConfigV1, key: SettingKey): boolean {
	return Object.hasOwn(config, key);
}

/** Raw value of a key when present and well formed; otherwise `undefined`. */
export function readSettingValue(
	config: ConfigV1 | undefined,
	key: SettingKey,
): string | boolean | undefined {
	if (!config || !present(config, key)) {
		return undefined;
	}
	switch (key) {
		case "subagents":
			return typeof config.subagents === "string"
				? config.subagents
				: undefined;
		case "inheritGlobalBindings":
			return typeof config.inheritGlobalBindings === "boolean"
				? config.inheritGlobalBindings
				: undefined;
		case "selection":
			return config.selection ? config.selection.mode : undefined;
		case "defaultProfile":
			return typeof config.defaultProfile === "string"
				? config.defaultProfile
				: undefined;
	}
}

export function defaultSetting(key: SettingKey): string | boolean | undefined {
	switch (key) {
		case "subagents":
			return "bindings";
		case "inheritGlobalBindings":
			return true;
		case "selection":
			return "auto";
		case "defaultProfile":
			return undefined;
	}
}

export interface SettingScopes {
	global: ConfigV1 | undefined;
	project: ConfigV1 | undefined;
	projectActive: boolean;
}

export interface EffectiveSetting {
	value: string | boolean | undefined;
	origin: "project" | "global" | "default";
}

/** Project over global over default, with the origin the value came from. */
export function effectiveSetting(
	scopes: SettingScopes,
	key: SettingKey,
): EffectiveSetting {
	if (scopes.projectActive && scopes.project && present(scopes.project, key)) {
		const value = readSettingValue(scopes.project, key);
		if (value !== undefined) {
			return { value, origin: "project" };
		}
	}
	if (scopes.global && present(scopes.global, key)) {
		const value = readSettingValue(scopes.global, key);
		if (value !== undefined) {
			return { value, origin: "global" };
		}
	}
	return { value: defaultSetting(key), origin: "default" };
}
