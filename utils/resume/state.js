/**
 * Reading the half-built run without reading the code: the plan of record, what each volume folder actually holds, and the findings split by their declared **level** into DAMAGE (STOP or MAJOR — this decides where to pick up), GAPS (MINOR — batched per kind and step, proposed for investigation, never opens the run) and NOTES (NOTE — reported only), with EVIDENCE (a gate refused something and kept its proof — read it, it is never a reason to rebuild) kept exactly as it was. A quarantine belongs to the artifact it NAMES, not to every step that declares the pattern, and a declared name is a template, not a file name.
 *
 * Part of the resume.js layer (split out of the original single file).
 */

const fs = require("fs");
const path = require("path");
const { PIPELINE_STEPS } = require("../../gulpfile");
const { STEP_ARTIFACT_SPECS, specForStep, quarantineStem } = require("../artifacts");
const { runPostMortem } = require("../postmortem");
const { FINDING_LEVELS } = require("../postmortem/levels");
const { readLedger, recurringFindings } = require("../ledger");
const { readTickets } = require("../tickets");
const { readPatches } = require("../patches");
const { runInProgress } = require("../runlock");
const { validateManifest } = require("../../get-translation-target");
const { readTranslationReport, summarizeReportRows } = require("../translation-report");
// The freeze gate's recorded acts (utils/prereqs/freeze.js). A release is STANDING — it does not
// expire and it is not consumed by one run — so it belongs in the snapshot the triage reads: a
// volume whose translation a release invalidated is a fact whoever resumes this series has to see,
// not something the person who typed the release has to remember.
const { readTranslationReleases, DOOR_OWNER } = require("../prereqs/freeze");

const { EVIDENCE_KINDS, actionByName } = require("./menu");

// ─── Level routing ────────────────────────────────────────────────────────────

/** @typedef {import("../postmortem").PostMortemFinding} PostMortemFinding */
/** @typedef {import("../postmortem/levels").FindingLevel} FindingLevel */

/**
 * What each declared level MEANS to the triage, as data.
 *
 * This is the table `utils/postmortem/plan/01-finding-levels.md` slice 2 is: the triage used to filter
 * on **severity** first, so four kinds the menu itself calls damage (`wrong-shape`,
 * `chapter-without-draft`, `accepted-without-acceptance`, `audit-verdict-missing`) were emitted at
 * MEDIUM and could never reach the decision. Routing on the level is what makes them visible; routing
 * on severity is what made them invisible.
 *
 * `damage` decides where the run picks up. `gap` is collected, reported and proposed for investigation
 * — it may not open the run. `note` is a line in the report and nothing else.
 *
 * **Frozen.** The file is closed to the dev team, but a table any module can reassign at runtime is a
 * dial whoever imports it can turn (`AGENTS.md` rule 3). `classifyFindings` reads its route out of this
 * object, so freezing it is what makes the routing un-turnable from inside a process.
 *
 * @type {Record<FindingLevel, "damage" | "gap" | "note">}
 */
const LEVEL_ROUTES = Object.freeze({
  STOP: "damage",
  MAJOR: "damage",
  MINOR: "gap",
  NOTE: "note",
});

/**
 * The size of fix each level expects, in the plan's own words (§3). Carried onto an investigation so
 * the role that answers it knows whether it is being asked for a one-file change or a rule change —
 * and so the triage is not the one deciding that. Frozen for the same reason as `LEVEL_ROUTES` above:
 * it is the other half of the same decision, and a half that can be edited from a process is a dial.
 *
 * @type {Record<FindingLevel, string>}
 */
const LEVEL_FIX_SIZE = Object.freeze({
  STOP: "anything; the run is already halted",
  MAJOR: "major: a rule, a converter, a stage's code",
  MINOR: "minor: one file, one volume, a re-run",
  NOTE: "none",
});

/**
 * The level one finding is routed by, and whether the level table actually declares its kind.
 *
 * The TABLE is the authority, not the object. A finding object can carry any `level` string whoever
 * built it chose; the table can only be edited by the account owner (`utils/postmortem/` is a banned
 * patch path). So a kind with no row is undeclared whatever its object claims, and an undeclared kind
 * is routed as damage rather than into the MINOR batch the default would have hidden it in.
 *
 * @param {PostMortemFinding|{kind?: string, level?: FindingLevel, levelDeclared?: boolean}} f
 * @returns {{level: FindingLevel, declared: boolean}}
 */
function levelOf(f) {
  const row = f && f.kind ? FINDING_LEVELS[f.kind] : null;
  if (row) return { level: row.level, declared: true };
  return { level: "MINOR", declared: false };
}

/**
 * Split one step's findings into the four classes the triage acts on.
 *
 * Fail closed, twice over: a kind the level table does not declare is **damage**, and a finding with
 * no kind at all is damage too — an unnamed finding is the most invisible one there is. That is the
 * intent of the comment this replaced ("a new finding kind must not become invisible here by not being
 * listed"): the old version achieved it by treating every HIGH finding as damage, which also made
 * every MEDIUM one invisible.
 *
 * `EVIDENCE_KINDS` keeps its exact current treatment: a HIGH `quarantine-present` is evidence, a MEDIUM
 * one is the note it already was, and neither is ever damage — Tier C, evidence is never a reason to
 * wipe accepted work.
 *
 * @param {PostMortemFinding[]|null} findings - One step's post-mortem findings.
 * @returns {{damage: PostMortemFinding[], gaps: PostMortemFinding[], notes: PostMortemFinding[], evidence: PostMortemFinding[]}}
 */
function classifyFindings(findings) {
  /** @type {{damage: PostMortemFinding[], gaps: PostMortemFinding[], notes: PostMortemFinding[], evidence: PostMortemFinding[]}} */
  const out = { damage: [], gaps: [], notes: [], evidence: [] };
  for (const f of findings || []) {
    if (!f || !f.kind) {
      out.damage.push(f);
      continue;
    }
    if (EVIDENCE_KINDS.has(f.kind)) {
      if (f.severity === "HIGH") out.evidence.push(f);
      else out.notes.push(f);
      continue;
    }
    const { level, declared } = levelOf(f);
    // The route comes FROM the table. A chain of `if (level === "STOP")` here would let the table and
    // the behaviour drift apart, and the table is the half in a closed path.
    const route = declared ? LEVEL_ROUTES[level] : "damage";
    if (route === "damage") out.damage.push(f);
    else if (route === "gap") out.gaps.push(f);
    else out.notes.push(f);
  }
  return out;
}

/**
 * Collect one step's MINOR findings into **one entry per kind**, with every volume it fired in.
 *
 * Batched, not per occurrence: a stray file in seventeen volumes is one question about one kind on one
 * step, not seventeen questions. The count and the volume list are kept so nothing is lost by grouping
 * — and so the bound slice 3 puts on investigations has a number to bound.
 *
 * @param {PostMortemFinding[]} gaps - The MINOR findings of one step.
 * @returns {Array<{kind: string, level: FindingLevel, count: number, volumes: string[], files: string[], message: string}>}
 */
function batchGaps(gaps) {
  /** @type {Map<string, {kind: string, level: FindingLevel, count: number, volumes: string[], files: string[], message: string}>} */
  const byKind = new Map();
  for (const f of gaps || []) {
    let batch = byKind.get(f.kind);
    if (!batch) {
      batch = { kind: f.kind, level: levelOf(f).level, count: 0, volumes: [], files: [], message: f.message || "" };
      byKind.set(f.kind, batch);
    }
    batch.count += 1;
    if (f.volume) {
      const v = String(f.volume);
      if (!batch.volumes.includes(v)) batch.volumes.push(v);
    }
    if (f.file && batch.files.length < 5 && !batch.files.includes(f.file)) batch.files.push(f.file);
  }
  return [...byKind.values()]
    .map((b) => ({ ...b, volumes: b.volumes.sort() }))
    .sort((a, b) => a.kind.localeCompare(b.kind));
}

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
  // The same stem the artifact table uses. Stripping the suffix here as well is how the numbered family
  // (`character-voice.md.rejected.4`) became a file the triage counted but attributed to nobody.
  const stem = quarantineStem(name);
  if (!stem) return false;
  return spec.volume.some((expect) => resolveDeclaredName(expect.name, installment) === stem);
}


/**
 * What one volume folder actually holds, against what every step that runs on a volume is
 * declared to leave there.
 *
 * The `missingForStep` / `quarantinedForStep` halves are what the triage reads, and both are
 * per step: the first is the declared `required` output that is not on disk (with `{installment}`
 * resolved, because a template is not a file name), and the second attributes each `.rejected` to
 * the step whose artifact it NAMES rather than to every step that declares the same quarantine
 * pattern.
 *
 * @param {string} seriesDir
 * @param {import("../types").TranslationTargetVolume} volume
 * @returns {VolumeInventory}
 */
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
    // Filled by `readWorkingState` from the freeze gate's release record: the doors a recorded release
    // currently lets rewrite this volume. Empty means frozen, and empty is also the honest answer for a
    // volume nothing has ever been released for — which is why it is declared here rather than left
    // undefined.
    releasedDoors: [],
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
 * Which doors a recorded translation release currently leaves open, per volume.
 *
 * A release is STANDING: it does not expire and one run does not consume it, because the translation
 * artifacts it invalidated stay on disk. So the resume triage has to carry it — otherwise a volume
 * somebody deliberately unlocked reads, on the next run, exactly like a volume that is frozen.
 *
 * @param {Array<{volumes?: string[], doors?: string[]}>} releases - Rows from `readTranslationReleases`.
 * @returns {Map<string, string[]>} installment → the doors released for it, sorted, newest release first.
 */
function indexTranslationReleases(releases) {
  /** @type {Map<string, Set<string>>} */
  const open = new Map();
  const rows = [...(releases || [])].sort((a, b) => String(a && a.at || "").localeCompare(String(b && b.at || "")));
  for (const r of rows) {
    if (!r || !Array.isArray(r.volumes)) continue;
    for (const installment of r.volumes) {
      const key = String(installment);
      if (!open.has(key)) open.set(key, new Set());
      for (const door of r.doors || []) open.get(key).add(String(door));
    }
  }
  /** @type {Map<string, string[]>} */
  const out = new Map();
  for (const [key, doors] of open) out.set(key, [...doors].sort());
  return out;
}


/**
 * The doors one volume's releases unlock for one step.
 *
 * A manual door (`rebuild-voice`, `extract-voice`, `reopen-volume`, `attribute-voice`) is unlocked by a
 * release naming its OWNING stage, because the artifact it threatens is that stage's artifact — the same
 * rule `utils/prereqs/freeze.js`'s `releaseCovering` applies, kept in one place by asking that module's
 * own `DOOR_OWNER` table rather than restating it here.
 *
 * @param {string[]|undefined} releasedDoors - The doors released for this volume.
 * @param {string} step
 * @returns {string[]} The released door names that cover this step, empty when none do.
 */
function releasedDoorsForStep(releasedDoors, step) {
  return (releasedDoors || []).filter((door) => door === step || DOOR_OWNER[door] === step);
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
 * Each step state's `status` is one of six, and the difference between them is the whole point of the
 * level routing: `complete` (nothing found), `gaps` (MINOR and NOTE findings beside finished work —
 * reported, batched, never a resume point), `quarantined` (gate evidence beside finished work — read it,
 * never rebuild it), `incomplete` (STOP/MAJOR damage — this is where the run picks up), `paused` (the
 * step stopped at a volume boundary on purpose, and `halt` says after which book and which books were
 * never attempted), and `unknown` (the assessment itself could not run).
 *
 * @param {Object} [opts]
 * @param {string} [opts.seriesDir] - Defaults to `SERIES_LOCATION`.
 * @param {Object} [opts.manifest] - Pass a plan of record to use instead of reading one.
 * @returns {Promise<{seriesDir: string, manifest: Object|null, manifestProblem: string|null,
 *   volumes: VolumeInventory[], stepStates: ResumeStepState[], recurring: Array,
 *   run: string|null, interventionsByStep: Object<string, number>, interventionBudget: number,
 *   unhelpfulInterventionsByStep: Object<string, Array>, ledgerError: string|null,
 *   tickets: Array, ticketsError: string|null,
 *   patches: Array, patchesError: string|null, releases: Array, releasesFile: string,
 *   releasesError: string|null, deliverable: Object|null}>}
 */
async function readWorkingState({ seriesDir, manifest } = {}) {
  const dir = path.resolve(seriesDir || process.env.SERIES_LOCATION || process.cwd());
  const plan = manifest === undefined ? readPlanOfRecord(dir) : { manifest, problem: null };

  const volumes = ((plan.manifest && plan.manifest.volumes) || []).map((v) => inventoryVolume(dir, v));

  // The freeze gate's recorded acts, read once and attached per volume. A standing release is the only
  // thing that distinguishes "this volume's reference is frozen because a translation was published on
  // top of it" from "somebody released it on purpose, and the run may rebuild it" — and without it in
  // the snapshot the next run cannot tell those two volumes apart.
  const releases = readTranslationReleases();
  const releasedByVolume = indexTranslationReleases(releases.releases);
  for (const volume of volumes) volume.releasedDoors = releasedByVolume.get(volume.installment) || [];

  /** @type {ResumeStepState[]} */
  const stepStates = [];
  if (plan.manifest) {
    for (const { name } of PIPELINE_STEPS) {
      const report = await runPostMortem({ step: name, seriesDir: dir, manifest: plan.manifest });
      const findings = report.findings || [];
      // Route on the DECLARED LEVEL, not on severity. `utils/postmortem/plan/01-finding-levels.md` §1
      // measured what the old severity-first filter cost: four kinds this layer calls damage were
      // emitted at MEDIUM and so could never reach the decision — a real defect reported in a channel
      // nobody reads.
      //
      // Fail closed the same way the old comment asked, and better: a kind with no row in the level
      // table is DAMAGE, not the MINOR the runtime default hands it. A new finding kind still cannot
      // become invisible by not being listed anywhere; now it cannot become invisible by being listed
      // nowhere *and* defaulted quietly either.
      const { damage, gaps, notes, evidence } = classifyFindings(findings);
      const namedVolumes = (list) =>
        [...new Set(list.filter((f) => f.volume).map((f) => String(f.volume)))].sort();
      const cite = (list) =>
        list.map((f) => ({
          kind: f.kind,
          level: levelOf(f).level,
          levelUndeclared: !levelOf(f).declared,
          severity: f.severity,
          file: f.file,
          volume: f.volume,
          message: f.message,
        }));
      // A step that HALTED at a volume boundary is a distinct state from a step that failed. The halt
      // record (utils/postmortem/halt.js) is already folded into the report by `runPostMortem`, so the
      // triage reads the same record the after-step assessment read — including the count of missing
      // output that halt accounts for.
      const halt = report.halt || null;
      stepStates.push({
        step: name,
        status: report.error
          ? "unknown"
          : halt
            ? "paused"
            : damage.length
              ? "incomplete"
              : evidence.length
                ? "quarantined"
                : findings.length
                  ? "gaps"
                  : "complete",
        damageKinds: [...new Set(damage.map((f) => f.kind))],
        evidenceKinds: [...new Set(evidence.map((f) => f.kind))],
        gapKinds: [...new Set(gaps.map((f) => f.kind))],
        noteKinds: [...new Set(notes.map((f) => f.kind))],
        // The findings themselves, not just their classes. When act mode has to open a ticket it
        // must cite what it looked at, and the only thing it looked at is this assessment — so
        // the citation has to come from here rather than be re-derived from a file that a triage
        // does not write.
        damageFindings: cite(damage),
        evidenceFindings: cite(evidence),
        gapFindings: cite(gaps),
        noteFindings: cite(notes),
        // MINOR is batched per kind, with every volume it fired in, so one kind across a series is one
        // question rather than seventeen.
        gapBatches: batchGaps(gaps),
        volumes: namedVolumes(damage),
        evidenceVolumes: namedVolumes(evidence),
        halt,
        notes: [...gaps, ...notes].map(
          (f) => `${levelOf(f).level} (${f.severity}) ${f.kind}${f.volume ? ` volume ${f.volume}` : ""}: ${f.message}`
        ),
        error: report.error || null,
      });
    }
  }

  const ledger = readLedger();
  // `recurringFindings` asks "in the CURRENT run, and also in an earlier one", per (step, kind).
  // A resume triage has no run of its own — it is reading what previous runs left — so the run it
  // means is the newest one recorded. Passing no run id at all makes the check silently return
  // nothing, which is the failure mode gotcha 67 exists to prevent.
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
    releases: releases.releases,
    releasesFile: releases.file,
    releasesError: releases.error || null,
    deliverable: await readDeliverable(dir),
  };
}

// ─── The plan ─────────────────────────────────────────────────────────────────


module.exports = {
  readPlanOfRecord,
  resolveDeclaredName,
  quarantineBelongsToStep,
  inventoryVolume,
  indexTranslationReleases,
  releasedDoorsForStep,
  readDeliverable,
  maxInterventionsPerStep,
  interventionsUsed,
  unhelpfulInterventions,
  readWorkingState,
  LEVEL_ROUTES,
  LEVEL_FIX_SIZE,
  levelOf,
  classifyFindings,
  batchGaps,
};
