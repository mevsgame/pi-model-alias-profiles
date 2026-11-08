import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALIASES, ConfigStore, validateName, type Config } from "../src/config.js";

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "model-profiles-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "nested", "model-profiles.json");
  return { dir, path, store: new ConfigStore(path) };
}
const config = (): Config => ({
  version: 1, defaultProfile: "work", lastActiveProfile: "work",
  profiles: { work: { large: "provider/model/with/slashes" }, draft: {} },
});

test("aliases and profile names", () => {
  assert.deepEqual(ALIASES, ["large", "medium", "small"]);
  for (const name of ["work", "local-2", "a.b_c", "123"]) assert.doesNotThrow(() => validateName(name));
  for (const name of ["", " spaced", "../x", "a/b", "next", "STATUS", "__proto__", "constructor", "toString", "x".repeat(65)]) {
    assert.throws(() => validateName(name), /Invalid or reserved/);
  }
});

test("missing configuration and atomic roundtrip including drafts", (t) => {
  const { store, path } = fixture(t);
  assert.deepEqual(store.load(), { version: 1, profiles: {} });
  store.save(config());
  assert.deepEqual(new ConfigStore(path).load(), config());
  assert.deepEqual(readdirSync(join(path, "..")), ["model-profiles.json"]);
  store.save({ version: 1, profiles: {} });
  assert.deepEqual(store.load(), { version: 1, profiles: {} });
});

test("malformed files preserved and writes blocked until successful reload", (t) => {
  const { store, path } = fixture(t);
  store.save(config());
  for (const bad of ["{broken", '{"version":2,"profiles":{}}', '{"version":1,"profiles":{"__proto__":{}}}']) {
    writeFileSync(path, bad);
    assert.throws(() => store.load(), /preserved/);
    assert.throws(() => store.save(config()), /load failed/);
    assert.equal(readFileSync(path, "utf8"), bad);
  }
  writeFileSync(path, JSON.stringify(config()));
  store.load();
  assert.doesNotThrow(() => store.save(config()));
});

test("schema rejects invalid mappings without damaging existing configuration", (t) => {
  const { store, path } = fixture(t);
  store.save(config());
  const before = readFileSync(path, "utf8");
  for (const profiles of [
    { work: { big: "p/m" } }, { work: { large: 42 } },
    { work: { large: "tier/small" } }, { work: { large: "missing-provider" } },
    { work: [] }, { status: {} },
  ]) {
    assert.throws(() => store.save({ version: 1, profiles } as unknown as Config));
    assert.equal(readFileSync(path, "utf8"), before);
  }
});

test("optimistic conflict check detects another writer and requires reload", (t) => {
  const { store, path } = fixture(t);
  store.load();
  const second = new ConfigStore(path);
  second.load();
  second.save(config());
  assert.throws(() => store.save({ version: 1, profiles: {} }), /conflict/);
  assert.deepEqual(new ConfigStore(path).load(), config());
  store.load();
  assert.doesNotThrow(() => store.save(config()));
});

test("content change including deletion or formatting is not silently overwritten", (t) => {
  const { store, path } = fixture(t);
  store.save(config());
  writeFileSync(path, JSON.stringify(config()));
  assert.throws(() => store.save(config()), /conflict/);
  store.load();
  rmSync(path);
  assert.throws(() => store.save(config()), /conflict/);
});

test("exclusive lock refuses writer and preserves existing data", (t) => {
  const { store, path } = fixture(t);
  store.save(config());
  const before = readFileSync(path, "utf8");
  writeFileSync(`${path}.lock`, "another writer");
  assert.throws(() => store.save(config()), /another writer/);
  assert.equal(readFileSync(path, "utf8"), before);
  assert.equal(readFileSync(`${path}.lock`, "utf8"), "another writer");
  rmSync(`${path}.lock`);
  assert.doesNotThrow(() => store.save(config()));
});
