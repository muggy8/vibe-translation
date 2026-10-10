/**
 * utils/reference-store/presence.js — who is actually in this volume's text, and how much.
 *
 * The character-voice coverage rule ("the reference covers fewer characters than the cast
 * holds") is only a real finding when the missing character was in the book. The reference
 * document cannot answer that — a reference that lost a character is exactly the file that
 * would deny it — so the answer comes from the only source that can give it: the volume's own
 * extracted chapter text, searched by code.
 *
 * Three rules decide this module's shape:
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
 *     itself off. `evidence.js`'s prepared-line form is used so the rule is the same one the
 *     evidence check runs and the measurement is affordable over a whole volume.
 *   - **Every match is kept, not just the first one.** "Is this character barely in this
 *     volume, or are they the book?" is a question about *how many chapters*, and a measurement
 *     that stopped at the first hit could not tell a character named once from a character named
 *     in every chapter. `cast_presence` is the per-character answer; `cast_presence_match` is
 *     one row per place a name occurred, each stamped with the rule that proved it — which is
 *     what lets the audit say *how* it knows a character is in the volume.
 *
 * @module utils/reference-store/presence
 */

const { readChapterLines } = require("./source-chapters");
const { prepareLineForQuoteSearch, prepareQuoteForSearch, matchPreparedLine } = require("./evidence");
const { refusal } = require("./refusals");
require("../../types"); // JSDoc type definitions

/**
 * Measure which cast entries this volume's own text contains, and store the answer.
 *
 * Replace, not merge: the measurement belongs to the source files, and a re-run after the
 * source changes has to overwrite the old answer instead of layering on top of it. That includes
 * the per-match rows, which are deleted and rewritten along with the summary.
 *
 * @param {{db: Object, volumeDir: string, volume: number, listChapters: Function}} ctx
 * @param {{volume?: number}} [opts] - Defaults to the volume this store is open for.
 * @returns {{ok: boolean, volume: number, measured: number, present: number, absent: number, merged: number, chapters: number, matchRows: number, refusal: ReferenceRefusal|null}}
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
      matchRows: 0,
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

  // Each chapter file is read once and its lines prepared once, then searched for every name the
  // record holds. Preparing per line rather than per (line, name) pair is what keeps this a
  // measurement a stage can afford to run on every volume.
  const chapters = [];
  for (const chapter of listed.chapters) {
    if (!chapter.file) continue;
    const lines = readChapterLines(ctx.volumeDir, chapter.file);
    if (!lines) continue;
    chapters.push({ id: chapter.id, prepared: lines.map(prepareLineForQuoteSearch) });
  }

  // Every roster entry is measured, including the ones marked `merged_into`.
  //
  // A merge says two names are the same person; it does not say the second name stopped appearing in
  // the book. Volume 01's entry keyed 俺 occurs 789 times across all 10 chapters, and after that entry
  // is folded into 如月雨露 the honest answer is still "the string 俺 occurs in every chapter of this
  // volume" — recorded under 俺, where it belongs. Measuring only the unmerged entries would either
  // lose that fact or move it onto the protagonist's row, and moving it is the thing that makes the
  // chapter-count signal meaningless: a first-person pronoun matches every chapter of every book
  // narrated in the first person, so a measurement that attributes it to the protagonist reports him as
  // present everywhere on evidence that says nothing about him.
  const castRows = ctx.db.prepare("SELECT key, display, aliases, merged_into AS mergedInto FROM cast ORDER BY key").all();

  // Names that are themselves a merged roster entry are not search names for the entry they were merged
  // into. `castAlias` records a merged key as an alias so every reader can see the two are the same
  // person — that is the identity, and it is worth keeping. But identity and evidence are different
  // questions: 如月雨露 is searched for as 如月雨露 and as the aliases somebody declared with a reason
  // (ジョーロ, 俺（主人公）), and the pronoun that arrived through a merge is searched for under its own
  // row instead.
  const mergedKeys = new Set(castRows.filter((row) => row.mergedInto).map((row) => row.key));

  const insertSummary = ctx.db.prepare(
    "INSERT INTO cast_presence (volume, key, present, matched, chapter, line, chapters, matches) VALUES (?,?,?,?,?,?,?,?) " +
      "ON CONFLICT(volume, key) DO UPDATE SET present = excluded.present, matched = excluded.matched, " +
      "chapter = excluded.chapter, line = excluded.line, chapters = excluded.chapters, matches = excluded.matches"
  );
  const insertMatch = ctx.db.prepare(
    "INSERT INTO cast_presence_match (volume, key, chapter, line, name, matched) VALUES (?,?,?,?,?,?) " +
      "ON CONFLICT(volume, key, chapter, line, name) DO UPDATE SET matched = excluded.matched"
  );

  let present = 0;
  let matchRows = 0;
  ctx.db.exec("BEGIN");
  try {
    // Replace, not merge: the old answer for this volume is dropped before the new one is written,
    // so a name that stopped appearing does not stay "present" from the previous measurement.
    ctx.db.prepare("DELETE FROM cast_presence_match WHERE volume = ?").run(vol);
    ctx.db.prepare("DELETE FROM cast_presence WHERE volume = ?").run(vol);
    // How many chapter files this measurement actually read, recorded next to the answer it gives.
    // "Named in 3 of 10 chapters" is only meaningful with its denominator, and the denominator belongs
    // to the measurement rather than to whatever the `chapters` table happens to hold.
    ctx.db
      .prepare("INSERT INTO store_info (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(`presence_chapters_${vol}`, String(chapters.length));

    for (const entry of castRows) {
      const found = findName(entry, chapters, mergedKeys);
      if (found) {
        present += 1;
        matchRows += found.matches.length;
        insertSummary.run(
          vol,
          entry.key,
          1,
          found.first.matched,
          found.first.chapter,
          found.first.line,
          found.chapterIds.length,
          found.matches.length
        );
        for (const match of found.matches) {
          insertMatch.run(vol, entry.key, match.chapter, match.line, match.name, match.matched);
        }
      } else {
        insertSummary.run(vol, entry.key, 0, null, null, null, 0, 0);
      }
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
    merged: mergedKeys.size,
    chapters: chapters.length,
    matchRows,
    refusal: null,
  };
}

/**
 * The names one cast entry is searched for: its key and its recorded aliases.
 *
 * A display like `如月雨露（ジョーロ）【俺人格】` is not a string the book prints, so it is only
 * tried when it is the key itself.
 *
 * An alias that is itself a roster entry merged into this one is skipped: it is how the record says two
 * names are the same person, and it is measured in its own right, so counting it here would attribute
 * another name's occurrences to this character. See `recordCastPresence`.
 *
 * @param {{key: string, display: string|null, aliases: string}} entry
 * @param {Set<string>} [mergedKeys] - Cast keys that have been merged into another entry.
 * @returns {Array<{name: string, prepared: Object}>}
 */
function namesForEntry(entry, mergedKeys = new Set()) {
  const names = [entry.key];
  try {
    for (const alias of JSON.parse(entry.aliases || "[]")) {
      if (typeof alias !== "string" || !alias.trim()) continue;
      const name = alias.trim();
      if (mergedKeys.has(name)) continue;
      names.push(name);
    }
  } catch {
    /* an unparsable aliases column costs this entry its aliases, not the measurement */
  }
  if (entry.display && entry.display === entry.key) names.push(entry.display);
  return [...new Set(names)].map((name) => ({ name, prepared: prepareQuoteForSearch(name) }));
}

/**
 * Every place one cast entry's names occur in this volume's chapters.
 *
 * Name first, then chapter, then line — the order the measurement has always used, which is why
 * `first` is the same hit `cast_presence` recorded before this table recorded every hit.
 *
 * @param {{key: string, display: string|null, aliases: string}} entry
 * @param {Array<{id: string, prepared: Array<Object>}>} chapters
 * @param {Set<string>} [mergedKeys] - Cast keys merged into another entry; not searched for this one.
 * @returns {{first: {name: string, chapter: string, line: number, matched: string}|null, matches: Array<{name: string, chapter: string, line: number, matched: string}>, chapterIds: string[], rules: string[]}|null}
 */
function findName(entry, chapters, mergedKeys = new Set()) {
  const names = namesForEntry(entry, mergedKeys);
  /** @type {Array<{name: string, chapter: string, line: number, matched: string}>} */
  const matches = [];
  const chapterIds = new Set();
  const rules = new Set();

  for (const { name, prepared } of names) {
    for (const chapter of chapters) {
      for (let i = 0; i < chapter.prepared.length; i += 1) {
        const matched = matchPreparedLine(chapter.prepared[i], prepared);
        if (!matched) continue;
        matches.push({ name, chapter: chapter.id, line: i + 1, matched });
        chapterIds.add(chapter.id);
        rules.add(matched);
      }
    }
  }

  if (matches.length === 0) return null;
  return {
    first: matches[0],
    matches,
    chapterIds: [...chapterIds],
    rules: [...rules],
  };
}

/**
 * The measured presence for one volume.
 *
 * @param {{db: Object}} ctx
 * @param {number} volume
 * @returns {Array<{volume: number, key: string, present: number, matched: string|null, chapter: string|null, line: number|null, chapters: number, matches: number}>}
 */
function castPresence(ctx, volume) {
  return ctx.db
    .prepare(
      "SELECT volume, key, present, matched, chapter, line, chapters, matches FROM cast_presence WHERE volume = ? ORDER BY key"
    )
    .all(Number(volume));
}

/**
 * Where one character's name actually occurs in one volume's text, chapter by chapter.
 *
 * The audit's answer to "how do you know they are in the volume" — the chapters, how many lines
 * in each, and which rule proved each one. An empty array means the measurement was never taken
 * for that character, which is a different answer from "they are not in the book": that is
 * `cast_presence.present = 0` with `chapters = 0`, and `presenceMeasured` is what tells them apart.
 *
 * @param {{db: Object}} ctx
 * @param {number} volume
 * @param {string} key
 * @returns {Array<{chapter: string, lines: number, matched: string}>} One row per chapter the name was found in.
 */
function presenceDetail(ctx, volume, key) {
  return ctx.db
    .prepare(
      "SELECT chapter, COUNT(*) AS lines, GROUP_CONCAT(DISTINCT matched) AS matched FROM cast_presence_match " +
        "WHERE volume = ? AND key = ? GROUP BY chapter ORDER BY chapter"
    )
    .all(Number(volume), key)
    .map((row) => ({ chapter: row.chapter, lines: Number(row.lines), matched: row.matched }));
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

/**
 * How many of this volume's chapter files the presence measurement read.
 *
 * The denominator of "named in 3 of 10 chapters". Null when the measurement has not run, which is
 * the same "nobody has measured this volume" answer `presenceMeasured` gives.
 *
 * @param {{db: Object}} ctx
 * @param {number} volume
 * @returns {number|null}
 */
function presenceChapterCount(ctx, volume) {
  const row = ctx.db.prepare("SELECT value FROM store_info WHERE key = ?").get(`presence_chapters_${Number(volume)}`);
  if (!row) return null;
  const n = Number.parseInt(row.value, 10);
  return Number.isFinite(n) ? n : null;
}

module.exports = {
  recordCastPresence,
  castPresence,
  presenceDetail,
  presenceChapterCount,
  presenceMeasured,
};
