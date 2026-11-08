import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { queryUsage } from "../src/usage-query.ts";

const session = { getSessionId: () => "id" } as ExtensionContext["sessionManager"];
const api = (emit: (...args: any[]) => void) => ({ events: { emit } }) as unknown as ExtensionAPI;

test("offers close synchronously; duplicate and late rejected promises are observed", async () => {
  let request: any;
  let duplicate: boolean | undefined;
  const c = new AbortController();
  const result = queryUsage(api((_, r) => {
    request = r;
    assert.equal(r.respond(Promise.resolve("first")), true);
    duplicate = r.respond(Promise.reject(new Error("duplicate")));
  }), session, "id", "p", c, 100);
  assert.equal(duplicate, false);
  assert.equal(request.respond(Promise.reject(new Error("late"))), false);
  assert.deepEqual(await result, { kind: "result", value: "first" });
  await new Promise(resolve => setImmediate(resolve));
});

test("absence closes offer window and aborts; deadline aborts accepted work", async () => {
  let request: any;
  const absent = new AbortController();
  assert.deepEqual(await queryUsage(api((_, r) => { request = r; }), session, "id", "p", absent, 100), { kind: "no-service" });
  assert.equal(absent.signal.aborted, true);
  assert.equal(request.respond(Promise.reject(new Error("late"))), false);
  const c = new AbortController();
  assert.deepEqual(await queryUsage(api((_, r) => r.respond(new Promise(() => {}))), session, "id", "p", c, 5), { kind: "timeout" });
  assert.equal(c.signal.aborted, true);
});

test("abort promptly settles accepted request", async () => {
  const c = new AbortController();
  const pending = queryUsage(api((_, r) => r.respond(new Promise(() => {}))), session, "id", "p", c, 1000);
  c.abort();
  assert.deepEqual(await pending, { kind: "cancelled" });
});
