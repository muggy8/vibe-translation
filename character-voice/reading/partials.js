/**
 * character-voice/reading/partials.js — the one job: keep one chapter's answer on disk beside the volume,
 * and answer honestly whether the copy already there may be reused **and whether it is a whole answer**.
 *
 * Resume is only safe when the partial belongs to the text that is there now, so a chapter is fingerprinted
 * by content rather than by mtime. Completeness is the other half, and it is the half gotcha 122 is about:
 * a partial whose answer never reached its closing bracket is a usable record of a failed read, not an answer
 * to build a volume from. `readPartial` says both, with the reason attached; `writePartial` writes through a
 * temporary name so a pass that dies mid-write cannot leave a half-written partial the next pass would read
 * as an answer.
 *
 * Part of the character-voice/reading.js layer.
 *
 * @module character-voice/reading/partials
 */

const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const crypto = require("crypto");
require("../../types"); // JSDoc type definitions

/** One chapter's answer, kept beside the volume so an interrupted pass does not pay for it twice. */
const PARTIAL_PREFIX = "character-voice-extract-";

/**
 * The partial's format version.
 *
 * Version 2 added `attempts` — one entry per paid read of the chapter, each with the reasoning level
 * it ran at and whether its answer closed. A version-1 partial cannot say whether its answer was
 * complete, and "we do not know" is answered here by re-reading rather than by trusting.
 */
const PARTIAL_SCHEMA = 2;

/**
 * The partial file one chapter's answer belongs in.
 *
 * @param {string} volumeDir
 * @param {string} segmentId
 * @returns {string}
 */
function partialPath(volumeDir, segmentId) {
  return path.join(volumeDir, `${PARTIAL_PREFIX}${segmentId}.json`);
}

/**
 * A fingerprint of the chapter text a partial was produced from.
 *
 * Resume is only safe if the partial belongs to the text that is there now. Content, not mtime:
 * a re-extracted chapter whose text is identical is the same chapter, and a chapter whose text
 * changed must not keep an answer that describes the old one.
 *
 * @param {string} file - Absolute path to the chapter file.
 * @returns {string} `missing` when it cannot be read — fail loud, not "unchanged".
 */
function segmentFingerprint(file) {
  try {
    return crypto.createHash("sha256").update(fsSync.readFileSync(file)).digest("hex");
  } catch {
    return "missing";
  }
}

/**
 * Read one chapter's partial, and say both whether it may be reused **and whether it is complete**.
 *
 * `complete` is the new half: a partial whose answer never closed its array is a usable record of a
 * failed read, not an answer to build a volume from. Whether it may still be reused turns on how many
 * paid attempts it already carries — see `MAX_ATTEMPTS_PER_CHAPTER`.
 *
 * @param {string} volumeDir
 * @param {{id: string, file: string}} segment
 * @param {string} fingerprint - The current chapter text's fingerprint.
 * @returns {{usable: boolean, complete: boolean, attempts: number, entries?: Array<Object>, attemptsLog?: Array<Object>, file: string, because: string}}
 */
function readPartial(volumeDir, segment, fingerprint) {
  const file = partialPath(volumeDir, segment.id);
  if (!fsSync.existsSync(file)) return { usable: false, complete: false, attempts: 0, file, because: "no partial for this chapter yet" };

  let parsed;
  try {
    parsed = JSON.parse(fsSync.readFileSync(file, "utf8"));
  } catch (err) {
    return { usable: false, complete: false, attempts: 0, file, because: `the partial is not readable JSON: ${err.message}` };
  }
  if (!parsed || parsed.schema !== PARTIAL_SCHEMA) {
    return {
      usable: false,
      complete: false,
      attempts: 0,
      file,
      because: `the partial is not schema ${PARTIAL_SCHEMA}${parsed && parsed.schema ? ` (it is schema ${parsed.schema})` : ""} — it cannot say whether its answer was complete, so the chapter is read again`,
    };
  }
  if (parsed.segmentId !== segment.id) {
    return { usable: false, complete: false, attempts: 0, file, because: `the partial names chapter "${parsed.segmentId}", not "${segment.id}"` };
  }
  if (!Array.isArray(parsed.entries)) {
    return { usable: false, complete: false, attempts: 0, file, because: "the partial holds no entry array" };
  }
  if (parsed.sourceSha !== fingerprint) {
    return {
      usable: false,
      complete: false,
      attempts: 0,
      file,
      because: `this chapter's text has changed since the partial was written (${String(parsed.sourceSha).slice(0, 12)}… → ${fingerprint.slice(0, 12)}…)`,
    };
  }
  const attemptsLog = Array.isArray(parsed.attempts) ? parsed.attempts : [];
  const attempts = attemptsLog.length || 1;
  const complete = parsed.cutOff !== true;
  return {
    usable: true,
    complete,
    attempts,
    entries: parsed.entries,
    attemptsLog,
    file,
    because: complete
      ? "reused: the same chapter text, already read, and the answer closed"
      : `the answer on disk was cut off before its closing bracket (${attempts} paid read(s) already recorded)`,
  };
}

/**
 * Write one chapter's answer. Written to a temporary name and renamed, so a pass that dies mid-write
 * cannot leave a half-written partial that the next pass would read as an answer.
 *
 * @param {string} volumeDir
 * @param {{id: string, file: string}} segment
 * @param {string} fingerprint
 * @param {Array<Object>} entries
 * @param {string|number} installmentNumber
 * @param {{attempts?: Array<Object>, cutOff?: boolean, parseError?: string|null, lost?: Array<Object>, rawAnswer?: string}} [extra]
 *   What the paid reads were — each with its reasoning level, its claim count and whether its answer
 *   closed — plus what the strict parse said, which claims were dropped, and the answer itself, so a
 *   later pass can re-read it without paying for the chapter again.
 * @returns {Promise<string>} The partial's path.
 */
async function writePartial(volumeDir, segment, fingerprint, entries, installmentNumber, extra = {}) {
  const file = partialPath(volumeDir, segment.id);
  const body = JSON.stringify(
    {
      schema: PARTIAL_SCHEMA,
      volume: String(installmentNumber),
      segmentId: segment.id,
      segmentFile: segment.file,
      sourceSha: fingerprint,
      extractedAt: new Date().toISOString(),
      entries,
      cutOff: Boolean(extra.cutOff),
      attempts: extra.attempts || [],
      ...(extra.parseError
        ? { parseError: extra.parseError, lostClaims: extra.lost || [], rawAnswer: extra.rawAnswer || "" }
        : {}),
    },
    null,
    2
  );
  const temp = `${file}.writing`;
  await fs.writeFile(temp, body + "\n", "utf8");
  await fs.rename(temp, file);
  return file;
}

module.exports = {
  PARTIAL_PREFIX,
  PARTIAL_SCHEMA,
  partialPath,
  segmentFingerprint,
  readPartial,
  writePartial,
};
