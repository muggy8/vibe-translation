/**
 * Reading the half-built run without reading the code: the plan of record, what each volume folder actually holds, and the HIGH findings split into DAMAGE (work is missing — this decides where to pick up) and EVIDENCE (a gate refused something — read it, it is not a reason to rebuild). A quarantine belongs to the artifact it NAMES, not to every step that declares the pattern, and a declared name is a template, not a file name.
 *
 * Part of the resume.js layer (split out of the original single file).
 */

const fs = require("fs");
const path = require("path");
const { PIPELINE_STEPS } = require("../../gulpfile");
const { STEP_ARTIFACT_SPECS, specForStep } = require("../artifacts");
const { runPostMortem } = require("../postmortem");
const { readLedger, recurringFindings } = require("../ledger");
const { readTickets } = require("../tickets");
const { readPatches } = require("../patches");
const { runInProgress } = require("../runlock");
const { validateManifest } = require("../../get-translation-target");
const { readTranslationReport, summarizeReportRows } = require("../translation-report");

const { EVIDENCE_KINDS, actionByName } = require("./menu");

/**
 * Read the plan of record straight off the disk.
 *
 * Deliberately NOT `getTranslationTarget()`: that is the door to the intake agent, and a
 * triage that reads the state must not be able to spend a token. The validation is the same
 * one (`validateManifest`), and a plan that fails it is reported as a problem rather than
 * handed on (gotcha 33).
 *
 * @param {string} seriesDir
 * @returns {{manifest: Object|null, problem: string|null}}
 */
function readPlanOfRecord(seriesDir) {
  const file = path.join(seriesDir, "translation-target.json");
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    return {
      manifest: null,
      problem:
        err && err.code === "ENOENT"
          ? `no plan of record at ${file} — nothing can run until the intake step has produced one`
          : `the plan of record could not be read (${err.message})`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { manifest: null, problem: `the plan of record is not valid JSON (${err.message})` };
  }
  try {
    validateManifest(parsed);
  } catch (err) {
    return { manifest: null, problem: `the plan of record does not validate: ${err.message}` };
  }
  return { manifest: parsed, problem: null };
}


/**
 * What one volume folder actually holds, against what every step that runs on a volume is
 * declared to leave there.
 *
 * @param {string} seriesDir
 * @param {import("../types").TranslationTargetVolume} volume
 * @returns {VolumeInventory}
 */
/**
 * A declared artifact name, with its `{installment}` placeholder filled in — because the
 * declaration in `utils/artifacts.js` is a template (`jump-in-wiki-validation-{installment}.md`)
 * and the disk holds the real file name. Comparing the two without resolving the placeholder
 * reports a step's output as missing when it is sitting right there, and puts a literal
 * `{installment}` in a wipe list, where it deletes nothing.
 *
 * @param {string} name - The declared name.
 * @param {string} installment - The volume's `NN`.
 * @returns {string}
 */
function resolveDeclaredName(name, installment) {
  return name.replace(/\{installment\}/g, String(installment || ""));
}


/**
 * Which step a quarantine file in a volume folder is evidence ABOUT.
 *
 * The patterns are shared: `utils/artifacts.js` declares the same
 * `^(glossary|character-voice|style-guide)\.md\.rejected$` expectation for all three cumulative
 * steps, because all three gates quarantine the same shape of file. Matching the pattern alone
 * therefore calls a `character-voice.md.rejected` glossary's evidence — and the triage then
 * reports "glossary's own gate removed this file" for a volume whose glossary gate never fired,
 * which is the wrong reason to stop a rebuild. The honest test is the artifact the quarantine
 * NAMES: strip the suffix, and ask which step declares that file.
 *
 * @param {string} step
 * @param {string} name - A file name present in the volume folder.
 * @param {string} installment
 * @returns {boolean}
 */
function quarantineBelongsToStep(step, name, installment) {
  const spec = specForStep(step);
  if (!spec || !spec.perVolume) return false;
  if (!spec.quarantines.some((q) => q.pattern.test(name))) return false;
  const stem = name.replace(/\.rejected(-passage)?\.md$/, "").replace(/\.rejected$/, "");
  return spec.volume.some((expect) => resolveDeclaredName(expect.name, installment) === stem);
}


function inventoryVolume(seriesDir, volume) {
  const volumeDir = path.join(seriesDir, volume.folder);
  /** @type {VolumeInventory} */
  const out = {
    folder: volume.folder,
    installment: String(volume.installmentNumber || "?"),
    exists: false,
    fileCount: 0,
    quarantines: [],
    quarantinedForStep: [],
    missingForStep: [],
  };

  let names = [];
  try {
    names = fs.readdirSync(volumeDir);
    out.exists = true;
    out.fileCount = names.length;
  } catch {
    return out;
  }

  out.quarantines = names.filter((n) => /\.rejected/.test(n));

  const present = new Set(names);
  for (const step of Object.keys(STEP_ARTIFACT_SPECS)) {
    const spec = STEP_ARTIFACT_SPECS[step];
    if (!spec.perVolume) continue;
    const missing = spec.volume
      .filter((expect) => expect.level === "required" && !present.has(resolveDeclaredName(expect.name, out.installment)))
      .map((expect) => resolveDeclaredName(expect.name, out.installment));
    if (missing.length) out.missingForStep.push({ step, files: missing });
    // Which step's gate evidence is lying in this folder — attributed to the step whose artifact
    // the file names, not to every step that declares the same quarantine pattern.
    if (out.quarantines.some((n) => quarantineBelongsToStep(step, n, out.installment))) {
      out.quarantinedForStep.push(step);
    }
  }
  return out;
}


/**
 * The deliverable, as the pipeline itself describes it.
 *
 * This is the manager's goal function (plan §8): `translation-report.md`, not the exit code.
 * A run that finished green and published 40 UNVERIFIED chapters is a failed delivery, and
 * the only way to see that is to read the roll-up.
 *
 * The reading and the bucketing both come from `utils/translation-report.js` — the module
 * that writes the file — so the triage and `utils/delivery-verify.js` (which decides whether
 * an intervention helped) cannot end up counting one report two different ways.
 *
 * @param {string} seriesDir
 * @returns {Promise<Object|null>} - null when the report does not exist yet.
 */
async function readDeliverable(seriesDir) {
  const report = await readTranslationReport(seriesDir);
  if (!report) return null;
  const counts = summarizeReportRows(report.chapters);

  /** @type {Object<string, {total: number, published: number, unverified: number, missing: number}>} */
  const byVolume = {};
  for (const row of report.chapters) {
    const v = String(row.volume);
    byVolume[v] = byVolume[v] || { total: 0, published: 0, unverified: 0, missing: 0 };
    byVolume[v].total += 1;
    const outcome = typeof row.outcome === "string" ? row.outcome : "";
    const key = outcome.startsWith("PUBLISHED")
      ? "published"
      : outcome.startsWith("UNVERIFIED")
        ? "unverified"
        : outcome.startsWith("MISSING")
          ? "missing"
          : null;
    if (key) byVolume[v][key] += 1;
  }
  return { file: report.file, generatedAt: report.generatedAt, counts, byVolume };
}


/**
 * `DELIVERY_MAX_INTERVENTIONS` — how many interventions the manager may make **on one step**
 * before it must stop acting on that step and write a report / open a ticket instead.
 *
 * Per step, not per run (account owner, 2026-10-06). A run with nine steps is not one problem:
 * a global cap spends glossary's attempts on the wiki, and the step that is genuinely stuck is
 * the one that ends up with none. The anti-spin gate in `utils/ledger.js` is a separate limit
 * and still applies inside a step — this one bounds how much the manager may keep doing to one
 * step even when every attempt is a different action against a different finding.
 *
 * @returns {number} - Default 5, minimum 1.
 */
function maxInterventionsPerStep() {
  const n = parseInt(process.env.DELIVERY_MAX_INTERVENTIONS, 10);
  return Number.isFinite(n) && n >= 1 ? n : 5;
}


/**
 * How many interventions this run has already made on each step, read out of the ledger.
 *
 * Only `kind: "intervention"` entries count — an `assessment` is the pipeline reporting what it
 * found, not the manager doing something about it. Only the current run counts, for the same
 * reason the anti-spin count is per run: a real fix must not be frozen out of the next run.
 *
 * And only the actions the menu says are interventions count against the **budget**. Act mode
 * records everything it does, including the free ones, because "what did the manager do" is a
 * question a human has to be able to audit; the menu's `countsAsIntervention` is what decides
 * which of those spend the step's allowance. An action that is not on the menu counts: an
 * unknown action cannot be waved through by not recognising it.
 *
 * @param {Array<Object>} entries - Ledger entries.
 * @param {string|null} run - The run to count.
 * @returns {Object<string, number>} - Step name -> interventions used.
 */
function interventionsUsed(entries, run) {
  /** @type {Object<string, number>} */
  const out = {};
  if (!run) return out;
  for (const e of entries || []) {
    if (!e || e.kind !== "intervention" || e.run !== run || !e.step) continue;
    const action = actionByName(e.action);
    if (action && !action.countsAsIntervention) continue;
    out[e.step] = (out[e.step] || 0) + 1;
  }
  return out;
}


/**
 * The attempts this run already made on each step that did NOT move the deliverable, read out of
 * the ledger.
 *
 * `interventionsUsed` counts attempts, which is the right thing for an allowance and the wrong
 * thing for a decision: an attempt that `improved` is not evidence against anything, and an attempt
 * that ended `unchanged` or `worse` is. This is the second question, and it is what lets the triage
 * see a failed repair rather than only a spent budget.
 *
 * The distinction it exists to make: the loop is allowed to keep going after a step fails, and the
 * thing that decides whether "keep going" means *try again* or *ask somebody who can read why* is
 * this record. Without it the only way the triage learns an attempt failed is the disk shape that
 * attempt happened to leave behind — and a step killed part-way through its work leaves a shape that
 * looks exactly like "the work was never done".
 *
 * Only the newest recorded run counts, for the same reason the anti-spin count is per run: a real
 * fix must not be frozen out of the next one.
 *
 * @param {Array<Object>} entries - Ledger entries.
 * @param {string|null} run - The run to read.
 * @returns {Object<string, Array<{id: string, action: string|null, finding: string|null, outcome: string}>>}
 *   Step name -> the attempts that did not help, oldest first.
 */
function unhelpfulInterventions(entries, run) {
  /** @type {Object<string, Array<{id: string, action: string|null, finding: string|null, outcome: string}>>} */
  const out = {};
  if (!run) return out;
  for (const e of entries || []) {
    if (!e || e.kind !== "intervention" || e.run !== run || !e.step) continue;
    if (e.outcome !== "unchanged" && e.outcome !== "worse") continue;
    if (!out[e.step]) out[e.step] = [];
    out[e.step].push({
      id: e.id,
      action: e.action || null,
      finding: e.finding || null,
      outcome: e.outcome,
    });
  }
  return out;
}


/**
 * Read everything a resume decision needs. No model call, no network, no writes.
 *
 * @param {Object} [opts]
 * @param {string} [opts.seriesDir] - Defaults to `SERIES_LOCATION`.
 * @param {Object} [opts.manifest] - Pass a plan of record to use instead of reading one.
 * @returns {Promise<{seriesDir: string, manifest: Object|null, manifestProblem: string|null,
 *   volumes: VolumeInventory[], stepStates: ResumeStepState[], recurring: Array,
 *   run: string|null, interventionsByStep: Object<string, number>, interventionBudget: number,
 *   unhelpfulInterventionsByStep: Object<string, Array>, ledgerError: string|null,
 *   tickets: Array, ticketsError: string|null,
 *   patches: Array, patchesError: string|null, deliverable: Object|null}>}
 */
async function readWorkingState({ seriesDir, manifest } = {}) {
  const dir = path.resolve(seriesDir || process.env.SERIES_LOCATION || process.cwd());
  const plan = manifest === undefined ? readPlanOfRecord(dir) : { manifest, problem: null };

  const volumes = ((plan.manifest && plan.manifest.volumes) || []).map((v) => inventoryVolume(dir, v));

  /** @type {ResumeStepState[]} */
  const stepStates = [];
  if (plan.manifest) {
    for (const { name } of PIPELINE_STEPS) {
      const report = await runPostMortem({ step: name, seriesDir: dir, manifest: plan.manifest });
      const findings = report.findings || [];
      const high = findings.filter((f) => f.severity === "HIGH");
      // Fail closed: a HIGH finding is damage unless it is explicitly the "a gate left its
      // evidence" class. A new finding kind added to utils/postmortem.js must not become
      // invisible here by not being listed in DAMAGE_KINDS.
      const damage = high.filter((f) => !EVIDENCE_KINDS.has(f.kind));
      const evidence = high.filter((f) => EVIDENCE_KINDS.has(f.kind));
      const namedVolumes = (list) =>
        [...new Set(list.filter((f) => f.volume).map((f) => String(f.volume)))].sort();
      stepStates.push({
        step: name,
        status: report.error
          ? "unknown"
          : damage.length
            ? "incomplete"
            : evidence.length
              ? "quarantined"
              : findings.some((f) => f.severity === "MEDIUM" || f.severity === "LOW")
                ? "gaps"
                : "complete",
        damageKinds: [...new Set(damage.map((f) => f.kind))],
        evidenceKinds: [...new Set(evidence.map((f) => f.kind))],
        // The findings themselves, not just their classes. When act mode has to open a ticket it
        // must cite what it looked at, and the only thing it looked at is this assessment — so
        // the citation has to come from here rather than be re-derived from a file that a triage
        // does not write.
        damageFindings: damage.map((f) => ({
          kind: f.kind,
          file: f.file,
          volume: f.volume,
          message: f.message,
        })),
        evidenceFindings: evidence.map((f) => ({
          kind: f.kind,
          file: f.file,
          volume: f.volume,
          message: f.message,
        })),
        volumes: namedVolumes(damage),
        evidenceVolumes: namedVolumes(evidence),
        notes: findings
          .filter((f) => f.severity !== "HIGH")
          .map((f) => `${f.severity} ${f.kind}${f.volume ? ` volume ${f.volume}` : ""}: ${f.message}`),
        error: report.error || null,
      });
    }
  }

  const ledger = readLedger();
  // `recurringFindings` asks "in the CURRENT run, and also in an earlier one". A resume triage
  // has no run of its own — it is reading what previous runs left — so the run it means is the
  // newest one recorded. Passing no run id at all makes the check silently return nothing,
  // which is the failure mode gotcha 67 exists to prevent.
  const entries = ledger.entries || [];
  const latestRun = entries.length ? entries[entries.length - 1].run : null;

  // The manager's own two channels, read into the same snapshot. They belong here rather than in
  // `planResume` for the same reason the ledger is read here: `planResume` is a **pure function of
  // a state snapshot**, and a triage decision that reached for `tickets.json` by itself would make
  // a hand-built test state silently read the real series' ticket history (gotcha 71's trap, in a
  // new costume). It also belongs here because these are the manager's own records — the ticket it
  // wrote and the patch it was handed are the two things in this layer that a customer is allowed
  // to read, and without them the triage can only describe the disk, which means it re-escalates
  // the same shape forever after a fix has already answered it.
  const tickets = readTickets();
  const patches = readPatches();

  // Who is holding the pipeline right now, and whether it is doing anything. This belongs in the
  // snapshot for the same reason the ledger does: `planResume` is a pure function of the snapshot,
  // and a triage that reached for `run.lock` by itself would make a hand-built test state read the
  // real series' lock (gotcha 71's trap again). A snapshot without this field reads as "nothing is
  // running", which is the safe default for a hand-built one.
  let runLock = { present: false, stalled: false, idleMinutes: null, beats: 0, note: null, error: null };
  try {
    const running = runInProgress();
    if (running.lock || running.error) {
      runLock = {
        present: true,
        stalled: running.stalled === true,
        idleMinutes: running.idleMinutes,
        beats: running.beats,
        note: running.note,
        error: running.error,
      };
    }
  } catch (err) {
    runLock.error = err.message;
  }

  return {
    seriesDir: dir,
    manifest: plan.manifest,
    manifestProblem: plan.problem,
    volumes,
    stepStates,
    recurring: latestRun ? recurringFindings(entries, latestRun) : [],
    run: latestRun,
    interventionsByStep: interventionsUsed(entries, latestRun),
    unhelpfulInterventionsByStep: unhelpfulInterventions(entries, latestRun),
    interventionBudget: maxInterventionsPerStep(),
    ledgerError: ledger.error || null,
    tickets: tickets.tickets,
    ticketsError: tickets.error || null,
    patches: patches.patches,
    patchesError: patches.error || null,
    runLock,
    deliverable: await readDeliverable(dir),
  };
}

// ─── The plan ─────────────────────────────────────────────────────────────────


module.exports = {
  readPlanOfRecord,
  resolveDeclaredName,
  quarantineBelongsToStep,
  inventoryVolume,
  readDeliverable,
  maxInterventionsPerStep,
  interventionsUsed,
  unhelpfulInterventions,
  readWorkingState,
};
