import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DirectoryStore, directoryKey } from "../src/directory.ts";

function tempDir(t: { after(fn: () => void): void }, prefix = "profiles-dir-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("one agent-dir map stores each directory's profile; unknown directories have no choice", t => {
  const store = new DirectoryStore(join(tempDir(t, "agent-"), "model-profile-directories.json"));
  const a = tempDir(t), b = tempDir(t), c = tempDir(t);
  assert.equal(store.read(a), undefined);
  store.write(a, "fast");
  store.write(b, "deep");
  store.write(c, null);
  assert.equal(store.read(a), "fast");
  assert.equal(store.read(b), "deep");
  assert.equal(store.read(c), null);
  const map = JSON.parse(readFileSync(store.path, "utf8"));
  assert.equal(map.version, 1);
  assert.equal(map.directories[directoryKey(a)], "fast");
});

test("writes keep other directories' entries (merge, not overwrite)", t => {
  const store = new DirectoryStore(join(tempDir(t, "agent-"), "map.json"));
  const a = tempDir(t), b = tempDir(t);
  store.write(a, "one");
  store.write(b, "two");
  store.write(a, "three");
  assert.equal(store.read(a), "three");
  assert.equal(store.read(b), "two");
});

test("symlinked directory shares one entry with its target", t => {
  const store = new DirectoryStore(join(tempDir(t, "agent-"), "map.json"));
  const real = tempDir(t);
  const link = join(tempDir(t), "link");
  symlinkSync(real, link);
  store.write(link, "linked");
  assert.equal(store.read(real), "linked");
});

test("malformed map is reported and never overwritten; lock is released on failure", t => {
  const path = join(tempDir(t, "agent-"), "map.json");
  const store = new DirectoryStore(path);
  const cwd = tempDir(t);
  for (const content of ["{broken", "null", JSON.stringify({ version: 2, directories: {} }), JSON.stringify({ version: 1, directories: { x: 3 } })]) {
    writeFileSync(path, content);
    assert.throws(() => store.read(cwd), /Cannot read|Invalid/);
    assert.throws(() => store.write(cwd, "x"), /Cannot read|Invalid/);
    assert.equal(readFileSync(path, "utf8"), content);
    assert.equal(existsSync(`${path}.lock`), false);
  }
});

test("a held lock blocks writes with a retry message", t => {
  const path = join(tempDir(t, "agent-"), "map.json");
  writeFileSync(`${path}.lock`, "");
  assert.throws(() => new DirectoryStore(path).write(tempDir(t), "x"), /Cannot lock/);
  rmSync(`${path}.lock`);
});
