/**
 * utils/artifacts/rules.js — the conditions a declared file is expected under, and the evidence a gate leaves.
 *
 * A `when` predicate exists so a step that legitimately wrote nothing is not reported as a gap:
 * the research stage writes no research file when it is off, and expecting one would be a
 * false finding. The quarantine patterns are the other half: a `.rejected` file is not a
 * missing output, it is a gate that FIRED, and an un-monitored run never looks at it.
 * 
 * The last block is the reverse question the post-mortem asks about a volume folder — which
 * files are legitimate there without being one step's declared output, so a stale one is still
 * visible (gotcha 3).
 */

/** @typedef {import("../artifacts").ArtifactExpectation} ArtifactExpectation */
/** @typedef {import("../artifacts").QuarantineExpectation} QuarantineExpectation */
/** @typedef {import("../artifacts").ArtifactContext} ArtifactContext */

// ─── `when` predicates ────────────────────────────────────────────────────────

/**
 * `RESEARCH_ENABLED` — the glossary's per-term research stage. Off, the stage
 * writes no `glossary-research.md`, and expecting one would be a false finding.
 * @param {ArtifactContext} ctx
 * @returns {boolean}
 */
function researchEnabled(ctx) {
  return ctx.researchEnabled;
}

/**
 * `VOLUME_CONSISTENCY_ENABLED` — the cross-chapter audit, which writes
 * `volume-consistency.{md,json}` only when it ran.
 * @param {ArtifactContext} ctx
 * @returns {boolean}
 */
function volumeConsistencyEnabled(ctx) {
  return ctx.volumeConsistencyEnabled;
}

/**
 * `POLISH_VERIFY_ENABLED` — the polish drift audit, which writes
 * `polish-verification.json` only when it ran.
 * @param {ArtifactContext} ctx
 * @returns {boolean}
 */
function polishVerifyEnabled(ctx) {
  return ctx.polishVerifyEnabled;
}

// ─── Shared quarantine patterns ───────────────────────────────────────────────

/**
 * A cumulative artifact a gate refused and kept. HIGH: the volume failed, the file is not readable by
 * the next volume, and every later volume cascades.
 *
 * The family is `<name>.md.rejected`, `<name>.md.rejected.2`, … because the quarantine door
 * (`utils/reference-store/quarantine.js`'s `moveArtifactAside`) numbers every rejection rather than
 * overwriting the first one (gotcha 111, gotcha 116). A pattern that stops at `.rejected` recognises
 * the first refusal of a volume and is blind to the second and every later one, which is how a real
 * refusal became invisible to the completion check and to the report.
 *
 * `pov-map.md` is in the family because it is a declared `character-voice` output
 * (`utils/artifacts/preproduction.js`) that the same door moves aside — `utils/reference-store/pov-map.js`
 * keeps an authored map rather than silently overwriting it, and `character-voice/assemble.js` quarantines
 * both artifacts together when the grade fails. Nothing named it before.
 *
 * @type {QuarantineExpectation}
 */
const QUARANTINED_CUMULATIVE = {
  pattern: /^(glossary|character-voice|style-guide|pov-map)\.md\.rejected(\.\d+)?$/,
  severity: "HIGH",
  meaning:
    "a gate refused this artifact and kept the copy it refused — the volume lost something a " +
    "previous volume held, and every later volume cascades from it",
};

/**
 * A translation draft the deterministic QA rejected. MEDIUM, not HIGH: the draft
 * is kept deliberately (gotcha 39) so `retranslate` has something to repair, and
 * a later round may already have fixed it. It is still worth naming in a report.
 * @type {QuarantineExpectation}
 */
const QUARANTINED_DRAFT = {
  pattern: /^translation-.+\.rejected(-passage)?\.md$/,
  severity: "MEDIUM",
  meaning:
    "a draft failed the deterministic QA and was quarantined — check whether a " +
    "later round repaired it or the chapter published UNVERIFIED",
};

// ─── What a quarantine file MEANS, given the folder it sits in ────────────────

/**
 * Three different acts write through the one quarantine door, and the file name cannot tell them
 * apart (`AGENTS.md` gotcha 130's lesson, measured 2026-10-13):
 *
 *   1. the carry-forward guard refused the artifact — the live file is GONE (`glossary/carry-forward/gates.js`);
 *   2. the acceptance grade refused the artifact — the live file is GONE (`glossary/store.js`, `character-voice/assemble.js`);
 *   3. a re-render replaced a published artifact and kept the copy it replaced — the live file is
 *      PRESENT, fresh, and graded (`renderGlossaryArtifact`, `writeRebuiltVoiceFile`, `writePovMapFile`).
 *
 * The PAIR can. A quarantine whose named artifact is also in the folder is the copy act 3 kept; one
 * whose named artifact is absent is act 1 or act 2. That is a fact already on the disk, checked for
 * free, and it is the same question `utils/prereqs.js` answers for its own gate — so both doors ask
 * this one function rather than each keeping an opinion (gotcha 136: a check that passes on a
 * coincidence is a check that is not running).
 *
 * A kept copy is LOW because it is not damage and not a defect: it is the reason
 * `KNOWN_VOLUME_FILE_PATTERNS` lists the family at all. The damage beside it is reported by its own
 * finding (`missing-required`, `accepted-without-acceptance`), which is what the level table means
 * when it calls `quarantine-present` a NOTE — "the deliverable beside it is checked by its own
 * finding, so this line is context rather than damage" (`utils/postmortem/levels.js`).
 */
const QUARANTINED_COPY_SEVERITY = "LOW";
const QUARANTINED_COPY_MEANING =
  "the copy a re-render replaced and kept as evidence — the artifact standing in its place is " +
  "judged by its own expectation, so this line says how this volume was made, not that it failed";

/**
 * The artifact a quarantine file NAMES, or null when it names none.
 *
 * `glossary.md.rejected.2` names `glossary.md`; `translation-ch3.rejected.md` names `translation-ch3`,
 * which no step declares (the translation steps declare `translation.md`, `translation-state.json`,
 * `translation-qa.md`) — that is what makes a kept draft a different kind of file from a refused
 * reference, and why it is never a completion blocker (gotcha 39).
 *
 * @param {string} name - A file name in a volume folder.
 * @returns {string|null}
 */
function quarantineStem(name) {
  const stem = String(name || "")
    .replace(/\.rejected(\.\d+)?$/, "")
    .replace(/\.rejected(-passage)?\.md$/, "");
  return stem && stem !== name ? stem : null;
}

// ─── Files a volume folder legitimately holds that no single step declares ────

/**
 * Volume-folder files that are legitimate but are not one step's declared output:
 * source material, extraction cache, quarantine evidence, and the cross-chapter
 * audit's files (declared for the verify steps, but they sit in the volume folder
 * and would otherwise look "unexpected" to every other step that runs after them).
 *
 * The unexpected-file check needs this list to be complete, or every staged book,
 * every extracted chapter and every piece of kept evidence becomes a finding — and
 * a check that fires on healthy output is a check people learn to ignore (the
 * lesson of gotcha 65's false-positive guard).
 *
 * `isVolumeArtifact` (get-translation-target.js) already covers the artifact half:
 * the bundle cache, `-whole.md`, `-chN.md`, the per-chapter translation files, the
 * rolling-state files. These are the pieces it does not name.
 *
 * @type {RegExp[]}
 */
const KNOWN_VOLUME_FILE_PATTERNS = [
  // Plain-text sources split into part files by materializeTextParts (utils/source.js).
  /^.+-part-\d+\.md$/,
  // The extraction cache's image manifest lives inside images/, which the
  // post-mortem skips as a directory; this covers a stray at the top level.
  /^images\.json$/,
  // The cross-chapter audit's output. Declared for verify-translate / translate-qa,
  // but it lives in the volume folder for the whole life of the volume.
  /^volume-consistency\.(md|json)$/,
  // Quarantine evidence the pipeline keeps on purpose. The family is `<name>.md.rejected` and the
  // numbered series the shared door writes (`<name>.md.rejected.2`, `.3`, … — gotcha 116), plus a
  // translation draft's `translation-<id>.rejected.md` and `.rejected-passage.md`. What each one MEANS
  // is decided beside the artifact it names (`quarantineStem` above, read by `classifyVolumeQuarantine`
  // in utils/artifacts/specs.js); being listed here only says it is not a stray file.
  /\.rejected(\.\d+)?$/,
  /\.rejected(-passage)?\.md(\.\d+)?$/,
  // Every volume folder gets a pipeline-written `.gitignore` whose whole content is `*.rejected*`, so the
  // run's memory can be committed with the books while the quarantines stay out (gotcha 116). No step
  // declares it, and it is not a defect: measured on the 17 legitimate books it was the *only* thing the
  // unexpected-file check ever reported — 18 findings, 2 distinct files, 0 genuine.
  /^\.gitignore$/,
];

/**
 * Whether a volume-folder file name is legitimate output or source material that
 * no single step's expectations declare.
 *
 * @param {string} name - A file name.
 * @returns {boolean}
 */
function isKnownVolumeFile(name) {
  return KNOWN_VOLUME_FILE_PATTERNS.some((re) => re.test(name));
}

module.exports = {
  researchEnabled,
  volumeConsistencyEnabled,
  polishVerifyEnabled,
  QUARANTINED_CUMULATIVE,
  QUARANTINED_DRAFT,
  QUARANTINED_COPY_SEVERITY,
  QUARANTINED_COPY_MEANING,
  quarantineStem,
  KNOWN_VOLUME_FILE_PATTERNS,
  isKnownVolumeFile,
};
