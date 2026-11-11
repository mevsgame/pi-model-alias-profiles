import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveRef } from "../core/refs.js";
import type { Selection } from "../core/types.js";

export const SELECTION_CUSTOM_TYPE = "pi-prompt-profiles/selection";

export interface PersistedSelection {
	mode: "auto" | "manual" | "off";
	profile?: string;
}

function parsePersisted(data: unknown): PersistedSelection | undefined {
	if (typeof data !== "object" || data === null) {
		return undefined;
	}
	const record = data as Record<string, unknown>;
	const mode = record.mode;
	if (mode === "auto" || mode === "off") {
		return { mode };
	}
	if (mode === "manual" && typeof record.profile === "string") {
		const ref = resolveRef(record.profile, "global");
		if (!ref) {
			return undefined;
		}
		return { mode: "manual", profile: `${ref.scope}:${ref.id}` };
	}
	return undefined;
}

/**
 * Reads the newest selection stored on the active branch. Walking the branch
 * (not the whole entry list) keeps tree navigation and forks correct.
 */
export function readPersistedSelection(
	sessionManager: ExtensionContext["sessionManager"],
): PersistedSelection | undefined {
	const branch = sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (
			entry &&
			entry.type === "custom" &&
			entry.customType === SELECTION_CUSTOM_TYPE
		) {
			const parsed = parsePersisted(entry.data);
			if (parsed) {
				return parsed;
			}
			// The newest selection entry is authoritative. If it cannot be parsed,
			// fall back to the default instead of resurrecting an older pin.
			return undefined;
		}
	}
	return undefined;
}

export function selectionToPersisted(selection: Selection): PersistedSelection {
	if (selection.mode === "manual" && selection.profile) {
		return { mode: "manual", profile: selection.profile };
	}
	return { mode: selection.mode === "manual" ? "auto" : selection.mode };
}

export function selectionLabel(selection: Selection): string {
	if (selection.mode === "manual") {
		return selection.profile ?? "manual";
	}
	return selection.mode;
}
