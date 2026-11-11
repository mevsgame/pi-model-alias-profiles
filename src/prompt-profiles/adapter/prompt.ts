import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { messageOf, type Runtime } from "./runtime.js";

export function registerPromptHooks(pi: ExtensionAPI, runtime: Runtime): void {
	let block: string | undefined;
	let warned = false;

	pi.on("before_agent_start", async (event, ctx) => {
		block = undefined;
		warned = false;
		try {
			// A returned prompt survives Pi's forced-prompt projection, which replaces
			// the whole system message after every hook and would discard a
			// request-local projection. Extensions that build on `event.systemPrompt`
			// chain, so the block stays single in either load order. A later handler
			// returning an independent replacement can still drop it; the read-only
			// check reports that.
			const resolution = runtime.resolve(ctx);
			const composed = runtime.compose(event.systemPrompt, resolution);
			block = composed.block;
			runtime.markApplied(
				ctx,
				block ? resolution.profile?.layers[0]?.hash : undefined,
			);
			runtime.observed = undefined;
			runtime.updateStatus(ctx);
			return composed.systemPrompt === undefined
				? undefined
				: { systemPrompt: composed.systemPrompt };
		} catch (cause) {
			block = undefined;
			ctx.ui.notify(
				`pi-prompt-profiles: ${messageOf(cause)}; Pi keeps its native prompt.`,
				"error",
			);
			return undefined;
		}
	});

	pi.on("before_provider_request", async (event, ctx: ExtensionContext) => {
		// Read only: never repair the payload by rewriting it.
		runtime.observe(event.payload, block);
		if (!block) {
			return undefined;
		}
		runtime.updateStatus(ctx);
		if (!warned && !runtime.observed?.blockPresent) {
			warned = true;
			ctx.ui.notify(
				runtime.observed?.systemFound
					? "pi-prompt-profiles: the selected profile was not found in this request. Another extension may have replaced the complete system prompt."
					: "pi-prompt-profiles: this provider payload format could not be checked; the selected profile is not confirmed in this request.",
				"warning",
			);
		}
		return undefined;
	});
}
