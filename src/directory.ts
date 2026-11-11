import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * The active profile per starting directory, kept in one file in the agent dir:
 *   { "version": 1, "directories": { "<realpath of cwd>": "profile" | null } }
 * Git never sees it. `null` is an explicit no-profile choice.
 */
export interface DirectoryMap {
  version: 1;
  directories: Record<string, string | null>;
}

/** Key for a starting directory: its resolved real path, so symlinked paths share one entry. */
export function directoryKey(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return resolve(cwd);
  }
}

function validateMap(value: unknown, path: string): asserts value is DirectoryMap {
  const object = value !== null && typeof value === "object" && !Array.isArray(value);
  if (!object || (value as { version?: unknown }).version !== 1 || typeof (value as { directories?: unknown }).directories !== "object" || (value as { directories?: unknown }).directories === null) {
    throw new Error(`Invalid ${path}: expected {"version":1,"directories":{...}}.`);
  }
  for (const [key, profile] of Object.entries((value as DirectoryMap).directories)) {
    if (!key || !(profile === null || typeof profile === "string")) {
      throw new Error(`Invalid ${path}: entry ${JSON.stringify(key)} must map to a profile name or null.`);
    }
  }
}

function readContent(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function parse(path: string, content: string | undefined): DirectoryMap {
  if (content === undefined) return { version: 1, directories: {} };
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${(error as Error).message}`, { cause: error });
  }
  validateMap(value, path);
  return value;
}

export class DirectoryStore {
  constructor(readonly path: string) {}

  /** undefined: this directory has no saved choice. null: explicitly no profile. */
  read(cwd: string): string | null | undefined {
    const map = parse(this.path, readContent(this.path));
    const key = directoryKey(cwd);
    return Object.hasOwn(map.directories, key) ? map.directories[key] : undefined;
  }

  /** Locked read-modify-write of one key, so concurrent windows keep each other's entries. */
  write(cwd: string, profile: string | null): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const lockPath = `${this.path}.lock`;
    let lock: number;
    try {
      lock = openSync(lockPath, "wx", 0o600);
    } catch (error) {
      throw new Error(`Cannot lock ${this.path}; another window may be writing. Retry (inspect ${lockPath} if stale).`, { cause: error });
    }
    let temporary: string | undefined;
    try {
      const current = readContent(this.path);
      const map = parse(this.path, current);
      map.directories[directoryKey(cwd)] = profile;
      temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(map, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, this.path);
      temporary = undefined;
    } finally {
      try {
        if (temporary) unlinkSync(temporary);
      } finally {
        try { closeSync(lock); } finally { unlinkSync(lockPath); }
      }
    }
  }
}
