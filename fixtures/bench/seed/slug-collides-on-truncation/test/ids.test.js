import test from "node:test";
import assert from "node:assert/strict";
import { taskId } from "../src/ids.js";

test("is stable for the same input", () => {
  assert.equal(taskId("Fix the retry loop"), taskId("Fix the retry loop"));
});

// Fails on the seeded bug: slug() truncates at 48 characters on a word
// boundary, so two tasks sharing an opening get one id between them.
test("distinguishes two long tasks that start with the same words", () => {
  // Both truncate to "fix-the-flaky-retry-loop-in-the-scheduler": they diverge
  // only after the 48-character cut, which is the whole point. Strings that
  // differ earlier do not collide and would make this test vacuous.
  const a = taskId("Fix the flaky retry loop in the scheduler module and rethrow the last error");
  const b = taskId("Fix the flaky retry loop in the scheduler module and log the last error");
  assert.notEqual(a, b);
});
