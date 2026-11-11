import { createHash } from "node:crypto";
import { MANAGED_BEGIN, MANAGED_END } from "./markers.js";
import type { ResolvedProfile } from "./types.js";

export { MANAGED_BEGIN, MANAGED_END } from "./markers.js";

function hashText(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

export function composeManagedBlock(profile: ResolvedProfile): string {
	const parts: string[] = [MANAGED_BEGIN, ""];
	// The block carries no heading and no statement about priority or
	// inheritance. Layers carry no heading either: the prompt must not reveal
	// the profile id, its scope or the fact that a base profile was inherited.
	// Order plus a blank line is enough to keep them apart.
	for (const layer of profile.layers) {
		parts.push(layer.content, "");
	}
	parts.push(MANAGED_END);
	return parts.join("\n");
}

export interface StripResult {
	text: string;
	removed: number;
	/** True when a begin marker had no matching end marker. */
	unterminated: boolean;
}

/**
 * Removes the leading managed block, if any. This extension always prepends its
 * block, so only a block at the very start of the prompt can be its own. Text
 * elsewhere in the prompt that merely contains the markers is left untouched.
 */
export function stripManagedBlocks(prompt: string): StripResult {
	let text = prompt;
	let removed = 0;
	let unterminated = false;
	while (text.startsWith(MANAGED_BEGIN)) {
		const end = text.indexOf(MANAGED_END, MANAGED_BEGIN.length);
		if (end < 0) {
			unterminated = true;
			break;
		}
		text = text.slice(end + MANAGED_END.length).replace(/^\n+/, "");
		removed += 1;
	}
	return { text, removed, unterminated };
}

export interface ComposeResult {
	systemPrompt: string;
	block?: string;
	hash: string;
	stripped: number;
	unterminated: boolean;
}

/**
 * Produces the effective system prompt: exactly one managed block, then the
 * prompt Pi composed. The operation is idempotent because any previous block
 * emitted by this extension is removed first.
 */
export function applyManagedPrompt(
	basePrompt: string,
	profile: ResolvedProfile | undefined,
): ComposeResult {
	const stripped = stripManagedBlocks(basePrompt);
	const remainder = stripped.text.replace(/^\n+/, "");
	if (!profile) {
		return {
			systemPrompt: remainder,
			hash: "",
			stripped: stripped.removed,
			unterminated: stripped.unterminated,
		};
	}
	const block = composeManagedBlock(profile);
	return {
		systemPrompt: `${block}\n\n${remainder}`,
		block,
		hash: hashText(block),
		stripped: stripped.removed,
		unterminated: stripped.unterminated,
	};
}
