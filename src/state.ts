export const STATE_ENTRY = "model-profiles.selection";
export function branchProfile(entries: readonly { type: string; customType?: string; data?: unknown }[]): string | null | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.type === "custom" && entry.customType === STATE_ENTRY) {
      const data = entry.data as { profile?: unknown } | undefined;
      if (typeof data?.profile === "string") return data.profile;
      if (data?.profile === null) return null;
    }
  }
  return undefined;
}
