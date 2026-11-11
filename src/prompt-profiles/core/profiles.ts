import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { error, warn } from "./diagnostics.js";
import { isSafeId } from "./ids.js";
import { containsManagedMarkers } from "./markers.js";
import {
	isRealPathInside,
	profilesDir,
	readTextIfExists,
	stripBom,
} from "./paths.js";
import type {
	Diagnostic,
	LoadedProfile,
	ProfileCatalog,
	ProfileMeta,
	Scope,
} from "./types.js";

export const DEFAULT_MAX_PROFILE_BYTES = 64 * 1024;

export function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Discovers `profiles/<id>.md` files. The file name is the profile id.
 * Invalid names, oversized files and symlinks escaping the root are skipped
 * with a diagnostic instead of failing the whole catalog.
 */
export function loadProfiles(
	root: string,
	scope: Scope,
	meta: Record<string, ProfileMeta> | undefined,
	maxBytes: number = DEFAULT_MAX_PROFILE_BYTES,
): ProfileCatalog {
	const directory = profilesDir(root);
	const profiles = new Map<string, LoadedProfile>();
	const diagnostics: Diagnostic[] = [];

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(directory, { withFileTypes: true });
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
			return { scope, profiles, createDiagnostics: [] };
		}
		return {
			scope,
			profiles,
			createDiagnostics: [
				error("profiles-dir", `Could not read ${directory}: ${String(cause)}`),
			],
		};
	}

	const seenCaseInsensitive = new Map<string, string>();

	for (const entry of entries) {
		if (!entry.isFile() && !entry.isSymbolicLink()) {
			continue;
		}
		if (!entry.name.toLowerCase().endsWith(".md")) {
			continue;
		}
		const id = entry.name.slice(0, -3);
		if (!isSafeId(id)) {
			diagnostics.push(
				warn(
					"profile-id",
					`Ignoring ${entry.name}: the file name is not a safe profile id.`,
				),
			);
			continue;
		}
		const filePath = path.join(directory, entry.name);
		if (!isRealPathInside(root, filePath)) {
			diagnostics.push(
				error(
					"profile-symlink",
					`Refusing ${entry.name}: it resolves outside ${root}.`,
				),
			);
			continue;
		}
		const folded = id.toLowerCase();
		const previous = seenCaseInsensitive.get(folded);
		if (previous !== undefined && previous !== id) {
			diagnostics.push(
				warn(
					"profile-case",
					`Profiles "${previous}" and "${id}" collide on case-insensitive filesystems.`,
				),
			);
		}
		seenCaseInsensitive.set(folded, id);

		const raw = readTextIfExists(filePath);
		if (raw === undefined) {
			continue;
		}
		const content = stripBom(raw);
		if (containsManagedMarkers(content)) {
			diagnostics.push(
				error(
					"profile-marker",
					`Profile "${id}" contains a reserved managed-block marker and was skipped.`,
				),
			);
			continue;
		}
		if (Buffer.byteLength(content, "utf8") > maxBytes) {
			diagnostics.push(
				error(
					"profile-too-large",
					`Profile "${id}" exceeds ${maxBytes} bytes and was skipped.`,
				),
			);
			continue;
		}
		const loaded: LoadedProfile = {
			id,
			scope,
			path: filePath,
			content,
			hash: sha256(content),
		};
		const description = meta?.[id]?.description;
		if (description !== undefined) {
			loaded.description = description;
		}
		profiles.set(id, loaded);
	}

	return { scope, profiles, createDiagnostics: diagnostics };
}
