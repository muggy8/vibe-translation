/**
 * utils/reference-store/presence.js — who is actually in this volume's text.
 *
 * The character-voice coverage rule ("the reference covers fewer characters than the cast
 * holds") is only a real finding when the missing character was in the book. The reference
 * document cannot answer that — a reference that lost a character is exactly the file that
 * would deny it — so the answer comes from the only source that can give it: the volume's own
 * extracted chapter text, searched by code.
 *
 * Two rules decide this module's shape:
 *
 *   - **It is a measurement, not a claim.** Everything in `facts` needs a citation that
 *     verifies at a line, and an absence has no passage to cite. So presence lives in its own
 *     table, written by code from the source files, and no verb here takes a caller's word for
 *     anything. A model cannot assert that a character was absent, and that is the point: the
 *     account owner's rule is that a character with no lines in a volume is left alone, and the
 *     thing that decides "left alone" has to be something the volume itself says.
 *   - **A name counts when the book writes it the way the book writes it.** The search is the
 *     store's one matching rule — verbatim, then the Han-character skeleton with its
 *     minimum-length guard — because 如月雨露 is printed 如月きさらぎ雨あま露つゆ, and a check
 *     that only matches bare kanji would report half the cast as absent and quietly switch
 *     itself off.
 *
 * @module utils/reference-store/presence
 */

const { readChapterLines } = require("./source-chapters");
const { matchQuoteOnLine } = require("./evidence");
const { refusal } = require("./refusals");
require("../../types"); // JSDoc type definitions

/**
 * Measure which cast entries this volume's own text contains, and store the answer.
 *
 * Replace, not merge: the measurement belongs to the source files, and a re-run after the
 * source changes has to overwrite the old answer instead of layering on top of it.
 *
 * @param {{db: Object, volumeDir: string, volume: number}} ctx
 * @param {{volume?: number}} [opts] - Defaults to the volume this store is open for.
 * @returns {{ok: boolean, volume: number, measured: number, present: number, absent: number, chapters: number, refusal: ReferenceRefusal|null}}
 */
function recordCastPresence(ctx, { volume } = {}) {
  const vol = Number(volume === undefined ? ctx.volume : volume);
  const listed = ctx.listChapters();
  if (listed.chapters.length === 0) {
    return {
      ok: false,
      volume: vol,
      measured: 0,
      present: 0,
      absent: 0,
      chapters: 0,
      refusal: refusal({
        verb: "record_cast_presence",
        rule: "presence-source-missing",
        because:
          `volume ${vol} has no extracted source to search (${listed.error}). Presence is measured ` +
          "from the book's own text, so without it the coverage question has no honest answer.",
        fix: "extract the volume's chapters first (the same source the evidence rule reads).",
      }),
    };
  }

  // Each chapter file is read once and searched for every name, which is the same cost the
  // evidence discovery already pays.
  const chapters = [];
  for (const chapter of listed.chapters) {
    if (!chapter.file) continue;
    const lines = readChapterLines(ctx.volumeDir, chapter.file);
    if (!lines) continue;
    chapters.push({ id: chapter.id, lines });
  }

  const castRows = ctx.db
    .prepare("SELECT key, display, aliases FROM cast WHERE merged_into IS NULL ORDER BY key")
    .all();

  const insert = ctx.db.prepare(
    "INSERT INTO cast_presence (volume, key, present, matched, chapter, line) VALUES (?,?,?,?,?,?) " +
      "ON CONFLICT(volume, key) DO UPDATE SET present = excluded.present, matched = excluded.matched, " +
      "chapter = excluded.chapter, line = excluded.line"
  );

  let present = 0;
  ctx.db.exec("BEGIN");
  try {
    for (const entry of castRows) {
      const found = findName(entry, chapters);
      insert.run(vol, entry.key, found ? 1 : 0, found ? found.matched : null, found ? found.chapter : null, found ? found.line : null);
      if (found) present += 1;
    }
    ctx.db.exec("COMMIT");
  } catch (err) {
    ctx.db.exec("ROLLBACK");
    throw err;
  }

  return {
    ok: true,
    volume: vol,
    measured: castRows.length,
    present,
    absent: castRows.length - present,
    chapters: chapters.length,
    refusal: null,
  };
}

/**
 * Where one cast entry's name first occurs in this volume's chapters.
 *
 * The key and the recorded aliases are the names tried; a display like
 * `如月雨露（ジョーロ）【俺人格】` is not a string the book prints, so it is only tried when it
 * is the key itself.
 *
 * @param {{key: string, display: string|null, aliases: string}} entry
 * @param {Array<{id: string, lines: string[]}>} chapters
 * @returns {{name: string, chapter: string, line: number, matched: string}|null}
 */
function findName(entry, chapters) {
  const names = [entry.key];
  try {
    for (const alias of JSON.parse(entry.aliases || "[]")) {
      if (typeof alias === "string" && alias.trim()) names.push(alias.trim());
    }
  } catch {
    /* an unparsable aliases column costs this entry its aliases, not the measurement */
  }
  if (entry.display && entry.display === entry.key) names.push(entry.display);

  for (const name of names) {
    for (const chapter of chapters) {
      for (let i = 0; i < chapter.lines.length; i += 1) {
        const matched = matchQuoteOnLine(chapter.lines[i], name);
        if (!matched) continue;
        return { name, chapter: chapter.id, line: i + 1, matched };
      }
    }
  }
  return null;
}

/**
 * The measured presence for one volume.
 *
 * @param {{db: Object}} ctx
 * @param {number} volume
 * @returns {Array<{volume: number, key: string, present: number, matched: string|null, chapter: string|null, line: number|null}>}
 */
function castPresence(ctx, volume) {
  return ctx.db
    .prepare("SELECT volume, key, present, matched, chapter, line FROM cast_presence WHERE volume = ? ORDER BY key")
    .all(Number(volume));
}

/**
 * Whether presence has been measured for a volume at all.
 *
 * The coverage query needs this: an unmeasured volume must never be treated as a volume where
 * nobody appears, because that is the shape of the check silently switching itself off.
 *
 * @param {{db: Object}} ctx
 * @param {number} volume
 * @returns {boolean}
 */
function presenceMeasured(ctx, volume) {
  return ctx.db.prepare("SELECT COUNT(*) AS n FROM cast_presence WHERE volume = ?").get(Number(volume)).n > 0;
}

module.exports = {
  recordCastPresence,
  castPresence,
  presenceMeasured,
};
