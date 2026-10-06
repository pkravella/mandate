import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const pins = JSON.parse(readFileSync(new URL("../vendor/toolchain.json", import.meta.url), "utf8")).pins;

test("every pin is an exact version", () => {
  for (const [name, version] of Object.entries(pins)) {
    assert.match(version, /^\d+\.\d+\.\d+$/, `${name} must be pinned exactly`);
  }
});

// Fails until the pin is bumped.
test("the linter is pinned at 2.5.0", () => {
  assert.equal(pins.linter, "2.5.0");
});

test("the formatter pin is left alone", () => {
  assert.equal(pins.formatter, "3.0.0");
});
