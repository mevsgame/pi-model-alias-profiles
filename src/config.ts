import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export const ALIASES = ["large", "medium", "small"] as const;
export type Alias = (typeof ALIASES)[number];
export type Profile = Partial<Record<Alias, string>>;
export interface Config {
  version: 1;
  defaultProfile?: string;
  lastActiveProfile?: string;
  profiles: Record<string, Profile>;
}

const reserved = new Set(["next", "status", ...Object.getOwnPropertyNames(Object.prototype)].map((name) => name.toLowerCase()));

export function validateName(name: string): void {
  if (typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name) || reserved.has(name.toLowerCase())) {
    throw new Error(`Invalid or reserved profile name: ${JSON.stringify(name)}. Use 1–64 letters, digits, dots, underscores or hyphens, starting with a letter or digit.`);
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Validate without consulting the model registry: incomplete drafts are permitted. */
function validateConfig(value: unknown): asserts value is Config {
  if (!object(value) || value.version !== 1 || !object(value.profiles)) {
    throw new Error("Invalid model profiles configuration: expected version 1 and a profiles object.");
  }
  for (const key of Object.keys(value)) {
    if (!["version", "profiles", "defaultProfile", "lastActiveProfile"].includes(key)) {
      throw new Error(`Unknown configuration field: ${key}`);
    }
  }
  for (const key of ["defaultProfile", "lastActiveProfile"]) {
    if (value[key] !== undefined) validateName(value[key] as string);
  }
  for (const [name, profile] of Object.entries(value.profiles)) {
    validateName(name);
    if (!object(profile)) throw new Error(`Invalid profile "${name}": expected an object.`);
    for (const [alias, target] of Object.entries(profile)) {
      if (!(ALIASES as readonly string[]).includes(alias) || typeof target !== "string" || !/^[^/\s]+\/\S+$/.test(target)) {
        throw new Error(`Invalid mapping "${name}.${alias}": expected a physical provider/modelId.`);
      }
      if (target.startsWith("tier/")) throw new Error(`Invalid mapping "${name}.${alias}": virtual tier models cannot be targets.`);
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

/** One store per process. Call load again to explicitly accept an external change. */
export class ConfigStore {
  private baseline: string | undefined;
  private loaded = false;
  private blocked = false;

  constructor(readonly path: string) {}

  load(): Config {
    try {
      const content = readContent(this.path);
      const config: unknown = content === undefined ? { version: 1, profiles: {} } : JSON.parse(content);
      validateConfig(config);
      this.baseline = content;
      this.loaded = true;
      this.blocked = false;
      return config;
    } catch (error) {
      this.blocked = true;
      throw new Error(`Cannot load ${this.path}; existing data was preserved: ${(error as Error).message}`, { cause: error });
    }
  }

  save(config: Config): void {
    if (this.blocked) throw new Error(`Cannot save ${this.path}: configuration load failed. Repair the file and load it again first.`);
    if (!this.loaded) this.load();
    validateConfig(config);
    const content = `${JSON.stringify(config, null, 2)}\n`;
    mkdirSync(dirname(this.path), { recursive: true });
    const lockPath = `${this.path}.lock`;
    let lock: number;
    try {
      lock = openSync(lockPath, "wx", 0o600);
    } catch (error) {
      throw new Error(`Cannot lock ${this.path}; another writer may be active. Retry after it finishes (inspect ${lockPath} if stale).`, { cause: error });
    }
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    let tempCreated = false;
    try {
      if (readContent(this.path) !== this.baseline) {
        throw new Error(`Configuration conflict: ${this.path} changed externally. Reload before saving.`);
      }
      const fd = openSync(temporary, "wx", 0o600);
      tempCreated = true;
      try {
        writeFileSync(fd, content, "utf8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, this.path);
      tempCreated = false;
      this.baseline = content;
    } finally {
      try {
        if (tempCreated) unlinkSync(temporary);
      } finally {
        try { closeSync(lock); } finally { unlinkSync(lockPath); }
      }
    }
  }
}
