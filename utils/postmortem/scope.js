/**
 * utils/postmortem/scope.js — the run folder: the records a delivery command left behind.
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
/** @typedef {import("../artifacts").ArtifactContext} ArtifactContext */

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
 * Assess the declared run-folder expectations for one delivery command.
 *
 * A `when` predicate that returns false skips the expectation entirely, which is what keeps the
 * check honest on the paths that legitimately write nothing: `--no-write`, `--open`, `--status`.
 * A `required` expectation whose `when` DID pass and whose file is absent is HIGH — the command
 * claimed it wrote the record and the disk says otherwise.
 *
 * @param {Object} opts
 * @param {import("../artifacts").StepArtifactSpec} opts.spec
 * @param {string} opts.step - The delivery command name.
 * @param {string} opts.runDir - Absolute path to the run folder (`postMortemDir()`).
 * @param {ArtifactContext} opts.ctx - What the command claims it did.
 * @returns {Promise<PostMortemFinding[]>}
 */
async function assessRunScope({ spec, step, runDir, ctx }) {
  const findings = [];
  for (const expectation of spec.run || []) {
    if (expectation.when && !expectation.when(ctx)) continue;
    const abs = path.join(runDir, expectation.name);
    const res = await assessFile(abs, expectation, step, null, expectation.name);
    if (res) findings.push(res);
  }
  return findings;
}

/**
 * The run folder's own report line: what was looked for, and what was found there.
 *
 * Kept separate from the volume/series counts because a delivery command assesses no volume, and a
 * report that says "0 volumes, 0 expectations checked" for a command that checked three records
 * would read as though nothing was looked at.
 *
 * @param {Object} opts
 * @param {import("../artifacts").StepArtifactSpec} opts.spec
 * @param {ArtifactContext} opts.ctx
 * @returns {number} How many run-scope expectations actually applied to this run.
 */
function countRunExpectations({ spec, ctx }) {
  return (spec.run || []).filter((e) => !e.when || e.when(ctx)).length;
}

module.exports = { assessRunScope, countRunExpectations, declaresRunScope };
