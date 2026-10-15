/**
 * character-voice/reconcile/buckets.js — the closing cast reconciliation's query: split the whole roster
 * into the three buckets, read out of the settled record, with 0 model calls.
 *
 * Per book the pipeline can only ask "is anybody missing from THIS volume's reference". That question is
 * answered by `utils/reference-store/integrity/coverage.js`, and since plan 06 slice 9 its softer half is a
 * per-book NOTE rather than a pause. The question the per-book guard cannot answer is the one the whole
 * series makes possible: **now that every book has been read, which names on the roster does the series
 * actually say something about, which ones does it name without ever putting on a page, and which ones are
 * on a page in a book that said nothing about them?** Those are the three buckets.
 *
 * | bucket | the roster holds them | the book's text puts them on a page | the record says something about how they speak |
 * |---|---|---|---|
 * | **named and voiced** | yes | any volume | yes |
 * | **named and never seen** | yes | no volume | no |
 * | **on the page, nothing recorded** | yes | at least one volume | no |
 *
 * ## Why the question is a query and never a judgement
 *
 * Every input is a row the store already wrote: `cast` for the roster, `cast_presence` /
 * `cast_presence_match` for "the book's own text prints this name" (measured from the volume's extracted
 * chapter files by the store's own matching rule — a model cannot assert an absence, which is why presence
 * is its own table), and `facts` for "something is recorded about how they speak". The same record always
 * produces the same three lists, which is what makes the split reviewable and what keeps a model out of it
 * entirely (plan 06 §9).
 *
 * ## "Covered" is the same predicate the per-book guard uses
 *
 * `integrity/coverage.js` counts a character as covered by a claim that is **record content** — not an
 * extraction candidate (`EXTRACTION_SOURCE_STAGE`) and not a glossary row (`aspect = 'term_usage'`). This
 * file uses that same predicate, on purpose: a character the per-book guard calls covered must land in
 * bucket 1 here, and a character the guard names in its MEDIUM group must land in bucket 3. Two doors that
 * disagree about who is covered is how a closing pass looks like it fixed something it did not look at.
 *
 * ## Presence is asked about the person, not the spelling
 *
 * A roster entry merged into another one is the same character, and `coverage.js` counts both spellings'
 * hits for "are they in this volume at all". The same rule is used here, so a protagonist filed under a
 * first-person pronoun that the record folded into his own entry is not reported as barely present.
 *
 * ## What it refuses
 *
 * A handle it cannot query, and a record with **no presence measurement in any volume**. The second is the
 * load-bearing refusal: without it every roster entry would land in "named and never seen", because "no row
 * says they are present" and "nobody measured" would be the same answer — which is the shape of a check
 * switching itself off (`coverage.js` refuses the same way for the same reason).
 *
 * @module character-voice/reconcile/buckets
 */

require("../../types"); // JSDoc type definitions
const { structuralError } = require("../../configs/shared");
const {
  listCast,
  castPresence,
  presenceDetail,
  EXTRACTION_SOURCE_STAGE,
  REFERENCE_STORE_FILE_NAME,
} = require("../../utils/reference-store");

/**
 * The error every refusal in this pass uses.
 *
 * Structural on purpose, the way the settled-terminology door and the prerequisite gate are: a closing act
 * that could not read the record must not be walkable past by `ON_TASK_ERROR=continue`, and it must not
 * publish an answer it never measured.
 *
 * @param {string} message - The whole refusal, already naming what was looked for and where.
 * @returns {Error}
 */
function reconciliationRefusal(message) {
  return structuralError(`[cast-reconciliation] ${message}`);
}

/**
 * The volumes this record knows about, read out of its own `volumes` table.
 *
 * Not out of the folder names, and not out of the run's plan of record: the record is the thing being
 * asked, and a reconciliation that took its volume list from somewhere else could report a volume the
 * record never measured (gotcha 119 is a stage reading the wrong file as the book; this is the same class
 * of mistake one level up).
 *
 * @param {{db: Object}} handle
 * @returns {number[]} Ascending.
 */
function recordVolumes(handle) {
  return handle.db
    .prepare("SELECT DISTINCT volume FROM volumes ORDER BY volume")
    .all()
    .map((row) => Number(row.volume));
}

/**
 * The volumes this record has a presence measurement for.
 *
 * `cast_presence` is written per volume by the audit. A volume absent from it is a volume nobody searched,
 * which is a different fact from "nobody on the roster is in it" — and the difference is the whole reason
 * this pass refuses rather than guesses.
 *
 * @param {{db: Object}} handle
 * @returns {number[]} Ascending.
 */
function measuredVolumes(handle) {
  return handle.db
    .prepare("SELECT DISTINCT volume FROM cast_presence ORDER BY volume")
    .all()
    .map((row) => Number(row.volume));
}

/**
 * The roster this record holds at the volume it is the settled record for.
 *
 * Merged entries are dropped: their claims were re-pointed to the entry they joined, so asking about both
 * halves of one person asks the same question twice with different answers. Their *hits* still count, under
 * the surviving key — see {@link presenceForCharacter}.
 *
 * @param {{db: Object}} handle
 * @param {number} volume
 * @returns {Array<{key: string, display: string|null, first_seen_volume: number|null}>}
 */
function rosterAt(handle, volume) {
  return listCast(handle, volume).filter((row) => !row.merged_into);
}

/**
 * Every roster key whose presence hits belong to this character: the entry itself plus every entry merged
 * into it.
 *
 * @param {{db: Object}} handle
 * @param {string} key
 * @returns {string[]}
 */
function identityKeysFor(handle, key) {
  return [key, ...handle.db.prepare("SELECT key FROM cast WHERE merged_into = ? ORDER BY key").all(key).map((row) => row.key)];
}

/**
 * How much of the series' text this character is in, over every volume the record measured.
 *
 * @param {{db: Object}} handle
 * @param {string[]} identityKeys
 * @param {number[]} volumes - The volumes with a presence measurement.
 * @param {Map<number, Array<{key: string, present: number, chapters: number, matches: number}>>} presenceByVolume
 * @returns {{volumesPresent: number[], volumesMeasured: number[], chaptersTotal: number, perVolume: Array<{volume: number, chapters: number, matches: number, rules: string[]}>}}
 */
function presenceForCharacter(handle, identityKeys, volumes, presenceByVolume) {
  const volumesPresent = [];
  const volumesMeasured = [];
  const perVolume = [];
  let chaptersTotal = 0;
  for (const volume of volumes) {
    const rows = (presenceByVolume.get(volume) || []).filter((row) => identityKeys.includes(row.key));
    if (rows.length === 0) continue; // nobody measured this name in this volume — not the same as absent
    volumesMeasured.push(volume);
    const chapters = Math.max(0, ...rows.map((row) => Number(row.chapters || 0)));
    const matches = rows.reduce((sum, row) => sum + Number(row.matches || 0), 0);
    if (matches <= 0) continue;
    volumesPresent.push(volume);
    chaptersTotal += chapters;
    const rules = new Set();
    for (const key of identityKeys) {
      for (const detail of presenceDetail(handle, volume, key)) {
        for (const rule of String(detail.matched || "").split(",")) if (rule) rules.add(rule);
      }
    }
    perVolume.push({ volume, chapters, matches, rules: [...rules].sort() });
  }
  return { volumesPresent, volumesMeasured, chaptersTotal, perVolume };
}

/**
 * How many claims about this character the record itself stands behind.
 *
 * The per-book coverage guard's predicate, unchanged: record content only, so an extraction candidate and a
 * glossary row do not fill the gap. A glossary row says how a name is translated, not what the character
 * sounds like.
 *
 * @param {{db: Object}} handle
 * @param {string} key
 * @returns {number}
 */
function recordedClaimsFor(handle, key) {
  return handle.db
    .prepare("SELECT COUNT(*) AS n FROM facts WHERE key = ? AND aspect != 'term_usage' AND source_stage != ?")
    .get(key, EXTRACTION_SOURCE_STAGE).n;
}

/**
 * How many claims the extraction pass filed about this character, whether the reference took them or not.
 *
 * The second signal the per-book guard uses — two separate readings of the same book disagreeing — and the
 * most useful line in an investigation dossier: "the extractor noticed them and the reference did not" is a
 * different hole from "nobody noticed them".
 *
 * @param {{db: Object}} handle
 * @param {string} key
 * @returns {number}
 */
function extractionClaimsFor(handle, key) {
  return handle.db
    .prepare("SELECT COUNT(*) AS n FROM facts WHERE key = ? AND aspect != 'term_usage' AND source_stage = ? AND status <> 'retracted'")
    .get(key, EXTRACTION_SOURCE_STAGE).n;
}

/**
 * The three buckets, over one settled record.
 *
 * @param {{db: Object, volume?: number, file?: string, folder?: string}} handle - The settled record, opened read-only.
 * @param {{volume?: number}} [opts] - The volume to read the roster at. Defaults to the record's own.
 * @returns {{
 *   roster: number,
 *   volumes: number[],
 *   volumesMeasured: number[],
 *   volumesUnmeasured: number[],
 *   voiced: Array<Object>,
 *   neverSeen: Array<Object>,
 *   onPageUnrecorded: Array<Object>,
 *   mergedEntries: number,
 *   mirroredVoiceDocument: boolean,
 * }}
 * @throws {Error} Structural, when the caller hands this query no record, or when the record holds no
 *   presence measurement in any volume.
 */
function castBuckets(handle, { volume } = {}) {
  if (!handle || !handle.db || typeof handle.db.prepare !== "function") {
    throw reconciliationRefusal(
      `the closing cast reconciliation is a query over the settled reference record ` +
        `(<volume folder>/${REFERENCE_STORE_FILE_NAME}), and it was handed no record to query. An empty ` +
        `answer would mean "this series has nobody on its roster"; a record nobody opened means "nobody ` +
        `looked". Those are different sentences, and publishing the first one for the second is how this ` +
        `pass would certify a cast it never read.`
    );
  }
  const vol = Number(volume === undefined ? handle.volume : volume);
  if (!Number.isInteger(vol)) {
    throw reconciliationRefusal(
      `the settled record at ${handle.file || handle.folder || "(unknown)"} does not say which volume it is, ` +
      `so the roster cannot be read at a volume and the reconciliation cannot say which volumes it covers.`
    );
  }

  const volumes = recordVolumes(handle);
  const measured = measuredVolumes(handle);
  if (measured.length === 0) {
    throw reconciliationRefusal(
      `the settled record at ${handle.file} holds no presence measurement for any volume ` +
      `(its ${volumes.length} registered volume(s): ${volumes.join(", ") || "none"}). Presence is what ` +
      `"the book's own text puts this name on a page" means here, and without it every roster entry would ` +
      `land in "named and never seen" on the strength of a measurement nobody took. Refused rather than ` +
      `publishing that.\n  Fix: run the pre-production steps so each volume's audit measures presence ` +
      `(npx gulp glossary / npx gulp character-voice), or reopen the volume whose record is short.`
    );
  }

  /** @type {Map<number, Array<Object>>} */
  const presenceByVolume = new Map();
  for (const volume2 of measured) presenceByVolume.set(volume2, castPresence(handle, volume2));

  const mirrored = handle.db.prepare("SELECT COUNT(*) AS n FROM document_prose").get().n > 0;
  const allCast = handle.db.prepare("SELECT COUNT(*) AS n FROM cast").get().n;
  const rows = rosterAt(handle, vol);

  const voiced = [];
  const neverSeen = [];
  const onPageUnrecorded = [];
  for (const entry of rows) {
    const identityKeys = identityKeysFor(handle, entry.key);
    const presence = presenceForCharacter(handle, identityKeys, measured, presenceByVolume);
    const recordedClaims = recordedClaimsFor(handle, entry.key);
    const row = {
      key: entry.key,
      display: entry.display || entry.key,
      firstSeenVolume: entry.first_seen_volume === null || entry.first_seen_volume === undefined ? null : Number(entry.first_seen_volume),
      identityKeys,
      recordedClaims,
      extractionClaims: extractionClaimsFor(handle, entry.key),
      ...presence,
    };
    if (recordedClaims > 0) voiced.push(row);
    else if (presence.volumesPresent.length === 0) neverSeen.push(row);
    else onPageUnrecorded.push(row);
  }

  const byName = (a, b) => a.key.localeCompare(b.key, "ja");
  voiced.sort(byName);
  neverSeen.sort(byName);
  onPageUnrecorded.sort(byName);

  return {
    roster: rows.length,
    mergedEntries: allCast - handle.db.prepare("SELECT COUNT(*) AS n FROM cast WHERE merged_into IS NULL").get().n,
    volumes,
    volumesMeasured: measured,
    volumesUnmeasured: volumes.filter((v) => !measured.includes(v)),
    voiced,
    neverSeen,
    onPageUnrecorded,
    mirroredVoiceDocument: mirrored,
  };
}

module.exports = {
  castBuckets,
  recordVolumes,
  measuredVolumes,
  rosterAt,
  identityKeysFor,
  presenceForCharacter,
  recordedClaimsFor,
  extractionClaimsFor,
};
