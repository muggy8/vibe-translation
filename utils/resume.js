/**
 * utils/resume.js — where the work actually stopped.
 *
 * The question this answers is the one a resumed run has to answer before it does
 * anything: **"I'm coming back to this after a long weekend — which step do I call
 * next?"** Today nobody answers it. `npm run pipeline` always starts at step 1 and lets
 * the idempotent skip-checks no-op their way forward, which is correct but blind: it
 * cannot tell "volume 15's glossary was quarantined, so the next thing is to fix volume 15
 * and rebuild the tail" from "everything is fine, run the whole list again". Choosing the
 * whole list when the work is half-built is the most common form of the spinning this
 * design exists to prevent (gotcha 69), and it is expensive: on the live 17-volume series
 * a pointless pass over nine completed steps is nine container switches and a re-audit of
 * every artifact.
 *
 * What this module is: **the deterministic half of the delivery manager's judgment.** It
 * reads the working state off the disk and produces a step list with reasons. It makes no
 * model call, it costs nothing, and it runs on every resume — the same tier-1 principle
 * that makes `utils/postmortem.js` free (gotcha 67: a model call that audits things that
 * are fine turns the auditor into the costliest stage in the pipeline).
 *
 * What it reads is deliberately the same thing a *customer* could read, because the
 * delivery manager is a customer (AGENTS.md §3.6, plan §3):
 *   - the plan of record (the volume list and reading order),
 *   - what each volume folder actually holds versus what `utils/artifacts.js` says the step
 *     that built it always leaves,
 *   - the post-mortem reports for every step (`utils/postmortem.js`, run fresh — it is free),
 *   - the run ledger's recurring findings (`utils/ledger.js` — what survived an earlier run),
 *   - `translation-report.json` — the deliverable itself, which is the manager's goal
 *     function (a run that finishes with 40 UNVERIFIED chapters is a failed delivery even
 *     though it exited 0).
 *
 * What it never reads: `.logs/**` (transcripts belong to the diagnostics team), any `.js`,
 * `system-prompts/`, `user-prompts/`, `hooks/`. It also never calls `getTranslationTarget()`,
 * which could start the intake agent: it reads the plan of record straight off the disk and
 * validates it with the same validator, so a resume triage cannot accidentally spend a
 * token (gotcha 69's test half is the same hazard in a different costume).
 *
 * And what it never does: **decide the intake questions.** Volume 17's placement, volume 13's
 * narration, the reading order — those are the intake agent's decisions and the account
 * owner's (decided 2026-10-05). When this module finds that there is no plan of record it
 * says so and stops; it does not build one.
 *
 * @module utils/resume
 */

const fs = require("fs");
const path = require("path");
const { PIPELINE_STEPS } = require("../gulpfile");
const { STEP_ARTIFACT_SPECS, specForStep } = require("./artifacts");
const { runPostMortem } = require("./postmortem");
const { readLedger, recurringFindings } = require("./ledger");
const { validateManifest } = require("../get-translation-target");
const { seriesArtifactFile } = require("../configs/shared");
const { TRANSLATION_REPORT_JSON } = require("./translation-report");

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * One volume's folder as it actually is on disk.
 *
 * @typedef {Object} VolumeInventory
 * @property {string} folder
 * @property {string} installment - Normalized `NN` from the plan of record.
 * @property {boolean} exists - False when the folder the plan names is not there.
 * @property {number} fileCount
 * @property {string[]} quarantines - `.rejected` evidence present (kept, never wiped).
 * @property {string[]} quarantinedForStep - Steps whose gate evidence this folder holds, from
 *   the same `quarantines` declaration `utils/postmortem.js` reads.
 * @property {Array<{step: string, files: string[]}>} missingForStep - Per step: the declared
 *   required files this step always leaves, that are absent.
 */

/**
 * One step's assessment of the current state.
 *
 * @typedef {Object} ResumeStepState
 * @property {string} step
 * @property {("complete"|"gaps"|"quarantined"|"incomplete"|"unknown")} status - `unknown` means
 *   the assessment could not run, which is never read as clean (gotcha 67). `quarantined` means
 *   every required output is present and a gate's evidence is lying in a volume folder: read it,
 *   do not rebuild from it.
 * @property {string[]} damageKinds - HIGH kinds that mean work is missing or damaged. These
 *   decide where the run picks up.
 * @property {string[]} evidenceKinds - HIGH kinds that mean a gate refused something and left
 *   the evidence behind.
 * @property {string[]} volumes - Installment numbers the DAMAGE findings name, sorted.
 * @property {string[]} evidenceVolumes - Installments holding gate evidence.
 * @property {string[]} notes - MEDIUM/LOW gaps worth knowing, not actions.
 * @property {string|null} error - The assessment's own failure, when there is one.
 */

/**
 * One entry of the closed action menu (plan §4). The manager may only ever name an action
 * that is in this table, and the table says which of them count against
 * `DELIVERY_MAX_INTERVENTIONS` — a budget applied PER STEP, not per run.
 *
 * @typedef {Object} DeliveryAction
 * @property {string} name
 * @property {("A"|"B"|"C")} tier - A: act alone. B: capped. C: never available to the manager.
 * @property {string} what - What it does, in one line.
 * @property {string} primitive - The code that already implements it, or `—` for Tier C.
 * @property {boolean} countsAsIntervention - Decided 2026-10-05: **picking up work is not an
 *   intervention.** Deciding where to resume, and running a step that is simply unfinished,
 *   is the job. Throwing away output that already exists is an intervention.
 * @property {string} [why] - Tier C only: why it is not on the menu.
 */

/**
 * The plan: the step list to run, with the reason for each line.
 *
 * @typedef {Object} ResumeStepPlan
 * @property {string} step
 * @property {("none"|"run"|"after"|"blocked"|"ticket")} action
 * @property {string|null} actionName - A name from `DELIVERY_ACTIONS`, when there is one.
 * @property {string[]} reasons
 * @property {string|null} fromVolume - The earliest volume the findings name, when the step
 *   broke at a volume.
 * @property {boolean} cascade - True when the cumulative invariant will rebuild the tail.
 * @property {Array<{volumeDir: string, files: string[]}>} wipeFirst - Files to remove so the
 *   skip-checks cannot no-op the fix (gotcha 66). Declared outputs only — never quarantine
 *   evidence.
 * @property {string[]} flags - Flags to pass to the step. Deliberately never `--volume` on a
 *   cumulative cascade: `--force --volume NN` does not cascade (gotcha 66).
 * @property {boolean} countsAsIntervention
 */

/**
 * @typedef {Object} ResumePlan
 * @property {string} generatedAt
 * @property {string} seriesDir
 * @property {("resume"|"nothing-to-do"|"evidence"|"blocked")} verdict - `evidence` means every
 *   step finished what it claims to have and unread gate evidence is lying in a volume folder.
 * @property {string} headline - One line a human reads first.
 * @property {ResumeStepPlan[]} steps
 * @property {VolumeInventory[]} volumes - Every volume folder as it actually is.
 * @property {string[]} notes - Things that are not actions.
 * @property {Array<{finding: string, steps: string[], runs: number}>} recurring - Finding
 *   classes that survived an earlier recorded run: structural, not transient.
 * @property {string|null} run - The newest run recorded in the ledger.
 * @property {Object<string, number>} interventionsByStep - Interventions this run has already
 *   made on each step.
 * @property {number} interventionBudget - `DELIVERY_MAX_INTERVENTIONS`, applied PER STEP.
 * @property {Object|null} deliverable - The roll-up of `translation-report.json`.
 * @property {string} markdown
 */

// ─── The closed action menu (plan §4) ─────────────────────────────────────────

/**
 * The steps whose artifacts are cumulative: regenerating one volume forces every later
 * volume to regenerate (`regeneratedAny`, AGENTS.md §4/§5/§6/§7). This is what makes
 * "wipe the broken volume and re-run the step" the correct primitive instead of
 * "re-run one volume".
 */
const CUMULATIVE_STEPS = new Set(["glossary", "character-voice", "style-guide", "jump-in-wiki"]);

/**
 * The steps that work per chapter and are already idempotent per chapter, so a plain re-run
 * is the cheap answer and no wipe is needed.
 */
const CHAPTER_STATE_STEPS = new Set(["translate", "translate-qa", "polish"]);

/**
 * The HIGH findings that mean **work is missing or damaged** — the ones that decide where the
 * run picks up.
 *
 * The split exists because the first version of this module chose volume 02 as the resume point
 * on the live series, and volume 02's glossary is fine. What it found there was a `.rejected`
 * file: evidence that a gate fired at some point in a run that has since rebuilt that volume.
 * Choosing a resume point from *evidence a gate once fired* proposes throwing away thirteen
 * volumes of accepted work to deal with a leftover file — which is the destructive shape of
 * spinning, and it is exactly what a manager with no code access cannot see for itself.
 */
const DAMAGE_KINDS = new Set([
  "missing-required",
  "missing-volume-folder",
  "empty-or-stub",
  "bad-json",
  "wrong-shape",
  "chapter-without-draft",
  "accepted-without-acceptance",
  "audit-verdict-fail",
  "audit-verdict-missing",
  "step-undeclared",
]);

/**
 * The HIGH findings that mean **a gate refused something and left its evidence**. Read them;
 * they are not by themselves a reason to rebuild, and they are never wiped (Tier C).
 */
const EVIDENCE_KINDS = new Set(["quarantine-present"]);

/**
 * The manager's whole vocabulary of actions. Nothing outside this table exists for it.
 *
 * Tier C is written down here rather than left as prose for two reasons: the plan's
 * acceptance test asserts Tier C is refused, and a refusal has to name what it refused.
 * `countsAsIntervention` is the account owner's decision of 2026-10-05 — "picking up work
 * is not an intervention" — written where the code can act on it.
 *
 * @type {DeliveryAction[]}
 */
const DELIVERY_ACTIONS = [
  {
    name: "resume-here",
    tier: "A",
    what: "Start the run at this step instead of at step 1, and let the idempotent skip-checks no-op the finished work.",
    primitive: "index.js --stages=<from>",
    countsAsIntervention: false,
  },
  {
    name: "re-run-step",
    tier: "A",
    what: "Run a step again with no flags. Cheap: the skip-checks make it a no-op wherever the work is already done.",
    primitive: "index.js --stages=<step>",
    countsAsIntervention: false,
  },
  {
    name: "wipe-and-cascade",
    tier: "A",
    what: "Remove one volume's declared outputs for one step, then re-run the step over the whole series so the cumulative invariant rebuilds every later volume.",
    primitive: "wipeAttemptOutputs (utils/fs.js) + the step",
    countsAsIntervention: true,
  },
  {
    name: "re-audit",
    tier: "A",
    what: "Re-run the cross-artifact audit with --force.",
    primitive: "index.js --stages=consistency-audit --force",
    countsAsIntervention: true,
  },
  {
    name: "re-translate-volume",
    tier: "A",
    what: "Re-run the translation stage for a volume whose drafts or verdicts are missing.",
    primitive: "index.js --stages=translate,translate-qa,polish",
    countsAsIntervention: false,
  },
  {
    name: "re-run-chunked",
    tier: "B",
    what: "Force the chapter-by-chapter mode for a step whose whole-installment pass did not fit.",
    primitive: "index.js --stages=<step> --chunked",
    countsAsIntervention: true,
  },
  {
    name: "re-run-force",
    tier: "B",
    what: "Regenerate a step's outputs even where they already exist and passed. This throws away accepted work, so it is capped.",
    primitive: "index.js --stages=<step> --force",
    countsAsIntervention: true,
  },
  {
    name: "settle-disputes",
    tier: "B",
    what: "Re-run the glossary amend pass so it settles the open terminology disputes the verifier raised.",
    primitive: "index.js --stages=glossary --force",
    countsAsIntervention: true,
  },
  {
    name: "stop-and-report",
    tier: "B",
    what: "Stop, write the human-facing report, and leave the run where it is.",
    primitive: "delivery.js",
    countsAsIntervention: false,
  },
  {
    name: "open-ticket",
    tier: "B",
    what: "Ask the diagnostics team. Required when the same action against the same finding has already failed twice (utils/ledger.js).",
    primitive: "createTicket (utils/tickets.js)",
    countsAsIntervention: false,
  },

  // Tier C — never available, at any count, in any mode. Named here so a refusal can name it.
  {
    name: "disable-guard",
    tier: "C",
    what: "—",
    primitive: "—",
    countsAsIntervention: false,
    why: "the carry-forward gates are the only thing that can see a cumulative artifact lose terms (gotcha 64). Only the account owner may un-check one.",
  },
  {
    name: "allow-fail",
    tier: "C",
    what: "—",
    primitive: "—",
    countsAsIntervention: false,
    why: "--allow-fail / --allow-no-glossary skip the entry gate that stops a token being spent on a foundation that was never built.",
  },
  {
    name: "lower-threshold",
    tier: "C",
    what: "—",
    primitive: "—",
    countsAsIntervention: false,
    why: "PASSING_SCORE is the definition of good enough. Moving it redefines the question instead of improving the artifact.",
  },
  {
    name: "delete-evidence",
    tier: "C",
    what: "—",
    primitive: "—",
    countsAsIntervention: false,
    why: ".rejected files and reports are how a run explains itself, and they are the before-side of every acceptance comparison.",
  },
  {
    name: "edit-code",
    tier: "C",
    what: "—",
    primitive: "—",
    countsAsIntervention: false,
    why: "the manager has no code access. A code change is a dev-team proposal the manager accepts or rejects (plan §5).",
  },
  {
    name: "edit-hooks",
    tier: "C",
    what: "—",
    primitive: "—",
    countsAsIntervention: false,
    why: "hooks/ are per-machine configuration that decide which model grades the work (gotcha 22).",
  },
  {
    name: "rename-volume-folder",
    tier: "C",
    what: "—",
    primitive: "—",
    countsAsIntervention: false,
    why: "renaming a folder that holds pipeline output orphans every artifact built under the old name (gotcha 28).",
  },
  {
    name: "run-intake",
    tier: "C",
    what: "—",
    primitive: "—",
    countsAsIntervention: false,
    why: "intake is its own step with its own agent and guards. The manager may report that it is needed; it may not answer the intake questions (decided 2026-10-05).",
  },
];

/**
 * Look up one action by name.
 * @param {string} name
 * @returns {DeliveryAction|null}
 */
function actionByName(name) {
  return DELIVERY_ACTIONS.find((a) => a.name === name) || null;
}

/**
 * Is this action available to the manager at all?
 * @param {string} name
 * @returns {{allowed: boolean, action: DeliveryAction|null, why: string}}
 */
function actionIsAvailable(name) {
  const action = actionByName(name);
  if (!action) return { allowed: false, action: null, why: `"${name}" is not on the action menu at all.` };
  if (action.tier === "C") return { allowed: false, action, why: action.why };
  return { allowed: true, action, why: "" };
}

// ─── Reading the working state ────────────────────────────────────────────────

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
 * @param {string} seriesDir
 * @returns {Promise<Object|null>} - null when the report does not exist yet.
 */
async function readDeliverable(seriesDir) {
  const file = seriesArtifactFile(TRANSLATION_REPORT_JSON, "TRANSLATION_REPORT_OUTPUT_FILE", seriesDir);
  let parsed;
  try {
    parsed = JSON.parse(await fs.promises.readFile(file, "utf8"));
  } catch {
    return null;
  }
  const chapters = Array.isArray(parsed.chapters) ? parsed.chapters : [];
  const bucket = (row) =>
    row.outcome.startsWith("PUBLISHED")
      ? "published"
      : row.outcome.startsWith("UNVERIFIED")
        ? "unverified"
        : row.outcome.startsWith("MISSING")
          ? "missing"
          : "emptyInSource";

  const counts = { total: chapters.length, published: 0, unverified: 0, missing: 0, emptyInSource: 0 };
  /** @type {Object<string, {total: number, published: number, unverified: number, missing: number}>} */
  const byVolume = {};
  for (const row of chapters) {
    const key = bucket(row);
    counts[key] += 1;
    const v = String(row.volume);
    byVolume[v] = byVolume[v] || { total: 0, published: 0, unverified: 0, missing: 0 };
    byVolume[v].total += 1;
    if (key in byVolume[v]) byVolume[v][key] += 1;
  }
  return { file, generatedAt: parsed.generatedAt || null, counts, byVolume };
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
    out[e.step] = (out[e.step] || 0) + 1;
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
 *   ledgerError: string|null, deliverable: Object|null}>}
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
  return {
    seriesDir: dir,
    manifest: plan.manifest,
    manifestProblem: plan.problem,
    volumes,
    stepStates,
    recurring: latestRun ? recurringFindings(entries, latestRun) : [],
    run: latestRun,
    interventionsByStep: interventionsUsed(entries, latestRun),
    interventionBudget: maxInterventionsPerStep(),
    ledgerError: ledger.error || null,
    deliverable: await readDeliverable(dir),
  };
}

// ─── The plan ─────────────────────────────────────────────────────────────────

/**
 * The declared outputs one step leaves in one volume folder — the exact list to remove so
 * the skip-checks cannot no-op the fix (gotcha 66: the skip-checks key on source
 * fingerprints, rolling state and `contextHash`, and none of them know the code changed).
 *
 * Quarantine evidence is never in this list. `.rejected` files are not this step's outputs;
 * they are the reason we are looking, and `delete-evidence` is Tier C.
 *
 * @param {string} step
 * @param {string} installment - The volume's `NN`, so a templated name resolves to the real one.
 * @returns {string[]}
 */
function declaredOutputsFor(step, installment) {
  const spec = specForStep(step);
  if (!spec || !spec.perVolume) return [];
  // Every declared name, placeholder resolved. Listing the whole set is the safe direction:
  // `wipeAttemptOutputs` deletes only the names that exist, and a `*-rolling-state.json` left
  // behind is the one thing that makes a re-run skip the volume it is supposed to rebuild
  // (gotcha 66).
  return spec.volume.map((expect) => resolveDeclaredName(expect.name, installment));
}

/**
 * Turn the working state into the step list to run.
 *
 * The rule, in words: walk the steps in run order; the first one that did not finish what it
 * claims to have is where the run picks up. Everything before it is left alone. Everything
 * after it runs *after* the resume point, because its inputs are about to change — and a
 * later step that is also broken is normally a symptom of the earlier one, not a second
 * problem, which the plan says out loud instead of proposing two fixes.
 *
 * @param {Awaited<ReturnType<typeof readWorkingState>>} state
 * @returns {ResumePlan}
 */
function planResume(state) {
  /** @type {ResumeStepPlan[]} */
  const steps = [];
  /** @type {string[]} */
  const notes = [];
  const order = PIPELINE_STEPS.map((s) => s.name);

  if (!state.manifest) {
    return finishPlan({
      state,
      verdict: "blocked",
      headline: "There is no plan of record, so no step can run. Intake is the step to call — and its questions are the account owner's, not mine.",
      steps: [
        {
          step: "discover",
          action: "blocked",
          actionName: null,
          reasons: [state.manifestProblem || "the plan of record is missing"],
          fromVolume: null,
          cascade: false,
          wipeFirst: [],
          flags: [],
          countsAsIntervention: false,
        },
      ],
      notes: [
        "The intake questions — which files are volumes, in what order, what the series is called — " +
          "belong to the intake agent and the account owner. I can report that intake is needed; I do not answer them.",
      ],
    });
  }

  const stateByStep = new Map(state.stepStates.map((s) => [s.step, s]));
  let resumeAt = -1;
  let resumeReason = "";

  // Which steps carry a finding class that survived an earlier recorded run. Built before the
  // plan, because it changes what may be *advised*: `index.js` already refuses to repeat
  // "just re-run, it's cheap" when its own ledger says a re-run has not cleared it, and the
  // resume triage giving the opposite advice would undo that.
  /** @type {Map<string, Array<{finding: string, steps: string[], runs: number}>>} */
  const recurringFor = new Map();
  for (const r of state.recurring || []) {
    for (const stepName of r.steps) {
      if (!recurringFor.has(stepName)) recurringFor.set(stepName, []);
      recurringFor.get(stepName).push(r);
    }
  }

  order.forEach((name, index) => {
    const st = stateByStep.get(name);
    if (!st) return;

    if (st.status === "incomplete" || st.status === "unknown") {
      if (resumeAt === -1) {
        resumeAt = index;
        resumeReason = st.error
          ? `${name} could not be assessed (${st.error})`
          : `${name} did not finish what it claims to have: ${st.damageKinds.join(", ")}`;
      }
    }
  });

  // Nothing is unfinished. Say so, and report what is worth reading without turning any of it
  // into work — including gate evidence lying beside a finished volume, which is the finding a
  // manager is most tempted to "fix" by rebuilding a volume that is already complete.
  if (resumeAt === -1) {
    const quarantined = [];
    for (const name of order) {
      const st = stateByStep.get(name);
      if (!st) continue;
      if (st.status === "gaps") {
        notes.push(`${name}: ${st.notes.length} non-blocking gap(s) — reported, not acted on.`);
      }
      if (st.status === "quarantined") {
        quarantined.push(name);
        notes.push(
          `${name}: gate evidence in volume(s) ${st.evidenceVolumes.join(", ")} beside output that is complete. ` +
            "A gate refused something at some point and the evidence was kept. Read it; it is not a reason to rebuild a volume that is finished."
        );
      }
    }
    const d = state.deliverable;
    if (d && (d.counts.unverified || d.counts.missing)) {
      notes.push(
        `the deliverable is not clean: ${d.counts.unverified} unverified and ${d.counts.missing} missing ` +
          `chapter(s) out of ${d.counts.total}. Every step finished; the book is what is not finished.`
      );
    }
    const allSteps = order.map((name) => ({
      step: name,
      action: quarantined.includes(name) ? "ticket" : "none",
      actionName: quarantined.includes(name) ? "open-ticket" : "resume-here",
      reasons: quarantined.includes(name)
        ? [
            `output for volume(s) ${stateByStep.get(name).evidenceVolumes.join(", ")} is complete, so this evidence is not a reason to rebuild it: a gate refused something at some point and the file was kept beside it`,
            "reading that evidence is a question for the diagnostics team, not a re-run — and it is not mine to delete (Tier C)",
            ...stateByStep.get(name).notes,
          ]
        : [stateByStep.get(name).status],
      fromVolume: quarantined.includes(name) ? stateByStep.get(name).evidenceVolumes[0] || null : null,
      cascade: false,
      wipeFirst: [],
      flags: [],
      countsAsIntervention: false,
    }));

    if (quarantined.length) {
      return finishPlan({
        state,
        verdict: "evidence",
        headline: `Every step finished what it claims to have. What is left is unread gate evidence in ${quarantined.join(", ")} — read it before running anything.`,
        steps: allSteps,
        notes,
      });
    }
    return finishPlan({
      state,
      verdict: "nothing-to-do",
      headline: notes.length
        ? "Every step finished what it claims to have. Nothing to resume — but read the notes."
        : "Every step finished what it claims to have, and the deliverable is clean. Nothing to do.",
      steps: allSteps,
      notes,
    });
  }

  const resumeStep = order[resumeAt];
  const resumeState = stateByStep.get(resumeStep);

  // ── The resume point ────────────────────────────────────────────────────────
  const fromVolume = resumeState.volumes.length ? resumeState.volumes[0] : null;
  const cumulative = CUMULATIVE_STEPS.has(resumeStep);
  const auditVerdictProblem = resumeState.damageKinds.some((k) => k.startsWith("audit-verdict"));

  // Did this step's own gate remove the output? The tell is on the disk, in one folder: the
  // volume is missing the step's required files AND holds that step's quarantine evidence
  // beside them. That is volume 15 of the live series — the carry-forward gate refused a
  // glossary that had GROWN from 445 terms to 460, moved the file to `glossary.md.rejected`,
  // and a 12-hour run ended there (gotcha 68). Re-running the step rebuilds the file and then
  // runs the same deterministic gate over it, which produces the identical quarantine.
  const resumeInventory = state.volumes.find((v) => v.installment === String(fromVolume)) || null;
  const gateRemovedIt = Boolean(fromVolume && resumeInventory && resumeInventory.quarantinedForStep.includes(resumeStep));

  /** @type {ResumeStepPlan} */
  const plan = {
    step: resumeStep,
    action: "run",
    actionName: "resume-here",
    reasons: [resumeReason, ...resumeState.damageKinds.map((k) => `finding: ${k}`)],
    fromVolume,
    cascade: false,
    wipeFirst: [],
    flags: [],
    countsAsIntervention: false,
  };

  if (resumeStep === "discover") {
    plan.action = "blocked";
    plan.actionName = null;
    plan.reasons.push(
      "intake is its own step with its own agent and its own guards. I can tell you it is needed; I do not answer its questions."
    );
    notes.push("The intake questions (volume order, which files are volumes, the series name) belong to the intake agent and the account owner.");
  } else if (gateRemovedIt) {
    plan.action = "ticket";
    plan.actionName = "open-ticket";
    plan.reasons.push(
      `volume ${fromVolume} is missing ${resumeStep}'s output AND holds ${resumeStep}'s own gate evidence in the same folder: a deterministic gate refused that file, and nothing has replaced it since.`,
      `re-running ${resumeStep} rebuilds the file and then runs the same gate over it, which produces the identical quarantine (gotcha 68). That is the spin, and the ledger refuses the third attempt.`,
      `read ${resumeInventory.quarantines.map((n) => `\`${n}\``).join(", ")} first — it is the gate's own account of what it refused, and it is not mine to delete (Tier C).`
    );
    notes.push(
      `A finding whose cause is a gate is not repaired by re-running the step the gate lives in. The evidence names the disagreement; the fix is a code question for the diagnostics team.`
    );
  } else if (auditVerdictProblem) {
    // A FAIL verdict is not repaired by re-auditing: the same four artifacts produce the
    // same FAIL. Re-running it is the spinning shape, so this is a question, not an action.
    plan.action = "ticket";
    plan.actionName = "open-ticket";
    plan.reasons.push(
      "the audit's verdict is the deliverable here, and re-auditing unchanged artifacts produces the same verdict. " +
        "The fix is in the four reference artifacts the findings name — which is a diagnostics question, not a re-run."
    );
  } else if (cumulative && fromVolume) {
    plan.actionName = "wipe-and-cascade";
    plan.cascade = true;
    plan.countsAsIntervention = true;
    const folder = (state.manifest.volumes.find((v) => String(v.installmentNumber) === String(fromVolume)) || {}).folder;
    if (folder) {
      plan.wipeFirst = [
        {
          volumeDir: path.join(state.seriesDir, folder),
          files: declaredOutputsFor(resumeStep, fromVolume),
        },
      ];
    }
    plan.reasons.push(
      `the cumulative invariant rebuilds every volume after ${fromVolume}, so the primitive is: remove ${fromVolume}'s ${resumeStep} outputs, then run ${resumeStep} over the whole series.`,
      "not --volume: a filtered run puts one volume in the loop, so the later volumes stay built on the broken one (gotcha 66).",
      "the declared outputs only — the quarantine evidence beside them is kept."
    );
  } else if (CHAPTER_STATE_STEPS.has(resumeStep)) {
    plan.actionName = "re-translate-volume";
    plan.reasons.push(
      "the translation stage is idempotent per chapter, so a plain re-run repairs a hole without throwing away the chapters that are already verified."
    );
  } else if (resumeStep === "consistency-audit") {
    plan.actionName = "re-audit";
    plan.countsAsIntervention = true;
    plan.reasons.push("the audit report is missing or stale; re-running it is the whole fix.");
  } else {
    plan.actionName = "re-run-step";
    plan.reasons.push("the idempotent skip-checks make a re-run cost almost nothing where the work is already done.");
  }

  steps.push(plan);

  // ── Everything before it: leave alone ───────────────────────────────────────
  for (let i = 0; i < resumeAt; i += 1) {
    const name = order[i];
    const st = stateByStep.get(name);
    const reasons = [st.status === "complete" ? "finished" : `finished with ${st.notes.length} non-blocking gap(s)`];
    if (st.status === "quarantined") {
      reasons.push(
        `gate evidence in volume(s) ${st.evidenceVolumes.join(", ")} beside output this step finished — worth reading, not worth rebuilding`
      );
    }
    steps.unshift({
      step: name,
      action: "none",
      actionName: null,
      reasons,
      fromVolume: null,
      cascade: false,
      wipeFirst: [],
      flags: [],
      countsAsIntervention: false,
    });
  }

  // ── Everything after it: run after, and say whether it is a second problem ──
  // The translation stage's own entry gate: it refuses to start on a FAIL or missing
  // consistency verdict, and bypassing that gate is Tier C. So when the audit is the
  // problem, the steps after it are reported as blocked rather than proposed.
  const auditState = stateByStep.get("consistency-audit") || null;
  const auditVerdictFails = Boolean(auditState && auditState.damageKinds.some((k) => k === "audit-verdict-fail"));
  const auditReportMissing = Boolean(auditState && auditState.damageKinds.some((k) => k === "missing-required" || k === "audit-verdict-missing"));
  const TRANSLATION_STEPS = new Set(["translate", "translate-qa", "polish"]);

  for (let i = resumeAt + 1; i < order.length; i += 1) {
    const name = order[i];
    const st = stateByStep.get(name);
    const blocked = TRANSLATION_STEPS.has(name) && auditVerdictFails;
    /** @type {string[]} */
    const reasons = blocked
      ? ["the translation stage refuses to start on a FAIL consistency verdict, and re-auditing unchanged artifacts produces the same FAIL — bypassing that gate is Tier C"]
      : st.status === "incomplete"
        ? [`also unfinished, most likely because ${resumeStep} was: fix the earlier step first, then re-assess this one`]
        : [`its inputs are about to change, so it runs after ${resumeStep}`];
    if (!blocked && TRANSLATION_STEPS.has(name) && auditReportMissing) {
      reasons.push("it cannot start until `consistency-report.md` exists and says PASS — that entry gate is not mine to bypass");
    }
    const recurring = recurringFor.get(name) || [];
    if (recurring.length) {
      reasons.push(
        `the ledger says ${recurring.map((r) => `${r.finding} (${r.runs} runs)`).join(", ")} for this step already — a re-run has not cleared it before, so treat this as a question, not a cheap retry`
      );
    }
    if (!blocked && st.evidenceVolumes.length) {
      reasons.push(
        `gate evidence in volume(s) ${st.evidenceVolumes.join(", ")} — read it; it is not by itself a reason to rebuild a volume this step finished`
      );
    }
    steps.push({
      step: name,
      action: blocked ? "blocked" : "after",
      actionName: blocked ? null : "re-run-step",
      reasons,
      // Each step picks up at its own earliest damaged volume, which is usually NOT the same
      // one the resume step picked up at: glossary may be whole through 14 while the voice
      // reference stopped at 02.
      fromVolume: st.volumes.length ? st.volumes[0] : null,
      cascade: false,
      wipeFirst: [],
      flags: [],
      countsAsIntervention: false,
    });
  }

  // ── Recurring findings: the free warning ────────────────────────────────────
  for (const r of state.recurring || []) {
    notes.push(
      `${r.finding} appeared in ${r.runs} recorded runs${r.steps.length ? ` (${r.steps.join(", ")})` : ""}. ` +
        "A finding that survives a run is structural, not transient — re-running is not the answer, and the ledger refuses the third attempt."
    );
  }
  const recurringHere = recurringFor.get(resumeStep) || [];
  if (recurringHere.length && plan.action !== "ticket") {
    plan.action = "ticket";
    plan.actionName = "open-ticket";
    plan.cascade = false;
    plan.wipeFirst = [];
    plan.reasons.push(
      `the ledger says ${recurringHere.map((r) => `${r.finding} (${r.runs} runs)`).join(", ")} for this step already: re-running it has not cleared it before, ` +
        "and the same action against the same finding is refused on the third attempt (utils/ledger.js)."
    );
  }

  // ── The per-step intervention budget ────────────────────────────────────────
  // DELIVERY_MAX_INTERVENTIONS is PER STEP (account owner, 2026-10-06): a run with nine steps is
  // nine problems, and a global cap spends glossary's attempts on the wiki. This is a different
  // limit from the anti-spin gate — the ledger refuses the same action against the same finding
  // twice; this refuses to keep doing *anything* to one step. Both escalate to a ticket, because
  // the honest reading of "I have run out of moves on this step" is "this needs somebody who can
  // see the code".
  const budget = state.interventionBudget || maxInterventionsPerStep();
  const used = (state.interventionsByStep || {})[resumeStep] || 0;
  if (used) {
    notes.push(
      `${resumeStep}: ${used} of ${budget} interventions used on this step in run ${state.run || "the recorded one"}.`
    );
  }
  if (plan.countsAsIntervention && used >= budget) {
    plan.action = "ticket";
    plan.actionName = "open-ticket";
    plan.cascade = false;
    plan.wipeFirst = [];
    plan.countsAsIntervention = false;
    plan.reasons.push(
      `this step has already had ${used} of the ${budget} interventions it is allowed in this run. ` +
        "The budget is per step on purpose, so spending it is the signal that this step needs the diagnostics team, not another attempt."
    );
    notes.push(
      `${resumeStep} is out of intervention budget (${used}/${budget}). The next move is a ticket, and the account owner is the only role that can raise the limit.`
    );
  }

  if (state.ledgerError) {
    notes.push(`the run ledger could not be read (${state.ledgerError}) — so nothing here is counted as safe to repeat.`);
  }

  const headline = gateRemovedIt
    ? `The run stops at ${resumeStep} volume ${fromVolume}: that step's own gate refused the file, and re-running the step refuses it again.`
    : plan.action === "ticket"
      ? `The run stops at ${resumeStep}: the answer is a question, not a re-run.`
      : plan.action === "blocked"
        ? `The run stops at ${resumeStep}, and the next move is not mine.`
        : `Pick up at ${resumeStep}${fromVolume ? ` volume ${fromVolume}` : ""}${plan.cascade ? ", then let the cascade rebuild the tail" : ""}.`;

  return finishPlan({ state, verdict: "resume", headline, steps, notes });
}

/**
 * Attach the render and return the plan.
 * @param {{state: Object, verdict: string, headline: string, steps: ResumeStepPlan[], notes: string[]}} input
 * @returns {ResumePlan}
 */
function finishPlan({ state, verdict, headline, steps, notes }) {
  /** @type {ResumePlan} */
  const plan = {
    generatedAt: new Date().toISOString(),
    seriesDir: state.seriesDir,
    verdict,
    headline,
    steps,
    volumes: state.volumes || [],
    notes,
    recurring: state.recurring || [],
    run: state.run || null,
    interventionsByStep: state.interventionsByStep || {},
    interventionBudget: state.interventionBudget || maxInterventionsPerStep(),
    deliverable: state.deliverable,
    markdown: "",
  };
  plan.markdown = renderResumePlanMarkdown(plan);
  return plan;
}

// ─── The human-facing half ────────────────────────────────────────────────────

/**
 * Collapse installment numbers into readable ranges: `["01","02","03","07"]` → `"01–03, 07"`.
 *
 * @param {string[]} installments
 * @returns {string} - `""` for an empty list.
 */
function formatRanges(installments) {
  const nums = installments
    .map((raw) => ({ raw, n: parseInt(raw, 10) }))
    .filter((v) => Number.isFinite(v.n))
    .sort((a, b) => a.n - b.n);
  if (!nums.length) return "";
  const chunks = [];
  let start = nums[0];
  let prev = nums[0];
  const flush = () => chunks.push(start.n === prev.n ? start.raw : `${start.raw}–${prev.raw}`);
  for (const cur of nums.slice(1)) {
    if (cur.n === prev.n + 1) {
      prev = cur;
      continue;
    }
    flush();
    start = cur;
    prev = cur;
  }
  flush();
  return chunks.join(", ");
}

/**
 * Per step, which volumes hold its required outputs and which do not.
 *
 * This is the sentence a delivery manager actually needs — "glossary is whole through 14,
 * missing 15–17" — instead of seventeen folders' worth of file names, which is what the first
 * version of this report printed and what made the important line impossible to find.
 *
 * @param {VolumeInventory[]} volumes
 * @returns {Array<{step: string, built: string, missing: string}>} - Only the steps with a gap.
 */
function progressByStep(volumes) {
  const vols = volumes || [];
  const gaps = new Set();
  for (const v of vols) for (const m of v.missingForStep) gaps.add(m.step);

  // Only the steps the pipeline actually runs, in run order. `verify-translate` and `retranslate`
  // have their own artifact specs, but they are half-rounds of `translate-qa` — listing them
  // separately makes the table read as though two more steps were missing.
  const ordered = PIPELINE_STEPS.map((s) => s.name).filter((n) => gaps.has(n));
  const out = [];
  for (const step of ordered) {
    const hasGap = (v) => v.missingForStep.some((m) => m.step === step);
    // A folder the plan names but that is not on disk is missing for every step, not none.
    const missing = vols.filter((v) => !v.exists || hasGap(v)).map((v) => v.installment);
    const built = vols.filter((v) => v.exists && !hasGap(v)).map((v) => v.installment);
    out.push({ step, built: formatRanges(built), missing: formatRanges(missing) });
  }
  return out;
}

/**
 * The plan as Markdown — the file a human reads, and the file the manager writes in `report`
 * mode.
 * @param {ResumePlan} plan
 * @returns {string}
 */
function renderResumePlanMarkdown(plan) {
  const lines = [
    `# Where the run stopped`,
    ``,
    `_${plan.generatedAt} — read from the working state only: the plan of record, what each volume folder holds, the step assessments, the run ledger, and the publish report. No model call._`,
    ``,
    `## ${plan.headline}`,
    ``,
  ];

  const d = plan.deliverable;
  if (d) {
    lines.push(
      `**The deliverable** (${d.generatedAt || "undated"}): ${d.counts.total} chapter(s) — ` +
        `${d.counts.published} published verified, ${d.counts.unverified} unverified, ${d.counts.missing} missing` +
        (d.counts.emptyInSource ? `, ${d.counts.emptyInSource} empty in the source` : "") +
        `.`,
      ``
    );
  } else {
    lines.push(`**The deliverable:** no publish report yet — the translation stage has not produced one.`, ``);
  }

  const progress = progressByStep(plan.volumes);
  if (progress.length) {
    lines.push(`## Where each step reached`);
    lines.push(``);
    for (const p of progress) {
      lines.push(`- **${p.step}** — built for ${p.built || "nothing"}, missing for ${p.missing}`);
    }
    const evidence = (plan.volumes || []).filter((v) => v.quarantines.length);
    if (evidence.length) {
      lines.push(``);
      lines.push(
        `Gate evidence kept (read it, never delete it): ` +
          evidence.map((v) => `volume ${v.installment} ${v.quarantines.map((n) => `\`${n}\``).join(", ")}`).join("; ")
      );
    }
    lines.push(``);
  }

  lines.push(`## The step list`);
  lines.push(``);
  for (const s of plan.steps) {
    const label =
      s.action === "none" ? "leave alone" : s.action === "after" ? "run after" : s.action === "blocked" ? "blocked" : s.action === "ticket" ? "open a ticket" : "run now";
    lines.push(`### ${label}: \`${s.step}\`${s.fromVolume ? ` — from volume ${s.fromVolume}` : ""}`);
    if (s.actionName) {
      const action = actionByName(s.actionName);
      lines.push(
        `- action: **${s.actionName}**${action ? ` (tier ${action.tier}${action.countsAsIntervention ? ", counts against this step's intervention limit" : ", does not count against the intervention limit"})` : ""}`
      );
    }
    for (const r of s.reasons) lines.push(`- ${r}`);
    if (s.flags.length) lines.push(`- flags: ${s.flags.join(" ")}`);
    for (const w of s.wipeFirst) {
      lines.push(`- remove first, in \`${w.volumeDir}\`:`);
      for (const f of w.files) lines.push(`  - ${f}`);
      lines.push(`  - (and nothing else — the quarantine evidence beside them stays)`);
    }
    lines.push(``);
  }

  if (plan.notes.length) {
    lines.push(`## Notes`);
    for (const n of plan.notes) lines.push(`- ${n}`);
    lines.push(``);
  }

  lines.push(
    `_Choosing where to resume is not an intervention and is not counted. Removing output that already exists is._`
  );
  return lines.join("\n") + "\n";
}

module.exports = {
  DELIVERY_ACTIONS,
  CUMULATIVE_STEPS,
  CHAPTER_STATE_STEPS,
  DAMAGE_KINDS,
  EVIDENCE_KINDS,
  actionByName,
  actionIsAvailable,
  readPlanOfRecord,
  inventoryVolume,
  readDeliverable,
  readWorkingState,
  planResume,
  declaredOutputsFor,
  maxInterventionsPerStep,
  interventionsUsed,
  formatRanges,
  progressByStep,
  renderResumePlanMarkdown,
};
