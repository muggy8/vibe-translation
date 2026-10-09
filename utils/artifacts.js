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
 *   - `run`         — files a delivery command must leave in the folder a run remembers
 *                     itself in (`<POSTMORTEM_DIR>/`): the plan of record, the ticket
 *                     channel, the patch channel
 *   - `quarantines` — files whose PRESENCE is itself a finding (a `.rejected`
 *     file means a gate fired; the pipeline kept it as evidence, and an
 *     un-monitored run never looks at it)
 * The assessment itself (what to do with this data) lives in utils/postmortem.js, and the
 * delivery layer's cross-record questions in utils/delivery-audit.js.
 *
 * Two rules this file deliberately keeps:
 *   1. `required` is only used where the pipeline writes the file on EVERY path
 *      it can reach. Over-declaring is worse than under-declaring: gotcha 65's
 *      carry-forward guard called an improvement a loss and threw away good work.
 *      A check that fires on healthy output trains everyone to ignore the check.
 *      For the delivery commands, which legitimately write nothing on several of
 *      their paths, the `when` predicate carries the same guarantee: the expectation
 *      applies when the command claims it wrote the record, and `required` then
 *      means the claim is not backed by the disk.
 *   2. Shape is checked the way the existing gates check it — a Markdown heading
 *      or a table (`hasDocumentShape` in utils/fs.js), because every prompt in
 *      this pipeline that writes one of these documents specifies that shape.
 *
 * The code lives in utils/artifacts/: rules.js (the conditions a file is expected under, the
 * evidence a gate leaves, and the files a volume folder may legitimately hold), preproduction.js
 * (what the six pre-production steps owe), translation.js (what the six translation-stage steps
 * owe), specs.js (the one table and the two questions asked of it). This file is the public
 * surface, and the shapes the post-mortem names in its JSDoc.
 *
 * @module utils/artifacts
 */

require("../types"); // JSDoc type definitions

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * What one file a step is supposed to produce.
 *
 * @typedef {Object} ArtifactExpectation
 * @property {string} name - File name, relative to the volume folder (to the series root for a
 *   `series` expectation, or to the run folder for a `run` expectation). `{installment}` is
 *   replaced with the volume's two-digit installment number, for the per-volume reports whose
 *   names carry it (`jump-in-wiki-validation-{installment}.md`).
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
 * @property {boolean} [planRecordClaimed] - The delivery command reported it wrote the plan of record
 * @property {boolean} [ticketRecordClaimed] - It reported it wrote the ticket channel
 * @property {boolean} [patchRecordClaimed] - It reported it wrote the patch channel
 * @property {boolean} [acting] - The command ran in the mode that touches the run (act), not the
 *   mode that only reports (report / watch)
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
 * @property {string} step - The gulp task name (a `TASKS` entry in utils/hooks.js), or a delivery
 *   command name (a `DELIVERY_COMMANDS` entry in utils/artifacts/delivery.js).
 * @property {boolean} perVolume - Whether the step writes per-volume artifacts at all.
 *   `discover` and `consistency-audit` work at the series level only.
 * @property {ArtifactExpectation[]} volume
 * @property {ArtifactExpectation[]} series
 * @property {ArtifactExpectation[]} [run] - Expectations resolved against the run folder
 *   (`POSTMORTEM_DIR`). Only the delivery commands declare it.
 * @property {QuarantineExpectation[]} quarantines
 */

const rules = require("./artifacts/rules");
const specs = require("./artifacts/specs");
const delivery = require("./artifacts/delivery");

// The public surface, unchanged from the single file, plus the delivery layer's names.
module.exports = {
  STEP_ARTIFACT_SPECS: specs.STEP_ARTIFACT_SPECS,
  specForStep: specs.specForStep,
  declaredSteps: specs.declaredSteps,
  DELIVERY_COMMANDS: delivery.DELIVERY_COMMANDS,
  isKnownVolumeFile: rules.isKnownVolumeFile,
  KNOWN_VOLUME_FILE_PATTERNS: rules.KNOWN_VOLUME_FILE_PATTERNS,
};
