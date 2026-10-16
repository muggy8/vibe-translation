/**
 * utils/reference-store/written-forms/readings.js — "how is this written form read, according to this
 * record?" answered as a query over the rows the record already holds.
 *
 * Plan 09 slice 3b. The published glossary gained a fourth column, and the only honest source for it is
 * the `written_forms` table plan 07 slice 1 built and plan 09 slice 3a wired into every record-open. This
 * file is the **one** door that question is asked through: `renderGlossary` asks it, and no renderer,
 * report or stage selects from `written_forms` itself. `test/test-written-forms.js` scenario 11 pins the
 * caller list, and proves it fires by planting a second caller beside the real one.
 *
 * ## Why a query and not a column
 *
 * A reading is not a fact about a term. It is a fact about **one book**: volume 10 guided 蒲田公英 with
 * たんぽぽ and thirteen other volumes guided it かまたきみえ. The record keeps one row per
 * (volume, written form, guided reading), so "what are this word's readings" is a fold over rows from
 * several books — which is exactly the shape `candidateGroupsInRecord` exists for, and the reason the
 * answer cannot be a column on the glossary row. A column would be one book's opinion stamped onto a row
 * another volume published, and a published row is never edited.
 *
 * ## The bound, and why it is the load-bearing rule
 *
 * `upToVolume` defaults to the record's own volume and is never allowed past it, and every row is filtered
 * `volume <= upToVolume`. `publishedGlossaryRowsInRecord` is bounded the same way, and the two bounds have
 * to agree: `test/test-glossary-revisions.js` pins that rendering volume 1 out of a record that reached
 * volume 2 reproduces volume 1's published file **byte for byte**. A reading column that reached forward
 * would print, in volume 1's file, a guide volume 1's book never printed — the same silent rewrite of the
 * past that bound exists to prevent, arriving through the newest column in the document.
 *
 * ## The order the readings come back in, and why that order
 *
 * **Most-guided first** (total guided occurrences across the volumes this record carries), then the
 * reading recorded in the earliest volume, then the reading itself. The reason is what the corpus actually
 * contains: 三色院菫子 is guided さんしよくいんすみれこ 289 times, パンジー 18, and おつぱい / お前 once each.
 * Ordering by volume would put a one-off guide from book 3 ahead of the author's habitual guide, and a
 * reader scanning a glossary column wants the answer to "how is this word read" first and the exceptions
 * after it. The order is pinned in `test/test-written-forms.js`, not left to a `GROUP BY`.
 *
 * ## What it never does
 *
 * It writes nothing, files nothing, marks nothing, and reaches no model. It does not decide whether a
 * reading contradicts the published rendering — that is plan 09 §6's open question and a language-neutral
 * rule for it has not been found (see the plan and `test/test-no-language-axis-list.js`). It returns rows
 * and counts, and the caller decides what to print.
 *
 * ## A record that predates the table answers, and says so
 *
 * A record is migrated only when something opens it through `openReferenceStore` / `copyForwardStore`;
 * `openDatabase` runs no DDL (plan 06 slice 7). `utils/translate/settled-glossary.js` opens the settled
 * record with `openDatabase(…, { readOnly: true })` on purpose — that is what keeps the translation
 * stage's terminology door clear of gotcha 124 — and every one of this corpus's 17 records is still on
 * schema 8, which has no `written_forms` table. A `SELECT` against it throws, and `withSettledRecord`
 * turns any throw into a **structural** refusal, so a query that needs a table the record does not have
 * would refuse the translation stage's terminology law, the drift report beside it and the glossary
 * settlement's publish of the series-root file — over a column none of them needs in order to translate.
 *
 * So the door answers, and names what it answered: `totals.tablePresent: false`, `rowsInRange: 0`, every
 * asked form with no readings. That is not a guard switched off — it is the honest answer to "what
 * readings does this record hold", and it is the answer only because `tablePresent` travels with it. A
 * renderer that printed the empty column **without** that flag would be reporting "these books guided
 * nothing" about books that guided 45,429 readings, which is the collapse `GLOSSARY_NO_READING_CELL`'s own
 * doc exists to prevent. Refusing instead is written up as an option in `/tmp/opencode/plan09-slice3b-questions.md`
 * and rejected for the cost: it breaks three working doors on all 17 real volumes.
 *
 * @module utils/reference-store/written-forms/readings
 */

const { refusal } = require("../refusals");
const { WRITTEN_FORM_COLUMNS, parseChapters } = require("./rows");
require("../../../types"); // JSDoc type definitions

/**
 * One guided reading of one written form, folded across every volume this record carries.
 *
 * @typedef {Object} RecordedReading
 * @property {string} reading - The reading the author guided the form with.
 * @property {string} readingScript - The harvest's own script label for it, carried through untouched.
 * @property {number} occurrences - Guided occurrences summed over the volumes in range.
 * @property {number} firstVolume - The earliest volume whose harvest recorded it.
 * @property {number} lastVolume - The latest one.
 * @property {number[]} volumes - Every volume that recorded it, in book order.
 * @property {string[]} chapters - The segment ids it occurred in, oldest volume first.
 */

/**
 * Whether this record even has the table the readings are folded out of.
 *
 * A record is only migrated when something opens it through `openReferenceStore` /
 * `copyForwardStore`; `openDatabase` runs no DDL (plan 06 slice 7). So a handle opened read-only on a
 * record written before schema 12 — which is exactly how `utils/translate/settled-glossary.js` opens the
 * settled record, to stay clear of gotcha 124 — points at a database with no `written_forms` table at
 * all, and a `SELECT` against it throws.
 *
 * This is asked here rather than at each caller because the two empty answers must not be collapsed:
 * **"this record holds no written-form rows"** (a book whose harvest filed nothing, or a plain-text book)
 * and **"this record predates the table"** (a record no build has opened since the table was added) are
 * different facts about different things, and a column that prints the same sentence for both is a column
 * that lies about the books it is printed in.
 *
 * @param {{db: Object}} store
 * @returns {boolean}
 */
function writtenFormsTablePresent(store) {
  if (!store || !store.db || typeof store.db.prepare !== "function") return false;
  try {
    const hit = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'written_forms'")
      .get();
    return Boolean(hit);
  } catch {
    return false;
  }
}

/**
 * Fold one written form's rows into its readings, in the order this layer publishes them.
 *
 * Shared by {@link readingsForFormsInRecord} and {@link formsCarryingSeveralReadingsInRecord} so the two
 * cannot disagree about what "the readings of this form" means — the failure mode this store keeps paying
 * to avoid (gotcha 117: two doors that order the same set differently settle it by table order).
 *
 * @param {Array<{volume: number, form: string, reading: string, readingScript: string, occurrences: number, chapters: string[]}>} rows
 * @returns {Map<string, Array<RecordedReading>>} Written form → its readings, most-guided first.
 */
function foldReadingsByForm(rows) {
  /** @type {Map<string, Map<string, RecordedReading>>} */
  const byForm = new Map();
  for (const row of rows) {
    const form = String(row.form || "");
    const reading = String(row.reading || "");
    if (!form || !reading) continue;
    if (!byForm.has(form)) byForm.set(form, new Map());
    const readings = byForm.get(form);
    if (!readings.has(reading)) {
      readings.set(reading, {
        reading,
        readingScript: row.readingScript || "",
        occurrences: 0,
        firstVolume: Number(row.volume),
        lastVolume: Number(row.volume),
        volumes: [],
        chapters: [],
      });
    }
    const entry = readings.get(reading);
    const volume = Number(row.volume);
    entry.occurrences += Number(row.occurrences) || 0;
    if (Number.isFinite(volume)) {
      if (volume < entry.firstVolume) entry.firstVolume = volume;
      if (volume > entry.lastVolume) entry.lastVolume = volume;
      if (!entry.volumes.includes(volume)) entry.volumes.push(volume);
    }
    for (const chapter of row.chapters || []) {
      if (!entry.chapters.includes(chapter)) entry.chapters.push(chapter);
    }
  }
  /** @type {Map<string, Array<RecordedReading>>} */
  const out = new Map();
  for (const [form, readings] of byForm) {
    out.set(
      form,
      [...readings.values()].sort(
        (a, b) =>
          b.occurrences - a.occurrences ||
          a.firstVolume - b.firstVolume ||
          (a.reading < b.reading ? -1 : a.reading > b.reading ? 1 : 0)
      )
    );
  }
  return out;
}

/**
 * The readings this record holds for the written forms it is asked about.
 *
 * @param {{db: Object, volume: number}} store - The record whose rows are asked about.
 * @param {Object} [opts]
 * @param {number} [opts.upToVolume] - The furthest volume whose harvests count. Defaults to the record's
 *   own volume, which is the furthest any volume is allowed to look. A volume later than the record is
 *   **refused**, not answered with a partial fold.
 * @param {string[]} [opts.forms] - The written forms to look up. Omit the key for every form the record
 *   carries; pass an empty array for none.
 * @returns {{ok: true, volume: number, upToVolume: number, forms: Array<{form: string, readings: Array<RecordedReading>}>, totals: Object, refusal: null}|{ok: false, volume: number, upToVolume: number, forms: [], totals: null, refusal: ReferenceRefusal}}
 *   `forms` is in the order the forms were asked for (or record order when none were asked for), and each
 *   entry's `readings` is in this layer's published order: most-guided first. `totals.tablePresent` is the
 *   fact that separates the two empty answers — `false` means this record has no `written_forms` table at
 *   all (it predates schema 12), `true` with `rowsInRange: 0` means the table is there and holds nothing.
 */
function readingsForFormsInRecord(store, { upToVolume, forms } = {}) {
  const recordVolume = Number(store && store.volume);
  const ceiling = Number(upToVolume === undefined ? recordVolume : upToVolume);
  if (!store || !store.db || !Number.isInteger(ceiling) || ceiling < 1) {
    return {
      ok: false,
      volume: recordVolume,
      upToVolume: ceiling,
      forms: [],
      totals: null,
      refusal: refusal({
        verb: "written_form_readings",
        rule: "written-form-readings-volume-undecided",
        because:
          `"${upToVolume}" is not a volume number. "How is this word read" is a question about the harvests ` +
          "one record carries, and a record carries its own volume's and the ones before it.",
        fix: "readingsForFormsInRecord(store, { upToVolume: 3 })",
      }),
    };
  }
  // The same no-forward rule `written-forms/file.js` enforces at filing and `view/select.js` at reading:
  // a volume cannot be shown a guide a later book printed (plan 07 §4.4).
  if (Number.isInteger(recordVolume) && ceiling > recordVolume) {
    return {
      ok: false,
      volume: recordVolume,
      upToVolume: ceiling,
      forms: [],
      totals: null,
      refusal: refusal({
        verb: "written_form_readings",
        rule: "written-form-readings-cannot-look-forward",
        because:
          `this record is volume ${recordVolume} and volume ${ceiling}'s book has not been read by it. ` +
          "The readings a volume may publish are the ones its own record holds.",
        fix: `open the record for volume ${ceiling} and ask that one.`,
        detail: { recordVolume, askedVolume: ceiling },
      }),
    };
  }

  const rows = writtenFormsTablePresent(store)
    ? store.db
        .prepare(`SELECT ${WRITTEN_FORM_COLUMNS} FROM written_forms WHERE volume <= ? ORDER BY volume, form, reading`)
        .all(ceiling)
        .map((row) => ({
          volume: Number(row.volume),
          form: row.form,
          reading: row.reading,
          readingScript: row.readingScript,
          occurrences: Number(row.occurrences),
          chapters: parseChapters(row.chapters),
        }))
    : [];

  const folded = foldReadingsByForm(rows);
  // `forms` omitted means "every form this record carries"; `forms: []` means "none" — the two are
  // different questions, and a caller that published no rows must not be answered with the whole table.
  const asked = Array.isArray(forms) ? forms.map((form) => String(form || "")) : [...folded.keys()];
  const out = [];
  const seen = new Set();
  for (const form of asked) {
    if (!form || seen.has(form)) continue;
    seen.add(form);
    out.push({ form, readings: folded.get(form) || [] });
  }

  let readings = 0;
  let occurrences = 0;
  let formsWithSeveral = 0;
  for (const entry of out) {
    readings += entry.readings.length;
    for (const reading of entry.readings) occurrences += reading.occurrences;
    if (entry.readings.length > 1) formsWithSeveral += 1;
  }
  return {
    ok: true,
    volume: recordVolume,
    upToVolume: ceiling,
    forms: out,
    totals: {
      rowsInRange: rows.length,
      formsAsked: out.length,
      formsWithReadings: out.filter((entry) => entry.readings.length > 0).length,
      formsWithoutReadings: out.filter((entry) => entry.readings.length === 0).length,
      distinctReadings: readings,
      guidedOccurrences: occurrences,
      formsWithSeveralReadings: formsWithSeveral,
      tablePresent: writtenFormsTablePresent(store),
    },
    refusal: null,
  };
}

/**
 * The written forms this record shows guided **more than one way** — the named set plan 09 decision 5 asks
 * for, and the candidate list plan 09 slice 4's terminology review is built from.
 *
 * It is a read over the same rows, not a second opinion about them: no group guard, no roster, no identity,
 * and no judgement about *why* a form was guided two ways. A guide that carries meaning (蒲田公英 guided
 * たんぽぽ), a one-volume disagreement (金本 guided かねもと and かなもと) and an alias written over a name
 * (大賀太陽 guided サンちやん) are all in this list, and telling them apart is not this door's job —
 * plan 07 §2.11 measured what happens when a door guesses at that.
 *
 * @param {{db: Object, volume: number}} store
 * @param {{upToVolume?: number}} [opts]
 * @returns {{ok: boolean, upToVolume: number, forms: Array<{form: string, readings: Array<RecordedReading>}>, totals: Object|null, refusal: Object|null}}
 */
function formsCarryingSeveralReadingsInRecord(store, { upToVolume } = {}) {
  const asked = readingsForFormsInRecord(store, { upToVolume });
  if (!asked.ok) return { ok: false, upToVolume: asked.upToVolume, forms: [], totals: null, refusal: asked.refusal };
  const forms = asked.forms.filter((entry) => entry.readings.length > 1);
  return {
    ok: true,
    upToVolume: asked.upToVolume,
    forms,
    totals: {
      formsInRecord: asked.forms.length,
      formsWithSeveralReadings: forms.length,
      readings: forms.reduce((sum, entry) => sum + entry.readings.length, 0),
      guidedOccurrences: forms.reduce(
        (sum, entry) => sum + entry.readings.reduce((inner, reading) => inner + reading.occurrences, 0),
        0
      ),
      tablePresent: asked.totals ? asked.totals.tablePresent : false,
    },
    refusal: null,
  };
}

module.exports = {
  writtenFormsTablePresent,
  foldReadingsByForm,
  readingsForFormsInRecord,
  formsCarryingSeveralReadingsInRecord,
};
