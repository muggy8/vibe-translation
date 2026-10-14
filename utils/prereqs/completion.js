/**
 * utils/prereqs/completion.js — what "complete" means, read off the folder.
 *
 * Three questions about one prerequisite step, all answered by listing a folder and asking the
 * post-mortem's own one-file verdict: is every `required` artifact this step declares for a volume
 * there and in the shape it declares, is the series-root half there, and are the step's own records in
 * the run's records? Plus the acceptance grade, where the step has one, and the quarantine reading —
 * a `.rejected` counts against the step only when the artifact it NAMES is absent, which is the same
 * reading the post-mortem and the resume triage use (gotcha 141).
 *
 * Every file name is asked out of `utils/artifacts.js`, never written a second time here: a second
 * list is a second opinion about one artifact, and two opinions is how a run calls a volume finished
 * that the post-mortem calls unfinished.
 *
 * @module utils/prereqs/completion
 */

const fs = require("fs");
const path = require("path");

const { specForStep, classifyVolumeQuarantine } = require("../artifacts");
const { assessRunScope, declaresRunScope, postMortemDir } = require("../postmortem");
// `assessFile` is the post-mortem's own one-file verdict — exists / is not a stub / parses / has the
// declared shape. It is required from its module rather than re-implemented here, because a second
// implementation of "is this file what it claims to be" is exactly the pair that drifts. It is not
// on the utils/postmortem barrel today; reaching the leaf keeps this slice from editing a closed
// path (AGENTS.md §3, gotcha 85).
const { assessFile } = require("../postmortem/file");
const { loadRollingState, isAcceptedState } = require("../../configs/shared");

const { gapPhrase } = require("./gap-wording");

/** @typedef {import("../artifacts").ArtifactContext} ArtifactContext */
/** @typedef {import("../artifacts").StepArtifactSpec} StepArtifactSpec */
/** @typedef {import("../types").TranslationTargetVolume} TranslationTargetVolume */

/**
 * Whether a quarantine file in a volume folder makes a prerequisite incomplete.
 *
 * Not by its name, and not by its severity. Three acts write through the one quarantine door
 * (`utils/reference-store/quarantine.js`'s `moveArtifactAside`): the carry-forward guard refusing an
 * artifact, the acceptance grade refusing one, and a re-render replacing one and keeping the copy it
 * replaced. All three write the same name, and the third is what `npx gulp glossary --force` and every
 * resumed run do. So the question is the one `utils/artifacts` answers from the disk: **is the artifact
 * this quarantine NAMES also in the folder?** Present → a kept copy, and the volume is finished. Absent
 * → a gate refused this volume's output and nothing replaced it.
 *
 * `QUARANTINED_DRAFT` names no declared artifact (`translation-<id>.rejected.md` is not a declared
 * name), so it is never damage: the draft is kept ON PURPOSE so `retranslate` has something to repair
 * (gotcha 39), and a volume that went through a repair round and came out fine still carries those
 * files. Gotcha 130's lesson: a gate that halts on a false positive is worse than no gate — and this
 * gate was refusing `glossary`, `character-voice` AND `style-guide` on one `character-voice.md.rejected`,
 * because the pattern is shared and the name was the only thing it asked.
 *
 * @param {import("../artifacts").QuarantineExpectation} quarantine - The expectation that matched.
 * @param {Object} facts
 * @param {string} facts.name - The file name that matched.
 * @param {import("../artifacts").StepArtifactSpec} facts.spec - The prerequisite step being checked.
 * @param {string} facts.installment - The volume's installment number.
 * @param {Set<string>} facts.presentNames - Every regular file in that volume folder.
 * @returns {boolean}
 */
function quarantineBlocksCompletion(quarantine, facts) {
  const read = classifyVolumeQuarantine({
    quarantine,
    name: facts.name,
    spec: facts.spec,
    installment: facts.installment,
    presentNames: facts.presentNames,
  });
  return read.blocksCompletion;
}

/**
 * One volume folder, one prerequisite step: is the work this step owes THIS volume finished?
 *
 * @param {Object} opts
 * @param {string} opts.step
 * @param {StepArtifactSpec} opts.spec
 * @param {string} opts.seriesDir
 * @param {TranslationTargetVolume} opts.volumeEntry
 * @param {ArtifactContext} opts.ctx
 * @returns {Promise<string[]>} Human-readable gaps, empty when the volume is complete.
 */
async function volumeGaps({ step, spec, seriesDir, volumeEntry, ctx }) {
  const gaps = [];
  const installment = volumeEntry.installmentNumber;
  const volumeDir = path.join(seriesDir, volumeEntry.folder);

  let names;
  try {
    names = (await fs.promises.readdir(volumeDir, { withFileTypes: true }))
      .filter((e) => e.isFile() || e.isSymbolicLink())
      .map((e) => e.name);
  } catch {
    return [`volume ${installment} has no folder (${volumeEntry.folder}) — ${step} never wrote it`];
  }

  // 0. The gate evidence in this folder, read beside the folder. A quarantine whose named artifact is
  //    ALSO here is the copy a re-render replaced — normal output, and no business of this gate. One
  //    whose named artifact is absent is a refusal, and it belongs to the step that declares that
  //    artifact and to no other (`QUARANTINED_CUMULATIVE` is one pattern shared by three steps, so
  //    matching the pattern alone used to refuse `glossary`, `character-voice` AND `style-guide` on one
  //    `character-voice.md.rejected`).
  const presentNames = new Set(names);
  /** @type {Map<string, {name: string, meaning: string}[]>} stem -> the refusals that name it */
  const refusals = new Map();
  for (const quarantine of spec.quarantines || []) {
    for (const name of names) {
      if (!quarantine.pattern.test(name)) continue;
      const read = classifyVolumeQuarantine({ quarantine, name, spec, installment, presentNames });
      if (!read.blocksCompletion) continue;
      const list = refusals.get(read.stem) || [];
      list.push({ name, meaning: read.meaning });
      refusals.set(read.stem, list);
    }
  }

  // 1. Every `required` expectation, judged by the post-mortem's own one-file verdict. When the gap is
  //    one a gate left its evidence beside, the evidence rides along in the same sentence: "volume 01
  //    has no glossary.md" is true and useless next to "…and it holds glossary.md.rejected, the gate's
  //    own account". One gap per damaged artifact, never two.
  const volumeCtx = { ...ctx, installment };
  const requiredNames = new Set();
  for (const expectation of spec.volume) {
    if (expectation.level !== "required") continue;
    if (expectation.when && !expectation.when(volumeCtx)) continue;
    const name = expectation.name.replace("{installment}", installment);
    requiredNames.add(name);
    const res = await assessFile(
      path.join(volumeDir, name),
      { ...expectation, name },
      step,
      installment,
      `${volumeEntry.folder}/${name}`
    );
    if (!res) continue;
    const evidence = (refusals.get(name) || []).map((r) => `and it holds ${r.name}: ${r.meaning}`).join("; ");
    gaps.push(`volume ${installment} ${gapPhrase(res, { ...expectation, name })}${evidence ? ` — ${evidence}` : ""}`);
  }

  // 2. The acceptance grade, through the same test the idempotent skip-check uses.
  for (const expectation of spec.volume) {
    if (expectation.shape !== "json" || !expectation.name.endsWith("-rolling-state.json")) continue;
    const name = expectation.name.replace("{installment}", installment);
    const state = await loadRollingState(path.join(volumeDir, name));
    // A missing or unparseable window is already reported by the required-file check above; this
    // half is only for the window that exists and did not pass.
    if (!state) continue;
    if (!isAcceptedState(state)) {
      const scores = (state.results || []).join(", ") || "no grades";
      gaps.push(
        `volume ${installment} has no passing acceptance grade — its window [${scores}] never met ` +
          `the criterion, so no grader signed it off`
      );
    }
  }

  // 3. A refusal this gate has not already named through a `required` expectation — a quarantine of an
  //    artifact this step declares at `expected` level, or one whose declared name is a template this
  //    volume's folder does not use. Nothing a guard refused may be dropped because the wording did not
  //    line up.
  for (const [stem, list] of refusals) {
    if (requiredNames.has(stem)) continue;
    for (const r of list) gaps.push(`volume ${installment} holds ${r.name} and has no ${stem}: ${r.meaning}`);
  }

  return gaps;
}

/**
 * The series-root half of a prerequisite step's declared output.
 *
 * Checked whenever the step has no per-volume output at all (`discover`, `consistency-audit` — a
 * narrowed run still needs the plan of record and still needs the sign-off), and otherwise only for
 * a whole-series run, which is the same rule the post-mortem applies: the tasks deliberately do not
 * publish a stale series copy for one volume.
 *
 * @param {Object} opts
 * @param {string} opts.step
 * @param {StepArtifactSpec} opts.spec
 * @param {string} opts.seriesDir
 * @param {boolean} opts.narrowed - The run is narrowed by `--volume`.
 * @returns {Promise<string[]>}
 */
async function seriesGaps({ step, spec, seriesDir }) {
  const gaps = [];
  for (const expectation of spec.series || []) {
    if (expectation.level !== "required") continue;
    const res = await assessFile(
      path.join(seriesDir, expectation.name),
      expectation,
      step,
      null,
      expectation.name
    );
    if (res) gaps.push(`the series root ${gapPhrase(res, expectation)}`);
  }
  return gaps;
}

/**
 * The run-record half of a prerequisite step's declared output (`extract`'s per-book reports).
 *
 * @param {Object} opts
 * @param {string} opts.step
 * @param {StepArtifactSpec} opts.spec
 * @param {ArtifactContext} opts.ctx
 * @param {TranslationTargetVolume[]} opts.volumes
 * @returns {Promise<string[]>}
 */
async function runGaps({ step, spec, ctx, volumes }) {
  if (!declaresRunScope(spec)) return [];
  let runDir;
  try {
    runDir = postMortemDir();
  } catch {
    return [`the run's own records folder could not be resolved, so ${step}'s records cannot be checked`];
  }
  const findings = await assessRunScope({ spec, step, runDir, ctx, volumes });
  return findings
    .filter((f) => f.severity === "HIGH")
    .map((f) => {
      const where = f.volume
        ? `volume ${f.volume} has no ${f.file} in the run's records`
        : `the run's records have no ${f.file}`;
      return `${where} (${f.kind})`;
    });
}

/**
 * Is one prerequisite step complete, for the volumes this run is about to process?
 *
 * @param {Object} opts
 * @param {string} opts.step
 * @param {string} opts.seriesDir
 * @param {TranslationTargetVolume[]} opts.volumes
 * @param {boolean} opts.narrowed
 * @param {ArtifactContext} opts.ctx
 * @returns {Promise<string[]>} Gaps; empty means complete.
 */
async function stepGaps({ step, seriesDir, volumes, narrowed, ctx }) {
  const spec = specForStep(step);
  if (!spec) return [`${step} has no entry in utils/artifacts.js, so nothing can say it finished`];
  const gaps = [];
  if (spec.perVolume) {
    for (const volumeEntry of volumes) {
      gaps.push(...(await volumeGaps({ step, spec, seriesDir, volumeEntry, ctx })));
    }
  }
  if (!narrowed || !spec.perVolume) {
    gaps.push(...(await seriesGaps({ step, spec, seriesDir })));
  }
  gaps.push(...(await runGaps({ step, spec, ctx, volumes })));
  return gaps;
}

module.exports = {
  quarantineBlocksCompletion,
  volumeGaps,
  seriesGaps,
  runGaps,
  stepGaps,
};
