/**
 * utils/fs.js — Filesystem utility functions shared across the ai-client
 * modules.
 *
 * @example
 * const { fileExists, assertWrote } = require("../utils/fs");
 */

const fs = require("fs");
const path = require("path");

// ─── Filesystem helpers ───────────────────────────────────────────────────────

/**
 * Check whether a file exists.
 *
 * @param {string} filePath - The path to check.
 * @returns {Promise<boolean>} True if the file exists, false otherwise.
 */
async function fileExists(filePath) {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fail loudly if an agent-mode stage left its output file(s) missing, empty,
 * or still holding a scaffold stub (see {@link isPlaceholderContent}).
 *
 * @param {string | string[]} filePaths - Expected output file path or array of paths.
 * @param {string} who - Who was supposed to write it (for the error message).
 * @returns {Promise<void>}
 */
async function assertWrote(filePaths, who) {
  const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
  for (const filePath of paths) {
    const content = await fs.promises.readFile(filePath, "utf-8").catch(() => null);
    if (isPlaceholderContent(content)) {
      throw new Error(
        `${who} did not produce ${filePath}` +
          (content !== null ? " (the file is empty or still holds its scaffold stub)" : ".") +
          ` Check the run log in .logs/ for the agent transcript.`
      );
    }
  }
}

/**
 * The scaffold stubs the workflows pre-write as a name anchor for the agent
 * ("a stronger anchor than 'create a new file'"). Every one of them starts
 * with this marker, so a stub that survived into the final output is
 * detectable without reading each workflow's scaffolding code.
 *
 * @type {string}
 */
const STUB_MARKER = "(stub —";

/**
 * Decide whether file content counts as "the agent did not actually write this".
 *
 * Three shapes qualify: the file is absent (null), it is empty or whitespace,
 * or it still holds a scaffold stub. The stub case is the dangerous one — a
 * crashed run leaves a file that EXISTS, so every "does the output exist?" check
 * (including the idempotency skip checks) would treat scaffolding as finished
 * work.
 *
 * @param {string|null|undefined} content - The file content, or null when the file is absent.
 * @returns {boolean} True when the content must NOT be treated as real output.
 */
function isPlaceholderContent(content) {
  if (content === null || content === undefined) return true;
  const text = String(content).trim();
  if (text === "") return true;
  return text.startsWith(STUB_MARKER);
}

/**
 * Fail loudly if an agent-mode stage left its output file(s) missing, empty or
 * stubbed — the hard stop callers run AFTER a recovery turn, so a stage can
 * never publish scaffolding as a finished artifact.
 *
 * @param {string | string[]} filePaths - Expected output file path or array of paths.
 * @param {string} who - Who was supposed to write it (for the error message).
 * @returns {Promise<void>}
 */
async function assertRealOutput(filePaths, who) {
  const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
  const bad = [];
  for (const filePath of paths) {
    const content = await fs.promises.readFile(filePath, "utf-8").catch(() => null);
    if (isPlaceholderContent(content)) bad.push(filePath);
  }
  if (bad.length > 0) {
    throw new Error(
      `${who} never wrote real output for: ${bad.join(", ")} ` +
        `(missing, empty, or still a scaffold stub). Check the agent transcript in .logs/.`
    );
  }
}

/**
 * Fail loudly if an agent-mode stage left its output file(s) missing, empty or
 * stubbed, or recover by writing provided chat-reply content to disk as a
 * fallback.
 *
 * This is a recovery wrapper for the author agent: when the model produces
 * the output in its chat reply instead of calling writeFile, the content is
 * still available in the agent handle's returned result and can be written
 * directly.
 *
 * The return value gates the CALLER's recovery turn: callers must only send
 * a recovery turn when this returns true (a file was actually missing).
 * Always returning true here made every stage run a redundant "recovery" turn
 * over an already-correct file — a second stochastic rewrite of the output
 * plus a false claim in the prompt that the model had replied in chat.
 *
 * A file that EXISTS but is empty or still holds its scaffold stub counts as
 * missing: the previous version only asked "does the path exist?", so an
 * interrupted run's 0-byte file (or an untouched wiki stub) was treated as
 * finished work and never recovered — and the next run skipped the volume
 * entirely.
 *
 * @param {string | string[]} filePaths - Expected output file path or array of paths.
 * @param {string} who - Who was supposed to write it (for the error message).
 * @param {string} [content] - Optional content to write if the file is missing.
 * @returns {Promise<boolean>} True if at least one file was missing (the
 *   fallback was used, or recovery is still needed because there was no
 *   content), false if every file already held real output.
 */
async function assertWroteWithFallback(filePaths, who, content) {
  const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
  let anyMissing = false;
  for (const filePath of paths) {
    const existing = await fs.promises.readFile(filePath, "utf-8").catch(() => null);
    if (!isPlaceholderContent(existing)) continue;

    anyMissing = true;
    if (content && content.trim().length > 0) {
      // Fallback: write the chat-reply content to disk (this also OVERWRITES a
      // stub, which a plain "does the file exist?" check would have left alone).
      await fs.promises.writeFile(filePath, content, "utf8");
      console.log(
        `[fallback] ${who} replied in chat instead of using writeFile; ` +
          `wrote ${filePath} from the chat reply (${content.length} chars)` +
          (existing !== null && existing.trim() !== "" ? " — replacing its scaffold stub" : "") +
          "."
      );
    } else {
      // No content to recover with — the caller will send a recovery turn
      // that re-sends the full task.
      console.warn(
        `[warning] ${who} produced no output${
          existing !== null ? ` (${filePath} is ${existing.trim() ? "still a scaffold stub" : "empty"})` : ""
        } — recovery turn will re-send the task.`
      );
    }
  }
  return anyMissing;
}

/**
 * Whether a file on disk holds real output (not absent, not empty, not a
 * scaffold stub).
 *
 * The idempotency skip checks all ask "does the output already exist?" — this
 * is the version of that question that cannot be answered by a stub left behind
 * by a crashed run.
 *
 * @param {string} filePath - The file to inspect.
 * @returns {Promise<boolean>} True when the file holds real, non-stub content.
 */
async function hasRealOutput(filePath) {
  const content = await fs.promises.readFile(filePath, "utf-8").catch(() => null);
  return !isPlaceholderContent(content);
}

/**
 * Write a provenance sidecar next to a series-root artifact copy.
 *
 * The root copies (glossary.md, character-voice.md, style-guide.md,
 * shared-wiki.md) are byte-identical copies of a per-volume snapshot, and
 * nothing in the file itself records which volume they came from — this
 * sidecar (`<copy>.provenance.json`) does: the source path, the volume, the
 * copy timestamp, and the content hash (so a later manual refresh of the
 * copy without re-running the task is detectable).
 *
 * Best-effort: a failure only warns — the copy itself is the deliverable.
 *
 * @param {string} targetFile - The root copy that was just written.
 * @param {string} sourceFile - The per-volume snapshot it was copied from.
 * @returns {Promise<void>}
 */
async function writeProvenanceSidecar(targetFile, sourceFile) {
  try {
    const crypto = require("crypto");
    const content = await fs.promises.readFile(targetFile);
    const sidecar = {
      file: path.basename(targetFile),
      copiedFrom: sourceFile,
      volume: path.basename(path.dirname(sourceFile)),
      copiedAt: new Date().toISOString(),
      sha256: crypto.createHash("sha256").update(content).digest("hex"),
    };
    await fs.promises.writeFile(
      `${targetFile}.provenance.json`,
      JSON.stringify(sidecar, null, 2) + "\n",
      "utf8"
    );
  } catch (err) {
    console.warn(
      `[provenance] could not write the sidecar for ${targetFile} (${err.message}) — continuing.`
    );
  }
}

/**
 * Read a cumulative reference artifact and prepare it as an INLINE prompt
 * message, optionally truncating it with the task's own truncator.
 *
 * A `{ file }` message is inlined whole by the harness — the model cannot page
 * through it the way it can page through a file it reads with readFile. So a
 * cumulative reference (the previous volume's glossary / voice reference /
 * style guide) handed to a one-shot extraction grows with the SERIES and
 * eventually crowds out the source text it is supposed to be checked against.
 * This is where the truncation helpers AGENTS.md describes get applied.
 *
 * The rendered shape matches the harness's own inline format exactly
 * (`File: <name>\nContent:\n\n<content>`), so the model sees the same thing it
 * would have seen with a `{ file }` message — just bounded.
 *
 * @param {string} filePath - The artifact to inline.
 * @param {string} name - The name the model is told the file has.
 * @param {{truncate?: (content: string) => string}} [opts] - The task's truncator (applied only to the inlined copy; the file on disk is never modified).
 * @returns {Promise<{text: string}>} A runOneShot message.
 */
async function inlineReferenceMessage(filePath, name, { truncate } = {}) {
  const raw = await fs.promises.readFile(filePath, "utf8");
  const content = typeof truncate === "function" ? truncate(raw) : raw;
  if (content.length !== raw.length) {
    console.log(
      `[context] inlining ${name} truncated: ${raw.length} → ${content.length} chars (the file on disk is unchanged).`
    );
  }
  return { text: `File: ${name}\nContent:\n\n${content}` };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

/**
 * Delete the files one processing attempt wrote, so a different attempt starts
 * from a clean folder.
 *
 * This exists because the whole-installment → chapter-by-chapter fallback swaps
 * the SHAPE of the work mid-volume, and the two modes leave different files
 * behind. A half-finished whole attempt leaves a partial (or scaffold-stub)
 * artifact, a research skeleton full of `- (pending)` lines, and a rolling-state
 * file recording scores for documents that no longer exist. The chunked path
 * would then read those as its starting point — and this codebase has been
 * burned by exactly that class of bug before (AGENTS.md gotcha 3: every stray
 * cleanup in the repo was added after a live failure; gotcha 50: "the file is
 * there" is never evidence the work was done).
 *
 * Deletes ONLY the names it is given. It never walks the folder and never
 * touches the source bundle: the extraction is keyed on the source fingerprint
 * and is valid regardless of which mode processes it.
 *
 * @param {string} volumeDir - The volume folder.
 * @param {string[]} fileNames - File names (relative to the folder) the attempt wrote.
 * @param {{glob?: RegExp}} [opts] - Optional pattern matched against file names, for a mode's per-chapter strays (e.g. /^wiki-.+\.md$/).
 * @returns {Promise<string[]>} The names actually removed.
 */
async function wipeAttemptOutputs(volumeDir, fileNames, { glob } = {}) {
  const removed = [];
  for (const name of fileNames || []) {
    const target = path.join(volumeDir, name);
    try {
      await fs.promises.rm(target);
      removed.push(name);
    } catch {
      // Not there — the attempt never got that far. Not an error.
    }
  }
  if (glob) {
    let entries = [];
    try {
      entries = await fs.promises.readdir(volumeDir);
    } catch {
      entries = [];
    }
    for (const name of entries) {
      if (!glob.test(name)) continue;
      try {
        await fs.promises.rm(path.join(volumeDir, name));
        removed.push(name);
      } catch {}
    }
  }
  return removed;
}

module.exports = {
  fileExists,
  assertWrote,
  assertWroteWithFallback,
  assertRealOutput,
  isPlaceholderContent,
  hasRealOutput,
  STUB_MARKER,
  inlineReferenceMessage,
  writeProvenanceSidecar,
  wipeAttemptOutputs,
};
