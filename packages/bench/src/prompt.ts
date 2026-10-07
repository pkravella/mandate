import type { LoadedTask } from "./tasks.js";

/**
 * The task as an agent is asked it, shared by **both** benchmark passes.
 *
 * Shared because it was not, and the divergence silently invalidated a whole
 * sweep: the unconstrained prompt asked for a pull request and the mandated one
 * did not. Ground truth therefore contained `create_pull_request` only because
 * the unconstrained agent had been told to open one, the writer correctly
 * granted nothing for a pull request nobody asked for, and the comparison
 * between the two passes was meaningless — the under-grant it reported was an
 * artifact of the two prompts, not a property of the mandate.
 *
 * A benchmark whose two passes are asked different questions measures nothing.
 * One function, called by both, is the only way to keep that true as either
 * pass changes.
 */
export function taskPrompt(
  task: LoadedTask, repo: string, issueNumber: number,
): string {
  return `Fix issue #${issueNumber} in ${repo}.\n\n`
    + `Title: ${task.issue.title}\n\n${task.issue.body}\n\n`
    + `Repository: ${repo}. Read a file before updating it, because an update needs its sha. `
    + `Work on a branch named ${branchFor(task)} and open a pull request when you are done, `
    + `unless the issue says otherwise. When you are finished, say DONE.`;
}

/** The branch a task's work belongs on. Derived, so both passes agree. */
export const branchFor = (task: LoadedTask): string => `agent/${task.id}`;
