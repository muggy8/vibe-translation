/**
 * utils/postmortem/scope.js — the run folder: the records a step or a command left behind.
 *
 * The other three files of this layer assess a step's output where the output lives — in a volume
 * folder, or at the series root. The delivery layer's output is not in the corpus at all: it is the
 * plan of record, the ticket channel and the patch channel, and they all sit in one folder
 * (`POSTMORTEM_DIR`) that the corpus-facing assessment never walks.
 *
 * So this is the same question asked of a third place. It is the same code doing it — `assessFile`
 * from ./file.js, `finding` from ./rules.js — because "exists, is not a stub, parses, has the shape
 * its writer always gives it" is not a different question when the file is a JSON record instead of
 * a Markdown artifact.
 *
 * TWO SHAPES OF RUN EXPECTATION. A run record is either ONE file for the whole run
 * (`delivery-plan.md`, `tickets.json`, `extraction-summary.md`) or ONE FILE PER VOLUME the run was
 * asked to process (`extraction-01.md` … `extraction-17.md`). The second shape is what
 * `perInstallment: true` declares, and it is what makes a step that writes one report per book
 * checkable at all: a flat list of file names can say "the summary is missing" but cannot tell
 * "the step ran and found nothing" from "the step stopped after book 9", which is the whole reason
 * the account owner asked for the per-book half (`utils/postmortem/plan/01-finding-levels.md` §10).
 * A per-installment expectation is expanded against the volumes THIS run was asked to process, so a
 * `--volume=05` run expects volume 05's report and is not blamed for the other sixteen.
 *
 * What it deliberately does NOT do: read the CONTENT of those records. A ticket that parses and is
 * empty of meaning, a patch that names a ticket that does not exist, a lock left by a process that
 * has exited — those are questions about the relationship between records, and they are asked in
 * utils/delivery-audit.js, which is allowed to know what a ticket is. This file is kept free of that
 * knowledge on purpose: utils/tickets, utils/patches, utils/ledger and utils/runlock each resolve
 * their own folder through utils/postmortem, so a module inside the postmortem layer that reached
 * back for them would close a require cycle and hand them a half-built barrel.
 */

const path = require("path");

const { assessFile } = require("./file");

/** @typedef {import("../postmortem").PostMortemFinding} PostMortemFinding */
/** @typedef {import("../artifacts").ArtifactExpectation} ArtifactExpectation */
/** @typedef {import("../artifacts").ArtifactContext} ArtifactContext */
/** @typedef {import("../types").TranslationTargetVolume} TranslationTargetVolume */

// ─── The run scope ────────────────────────────────────────────────────────────

/**
 * Whether a spec declares anything in the run folder.
 *
 * @param {import("../artifacts").StepArtifactSpec} spec
 * @returns {boolean}
 */
function declaresRunScope(spec) {
  return Boolean(spec && Array.isArray(spec.run) && spec.run.length > 0);
}

/**
 * Whether a spec declares a run expectation that is written once per volume.
 *
 * This is the question `runPostMortem` asks to decide whether it can assess the step at all without
 * a plan of record: a per-installment expectation names files after volumes, and the list of volumes
 * only exists in the plan. A step whose run expectations are all whole-run files (the four delivery
 * commands) needs no plan, and `diagnose` / `fix` must stay assessable when pointed at a ticket with
 * no readable series folder beside them.
 *
 * @param {import("../artifacts").StepArtifactSpec} spec
 * @returns {boolean}
 */
function declaresPerInstallmentRunScope(spec) {
  return Boolean(spec && Array.isArray(spec.run) && spec.run.some((e) => e.perInstallment === true));
}

/**
 * The key a per-volume run record is named after.
 *
 * It MUST be the key the writer used, or the check looks for a file the step never promised and
 * reports a healthy run as missing its report. `extract/reports.js` names its reports
 * `extraction-<safeReportKey(installmentNumber || folder)>`; this is that same rule, and
 * `test/test-extract-run-scope.js` pins the two against each other over the awkward inputs
 * (a folder name with brackets and Japanese, an empty installment, a leading dot) because two
 * implementations of one naming rule is exactly the kind of pair that drifts.
 *
 * @param {TranslationTargetVolume|{installmentNumber?: string, folder?: string}} volumeEntry
 * @returns {string} The file-name-safe key, e.g. `01`.
 */
function runScopeVolumeKey(volumeEntry) {
  const s = String((volumeEntry && (volumeEntry.installmentNumber || volumeEntry.folder)) || "")
    .trim();
  if (!s) return "unknown";
  return s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "").slice(0, 64) || "unknown";
}

/**
 * The concrete files one run expectation resolves to.
 *
 * A whole-run expectation is one file. A `perInstallment` expectation is one file per volume this
 * run was asked to process, with `{installment}` replaced by that volume's report key, and each
 * finding carries the volume it belongs to — which is what lets the report name WHICH book lost its
 * report instead of reporting a step that "did not finish".
 *
 * @param {ArtifactExpectation} expectation
 * @param {TranslationTargetVolume[]} [volumes] - The volumes this run was asked to process, already
 *   filtered by `--volume`. Ignored by a whole-run expectation.
 * @returns {Array<{name: string, volume: string|null}>}
 */
function runScopeTargets(expectation, volumes) {
  if (expectation.perInstallment !== true) return [{ name: expectation.name, volume: null }];
  return (volumes || []).map((v) => ({
    name: expectation.name.replace("{installment}", runScopeVolumeKey(v)),
    volume: v.installmentNumber || null,
  }));
}

/**
 * Assess the declared run-folder expectations for one step or delivery command.
 *
 * A `when` predicate that returns false skips the expectation entirely, which is what keeps the
 * check honest on the paths that legitimately write nothing: `--no-write`, `--open`, `--status`.
 * A `required` expectation whose `when` DID pass and whose file is absent is HIGH — the command
 * claimed it wrote the record and the disk says otherwise.
 *
 * @param {Object} opts
 * @param {import("../artifacts").StepArtifactSpec} opts.spec
 * @param {string} opts.step - The gulp task or delivery command name.
 * @param {string} opts.runDir - Absolute path to the run folder (`postMortemDir()`).
 * @param {ArtifactContext} opts.ctx - What the command claims it did.
 * @param {TranslationTargetVolume[]} [opts.volumes] - The volumes this run was asked to process.
 *   Only consulted by a `perInstallment` expectation, so the four delivery commands are assessed
 *   exactly as they were before that shape existed.
 * @returns {Promise<PostMortemFinding[]>}
 */
async function assessRunScope({ spec, step, runDir, ctx, volumes }) {
  const findings = [];
  for (const expectation of spec.run || []) {
    if (expectation.when && !expectation.when(ctx)) continue;
    for (const target of runScopeTargets(expectation, volumes)) {
      const abs = path.join(runDir, target.name);
      const res = await assessFile(abs, { ...expectation, name: target.name }, step, target.volume, target.name);
      if (res) findings.push(res);
    }
  }
  return findings;
}

/**
 * The run folder's own report line: what was looked for, and what was found there.
 *
 * Kept separate from the volume/series counts because a delivery command assesses no volume, and a
 * report that says "0 volumes, 0 expectations checked" for a command that checked three records
 * would read as though nothing was looked at. A per-installment expectation counts once per volume,
 * which is the number that proves the per-book reports were actually looked for.
 *
 * @param {Object} opts
 * @param {import("../artifacts").StepArtifactSpec} opts.spec
 * @param {ArtifactContext} opts.ctx
 * @param {TranslationTargetVolume[]} [opts.volumes] - The volumes this run was asked to process.
 * @returns {number} How many run-scope expectations actually applied to this run.
 */
function countRunExpectations({ spec, ctx, volumes }) {
  return (spec.run || [])
    .filter((e) => !e.when || e.when(ctx))
    .reduce((n, e) => n + runScopeTargets(e, volumes).length, 0);
}

module.exports = {
  assessRunScope,
  countRunExpectations,
  declaresRunScope,
  declaresPerInstallmentRunScope,
  runScopeTargets,
  runScopeVolumeKey,
};
