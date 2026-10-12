import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { approvalDigest, approvalLine, APPROVAL_FORMAT } from "./approval.js";
import { mandateHash } from "./canonical.js";
import type { Mandate } from "./mandate.js";

const M: Mandate = {
  mandate: "fix-issue-42", task: "Fix issue #42", requestedBy: "user:alice", expiresInMinutes: 30,
  ceiling: "org-policy@v12",
  grants: [{ action: "contents.read", enforcedBy: "token", resources: ["acme/api"] }],
  destinations: { allow: ["github.com/acme/api"] },
};
const CEILING = "c".repeat(64);

describe("approvalDigest", () => {
  it("is sha256 over the format, the mandate's hash, the ceiling's sha256 and the requester", () => {
    const expected = createHash("sha256")
      .update(`${APPROVAL_FORMAT}\n${mandateHash(M)}\n${CEILING}\nalice`).digest("hex");
    expect(approvalDigest(M, CEILING, "user:alice")).toBe(expected);
  });

  // What the approver saw depended on all three, so changing any one is a
  // different thing to approve.
  it("changes with the mandate's content", () => {
    const wider = { ...M, grants: [{ ...M.grants[0]!, resources: ["acme/*"] }] };
    expect(approvalDigest(wider, CEILING, "user:alice")).not.toBe(approvalDigest(M, CEILING, "user:alice"));
  });

  it("changes with the ceiling", () => {
    expect(approvalDigest(M, "d".repeat(64), "user:alice")).not.toBe(approvalDigest(M, CEILING, "user:alice"));
  });

  it("changes with the requester, and ignores the case GitHub ignores", () => {
    expect(approvalDigest(M, CEILING, "user:bob")).not.toBe(approvalDigest(M, CEILING, "user:alice"));
    expect(approvalDigest(M, CEILING, "user:Alice")).toBe(approvalDigest(M, CEILING, "user:alice"));
  });

  // Pattern order and key order do not change what a mandate grants, so they
  // do not change what was approved: the digest rides on mandateHash.
  it("does not change with grant order", () => {
    const two: Mandate = {
      ...M,
      grants: [
        { action: "contents.read", enforcedBy: "token", resources: ["acme/api"] },
        { action: "repo.read", enforcedBy: "token", resources: ["acme/api"] },
      ],
    };
    const swapped = { ...two, grants: [two.grants[1]!, two.grants[0]!] };
    expect(approvalDigest(swapped, CEILING, "user:alice")).toBe(approvalDigest(two, CEILING, "user:alice"));
  });

  it("refuses a requester that is not a user", () => {
    expect(() => approvalDigest(M, CEILING, "app:bot")).toThrow(/user:/);
  });
});

describe("approvalLine", () => {
  it("is the exact line an approver posts", () => {
    expect(approvalLine("a".repeat(64))).toBe(`/leastpilot approve ${"a".repeat(64)}`);
  });
});
