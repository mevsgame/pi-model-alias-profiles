import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./adapter/commands.js";
import { registerPromptHooks } from "./adapter/prompt.js";
import { messageOf, Runtime } from "./adapter/runtime.js";
import type { Selection } from "./core/types.js";

const FLAG_PROFILE = "sp-profile";
const FLAG_AUTO = "sp-auto";
const FLAG_OFF = "sp-off";

interface FlagSelection {
	conflict: boolean;
	selection?: Selection;
}

function readFlags(pi: ExtensionAPI): FlagSelection {
	const profile = pi.getFlag(FLAG_PROFILE);
	const auto = pi.getFlag(FLAG_AUTO);
	const off = pi.getFlag(FLAG_OFF);
	const active = [
		typeof profile === "string" && profile.length > 0,
		auto === true,
		off === true,
	].filter(Boolean).length;
	if (active > 1) {
		return { conflict: true };
	}
	if (typeof profile === "string" && profile.length > 0) {
		return { conflict: false, selection: { mode: "manual", profile } };
	}
	if (auto === true) {
		return { conflict: false, selection: { mode: "auto" } };
	}
	if (off === true) {
		return { conflict: false, selection: { mode: "off" } };
	}
	return { conflict: false };
}

function reportErrors(runtime: Runtime, ctx: ExtensionContext): void {
	const errors = runtime.errorDiagnostics();
	if (errors.length === 0) {
		return;
	}
	ctx.ui.notify(
		`pi-prompt-profiles:\n${errors.map((entry) => entry.message).join("\n")}`,
		"error",
	);
}

/**
 * pi-prompt-profiles
 *
 * Applies a Markdown system prompt profile by prepending one managed block to
 * the prompt Pi composed. It never rewrites the user's text and never changes
 * the model, provider, thinking level or permissions.
 */
export default function piPromptProfiles(pi: ExtensionAPI, resolveModel?: (ctx: ExtensionContext) => ExtensionContext["model"]): void {
	const runtime = new Runtime(pi, getAgentDir(), CONFIG_DIR_NAME, resolveModel);

	pi.registerFlag(FLAG_PROFILE, {
		type: "string",
		description:
			"Start with a pinned system prompt profile (bare id, global:id or project:id).",
	});
	pi.registerFlag(FLAG_AUTO, {
		type: "boolean",
		description: "Start with automatic profile resolution.",
	});
	pi.registerFlag(FLAG_OFF, {
		type: "boolean",
		description: "Start with the prompt-profile manager disabled.",
	});

	registerCommands(pi, runtime);

	pi.on("session_start", async (_event, ctx) => {
		try {
			runtime.reload();
			runtime.ensure(ctx);
			const flags = readFlags(pi);
			if (flags.conflict) {
				ctx.ui.notify(
					"pi-prompt-profiles: --sp-profile, --sp-auto and --sp-off cannot be combined; all flags were ignored.",
					"error",
				);
			} else if (flags.selection) {
				runtime.setSessionSelection(ctx, flags.selection, "flag");
				reportErrors(runtime, ctx);
				return;
			}
			if (!runtime.restoreFromSession(ctx)) {
				runtime.applyConfigSelection();
			}
			reportErrors(runtime, ctx);
			runtime.updateStatus(ctx);
		} catch (cause) {
			ctx.ui.notify(`pi-prompt-profiles: ${messageOf(cause)}`, "error");
		}
	});

	pi.on("session_tree", async (_event, ctx) => {
		try {
			runtime.reload();
			runtime.ensure(ctx);
			if (!runtime.restoreFromSession(ctx)) {
				runtime.applyConfigSelection();
			}
			runtime.updateStatus(ctx);
		} catch (cause) {
			ctx.ui.notify(`pi-prompt-profiles: ${messageOf(cause)}`, "error");
		}
	});

	pi.on("model_select", async (_event, ctx) => {
		try {
			runtime.invalidate();
			runtime.updateStatus(ctx);
		} catch {
			// A status refresh must never break model selection.
		}
	});

	registerPromptHooks(pi, runtime);

	pi.on("session_shutdown", async () => {
		runtime.reload();
	});
}
