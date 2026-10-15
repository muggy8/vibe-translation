/**
 * utils/reference-store/written-forms/reports/collisions.js — the pure half of the two source-quality
 * reports: the two chapter-scoped shapes, the one discriminator, and the rule this layer measured and
 * rejected.
 *
 * Plan 07 slice 2b. Both reports answer the same question in two directions, over rows the record
 * already holds:
 *
 *   **shape (a)** — one **written form** guided two or more different ways **in the same chapter**.
 *   The real case is in the harvest already: volume 17 chapter 5 guides 三色院董子 as
 *   さんしよくいん**すみれ**こ and as さんしよくいん**すれみ**こ. A reading whose moras are transposed.
 *
 *   **shape (b)** — one guided **reading** printed over two or more written forms **in the same
 *   chapter**. Volume 16 prints 菫子 and 董子 under すみれこ in four chapters.
 *
 * ## Why "in the same chapter" is the discriminator, and why it is not enough on its own
 *
 * A form guided two ways **somewhere in a 17-book series** is a fact about a language: 嫌 is read いや,
 * きら and ぎら. A form guided two ways **in one chapter** is a fact about one page. But measured over
 * the 8,910 rows the record holds, chapter scope alone still reports 244 collisions of shape (a) and
 * 309 of shape (b), and almost all of them are legitimate:
 *
 * | shape | collisions | (volume, key) pairs | keys |
 * |---|---|---|---|
 * | (a) one form, 2+ readings, one chapter | 244 | 142 | 71 forms |
 * | (b) one reading, 2+ forms, one chapter | 309 | 181 | 81 readings |
 *
 * So this file computes the widths **and** the one narrow class, and lets the door print the widths as
 * counts rather than as findings. The narrow class is the transposition: **the author's two answers are
 * made of the same characters in a different order**. Measured on the real corpus it fires **once** —
 * on the plan's own defect — and **zero** times on shape (b), and it fires on none of the legitimate
 * shapes planted in `test/test-source-quality-reports.js`.
 *
 * It is deliberately a statement about two strings and not about a language. "Same characters, different
 * order" is what a transposition typo is in any script (English *recieve* / *receive*), and this
 * repository carries no list of what a language is (plan 06 §4.3 guard 1, `test/test-no-language-axis-list.js`).
 *
 * ## The rule this layer measured and rejected, kept because it is re-measurable
 *
 * `naiveFrequencyCandidates` is the plan's "one form at least 10× more common than another under the same
 * reading". It is exported so the test and the measurement share one implementation, and **no door in this
 * layer calls it**. Measured on the record's own rows, same-chapter: **39 collisions / 31 pairs**, of which
 * 9 have the smaller count at 2 or more — and the ones it flags are 込 ×36 / 越 ×7 / 濃 ×3 / 子 ×2,
 * 芝 ×102 / 縛 ×7, 達 ×48 / 性質 ×2, i.e. plan 07 §2.11's exact false positives. It also **misses** the
 * real defect: 董子 appears in 0 of its candidates, because the two readings of 三色院董子 are one guide
 * over one form and the rule only compares forms. A detector that flags the noise and misses the defect is
 * the reason §2.11 says frequency is not a detector.
 *
 * **Reads nothing, writes nothing, calls no model.** Every input is a row the record already holds.
 *
 * @module utils/reference-store/written-forms/reports/collisions
 */

require("../../../../types"); // JSDoc type definitions

/**
 * @typedef {Object} WrittenFormRow
 * One row of `written_forms`, exactly as `written-forms/rows.js`'s `writtenFormsInRecord` reads it back.
 * Declared here rather than imported so this file's only dependency is the row it is handed.
 * @property {number} volume        - The volume whose harvest produced the row.
 * @property {string} form          - The written form, guides already removed.
 * @property {string} reading       - The reading the author guided it with.
 * @property {number} occurrences   - Times **that volume** guided that form that way — a volume-wide count.
 * @property {string[]} chapters    - The segment ids it occurred in, in the order the harvest recorded them.
 */

/**
 * @typedef {Object} FormChapterCollision
 * One written form guided two or more ways inside one chapter of one volume.
 * @property {number} volume        - The volume whose harvest recorded it.
 * @property {string} form          - The written form, guides already removed.
 * @property {string} chapter       - The segment id the two guides were recorded in.
 * @property {Array<{reading: string, occurrences: number}>} readings - The guided readings, sorted.
 * @property {number} readingCount  - How many distinct readings this form carries in this chapter.
 */

/**
 * @typedef {Object} ReadingChapterCollision
 * One guided reading printed over two or more written forms inside one chapter of one volume.
 * @property {number} volume
 * @property {string} reading
 * @property {string} chapter
 * @property {Array<{form: string, occurrences: number}>} forms - The written forms, sorted.
 * @property {number} formCount
 */

/**
 * @typedef {Object} NaiveFrequencyCandidate
 * One pair the rejected "10× more common" rule would have flagged. Produced only by
 * {@link naiveFrequencyCandidates}, which no door calls.
 * @property {number} volume
 * @property {string} reading
 * @property {string} chapter
 * @property {string} largerForm
 * @property {number} largerCount
 * @property {string} smallerForm
 * @property {number} smallerCount
 * @property {number} ratio
 */

/**
 * How far apart two counts have to be for the **rejected** frequency rule to flag them.
 *
 * Kept as a constant rather than a setting: it is the number plan 07 §2.11 measured (132 candidate pairs
 * over the raw harvest), not a dial. Nothing in this layer calls the rule that uses it.
 *
 * @type {number}
 */
const NAIVE_FREQUENCY_FACTOR = 10;

/**
 * The sentence the reports print beside the transposition class, so a reader knows what was called a
 * defect and what was not.
 *
 * @type {string}
 */
const TRANSPOSITION_RULE_NOTE =
  "The anomaly this report calls a defect is one the author's own two answers disagree about in the same " +
  "place: the two guided strings are made of exactly the same characters in a different order. A word the " +
  "author reads several ways, and a name the author spells two ways, are not defects and are reported as " +
  "counts.";

/**
 * A string with every run of whitespace removed.
 *
 * The same normalisation `shapes.js`'s `closestFormPairOf` applies before it compares two written forms,
 * restated here rather than imported so the two comparisons cannot disagree about what the same form is.
 *
 * @param {string} value
 * @returns {string}
 */
function stripSpaces(value) {
  return String(value === undefined || value === null ? "" : value).replace(/\s+/g, "");
}

/**
 * Characters of a string, sorted — the comparison a transposition is.
 *
 * @param {string} value
 * @returns {string}
 */
function sortedCharacters(value) {
  return Array.from(stripSpaces(value)).sort().join("");
}

/**
 * Whether two strings are **the same characters in a different order**.
 *
 * The transposition test, and the whole discriminator this layer ships. It is length-equality plus a
 * character-multiset equality, which is script-neutral: it says nothing about kana, Han, or Latin, and it
 * cannot fire on 美味 / 上手 (different characters), 貴女 / 貴方 (different characters), いや / きら / ぎら
 * (different characters) or 菫子 / 董子 (different characters). It fires on
 * さんしよくいんすみれこ / さんしよくいんすれみこ, which is the defect plan 07 §2.11(b) names.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean} True when both are non-empty, differ, and are anagrams of each other.
 */
function sameCharactersDifferentOrder(a, b) {
  const x = stripSpaces(a);
  const y = stripSpaces(b);
  if (!x || !y || x === y) return false;
  if (x.length !== y.length) return false;
  return sortedCharacters(x) === sortedCharacters(y);
}

/**
 * Whether **any pair** in a list satisfies a two-string test.
 *
 * Every pair, not just the extremes: a form guided three ways can carry one transposed pair beside two
 * unrelated readings, and asking only the first pair would answer the wrong question.
 *
 * @param {string[]} values
 * @param {(a: string, b: string) => boolean} test
 * @returns {boolean}
 */
function anyPairMatches(values, test) {
  const list = Array.isArray(values) ? values : [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (test(list[i], list[j])) return true;
    }
  }
  return false;
}

/**
 * Shape (a): every (volume, written form, chapter) where that form was guided two or more different ways.
 *
 * Chapter scope is the whole point of this function, and it is why the rows' `chapters` cells matter:
 * `written_forms.occurrences` is a **volume-wide** count, so a form guided twice in one chapter and twice
 * in another looks identical to a form guided four times in one chapter unless the chapter lists are read.
 * The count each reading carries here is still the volume-wide count, and every report that prints it says
 * so rather than implying a per-chapter count.
 *
 * @param {WrittenFormRow[]} rows - Rows this record holds, from `rows.js`'s `writtenFormsInRecord`.
 * @returns {FormChapterCollision[]} Sorted by volume, then chapter, then form.
 */
function collisionsForFormsByChapter(rows) {
  /** @type {Map<number, Map<string, Map<string, {occurrences: number, chapters: Set<string>}>>>} */
  const byVolume = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const volume = Number(row.volume);
    const form = stripSpaces(row.form);
    const reading = stripSpaces(row.reading);
    if (!Number.isFinite(volume) || !form || !reading) continue;
    if (!byVolume.has(volume)) byVolume.set(volume, new Map());
    const forms = byVolume.get(volume);
    if (!forms.has(form)) forms.set(form, new Map());
    const readings = forms.get(form);
    if (!readings.has(reading)) readings.set(reading, { occurrences: 0, chapters: new Set() });
    const entry = readings.get(reading);
    entry.occurrences += Number(row.occurrences) || 0;
    for (const chapter of Array.isArray(row.chapters) ? row.chapters : []) entry.chapters.add(stripSpaces(chapter));
  }

  /** @type {FormChapterCollision[]} */
  const out = [];
  for (const volume of [...byVolume.keys()].sort((a, b) => a - b)) {
    for (const [form, readings] of byVolume.get(volume)) {
      if (readings.size < 2) continue;
      /** @type {Map<string, Map<string, number>>} */
      const perChapter = new Map();
      for (const [reading, info] of readings) {
        for (const chapter of info.chapters) {
          if (!chapter) continue;
          if (!perChapter.has(chapter)) perChapter.set(chapter, new Map());
          perChapter.get(chapter).set(reading, info.occurrences);
        }
      }
      for (const chapter of [...perChapter.keys()].sort()) {
        const map = perChapter.get(chapter);
        if (map.size < 2) continue;
        out.push({
          volume,
          form,
          chapter,
          readings: [...map.entries()].map(([reading, occurrences]) => ({ reading, occurrences })).sort((a, b) => (a.reading < b.reading ? -1 : 1)),
          readingCount: map.size,
        });
      }
    }
  }
  return out;
}

/**
 * Shape (b): every (volume, guided reading, chapter) where that reading was printed over two or more
 * written forms.
 *
 * @param {WrittenFormRow[]} rows
 * @returns {ReadingChapterCollision[]} Sorted by volume, then chapter, then reading.
 */
function collisionsForReadingsByChapter(rows) {
  /** @type {Map<number, Map<string, Map<string, Map<string, number>>>>} */
  const byVolume = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const volume = Number(row.volume);
    const form = stripSpaces(row.form);
    const reading = stripSpaces(row.reading);
    if (!Number.isFinite(volume) || !form || !reading) continue;
    if (!byVolume.has(volume)) byVolume.set(volume, new Map());
    const readings = byVolume.get(volume);
    if (!readings.has(reading)) readings.set(reading, new Map());
    const chapters = readings.get(reading);
    for (const chapterRaw of Array.isArray(row.chapters) ? row.chapters : []) {
      const chapter = stripSpaces(chapterRaw);
      if (!chapter) continue;
      if (!chapters.has(chapter)) chapters.set(chapter, new Map());
      const forms = chapters.get(chapter);
      forms.set(form, (forms.get(form) || 0) + (Number(row.occurrences) || 0));
    }
  }

  /** @type {ReadingChapterCollision[]} */
  const out = [];
  for (const volume of [...byVolume.keys()].sort((a, b) => a - b)) {
    for (const [reading, chapters] of byVolume.get(volume)) {
      for (const chapter of [...chapters.keys()].sort()) {
        const forms = chapters.get(chapter);
        if (forms.size < 2) continue;
        out.push({
          volume,
          reading,
          chapter,
          forms: [...forms.entries()].map(([form, occurrences]) => ({ form, occurrences })).sort((a, b) => (a.form < b.form ? -1 : 1)),
          formCount: forms.size,
        });
      }
    }
  }
  return out;
}

/**
 * The first pair in a list that are the same characters in a different order.
 *
 * @param {string[]} values
 * @returns {string[]|null} The pair, or null when no pair matches.
 */
function findTransposedPair(values) {
  const list = Array.isArray(values) ? values : [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (sameCharactersDifferentOrder(list[i], list[j])) return [list[i], list[j]];
    }
  }
  return null;
}

/**
 * The collisions whose two guided strings are the same characters in a different order.
 *
 * The anomaly class, for either shape. `key` names which side of the collision is compared: `readings`
 * for shape (a), `forms` for shape (b). Each returned collision carries `transposedPair`, the two strings
 * that matched, so a report can print the pair without re-deriving it.
 *
 * @param {Array<FormChapterCollision|ReadingChapterCollision>} collisions
 * @param {"readings"|"forms"} key
 * @returns {Array<FormChapterCollision|ReadingChapterCollision>} Copies of the matching collisions.
 */
function transposedCollisions(collisions, key) {
  const list = Array.isArray(collisions) ? collisions : [];
  const field = key === "forms" ? "forms" : "readings";
  const out = [];
  for (const collision of list) {
    const pair = findTransposedPair((collision[field] || []).map((side) => side.reading || side.form));
    if (pair) out.push({ ...collision, transposedPair: pair });
  }
  return out;
}

/**
 * How many (volume, written form) pairs in the record carry two or more guided readings, ignoring chapters.
 *
 * The **loose** width, printed beside the chapter-scoped one so a reader can see what chapter scope cost:
 * measured over the record's rows, 215 pairs become 142 once "in one chapter" is asked.
 *
 * @param {WrittenFormRow[]} rows
 * @returns {{pairs: number, keys: number}} `pairs` counts (volume, form); `keys` counts distinct forms.
 */
function formsCarryingMoreThanOneReading(rows) {
  /** @type {Map<number, Map<string, Set<string>>>} */
  const byVolume = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const volume = Number(row.volume);
    const form = stripSpaces(row.form);
    const reading = stripSpaces(row.reading);
    if (!Number.isFinite(volume) || !form || !reading) continue;
    if (!byVolume.has(volume)) byVolume.set(volume, new Map());
    const forms = byVolume.get(volume);
    if (!forms.has(form)) forms.set(form, new Set());
    forms.get(form).add(reading);
  }
  let pairs = 0;
  const keys = new Set();
  for (const forms of byVolume.values()) {
    for (const [form, readings] of forms) {
      if (readings.size < 2) continue;
      pairs++;
      keys.add(form);
    }
  }
  return { pairs, keys: keys.size };
}

/**
 * How many distinct (volume, key) pairs a collision list covers.
 *
 * Chapter ids repeat across volumes — every volume has a `ch1` — so a collision is only ever counted
 * inside its own volume, and this is the count that says so.
 *
 * @param {Array<FormChapterCollision|ReadingChapterCollision>} collisions
 * @param {"form"|"reading"} key
 * @returns {{collisions: number, pairs: number, keys: number}} `keys` counts the distinct strings, ignoring volume.
 */
function collisionTotals(collisions, key) {
  const list = Array.isArray(collisions) ? collisions : [];
  const pairs = new Set();
  const strings = new Set();
  for (const collision of list) {
    const value = String(collision[key === "reading" ? "reading" : "form"]);
    pairs.add(`${collision.volume}|${value}`);
    strings.add(value);
  }
  return { collisions: list.length, pairs: pairs.size, keys: strings.size };
}

/**
 * The **rejected** rule, implemented once so it can be measured rather than remembered.
 *
 * Plan 07 §2.11: "one form at least 10× more common than another under the same reading" selects 132
 * candidate pairs over the raw harvest, most of them single-mora guides. **No door in this layer calls
 * this function.** It exists because a rejected alternative that only exists in a paragraph cannot be
 * re-measured, and because `test/test-source-quality-reports.js` pins that the two doors do not use it.
 *
 * @param {ReadingChapterCollision[]} collisions - Shape (b) collisions: the rule compares **forms** under one reading.
 * @param {{factor?: number}} [opts]
 * @returns {{candidates: NaiveFrequencyCandidate[], totals: {collisions: number, candidates: number, pairs: number, smallerCountAtLeastTwo: number}}}
 */
function naiveFrequencyCandidates(collisions, { factor = NAIVE_FREQUENCY_FACTOR } = {}) {
  /** @type {NaiveFrequencyCandidate[]} */
  const candidates = [];
  for (const collision of Array.isArray(collisions) ? collisions : []) {
    const forms = (collision.forms || []).slice().sort((a, b) => b.occurrences - a.occurrences || (a.form < b.form ? -1 : 1));
    if (forms.length < 2) continue;
    const larger = forms[0];
    const smaller = forms[forms.length - 1];
    if (smaller.occurrences <= 0) continue;
    const ratio = larger.occurrences / smaller.occurrences;
    if (ratio < factor) continue;
    candidates.push({
      volume: collision.volume,
      reading: collision.reading,
      chapter: collision.chapter,
      largerForm: larger.form,
      largerCount: larger.occurrences,
      smallerForm: smaller.form,
      smallerCount: smaller.occurrences,
      ratio,
    });
  }
  return {
    candidates,
    totals: {
      collisions: (Array.isArray(collisions) ? collisions : []).length,
      candidates: candidates.length,
      pairs: new Set(candidates.map((candidate) => `${candidate.volume}|${candidate.reading}`)).size,
      smallerCountAtLeastTwo: candidates.filter((candidate) => candidate.smallerCount >= 2).length,
    },
  };
}

module.exports = {
  NAIVE_FREQUENCY_FACTOR,
  TRANSPOSITION_RULE_NOTE,
  stripSpaces,
  sortedCharacters,
  sameCharactersDifferentOrder,
  anyPairMatches,
  findTransposedPair,
  formsCarryingMoreThanOneReading,
  collisionsForFormsByChapter,
  collisionsForReadingsByChapter,
  transposedCollisions,
  collisionTotals,
  naiveFrequencyCandidates,
};
