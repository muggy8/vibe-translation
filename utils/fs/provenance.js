/**
 * utils/fs/provenance.js — what a published file was copied from, and what a set of files currently is.
 *
 * A sidecar that records where a series-root copy came from, and a fingerprint that lets a
 * later run prove the artifacts are still the ones a report signed off. Both are content
 * checks, not timestamp checks: a restored file with an old mtime must never pass as fresh.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

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

/**
 * A cheap content fingerprint for a set of files, so a caller can ask afterwards
 * whether anything actually changed.
 *
 * Why this exists: a QA loop's feedback pass is only worth its cost if it moves
 * the artifact. Observed live on the 17-volume series — the character-voice
 * feedback pass on volume 01 made 46 tool calls (29 reads, 15 searches, ZERO
 * writes), spent 2.63M tokens, and left `character-voice.md` and `pov-map.md`
 * byte-identical to what the compile pass had written. Both files existed and
 * were real, so `assertWroteWithFallback` reported no gap, no recovery turn ran,
 * `assertRealOutput` passed, and the loop cheerfully started another iteration
 * that re-audited the unchanged document for another 8.4M tokens. Every existing
 * check asks "is the file there?"; none asks "did this pass do anything?".
 *
 * Content hashes, not mtimes: an agent that rewrites a file with identical text
 * is exactly the no-op this detects, and a tool that touched mtime without
 * touching content would hide it.
 *
 * Fail-soft: an unreadable file fingerprints as `missing`, so a read error cannot
 * masquerade as "nothing changed".
 *
 * @param {string|string[]} filePaths - The file(s) to fingerprint.
 * @returns {Promise<string>} A stable string that differs whenever any listed
 *   file's content (or presence) differs.
 */
async function fingerprintFiles(filePaths) {
  const list = (Array.isArray(filePaths) ? filePaths : [filePaths]).filter(Boolean);
  const parts = [];
  for (const filePath of list) {
    try {
      const buf = await fs.promises.readFile(filePath);
      parts.push(`${filePath}:${buf.length}:${crypto.createHash("sha256").update(buf).digest("hex")}`);
    } catch (err) {
      parts.push(`${filePath}:missing:${err.code || err.message}`);
    }
  }
  return parts.join("|");
}

module.exports = { writeProvenanceSidecar, inlineReferenceMessage, fingerprintFiles };
