import { createHash } from "node:crypto";
import { slug } from "./slug.js";

/**
 * A stable id for a task.
 *
 * The slug alone collides, because it truncates on a word boundary: two tasks
 * sharing an opening produce the same one. A short digest of the full text
 * keeps the id readable and distinct.
 */
export function taskId(text) {
  const digest = createHash("sha256").update(text).digest("hex").slice(0, 8);
  return `${slug(text)}-${digest}`;
}
