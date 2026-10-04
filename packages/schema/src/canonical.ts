import { createHash } from "node:crypto";
import type { Mandate } from "./mandate.js";

/**
 * Deterministic serialization: keys sorted, order-insensitive arrays sorted,
 * no whitespace. Two mandates granting the same authority hash the same, so an
 * approval can be cached against the hash and is invalidated by any change to
 * what the mandate permits.
 *
 * Symbol-keyed properties are ignored by JSON.stringify, so a ValidatedMandate
 * hashes identically to its plain form.
 */
export function canonicalize(m: Mandate): string {
  return JSON.stringify(sortValue(m));
}

function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) {
    return v
      .map(sortValue)
      .map((x) => [JSON.stringify(x), x] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([, x]) => x);
  }
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const val = (v as Record<string, unknown>)[k];
      if (val !== undefined) out[k] = sortValue(val);
    }
    return out;
  }
  return v;
}

export function mandateHash(m: Mandate): string {
  return createHash("sha256").update(canonicalize(m)).digest("hex");
}
