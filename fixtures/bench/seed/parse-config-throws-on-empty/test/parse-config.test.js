import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/parse-config.js";

test("reads key=value pairs", () => {
  assert.deepEqual(parseConfig("a=1\nb=2"), { a: "1", b: "2" });
});

test("keeps the defaults it was given", () => {
  assert.deepEqual(parseConfig("a=1", { b: "2" }), { a: "1", b: "2" });
});

// Fails on the seeded bug: splitting "" yields [""], and the code then calls
// .trim() on an undefined value.
test("returns the defaults for an empty file", () => {
  assert.deepEqual(parseConfig("", { a: "1" }), { a: "1" });
});

test("skips a blank line between entries", () => {
  assert.deepEqual(parseConfig("a=1\n\nb=2"), { a: "1", b: "2" });
});
