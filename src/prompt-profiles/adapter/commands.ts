import fs from "node:fs";
import path from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { composeManagedBlock, stripManagedBlocks } from "../core/compose.js";
import { loadConfigFile } from "../core/config.js";
import { isSafeId } from "../core/ids.js";
import { matchRule } from "../core/match.js";
import {
	atomicWriteFile,
	configPath,
	globalRoot,
	isRealPathInside,
	projectRoot,
} from "../core/paths.js";
import {
	allModels,
	modelsOfProvider,
	type PickerItem,
	providerNames,
} from "../core/picker.js";
import { formatRef, parseRef } from "../core/refs.js";
import { isProjectActive } from "../core/resolve.js";
import {
	applySetting,
	effectiveSetting,
	parseSetting,
	type SettingKey,
	settingKeys,
	settingScopeError,
	settingSpec,
	unsetSetting,
} from "../core/settings.js";
import type { Binding, Diagnostic, ProfileRef, Scope } from "../core/types.js";
import {
	readRawConfig,
	type RawConfig,
	writeRawConfigIfUnchanged,
} from "./config-edit.js";
import { identityOf } from "./model.js";
import { selectItem } from "./picker.js";
import { selectionLabel } from "./state.js";
import { messageOf, type Runtime } from "./runtime.js";

const COMMAND_NAME = "sp";

interface ParsedArgs {
	positional: string[];
	flags: Record<string, string | boolean>;
}

export function parseArgs(input: string): ParsedArgs {
	const tokens = input.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
	const positional: string[] = [];
	const flags: Record<string, string | boolean> = {};
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index] ?? "";
		if (token.startsWith("--")) {
			const equals = token.indexOf("=");
			if (equals > 0) {
				flags[token.slice(2, equals)] = token.slice(equals + 1);
				continue;
			}
			const key = token.slice(2);
			const next = tokens[index + 1];
			if (next !== undefined && !next.startsWith("--")) {
				flags[key] = next;
				index += 1;
			} else {
				flags[key] = true;
			}
			continue;
		}
		positional.push(token.replace(/^['"]|['"]$/g, ""));
	}
	return { positional, flags };
}

function flagString(
	flags: Record<string, string | boolean>,
	name: string,
): string | undefined {
	const value = flags[name];
	return typeof value === "string" ? value : undefined;
}

function flagNumber(
	flags: Record<string, string | boolean>,
	name: string,
): number | undefined {
	const value = flagString(flags, name);
	if (value === undefined) {
		return undefined;
	}
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function notify(
	ctx: ExtensionCommandContext,
	message: string,
	type: "info" | "warning" | "error" = "info",
): void {
	ctx.ui.notify(message, type);
}

interface ScopeFlag {
	scope?: Scope;
	invalid?: string;
}

function parseScope(flags: Record<string, string | boolean>): ScopeFlag {
	const value = flags.scope;
	if (value === undefined) {
		return {};
	}
	if (value === true || value === false) {
		return { invalid: "(missing value)" };
	}
	if (value === "global" || value === "project") {
		return { scope: value };
	}
	return { invalid: value };
}

function formatDiagnostics(diagnostics: Diagnostic[]): string {
	return diagnostics
		.map((entry) => `${entry.level}: ${entry.message}`)
		.join("\n");
}

function findProfileRef(runtime: Runtime, input: string): ProfileRef | string {
	const explicit = parseRef(input);
	if (explicit) {
		return explicit;
	}
	if (!isSafeId(input)) {
		return `"${input}" is not a valid profile id.`;
	}
	const loaded = runtime.loaded;
	if (loaded?.projectTrusted && loaded.projectProfiles.profiles.has(input)) {
		return { scope: "project", id: input };
	}
	if (loaded?.globalProfiles.profiles.has(input)) {
		return { scope: "global", id: input };
	}
	return `Profile "${input}" was not found.`;
}

function profileExists(runtime: Runtime, ref: ProfileRef): boolean {
	const loaded = runtime.loaded;
	if (!loaded) {
		return false;
	}
	if (ref.scope === "project") {
		return loaded.projectTrusted && loaded.projectProfiles.profiles.has(ref.id);
	}
	return loaded.globalProfiles.profiles.has(ref.id);
}

function configRootFor(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
	scope: Scope,
): string {
	return scope === "project"
		? projectRoot(ctx.cwd, runtime.configDirName)
		: globalRoot(runtime.agentDir);
}

function editConfig(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
	scope: Scope,
	mutate: (config: RawConfig) => boolean,
): boolean {
	if (scope === "project" && !ctx.isProjectTrusted()) {
		throw new Error(
			"This project is not trusted, so its config cannot be modified.",
		);
	}
	const filePath = configPath(configRootFor(runtime, ctx, scope));
	const snapshot = readRawConfig(filePath);
	if (snapshot.config.version !== 1) {
		throw new Error(
			`${filePath}: unsupported version ${JSON.stringify(snapshot.config.version)}; expected 1.`,
		);
	}
	if (mutate(snapshot.config) === false) {
		return false;
	}
	writeRawConfigIfUnchanged(filePath, snapshot, snapshot.config);
	return true;
}

function listProfiles(runtime: Runtime, scope: Scope | undefined): string[] {
	const loaded = runtime.loaded;
	if (!loaded) {
		return [];
	}
	const lines: string[] = [];
	const add = (catalog: typeof loaded.globalProfiles) => {
		for (const profile of catalog.profiles.values()) {
			const suffix = profile.description ? ` — ${profile.description}` : "";
			lines.push(
				`${formatRef({ scope: profile.scope, id: profile.id })} — ${path.dirname(profile.path)}${suffix}`,
			);
		}
	};
	if (scope !== "project") {
		add(loaded.globalProfiles);
	}
	if (scope !== "global" && loaded.projectTrusted) {
		add(loaded.projectProfiles);
	}
	return lines;
}

function profileEntries(
	runtime: Runtime,
): Array<{ label: string; ref: ProfileRef }> {
	const loaded = runtime.loaded;
	if (!loaded) {
		return [];
	}
	const entries: Array<{ label: string; ref: ProfileRef }> = [];
	if (loaded.projectTrusted) {
		for (const profile of loaded.projectProfiles.profiles.values()) {
			entries.push({
				label: profileLabel(
					"project",
					profile.id,
					profile.path,
					profile.description,
				),
				ref: { scope: "project", id: profile.id },
			});
		}
	}
	for (const profile of loaded.globalProfiles.profiles.values()) {
		entries.push({
			label: profileLabel(
				"global",
				profile.id,
				profile.path,
				profile.description,
			),
			ref: { scope: "global", id: profile.id },
		});
	}
	return entries;
}

function profileLabel(
	scope: Scope,
	id: string,
	profilePath: string,
	description: string | undefined,
): string {
	const suffix = description ? ` · ${description}` : "";
	return `${scope}:${id} — ${path.dirname(profilePath)}${suffix}`;
}

async function chooseProfileInteractive(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
	title = "Select a system prompt profile",
): Promise<void> {
	const entries = profileEntries(runtime);
	if (entries.length === 0) {
		notify(ctx, "No profiles found. Create one first.", "warning");
		return;
	}
	const auto = "(auto) Resolve from bindings and defaults";
	const off = "(off) Disable the manager";
	const items: PickerItem[] = [
		{ value: "__auto__", label: auto },
		...entries.map((entry) => ({
			value: formatRef(entry.ref),
			label: entry.label,
		})),
		{ value: "__off__", label: off },
	];
	const choice = await selectItem(ctx, { title, items });
	if (choice === undefined) {
		return;
	}
	if (choice === "__auto__") {
		runtime.setSessionSelection(ctx, { mode: "auto" }, "session");
		notify(ctx, "Selection: auto.");
		return;
	}
	if (choice === "__off__") {
		runtime.setSessionSelection(ctx, { mode: "off" }, "session");
		notify(ctx, "Selection: off.");
		return;
	}
	const ref = parseRef(choice);
	if (!ref) {
		return;
	}
	runtime.setSessionSelection(
		ctx,
		{ mode: "manual", profile: formatRef(ref) },
		"session",
	);
	notify(ctx, `Selection: ${formatRef(ref)}.`);
}

async function pickProfileRef(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
): Promise<ProfileRef | undefined> {
	const entries = profileEntries(runtime);
	if (entries.length === 0) {
		notify(ctx, "No profiles found. Create one first.", "warning");
		return undefined;
	}
	const choice = await selectItem(ctx, {
		title: "Select a profile",
		items: entries.map((entry) => ({
			value: formatRef(entry.ref),
			label: entry.label,
		})),
	});
	if (choice === undefined) {
		return undefined;
	}
	return parseRef(choice);
}

async function chooseScopeInteractive(
	ctx: ExtensionCommandContext,
): Promise<Scope | undefined> {
	const items: PickerItem[] = [];
	if (ctx.isProjectTrusted()) {
		items.push({ value: "project", label: "Project (this repository)" });
	}
	items.push({ value: "global", label: "Global (all projects)" });
	const choice = await selectItem(ctx, {
		title: "Which configuration?",
		items,
	});
	return choice === "global" || choice === "project" ? choice : undefined;
}

async function changeSettingInteractive(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const scope = await chooseScopeInteractive(ctx);
	if (!scope) {
		return;
	}
	const items: PickerItem[] = [];
	for (const key of settingKeys()) {
		const spec = settingSpec(key);
		if (
			!spec?.settable ||
			(spec.setScope === "project" && scope !== "project")
		) {
			continue;
		}
		const effective = effectiveSettingFor(runtime, key);
		items.push({
			value: key,
			label: `${key} — ${spec.description} (now: ${JSON.stringify(effective.value)} from ${effective.origin})`,
		});
	}
	const key = await selectItem(ctx, {
		title: `Setting in the ${scope} config`,
		items,
	});
	if (!key) {
		return;
	}
	const spec = settingSpec(key);
	if (!spec) {
		return;
	}
	const values = spec.values ?? ["true", "false"];
	const value = await selectItem(ctx, {
		title: `${spec.key} — ${scope} config`,
		items: values.map((entry) => ({ value: entry, label: entry })),
	});
	if (value === undefined) {
		return;
	}
	await setSetting(runtime, ctx, key, value, scope);
}

/**
 * One discoverable menu for the common actions, so a user does not have to
 * remember subcommands to create, choose, bind or unbind profiles.
 */
async function interactiveMenu(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const actions = [
		"Choose a profile for this session",
		"Create a new profile",
		"Edit a profile",
		"Manage model bindings",
		"Set the default profile",
		"Show status",
		"Preview the active profile",
		"Reload from disk",
		"Show configuration",
		"Change a setting",
		"Turn the manager off for this session",
	];
	const choice = await selectItem(ctx, {
		title: "System prompt profiles",
		items: actions.map((action) => ({ value: action, label: action })),
	});
	if (choice === undefined) {
		return;
	}
	switch (choice) {
		case "Choose a profile for this session":
			await chooseProfileInteractive(runtime, ctx);
			break;
		case "Create a new profile": {
			const id = (
				await ctx.ui.input("New profile id", "for example: review")
			)?.trim();
			if (!id) {
				notify(ctx, "Cancelled.", "info");
				return;
			}
			if (!isSafeId(id)) {
				notify(ctx, `"${id}" is not a valid profile id.`, "error");
				return;
			}
			const where = await ctx.ui.select("Where should it live?", [
				"Project (this repository)",
				"Global (all projects)",
			]);
			if (where === undefined) {
				return;
			}
			const scope: Scope =
				where === "Global (all projects)" ? "global" : "project";
			if (scope === "project" && !ctx.isProjectTrusted()) {
				notify(
					ctx,
					"This project is not trusted, so a project profile cannot be created.",
					"error",
				);
				return;
			}
			const root = configRootFor(runtime, ctx, scope);
			const directory = path.join(root, "profiles");
			const filePath = path.join(directory, `${id}.md`);
			try {
				fs.mkdirSync(directory, { recursive: true });
				if (!isRealPathInside(root, directory)) {
					notify(ctx, `Refusing to write outside ${root}.`, "error");
					return;
				}
				if (fs.existsSync(filePath)) {
					notify(
						ctx,
						`${scope}:${id} already exists. Use "Edit a profile".`,
						"warning",
					);
					return;
				}
				const body = await ctx.ui.editor(`New profile ${scope}:${id}`, "");
				if (body === undefined) {
					notify(ctx, "Cancelled. No file was created.", "info");
					return;
				}
				atomicWriteFile(filePath, body.endsWith("\n") ? body : `${body}\n`);
				runtime.reload();
				runtime.ensure(ctx);
				notify(ctx, `Created ${scope}:${id} and saved the prompt body.`);
			} catch (cause) {
				notify(ctx, messageOf(cause), "error");
			}
			break;
		}
		case "Edit a profile": {
			const ref = await pickProfileRef(runtime, ctx);
			if (ref) {
				await handleEdit(runtime, ctx, {
					positional: [formatRef(ref)],
					flags: {},
				});
			}
			break;
		}
		case "Manage model bindings":
			await bindingsMenu(runtime, ctx);
			break;
		case "Set the default profile": {
			const ref = await pickProfileRef(runtime, ctx);
			if (ref) {
				await handleDefault(runtime, ctx, {
					positional: [formatRef(ref)],
					flags: {},
				});
			}
			break;
		}
		case "Show status":
			notify(ctx, statusText(runtime, ctx));
			break;
		case "Preview the active profile":
			handlePreview(runtime, ctx);
			break;
		case "Reload from disk":
			await handleReload(runtime, ctx);
			break;
		case "Show configuration": {
			const scope = await chooseScopeInteractive(ctx);
			if (scope) {
				await handleConfig(runtime, ctx, { positional: [], flags: { scope } });
			}
			break;
		}
		case "Change a setting":
			await changeSettingInteractive(runtime, ctx);
			break;
		case "Turn the manager off for this session":
			runtime.setSessionSelection(ctx, { mode: "off" }, "session");
			notify(ctx, "Selection: off.");
			break;
	}
}

function statusText(runtime: Runtime, ctx: ExtensionCommandContext): string {
	const resolution = runtime.resolve(ctx);
	const model = ctx.model;
	const lines = [
		`mode: ${runtime.selection.mode}`,
		`origin: ${runtime.origin}`,
		`model: ${model ? `${model.provider}/${model.id}` : "none"}`,
	];
	if (runtime.selection.profile) {
		lines.push(`selection: ${runtime.selection.profile}`);
	}
	if (resolution?.profile) {
		lines.push(`profile: ${formatRef(resolution.profile.ref)}`);
		lines.push(
			`layers: ${resolution.profile.layers.map((layer) => formatRef(layer.ref)).join(" -> ")}`,
		);
	}
	if (resolution?.binding) {
		lines.push(
			`binding: ${resolution.binding.scope}:${resolution.binding.binding.id}`,
		);
	}
	const observed = runtime.observed;
	lines.push(
		observed
			? `last payload: ${observed.blockPresent ? "managed block present" : "managed block not found"}; ${observed.note}`
			: "last payload: not observed yet",
	);
	return lines.join("\n");
}

async function handleList(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
	args: ParsedArgs,
): Promise<void> {
	const { scope, invalid } = parseScope(args.flags);
	if (invalid !== undefined) {
		notify(
			ctx,
			`Invalid --scope "${invalid}". Use global or project.`,
			"error",
		);
		return;
	}
	const lines = listProfiles(runtime, scope);
	notify(ctx, lines.length > 0 ? lines.join("\n") : "No profiles found.");
}

async function handleUse(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
	args: ParsedArgs,
): Promise<void> {
	const input = args.positional[0];
	if (!input) {
		notify(ctx, "Usage: /sp use <profile>", "warning");
		return;
	}
	const ref = findProfileRef(runtime, input);
	if (typeof ref === "string") {
		notify(ctx, ref, "error");
		return;
	}
	if (!profileExists(runtime, ref)) {
		notify(ctx, `Profile ${formatRef(ref)} was not found.`, "error");
		return;
	}
	runtime.setSessionSelection(
		ctx,
		{ mode: "manual", profile: formatRef(ref) },
		"session",
	);
	notify(ctx, `Selection: ${formatRef(ref)}.`);
}

async function handleDefault(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
	args: ParsedArgs,
): Promise<void> {
	const input = args.positional[0];
	if (!input) {
		notify(
			ctx,
			"Usage: /sp default <profile> --scope global|project",
			"warning",
		);
		return;
	}
	const { scope: scopeFlag, invalid } = parseScope(args.flags);
	if (invalid !== undefined) {
		notify(
			ctx,
			`Invalid --scope "${invalid}". Use global or project.`,
			"error",
		);
		return;
	}
	const explicit = parseRef(input);
	const scope: Scope = scopeFlag ?? explicit?.scope ?? "global";
	const id = explicit?.id ?? input;
	if (!isSafeId(id)) {
		notify(ctx, `"${input}" is not a valid profile id.`, "error");
		return;
	}
	if (!profileExists(runtime, { scope, id })) {
		notify(
			ctx,
			`Profile ${scope}:${id} was not found; defaultProfile was not changed.`,
			"error",
		);
		return;
	}
	const value = formatRef({ scope, id });
	try {
		editConfig(runtime, ctx, scope, (config) => {
			config.defaultProfile = value;
			return true;
		});
		runtime.reload();
		runtime.ensure(ctx);
		notify(ctx, `defaultProfile set to ${value} in the ${scope} config.`);
	} catch (cause) {
		notify(ctx, messageOf(cause), "error");
	}
}

function effectiveSettingFor(runtime: Runtime, key: SettingKey) {
	const loaded = runtime.loaded;
	const projectActive = loaded ? isProjectActive(runtime.sources()) : false;
	return effectiveSetting(
		{
			global: loaded?.globalConfig.config,
			project: projectActive ? loaded?.projectConfig.config : undefined,
			projectActive,
		},
		key,
	);
}

/** Reloads and reports; a failed reload never hides a successful write. */
function reloadAfterWrite(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
	key: SettingKey | undefined,
): void {
	try {
		runtime.reload();
		runtime.ensure(ctx);
		if (!runtime.hasSessionSelection()) {
			runtime.applyConfigSelection();
		}
		runtime.updateStatus(ctx);
	} catch (cause) {
		notify(
			ctx,
			`Written, but the reload failed: ${messageOf(cause)}. Run /sp reload.`,
			"error",
		);
		return;
	}
	if (key === "selection" && runtime.hasSessionSelection()) {
		notify(
			ctx,
			"This session keeps its own selection; the stored value applies to new sessions.",
			"info",
		);
	}
	if (key === "subagents") {
		notify(ctx, "Subagents that start from now use the new policy.", "info");
	}
}

async function setSetting(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
	rawKey: string,
	rawValue: string,
	scope: Scope,
): Promise<void> {
	const parsed = parseSetting(rawKey, rawValue);
	if (!parsed.ok) {
		notify(ctx, parsed.message, "error");
		return;
	}
	const scopeError = settingScopeError(parsed.setting.spec, scope);
	if (scopeError) {
		notify(ctx, scopeError, "error");
		return;
	}
	let droppedManual = false;
	try {
		editConfig(runtime, ctx, scope, (config) => {
			const selection = config.selection;
			if (
				parsed.setting.spec.key === "selection" &&
				typeof selection === "object" &&
				selection !== null &&
				(selection as { mode?: unknown }).mode === "manual"
			) {
				droppedManual = true;
			}
			applySetting(config, parsed.setting);
			return true;
		});
	} catch (cause) {
		notify(ctx, messageOf(cause), "error");
		return;
	}
	const filePath = configPath(configRootFor(runtime, ctx, scope));
	const check = loadConfigFile(filePath, scope);
	const errors = check.diagnostics.filter((entry) => entry.level === "error");
	if (errors.length > 0) {
		notify(
			ctx,
			`Written, but the config still has errors (they may predate this change):\n${formatDiagnostics(errors)}\nRun /sp reload.`,
			"error",
		);
		return;
	}
	notify(
		ctx,
		`${parsed.setting.spec.key} set to ${JSON.stringify(parsed.setting.value)} in the ${scope} config.`,
	);
	if (droppedManual) {
		notify(ctx, "The previous selection.profile was dropped.", "warning");
	}
	reloadAfterWrite(runtime, ctx, parsed.setting.spec.key);
}

async function handleConfig(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
	args: ParsedArgs,
): Promise<void> {
	const { scope: scopeFlag, invalid } = parseScope(args.flags);
	if (invalid !== undefined) {
		notify(
			ctx,
			`Invalid --scope "${invalid}". Use global or project.`,
			"error",
		);
		return;
	}
	const scope: Scope = scopeFlag ?? "global";
	if (scope === "project" && !ctx.isProjectTrusted()) {
		notify(
			ctx,
			"The project is not trusted, so its config is not read.",
			"warning",
		);
		return;
	}
	const filePath = configPath(configRootFor(runtime, ctx, scope));
	try {
		const snapshot = readRawConfig(filePath);
		const loaded = loadConfigFile(filePath, scope);
		const lines = [
			snapshot.exists
				? `${scope} config (${filePath}):`
				: `${scope} config (no file at ${filePath}; defaults apply):`,
			JSON.stringify(snapshot.config, null, 2),
		];
		for (const key of settingKeys()) {
			const effective = effectiveSettingFor(runtime, key);
			lines.push(
				`${key} = ${JSON.stringify(effective.value)} (from ${effective.origin})`,
			);
		}
		if (loaded.diagnostics.length > 0) {
			lines.push(formatDiagnostics(loaded.diagnostics));
		}
		notify(ctx, lines.join("\n"));
	} catch (cause) {
		notify(ctx, messageOf(cause), "error");
	}
}

async function handleSet(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
	args: ParsedArgs,
): Promise<void> {
	const rawKey = args.positional[0];
	const rawValue = args.positional[1];
	if (!rawKey || rawValue === undefined || args.positional.length > 2) {
		notify(
			ctx,
			"Usage: /sp set <setting> <value> [--scope global|project]",
			"warning",
		);
		return;
	}
	const { scope: scopeFlag, invalid } = parseScope(args.flags);
	if (invalid !== undefined) {
		notify(
			ctx,
			`Invalid --scope "${invalid}". Use global or project.`,
			"error",
		);
		return;
	}
	await setSetting(runtime, ctx, rawKey, rawValue, scopeFlag ?? "global");
}

async function handleUnset(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
	args: ParsedArgs,
): Promise<void> {
	const rawKey = args.positional[0];
	if (!rawKey || args.positional.length > 1) {
		notify(
			ctx,
			"Usage: /sp unset <setting> [--scope global|project]",
			"warning",
		);
		return;
	}
	const { scope: scopeFlag, invalid } = parseScope(args.flags);
	if (invalid !== undefined) {
		notify(
			ctx,
			`Invalid --scope "${invalid}". Use global or project.`,
			"error",
		);
		return;
	}
	const spec = settingSpec(rawKey);
	if (!spec) {
		notify(
			ctx,
			`Unknown setting "${rawKey.trim()}". Known: ${settingKeys().join(", ")}.`,
			"error",
		);
		return;
	}
	const scope: Scope = scopeFlag ?? "global";
	let failure: string | undefined;
	try {
		const wrote = editConfig(runtime, ctx, scope, (config) => {
			const result = unsetSetting(config, rawKey);
			if (!result.ok) {
				failure = result.message;
				return false;
			}
			return true;
		});
		if (!wrote) {
			notify(ctx, failure ?? "Nothing was removed.", "warning");
			return;
		}
	} catch (cause) {
		notify(ctx, messageOf(cause), "error");
		return;
	}
	notify(ctx, `${spec.key} removed from the ${scope} config.`);
	reloadAfterWrite(runtime, ctx, spec.key);
}

async function handleNew(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
	args: ParsedArgs,
): Promise<void> {
	const id = args.positional[0];
	if (!id || !isSafeId(id)) {
		notify(ctx, "Usage: /sp new <id> --scope global|project", "warning");
		return;
	}
	const { scope: scopeFlag, invalid } = parseScope(args.flags);
	if (invalid !== undefined) {
		notify(
			ctx,
			`Invalid --scope "${invalid}". Use global or project.`,
			"error",
		);
		return;
	}
	const scope = scopeFlag ?? "global";
	if (scope === "project" && !ctx.isProjectTrusted()) {
		notify(
			ctx,
			"This project is not trusted, so a project profile cannot be created.",
			"error",
		);
		return;
	}
	const root = configRootFor(runtime, ctx, scope);
	const directory = path.join(root, "profiles");
	const filePath = path.join(directory, `${id}.md`);
	try {
		fs.mkdirSync(directory, { recursive: true });
		if (!isRealPathInside(root, directory)) {
			notify(ctx, `Refusing to write outside ${root}.`, "error");
			return;
		}
		if (fs.existsSync(filePath)) {
			notify(ctx, `${filePath} already exists.`, "error");
			return;
		}
		atomicWriteFile(
			filePath,
			"<!-- Profile body. Replace this comment with the instructions for this profile. -->\n",
		);
		runtime.reload();
		runtime.ensure(ctx);
		notify(
			ctx,
			`Created ${scope}:${id} at ${filePath}. Reload with /sp reload if it does not appear.`,
		);
	} catch (cause) {
		notify(ctx, messageOf(cause), "error");
	}
}

async function handleEdit(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
	args: ParsedArgs,
): Promise<void> {
	const input = args.positional[0];
	if (!input) {
		notify(ctx, "Usage: /sp edit <profile>", "warning");
		return;
	}
	const ref = findProfileRef(runtime, input);
	if (typeof ref === "string") {
		notify(ctx, ref, "error");
		return;
	}
	const loaded =
		ref.scope === "project"
			? runtime.loaded?.projectProfiles
			: runtime.loaded?.globalProfiles;
	const profile = loaded?.profiles.get(ref.id);
	if (!profile) {
		notify(ctx, `Profile ${formatRef(ref)} was not found.`, "error");
		return;
	}
	const updated = await ctx.ui.editor(
		`Edit ${formatRef(ref)}`,
		profile.content,
	);
	if (updated === undefined) {
		return;
	}
	try {
		if (
			!isRealPathInside(configRootFor(runtime, ctx, ref.scope), profile.path)
		) {
			notify(ctx, "Refusing to write outside the authorized root.", "error");
			return;
		}
		atomicWriteFile(profile.path, updated);
		runtime.reload();
		runtime.ensure(ctx);
		notify(ctx, `Saved ${formatRef(ref)}.`);
	} catch (cause) {
		notify(ctx, messageOf(cause), "error");
	}
}

async function chooseBindingTarget(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
	ref: ProfileRef,
): Promise<{ provider: string; model: string } | undefined> {
	const models = ctx.modelRegistry.getAvailable().map((candidate) => ({
		provider: String(candidate.provider),
		id: String(candidate.id),
	}));
	const subtitle = bindingContext(runtime, ctx, ref);
	const provider = await selectItem(ctx, {
		title: `Bind ${formatRef(ref)} — choose a provider`,
		subtitle,
		items: [
			{ value: "*", label: "(any provider)" },
			...providerNames(models).map((name) => ({ value: name, label: name })),
		],
	});
	if (provider === undefined) {
		return undefined;
	}
	if (provider === "*") {
		const target = await selectItem(ctx, {
			title: `Bind ${formatRef(ref)} — models of any provider`,
			subtitle,
			items: [
				{ value: "*", label: "(any model)" },
				...allModels(models).map((entry) => ({
					// A model id can contain "/", so provider and id travel as JSON.
					value: JSON.stringify([entry.provider, entry.id]),
					label: `${entry.provider} · ${entry.id}`,
				})),
			],
		});
		if (target === undefined) {
			return undefined;
		}
		if (target === "*") {
			return { provider: "*", model: "*" };
		}
		const [targetProvider, targetModel] = JSON.parse(target) as [
			string,
			string,
		];
		return { provider: targetProvider, model: targetModel };
	}
	const model = await selectItem(ctx, {
		title: `Bind ${formatRef(ref)} — models of ${provider}`,
		subtitle,
		items: [
			{ value: "*", label: `(any model of ${provider})` },
			...modelsOfProvider(models, provider).map((entry) => ({
				value: entry.id,
				label: entry.id,
			})),
		],
	});
	if (model === undefined) {
		return undefined;
	}
	return { provider, model };
}

/** One line describing the active model and the profile's current bindings. */
function bindingContext(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
	ref: ProfileRef,
): string {
	const model = ctx.model;
	const current = model
		? `current model ${model.provider}/${model.id}`
		: "no model selected";
	const entries: string[] = [];
	const scopes: Array<[string, Binding[] | undefined]> = [
		["p", runtime.loaded?.projectConfig.config?.bindings],
		["g", runtime.loaded?.globalConfig.config?.bindings],
	];
	for (const [scope, bindings] of scopes) {
		for (const binding of bindings ?? []) {
			if (binding.profile !== formatRef(ref)) {
				continue;
			}
			const rules = matchRules(binding);
			entries.push(`${scope}:${rules}(p${binding.priority ?? 0})`);
		}
	}
	const existing =
		entries.length > 0 ? `bindings ${entries.join(" ")}` : "no bindings yet";
	return `${current} · ${existing}`;
}

/**
 * A binding can be saved correctly and still never fire: a pinned selection
 * bypasses matching, and a wrong provider or model id fails silently at resolve
 * time. Report both right after the write, where the user can still act.
 */
function reportBindingCaveats(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
	binding: Binding,
): void {
	if (runtime.selection.mode !== "auto") {
		notify(
			ctx,
			`Selection is "${selectionLabel(runtime.selection)}" and bindings apply only in auto mode; run /sp auto to test this binding.`,
			"warning",
		);
		return;
	}
	const active = identityOf(ctx.model);
	if (active && !binding.match.some((rule) => matchRule(rule, active))) {
		notify(
			ctx,
			`This binding does not match the current model ${active.provider}/${active.id}.`,
			"warning",
		);
	}
}

async function handleBind(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
	args: ParsedArgs,
): Promise<void> {
	const input = args.positional[0];
	if (!input) {
		notify(
			ctx,
			"Usage: /sp bind <profile> [--provider <p>] [--model <m>] [--scope global|project] [--priority <n>] [--id <id>]",
			"warning",
		);
		return;
	}
	const ref = findProfileRef(runtime, input);
	if (typeof ref === "string") {
		notify(ctx, ref, "error");
		return;
	}
	const { scope: scopeFlag, invalid } = parseScope(args.flags);
	if (invalid !== undefined) {
		notify(
			ctx,
			`Invalid --scope "${invalid}". Use global or project.`,
			"error",
		);
		return;
	}
	const scope: Scope = scopeFlag ?? ref.scope;

	let provider = flagString(args.flags, "provider") ?? "*";
	let model = flagString(args.flags, "model") ?? "*";
	if (
		flagString(args.flags, "provider") === undefined &&
		flagString(args.flags, "model") === undefined
	) {
		if (!ctx.hasUI) {
			notify(
				ctx,
				"Provide --provider and/or --model, or run interactively.",
				"error",
			);
			return;
		}
		if (ctx.modelRegistry.getAvailable().length === 0) {
			notify(ctx, "No models are available to bind.", "error");
			return;
		}
		const target = await chooseBindingTarget(runtime, ctx, ref);
		if (!target) {
			notify(ctx, "Cancelled. No binding was written.", "info");
			return;
		}
		provider = target.provider;
		model = target.model;
	}

	const priority = flagNumber(args.flags, "priority") ?? 0;
	const wildcard = (value: string): string => (value === "*" ? "any" : value);
	const bindingId =
		flagString(args.flags, "id") ??
		`${ref.id}-${wildcard(provider)}-${wildcard(model)}`.replace(
			/[^A-Za-z0-9._-]/g,
			"-",
		);
	if (!isSafeId(bindingId)) {
		notify(ctx, `Binding id "${bindingId}" is not valid; pass --id.`, "error");
		return;
	}
	const binding: Binding = {
		id: bindingId,
		profile: formatRef(ref),
		priority,
		match: [{ provider, model }],
	};
	try {
		editConfig(runtime, ctx, scope, (config) => {
			const existing = Array.isArray(config.bindings)
				? (config.bindings as unknown[])
				: [];
			const filtered = existing.filter(
				(entry) =>
					!(
						typeof entry === "object" &&
						entry !== null &&
						(entry as { id?: unknown }).id === bindingId
					),
			);
			config.bindings = [...filtered, binding];
			return true;
		});
		runtime.reload();
		runtime.ensure(ctx);
		notify(
			ctx,
			`Bound ${formatRef(ref)} to ${provider}/${model} (priority ${priority}) in the ${scope} config.`,
		);
		reportBindingCaveats(runtime, ctx, binding);
	} catch (cause) {
		notify(ctx, messageOf(cause), "error");
	}
}

/** Drops every binding with this id and returns how many entries were removed. */
function removeBindingFrom(config: RawConfig, id: string): number {
	const current = config.bindings;
	if (!Array.isArray(current)) {
		return 0;
	}
	const filtered = current.filter(
		(entry) =>
			!(
				typeof entry === "object" &&
				entry !== null &&
				(entry as { id?: unknown }).id === id
			),
	);
	const removed = current.length - filtered.length;
	if (removed > 0) {
		config.bindings = filtered;
	}
	return removed;
}

async function handleUnbind(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
	args: ParsedArgs,
): Promise<void> {
	const id = args.positional[0];
	if (!id) {
		notify(
			ctx,
			"Usage: /sp unbind <binding-id> [--scope global|project]",
			"warning",
		);
		return;
	}
	const { scope: scopeFlag, invalid } = parseScope(args.flags);
	if (invalid !== undefined) {
		notify(
			ctx,
			`Invalid --scope "${invalid}". Use global or project.`,
			"error",
		);
		return;
	}
	// Without --scope the binding can live in either config, so search both.
	// Only the implicit search skips an untrusted project: an explicit
	// --scope project keeps editConfig's trust error.
	const scopes: Scope[] = scopeFlag ? [scopeFlag] : ["project", "global"];
	let removed = 0;
	const removedFrom: Scope[] = [];
	try {
		for (const scope of scopes) {
			if (!scopeFlag && scope === "project" && !ctx.isProjectTrusted()) {
				continue;
			}
			let removedHere = 0;
			editConfig(runtime, ctx, scope, (config) => {
				removedHere = removeBindingFrom(config, id);
				return removedHere > 0;
			});
			if (removedHere > 0) {
				removed += removedHere;
				removedFrom.push(scope);
			}
		}
	} catch (cause) {
		// A two-config pass can fail halfway. Report what already changed so a
		// plain repeat finishes the job instead of leaving a silent half state.
		const partial =
			removedFrom.length > 0
				? ` Removed ${removed} from the ${removedFrom.join(" and ")} config first; run /sp unbind ${id} again to finish.`
				: "";
		// Whatever was written must take effect now: the cached state would keep
		// applying a binding that is already gone from disk.
		runtime.reload();
		notify(ctx, `${messageOf(cause)}${partial}`, "error");
		return;
	}
	try {
		runtime.reload();
		runtime.ensure(ctx);
	} catch (cause) {
		notify(
			ctx,
			`Written, but the reload failed: ${messageOf(cause)}. Run /sp reload.`,
			"error",
		);
		return;
	}
	notify(
		ctx,
		removed > 0
			? `Removed ${removed} binding(s) named "${id}" from the ${removedFrom.join(" and ")} config.`
			: `No binding named "${id}" was found${scopeFlag ? ` in the ${scopeFlag} config` : ""}.`,
	);
}

/** One `provider/model` rule line, `*` on the side the rule omits. */
function matchRules(binding: Binding): string {
	return binding.match
		.map((rule) => `${rule.provider ?? "*"}/${rule.model ?? "*"}`)
		.join(",");
}

const EMPTY_BINDINGS =
	'No bindings configured. Use "Add a binding to a model" to create one.';

/** Every binding of both configs, one per line, project first. */
function bindingList(runtime: Runtime): string[] {
	const loaded = runtime.loaded;
	if (!loaded) {
		return [];
	}
	const lines: string[] = [];
	const scopes: Array<[Scope, Binding[] | undefined]> = [
		["project", loaded.projectConfig.config?.bindings],
		["global", loaded.globalConfig.config?.bindings],
	];
	for (const [scope, bindings] of scopes) {
		for (const binding of bindings ?? []) {
			const priority =
				binding.priority !== undefined && binding.priority !== 0
					? ` (priority ${binding.priority})`
					: "";
			lines.push(
				`${scope}:${binding.id} — ${binding.profile} ← ${matchRules(binding)}${priority}`,
			);
		}
	}
	return lines;
}

/**
 * The bind/unbind hub of the menu: add, list and remove bindings in one place
 * and a way back to the main menu, so neither subcommands nor ids need to be
 * remembered.
 */
async function bindingsMenu(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
): Promise<void> {
	for (;;) {
		const choice = await selectItem(ctx, {
			title: "Model bindings",
			items: [
				{ value: "add", label: "Add a binding to a model" },
				{ value: "list", label: "List bindings" },
				{ value: "remove", label: "Remove a binding" },
				{ value: "back", label: "Back to the main menu" },
			],
		});
		if (choice === undefined) {
			return;
		}
		if (choice === "back") {
			await interactiveMenu(runtime, ctx);
			return;
		}
		if (choice === "list") {
			const lines = bindingList(runtime);
			notify(ctx, lines.length > 0 ? lines.join("\n") : EMPTY_BINDINGS);
			continue;
		}
		if (choice === "remove") {
			await removeBindingInteractive(runtime, ctx);
			continue;
		}
		const ref = await pickProfileRef(runtime, ctx);
		if (ref) {
			await handleBind(runtime, ctx, {
				positional: [formatRef(ref)],
				flags: {},
			});
		}
	}
}

async function removeBindingInteractive(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const loaded = runtime.loaded;
	const entries: Array<{ scope: Scope; binding: Binding }> = [];
	for (const binding of loaded?.projectConfig.config?.bindings ?? []) {
		entries.push({ scope: "project", binding });
	}
	for (const binding of loaded?.globalConfig.config?.bindings ?? []) {
		entries.push({ scope: "global", binding });
	}
	if (entries.length === 0) {
		notify(ctx, EMPTY_BINDINGS);
		return;
	}
	const choice = await selectItem(ctx, {
		title: "Remove a binding",
		items: entries.map(({ scope, binding }) => ({
			value: JSON.stringify([scope, binding.id]),
			label: `${scope}:${binding.id} — ${binding.profile} ← ${matchRules(binding)}`,
		})),
	});
	if (choice === undefined) {
		return;
	}
	const [scope, id] = JSON.parse(choice) as [Scope, string];
	try {
		let removed = 0;
		editConfig(runtime, ctx, scope, (config) => {
			removed = removeBindingFrom(config, id);
			return removed > 0;
		});
		runtime.reload();
		runtime.ensure(ctx);
		notify(
			ctx,
			removed > 0
				? `Removed binding "${id}" from the ${scope} config.`
				: `No binding named "${id}" was found in the ${scope} config.`,
		);
	} catch (cause) {
		notify(ctx, messageOf(cause), "error");
	}
}

function handleValidate(runtime: Runtime, ctx: ExtensionCommandContext): void {
	const diagnostics = runtime.diagnostics();
	const resolution = runtime.resolve(ctx);
	const lines: string[] = [];
	lines.push(
		`global config: ${runtime.loaded?.globalConfig.exists ? "present" : "absent"}`,
	);
	lines.push(`project trusted: ${ctx.isProjectTrusted() ? "yes" : "no"}`);
	lines.push(
		`global profiles: ${runtime.loaded?.globalProfiles.profiles.size ?? 0}`,
	);
	lines.push(
		`project profiles: ${runtime.loaded?.projectTrusted ? (runtime.loaded.projectProfiles.profiles.size ?? 0) : "not applied (untrusted)"}`,
	);
	lines.push(
		`resolved: ${resolution.profile ? formatRef(resolution.profile.ref) : "none"}`,
	);
	lines.push(`diagnostics: ${diagnostics.length}`);
	if (diagnostics.length > 0) {
		lines.push(formatDiagnostics(diagnostics));
	}
	notify(ctx, lines.join("\n"));
}

function handlePreview(runtime: Runtime, ctx: ExtensionCommandContext): void {
	const resolution = runtime.resolve(ctx);
	if (!resolution.profile) {
		notify(
			ctx,
			"No active profile to preview. Pi will use its native prompt.",
			"warning",
		);
		return;
	}
	const block = composeManagedBlock(resolution.profile);
	const base = ctx.getSystemPrompt();
	const stripped = stripManagedBlocks(base);
	const lines = [
		`profile: ${formatRef(resolution.profile.ref)} (${resolution.profile.layers.length} layer(s))`,
		`managed block: ${Buffer.byteLength(block, "utf8")} bytes`,
		`current system prompt: ${Buffer.byteLength(base, "utf8")} bytes (${stripped.removed} managed block(s) already present)`,
		`block hash: ${resolution.profile.layers.map((layer) => layer.hash.slice(0, 12)).join(", ")}`,
		`last provider payload: ${runtime.observed ? (runtime.observed.blockPresent ? "block present" : "block not found") : "not observed yet"}`,
		"This preview may contain private instructions from your profiles.",
		"",
		block.slice(0, 800),
	];
	if (block.length > 800) {
		lines.push(`... (${block.length - 800} more characters)`);
	}
	notify(ctx, lines.join("\n"), "warning");
}

async function handleReload(
	runtime: Runtime,
	ctx: ExtensionCommandContext,
): Promise<void> {
	runtime.reload();
	runtime.ensure(ctx);
	if (!runtime.hasSessionSelection()) {
		runtime.applyConfigSelection();
	}
	runtime.updateStatus(ctx);
	notify(ctx, "Reloaded config and profiles from disk.");
}

export function registerCommands(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand(COMMAND_NAME, {
		description:
			"Manage system prompt profiles (list, use, auto, off, status, why, preview, bind, unbind, reload, validate, new, edit, default, config, set, unset).",
		getArgumentCompletions(argumentPrefix: string) {
			const subcommands = [
				"list",
				"use",
				"auto",
				"off",
				"status",
				"why",
				"preview",
				"bind",
				"unbind",
				"reload",
				"validate",
				"new",
				"edit",
				"default",
				"config",
				"set",
				"unset",
				"help",
			];
			const parts = argumentPrefix.split(/\s+/);
			if (parts.length <= 1) {
				return subcommands
					.filter((name) => name.startsWith(parts[0] ?? ""))
					.map((name) => ({ value: name, label: name }));
			}
			if (
				parts[0] === "use" ||
				parts[0] === "edit" ||
				parts[0] === "bind" ||
				parts[0] === "default"
			) {
				const profiles = listProfiles(runtime, undefined).map(
					(line) => line.split(" —")[0] ?? line,
				);
				return profiles.map((value) => ({
					value: `${parts[0]} ${value}`,
					label: value,
				}));
			}
			return null;
		},
		async handler(args: string, ctx: ExtensionCommandContext): Promise<void> {
			try {
				runtime.ensure(ctx);
				const parsed = parseArgs(args);
				const subcommand = parsed.positional[0] ?? "interactive";
				const operands: ParsedArgs = {
					positional: parsed.positional.slice(1),
					flags: parsed.flags,
				};
				switch (subcommand) {
					case "interactive":
						if (ctx.hasUI) {
							await interactiveMenu(runtime, ctx);
						} else {
							notify(
								ctx,
								"Usage: /sp <list|use|auto|off|status|why|preview|bind|unbind|reload|validate|new|edit|default|config|set|unset>",
							);
						}
						break;
					case "help":
						notify(
							ctx,
							[
								"/sp                     interactive selector",
								"/sp list [--scope ...]  list profiles",
								"/sp use <profile>       pin a profile for this session",
								"/sp auto                clear the pin and resolve from rules",
								"/sp off                 disable the manager for this session",
								"/sp status              show the effective selection",
								"/sp why                 explain the resolution",
								"/sp preview             show the managed block",
								"/sp bind <profile>      add a model binding",
								"/sp unbind <id>         remove a binding",
								"/sp reload              re-read config and profiles",
								"/sp validate            report configuration problems",
								"/sp new <id>            create a profile file",
								"/sp edit <profile>      edit a profile",
								"/sp default <profile>   set defaultProfile",
								"/sp config [--scope ...] show a config file and its diagnostics",
								"/sp set <key> <value>   change a setting",
								"/sp unset <key>         remove a setting",
							].join("\n"),
						);
						break;
					case "list":
						await handleList(runtime, ctx, operands);
						break;
					case "use":
						await handleUse(runtime, ctx, operands);
						break;
					case "auto":
						runtime.setSessionSelection(ctx, { mode: "auto" }, "session");
						notify(ctx, "Selection: auto.");
						break;
					case "off":
						runtime.setSessionSelection(ctx, { mode: "off" }, "session");
						notify(ctx, "Selection: off.");
						break;
					case "status":
						notify(ctx, statusText(runtime, ctx));
						break;
					case "why": {
						const lines = [statusText(runtime, ctx)];
						const resolution = runtime.resolve(ctx);
						if (resolution.ignored.length > 0) {
							lines.push(
								`discarded rules: ${resolution.ignored.map((match) => `${match.scope}:${match.binding.id}`).join(", ")}`,
							);
						}
						if (resolution.diagnostics.length > 0) {
							lines.push(formatDiagnostics(resolution.diagnostics));
						}
						notify(ctx, lines.join("\n"));
						break;
					}
					case "preview":
						handlePreview(runtime, ctx);
						break;
					case "bind":
						await handleBind(runtime, ctx, operands);
						break;
					case "unbind":
						await handleUnbind(runtime, ctx, operands);
						break;
					case "reload":
						await handleReload(runtime, ctx);
						break;
					case "validate":
						handleValidate(runtime, ctx);
						break;
					case "new":
						await handleNew(runtime, ctx, operands);
						break;
					case "edit":
						await handleEdit(runtime, ctx, operands);
						break;
					case "default":
						await handleDefault(runtime, ctx, operands);
						break;
					case "config":
						await handleConfig(runtime, ctx, operands);
						break;
					case "set":
						await handleSet(runtime, ctx, operands);
						break;
					case "unset":
						await handleUnset(runtime, ctx, operands);
						break;
					default:
						notify(
							ctx,
							`Unknown subcommand "${subcommand}". Try /sp help.`,
							"error",
						);
				}
			} catch (cause) {
				notify(ctx, `pi-prompt-profiles: ${messageOf(cause)}`, "error");
			}
		},
	});
}
