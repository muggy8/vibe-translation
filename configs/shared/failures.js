/**
 * configs/shared/failures.js — how a failure is classified, and why that decides everything.
 *
 * The run policies (ON_VOLUME_ERROR=skip, ON_TASK_ERROR=continue) exist so an
 * un-monitored run survives a flaky model call. They must not paper over a
 * broken book. This file is the only place that draws the line, and every
 * skip site on the other side of it asks here first.
 */

/**
 * Build a STRUCTURAL error: the pipeline's inputs or outputs are broken, as
 * opposed to a model that had a bad run.
 *
 * The distinction decides whether a failure may be skipped. `ON_VOLUME_ERROR=skip`
 * and `ON_TASK_ERROR=continue` exist so an un-monitored overnight run survives a
 * flaky model call — but they must NOT paper over a source file that has gone
 * missing, an archive that will not open, or a volume published with chapters
 * missing from the middle. Those are not transient: re-running cannot fix them,
 * and continuing means a whole series of artifacts built on a broken book.
 *
 * Mark one with `structuralError(...)` at the point that knows the difference;
 * every volume-skip site honours it.
 *
 * @param {string} message - The error message.
 * @param {Error} [cause] - The underlying error, if any.
 * @returns {Error} The marked error.
 */
function structuralError(message, cause) {
  const err = new Error(message);
  err.structural = true;
  if (cause) err.cause = cause;
  return err;
}

/**
 * Whether an error is structural (see {@link structuralError}) — the check that
 * overrides ON_VOLUME_ERROR=skip / ON_TASK_ERROR=continue.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isStructuralError(err) {
  return !!(err && typeof err === "object" && err.structural === true);
}

/**
 * Build the error that means "this did not fit in a single pass" — the mirror of
 * {@link structuralError}, and the only failure the pipeline may recover from by
 * switching to the chapter-by-chapter path.
 *
 * Why the class exists: a whole-installment pass is the cheap, cache-friendly
 * path, and the pipeline now prefers it whenever the size check says it fits.
 * When it turns out not to fit, retrying the same volume chapter by chapter is a
 * genuine fix rather than a retry of the same mistake. But "on any error, try
 * chunked" would be a trap: a hang, a malformed tool call, a dead container or a
 * missing previous artifact are not size problems, and chunking them costs the
 * whole volume again to fix something chunking cannot fix. So only the three
 * signatures that are actually about size get this tag:
 *
 *   - the server rejecting the request because prompt + output cap exceed the
 *     context (it refuses before generating anything — see gotcha 36);
 *   - an agent turn that hit the output cap while writing a file
 *     (finish_reason=length on a writeFile/editFile step);
 *   - a tool-less call that hit the output cap.
 *
 * A bad ACCEPTANCE score is deliberately NOT this error. That is the QA loop's
 * problem, it is stochastic, and auto-switching processing mode on it would make
 * which mode ran — and therefore what the artifacts look like — irreproducible
 * between runs.
 *
 * @param {string} message - The error message.
 * @param {Error} [cause] - The underlying error, if any.
 * @returns {Error} The marked error.
 */
function tooBigForOnePassError(message, cause) {
  const err = new Error(message);
  err.tooBigForOnePass = true;
  if (cause) err.cause = cause;
  return err;
}

/**
 * Whether an error means "did not fit in one pass" (see
 * {@link tooBigForOnePassError}) — the only condition a whole→chunked fallback
 * acts on.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isTooBigForOnePassError(err) {
  return !!(err && typeof err === "object" && err.tooBigForOnePass === true);
}

/**
 * Build the error that means "the endpoint refused to answer in the shape it was
 * asked for".
 *
 * This is a different failure from a bad grade and a different failure from a size
 * refusal, and telling them apart is the whole point:
 *   - a bad grade means the artifact has a problem, and the QA loop's answer is a rewrite;
 *   - a size refusal means the request was too big, and the answer is to split it;
 *   - a refused SHAPE means the request itself was well-formed and the server could not
 *     produce an answer that fits it. Rewriting the artifact fixes nothing, splitting the
 *     request fixes nothing, and re-asking the same question is usually what fails again.
 *
 * A structured-output failure is therefore never a `tooBigForOnePass` error (it must not
 * send a volume down the chapter-by-chapter path) and never a silent empty answer (which
 * is what it used to become: "The model returned no content").
 *
 * @param {string} message - The error message.
 * @param {Error} [cause] - The underlying error, if any.
 * @returns {Error} The marked error.
 */
function structuredOutputError(message, cause) {
  const err = new Error(message);
  err.structuredOutput = true;
  if (cause) err.cause = cause;
  return err;
}

/**
 * Whether an error means "the endpoint could not answer in the requested shape"
 * (see {@link structuredOutputError}).
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isStructuredOutputError(err) {
  return !!(err && typeof err === "object" && err.structuredOutput === true);
}

/**
 * Whether a piece of server text is this failure class.
 *
 * One list of patterns, used by the transport layer (to decide when a refusal must not be
 * quietly re-asked) and by the error tagger (to decide what class to report). Keeping them in
 * two places is how the two drift apart and one of them stops firing.
 *
 * Narrow on purpose, in the same shape as the size signatures in ai/endpoint.js: a false match
 * here would relabel an ordinary server error as a shape problem and stop the client from
 * retrying a call that a retry would have fixed.
 *
 * @param {string} text - Server wording: an error message, a body, or an SSE error frame.
 * @returns {boolean}
 */
function isStructuredOutputMessage(text) {
  const message = String(text || "");
  return (
    /structured_output_failed/i.test(message) ||
    /\bstructured output\b/i.test(message) ||
    /response_format/i.test(message) && /\b(invalid|unsupport|fail|error|refus)/i.test(message) ||
    /json ?schema/i.test(message) && /\b(invalid|violat|does not match|failed)/i.test(message)
  );
}

/**
 * Build the error a task must throw when one or more of its volumes failed.
 *
 * Every per-volume loop is wrapped in a try/catch so an un-monitored run can keep
 * going (`ON_VOLUME_ERROR=skip`) — but "keep going" must not mean "report success".
 * A task that skipped or failed volumes has to fail the run, exactly like the
 * translation-stage tasks already do; otherwise a whole series of artifacts is
 * silently missing and the exit code says everything worked. (Observed: the four
 * pre-production tasks printed the failure summary and exited 0.)
 *
 * Returns `null` when there is nothing to fail on, so callers can do their
 * end-of-run publishing first and throw last.
 *
 * @param {string} taskName - The task name, for the message.
 * @param {Array<{folder?: string, installmentNumber?: string, error?: Error}>} failedVolumes - The recorded failures.
 * @param {number} totalVolumes - How many volumes the task attempted.
 * @returns {Error|null} The error to throw, or null when every volume succeeded.
 */
function volumeFailureError(taskName, failedVolumes, totalVolumes) {
  if (!Array.isArray(failedVolumes) || failedVolumes.length === 0) return null;
  const names = failedVolumes
    .map((v) => {
      // A bare name or installment number is as much a volume as an entry object: the four
      // translation-stage tasks have always collected numbers here, and a summary that answered
      // "unknown (failed)" for all of them named no volume at all.
      if (typeof v === "string" || typeof v === "number") return `${v} (volume failed)`;
      const label = v && (v.installmentNumber || v.folder) ? (v.installmentNumber || v.folder) : "unknown";
      const reason = v && v.error && v.error.message ? v.error.message : "failed";
      return `${label} (${reason})`;
    })
    .join("; ");
  return new Error(
    `${taskName}: ${failedVolumes.length} of ${totalVolumes} volume(s) failed: ${names}. ` +
      `Re-run the task (idempotent) to pick them up.`
  );
}

module.exports = {
  structuralError,
  isStructuralError,
  tooBigForOnePassError,
  isTooBigForOnePassError,
  structuredOutputError,
  isStructuredOutputError,
  isStructuredOutputMessage,
  volumeFailureError,
};
