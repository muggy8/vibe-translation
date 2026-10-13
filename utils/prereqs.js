/**
 * utils/prereqs.js — the one table of what must already be finished before a step may start.
 *
 * Why this exists. The account owner's rule is that a run goes **pre-production → translation →
 * polish**, and once it is in translation the reference artifacts are frozen. Until 2026-10-13 the
 * only thing enforcing any of that was a hand-written pair of checks inside `translate`
 * (`checkTranslationPreconditions`): a PASS/FAIL `consistency-report.md` and a per-volume
 * `glossary.md`, both waveable past with a flag. Nothing gated `polish` on `translate`, nothing
 * gated `consistency-audit` on the four artifacts it audits, nothing gated `glossary` on `extract`,
 * and nothing gated anything on `discover`. Measured before this module existed: a fixture series
 * with a PASS audit and a glossary in every volume but **no character-voice, no style-guide and no
 * wiki** was allowed to start `translate`, and with `--allow-fail --allow-no-glossary` it was
 * allowed to start with **no glossary at all**.
 *
 * Three rules this file keeps.
 *
 *   1. **The order is declared data, in a closed path.** It is not a stage's judgement and there is
 *      no knob on it. `utils/patches/rules.js` bans this module for the dev team for the same reason
 *      it bans the finding level table (AGENTS.md §4 rule 3, gotcha 70): a role that can edit the
 *      rule that stops it is not being stopped.
 *   2. **"Completed" is read off the disk, not remembered by this process.** A prerequisite is
 *      complete when the files that step's own declaration in `utils/artifacts.js` promises are on
 *      disk in the shape that declaration says, and — where the step has an acceptance grade — when
 *      the volume's persisted acceptance state passes. There is no second list of expected files
 *      here on purpose: a second list is a second opinion, and two opinions about one artifact is
 *      how a run ends up calling a volume finished that the post-mortem calls unfinished.
 *   3. **The table does not order the pre-production steps among themselves.** `glossary`,
 *      `character-voice`, `style-guide` and `jump-in-wiki` each require `discover` and `extract` and
 *      nothing else, so any order of those four is legal. Only `consistency-audit` depends on all
 *      four, and only the translation stage depends on the audit. That is the owner's rule, and
 *      `test/test-prerequisite-gate.js` pins it by running three different orders.
 *
 * What a refusal looks like. It names the nearest missing thing and the chain that led there,
 * because a refusal that only says "prerequisite missing" is a refusal nobody can act on:
 *
 *     translate refuses to start: 1 prerequisite is not complete.
 *       - `translate` needs `consistency-audit`, which needs `character-voice`; volume 03 has no
 *         `character-voice.md` (the cumulative character voice reference). Run
 *         `npx gulp character-voice --volume 03` first.
 *
 * The chain is built through the **nearest consumer** of the missing step — the last step in run
 * order that declares it — because that is also the step you have to re-run after you fix it.
 *
 * @module utils/prereqs
 */

const fs = require("fs");
const path = require("path");

const { specForStep } = require("./artifacts");
const { assessRunScope, declaresRunScope, postMortemDir } = require("./postmortem");
// `assessFile` is the post-mortem's own one-file verdict — exists / is not a stub / parses / has the
// declared shape. It is required from its module rather than re-implemented here, because a second
// implementation of "is this file what it claims to be" is exactly the pair that drifts. It is not
// on the utils/postmortem barrel today; reaching the leaf keeps this slice from editing a closed
// path (AGENTS.md §3, gotcha 85).
const { assessFile } = require("./postmortem/file");
const { loadRollingState, isAcceptedState, structuralError } = require("../configs/shared");
const { filterVolumesByInstallment } = require("./manifest");

/** @typedef {import("./artifacts").ArtifactContext} ArtifactContext */
/** @typedef {import("./artifacts").StepArtifactSpec} StepArtifactSpec */
/** @typedef {import("./postmortem").PostMortemFinding} PostMortemFinding */
/** @typedef {import("./types").TranslationTargetVolume} TranslationTargetVolume */

// ─── The table ────────────────────────────────────────────────────────────────

/**
 * One edge: a step this step needs, and why it needs it.
 *
 * @typedef {Object} PrerequisiteEdge
 * @property {string} step - The prerequisite's gulp task name.
 * @property {string} because - One line, written for the person who is being refused.
 */

/**
 * Every step's prerequisites, as data.
 *
 * The keys are exactly the ten names in `gulpfile.js`'s `PIPELINE_STEPS`. A step missing from this
 * table has no prerequisites, which is why `test/test-prerequisite-gate.js` pins the two lists
 * against each other: a new pipeline step that is not declared here silently gets a free pass.
 *
 * @type {Record<string, PrerequisiteEdge[]>}
 */
const STEP_PREREQUISITES = Object.freeze({
  discover: [],

  extract: [
    {
      step: "discover",
      because:
        "it converts the books the intake named: without the plan of record there is no answer to " +
        "which file is volume NN",
    },
  ],

  glossary: [
    { step: "discover", because: "the volume folders and their reading order come from the plan of record" },
    {
      step: "extract",
      because: "the terms are read out of the extracted text, so the extraction audit has to have run " +
        "over that text first — a glossary built on a book that failed its own audit inherits the damage",
    },
  ],

  "character-voice": [
    { step: "discover", because: "the volume folders and their reading order come from the plan of record" },
    {
      step: "extract",
      because: "the voice reference quotes the book, and a quote is only checkable against text the " +
        "extraction step verified",
    },
  ],

  "style-guide": [
    { step: "discover", because: "the volume folders and their reading order come from the plan of record" },
    {
      step: "extract",
      because: "the guide records how source constructs are rendered, and a construct has to be in the " +
        "extracted text to be rendered at all",
    },
  ],

  "jump-in-wiki": [
    { step: "discover", because: "the volume folders and their reading order come from the plan of record" },
    {
      step: "extract",
      because: "the wiki is written from the volume's chapters, and `chapters.json` — the handoff the " +
        "whole translation stage is driven by — comes out of the bundle the extraction step produced",
    },
  ],

  "consistency-audit": [
    { step: "glossary", because: "it is one of the four artifacts the audit checks against each other" },
    { step: "character-voice", because: "it is one of the four artifacts the audit checks against each other" },
    { step: "style-guide", because: "it is one of the four artifacts the audit checks against each other" },
    {
      step: "jump-in-wiki",
      because: "it is one of the four artifacts the audit checks against each other, and its shared-wiki " +
        "copy is the story state the audit reads",
    },
  ],

  translate: [
    { step: "discover", because: "the stage translates the volumes the intake named, in the order it decided" },
    {
      step: "extract",
      because: "the translator is given the extracted chapter text; a book that failed its extraction " +
        "audit would be translated as though it were intact",
    },
    {
      step: "glossary",
      because: "terminology is the one thing the translation stage cannot repair afterwards — " +
        "verification can flag a wrong rendering, only the glossary can decide the right one",
    },
    {
      step: "character-voice",
      because: "a character who speaks in one volume and is described in another needs the reference to " +
        "be translated consistently",
    },
    { step: "style-guide", because: "how the source's constructs are rendered is decided before the chapter is written, not after" },
    {
      step: "jump-in-wiki",
      because: "its `chapters.json` is the chapter list the stage iterates, and `translation-brief.md` " +
        "is what the translator is told about this volume",
    },
    {
      step: "consistency-audit",
      because: "it is the sign-off that the four references agree with each other; translating a set of " +
        "references that contradict one another inherits the contradiction for the whole book",
    },
  ],

  "translate-qa": [
    {
      step: "translate",
      because: "the loop verifies and repairs drafts; with no draft there is nothing to verify and " +
        "nothing to repair",
    },
  ],

  polish: [
    {
      step: "translate",
      because: "polish rewrites published text — it cannot polish a volume that has no translation",
    },
    {
      step: "translate-qa",
      because: "polishing a chapter that has not passed verification rewrites text the run has not " +
        "checked against the source, and the polish drift audit has nothing to compare it against",
    },
  ],
});

/**
 * The steps this table knows about, in gulp run order.
 * @returns {string[]}
 */
function declaredPrerequisiteSteps() {
  return Object.keys(STEP_PREREQUISITES);
}

/**
 * The direct prerequisites of one step, or an empty list when it has none (or is not declared).
 *
 * @param {string} step - A gulp task name.
 * @returns {PrerequisiteEdge[]}
 */
function prerequisitesFor(step) {
  return STEP_PREREQUISITES[String(step || "")] || [];
}

/**
 * Every step reachable below one, transitively, each with the shortest number of hops to it.
 *
 * @param {string} step - The step being gated.
 * @returns {Map<string, {depth: number}>} Prerequisite step → its depth below `step`.
 */
function transitivePrerequisites(step) {
  const found = new Map();
  const queue = [{ step, depth: 0 }];
  while (queue.length > 0) {
    const here = queue.shift();
    for (const edge of prerequisitesFor(here.step)) {
      if (found.has(edge.step)) continue;
      found.set(edge.step, { depth: here.depth + 1 });
      queue.push({ step: edge.step, depth: here.depth + 1 });
    }
  }
  return found;
}

/**
 * The steps that name one step in their own prerequisites.
 *
 * @param {string} target - The step being asked about.
 * @returns {string[]} Consumer step names, in table order.
 */
function consumersOf(target) {
  return Object.keys(STEP_PREREQUISITES).filter(
    (step) => prerequisitesFor(step).some((edge) => edge.step === target)
  );
}

/**
 * The run-order position of a step, used to pick the NEAREST consumer when several steps need it.
 *
 * "Nearest" is the consumer that comes last in the default run, because that is also the step the
 * operator has to re-run after fixing the missing one — which is the fact a refusal has to carry.
 *
 * @param {string} step
 * @returns {number} A larger number means later in the run; unknown steps sort first.
 */
function runOrderOf(step) {
  const order = Object.keys(STEP_PREREQUISITES);
  const at = order.indexOf(step);
  return at === -1 ? -1 : at;
}

/**
 * The chain of steps between a gated step and one of its (possibly indirect) prerequisites.
 *
 * Built through the NEAREST CONSUMER — the step that declares the missing one and comes last in run
 * order — rather than through the shortest hop. `translate` declares `character-voice` directly, but
 * the useful refusal is "`translate` needs `consistency-audit`, which needs `character-voice`",
 * because the audit is the step that has to run again once the reference is rebuilt. A chain that
 * names only the missing file tells you what is absent; a chain that names the consumer tells you
 * what to do about it.
 *
 * @param {string} from - The step being gated.
 * @param {string} target - The prerequisite to reach.
 * @param {number} [depth] - Recursion guard. The table is a DAG (a test pins that), so this only
 *   bounds the damage if someone adds a cycle to it.
 * @returns {string[]} The chain, nearest to `from` first, ending at `target`; empty when unreachable.
 */
function prerequisiteChain(from, target, depth = 0) {
  if (from === target || depth > 12) return [];
  const below = new Set(transitivePrerequisites(from).keys());
  const consumers = consumersOf(target)
    .filter((step) => below.has(step) && step !== target)
    .sort((a, b) => runOrderOf(b) - runOrderOf(a));
  for (const step of consumers) {
    const rest = prerequisiteChain(step, target, depth + 1);
    if (rest.length > 0) return [step, ...rest];
  }
  // No consumer below `from` declares it, so the only way to reach it is the direct edge.
  if (prerequisitesFor(from).some((edge) => edge.step === target)) return [target];
  return [];
}

// ─── What "complete" means ────────────────────────────────────────────────────

/**
 * Resolve the `when` predicates' inputs for one gate evaluation.
 *
 * The same four settings the post-mortem resolves (`artifactContext` in utils/postmortem/run.js),
 * read the same way. Kept here rather than reached for because that function is not on the
 * postmortem barrel, and a gate that cannot run is not a gate.
 *
 * @returns {ArtifactContext}
 */
function gateContext() {
  return {
    researchEnabled: process.env.RESEARCH_ENABLED !== "false",
    verifyEnabled: process.env.VERIFY_TRANSLATE_ENABLED !== "false",
    volumeConsistencyEnabled: process.env.VOLUME_CONSISTENCY_ENABLED !== "false",
    polishVerifyEnabled: process.env.POLISH_VERIFY_ENABLED !== "false",
    installment: "",
  };
}

/**
 * The volumes this run is about to process.
 *
 * `--volume NN` narrows the check to that volume, and a single-volume run must not be blocked by an
 * untouched volume 14: the prerequisite that matters is the one for the book being started. A
 * `--volume` that matches nothing is reported as a gap rather than silently narrowing to nothing.
 *
 * @param {string} seriesDir
 * @param {string|null} volumeArg
 * @returns {{volumes: TranslationTargetVolume[], error: string|null}}
 */
function readVolumesInScope(seriesDir, volumeArg) {
  const planFile = path.join(seriesDir, "translation-target.json");
  let plan;
  try {
    plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
  } catch {
    return { volumes: [], error: planFile };
  }
  const volumes = Array.isArray(plan.volumes) ? plan.volumes : [];
  if (!volumeArg) return { volumes, error: null };
  const picked = new Set(filterVolumesByInstallment(plan, volumeArg));
  if (picked.size === 0) {
    return {
      volumes: [],
      error:
        `--volume ${volumeArg} matches none of this series' volumes ` +
        `(${volumes.map((v) => `${v.installmentNumber} = ${v.folder}`).join(", ") || "none listed"})`,
    };
  }
  return { volumes: volumes.filter((v) => picked.has(v.folder)), error: null };
}

/**
 * Whether a quarantine pattern makes a prerequisite incomplete.
 *
 * Only a HIGH quarantine does. `QUARANTINED_CUMULATIVE` (HIGH) means the volume's own gate rejected
 * the artifact and every later volume cascades from it. `QUARANTINED_DRAFT` (MEDIUM) means a draft
 * failed the deterministic QA and was kept ON PURPOSE so `retranslate` has something to repair
 * (gotcha 39) — a volume that went through a repair round and came out fine still carries those
 * files, so treating them as "not complete" would refuse `polish` on a legitimately repaired book.
 * That is gotcha 130's lesson: a gate that halts on a false positive is worse than no gate.
 *
 * @param {import("./artifacts").QuarantineExpectation} quarantine
 * @returns {boolean}
 */
function quarantineBlocksCompletion(quarantine) {
  return quarantine.severity === "HIGH";
}

/**
 * The short, actionable half of a file verdict.
 *
 * `assessFile` returns the post-mortem's full finding, whose message carries the expectation's whole
 * `why` paragraph — right in a report, unreadable in a refusal. The refusal needs the file and what
 * is wrong with it, and nothing else.
 *
 * @param {PostMortemFinding} verdict - The finding `assessFile` produced.
 * @param {import("./artifacts").ArtifactExpectation} expectation
 * @returns {string} A phrase beginning with "has" / "has no", ready to follow "volume 03".
 */
function gapPhrase(verdict, expectation) {
  const name = expectation.name.replace("{installment}", "");
  switch (verdict.kind) {
    case "missing-required":
    case "missing-expected":
      return `has no ${name}`;
    case "empty-or-stub":
      return `has ${name}, which is empty or still holds a scaffold stub`;
    case "bad-json":
      return `has ${name}, which is not parseable JSON`;
    case "wrong-shape":
      return `has ${name}, which is not the ${expectation.shape || "document"} shape this step declares`;
    default:
      return `has ${name}, which this step did not produce as declared (${verdict.kind})`;
  }
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

  // 1. Every `required` expectation, judged by the post-mortem's own one-file verdict.
  const volumeCtx = { ...ctx, installment };
  for (const expectation of spec.volume) {
    if (expectation.level !== "required") continue;
    if (expectation.when && !expectation.when(volumeCtx)) continue;
    const name = expectation.name.replace("{installment}", installment);
    const res = await assessFile(
      path.join(volumeDir, name),
      { ...expectation, name },
      step,
      installment,
      `${volumeEntry.folder}/${name}`
    );
    if (res) gaps.push(`volume ${installment} ${gapPhrase(res, { ...expectation, name })}`);
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

  // 3. A gate that fired and left its evidence in this folder.
  for (const quarantine of spec.quarantines || []) {
    if (!quarantineBlocksCompletion(quarantine)) continue;
    const hit = names.find((name) => quarantine.pattern.test(name));
    if (hit) gaps.push(`volume ${installment} holds ${hit}: ${quarantine.meaning}`);
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

// ─── The verdict ──────────────────────────────────────────────────────────────

/**
 * One incomplete prerequisite, phrased as a refusal a person can act on.
 *
 * @typedef {Object} PrerequisiteGap
 * @property {string} step - The prerequisite that is not complete.
 * @property {string[]} chain - The steps between the gated step and this one, nearest first.
 * @property {string[]} gaps - What is missing, in the words the checks produced.
 * @property {string} line - The rendered bullet.
 */

/**
 * The command that would fix one gap.
 *
 * A narrowed run is told to rebuild that one volume, because that is the cheap move and it is the
 * one the run was already asked to make. A whole-series run is told to re-run the step, which
 * rebuilds the missing volume and cascades the volumes after it.
 *
 * @param {string} step
 * @param {string[]} gaps
 * @param {boolean} narrowed
 * @returns {string}
 */
function fixCommandFor(step, gaps, narrowed) {
  const volumeMatch = gaps.map((g) => /^volume (\S+)/.exec(g)).filter(Boolean).map((m) => m[1]);
  if (volumeMatch.length === 0) return `npx gulp ${step}`;
  if (narrowed) return `npx gulp ${step} --volume ${volumeMatch[0]}`;
  return `npx gulp ${step}`;
}

/**
 * Ask whether every prerequisite of one step is complete, and phrase the answer.
 *
 * Reads the disk only. It writes nothing, makes no model call, and never consults a flag: `--force`,
 * `--allow-fail`, `ON_TASK_ERROR=continue`, the ledger and the resume menu are not inputs to this
 * question, which is the whole point of the gate.
 *
 * @param {Object} opts
 * @param {string} opts.step - The gulp task about to start.
 * @param {string} opts.seriesDir - `SERIES_LOCATION`.
 * @param {string|null} [opts.volumeArg] - The `--volume` filter, when the run is narrowed.
 * @returns {Promise<{
 *   ok: boolean, step: string, narrowed: boolean, gaps: PrerequisiteGap[],
 *   headline: string, bullets: string[], message: string, planMissing: boolean,
 * }>} `headline` + `bullets` are the verdict in the shape a dry run prints; `message` is the same
 *   thing as the one string a refusal throws.
 */
async function evaluatePrerequisites({ step, seriesDir, volumeArg = null }) {
  const edges = prerequisitesFor(step);
  const narrowed = Boolean(volumeArg);
  const empty = { ok: true, step, narrowed, gaps: [], headline: "", bullets: [], message: "", planMissing: false };
  if (edges.length === 0) return empty;

  /**
   * Turn the collected gaps into the headline and bullets a person can act on.
   * @param {PrerequisiteGap[]} found
   * @returns {{headline: string, bullets: string[]}}
   */
  const render = (found) => {
    for (const gap of found) {
      const needs = gap.chain.length > 0
        ? gap.chain.map((s) => `\`${s}\``).join(", which needs ")
        : "it";
      const shown = gap.gaps.slice(0, 2);
      const more = gap.gaps.length > shown.length ? ` (and ${gap.gaps.length - shown.length} more)` : "";
      gap.line =
        `\`${step}\` needs ${needs}; ${shown.join("; ")}${more}. ` +
        `Run \`${fixCommandFor(gap.step, gap.gaps, narrowed)}\` first.`;
    }
    const shown = found.slice(0, 6);
    const hidden = found.length - shown.length;
    const bullets = shown.map((g) => g.line);
    if (hidden > 0) bullets.push(`… ${hidden} more incomplete prerequisite(s); fix these first.`);
    return {
      headline:
        `${step} refuses to start: ${found.length} prerequisite${found.length === 1 ? "" : "s"} ` +
        `${found.length === 1 ? "is" : "are"} not complete. This gate has no override.`,
      bullets,
    };
  };

  /**
   * @param {PrerequisiteGap[]} found
   * @param {boolean} planMissing
   * @returns {Object} A failed verdict with the message composed.
   */
  const failed = (found, planMissing = false) => {
    const rendered = render(found);
    return {
      ok: false,
      step,
      narrowed,
      planMissing,
      gaps: found,
      headline: rendered.headline,
      bullets: rendered.bullets,
      message: `${rendered.headline}\n  - ${rendered.bullets.join("\n  - ")}`,
    };
  };

  if (!seriesDir) {
    return failed([{ step: "discover", chain: ["discover"], gaps: ["SERIES_LOCATION is not set"], line: "" }], true);
  }

  const { volumes, error } = readVolumesInScope(seriesDir, volumeArg);
  if (error) return failed([{ step, chain: [], gaps: [error], line: "" }]);

  const ctx = gateContext();
  const below = [...transitivePrerequisites(step).keys()];
  /** @type {PrerequisiteGap[]} */
  const gaps = [];
  for (const prereq of below) {
    const found = await stepGaps({ step: prereq, seriesDir, volumes, narrowed, ctx });
    if (found.length === 0) continue;
    gaps.push({ step: prereq, chain: prerequisiteChain(step, prereq), gaps: found, line: "" });
  }
  // Name the deepest missing thing first: it is the root cause, and everything above it is a
  // consequence the operator would otherwise have to work out.
  gaps.sort((a, b) => b.chain.length - a.chain.length);
  if (gaps.length === 0) return empty;
  return failed(gaps);
}

/**
 * The refusal this gate throws: a STRUCTURAL error, so `ON_TASK_ERROR=continue` cannot walk past it
 * and `isStructuralError` sees it (gotcha 21).
 *
 * @param {string} message
 * @returns {Error}
 */
function prerequisiteRefusal(message) {
  return structuralError(message);
}

module.exports = {
  STEP_PREREQUISITES,
  declaredPrerequisiteSteps,
  prerequisitesFor,
  transitivePrerequisites,
  consumersOf,
  prerequisiteChain,
  gateContext,
  quarantineBlocksCompletion,
  stepGaps,
  evaluatePrerequisites,
  prerequisiteRefusal,
};
