/**
 * The objective half of 'is this a real narrative?'.
 *
 * The intake agent's own judgment (each volume's integrity block) is necessary but not
 * sufficient — a model can be wrong about what it read. So each staged file is also
 * checked without guessing about what a story is: an archive with no readable text
 * section, a file under the readable-text floor (binary junk / an empty archive / a
 * stub), a text file that is mostly undecodable bytes (a binary file renamed), and an
 * archive whose image payload dwarfs its prose (an art book).
 *
 * The prose is counted ACROSS THE BOOK and the two payloads are compared in BYTES: a
 * real light novel IS mostly image bytes (a 9.6 MB book holding 575 KB of XHTML), so
 * 'the file is much bigger than its text' is true of every illustrated book and
 * identifies nothing. Measured live: all 17 volumes of a real series were rejected as
 * art books because the first sections of a novel are the cover, the colophon and the
 * table of contents (gotcha 51).
 *
 * Part of the get-translation-target.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("../types"); // JSDoc type definitions
const { sha256OfFile, openEpub, isEpubPath, htmlToPlainText } = require("../utils/source");

const { artbookMaxTextChars, minVolumeTextChars } = require("./config");

/**
 * Validate one volume's "is this actually a book?" judgment.
 *
 * The intake used to report only which files looked like volumes and in what
 * order. Nothing asked whether the text it read was a real narrative — so an
 * art book, a preview sample, or a corrupted archive that happened to open
 * could be listed as volume 03, and the pipeline would build a glossary, a
 * wiki and a translation for it.
 *
 * The judgment is the agent's: "does this read like a story?" is not a question
 * a character-count threshold answers honestly. What the code enforces is that
 * the judgment EXISTS, is stated per volume, and says what it was based on — a
 * gate the model can pass by saying nothing is not a gate (the same rule as the
 * confidence gate).
 *
 * @param {unknown} integrity - The agent's `integrity` block for this volume.
 * @param {string} where - Position label for the error message.
 * @returns {{isNarrative: boolean, confidence: number, basis: string}} The normalized block.
 */
function validateVolumeIntegrity(integrity, where) {
  if (!integrity || typeof integrity !== "object" || Array.isArray(integrity)) {
    throw new Error(
      `${where} is missing an "integrity" block. For every volume you accept, report ` +
        `{"integrity": {"isNarrative": true, "confidence": 0.9, "basis": "what you read and why it ` +
        `reads like a story"}}. A file you are not sure is a real narrative belongs in ` +
        `discovery.excluded with a reason, not in volumes.`
    );
  }
  if (typeof integrity.isNarrative !== "boolean") {
    throw new Error(
      `${where} integrity.isNarrative must be true or false: you must say whether the text you ` +
        `read is a real narrative (a story, or a legitimate short story), not leave it blank.`
    );
  }
  if (!Number.isFinite(integrity.confidence) || integrity.confidence < 0 || integrity.confidence > 1) {
    throw new Error(
      `${where} integrity.confidence must be a number from 0 to 1 — how sure you are that this ` +
        `is a real narrative.`
    );
  }
  if (typeof integrity.basis !== "string" || integrity.basis.trim().length < 20) {
    throw new Error(
      `${where} integrity.basis must say WHAT you read and WHAT made it look like a narrative ` +
        `(at least 20 characters — e.g. "opening 1500 chars are continuous prose with chapter ` +
        `structure; 41 text sections, 2 images").`
    );
  }
  return {
    isNarrative: integrity.isNarrative,
    confidence: integrity.confidence,
    basis: integrity.basis.trim(),
  };
}


/**
 * The objective half of "is this a book?" — the checks that need no guessing
 * about what a story is.
 *
 * Runs against the STAGED file, after the agent's own judgment has been
 * recorded, and can override the agent when the file is objectively not a book:
 *
 *   - an archive with no readable text section is not a book;
 *   - a file that yields essentially no text is binary junk or a stub;
 *   - a text file that is mostly undecodable bytes is a binary file renamed;
 *   - an archive whose images dwarf a thin prose count is an art book, whatever
 *     the agent called it.
 *
 * @param {string} seriesDir - The series location.
 * @param {TranslationTargetVolume} volume - The volume (sourceFile resolved against seriesDir).
 * @returns {Promise<{ok: boolean, problem?: string, stats: {textChars: number, imageBytes: number, sections: number}}>}
 *   `ok` false = a hard structural problem; `problem` explains it.
 */
async function checkVolumeSourceShape(seriesDir, volume) {
  const sourcePath = path.resolve(seriesDir, volume.sourceFile);
  const stats = { textChars: 0, imageBytes: 0, sections: 0 };

  if (isEpubPath(sourcePath)) {
    let book = null;
    try {
      book = await openEpub(sourcePath);
    } catch (err) {
      return { ok: false, stats, problem: `"${volume.sourceFile}" will not open as an archive: ${err.message}` };
    }
    const sections = book.textItems || [];
    stats.sections = sections.length;
    if (sections.length === 0) {
      return {
        ok: false,
        stats,
        problem: `"${volume.sourceFile}" has no readable text sections at all — an archive with nothing to read is not a volume.`,
      };
    }
    // Count the prose ACROSS THE BOOK, stopping as soon as it is obvious the book
    // is a book. Sampling the first N sections is not a measurement: for a real
    // novel those sections are the cover, the colophon, the caution page and the
    // table of contents (observed live: a 151,245-character book sampled to
    // 8,419, and all 17 volumes of a real series were rejected as art books).
    const ceiling = artbookMaxTextChars();
    let textChars = 0;
    for (const section of sections) {
      try {
        const html = await book.zip.file(section.zipPath).async("string");
        textChars += htmlToPlainText(html).length;
      } catch {
        /* an unreadable section just contributes nothing; the floors below catch it */
      }
      if (textChars > ceiling) break; // both checks below are already satisfied
    }
    stats.textChars = textChars;
    const floor = minVolumeTextChars();
    if (textChars < floor) {
      return {
        ok: false,
        stats,
        problem:
          `"${volume.sourceFile}" yields only ${textChars} characters of text across ` +
          `${sections.length} section(s) — under the ${floor}-character floor for ` +
          `"this file contains a readable text at all".`,
      };
    }
    // Art-book signal: BYTES compared against BYTES, and only when the prose is
    // thin enough for the archive's composition to outweigh the agent's judgment.
    // "the file is far bigger than its text" identifies nothing — a real light
    // novel IS mostly image bytes (observed: a 9.6 MB book holding 575 KB of
    // XHTML and 9.2 MB of illustration plates), so that rule called every
    // illustrated book an art book. The sizes come from the zip's central
    // directory, so no image is ever decompressed.
    const payload = book.payload || { textBytes: 0, otherBytes: 0 };
    stats.imageBytes = payload.otherBytes;
    const MIN_ARTBOOK_IMAGE_BYTES = 5 * 1024 * 1024; // below this the archive holds no real image payload
    const ARTBOOK_IMAGE_RATIO = 20; // images at least this many times the text pages
    if (
      payload.textBytes > 0 &&
      payload.otherBytes >= MIN_ARTBOOK_IMAGE_BYTES &&
      payload.otherBytes >= ARTBOOK_IMAGE_RATIO * payload.textBytes &&
      textChars <= ceiling
    ) {
      return {
        ok: false,
        stats,
        problem:
          `"${volume.sourceFile}" carries ${(payload.otherBytes / 1024 / 1024).toFixed(1)} MB of images ` +
          `against ${(payload.textBytes / 1024).toFixed(0)} KB of text pages, and only ${textChars} ` +
          `characters of prose — an image-dominated archive with no book's worth of text in it, i.e. ` +
          `an art book, whatever the intake agent reported. Exclude it, or raise ` +
          `DISCOVER_ARTBOOK_MAX_TEXT_CHARS (now ${ceiling}) if this book really is that thin.`,
      };
    }
    return { ok: true, stats };
  }

  // Plain text / Markdown source.
  let raw = "";
  try {
    raw = await fs.readFile(sourcePath, "utf8");
  } catch (err) {
    return { ok: false, stats, problem: `"${volume.sourceFile}" could not be read: ${err.message}` };
  }
  const text = raw.trim();
  stats.textChars = text.length;
  stats.sections = 1;
  if (!text) {
    return { ok: false, stats, problem: `"${volume.sourceFile}" is empty.` };
  }
  const floor = minVolumeTextChars();
  if (text.length < floor) {
    return {
      ok: false,
      stats,
      problem:
        `"${volume.sourceFile}" holds only ${text.length} characters — under the ` +
        `${floor}-character floor for "this file contains a readable text at all".`,
    };
  }
  // A binary file renamed to .txt/.md shows up as replacement characters.
  const junkRatio = (text.match(/\uFFFD/g) || []).length / text.length;
  if (junkRatio > 0.02) {
    return {
      ok: false,
      stats,
      problem:
        `"${volume.sourceFile}" is ${(junkRatio * 100).toFixed(1)}% undecodable bytes — it looks ` +
        `like a binary file, not a text source.`,
    };
  }
  return { ok: true, stats };
}


/**
 * Gate every listed volume on both halves of the integrity story: the agent's
 * stated judgment, and the objective shape of the staged file.
 *
 * @param {string} seriesDir - The series location.
 * @param {TranslationTargetManifest} manifest - The validated manifest.
 * @returns {Promise<string[]>} The problems (empty when the plan passes). A
 *   non-empty list fails the intake attempt so the agent gets a correction turn.
 */
async function volumeIntegrityProblems(seriesDir, manifest) {
  const problems = [];
  for (const vol of manifest.volumes || []) {
    if (!vol.integrity.isNarrative) {
      problems.push(
        `volumes[] "${vol.folder}": the intake agent itself reported this is NOT a narrative ` +
          `("${vol.integrity.basis}"). A volume you do not believe is a story must be listed in ` +
          `discovery.excluded with that reason, not in volumes.`
      );
      continue;
    }
    if (vol.integrity.confidence < 0.5) {
      problems.push(
        `volumes[] "${vol.folder}": the agent's own narrative confidence is ${vol.integrity.confidence} ` +
        `(below 0.5). Read more of it and decide, or exclude it with a reason.`
      );
      continue;
    }
    const shape = await checkVolumeSourceShape(seriesDir, vol);
    if (!shape.ok) problems.push(`volumes[] "${vol.folder}": ${shape.problem}`);
  }
  return problems;
}

// ─── Manifest validation ────────────────────────────────────────────────────


module.exports = {
  validateVolumeIntegrity,
  checkVolumeSourceShape,
  volumeIntegrityProblems,
};
