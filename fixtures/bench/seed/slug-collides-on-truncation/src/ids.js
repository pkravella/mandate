import { slug } from "./slug.js";

/**
 * A stable id for a task.
 *
 * Two tasks whose text begins with the same words truncate to the same slug,
 * so this returns the same id for both and anything keyed on it collides.
 */
export function taskId(text) {
  return slug(text);
}
