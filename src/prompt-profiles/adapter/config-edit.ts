import fs from "node:fs";
import { atomicWriteFile, readTextIfExists, stripBom } from "../core/paths.js";

export type RawConfig = Record<string, unknown>;

function messageOf(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

export interface ConfigSnapshot {
	config: RawConfig;
	exists: boolean;
	mtimeMs: number | undefined;
}

export function readRawConfig(filePath: string): ConfigSnapshot {
	const text = readTextIfExists(filePath);
	if (text === undefined) {
		return { config: { version: 1 }, exists: false, mtimeMs: undefined };
	}
	const parsed: unknown = (() => {
		try {
			return JSON.parse(stripBom(text));
		} catch (cause) {
			throw new Error(`${filePath}: invalid JSON (${messageOf(cause)}).`);
		}
	})();
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`${filePath}: the root must be a JSON object`);
	}
	let mtimeMs: number | undefined;
	try {
		mtimeMs = fs.statSync(filePath).mtimeMs;
	} catch {
		mtimeMs = undefined;
	}
	return { config: parsed as RawConfig, exists: true, mtimeMs };
}

/**
 * Writes only when the file has not changed since it was read, so a concurrent
 * edit is reported instead of being overwritten. Unknown fields are preserved
 * because the whole object is rewritten.
 */
export function writeRawConfigIfUnchanged(
	filePath: string,
	snapshot: ConfigSnapshot,
	next: RawConfig,
): void {
	if (snapshot.exists) {
		const current = fs.statSync(filePath).mtimeMs;
		if (snapshot.mtimeMs !== undefined && current !== snapshot.mtimeMs) {
			throw new Error(
				`${filePath} changed on disk since it was read; reload and try again.`,
			);
		}
	} else if (fs.existsSync(filePath)) {
		throw new Error(
			`${filePath} appeared on disk since it was read; reload and try again.`,
		);
	}
	atomicWriteFile(filePath, `${JSON.stringify(next, null, "\t")}\n`);
}
