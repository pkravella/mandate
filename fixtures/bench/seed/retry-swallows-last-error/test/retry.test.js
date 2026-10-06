import test from "node:test";
import assert from "node:assert/strict";
import { retry } from "../src/retry.js";

test("returns the first successful result", async () => {
  let calls = 0;
  const out = await retry(async () => { calls += 1; if (calls < 2) throw new Error("x"); return "ok"; }, 3);
  assert.equal(out, "ok");
});

test("stops after the given number of attempts", async () => {
  let calls = 0;
  await retry(async () => { calls += 1; throw new Error("boom"); }, 2).catch(() => {});
  assert.equal(calls, 2);
});

// Fails on the seeded bug: retry() resolves with undefined instead of
// rejecting, so a total failure is indistinguishable from a function that
// legitimately returned nothing.
test("rejects with the last error when every attempt fails", async () => {
  let calls = 0;
  await assert.rejects(
    retry(async () => { calls += 1; throw new Error(`failure ${calls}`); }, 3),
    { message: "failure 3" },
  );
});
