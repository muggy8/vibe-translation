/**
 * utils/reference-store/identity/sources.js — the two things that actually STATE a link, read as they are.
 *
 * Slice 1 measured every candidate source in this corpus (plan 06 §2.11). Six of them state nothing at
 * all — `cast.aliases` 0 rows, `cast_merges` 0 rows, every `cast_presence_match.name` equal to its own
 * key, `facts.extracted_as` 0 rows, `document_prose` 0 rows, `attribution_answers` 0 rows — and two
 * state something:
 *
 *   - **`<base>-ruby-guides.json`** — the extraction's pronunciation-guide harvest, which is the book's
 *     own markup: 三色院菫子 is annotated パンジー 18 times, 日向葵 is annotated ひまわり. **13 pairs,
 *     24 of the 196 roster entries.** It is the only structured source, and it is the one that cannot
 *     answer the question a *merge* needs (which entry is the character) — which is exactly why this
 *     slice files a group instead of a survivor.
 *   - **the record's own Characters rows** — the same prose the published glossary prints, already
 *     inside `facts` with `section = 'Characters'`. **56 pairs, 88 entries.** Read through the pinned
 *     shape table in `shapes.js`, never through a general prose rule.
 *
 * Both readers here **state what they skipped**. The ruby guide misses 大賀太陽 → サンちゃん outright
 * because the book spells the reading サンちやん and the roster spells it サンちゃん; that is reported as
 * a near miss and filed as nothing, because a door that normalizes spelling is a door that has decided
 * two names are the same one on the strength of a ャ/ヤ pair.
 *
 * @module utils/reference-store/identity/sources
 */

const fs = require("fs");
const path = require("path");

const { GLOSSARY_CHARACTER_SECTION } = require("../glossary-adapter/labels");
const { EXTRACTION_SOURCE_STAGE } = require("../schema");
const { statedLinksInProse } = require("./shapes");
require("../../../types"); // JSDoc type definitions

/**
 * The suffix of the pronunciation-guide harvest the extraction writes beside the bundle.
 *
 * Inlined rather than imported from `utils/source/ruby-guides.js` for the same reason
 * `source-chapters.js` inlines `-bundle.meta.json` and `-whole.md`: the store reads the **files** the
 * extraction wrote, not the extraction's modules. Pulling that require in would put `cheerio` and the
 * epub converter behind every identity query, and the store is a leaf on purpose (gotcha 85). The name
 * is one string in one place on each side, and `test/test-identity-table.js` asserts the two agree.
 *
 * @type {string}
 */
const RUBY_GUIDE_HARVEST_SUFFIX = "-ruby-guides.json";

/**
 * The pronunciation-guide harvest files this volume's extraction wrote.
 *
 * Read-only, and read from the volume folder the store already resolved. A volume with no harvest (a
 * plain-text book, or a volume nobody has extracted) is reported, not guessed at.
 *
 * @param {string} volumeDir - The volume folder.
 * @param {number} [volume] - The volume these harvests belong to, stamped onto each one.
 * @returns {{files: Array<{file: string, rows: Array<Object>, volume: number|null}>, error: string|null}}
 */
function readRubyGuideHarvests(volumeDir, volume) {
  const vol = Number.isInteger(Number(volume)) ? Number(volume) : null;
  let names;
  try {
    names = fs.readdirSync(volumeDir);
  } catch (err) {
    return { files: [], error: `cannot read ${volumeDir}: ${String(err && err.message ? err.message : err)}` };
  }
  const files = [];
  for (const name of names.sort()) {
    if (!name.endsWith(RUBY_GUIDE_HARVEST_SUFFIX)) continue;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(volumeDir, name), "utf8"));
    } catch (err) {
      files.push({ file: name, rows: [], volume: vol, parseError: String(err && err.message ? err.message : err) });
      continue;
    }
    const rows = Array.isArray(parsed && parsed.guides) ? parsed.guides : [];
    files.push({ file: name, rows, volume: vol });
  }
  return { files, error: files.length ? null : `no ${RUBY_GUIDE_HARVEST_SUFFIX} file in ${volumeDir}` };
}

/**
 * Fold one small-kana spelling onto the one the roster is likely to use.
 *
 * **This is used to REPORT a near miss, never to file a link.** 大賀太陽 → サンちやん is the book's
 * spelling of サンちゃん; saying so out loud is useful, and filing it would be the door deciding a name
 * match on a small-kana fold, which is a spelling rule this layer does not have anywhere else.
 *
 * @param {string} text
 * @returns {string}
 */
function foldSmallKana(text) {
  const small = { "\u3083": "\u3084", "\u3085": "\u3086", "\u3087": "\u3088", "\u30c3": "\u30c4", "\u30e7": "\u30e8", "\u30e3": "\u30e4" };
  return String(text || "")
    .split("")
    .map((ch) => (small[ch] === undefined ? ch : small[ch]))
    .join("");
}

/**
 * The links the book's own markup states, and the ones it almost states.
 *
 * A guide row states a link when **both** the annotated word and the reading the author gave it are
 * roster entries of this record, and they differ. Everything else is reported: a reading that is a
 * roster name spelled differently is a `nearMiss`, and a guide whose word is a roster name but whose
 * reading is not (蒲田公英 → たんぽぽ when たんぽぽ is not on the roster) is a `skipped`.
 *
 * @param {Array<{file: string, rows: Array<Object>, volume?: number}>} harvests - From `readRubyGuideHarvests`. Each harvest carries the volume its book is.
 * @param {Set<string>} castKeys - The roster this record holds.
 * @param {number} [defaultVolume] - The volume to attribute a harvest to when it does not carry one.
 * @returns {{links: Array<{a: string, b: string, statedBy: string, volume: number, sourceFile: string, reason: string, annotations: number, chapters: string[]}>, nearMisses: Array<{word: string, reading: string, rosterName: string, sourceFile: string}>, skipped: number, rows: number}}
 */
function rubyGuideStatedLinks(harvests, castKeys, defaultVolume) {
  /** @type {Map<string, {a: string, b: string, statedBy: string, volume: number, sourceFile: string, word: string, reading: string, volumes: Set<number>, annotations: number, chapters: Set<string>}>} */
  const byPair = new Map();
  const nearMisses = [];
  let skipped = 0;
  let rows = 0;

  for (const harvest of harvests) {
    const harvestVolume = Number.isInteger(Number(harvest.volume)) ? Number(harvest.volume) : Number(defaultVolume);
    for (const guide of harvest.rows) {
      rows += 1;
      const word = String((guide && guide.word) || "").trim();
      const reading = String((guide && guide.reading) || "").trim();
      if (!word || !reading || word === reading) {
        skipped += 1;
        continue;
      }
      if (castKeys.has(word) && castKeys.has(reading)) {
        const [a, b] = [word, reading].sort();
        const id = `${a} ${b}`;
        if (!byPair.has(id)) {
          byPair.set(id, {
            a,
            b,
            statedBy: "ruby-guide",
            volume: harvestVolume,
            sourceFile: harvest.file,
            word,
            reading,
            volumes: new Set([harvestVolume]),
            annotations: 0,
            chapters: new Set(),
          });
        }
        const link = byPair.get(id);
        link.annotations += Number(guide.count || 0);
        link.volumes.add(harvestVolume);
        for (const chapter of Array.isArray(guide.chapters) ? guide.chapters : []) link.chapters.add(String(chapter));
        continue;
      }
      // The reading is a roster name the book spelled differently. Named, not filed.
      if (castKeys.has(word) && !castKeys.has(reading)) {
        const folded = foldSmallKana(reading);
        const hit = [...castKeys].find((key) => key !== word && foldSmallKana(key) === folded);
        if (hit) {
          nearMisses.push({ word, reading, rosterName: hit, sourceFile: harvest.file });
          continue;
        }
      }
      skipped += 1;
    }
  }

  const links = [...byPair.values()].map((link) => ({
    a: link.a,
    b: link.b,
    statedBy: link.statedBy,
    volume: link.volume,
    sourceFile: link.sourceFile,
    reason:
      `the book annotates ${link.word} with the reading ${link.reading} in volume(s) ` +
      `${[...link.volumes].sort((x, y) => x - y).join(", ")} — ${link.annotations} annotation(s) in ` +
      `${link.sourceFile}`,
    annotations: link.annotations,
    chapters: [...link.chapters].sort(),
  }));
  return { links, nearMisses, skipped, rows };
}

/**
 * The record's own published character rows — the same prose the volume's `glossary.md` prints.
 *
 * Two filters, both stated:
 *
 *   - the extraction's candidate copies (`source_stage = 'extract'`) are excluded: they are not record
 *     content anywhere else in this layer either, and a link stated by a chapter-level read is a
 *     different source from the one §2.11 measured;
 *   - when `establishedVolume` is given, only the rows **that volume established** are returned. The
 *     record is cumulative, so volume 17's copy holds volume 1's rows too; filing them again from volume
 *     17 would file the same statement seventeen times and stamp it with the wrong volume. Each row is
 *     read once, by the volume that wrote it, and copy-forward carries the link with the row.
 *
 * @param {{db: Object}} ctx - Anything with a `db` holding `facts`.
 * @param {{establishedVolume?: number}} [opts]
 * @returns {Array<{factId: string, term: string, notes: string, section: string, establishedVolume: number}>}
 */
function characterRowsInRecord(ctx, { establishedVolume } = {}) {
  const rows =
    establishedVolume === undefined || establishedVolume === null
      ? ctx.db
          .prepare(
            "SELECT id, examples, body, section, established_volume FROM facts WHERE section = ? AND source_stage <> ? ORDER BY established_volume, ord"
          )
          .all(GLOSSARY_CHARACTER_SECTION, EXTRACTION_SOURCE_STAGE)
      : ctx.db
          .prepare(
            "SELECT id, examples, body, section, established_volume FROM facts WHERE section = ? AND source_stage <> ? AND established_volume = ? ORDER BY ord"
          )
          .all(GLOSSARY_CHARACTER_SECTION, EXTRACTION_SOURCE_STAGE, Number(establishedVolume));
  const out = [];
  for (const row of rows) {
    let examples = [];
    try {
      examples = JSON.parse(row.examples || "[]").map(String);
    } catch {
      examples = [];
    }
    const term = (examples[0] || "").trim();
    if (!term) continue;
    out.push({
      factId: row.id,
      term,
      notes: String(row.body || ""),
      section: row.section,
      establishedVolume: Number(row.established_volume),
    });
  }
  return out;
}

/**
 * The links the record's character rows state, through the pinned shape table.
 *
 * @param {Array<{factId: string, term: string, notes: string}>} rows - From `characterRowsInRecord`.
 * @param {Set<string>} castKeys - The roster this record holds.
 * @returns {{links: Array<{a: string, b: string, statedBy: string, factId: string, shape: string, reason: string}>, excluded: Array<{term: string, otherKey: string, shape: string, because: string}>, rowsNamingAnotherKey: number}}
 */
function characterRowStatedLinks(rows, castKeys) {
  const links = [];
  const excluded = [];
  let rowsNamingAnotherKey = 0;
  for (const row of rows) {
    const { stated, excluded: rejected } = statedLinksInProse({ term: row.term, notes: row.notes }, castKeys);
    if (stated.length || rejected.length) rowsNamingAnotherKey += 1;
    for (const hit of stated) {
      const [a, b] = [row.term, hit.otherKey].sort();
      links.push({
        a,
        b,
        statedBy: "glossary-character-row",
        volume: Number.isInteger(row.establishedVolume) ? row.establishedVolume : undefined,
        factId: row.factId,
        shape: hit.shape,
        reason: `the ${GLOSSARY_CHARACTER_SECTION} row ${row.factId} (established in volume ${row.establishedVolume}) states it through the shape "${hit.shape}": ${row.notes}`,
      });
    }
    for (const miss of rejected) {
      excluded.push({ term: row.term, otherKey: miss.otherKey, shape: miss.shape, because: miss.because });
    }
  }
  return { links, excluded, rowsNamingAnotherKey };
}

module.exports = {
  RUBY_GUIDE_HARVEST_SUFFIX,
  readRubyGuideHarvests,
  foldSmallKana,
  rubyGuideStatedLinks,
  characterRowsInRecord,
  characterRowStatedLinks,
};
