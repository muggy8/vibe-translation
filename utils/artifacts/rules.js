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
 * A cumulative artifact a carry-forward gate rejected. HIGH: the volume failed,
 * the file is not readable by the next volume, and every later volume cascades.
 * @type {QuarantineExpectation}
 */
const QUARANTINED_CUMULATIVE = {
  pattern: /^(glossary|character-voice|style-guide)\.md\.rejected$/,
  severity: "HIGH",
  meaning:
    "a carry-forward gate rejected this artifact — the volume lost something a " +
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
  // Quarantine evidence the pipeline keeps on purpose. Two spellings: a cumulative
  // artifact gets `<name>.md.rejected`, a translation draft gets
  // `translation-<id>.rejected.md` (and `.rejected-passage.md`). Its presence is
  // reported by a step's `quarantines`, not by the unexpected-file check.
  /\.rejected$/,
  /\.rejected(-passage)?\.md$/,
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
  KNOWN_VOLUME_FILE_PATTERNS,
  isKnownVolumeFile,
};
