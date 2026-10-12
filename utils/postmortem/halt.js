/**
 * utils/postmortem/halt.js — which stages pause at the volume boundary, and what a pause records.
 *
 * `utils/postmortem/plan/01-finding-levels.md` §3 gives every finding kind a **level**. This file is
 * the half that turns two of those levels into an action inside a running step: a `STOP` or a `MAJOR`
 * found in the volume that just finished ends the walk, so the next volume is never built on the
 * broken thing.
 *
 * **Why the policy is a table and not a flag.** A stage that can declare itself exempt is not gated.
 * So the loop asks this file whether a *step name* is gated; the stage only names itself. The table
 * lives in `utils/postmortem/` for the same reason `levels.js` does — that folder is a banned patch
 * path (`utils/patches/rules.js`, `constraint-tables`), so the role being paused cannot widen its own
 * exemption (AGENTS.md rule 3, gotcha 70). There is no environment variable in this file and there
 * must not be one.
 *
 * **Which stages halt — the plan's measurement, kept as data.** A per-volume pause earns its keep
 * when BOTH hold: later books are built on the broken thing, **and** those later books cost model
 * calls. Cost alone is not enough — pausing a stage whose later volumes do not inherit the damage
 * skips work that would have been perfectly good.
 *
 * | stage | carries the previous book forward | uses the shared volume loop | pays per book | halts |
 * |---|---|---|---|---|
 * | `glossary` | yes | yes | yes | **yes** |
 * | `character-voice` | yes (the record is copied forward) | yes | yes | **yes** |
 * | `style-guide` | yes | yes | yes | **yes** |
 * | `jump-in-wiki` | yes | yes | yes | **yes** |
 * | `translate` | yes (`previousVolumeTail`) | yes | yes | **yes** |
 * | `verify-translate` | yes | yes (it calls `walkVolumes` directly) | yes | **yes** |
 * | `polish` | **no** | yes | yes | no |
 * | `extract` | **no** | **no** — its own `extractVolumes` | **no** — 0 calls | never reaches the gate |
 * | `discover`, `retranslate`, `translate-qa`, `consistency-audit`, `translation-report` | — | **no** | — | never reaches the gate |
 *
 * The last two rows are named here rather than left as an absence. `extract` is exempt on three
 * independent grounds (it carries nothing, it costs nothing, and auditing every book before it fails
 * is the behaviour it was designed for); the rest do not call the shared loop at all, so there is no
 * place in them to put the gate.
 *
 * **What a halt records.** A step that halts at volume 3 leaves volumes 4–17 with no output, and the
 * after-step assessment (`index/assess.js`) runs regardless. Left alone it would report fourteen
 * `missing-required` HIGH findings, which is exactly the confusion this layer exists to prevent: a
 * deliberate halt indistinguishable from a step that broke on every remaining book. So the halt writes
 * one record into the run's own records folder, and `runPostMortem` reads it back: the volumes the
 * step never attempted are not counted as broken books, and the volume that tripped the gate is.
 *
 * This file requires `./levels` (the trigger) and `./render` (where the run's records live). It
 * requires nothing from `utils/ledger`, `utils/tickets`, `utils/patches` or `utils/runlock` — a module
 * under `utils/postmortem/` that reached back for them would close a require cycle (gotcha 85).
 *
 * @module utils/postmortem/halt
 */

const fs = require("fs");
const path = require("path");

const { levelFor } = require("./levels");
const { postMortemDir } = require("./render");

/** @typedef {import("../postmortem").PostMortemFinding} PostMortemFinding */
/** @typedef {import("./levels").FindingLevel} FindingLevel */

// ─── The policy ───────────────────────────────────────────────────────────────

/**
 * The levels that end a volume walk. `MINOR` is investigated in a batch and `NOTE` is reported;
 * neither may stop a run, and that is not configurable.
 *
 * @type {FindingLevel[]}
 */
const HALT_LEVELS = ["STOP", "MAJOR"];

/**
 * One row of the gate's own table: a step, and why it is inside the gate.
 *
 * @typedef {Object} HaltStageRow
 * @property {string} step - The gulp task name, exactly as `utils/artifacts.js` and `gulpfile.js` spell it.
 * @property {string} reason - Why this stage halts (or why it never reaches the gate), in one line.
 */

/**
 * The stages the gate halts: they carry the previous book forward and they pay per book.
 *
 * @type {HaltStageRow[]}
 */
const HALT_STAGES = [
  {
    step: "glossary",
    reason: "every later volume amends this volume's glossary, and every volume costs model calls",
  },
  {
    step: "character-voice",
    reason: "the reference record is copied into the next volume's store, so a damaged record is inside every later book",
  },
  {
    step: "style-guide",
    reason: "the cumulative style guide is the base the next volume amends, and every volume costs model calls",
  },
  {
    step: "jump-in-wiki",
    reason: "shared-wiki.md and chapters.json are what the translation stage reads next, and every volume costs model calls",
  },
  {
    step: "translate",
    reason: "previousVolumeTail seeds each volume's continuity from the volume before it, and every chapter is a paid call",
  },
  {
    step: "verify-translate",
    reason: "its verdicts decide what retranslate repairs and what polish may touch, and every chapter is a paid call",
  },
];

/**
 * The stages that use the shared volume loop and are deliberately NOT gated.
 *
 * @type {HaltStageRow[]}
 */
const LOOP_STAGES_NOT_GATED = [
  {
    step: "polish",
    reason: "it pays per book but carries nothing into the next one, so a halt here would throw away work that was going to be fine",
  },
];

/**
 * The pipeline steps that never reach the gate, because they do not walk the volumes through the
 * shared loop. Named out loud rather than left as a silent absence: an ungated step that nobody
 * wrote down is a hole, and an ungated step that is written down with its reason is a decision.
 *
 * @type {HaltStageRow[]}
 */
const NO_VOLUME_LOOP_STAGES = [
  {
    step: "extract",
    reason: "it has its own extractVolumes, carries nothing between volumes, makes no model call, and audits every book before it fails — running past a broken book is its design",
  },
  {
    step: "discover",
    reason: "it works at the series level and produces the plan of record; there is no volume to stop after",
  },
  {
    step: "retranslate",
    reason: "it repairs the chapters verify-translate already failed, volume by volume in its own loop; its damage is already a verdict the QA loop is holding",
  },
  {
    step: "translate-qa",
    reason: "it drives verify-translate and retranslate, and the gate fires inside verify-translate's own walk",
  },
  {
    step: "consistency-audit",
    reason: "one audit of the whole series, no volume loop",
  },
  {
    step: "translation-report",
    reason: "a deterministic roll-up that reads what the other steps published; it writes nothing per volume",
  },
];

/**
 * The kinds that describe an ABSENT file, as opposed to a file that is there and wrong.
 *
 * They are the two kinds the after-step assessment must not report for a volume the step never
 * reached, and the two kinds a cascade explains: when an earlier volume in the same walk already
 * failed, the later volume's missing output is the symptom of that failure, not a new fault, and the
 * failure is already recorded and will fail the run.
 *
 * @type {Set<string>}
 */
const MISSING_OUTPUT_KINDS = new Set(["missing-required", "missing-expected"]);

const HALT_STEPS = new Set(HALT_STAGES.map((row) => row.step));

/**
 * Whether the volume-boundary gate applies to one step.
 *
 * @param {string} step - The gulp task name.
 * @returns {boolean}
 */
function haltsForStep(step) {
  return HALT_STEPS.has(String(step || ""));
}

/**
 * The findings in one volume's assessment that are strong enough to end the walk.
 *
 * The level is read from the finding when it carries one (every finding built by `finding()` does),
 * and looked up from the kind when it does not — so a caller cannot supply its own level and a kind
 * the level table calls `NOTE` can never halt whatever severity it was emitted at.
 *
 * @param {Array<PostMortemFinding|{kind: string, level?: FindingLevel}>} findings
 * @returns {Array<PostMortemFinding|{kind: string, level: FindingLevel}>} The triggering findings, in the order found.
 */
function haltTriggerFor(findings) {
  return (findings || [])
    .map((f) => (f && f.level ? f : { ...f, level: levelFor(f && f.kind) }))
    .filter((f) => HALT_LEVELS.includes(f.level));
}

// ─── The halt itself ──────────────────────────────────────────────────────────

/**
 * The error a volume walk throws when a volume's own assessment found a STOP or a MAJOR.
 *
 * It is **structural** (`err.structural === true`, `configs/shared/failures.js`), because the skip
 * policy exists for flaky model calls and a broken book is not one: `ON_VOLUME_ERROR=skip` must not
 * walk past it, and neither must `ON_TASK_ERROR=continue`. It names the volume it stopped after and
 * the findings that stopped it, because "where do I pick this up?" is the only question a halted run
 * leaves an operator with.
 *
 * @extends Error
 */
class VolumeHaltError extends Error {
  /**
   * @param {{
   *   step: string,
   *   volume: string,
   *   folder: string,
   *   trigger: Array<PostMortemFinding|{kind: string, level?: FindingLevel}>,
   *   unattemptedVolumes?: string[],
   * }} opts - The step, the volume whose assessment tripped the gate, and what it found.
   */
  constructor({ step, volume, folder, trigger, unattemptedVolumes = [] }) {
    const levels = [...new Set((trigger || []).map((f) => f.level || levelFor(f.kind)))];
    const kinds = (trigger || []).map((f) => `${f.kind}${f.file ? ` (${f.file})` : ""}`).join(", ");
    super(
      `${step}: halted after volume ${volume} (${folder}) — ${levels.join(", ")} finding(s): ` +
        `${kinds || "(none named)"}. ` +
        (unattemptedVolumes.length
          ? `Volumes ${unattemptedVolumes.join(", ")} were not attempted. `
          : "") +
        `Re-run this step from volume ${volume} once the finding is answered (the idempotent ` +
        `skip-checks keep the accepted volumes free).`
    );
    this.name = "VolumeHaltError";
    // The one flag every skip site in this pipeline asks before it skips. See configs/shared/failures.js.
    this.structural = true;
    this.step = step;
    this.volume = volume;
    this.folder = folder;
    this.trigger = trigger || [];
    this.unattemptedVolumes = unattemptedVolumes;
  }
}

// ─── The record a halt leaves ─────────────────────────────────────────────────

/** The file a halted step writes into the run's own records folder. */
const HALT_RECORD_FILE = "last-volume-halt.json";

/**
 * What one halt looks like on disk.
 *
 * @typedef {Object} VolumeHaltRecord
 * @property {string} step - The step that halted. The record is honoured only for this step.
 * @property {string} haltedAfterVolume - The installment number of the last volume the step worked on.
 * @property {string} haltedAfterFolder - Its folder name.
 * @property {string[]} attemptedVolumes - Installment numbers the step actually worked on.
 * @property {string[]} unattemptedVolumes - Installment numbers it never reached.
 * @property {Array<{kind: string, level: FindingLevel, severity?: string, file?: string, message?: string}>} trigger
 *   The findings that stopped the walk.
 * @property {string} at - ISO timestamp.
 */

/**
 * @returns {string} Absolute path of the halt record.
 */
function haltRecordPath() {
  return path.join(postMortemDir(), HALT_RECORD_FILE);
}

/**
 * Record a halt where a separate process can read it.
 *
 * The step runs in its own process (`index/run-step.js`), so an in-process flag cannot cross the
 * boundary — this is the same channel `withStructuralMarker` uses for `last-structural-failure.json`,
 * with the two things that file cannot say: which volume the step stopped after, and which volumes it
 * therefore never attempted.
 *
 * @param {Omit<VolumeHaltRecord, "at">} record
 * @returns {{written: boolean, file: string, error: string|null}}
 */
function writeVolumeHalt(record) {
  const file = haltRecordPath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...record, at: new Date().toISOString() }, null, 2) + "\n", "utf8");
    return { written: true, file, error: null };
  } catch (err) {
    // A halt that cannot write its own record still halts: the error it throws is the guarantee,
    // the record is what makes the after-step assessment read it correctly.
    return { written: false, file, error: String(err.message || err) };
  }
}

/**
 * Read the halt record, or null when there is none (or it cannot be read).
 *
 * @returns {VolumeHaltRecord|null}
 */
function readVolumeHalt() {
  try {
    const parsed = JSON.parse(fs.readFileSync(haltRecordPath(), "utf8"));
    if (!parsed || typeof parsed !== "object" || !parsed.step) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Drop the halt record for a step that is about to run.
 *
 * Without this, a record left by an earlier run would silence the missing output of this one. The
 * loop clears its own step's record before it walks, which is the same rule `index/run-step.js`
 * applies to the structural marker ("this step's outcome, not the previous step's").
 *
 * @param {string} step - The step about to walk. A record belonging to another step is left alone,
 *   because that step's assessment has not run yet.
 * @returns {void}
 */
function clearVolumeHalt(step) {
  const existing = readVolumeHalt();
  if (!existing || existing.step !== step) return;
  try {
    fs.rmSync(haltRecordPath());
  } catch {
    /* a record that cannot be deleted is reported by the assessment that reads it */
  }
}

/**
 * Fold a halt into the after-step assessment, so "we stopped here on purpose" is not mistaken for
 * "every remaining book is broken".
 *
 * The volumes the step never reached keep their missing output out of the finding list (they are
 * counted in `report.halt.suppressedMissing` instead, so the number is not lost); the volume that
 * tripped the gate keeps every finding it earned; and the report is never `ok`, because a step that
 * halted did not finish.
 *
 * @param {import("../postmortem").PostMortemReport} report - The report, mutated in place.
 * @returns {import("../postmortem").PostMortemReport}
 */
function applyVolumeHalt(report) {
  const record = readVolumeHalt();
  if (!record || record.step !== report.step) return report;

  const unattempted = new Set(record.unattemptedVolumes || []);
  const kept = [];
  let suppressed = 0;
  for (const f of report.findings) {
    if (unattempted.has(f.volume) && MISSING_OUTPUT_KINDS.has(f.kind)) {
      suppressed++;
      continue;
    }
    kept.push(f);
  }
  report.findings = kept;
  report.counts = {
    ...report.counts,
    HIGH: kept.filter((f) => f.severity === "HIGH").length,
    MEDIUM: kept.filter((f) => f.severity === "MEDIUM").length,
    LOW: kept.filter((f) => f.severity === "LOW").length,
  };
  // A step that halted did not finish, whatever is left in the finding list.
  report.ok = false;
  report.halt = {
    step: record.step,
    haltedAfterVolume: record.haltedAfterVolume,
    haltedAfterFolder: record.haltedAfterFolder,
    attemptedVolumes: record.attemptedVolumes || [],
    unattemptedVolumes: record.unattemptedVolumes || [],
    suppressedMissing: suppressed,
    trigger: record.trigger || [],
    at: record.at,
  };
  return report;
}

module.exports = {
  HALT_LEVELS,
  HALT_STAGES,
  LOOP_STAGES_NOT_GATED,
  NO_VOLUME_LOOP_STAGES,
  MISSING_OUTPUT_KINDS,
  HALT_RECORD_FILE,
  haltsForStep,
  haltTriggerFor,
  VolumeHaltError,
  haltRecordPath,
  writeVolumeHalt,
  readVolumeHalt,
  clearVolumeHalt,
  applyVolumeHalt,
};
