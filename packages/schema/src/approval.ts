import { createHash } from "node:crypto";
import { mandateHash } from "./canonical.js";
import type { Mandate } from "./mandate.js";

/**
 * R5: what a person approves when they approve a mandate.
 *
 * Not the mandate's hash alone. The permission diff an approver reads depends
 * on the mandate, on the ceiling it was proved against and on whose authority
 * bounded it, so the approval binds all three: a mandate edited after review,
 * the same mandate validated against another ceiling, or the same mandate
 * requested by someone else is a different thing to approve.
 *
 * Content-addressed through `mandateHash`, so grant and pattern order -- which
 * change nothing a mandate permits -- do not invalidate an approval.
 */
export const APPROVAL_FORMAT = "mandate-approval/1";

/** The command an approver posts, followed by the digest. */
export const APPROVE_COMMAND = "/mandate approve";

export function approvalDigest(mandate: Mandate, ceilingSha256: string, requester: string): string {
  if (!requester.startsWith("user:")) {
    throw new Error(`an approval names a user:<login> requester, not ${JSON.stringify(requester)}`);
  }
  // GitHub logins are case-insensitive, and requestedBy is checked against
  // --as without case; the approval must agree with both.
  const login = requester.slice("user:".length).toLowerCase();
  return createHash("sha256")
    .update(`${APPROVAL_FORMAT}\n${mandateHash(mandate)}\n${ceilingSha256}\n${login}`)
    .digest("hex");
}

/** The exact line an approver posts. */
export const approvalLine = (digest: string): string => `${APPROVE_COMMAND} ${digest}`;
