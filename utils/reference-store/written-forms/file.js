/**
 * utils/reference-store/written-forms/file.js — the door that files one volume's written forms.
 *
 * Plan 07 slice 1, **widened to the scope the account owner chose in §6.7 (2026-10-15)**. The door reads
 * **one volume's own pronunciation-guide harvest** — the file the extraction writes beside the bundle since
 * gotcha 123 fixed the guide-split defect, one row per (word, reading) pair, 10,005 rows and 45,429
 * occurrences across the 17 real books — and files **every harvested row that passes the two *row* guards**:
 * the guided reading is at least `GUIDE_GROUP_MIN_READING_CHARS` characters long, and the reading shares no
 * character with the written form. Each filed row is one `written_forms` row: this volume printed this form,
 * the author guided it with this reading, this many times, in these chapters.
 *
 * ## Filing is judgement-free; grouping is a read
 *
 * The door applies **two** of `utils/source/guide-groups.js`'s four guards — the two that are facts about a
 * single (form, reading) pair — and **none** of the two that are facts about a **set**: "2+ distinct written
 * forms carry this reading" (`GUIDE_GROUP_MIN_FORMS`) and "at least one of them is 2+ characters long"
 * (`GUIDE_GROUP_MIN_FORM_CHARS`). Those two stay exactly where slice 0 measured them, in the reader and in
 * `rows.js`'s `candidateGroupsInRecord`, and they **stop deciding what gets filed**.
 *
 * The reason is the owner's, and it is the reason this shape exists rather than the narrower one slice 1
 * first built: **the grouping guards are arguable, and they already carry a measured false negative.** しば ←
 * 芝 x416 / 縛 x10 is dropped by the "at least one form 2+ characters" rule, and 芝 is a name the published
 * record already holds (plan 07 §2.7). A door that applies an arguable judgement **when it files** is a door
 * that makes that judgement impossible to widen later — the rows it never wrote are not in the table to be
 * re-read by a better rule. Filing stays per-volume and judgement-free; grouping is a read, and a read can be
 * re-asked. Measured on the 17 real books: the two row guards keep **8,910 of 10,005 rows** (1,084 dropped
 * for a one-character reading, 10 for a reading that reuses a character of its own word, 1 skipped for
 * naming no written form at all), and regrouping those rows through the shipped fold reproduces §2.2's
 * **97 groups / 222 written forms / 634 rows / 8,734 occurrences** exactly.
 *
 * **The row guards are the reader's own, not a copy of them.** `GUIDE_GROUP_MIN_READING_CHARS` and
 * `readingSharesNoCharacterWithForm` are imported from `utils/source/guide-groups.js`, and `normalizeSpaces`
 * is the same normaliser `foldVolumeHarvest` runs each row through, so the rows the door writes are the rows
 * the reader would have grouped — `test/test-written-forms.js` asserts the two tallies agree field for field.
 *
 * ## What the door asserts, and what it refuses to assert
 *
 * **It files no identity.** Plan 07 §5's slice-1 row is the account owner's rule: the roster-or-reading claim
 * that says two written forms are one person belongs to slice 2, and it covers 18 of the 97 groups. This door
 * files the forms of the 18 **and** of the 79 the roster cannot see, including the pronoun-and-description
 * groups the owner answered with *"record the words, no character"*. Filing a form is transcribing markup;
 * filing a person is a claim, and the claim needs the identity table, which this layer does not require and
 * does not write.
 *
 * **It reports the roster's answer without acting on it.** `splitGroupsByRoster` and
 * `classifyUnselectedGroups` run on every pass and their numbers come back in the result, because plan 07
 * §2.9's 18 / 79 and §2.10's 25 / 54 are only meaningful next to the pass that produced them. Both are
 * computed over the **groups the fold derives**, never over the rows the door filed — a filed row is not a
 * candidate group, and a report that counted filed rows as groups would be counting a different thing than
 * the plan's numbers describe. Nothing is filed *because* of either split, and neither one is a finding: the
 * 54 sound-alike groups are ordinary homophones the author chose to gloss, and a rule that called them
 * defects would cry wolf 54 times over 17 legitimate books.
 *
 * ## Why it reads only its own volume, and refuses anything later
 *
 * The account owner's asymmetry (plan 07 §4.4) is that **voice never looks forward**: a volume's record is
 * built from that volume and the volumes before it, so the snapshot an earlier volume published stays
 * byte-identical no matter what a later book turns out to say. A door that filed volume 9's markup into
 * volume 4's record would break that, and it would do it silently. So the volume is checked *before*
 * anything is read (`written-forms-cannot-look-forward`), and the harvest is read out of the volume folder
 * the store itself resolved — there is no path through this door to another volume's book.
 *
 * **And the widening is what makes that rule survivable.** §2.13 measured that filing only each volume's
 * *candidate groups* reaches 57 groups / 240 rows across the 17 books against the 97 / 634 the whole-series
 * fold measures, because three of the 18 identity-bearing groups (ホース, ミント, つきみ) are never a
 * candidate group in any single book — their second written form appears in a **later** one. Under the widened
 * scope each volume files its own eligible rows and nothing else, so the no-forward rule is untouched, and
 * the group appears anyway: the rows travel forward through copy-forward (`written_forms` is in
 * `COUNTED_TABLES`), and `candidateGroupsInRecord` re-derives the group over the rows the copy carries. The
 * door never has to look forward to file; only the read does.
 *
 * ## No seal guard, and that is the owner's answer, not a borrowed one
 *
 * Plan 07 §2b (2026-10-15): **no seal on a written-forms row**, because *"future volumes won't be touching
 * this volume's copy"* — a later volume works in its own copy, so a seal on a row that reaches no published
 * file protects nothing. Same reasoning `identity/file.js` already gives: `castAlias` refuses to merge on a
 * sealed record because a merge re-points rows the record already published, and filing a written-forms row
 * re-points nothing — no renderer, audit rule, presence matcher, coverage rule or chapter-facts query reads
 * this table (plan 07 slice 1's acceptance line, and `test/test-written-forms.js` greps the tree to prove
 * the count is zero). A row that reaches nothing published cannot damage what a seal protects. **The door
 * is now called by the pipeline** (plan 09 slice 3a, `pipeline-store.js`), and that changes who *writes*
 * rows, not who reads them: nothing published reads this table yet, which is what the next slice changes.
 *
 * ## Idempotence
 *
 * The primary key is the rule: (volume, form, reading). A second pass over the same volume asks
 * `writtenFormAlreadyFiled` first and files 0, which is what makes the door safe to re-run and what
 * plan 07 §5's acceptance line asks for. A collision that the read did not predict throws rather than
 * overwriting a row another volume filed.
 *
 * ## The door is synchronous, and that is what lets the pipeline reach it (plan 09 slice 3a)
 *
 * Plan 07 §6 item 3 — *who runs this door* — was answered on 2026-10-16 by the account owner's decision
 * to reuse `written_forms` for the glossary's readings, and the answer is: **`openVolumeRecord` does**,
 * through `pipeline-store.js`'s `ensureVolumeWrittenFormsInRecord`, the same door
 * `ensureVolumeGlossaryInRecord` sits in (gotcha 103). That door is synchronous — every stage opens a
 * record from synchronous code — so this one had to become synchronous too. Its only asynchronous step
 * ever was reading one JSON file, and `readHarvestDocument` above is why the read now lives here rather
 * than in a promise-returning helper the caller could not wait for. Every existing caller `await`s this
 * function and still works; nothing about what it files, refuses or reports changed.
 *
 * @module utils/reference-store/written-forms/file
 */

const fs = require("fs");
const path = require("path");

const { refusal } = require("../refusals");
const { RUBY_GUIDE_FILE_SUFFIX } = require("../../source/ruby-guides");
const { normalizeSpaces } = require("../../source/html");
const {
  GUIDE_GROUP_MIN_READING_CHARS,
  collectGuideGroups,
  readingSharesNoCharacterWithForm,
} = require("../../source/guide-groups");
const { splitGroupsByRoster, classifyUnselectedGroups, describeGroupForReport } = require("./shapes");
const { writtenFormAlreadyFiled, insertWrittenFormRow, writtenFormCounts } = require("./rows");
require("../../../types"); // JSDoc type definitions

/**
 * The roster this record holds, as a set of names.
 *
 * The only roster a volume is allowed to ask. `cast` is what this volume's own record published plus
 * what copy-forward carried from the volumes before it, so the question "does this record already know
 * this name as an entry" is answerable without looking at any later volume.
 *
 * @param {{db: Object}} store
 * @returns {Set<string>}
 */
function rosterKeysInRecord(store) {
  return new Set(store.db.prepare("SELECT key FROM cast").all().map((row) => row.key));
}

/**
 * The pronunciation-guide harvest files one volume's folder holds.
 *
 * The extraction names the file `<base>-ruby-guides.json` after the volume's source archive, and the
 * store does not know the base name — so the folder is scanned for the suffix and the base is read back
 * out of the name. A volume with no harvest (a plain-text book, or one extracted before the harvest
 * existed) is **named**, not treated as an empty harvest: the read answers "there is no file here" with
 * null, and a reader that turns that into zero rows reports a zero it did not measure.
 *
 * @param {string} volumeDir - The volume folder the store resolved.
 * @returns {{files: Array<{file: string, base: string}>, error: string|null}}
 */
function writtenFormHarvestFiles(volumeDir) {
  let names;
  try {
    names = fs.readdirSync(volumeDir);
  } catch (err) {
    return { files: [], error: `cannot read ${volumeDir}: ${String(err && err.message ? err.message : err)}` };
  }
  const files = [];
  for (const name of names.sort()) {
    if (!name.endsWith(RUBY_GUIDE_FILE_SUFFIX)) continue;
    files.push({ file: name, base: name.slice(0, name.length - RUBY_GUIDE_FILE_SUFFIX.length) });
  }
  return { files, error: files.length ? null : `no ${RUBY_GUIDE_FILE_SUFFIX} file in ${volumeDir}` };
}

/**
 * One harvest file's `guides` array, read straight out of the volume folder.
 *
 * **Why this door reads the file itself instead of calling `utils/source/ruby-guides.js`'s reader.**
 * That reader is promise-based, and this door is now reached from `openVolumeRecord`, which is
 * synchronous — every stage that opens a record calls it from synchronous code, and making the open
 * async would rewrite twenty call sites to service one file read. `test/test-written-forms.js`
 * scenario 12 pins that **this file** is the only door inside `utils/reference-store/` allowed to open
 * a harvest, so the synchronous read belongs here rather than in a second reader added to the source
 * layer (which would be a second door by another name). The contract is the shipped reader's, kept
 * field for field: parse the JSON, require a `guides` **array**, and answer `null` for anything else —
 * including a file that is there but unreadable, which the caller reports rather than files.
 *
 * @param {string} volumeDir - The volume folder.
 * @param {string} file - The harvest file's name, as `writtenFormHarvestFiles` found it.
 * @returns {{guides: Array<Object>}|null} The harvest, or null when the file is not a readable harvest.
 */
function readHarvestDocument(volumeDir, file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(volumeDir, file), "utf8"));
  } catch {
    return null;
  }
  if (!parsed || !Array.isArray(parsed.guides)) return null;
  return parsed;
}

/**
 * Read one volume's harvest into the shape `collectGuideGroups` folds.
 *
 * Synchronous, for the reason given on {@link readHarvestDocument}. A volume with no harvest is reported
 * in `missing`, and a file that is there but does not parse is reported in `errors` — neither is folded
 * into the filing as an empty harvest.
 *
 * @param {string} volumeDir - The volume folder the store resolved.
 * @param {number} volume - The volume label to stamp on the harvest, so the fold can date each form.
 * @returns {{harvests: Array<{volume: number, guides: Array<Object>, file: string}>, missing: string[], errors: Array<{file: string, error: string}>}}
 */
function readWrittenFormHarvest(volumeDir, volume) {
  const { files, error } = writtenFormHarvestFiles(volumeDir);
  /** @type {Array<{volume: number, guides: Array<Object>, file: string}>} */
  const harvests = [];
  /** @type {Array<{file: string, error: string}>} */
  const errors = [];
  for (const entry of files) {
    const harvest = readHarvestDocument(volumeDir, entry.file);
    if (!harvest) {
      errors.push({ file: entry.file, error: "the file is there and its `guides` array is not readable" });
      continue;
    }
    harvests.push({ volume: Number(volume), guides: harvest.guides, file: entry.file });
  }
  return { harvests, missing: error ? [String(volume)] : [], errors };
}

/**
 * The script label for one group's guided reading.
 *
 * The harvest's own label is used when the fold carried one, because that label is what the extraction
 * wrote (`aggregateRubyGuides` stamps every row with `readingScriptOf(reading)`). A group carrying more
 * than one label for one reading string is reported rather than settled by list order — the harvest
 * cannot produce one today, and a door that picked silently would be a door that hid a contradiction.
 *
 * @param {{reading: string, readingScripts?: string[]}} group
 * @returns {{readingScript: string, ambiguous: boolean}}
 */
function scriptOfGroup(group) {
  const scripts = (group && Array.isArray(group.readingScripts) ? group.readingScripts : []).filter(Boolean);
  if (scripts.length === 1) return { readingScript: scripts[0], ambiguous: false };
  if (scripts.length > 1) return { readingScript: scripts.slice().sort()[0], ambiguous: true };
  return { readingScript: "", ambiguous: false };
}

/**
 * @typedef {Object} WrittenFormFilingTally
 * What the door's **two row guards** saw, counted per guard, so the widened scope is re-readable rather
 * than remembered. The two *group* guards are not here and must never be: they decide nothing about filing.
 * @property {number} harvestRows           — Rows read out of this volume's harvest, every one counted.
 * @property {number} rowsSkippedWithoutWordOrReading — Rows naming no written form or no reading: counted, never filed.
 *   (the same name `GuideGroupTotals` gives the same count, so the door's tally and the reader's tally read
 *   as one vocabulary and `test/test-written-forms.js` can assert they agree)
 * @property {number} rowsDroppedByReadingLength — Rows whose reading is shorter than `GUIDE_GROUP_MIN_READING_CHARS`.
 * @property {number} rowsDroppedBySharedCharacter — Rows whose reading shares a character with the written form.
 * @property {number} rowsEligible          — Rows that passed both row guards.
 * @property {number} rowsMerged            — Eligible rows that shared a (form, reading) key and were summed rather than filed twice.
 * @property {number} rowsToFile            — Distinct (form, reading) keys the door will file.
 * @property {number} distinctReadings      — Distinct guided readings among them.
 * @property {number} distinctForms         — Distinct written forms among them.
 * @property {number} occurrences           — Guided occurrences summed over the rows to file.
 */

/**
 * The rows one volume's harvest yields **under the two row guards only**, merged per (form, reading).
 *
 * This is the widened filing set (plan 07 §6.7). It is deliberately **not** a group list: a row is filed
 * whatever group it would or would not have joined, so the arguable set-level guards in
 * `utils/source/guide-groups.js` cannot silently decide what the record gets to know. The two row guards
 * applied here are that module's own constant and its own predicate, and the normalisation is its own
 * `normalizeSpaces`, so the door and the reader cannot disagree about what an eligible row is.
 *
 * Merging on (form, reading) is what keeps a harvest that lists one pair twice from doubling a count — the
 * same protection `foldVolumeHarvest` gives the fold — and it is also what makes the door's output match the
 * table's primary key one-for-one.
 *
 * @param {Array<Object>} harvestRows - One volume's `guides` array, in the shape `utils/source/ruby-guides.js` writes it.
 * @returns {{rows: Array<{form: string, reading: string, readingScript: string, ambiguousScript: boolean, occurrences: number, chapters: string[]}>, tally: WrittenFormFilingTally, missingScriptRows: Array<{form: string, reading: string}>, ambiguousScripts: string[]}}
 *   `missingScriptRows` names the rows that carry no script label for their reading — refused rather than
 *   filed half — and `ambiguousScripts` the readings that arrive under more than one label.
 */
function eligibleWrittenFormRows(harvestRows) {
  /** @type {Map<string, {form: string, reading: string, scripts: Set<string>, occurrences: number, chapters: string[]}>} */
  const byKey = new Map();
  const tally = {
    harvestRows: 0,
    rowsSkippedWithoutWordOrReading: 0,
    rowsDroppedByReadingLength: 0,
    rowsDroppedBySharedCharacter: 0,
    rowsEligible: 0,
    rowsMerged: 0,
    rowsToFile: 0,
    distinctReadings: 0,
    distinctForms: 0,
    occurrences: 0,
  };
  /** @type {Array<{form: string, reading: string}>} */
  const missingScriptRows = [];

  for (const row of Array.isArray(harvestRows) ? harvestRows : []) {
    tally.harvestRows += 1;
    // The same normalisation the fold runs, so a filed row and a grouped row are the same string.
    const form = normalizeSpaces(row && row.word);
    const reading = normalizeSpaces(row && row.reading);
    if (!form || !reading) {
      tally.rowsSkippedWithoutWordOrReading += 1;
      continue;
    }
    if (reading.length < GUIDE_GROUP_MIN_READING_CHARS) {
      tally.rowsDroppedByReadingLength += 1;
      continue;
    }
    if (!readingSharesNoCharacterWithForm(reading, form)) {
      tally.rowsDroppedBySharedCharacter += 1;
      continue;
    }
    tally.rowsEligible += 1;

    const key = `${form}\u0000${reading}`;
    let entry = byKey.get(key);
    if (entry) tally.rowsMerged += 1;
    else {
      entry = { form, reading, scripts: new Set(), occurrences: 0, chapters: [] };
      byKey.set(key, entry);
    }
    entry.occurrences += Number.isFinite(row && row.count) ? Number(row.count) : 0;
    if (row && row.readingScript) entry.scripts.add(String(row.readingScript));
    for (const chapter of (row && Array.isArray(row.chapters)) ? row.chapters : []) {
      if (chapter && !entry.chapters.includes(chapter)) entry.chapters.push(chapter);
    }
  }

  // Reading, then form: the same order `writtenFormsInRecord` reads the rows back in, so the filing log
  // and the record's own read cannot look like two different passes.
  const merged = [...byKey.values()].sort(
    (a, b) =>
      a.reading < b.reading ? -1 : a.reading > b.reading ? 1 : a.form < b.form ? -1 : a.form > b.form ? 1 : 0
  );

  /** @type {Array<{form: string, reading: string, readingScript: string, ambiguousScript: boolean, occurrences: number, chapters: string[]}>} */
  const rows = [];
  /** @type {string[]} */
  const ambiguousScripts = [];
  for (const entry of merged) {
    const scripts = [...entry.scripts].sort();
    if (scripts.length === 0) {
      missingScriptRows.push({ form: entry.form, reading: entry.reading });
      continue;
    }
    if (scripts.length > 1) ambiguousScripts.push(entry.reading);
    rows.push({
      form: entry.form,
      reading: entry.reading,
      readingScript: scripts[0],
      ambiguousScript: scripts.length > 1,
      occurrences: entry.occurrences,
      chapters: entry.chapters.slice(),
    });
  }

  tally.rowsToFile = rows.length;
  tally.distinctReadings = new Set(rows.map((row) => row.reading)).size;
  tally.distinctForms = new Set(rows.map((row) => row.form)).size;
  tally.occurrences = rows.reduce((sum, row) => sum + row.occurrences, 0);
  return { rows, tally, missingScriptRows, ambiguousScripts: [...new Set(ambiguousScripts)].sort() };
}

/**
 * File one volume's written forms into the record this store has open.
 *
 * Every harvested row that passes the two **row** guards is filed, whatever group it would or would not
 * have joined (plan 07 §6.7, the account owner's answer). The two **group** guards stay in
 * `utils/source/guide-groups.js` and in `rows.js`'s `candidateGroupsInRecord`, and they decide nothing here.
 *
 * @param {Object} store - The store context from `openReferenceStore` / `openVolumeRecord`.
 * @param {Object} [opts]
 * @param {number} [opts.volume] - The volume whose harvest is being read. Defaults to this store's volume.
 * @param {Array<{volume: number, guides: Array<Object>}>} [opts.harvests] - Pre-read harvests, for a
 *   caller that already holds them (the measurement scripts). Every one must belong to this volume or an
 *   earlier one; a later volume is refused by name.
 * @returns {{ok: boolean, volume: number, harvestFiles: string[], harvestMissing: boolean, harvestErrors: Array<Object>, harvestReadError: string|null, filing: WrittenFormFilingTally, totals: Object, candidateGroups: number, candidateForms: number, candidateRows: number, candidateOccurrences: number, identityBearing: {groups: number, rows: number, occurrences: number, readings: string[]}, unselected: {groups: number, rows: number, occurrences: number, spellingVariants: number, soundAlikes: number}, spellingVariantGroups: Array<Object>, soundAlikeGroups: Array<Object>, ambiguousReadingScripts: string[], harvestVolumesIgnored: number[], formsFiled: Array<Object>, rowsFiled: number, rowsAlreadyFiled: number, counts: Object, refusal: ReferenceRefusal|null}}
 */
function fileVolumeWrittenForms(store, { volume, harvests } = {}) {
  const vol = Number(volume === undefined ? store.volume : volume);
  const empty = {
    harvestFiles: [],
    harvestMissing: false,
    harvestErrors: [],
    harvestReadError: null,
    filing: null,
    totals: null,
    candidateGroups: 0,
    candidateForms: 0,
    candidateRows: 0,
    candidateOccurrences: 0,
    identityBearing: { groups: 0, rows: 0, occurrences: 0, readings: [] },
    unselected: { groups: 0, rows: 0, occurrences: 0, spellingVariants: 0, soundAlikes: 0 },
    spellingVariantGroups: [],
    soundAlikeGroups: [],
    ambiguousReadingScripts: [],
    harvestVolumesIgnored: [],
    formsFiled: [],
    rowsFiled: 0,
    rowsAlreadyFiled: 0,
  };

  if (!Number.isInteger(vol) || vol < 1) {
    return {
      ...empty,
      volume: vol,
      counts: null,
      refusal: refusal({
        verb: "file_written_forms",
        rule: "written-forms-volume-undecided",
        because: `"${volume}" is not a volume number, and a written form has to be filed under the volume whose book printed it.`,
        fix: "fileVolumeWrittenForms(store, { volume: 3 })",
      }),
    };
  }
  // The no-forward rule, asked before anything is read. A record is what this volume and the volumes
  // before it measured; filing a later book's markup into it would rewrite what an earlier snapshot
  // published, which is the asymmetry plan 07 §4.4 exists to keep. The widening does not soften this:
  // a volume files its OWN eligible rows and nothing else, and the group that needs two books is
  // recovered later by the read, not by looking ahead here.
  if (Number.isInteger(store.volume) && vol > Number(store.volume)) {
    return {
      ...empty,
      volume: vol,
      counts: null,
      refusal: refusal({
        verb: "file_written_forms",
        rule: "written-forms-cannot-look-forward",
        because:
          `this record is volume ${store.volume}, and volume ${vol}'s book has not been read by it. A written form is ` +
          "filed under the volume that printed it, and a volume's record is built from that volume and the ones before it " +
          "(plan 07 §4.4): filing forward would change what an earlier volume already published.",
        fix: `open the record for volume ${vol} and file its own harvest, or file volume ${vol}'s forms into it from that volume's own pass.`,
        detail: { recordVolume: Number(store.volume), askedVolume: vol },
      }),
    };
  }

  /** @type {Array<{volume: number, guides: Array<Object>}>} */
  let read = [];
  let harvestFiles = [];
  let harvestMissing = false;
  /** @type {Array<{file: string, error: string}>} */
  let harvestErrors = [];
  let harvestReadError = null;

  if (harvests === undefined) {
    const fromDisk = readWrittenFormHarvest(store.volumeDir, vol);
    read = fromDisk.harvests;
    harvestFiles = fromDisk.harvests.map((harvest) => harvest.file);
    harvestMissing = fromDisk.missing.length > 0;
    harvestErrors = fromDisk.errors;
    harvestReadError = fromDisk.missing.length ? `no ${RUBY_GUIDE_FILE_SUFFIX} file in ${store.volumeDir}` : null;
  } else {
    read = (Array.isArray(harvests) ? harvests : []).map((harvest) => ({
      volume: Number.isInteger(Number(harvest && harvest.volume)) ? Number(harvest.volume) : vol,
      guides: (harvest && harvest.guides) || [],
    }));
    const forward = read.filter((harvest) => harvest.volume > vol).map((harvest) => harvest.volume);
    if (forward.length) {
      return {
        ...empty,
        volume: vol,
        counts: null,
        refusal: refusal({
          verb: "file_written_forms",
          rule: "written-forms-cannot-look-forward",
          because:
            `the harvests handed to this pass include volume(s) ${forward.join(", ")}, which are later than volume ${vol}. ` +
            "A volume's written forms come from that volume's own harvest and the ones before it (plan 07 §4.4).",
          fix: `hand it only the harvests of volumes 1–${vol}, or run the door for the later volume itself.`,
          detail: { askedVolume: vol, forwardVolumes: forward },
        }),
      };
    }
  }

  const own = read.filter((harvest) => harvest.volume === vol);
  const ignoredVolumes = [...new Set(read.filter((harvest) => harvest.volume !== vol).map((harvest) => harvest.volume))].sort(
    (a, b) => a - b
  );
  const ownRows = own.flatMap((harvest) => (harvest.guides && harvest.guides) || []);

  // ── What gets filed: the two row guards, and nothing else. ───────────────────────────────────────
  const { rows, tally, missingScriptRows, ambiguousScripts } = eligibleWrittenFormRows(ownRows);

  // ── What gets reported: the shipped grouping fold, over the same rows. ───────────────────────────
  // The fold is the ONLY place the two group guards are applied to this volume's rows, and it decides
  // nothing here. It runs so the roster's answer (plan 07 §2.9) and the 25 / 54 split (§2.10) can be
  // printed beside the pass that produced them — as data, over the GROUPS the fold derives, never over
  // the rows the door filed.
  const folded = collectGuideGroups(own, { displaySubset: false });
  const roster = rosterKeysInRecord(store);
  const split = splitGroupsByRoster(folded.groups, roster);
  const unselectedReport = classifyUnselectedGroups(split.unselected);
  const ambiguousReadingScripts = [...new Set([...ambiguousScripts, ...folded.groups.filter((group) => scriptOfGroup(group).ambiguous).map((group) => group.reading)])].sort();

  /** @type {Array<Object>} */
  const formsFiled = [];
  let rowsFiled = 0;
  let rowsAlreadyFiled = 0;

  store.db.exec("BEGIN");
  try {
    // A row whose reading carries no script label is **refused, not filed half**: a row that cannot say
    // how its reading is written is a row a later reader has to guess about, and guessing is how a
    // script-neutral table quietly stops being one. It throws, so the whole pass rolls back rather than
    // publishing a volume whose filing is part-finished.
    if (missingScriptRows.length) {
      throw new Error(
        `[reference-store] fileVolumeWrittenForms: ${missingScriptRows.length} written form(s) in volume ${vol} carry no script label for ` +
          `their reading (first: "${missingScriptRows[0].form}" → "${missingScriptRows[0].reading}"), and a row that cannot say how its ` +
          "reading is written is a row a later reader has to guess about."
      );
    }
    for (const row of rows) {
      const existing = writtenFormAlreadyFiled(store, { volume: vol, form: row.form, reading: row.reading });
      if (existing) {
        rowsAlreadyFiled += 1;
        continue;
      }
      insertWrittenFormRow(store, {
        volume: vol,
        form: row.form,
        reading: row.reading,
        readingScript: row.readingScript,
        occurrences: row.occurrences,
        chapters: row.chapters,
      });
      rowsFiled += 1;
      formsFiled.push({
        form: row.form,
        reading: row.reading,
        readingScript: row.readingScript,
        occurrences: row.occurrences,
        chapters: row.chapters.slice(),
      });
    }
    store.db.exec("COMMIT");
  } catch (err) {
    store.db.exec("ROLLBACK");
    throw err;
  }

  return {
    ok: true,
    volume: vol,
    harvestFiles,
    harvestMissing,
    harvestErrors,
    harvestReadError,
    filing: tally,
    totals: folded.totals,
    candidateGroups: folded.totals.candidateGroups,
    candidateForms: folded.totals.candidateForms,
    candidateRows: folded.totals.candidateRows,
    candidateOccurrences: folded.totals.candidateOccurrences,
    identityBearing: {
      groups: split.totals.identityBearing,
      rows: split.totals.identityBearingRows,
      occurrences: split.totals.identityBearingOccurrences,
      readings: split.identityBearing.map((group) => group.reading),
    },
    unselected: {
      groups: split.totals.unselected,
      rows: split.totals.unselectedRows,
      occurrences: split.totals.unselectedOccurrences,
      spellingVariants: unselectedReport.totals.spellingVariants,
      soundAlikes: unselectedReport.totals.soundAlikes,
    },
    spellingVariantGroups: unselectedReport.spellingVariants.map(describeGroupForReport),
    soundAlikeGroups: unselectedReport.soundAlikes.map(describeGroupForReport),
    ambiguousReadingScripts,
    harvestVolumesIgnored: ignoredVolumes,
    formsFiled,
    rowsFiled,
    rowsAlreadyFiled,
    counts: writtenFormCounts(store, { volume: vol }),
    refusal: null,
  };
}

module.exports = {
  rosterKeysInRecord,
  writtenFormHarvestFiles,
  readHarvestDocument,
  readWrittenFormHarvest,
  scriptOfGroup,
  eligibleWrittenFormRows,
  fileVolumeWrittenForms,
};
