/**
 * utils/prereqs/freeze/gate.js — the decision: may this door rewrite what it is about to rewrite?
 *
 * One question, answered by reading the disk. It writes nothing, makes no model call and consults no
 * flag: `--force`, `--allow-fail`, `ON_TASK_ERROR=continue`, `ON_VOLUME_ERROR=skip`, the ledger and the
 * resume menu are not inputs, because the CALLER reports `cancelledBy` — what its own act would do —
 * rather than a permission. A door reporting one of `NOT_A_REWRITE`'s cancellations is passed without
 * a folder being read; an unrecognised cancellation is treated as a rewrite, because a gate that failed
 * open on a word it did not know is a gate a caller could widen by inventing a label. The refusal is a
 * STRUCTURAL error, so no run policy can walk past it.
 *
 * @module utils/prereqs/freeze/gate
 */

const fs = require("fs");
const path = require("path");

const { structuralError } = require("../../../configs/shared");
const { NOT_A_REWRITE, freezeDoorRow } = require("./doors");
const { doorArtifacts } = require("./declared-artifacts");
const { readFreezeScope } = require("./frozen-state");
const { MIN_RELEASE_REASON_CHARS, readTranslationReleases, releaseCovering } = require("./releases");
const { CANCEL_WORDS, freezeGap } = require("./wording");

/** @typedef {import("../../types").TranslationTargetVolume} TranslationTargetVolume */

/** @typedef {import("./releases").TranslationRelease} TranslationRelease */

/** @typedef {import("./wording").FreezeGap} FreezeGap */

/**
 * Ask whether one door may rewrite what it is about to rewrite.
 *
 * Reads the disk only. It writes nothing, makes no model call, and consults no flag: `--force`,
 * `--allow-fail`, `ON_TASK_ERROR=continue`, `ON_VOLUME_ERROR=skip`, the ledger and the resume menu
 * are not inputs to this question — the CALLER reports `cancelledBy`, which is what its own act
 * would do, not a permission.
 *
 * @param {Object} opts
 * @param {string} opts.door - The gulp task name or the manual door name.
 * @param {string} opts.seriesDir - `SERIES_LOCATION`.
 * @param {string} opts.cancelledBy - Why this act would rewrite rather than skip, from the door's own
 *   skip decision (`skipDecisionFor` in utils/series-run/skip.js, or the door's own freshness rule).
 *   One of `NOT_A_REWRITE` means the act writes nothing and the gate passes it without reading a folder.
 * @param {string} [opts.detail] - Extra fact the wording needs (the cascade's source volume).
 * @param {string|null} [opts.volumeArg] - The `--volume` filter.
 * @param {TranslationTargetVolume[]} [opts.volumes] - The volumes the caller already resolved.
 * @param {TranslationRelease[]} [opts.releases] - Recorded releases the caller has already read. When
 *   omitted this function reads the release record itself.
 * @returns {Promise<{
 *   ok: boolean, door: string, gated: boolean, frozen: FreezeGap[],
 *   headline: string, bullets: string[], message: string, recordError: string|null,
 * }>}
 */
async function evaluateFreeze({ door, seriesDir, cancelledBy, detail, volumeArg = null, volumes = null, releases = null }) {
  const row = freezeDoorRow(door);
  const pass = { ok: true, door, gated: Boolean(row), frozen: [], headline: "", bullets: [], message: "", recordError: null, notARewrite: null };
  if (!row) return pass;
  // "Frozen" is only ever a reason to refuse an act that REWRITES. A door reporting one of the
  // not-a-rewrite cancellations is not asking to overwrite anything, and the gate says so in its own
  // verdict rather than relying on the caller not to ask (the rule, in the table, not in the callers).
  if (NOT_A_REWRITE[String(cancelledBy || "")]) return { ...pass, notARewrite: NOT_A_REWRITE[String(cancelledBy)] };
  if (!seriesDir) {
    return {
      ...pass,
      ok: false,
      frozen: [],
      headline: `${door} refuses to rewrite anything: SERIES_LOCATION is not set, so nothing can be checked.`,
      bullets: [],
      message: `${door} refuses to rewrite anything: SERIES_LOCATION is not set.`,
    };
  }

  const scope = await readFreezeScope({ seriesDir, volumeArg, volumes });
  if (scope.error) {
    return {
      ...pass,
      ok: false,
      headline: `${door} refuses to rewrite anything: ${scope.error}`,
      bullets: [scope.error],
      message: `${door} refuses to rewrite anything: ${scope.error}`,
    };
  }

  let releaseRows = releases;
  let recordError = null;
  if (!Array.isArray(releaseRows)) {
    const read = readTranslationReleases();
    releaseRows = read.releases;
    recordError = read.error;
  }

  // An unrecognised cancellation is treated as a rewrite. A gate that failed OPEN on a word it did not
  // know would be a gate a caller could widen by inventing a label.
  const undeclared = !CANCEL_WORDS[String(cancelledBy || "")] && !NOT_A_REWRITE[String(cancelledBy || "")];

  /** @type {FreezeGap[]} */
  const frozen = [];
  for (const volume of scope.volumes) {
    if (!volume.frozen) continue;
    if (releaseCovering(releaseRows, volume.installment, door)) continue;
    if (row.missingIsRepair) {
      // Filling a hole is not overwriting. The artifact this door would write is not there, so the
      // act completes a half-built volume rather than replacing what a translation consumed. This is
      // the one skip-cancelling condition that is NOT a rewrite, and it is what keeps the gate from
      // refusing a half-translated series for being half-translated (gotcha 130).
      //
      // A SERIES door is judged against the series root, which is the only folder it writes; judging
      // it against a volume folder would find `consistency-report.md` missing in every volume and
      // excuse the audit from the freeze entirely.
      const base = row.scope === "series" ? seriesDir : path.join(seriesDir, volume.folder);
      const names = doorArtifacts(row, door, volume.installment);
      const present = names.filter((name) => fs.existsSync(path.join(base, name)));
      if (names.length > 0 && present.length < names.length) continue;
    }
    frozen.push(freezeGap({ row, volume, cancelledBy, detail }));
  }

  if (frozen.length === 0) return { ...pass, recordError, undeclaredCancellation: undeclared };

  const shown = frozen.slice(0, 8);
  const hidden = frozen.length - shown.length;
  const bullets = shown.map((g) => g.line);
  if (hidden > 0) bullets.push(`… ${hidden} more frozen volume(s).`);
  if (undeclared) {
    bullets.push(
      `(the reason given for rewriting — ${JSON.stringify(cancelledBy)} — is not one this gate knows, so it is ` +
        `treated as a rewrite rather than waved through.)`
    );
  }
  const volumesArg = frozen.map((g) => g.installment).join(",");
  bullets.push(
    `To do this on purpose: \`node release-translation.js --volume=${volumesArg} --door=${door} ` +
      `--reason="…"\` — a reason of at least ${MIN_RELEASE_REASON_CHARS} characters, recorded in the run's ` +
      `own records, naming the translations it invalidates. It touches no translation.`
  );
  const headline =
    `${door} refuses to rewrite ${frozen.length} volume(s): their translation is already published. ` +
    `This gate has no override.`;
  return {
    ok: false,
    door,
    gated: true,
    frozen,
    headline,
    bullets,
    message: `${headline}\n  - ${bullets.join("\n  - ")}`,
    recordError,
    undeclaredCancellation: undeclared,
  };
}

/**
 * The refusal this gate throws: a STRUCTURAL error, so `ON_TASK_ERROR=continue` and
 * `ON_VOLUME_ERROR=skip` cannot walk past it (the shape `utils/postmortem/halt.js` uses).
 *
 * @param {string} message
 * @returns {Error}
 */
function freezeRefusal(message) {
  return structuralError(message);
}

/**
 * The door a stage or a manual command knocks on: ask, report, and refuse unless this is a dry run.
 *
 * `--dry-run` reports and does not refuse — the prerequisite gate's rule, kept identical so the two
 * gates behave the same way for the same flag.
 *
 * @param {Object} opts
 * @param {string} opts.door
 * @param {string} opts.seriesDir
 * @param {string} opts.cancelledBy
 * @param {string} [opts.detail]
 * @param {string|null} [opts.volumeArg]
 * @param {TranslationTargetVolume[]} [opts.volumes]
 * @param {boolean} [opts.dryRun]
 * @param {(line: string) => void} [opts.log]
 * @returns {Promise<{ok: boolean, reported: boolean, verdict: Object}>}
 * @throws {Error} A structural refusal when the act would rewrite a frozen volume.
 */
async function assertDoorAllowed({ door, seriesDir, cancelledBy, detail, volumeArg = null, volumes = null, dryRun = false, log = console.error }) {
  const verdict = await evaluateFreeze({ door, seriesDir, cancelledBy, detail, volumeArg, volumes });
  if (verdict.ok) return { ok: true, reported: false, verdict };
  if (dryRun) {
    log(`[freeze] ${door} — DRY RUN, so the freeze gate reports and does NOT refuse: ${verdict.frozen.length} volume(s) would be rewritten.`);
    for (const bullet of verdict.bullets) log(`[freeze]   - ${bullet}`);
    return { ok: false, reported: true, verdict };
  }
  throw freezeRefusal(verdict.message);
}

module.exports = {
  evaluateFreeze,
  freezeRefusal,
  assertDoorAllowed,
};
