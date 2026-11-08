import { test } from "node:test";
import assert from "node:assert/strict";
import { branchProfile, STATE_ENTRY } from "../src/state.ts";

const entry = (profile: unknown) => ({ type: "custom", customType: STATE_ENTRY, data: { profile } });

test("branch selection uses the newest valid selection on the supplied ancestry only", () => {
  const root = [entry("root")];
  const left = [...root, entry("left")];
  const right = [...root, entry("right")];
  assert.equal(branchProfile(left), "left");
  assert.equal(branchProfile(right), "right");
  assert.equal(branchProfile(root), "root");
  assert.equal(branchProfile([]), undefined);
  assert.deepEqual(root, [entry("root")]);
});

test("unrelated and malformed entries do not mask prior valid selections", () => {
  const noise = [
    { type: "message", customType: STATE_ENTRY, data: { profile: "wrong" } },
    { type: "custom", customType: "other", data: { profile: "wrong" } },
    { type: "custom", customType: STATE_ENTRY },
    ...[null, {}, [], 12, { profile: 12 }, { profile: undefined }].map(data => ({ type: "custom", customType: STATE_ENTRY, data })),
  ];
  assert.equal(branchProfile(noise), undefined);
  assert.equal(branchProfile([entry("saved"), ...noise]), "saved");
  assert.equal(branchProfile([entry("deleted-profile")]), "deleted-profile");
  assert.equal(branchProfile([entry("")]), "");
});

test("explicit null pins no selection and can be superseded by a later selection", () => {
  assert.equal(branchProfile([entry(null)]), null);
  assert.equal(branchProfile([entry("saved"), entry(null), entry(undefined)]), null);
  assert.equal(branchProfile([entry(null), entry("saved")]), "saved");
});
