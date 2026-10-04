/**
 * Why the writer produced nothing.
 *
 * The writer is the one model-driven component, so every way its output can be
 * unusable has to be a named, printable outcome rather than a stack trace: R10
 * requires that a stop names what it hit, and "the mandate was never written"
 * is a stop like any other. A `WriterError` always means no mandate — the
 * writer never returns a partial proposal.
 */
export type WriterErrorCode =
  /** The request itself is malformed; nothing was sent to the model. */
  | "invalid-request"
  /** The model answered without calling the tool it was asked to call. */
  | "no-tool-call"
  /** Safety classifiers declined the request. */
  | "refused"
  /** The response was cut off, so the tool input may be a prefix of itself. */
  | "truncated"
  /** A stop reason the writer has no rule for. Fail closed, do not read on. */
  | "unexpected-stop"
  /** The tool input did not match the tool's own schema. */
  | "invalid-tool-input"
  /** Two grants for one action: merging them would widen one of the two. */
  | "duplicate-action"
  /** An operation that is not in the catalog, which is the only vocabulary. */
  | "unknown-action"
  /** A grant the mandate schema refuses, e.g. a facet the operation lacks. */
  | "invalid-grant"
  /** The assembled mandate does not satisfy the contract. */
  | "invalid-mandate";

export class WriterError extends Error {
  readonly code: WriterErrorCode;

  constructor(code: WriterErrorCode, message: string) {
    super(message);
    this.name = "WriterError";
    this.code = code;
  }
}
