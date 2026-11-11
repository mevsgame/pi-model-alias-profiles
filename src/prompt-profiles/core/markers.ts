/**
 * Delimiters for the managed block. They keep the block identifiable and unique
 * without naming the extension. Profile bodies are rejected when they contain
 * them (see `loadProfiles`), so a profile can never forge or truncate a block.
 */
export const MANAGED_BEGIN = "<!-- system-instructions:begin v1 -->";
export const MANAGED_END = "<!-- system-instructions:end -->";

export function containsManagedMarkers(text: string): boolean {
	return text.includes(MANAGED_BEGIN) || text.includes(MANAGED_END);
}
