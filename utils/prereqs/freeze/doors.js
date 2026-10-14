/**
 * utils/prereqs/freeze/doors.js — the gate's declared data: which doors it covers, what each
 * one rewrites, and which cancellations mean "this act writes nothing".
 *
 * Nothing here decides anything. This file is the table the gate reads, and the two lookups that
 * read it. The refusal wording lives in `wording.js`, the folder reading in `frozen-state.js`, and
 * the decision itself in `gate.js`; a door cannot exempt itself here because a table an importing
 * module can reassign is a dial, so every row is `Object.freeze`d on top of living in a banned
 * patch path (AGENTS.md §3).
 *
 * @module utils/prereqs/freeze/doors
 */

/**
 * One door this gate covers, and why it is covered.
 *
 * @typedef {Object} FreezeDoorRow
 * @property {string} door - The gulp task name, or the manual command's own name for the four root
 *   doors that are not gulp tasks and therefore never pass through `gulpfile.js`.
 * @property {"volume"|"series"} scope - `volume`: the refusal is per volume. `series`: the door
 *   writes one thing for the whole series, so it is frozen when ANY volume in scope is frozen.
 * @property {string} writes - What this door rewrites, in the words a refusal prints.
 * @property {boolean} missingIsRepair - Whether an ABSENT artifact counts as a hole to fill rather
 *   than a thing to overwrite. True only where the door's own output is a declared per-volume
 *   artifact; `extract` rewrites the extracted text whether or not a file of its own is present.
 * @property {string} because - Why this door is inside the gate at all.
 */

/**
 * Every door the freeze covers.
 *
 * The five pre-production gulp steps, `discover` and `extract` under the "would this act actually
 * rewrite it" rule, and the four manual doors — which are root commands rather than gulp tasks, so
 * no wrapper can reach them and each one calls this gate itself.
 *
 * @type {Record<string, FreezeDoorRow>}
 */
const FREEZE_DOORS = Object.freeze({
  glossary: {
    door: "glossary",
    scope: "volume",
    writes: "this volume's `glossary.md` and its reference record",
    missingIsRepair: true,
    because:
      "the glossary is the one thing the translation stage cannot repair afterwards, and every later " +
      "volume amends this volume's copy",
  },
  "character-voice": {
    door: "character-voice",
    scope: "volume",
    writes: "this volume's `character-voice.md`, its `pov-map.md` and its reference record",
    missingIsRepair: true,
    because:
      "the voice reference decides how a character sounds in every volume after this one, and the " +
      "record is copied forward into each of them",
  },
  "style-guide": {
    door: "style-guide",
    scope: "volume",
    writes: "this volume's `style-guide.md`",
    missingIsRepair: true,
    because: "the cumulative style guide is the base the next volume amends and the translator follows",
  },
  "jump-in-wiki": {
    door: "jump-in-wiki",
    scope: "volume",
    writes: "this volume's `wiki.md`, `shared-wiki.md`, `chapters.json` and `translation-brief.md`",
    missingIsRepair: true,
    because:
      "`chapters.json` is the chapter list the translation stage iterated and `shared-wiki.md` is the " +
      "story state it was told about this volume",
  },
  "consistency-audit": {
    door: "consistency-audit",
    scope: "series",
    writes: "the series' `consistency-report.md` — the sign-off those translations were built on",
    missingIsRepair: true,
    because:
      "re-signing after the fact makes the sign-off describe a state that no longer matches what was " +
      "translated. A plain run skips while its provenance sidecar still fingerprints the four " +
      "artifacts, so this never blocks a legal resumed `translate` — the prerequisite gate asks " +
      "whether the audit is COMPLETE, not whether it may run",
  },
  discover: {
    door: "discover",
    scope: "series",
    writes: "the plan of record (`translation-target.json`, `translation-plan.md`)",
    missingIsRepair: false,
    because:
      "every volume folder, every reading order and every source file name downstream came from this " +
      "plan; re-deciding it re-decides which book each finished translation was made from. A plain " +
      "run reuses the cached plan and is not a rewrite",
  },
  extract: {
    door: "extract",
    scope: "volume",
    writes: "the extracted text this volume's translation was translated from",
    missingIsRepair: false,
    because:
      "`--force` re-extracts every volume and so rewrites the text a published translation is a " +
      "translation OF. A warm-cache run only VERIFIES that text against the archive and writes " +
      "nothing, which is why it is allowed on a frozen series",
  },
  "rebuild-voice": {
    door: "rebuild-voice",
    scope: "volume",
    writes: "this volume's `character-voice.md` / `pov-map.md`, and it seals the record beside them",
    missingIsRepair: false,
    because:
      "`--apply` publishes into the volume folder and seals the record the next volume copies forward. " +
      "A rehearsal without `--apply` writes nothing into the series folder and stays allowed — that " +
      "door exists so a renderer change can be seen before it is published",
  },  "extract-voice": {
    door: "extract-voice",
    scope: "volume",
    writes: "this volume's extraction notebook and its reference record (`series.db`)",
    missingIsRepair: false,
    because:
      "it re-reads the volume chapter by chapter and re-files the record a published reference — and " +
      "therefore a published translation — was rendered from",
  },
  "reopen-volume": {
    door: "reopen-volume",
    scope: "volume",
    writes: "this volume's published reference record (it retires the record whole)",
    missingIsRepair: false,
    because:
      "retiring a record is the first half of rebuilding the reference a translation was built from, " +
      "so it is the act the freeze exists to make deliberate",
  },
  "attribute-voice": {
    door: "attribute-voice",
    scope: "volume",
    writes: "claims this volume's published reference already makes (it marks them `disputed`)",
    missingIsRepair: false,
    because:
      "a published claim a translation was built on is left standing but marked contested, which " +
      "changes what the reference says about who speaks those words",
  },
  "glossary-settlement": {
    door: "glossary-settlement",
    scope: "series",
    writes:
      "the series' `glossary.md` (it is rendered out of the settled record) and the settled terminology " +
      "the published translations were rendered under",
    missingIsRepair: false,
    because:
      "the settlement files new supersede rows into the reference records and republishes the series " +
      "glossary from them, which rewrites the terminology law a published translation was translated " +
      "against. A series with no root `glossary.md` yet is not excused: what this door rewrites is the " +
      "law, not one file",
  },
});

/**
 * The manual doors are not gulp tasks, so the artifact they threaten is a gulp step's artifact.
 * This is the mapping the refusal prints, and the reason a rehearsal of one of them is judged
 * against the same folder as the stage it belongs to.
 *
 * @type {Record<string, string>}
 */
const DOOR_OWNER = Object.freeze({
  "rebuild-voice": "character-voice",
  "extract-voice": "character-voice",
  "reopen-volume": "character-voice",
  "attribute-voice": "character-voice",
  // The settlement is the glossary step's own end-of-run act, so the artifact it threatens is the
  // glossary stage's series declaration.
  "glossary-settlement": "glossary",
});

/**
 * The cancellations that mean "this act writes nothing".
 *
 * The freeze is on REWRITING, not on looking, and that rule is enforced here rather than left to each
 * caller's restraint: a door that reports one of these is not asking to overwrite anything, and the gate
 * says so in its own verdict instead of trusting that nobody would ask. `extract` on a warm cache,
 * `discover` reusing the plan of record, a volume whose skip stands, and a glossary settlement with
 * nothing left to decide are the four real cases.
 *
 * Anything NOT listed is treated as a rewrite, including a word this file has never seen — a gate that
 * failed closed on an unrecognised cancellation would be a gate a caller could not widen by inventing a
 * label.
 *
 * @type {Record<string, string>}
 */
const NOT_A_REWRITE = Object.freeze({
  skip: "the skip stands: this run rebuilds nothing",
  "cache-verified": "the extracted text was verified against the archive and rewritten by nobody",
  "plan-cached": "the plan of record was reused from disk",
  "audit-fresh": "the report still fingerprints the four artifacts it audited",
  // The glossary settlement, on a run that has nothing left to decide. The caller computes this from
  // the two facts the gate cares about — no agenda term has a question that has never been asked, and
  // the render of the settled record is byte-for-byte the file already on disk — rather than from a
  // flag, so it cannot be claimed by a door that would in fact rewrite something.
  "settlement-no-change": "every settlement question this series asks has already been answered, and the series glossary already matches the render of the settled record",
});

/**
 * Is one door inside the gate?
 *
 * @param {string} door - A gulp task name or a manual door name.
 * @returns {FreezeDoorRow|null} The row, or null when this door is not gated.
 */
function freezeDoorRow(door) {
  return FREEZE_DOORS[String(door || "")] || null;
}

/**
 * The doors this gate covers, in table order.
 *
 * @returns {string[]}
 */
function frozenDoors() {
  return Object.keys(FREEZE_DOORS);
}

module.exports = {
  FREEZE_DOORS,
  DOOR_OWNER,
  NOT_A_REWRITE,
  freezeDoorRow,
  frozenDoors,
};
