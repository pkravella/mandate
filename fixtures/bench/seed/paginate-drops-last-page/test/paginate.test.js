import test from "node:test";
import assert from "node:assert/strict";
import { collectAll } from "../src/paginate.js";

const pages = (...ps) => (n) => Promise.resolve({ items: ps[n], hasMore: n < ps.length - 1 });

// Fails on the seeded bug: the loop exits on the current page's hasMore, so
// the final page is fetched and then discarded.
test("collects every page, including the last", async () => {
  assert.deepEqual(await collectAll(pages(["a"], ["b"], ["c"])), ["a", "b", "c"]);
});

test("collects a single page", async () => {
  assert.deepEqual(await collectAll(pages(["only"])), ["only"]);
});
