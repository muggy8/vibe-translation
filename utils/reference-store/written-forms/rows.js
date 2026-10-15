/**
 * utils/reference-store/written-forms/rows.js — the row, and the reads over it.
 *
 * Plan 07 slice 1. `written_forms` is one row per **(volume, written form, guided reading)**: the
 * book's own markup, transcribed. *Volume 9 prints 美味 and guides it with うま.* Nothing more than
 * that sentence says, which is the account owner's rule from plan 07 §5's slice-1 row — **record the
 * words, no character** — written down as a table shape rather than trusted to a caller's restraint.
 *
 * ## Insert-only, and what that rules out
 *
 * A filed row's content columns never change. The table is out of `UPDATABLE_FIELDS` (which belongs to
 * `facts` and is the only update contract in this store), it has no `status`, no `row_version`, no
 * `sealed` flag and no `updated_at`, for the same reason `claim_confirmations` and
 * `cast_identity_links` have none: a row that can never be updated does not need a column that would
 * be null in every row and read by no query. `test/test-written-forms.js` asserts the content columns
 * are identical after a second pass, column by column, rather than asserting "nothing obviously
 * changed".
 *
 * ## What nothing in this repository does with these rows yet
 *
 * **No renderer, no audit rule, no presence matcher, no coverage rule, no chapter-facts query, no
 * validator query and no stage reads this table.** That is not an oversight waiting for a follow-up; it
 * is how the owner's asymmetry — *filing is easy to extend and effectively impossible to undo* — is
 * honoured while the shape is still being argued. The reads below exist for the door itself and for the
 * measurement, and `test/test-written-forms.js` greps the rest of the tree to prove the count is zero.
 *
 * @module utils/reference-store/written-forms/rows
 */

const { collectGuideGroups } = require("../../source/guide-groups");
require("../../../types"); // JSDoc type definitions

/**
 * The joined columns every read selects, in the order the table declares them.
 *
 * Named once so the door's idempotence read and the report's read cannot select different shapes of the
 * same row.
 *
 * @type {string}
 */
const WRITTEN_FORM_COLUMNS =
  "volume, form, reading, reading_script AS readingScript, occurrences, chapters, created_at AS createdAt";

/**
 * Whether this record already holds this exact (volume, form, reading) row.
 *
 * The idempotence question, and the reason a second pass over a volume files 0: the primary key is the
 * rule, this is the read that lets the door report "already filed" instead of failing on it.
 *
 * @param {{db: Object}} store
 * @param {{volume: number|string, form: string, reading: string}} key
 * @returns {Object|null} The stored row with its content columns, or null.
 */
function writtenFormAlreadyFiled(store, { volume, form, reading } = {}) {
  const vol = Number(volume);
  const f = String(form === undefined || form === null ? "" : form);
  const r = String(reading === undefined || reading === null ? "" : reading);
  if (!Number.isInteger(vol) || vol < 1 || !f || !r) return null;
  const row = store.db
    .prepare(`SELECT ${WRITTEN_FORM_COLUMNS} FROM written_forms WHERE volume = ? AND form = ? AND reading = ?`)
    .get(vol, f, r);
  // The same read shape as `writtenFormsInRecord`: a caller must not get a raw JSON cell from one read
  // and a list from the other.
  if (!row) return null;
  return {
    volume: Number(row.volume),
    form: row.form,
    reading: row.reading,
    readingScript: row.readingScript,
    occurrences: Number(row.occurrences),
    chapters: parseChapters(row.chapters),
    createdAt: row.createdAt,
  };
}

/**
 * File one written form one volume printed with one guided reading.
 *
 * Insert-only: no `ON CONFLICT`, no update, no delete. The caller has already asked
 * {@link writtenFormAlreadyFiled} when it wants an idempotent pass; a collision here is a bug in the
 * caller and it throws rather than quietly overwriting a row another volume filed.
 *
 * @param {{db: Object}} store
 * @param {Object} row
 * @param {number|string} row.volume - The volume whose harvest produced this row. **Not** the volume
 *   whose record is being written into: a row is stamped with the book the form was read out of.
 * @param {string} row.form - The written form as the book prints it, guides already removed (gotcha
 *   164: the harvest stores the word guide-free, so this is the same string the evidence rule matches).
 * @param {string} row.reading - The reading the author guided it with.
 * @param {string} row.readingScript - The harvest's own script label for that reading.
 * @param {number} row.occurrences - Times this volume guided this form this way.
 * @param {string[]} [row.chapters] - The segment ids it occurred in, in the order the harvest recorded.
 * @returns {Object} The row as it now stands in the record.
 */
function insertWrittenFormRow(store, row) {
  const vol = Number(row.volume);
  if (!Number.isInteger(vol) || vol < 1) {
    throw new Error(`[reference-store] insertWrittenFormRow: volume "${row.volume}" is not a volume number.`);
  }
  const form = String(row.form || "");
  const reading = String(row.reading || "");
  if (!form || !reading) {
    throw new Error(
      `[reference-store] insertWrittenFormRow: a written-form row needs both the form and the reading it was guided with ` +
        `(got form="${form}" reading="${reading}").`
    );
  }
  const script = String(row.readingScript || "");
  if (!script) {
    throw new Error(
      `[reference-store] insertWrittenFormRow: the row for "${form}" → "${reading}" names no script for its reading, ` +
        "and a row that cannot say how the reading is written is a row a later reader has to guess about."
    );
  }
  const occurrences = Number.isFinite(row.occurrences) ? Number(row.occurrences) : 0;
  const chapters = Array.isArray(row.chapters) ? row.chapters.map((chapter) => String(chapter)) : [];
  store.db
    .prepare(
      "INSERT INTO written_forms (volume, form, reading, reading_script, occurrences, chapters, created_at) VALUES (?,?,?,?,?,?,?)"
    )
    .run(vol, form, reading, script, occurrences, JSON.stringify(chapters), new Date().toISOString());
  return writtenFormAlreadyFiled(store, { volume: vol, form, reading });
}

/**
 * The rows this record holds — all of them, or one volume's.
 *
 * `volume` is the volume the form was **read out of**, so asking for volume 1's rows on volume 17's
 * record returns what volume 1's own harvest recorded, carried forward into this copy. That is the
 * question a later slice asks, and it is answerable only because the table is in `COUNTED_TABLES`.
 *
 * @param {{db: Object, volume: number}} store
 * @param {{volume?: number}} [opts] - Omit for every volume this record carries.
 * @returns {Array<{volume: number, form: string, reading: string, readingScript: string, occurrences: number, chapters: string[], createdAt: string}>}
 */
function writtenFormsInRecord(store, { volume } = {}) {
  const vol = volume === undefined ? null : Number(volume);
  const rows =
    vol === null
      ? store.db.prepare(`SELECT ${WRITTEN_FORM_COLUMNS} FROM written_forms ORDER BY volume, reading, form`).all()
      : store.db
          .prepare(`SELECT ${WRITTEN_FORM_COLUMNS} FROM written_forms WHERE volume = ? ORDER BY reading, form`)
          .all(vol);
  return rows.map((row) => ({
    volume: Number(row.volume),
    form: row.form,
    reading: row.reading,
    readingScript: row.readingScript,
    occurrences: Number(row.occurrences),
    chapters: parseChapters(row.chapters),
    createdAt: row.createdAt,
  }));
}

/**
 * The `chapters` cell, read back as the list it was filed as.
 *
 * A cell that does not parse is reported as **empty and named**, not repaired: a row whose chapter list
 * is unreadable still records the form and the reading, and silently substituting `[]` would make a
 * damaged cell look like a form that occurred in no chapter.
 *
 * @param {string} raw
 * @returns {{chapters: string[], unreadable: boolean}}
 */
function parseChaptersCell(raw) {
  if (raw === null || raw === undefined || raw === "") return { chapters: [], unreadable: false };
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { chapters: [], unreadable: true };
    return { chapters: parsed.map((chapter) => String(chapter)), unreadable: false };
  } catch {
    return { chapters: [], unreadable: true };
  }
}

/**
 * The plain-list half of {@link parseChaptersCell}, for the reads that only want the list.
 *
 * @param {string} raw
 * @returns {string[]}
 */
function parseChapters(raw) {
  return parseChaptersCell(raw).chapters;
}

/**
 * How many rows this record holds, per volume, and what they add up to.
 *
 * Reported as **data, not a finding**: a volume whose harvest produced no candidate group is a volume
 * that guided no reading over two written forms, which is a fact about that book. Plan 07 slice 1 files
 * nothing and punishes nothing for it.
 *
 * @param {{db: Object, volume: number}} store
 * @param {{volume?: number}} [opts] - Defaults to the record's own volume.
 * @returns {{total: number, thisVolume: number, distinctForms: number, distinctReadings: number, occurrences: number, perVolume: Object<string, number>}}
 */
function writtenFormCounts(store, { volume } = {}) {
  const vol = Number(volume === undefined ? store.volume : volume);
  const total = store.db.prepare("SELECT COUNT(*) AS n FROM written_forms").get().n;
  const thisVolume = store.db
    .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(occurrences), 0) AS occurrences FROM written_forms WHERE volume = ?")
    .get(vol);
  const distinct = store.db
    .prepare("SELECT COUNT(DISTINCT form) AS forms, COUNT(DISTINCT reading) AS readings FROM written_forms")
    .get();
  const occurrences = store.db.prepare("SELECT COALESCE(SUM(occurrences), 0) AS n FROM written_forms").get().n;
  /** @type {Object<string, number>} */
  const perVolume = {};
  for (const row of store.db
    .prepare("SELECT volume, COUNT(*) AS n FROM written_forms GROUP BY volume ORDER BY volume")
    .all()) {
    perVolume[String(row.volume)] = Number(row.n);
  }
  return {
    total: Number(total),
    thisVolume: Number(thisVolume.n),
    distinctForms: Number(distinct.forms),
    distinctReadings: Number(distinct.readings),
    occurrences: Number(occurrences),
    perVolume,
  };
}

/**
 * The candidate groups this record's own rows describe, rebuilt by **the shipped grouping rule itself**.
 *
 * **This is the read a later slice asks**, and it exists because the grouping rule is not decomposable
 * per volume: "one reading printed over two or more written forms" is a question about a **set**, and a
 * volume that guided 月見 with つきみ cannot know that another book guided 草見月 with the same reading.
 * Each volume files only its own harvest (plan 07 §5's slice-1 rule, and the no-forward-leak rule the
 * account owner set), so the group question is answered here, over the rows the copy-forward carried —
 * which can only ever be this volume's and earlier ones'.
 *
 * It is not a second implementation of the fold. The rows are handed back to
 * `utils/source/guide-groups.js`'s `collectGuideGroups` in the same shape the harvest file holds them
 * (`word` / `reading` / `count` / `chapters` / `readingScript`), so the door that files and the query that
 * groups **cannot** drift into two different definitions of a candidate — which is the failure mode
 * `utils/reference-store/drafting.js` and the two reading passes were each built to avoid. The totals
 * returned are that module's own `GuideGroupTotals`, field for field.
 *
 * @param {{db: Object, volume: number}} store
 * @param {{upToVolume?: number}} [opts] - Defaults to the record's own volume, which is the furthest
 *   any volume is allowed to look.
 * @returns {{groups: import("../../source/guide-groups").GuideGroup[], totals: import("../../source/guide-groups").GuideGroupTotals}}
 */
function candidateGroupsInRecord(store, { upToVolume } = {}) {
  const ceiling = Number(upToVolume === undefined ? store.volume : upToVolume);
  const rows =
    store.db
      .prepare(`SELECT ${WRITTEN_FORM_COLUMNS} FROM written_forms WHERE volume <= ? ORDER BY volume, reading, form`)
      .all(ceiling)
      .map((row) => ({
        volume: Number(row.volume),
        word: row.form,
        reading: row.reading,
        readingScript: row.readingScript,
        count: Number(row.occurrences),
        chapters: parseChapters(row.chapters),
      }));
  /** @type {Map<string, Array<Object>>} */
  const byVolume = new Map();
  for (const row of rows) {
    const label = String(row.volume);
    if (!byVolume.has(label)) byVolume.set(label, []);
    byVolume.get(label).push(row);
  }
  const harvests = [...byVolume.entries()]
    .sort((a, b) => compareVolumeLabels(a[0], b[0]))
    .map(([volume, guides]) => ({ volume, guides }));
  const built = collectGuideGroups(harvests, { displaySubset: false });
  return { groups: built.groups, totals: built.totals };
}

/**
 * Volume labels sort in book order whether they arrived as "01" or 1.
 *
 * The same helper `utils/source/guide-groups.js` uses for the same reason, restated here because the
 * two must agree and the function is three lines: importing it would make a formatting helper part of
 * the shared surface between the source layer and the store.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareVolumeLabels(a, b) {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

module.exports = {
  WRITTEN_FORM_COLUMNS,
  writtenFormAlreadyFiled,
  insertWrittenFormRow,
  writtenFormsInRecord,
  parseChaptersCell,
  parseChapters,
  writtenFormCounts,
  candidateGroupsInRecord,
};
