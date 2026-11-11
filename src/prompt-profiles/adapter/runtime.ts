import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { applyManagedPrompt, MANAGED_BEGIN } from "../core/compose.js";
import { parseRef } from "../core/refs.js";
import {
	isProjectActive,
	resolveProfile as resolveCore,
	type ResolveSources,
} from "../core/resolve.js";
import { loadState, type LoadedState } from "../core/store.js";
import type {
	Diagnostic,
	Resolution,
	Scope,
	Selection,
	SubagentPolicy,
} from "../core/types.js";
import { identityOf, modelKey } from "./model.js";
import {
	readPersistedSelection,
	SELECTION_CUSTOM_TYPE,
	selectionLabel,
	selectionToPersisted,
} from "./state.js";

export type SelectionOrigin = "default" | "config" | "session" | "flag";

export interface ObservedPayload {
	at: number;
	systemFound: boolean;
	blockPresent: boolean;
	note: string;
}

export interface AppliedPrompt {
	key: string;
	label: string;
	hash: string | undefined;
}

export function messageOf(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Best-effort detection of a subagent run. `pi-subagents` marks child processes
 * with this variable; without it, an ambient background child loads the
 * extension and would inherit whatever the config assigns to its model.
 */
export function isSubagentRun(): boolean {
	return process.env.PI_SUBAGENT_CHILD === "1";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeSelection(
	selection: Selection,
	scope: Scope,
): Selection {
	if (selection.mode !== "manual") {
		return selection;
	}
	if (!selection.profile) {
		return { mode: "auto" };
	}
	if (parseRef(selection.profile)) {
		return selection;
	}
	return { mode: "manual", profile: `${scope}:${selection.profile}` };
}

function partText(part: unknown): string {
	if (typeof part === "string") {
		return part;
	}
	if (isRecord(part) && typeof part.text === "string") {
		return part.text;
	}
	return "";
}

/** Best-effort extraction of the system text from a provider payload. */
export function extractSystemText(payload: unknown): string | undefined {
	if (!isRecord(payload)) {
		return undefined;
	}
	const parts: string[] = [];
	for (const field of [payload.system, payload.instructions]) {
		if (typeof field === "string") {
			parts.push(field);
		} else if (Array.isArray(field)) {
			parts.push(field.map(partText).filter(Boolean).join("\n"));
		}
	}
	for (const messages of [payload.messages, payload.input]) {
		if (!Array.isArray(messages)) {
			continue;
		}
		for (const message of messages) {
			if (!isRecord(message)) {
				continue;
			}
			if (message.role === "system" || message.role === "developer") {
				const text =
					typeof message.content === "string"
						? message.content
						: Array.isArray(message.content)
							? message.content.map(partText).filter(Boolean).join("\n")
							: "";
				if (text) {
					parts.push(text);
				}
			}
		}
	}
	return parts.length > 0 ? parts.filter(Boolean).join("\n\n") : undefined;
}

export class Runtime {
	loaded: LoadedState | undefined;
	selection: Selection = { mode: "auto" };
	origin: SelectionOrigin = "default";
	resolved: { key: string; resolution: Resolution } | undefined;
	observed: ObservedPayload | undefined;
	applied: AppliedPrompt | undefined;
	private hadSessionSelection = false;

	constructor(
		private readonly pi: ExtensionAPI,
		readonly agentDir: string,
		readonly configDirName: string,
		private readonly resolveModel?: (ctx: ExtensionContext) => ExtensionContext["model"],
	) {}

	hasSessionSelection(): boolean {
		return this.hadSessionSelection;
	}

	/** Drops cached state so the next read reloads from disk. */
	reload(): void {
		this.loaded = undefined;
		this.resolved = undefined;
		this.observed = undefined;
	}

	ensure(ctx: ExtensionContext): LoadedState {
		if (this.loaded && this.loaded.cwd === ctx.cwd) {
			return this.loaded;
		}
		if (this.loaded && this.loaded.cwd !== ctx.cwd) {
			// A different project must not inherit a cached resolution or status.
			this.resolved = undefined;
			this.applied = undefined;
			this.observed = undefined;
		}
		this.loaded = loadState({
			cwd: ctx.cwd,
			agentDir: this.agentDir,
			configDirName: this.configDirName,
			projectTrusted: ctx.isProjectTrusted(),
		});
		return this.loaded;
	}

	sources(): ResolveSources {
		const loaded = this.loaded;
		if (!loaded) {
			throw new Error("state was not loaded");
		}
		return {
			global: loaded.globalConfig,
			project: loaded.projectConfig,
			globalProfiles: loaded.globalProfiles,
			projectProfiles: loaded.projectProfiles,
			projectTrusted: loaded.projectTrusted,
		};
	}

	/** Applies the config-provided selection as the baseline for the session. */
	applyConfigSelection(): void {
		const loaded = this.loaded;
		if (!loaded) {
			return;
		}
		// The config baseline replaces any previous resolution: clear the cache so
		// the next turn cannot return a stale profile under a new status.
		this.resolved = undefined;
		this.applied = undefined;
		const projectSelection = isProjectActive(this.sources())
			? loaded.projectConfig.config?.selection
			: undefined;
		const baseline = projectSelection ?? loaded.globalConfig.config?.selection;
		if (!baseline) {
			this.selection = { mode: "auto" };
			this.origin = "default";
			return;
		}
		if (baseline.mode === "manual") {
			const scope: Scope = projectSelection ? "project" : "global";
			this.selection = normalizeSelection(
				{ mode: "manual", profile: baseline.profile },
				scope,
			);
		} else {
			this.selection = { mode: baseline.mode };
		}
		this.origin = "config";
	}

	restoreFromSession(ctx: ExtensionContext): boolean {
		const persisted = readPersistedSelection(ctx.sessionManager);
		if (!persisted) {
			this.hadSessionSelection = false;
			return false;
		}
		this.hadSessionSelection = true;
		this.origin = "session";
		this.selection =
			persisted.mode === "manual" && persisted.profile
				? { mode: "manual", profile: persisted.profile }
				: { mode: persisted.mode };
		return true;
	}

	setSessionSelection(
		ctx: ExtensionContext,
		selection: Selection,
		origin: SelectionOrigin,
	): void {
		this.selection = selection;
		this.origin = origin;
		this.hadSessionSelection = true;
		this.resolved = undefined;
		this.pi.appendEntry(SELECTION_CUSTOM_TYPE, selectionToPersisted(selection));
		this.updateStatus(ctx);
	}

	invalidate(): void {
		this.resolved = undefined;
	}

	/** Project config wins over global; the default keeps subagents to bindings. */
	private subagentPolicy(loaded: LoadedState): SubagentPolicy {
		const project = isProjectActive(this.sources())
			? loaded.projectConfig.config?.subagents
			: undefined;
		return project ?? loaded.globalConfig.config?.subagents ?? "bindings";
	}

	resolve(ctx: ExtensionContext): Resolution {
		const loaded = this.ensure(ctx);
		const model = this.resolveModel ? this.resolveModel(ctx) : ctx.model;
		const key = modelKey(model);
		if (this.resolved && this.resolved.key === key) {
			return this.resolved.resolution;
		}
		const policy: SubagentPolicy = isSubagentRun()
			? this.subagentPolicy(loaded)
			: "inherit";
		// An explicit `off` always wins, including inside a subagent.
		const selection: Selection =
			policy === "off" || this.selection.mode === "off"
				? { mode: "off" }
				: policy === "bindings"
					? { mode: "auto" }
					: this.selection;
		const resolution = resolveCore(
			selection,
			identityOf(model),
			{
				global: loaded.globalConfig,
				project: loaded.projectConfig,
				globalProfiles: loaded.globalProfiles,
				projectProfiles: loaded.projectProfiles,
				projectTrusted: loaded.projectTrusted,
			},
			{ bindingsOnly: policy === "bindings" },
		);
		this.resolved = { key, resolution };
		return resolution;
	}

	isPending(ctx: ExtensionContext): boolean {
		return (
			!this.applied ||
			this.applied.key !== modelKey(ctx.model) ||
			this.applied.label !== selectionLabel(this.selection)
		);
	}

	markApplied(ctx: ExtensionContext, hash: string | undefined): void {
		this.applied = {
			key: modelKey(ctx.model),
			label: selectionLabel(this.selection),
			hash,
		};
	}

	/**
	 * Composes the prompt for a resolution that was already obtained, so the block
	 * checked in the provider payload is the same one written into the prompt.
	 * An absent `systemPrompt` means Pi's own prompt stays untouched.
	 */
	compose(
		basePrompt: string,
		resolution: Resolution,
	): { systemPrompt: string | undefined; block: string | undefined } {
		const profile = resolution.mode === "off" ? undefined : resolution.profile;
		const composed = applyManagedPrompt(basePrompt, profile);
		if (profile) {
			return { systemPrompt: composed.systemPrompt, block: composed.block };
		}
		// Off or unresolved: a block left by an earlier run must not survive, but a
		// prompt that carries none is returned unchanged.
		const clearsPreviousBlock = composed.stripped > 0;
		return {
			systemPrompt: clearsPreviousBlock ? composed.systemPrompt : undefined,
			block: undefined,
		};
	}

	observe(payload: unknown, expectedBlock?: string): void {
		const system = extractSystemText(payload);
		this.observed = {
			at: Date.now(),
			systemFound: system !== undefined,
			blockPresent: system?.includes(expectedBlock ?? MANAGED_BEGIN) ?? false,
			note:
				system === undefined
					? "No system text was recognized in this provider payload."
					: "System text observed at before_provider_request.",
		};
	}

	diagnostics(): Diagnostic[] {
		return this.loaded?.diagnostics ?? [];
	}

	errorDiagnostics(): Diagnostic[] {
		return this.diagnostics().filter((entry) => entry.level === "error");
	}

	updateStatus(ctx: ExtensionContext): void {
		let resolution: Resolution | undefined;
		try {
			resolution = this.resolve(ctx);
		} catch {
			resolution = undefined;
		}
		let text: string;
		if (resolution?.mode === "off") {
			text = "SP: off";
		} else if (resolution?.profile) {
			const pending = this.isPending(ctx);
			const observation =
				this.applied?.hash && this.observed && !this.observed.blockPresent
					? this.observed.systemFound
						? " · not in payload"
						: " · payload unverified"
					: "";
			text = `SP: ${resolution.profile.ref.id} [${this.selection.mode}]${pending ? " · next run" : observation}`;
		} else if (this.selection.mode === "manual") {
			text = "SP: manual (unresolved)";
		} else {
			text = "SP: auto (none)";
		}
		ctx.ui.setStatus("sp", text);
	}
}
