/**
 * utils/artifacts.js — What each pipeline step is supposed to leave behind.
 *
 * Why this file exists. The pipeline's failure reports describe what the code
 * noticed, and the most expensive bugs this project has had are the kind that
 * noticed nothing:
 *   - volume 04 of the live 17-volume run has a `glossary.md` and NOTHING else
 *     — no validation report, no coverage audit, no rolling state (gotcha 64);
 *   - 457 glossary terms disappeared between two volumes with no error at all;
 *   - a 164-character sentence about an agent's plan became the series' published
 *     character voice reference (gotcha 58);
 *   - a feedback pass made 46 tool calls, wrote nothing, and the loop paid 8.4M
 *     tokens to re-audit an unchanged document (gotcha 65).
 * None of those are crashes. Every one of them is visible to a question the
 * pipeline has never asked: "did this step leave the files this step always
 * writes, in the shape those files always have?"
 *
 * This module is that question, written down as data. It declares, per step:
 *   - `volume`      — files the step must leave in each volume folder it ran on
 *   - `series`      — files the step must leave at the series root
 *   - `quarantines` — files whose PRESENCE is itself a finding (a `.rejected`
 *     file means a gate fired; the pipeline kept it as evidence, and an
 *     un-monitored run never looks at it)
 * The assessment itself (what to do with this data) lives in utils/postmortem.js.
 *
 * Two rules this file deliberately keeps:
 *   1. `required` is only used where the pipeline writes the file on EVERY path
 *      it can reach. Over-declaring is worse than under-declaring: gotcha 65's
 *      carry-forward guard called an improvement a loss and threw away good work.
 *      A check that fires on healthy output trains everyone to ignore the check.
 *   2. Shape is checked the way the existing gates check it — a Markdown heading
 *      or a table (`hasDocumentShape` in utils/fs.js), because every prompt in
 *      this pipeline that writes one of these documents specifies that shape.
 *
 * @module utils/artifacts
 */

require("../types"); // JSDoc type definitions

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * What one file a step is supposed to produce.
 *
 * @typedef {Object} ArtifactExpectation
 * @property {string} name - File name, relative to the volume folder (or to the
 *   series root for a `series` expectation). `{installment}` is replaced with the
 *   volume's two-digit installment number, for the per-volume reports whose names
 *   carry it (`jump-in-wiki-validation-{installment}.md`).
 * @property {"required"|"expected"} level - `required`: its absence means the step
 *   did not finish this volume (HIGH). `expected`: its absence is a gap worth
 *   reporting, not a failure (MEDIUM).
 * @property {"document"|"table"|"json"|"any"} [shape] - What the file must look
 *   like when it exists. `document` = a Markdown heading, `table` = a Markdown
 *   table, `json` = parseable JSON, `any` = presence only. Defaults to `any`.
 * @property {string} [why] - One line of provenance: why this file is expected.
 * @property {function(ArtifactContext): boolean} [when] - Skip this expectation
 *   entirely when it returns false (a stage the operator turned off writes nothing).
 */

/**
 * The values a `when` predicate may read.
 *
 * @typedef {Object} ArtifactContext
 * @property {boolean} researchEnabled - `RESEARCH_ENABLED` (the glossary's research stage)
 * @property {boolean} verifyEnabled - `VERIFY_TRANSLATE_ENABLED` (the verify → retranslate chain)
 * @property {boolean} volumeConsistencyEnabled - `VOLUME_CONSISTENCY_ENABLED` (the cross-chapter audit)
 * @property {boolean} polishVerifyEnabled - `POLISH_VERIFY_ENABLED` (the polish drift audit)
 * @property {string} installment - The volume's two-digit installment number, when per-volume
 */

/**
 * A file whose PRESENCE is a finding rather than a deliverable.
 *
 * The pipeline quarantines damaged output instead of deleting it, so a broken
 * run leaves evidence on disk that nothing ever reads. A quarantine pattern
 * turns that evidence back into a finding.
 *
 * @typedef {Object} QuarantineExpectation
 * @property {RegExp} pattern - Matched against the file name in the volume folder.
 * @property {"HIGH"|"MEDIUM"|"LOW"} severity - HIGH: a gate rejected the artifact this
 *   step is supposed to publish. MEDIUM: a repairable failure was recorded and may or
 *   may not have been repaired downstream.
 * @property {string} meaning - What the file means, for the report.
 */

/**
 * Everything one step is expected to leave.
 *
 * @typedef {Object} StepArtifactSpec
 * @property {string} step - The gulp task name (a `TASKS` entry in utils/hooks.js).
 * @property {boolean} perVolume - Whether the step writes per-volume artifacts at all.
 *   `discover` and `consistency-audit` work at the series level only.
 * @property {ArtifactExpectation[]} volume
 * @property {ArtifactExpectation[]} series
 * @property {QuarantineExpectation[]} quarantines
 */

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

// ─── Per-step expectations ────────────────────────────────────────────────────

/**
 * The whole manifest, keyed by gulp task name.
 *
 * Every step name here is a `TASKS` entry in utils/hooks.js and a key of
 * `PIPELINE_STEPS` in gulpfile.js — `test/test-postmortem.js` asserts the three
 * lists agree, so a new step cannot be added to the pipeline without being
 * declared here too.
 *
 * @type {Object<string, StepArtifactSpec>}
 */
const STEP_ARTIFACT_SPECS = {
  discover: {
    step: "discover",
    perVolume: false,
    volume: [],
    series: [
      {
        name: "translation-target.json",
        level: "required",
        shape: "json",
        why: "the plan of record every other step reads",
      },
      {
        name: "translation-plan.md",
        level: "expected",
        shape: "document",
        why: "the human-readable version of the plan",
      },
    ],
    quarantines: [],
  },

  glossary: {
    step: "glossary",
    perVolume: true,
    volume: [
      {
        name: "glossary.md",
        level: "required",
        shape: "table",
        why: "the volume's glossary snapshot — terminology law for the translator",
      },
      {
        name: "glossary-validation.md",
        level: "required",
        shape: "document",
        why: "the validator's report (chunked mode assembles it from per-chapter partials)",
      },
      {
        name: "glossary-validation-rolling-state.json",
        level: "required",
        shape: "json",
        why: "the acceptance window this volume was accepted on — the skip-check reads it",
      },
      {
        name: "glossary-new-terms.json",
        level: "expected",
        shape: "json",
        why: "the new-terms extraction snapshot the handoff summarizes",
      },
      {
        name: "glossary-coverage.md",
        level: "expected",
        shape: "document",
        why: "the deterministic coverage audit (no AI) — the hallucinated-entry check",
      },
      {
        name: "glossary-coverage.json",
        level: "expected",
        shape: "json",
        why: "the machine-readable half of the coverage audit",
      },
      {
        name: "glossary-research.md",
        level: "expected",
        shape: "document",
        why: "the per-term research notes",
        when: researchEnabled,
      },
    ],
    series: [
      {
        name: "glossary.md",
        level: "required",
        shape: "table",
        why: "the newest per-volume snapshot, published as the series' canonical glossary",
      },
      {
        name: "glossary.md.provenance.json",
        level: "expected",
        shape: "json",
        why: "which volume snapshot the root copy came from",
      },
    ],
    quarantines: [QUARANTINED_CUMULATIVE],
  },

  "character-voice": {
    step: "character-voice",
    perVolume: true,
    volume: [
      {
        name: "character-voice.md",
        level: "required",
        shape: "document",
        why: "the cumulative character voice reference",
      },
      {
        name: "pov-map.md",
        level: "required",
        shape: "document",
        why: "this volume's POV map (per-volume, so it is the one file the seed does not copy)",
      },
      {
        name: "character-voice-validation.md",
        level: "required",
        shape: "document",
        why: "the validator's report",
      },
      {
        name: "character-voice-validation-rolling-state.json",
        level: "required",
        shape: "json",
        why: "the acceptance window this volume was accepted on",
      },
      {
        name: "character-voice-new.json",
        level: "expected",
        shape: "json",
        why: "the quirk/POV extraction snapshot the handoff summarizes",
      },
    ],
    series: [
      {
        name: "character-voice.md",
        level: "required",
        shape: "document",
        why: "the newest per-volume snapshot, published at the series root",
      },
      {
        name: "character-voice.md.provenance.json",
        level: "expected",
        shape: "json",
        why: "which volume snapshot the root copy came from",
      },
    ],
    quarantines: [QUARANTINED_CUMULATIVE],
  },

  "style-guide": {
    step: "style-guide",
    perVolume: true,
    volume: [
      {
        name: "style-guide.md",
        level: "required",
        shape: "document",
        why: "the cumulative style guide — how source constructs are rendered",
      },
      {
        name: "style-guide-validation.md",
        level: "required",
        shape: "document",
        why: "the validator's report",
      },
      {
        name: "style-guide-validation-rolling-state.json",
        level: "required",
        shape: "json",
        why: "the acceptance window this volume was accepted on",
      },
      {
        name: "style-guide-new.json",
        level: "expected",
        shape: "json",
        why: "the style-observation extraction snapshot the handoff summarizes",
      },
    ],
    series: [
      {
        name: "style-guide.md",
        level: "required",
        shape: "document",
        why: "the newest per-volume snapshot, published at the series root",
      },
      {
        name: "style-guide.md.provenance.json",
        level: "expected",
        shape: "json",
        why: "which volume snapshot the root copy came from",
      },
    ],
    quarantines: [QUARANTINED_CUMULATIVE],
  },

  "jump-in-wiki": {
    step: "jump-in-wiki",
    perVolume: true,
    volume: [
      {
        name: "wiki.md",
        level: "required",
        shape: "document",
        why: "this volume's wiki",
      },
      {
        name: "shared-wiki.md",
        level: "required",
        shape: "document",
        why: "series state through this volume — the story background the translator reads",
      },
      {
        name: "jump-in-wiki-validation-{installment}.md",
        level: "required",
        shape: "document",
        why: "the validator's report for this volume",
      },
      {
        name: "jump-in-wiki-validation-{installment}-rolling-state.json",
        level: "required",
        shape: "json",
        why: "the acceptance window this volume was accepted on",
      },
      {
        name: "chapters.json",
        level: "required",
        shape: "json",
        why: "the deterministic translation handoff's chapter list",
      },
      {
        name: "translation-brief.md",
        level: "required",
        shape: "document",
        why: "the one-page brief — what is new in this volume, and a completeness check",
      },
    ],
    series: [
      {
        name: "shared-wiki.md",
        level: "required",
        shape: "document",
        why: "the last publishable per-volume copy, published at the series root",
      },
      {
        name: "shared-wiki.md.provenance.json",
        level: "expected",
        shape: "json",
        why: "which volume snapshot the root copy came from",
      },
    ],
    quarantines: [],
  },

  "consistency-audit": {
    step: "consistency-audit",
    perVolume: false,
    volume: [],
    series: [
      {
        name: "consistency-report.md",
        level: "required",
        shape: "document",
        why: "the pre-translation sign-off",
      },
      {
        name: "consistency-report.md.provenance.json",
        level: "expected",
        shape: "json",
        why: "the fingerprint of the four audited artifacts — what makes the report re-runnable",
      },
    ],
    quarantines: [],
  },

  translate: {
    step: "translate",
    perVolume: true,
    volume: [
      {
        name: "translation.md",
        level: "required",
        shape: "document",
        why: "the merged volume — what the pipeline publishes",
      },
      {
        name: "translation-state.json",
        level: "required",
        shape: "json",
        why: "the per-chapter idempotency state",
      },
      {
        name: "translation-qa.md",
        level: "expected",
        shape: "document",
        why: "the deterministic QA report, including the reference material the model did NOT see",
      },
    ],
    series: [],
    quarantines: [QUARANTINED_DRAFT],
  },

  "verify-translate": {
    step: "verify-translate",
    perVolume: true,
    volume: [
      {
        name: "translation-verification.json",
        level: "required",
        shape: "json",
        why: "the per-chapter verdicts `retranslate` and the publish gate read",
      },
      {
        name: "translation-verification.md",
        level: "expected",
        shape: "document",
        why: "the human-readable verification report",
      },
      {
        name: "volume-consistency.md",
        level: "expected",
        shape: "document",
        why: "the cross-chapter audit — the drift a per-chapter check cannot see",
        when: volumeConsistencyEnabled,
      },
      {
        name: "volume-consistency.json",
        level: "expected",
        shape: "json",
        why: "the machine-readable half of the cross-chapter audit",
        when: volumeConsistencyEnabled,
      },
    ],
    series: [
      {
        name: "glossary-disputes.md",
        level: "expected",
        shape: "document",
        why: "the terminology challenges the verifier raised — the glossary task must settle them",
      },
    ],
    quarantines: [QUARANTINED_DRAFT],
  },

  retranslate: {
    step: "retranslate",
    perVolume: true,
    volume: [
      {
        name: "translation.md",
        level: "required",
        shape: "document",
        why: "retranslate re-merges the volume after every repair",
      },
      {
        name: "translation-state.json",
        level: "required",
        shape: "json",
        why: "a retranslate bumps draftHash and clears the polish marks",
      },
    ],
    series: [],
    quarantines: [QUARANTINED_DRAFT],
  },

  "translate-qa": {
    step: "translate-qa",
    perVolume: true,
    volume: [
      {
        name: "translation-verification.json",
        level: "required",
        shape: "json",
        why: "the loop's verdicts (its verify half writes them)",
      },
      {
        name: "translation.md",
        level: "required",
        shape: "document",
        why: "the loop re-merges after every retranslate batch",
      },
      {
        name: "translation-state.json",
        level: "required",
        shape: "json",
        why: "the ratchet baseline lives here",
      },
    ],
    series: [],
    quarantines: [QUARANTINED_DRAFT],
  },

  polish: {
    step: "polish",
    perVolume: true,
    volume: [
      {
        name: "translation.md",
        level: "required",
        shape: "document",
        why: "polish re-merges the volume (polished text wins when it was accepted)",
      },
      {
        name: "translation-state.json",
        level: "required",
        shape: "json",
        why: "the polish marks (polishedDraftHash / polishVerifiedDraftHash) live here",
      },
      {
        name: "polish-verification.json",
        level: "expected",
        shape: "json",
        why: "the drift inspector's verdicts",
        when: polishVerifyEnabled,
      },
      {
        name: "polish-qa.md",
        level: "expected",
        shape: "document",
        why: "the polish regression-guard report",
      },
    ],
    series: [],
    quarantines: [QUARANTINED_DRAFT],
  },

  "translation-report": {
    step: "translation-report",
    perVolume: false,
    volume: [],
    series: [
      {
        name: "translation-report.md",
        level: "required",
        shape: "document",
        why: "the deterministic roll-up of what the pipeline actually published",
      },
      {
        name: "translation-report.json",
        level: "required",
        shape: "json",
        why: "the machine-readable half",
      },
      {
        name: "translation-report.md.provenance.json",
        level: "expected",
        shape: "json",
        why: "the sidecar every other series-root copy carries",
      },
    ],
    quarantines: [],
  },
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

// ─── Lookups ──────────────────────────────────────────────────────────────────

/**
 * The expectations for one step, or null when the step is not declared here.
 *
 * Returning null (rather than an empty spec) is deliberate: an undeclared step
 * must be visible as a gap in the post-mortem, not silently pass.
 *
 * @param {string} step - A gulp task name.
 * @returns {StepArtifactSpec|null}
 */
function specForStep(step) {
  return STEP_ARTIFACT_SPECS[step] || null;
}

/**
 * Every declared step name.
 * @returns {string[]}
 */
function declaredSteps() {
  return Object.keys(STEP_ARTIFACT_SPECS);
}

module.exports = {
  STEP_ARTIFACT_SPECS,
  specForStep,
  declaredSteps,
  isKnownVolumeFile,
  KNOWN_VOLUME_FILE_PATTERNS,
};
