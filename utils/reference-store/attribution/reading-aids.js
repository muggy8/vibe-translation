/**
 * utils/reference-store/attribution/reading-aids.js — the probe that explains a name the store cannot see.
 *
 * The store has ONE matching rule, and it needs a Han-character skeleton of `SKELETON_MIN_CHARS` or more.
 * 蒲田 has two, and the book prints it as 「蒲かま田」 — the reading aids written *between* the two kanji —
 * so the measurement reports the character absent. This file searches a name's kanji in order with only
 * kana between them and reports what it finds.
 *
 * It is a probe, not a second matching rule, and it is **not** wired into `presence.js` or `evidence.js`:
 * widening the store's one rule to rescue one character is how a guard stops meaning what it says, and the
 * coverage rule and the copy-forward guard are built on that rule answering the same question everywhere
 * (gotcha 121). It fires on 1 of the 4 cast entries both real records measure absent, and 0 of the other 3.
 *
 * **What plan 09 changed about it (2026-10-16).** That measurement was taken against the extraction that
 * was on disk then, which pasted the guide into the word. The extraction no longer does that: the guide is
 * markup over a word that stays whole, and the guide-free projection of `<ruby>蒲田<rt>かまた</rt></ruby>`
 * is 蒲田 — which the store's own rule now matches on its **verbatim** rung, the one with no minimum length.
 * So the case this probe was written for is closed by the extraction, not by this file. What the probe is
 * for now is the shape the extraction cannot close: a name short enough that only the skeleton rung could
 * find it *inside* a longer run of characters. And it searches the guide-free projection, for the same
 * reason `presence.js` does — see `readingAidSpan`.
 *
 * @module utils/reference-store/attribution/reading-aids
 */

const { namesForEntry } = require("../presence");
const { stripRubyMarkup } = require("../ruby-markup");
const { volumeChapterLines } = require("./lines");
require("../../../types"); // JSDoc type definitions

/**
 * The Han characters of a name, in order.
 * @param {string} name
 * @returns {string[]}
 */
function hanCharacters(name) {
  return [...String(name || "")].filter((ch) => /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/.test(ch));
}

/**
 * Whether a stretch of text is only reading aids: kana, the long-vowel mark, a repeated-name mark.
 * @param {string} text
 * @returns {boolean}
 */
function onlyReadingAids(text) {
  return /^[\u3041-\u3096\u30A1-\u30FA\u30FC\u3005\u3099-\u309E\u30FD\u30FEー]+$/.test(text);
}

/**
 * The most reading aid this probe is willing to sit between two kanji.
 *
 * 蒲かま田 needs 2. 如月きさらぎ needs 4. Past this the "name" being found is a sentence that happens
 * to contain the right kanji in the right order, which is not a name and not a measurement.
 *
 * @type {number}
 */
const READING_AID_MAX_GAP = 4;

/**
 * Find one name in one line when the book has written its reading aids between its kanji.
 *
 * **The line is stripped first** (plan 09 slice 1, 2026-10-16). This probe explains a verdict
 * `presence.js` reached on the guide-free projection, so it has to look at the same projection; a
 * probe that reads the raw file answers a different question than the measurement it is meant to
 * explain. Measured on the 17 real books, 0 model calls: searching the raw line is **blind** to a name
 * whose kanji are separated by markup (`<ruby>蒲<rt>かま</rt>田<rt>た</rt></ruby>` — the between-text is
 * `<rt>かま</rt>`, which `onlyReadingAids` refuses), and it is **not inert** either: 5 of the 13 harvest
 * readings with two or more Han characters (脅迫, 強制終了, 金属バツト→金属, 緊急事態, 劇場) are "found" in a
 * volume by the raw search and found **nowhere** by the guide-free one, because those characters are a
 * reading written over someone's head, not a word the book prints. Both directions are the probe
 * answering about the markup instead of about the book.
 *
 * @param {string} line - One physical line of the chapter's source text, as the file holds it.
 * @param {string[]} kanji - The name's Han characters, in order.
 * @returns {{span: string, gap: number}|null}
 */
function readingAidSpan(line, kanji) {
  if (kanji.length < 2) return null;
  const text = stripRubyMarkup(line).replace(/\s+/g, "");
  let at = 0;
  let start = -1;
  let gap = 0;
  let maxGap = 0;
  for (let h = 0; h < kanji.length; h += 1) {
    const idx = text.indexOf(kanji[h], at);
    if (idx < 0) return null;
    if (h === 0) start = idx;
    else {
      const between = text.slice(at, idx);
      if (between.length > READING_AID_MAX_GAP) return null;
      if (between.length > 0 && !onlyReadingAids(between)) return null;
      if (between.length > maxGap) maxGap = between.length;
    }
    at = idx + 1;
  }
  return { span: text.slice(start, at), gap: maxGap };
}

/**
 * Whether this volume's own text contains a name when its reading aids are written between its kanji.
 *
 * The probe exists to explain an absence, not to overrule a measurement. Swept over every cast entry
 * in both real records: 1 hit out of the 4 entries measured absent (蒲田 → 「蒲かま田」 at ch3:1243),
 * 0 hits for the other 3, and it cannot say anything at all about a name with fewer than two kanji
 * (ジョージョエン・スカイウォーカー is katakana, so there is no kanji to order).
 *
 * @param {{resolveVolume: Function, db: Object}} ctx
 * @param {{volume: number, key: string}} opts
 * @returns {{found: boolean, hits: Array<{chapter: string, line: number, span: string, gap: number}>, names: string[], kanjiNames: string[], skipped: string[], error: string|null}}
 */
function namePrintedWithReadingAids(ctx, { volume, key }) {
  const entry = ctx.db.prepare("SELECT key, display, aliases, merged_into AS mergedInto FROM cast WHERE key = ?").get(key);
  if (!entry) return { found: false, hits: [], names: [], kanjiNames: [], skipped: [key], error: `no cast entry "${key}"` };
  // The same name list the presence measurement searches, from the same function: key plus the aliases
  // somebody declared, minus the aliases that are themselves merged entries. Two answers to "which
  // names is this character searched for" is how one of them drifts.
  const mergedKeys = new Set(ctx.db.prepare("SELECT key FROM cast WHERE merged_into IS NOT NULL").all().map((row) => row.key));
  const names = namesForEntry(entry, mergedKeys).map((row) => row.name);

  const read = volumeChapterLines(ctx, volume);
  if (read.error) return { found: false, hits: [], names, kanjiNames: [], skipped: [], error: read.error };

  /** @type {Array<{chapter: string, line: number, span: string, gap: number}>} */
  const hits = [];
  /** @type {string[]} */
  const kanjiNames = [];
  /** @type {string[]} */
  const skipped = [];
  for (const name of names) {
    const kanji = hanCharacters(name);
    if (kanji.length < 2) {
      skipped.push(name);
      continue;
    }
    kanjiNames.push(name);
    for (const chapter of read.chapters) {
      for (let i = 0; i < chapter.lines.length; i += 1) {
        const span = readingAidSpan(chapter.lines[i], kanji);
        if (!span) continue;
        hits.push({ chapter: chapter.id, line: i + 1, span: span.span, gap: span.gap });
      }
    }
  }
  // The shortest kanji run among the names this probe could look at. The report prints it because it is
  // the number the store's own matching rule compares against, and "the measurement cannot see this name"
  // is only checkable if the report says how blind the name is.
  const kanjiCounts = kanjiNames.map((name) => hanCharacters(name).length);
  return {
    found: hits.length > 0,
    hits,
    names,
    kanjiNames,
    kanjiCount: kanjiCounts.length ? Math.min(...kanjiCounts) : 0,
    skipped,
    error: null,
  };
}

module.exports = {
  hanCharacters,
  onlyReadingAids,
  READING_AID_MAX_GAP,
  readingAidSpan,
  namePrintedWithReadingAids,
};
