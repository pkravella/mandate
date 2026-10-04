import { describe, expect, it } from "vitest";

describe("toolchain", () => {
  it("runs ESM TypeScript under strict settings", () => {
    const xs: readonly number[] = [1];
    // noUncheckedIndexedAccess makes this `number | undefined`, which is the
    // setting we actually want to confirm is on.
    const first: number | undefined = xs[0];
    expect(first).toBe(1);
  });
});
