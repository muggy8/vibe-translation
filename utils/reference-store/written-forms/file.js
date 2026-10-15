/**
 * utils/reference-store/written-forms/file.js — the door that files one volume's candidate written forms.
 *
 * Plan 07 slice 1. The door reads **one volume's own pronunciation-guide harvest** — the file the
 * extraction writes beside the bundle since gotcha 123 fixed the guide-split defect, one row per
 * (word, reading) pair, 10,005 rows and 45,429 occurrences across the 17 real books, and read by
 * nothing at all until this slice — folds it into candidate groups with the shipped rule
 * (`utils/source/guide-groups.js`), and files each written form inside each candidate group as one
 * `written_forms` row: this volume printed this form, the author guided it with this reading, this many
 * times, in these chapters.
 *
 * ## What the door asserts, and what it refuses to assert
 *
 * **It files no identity.** Plan 07 §5's slice-1 row is the account owner's rule: the roster-or-reading
 * claim that says two written forms are one person belongs to slice 2, and it covers 18 of the 97
 * groups. This door files all candidate groups — the 18 the roster selects **and** the 79 it cannot see,
 * including the six pronoun-and-description groups the owner answered with *"record the words, no
 * character"*. Filing a group is transcribing markup; filing a person is a claim, and the claim needs
 * the identity table, which this layer does not require and does not write.
 *
 * **It reports the roster's answer without acting on it.** `splitGroupsByRoster` and
 * `classifyUnselectedGroups` run on every pass and their numbers come back in the result, because plan
 * 07 §2.9's 18 / 79 and §2.10's 25 / 54 are only meaningful next to the pass that produced them. Nothing
 * is filed *because* of either split, and neither one is a finding: the 54 sound-alike groups are
 * ordinary homophones the author chose to gloss, and a rule that called them defects would cry wolf 54
 * times over 17 legitimate books.
 *
 * ## Why it reads only its own volume, and refuses anything later
 *
 * The account owner's asymmetry (plan 07 §4.4) is that **voice never looks forward**: a volume's record
 * is built from that volume and the volumes before it, so the snapshot an earlier volume published stays
 * byte-identical no matter what a later book turns out to say. A door that filed volume 9's markup into
 * volume 4's record would break that, and it would do it silently. So the volume is checked *before*
 * anything is read (`written-forms-cannot-look-forward`), and the harvest is read out of the volume
 * folder the store itself resolved — there is no path through this door to another volume's book.
 *
 * **The consequence is measured and reported, not hidden:** "one reading printed over two or more
 * written forms" is a question about a **set**, and it is not decomposable per volume. Folding each
 * volume's own harvest alone produces 57 groups / 240 rows across the 17 real books; folding all 17
 * together produces the 97 groups / 634 rows plan 07 §2.2 measures. The 40 groups that only exist in the
 * union are groups whose second written form appears in a **later** book (つきみ ← 月見 in volume 4 and
 * 草見月 in volume 11). This door cannot see them, by the owner's own rule. `candidateGroupsInRecord` in
 * `rows.js` is the read that answers the question over the rows the copy-forward carried — which can only
 * ever be this volume's and earlier ones' — and the widening decision is written up in
 * `/tmp/opencode/plan07-slice1-questions.md` rather than made here.
 *
 * ## No seal guard, and that is deliberate
 *
 * Same reasoning as `identity/file.js`: `castAlias` refuses to merge on a sealed record because a merge
 * re-points rows the record already published. Filing a written-forms row re-points nothing — no
 * renderer, audit rule, presence matcher, coverage rule, chapter-facts query or stage reads this table
 * (plan 07 slice 1's acceptance line, and `test/test-written-forms.js` greps the tree to prove the
 * count is zero). A row that reaches nothing published cannot damage what a seal protects.
 *
 * ## Idempotence
 *
 * The primary key is the rule: (volume, form, reading). A second pass over the same volume asks
 * `writtenFormAlreadyFiled` first and files 0, which is what makes the door safe to re-run and what
 * plan 07 §5's acceptance line asks for. A collision that the read did not predict throws rather than
 * overwriting a row another volume filed.
 *
 * @module utils/reference-store/written-forms/file
 */

const fs = require("fs");
const path = require("path");

const { refusal } = require("../refusals");
const { RUBY_GUIDE_FILE_SUFFIX, readRubyGuideFile } = require("../../source/ruby-guides");
const { collectGuideGroups } = require("../../source/guide-groups");
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
 * existed) is **named**, not treated as an empty harvest: `readRubyGuideFile` answers "there is no file
 * here" with null, and a reader that turns that into zero rows reports a zero it did not measure.
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
 * Read one volume's harvest into the shape `collectGuideGroups` folds.
 *
 * @param {string} volumeDir - The volume folder.
 * @param {number} volume - The volume label to stamp on the harvest, so the fold can date each form.
 * @returns {Promise<{harvests: Array<{volume: number, guides: Array<Object>, file: string}>, missing: string[], errors: Array<{file: string, error: string}>}>}
 */
async function readWrittenFormHarvest(volumeDir, volume) {
  const { files, error } = writtenFormHarvestFiles(volumeDir);
  /** @type {Array<{volume: number, guides: Array<Object>, file: string}>} */
  const harvests = [];
  /** @type {Array<{file: string, error: string}>} */
  const errors = [];
  for (const entry of files) {
    const harvest = await readRubyGuideFile(volumeDir, entry.base);
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
 * File one volume's candidate written forms into the record this store has open.
 *
 * @param {Object} store - The store context from `openReferenceStore` / `openVolumeRecord`.
 * @param {Object} [opts]
 * @param {number} [opts.volume] - The volume whose harvest is being read. Defaults to this store's volume.
 * @param {Array<{volume: number, guides: Array<Object>}>} [opts.harvests] - Pre-read harvests, for a
 *   caller that already holds them (the measurement script). Every one must belong to this volume or an
 *   earlier one; a later volume is refused by name.
 * @returns {Promise<{ok: boolean, volume: number, harvestFiles: string[], harvestMissing: boolean, harvestErrors: Array<Object>, harvestReadError: string|null, totals: Object, candidateGroups: number, candidateForms: number, candidateRows: number, candidateOccurrences: number, identityBearing: {groups: number, rows: number, occurrences: number, readings: string[]}, unselected: {groups: number, rows: number, occurrences: number, spellingVariants: number, soundAlikes: number}, spellingVariantGroups: Array<Object>, soundAlikeGroups: Array<Object>, ambiguousReadingScripts: string[], harvestVolumesIgnored: number[], formsFiled: Array<Object>, rowsFiled: number, rowsAlreadyFiled: number, counts: Object, refusal: ReferenceRefusal|null}>}
 */
async function fileVolumeWrittenForms(store, { volume, harvests } = {}) {
  const vol = Number(volume === undefined ? store.volume : volume);
  const empty = {
    harvestFiles: [],
    harvestMissing: false,
    harvestErrors: [],
    harvestReadError: null,
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
    formsFiled: [],
    rowsFiled: 0,
    rowsAlreadyFiled: 0,
    harvestVolumesIgnored: [],
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
  // published, which is the asymmetry plan 07 §4.4 exists to keep.
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
    const fromDisk = await readWrittenFormHarvest(store.volumeDir, vol);
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
  const folded = collectGuideGroups(own, { displaySubset: false });
  const roster = rosterKeysInRecord(store);
  const split = splitGroupsByRoster(folded.groups, roster);
  const unselectedReport = classifyUnselectedGroups(split.unselected);
  const ambiguousReadingScripts = folded.groups
    .filter((group) => scriptOfGroup(group).ambiguous)
    .map((group) => group.reading);

  /** @type {Array<Object>} */
  const formsFiled = [];
  let rowsFiled = 0;
  let rowsAlreadyFiled = 0;

  store.db.exec("BEGIN");
  try {
    for (const group of folded.groups) {
      const script = scriptOfGroup(group);
      if (!script.readingScript) {
        throw new Error(
          `[reference-store] fileVolumeWrittenForms: the group "${group.reading}" carries no script label for its reading, ` +
            "and a written-form row that cannot say how its reading is written is a row a later reader has to guess about."
        );
      }
      for (const form of group.forms) {
        for (const occurrence of form.occurrences || []) {
          if (Number(occurrence.volume) !== vol) continue;
          const existing = writtenFormAlreadyFiled(store, { volume: vol, form: form.form, reading: group.reading });
          if (existing) {
            rowsAlreadyFiled += 1;
            continue;
          }
          insertWrittenFormRow(store, {
            volume: vol,
            form: form.form,
            reading: group.reading,
            readingScript: script.readingScript,
            occurrences: Number(occurrence.count),
            chapters: occurrence.chapters || [],
          });
          rowsFiled += 1;
          formsFiled.push({
            form: form.form,
            reading: group.reading,
            readingScript: script.readingScript,
            occurrences: Number(occurrence.count),
            chapters: (occurrence.chapters || []).slice(),
          });
        }
      }
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
  readWrittenFormHarvest,
  scriptOfGroup,
  fileVolumeWrittenForms,
};
