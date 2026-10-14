/**
 * utils/series-run/findings.js — the door a step uses to say what it found while it was running.
 *
 * The delivery layer assesses a finished step **from the disk**. A stage that discovered something mid-run
 * — a term-list read that never produced a list, a chapter whose answer never closed — could describe it,
 * print it, and lose it, because nothing on the stage's own context object is on the disk. That is gotcha
 * 138, and the record format and the reading half of it live in `utils/postmortem/channel.js`.
 *
 * This file is only the door a *stage* stands behind: it names the volume, resolves the run's records
 * folder at CALL time (gotcha 94 — never at require time; gotcha 80 — never from this module's own
 * location), works out which book the report is about, and hands the findings over. A stage should not
 * have to know where the run keeps its memory, and it should not be able to reach into the post-mortem's
 * internals to do it.
 *
 * **What the door refuses, and why.**
 *   - `--dry-run` writes nothing. A rehearsal that sent no model call has not learned anything about the
 *     book, and a record it invented would be read back by a later real run as a fact.
 *   - a report with no source identity is refused. A record that can never pass the staleness check buries
     the finding it was carrying, so the door says it could not write rather than writing something the
 *     assessment will throw away.
 *   - a level is never accepted. The caller's `level` / `levelDeclared` are dropped on the way in and the
 *     level is looked up from `utils/postmortem/levels.js` when the record is read (AGENTS.md rule 3).
 *
 * **When NOT to call it.** A volume whose reading pass never ran has not reported anything, and writing an
 * empty record for it would overwrite the record an earlier pass left — which is how a hole gets erased by
 * a run that never looked at the book. The caller decides that, and the glossary stage's rule is: report
 * when the reading pass ran, stay silent when it did not.
 *
 * Part of the series-run layer (utils/series-run.js).
 */

const path = require("path");

const { postMortemDir } = require("../../configs/run-state");
const { sha256Of, writeChannelRecord } = require("../postmortem/channel");
const { readRunArgs } = require("./args");

/** @typedef {import("../postmortem").PostMortemFinding} PostMortemFinding */
/** @typedef {import("../postmortem/channel").ChannelRecord} ChannelRecord */

/**
 * The book one volume's report is about, as two recorded facts: the file name inside the volume folder and
 * its sha256.
 *
 * This is the same fingerprint the idempotency skip-check compares (`utils/series-run/skip.js` →
 * `isSourceStale`), which is why it is the right identity here: it is already computed, already recorded,
 * and already the thing that says "the artifacts on disk were written from a different book". A timestamp
 * would say "this record is old", which is a different question and the wrong one — gotcha 114.
 *
 * @param {{ volumeDir: string, bundle: { originalPath?: string, sourceFingerprint?: string|null } }} opts
 * @returns {{sourceFile: string, sourceFingerprint: string|null}} `sourceFingerprint` is null when the
 *   bundle carried none and the file cannot be read — which {@link reportVolumeFindings} refuses.
 */
function volumeSourceIdentity({ volumeDir, bundle }) {
  const originalPath = String((bundle && bundle.originalPath) || "");
  if (!originalPath) return { sourceFile: "", sourceFingerprint: null };
  const sourceFile = path.relative(volumeDir, originalPath) || path.basename(originalPath);
  const fingerprint = (bundle && bundle.sourceFingerprint) || sha256Of(originalPath);
  return { sourceFile, sourceFingerprint: fingerprint || null };
}

/**
 * Record what this step found about this volume, so the assessment of this volume can find it.
 *
 * Call it once per volume, at the end of the step's own work on that volume — before the shared loop
 * assesses it (`utils/series-run/loop.js`), which is what lets a MAJOR arriving through the channel halt
 * the walk at the volume boundary instead of being printed and forgotten.
 *
 * Never throws. A channel that cannot write is reported, not fatal: a step must not die because the pipe
 * that carries its findings is broken, and the finding it is carrying is still real.
 *
 * @param {Object} opts
 * @param {string} opts.step - The gulp task name, exactly as `utils/artifacts.js` spells it. The assessment
 *   only honours a record for the step it is assessing, so a step that misnames itself reports nothing.
 * @param {import("../../types").TranslationTargetVolume} opts.volumeEntry - The volume this report is about.
 * @param {string} opts.volumeDir - That volume's folder.
 * @param {import("../../types").SourceBundle} opts.bundle - The source this step actually read.
 * @param {PostMortemFinding[]} opts.findings - What the step found, built with `utils/postmortem`'s own
 *   `finding()`. An empty list is an honest answer and is recorded as one.
 * @param {boolean} [opts.dryRun] - `--dry-run` writes nothing. Defaults to this process's own flags.
 * @returns {Promise<{written: boolean, file: string, count: number, refused: string[], error: string|null, reason: string|null}>}
 */
async function reportVolumeFindings({ step, volumeEntry, volumeDir, bundle, findings, dryRun }) {
  if (dryRun === undefined || dryRun === null ? readRunArgs().dryRun : dryRun) {
    return { written: false, file: "", count: 0, refused: [], error: null, reason: "dry-run writes no run records" };
  }

  const identity = volumeSourceIdentity({ volumeDir, bundle });
  const result = writeChannelRecord({
    runDir: postMortemDir(),
    step: String(step),
    volume: volumeEntry && volumeEntry.installmentNumber,
    folder: volumeEntry && volumeEntry.folder,
    identity,
    findings: findings || [],
  });

  for (const refused of result.refused) console.error(`[findings] ${step} volume ${volumeEntry && volumeEntry.installmentNumber}: refused — ${refused}`);
  if (result.written && result.count > 0) {
    console.error(
      `[findings] ${step} volume ${volumeEntry.installmentNumber}: reported ${result.count} finding(s) to the ` +
        `run's records (${result.file}). The level is the level table's, not this step's.`
    );
  }
  if (!result.written && result.error) {
    console.error(
      `[findings] ${step} volume ${volumeEntry && volumeEntry.installmentNumber}: could not record what this ` +
        `step found (${result.error}) — the finding stays inside this process, which is the hole this door exists to close.`
    );
  }
  return { ...result, reason: null };
}

module.exports = { reportVolumeFindings, volumeSourceIdentity };
