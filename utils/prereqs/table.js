/**
 * utils/prereqs/table.js — the declared order, and the questions asked of it.
 *
 * `STEP_PREREQUISITES` is the constraint table: every gulp step, and for each edge the step it needs
 * and the one-line `because` written for the person being refused. Nothing here reads the disk or
 * decides whether anything is finished — that is `completion.js`. This file answers questions about
 * the TABLE alone: what a step declares, what is reachable below it, which steps consume a step, and
 * the chain a refusal is built through (the NEAREST consumer, not the shortest hop).
 *
 * The table is `Object.freeze`d and stays inside `utils/prereqs/`, which `utils/patches/rules.js`'s
 * `constraint-tables` pattern bans as a patch path — the pattern matches the folder as well as
 * `utils/prereqs.js`, so splitting the file moves no table out of the ban (AGENTS.md §3). A table an
 * importing module can reassign is a dial (AGENTS.md §4 rule 3).
 *
 * @module utils/prereqs/table
 */

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

module.exports = {
  STEP_PREREQUISITES,
  declaredPrerequisiteSteps,
  prerequisitesFor,
  transitivePrerequisites,
  consumersOf,
  prerequisiteChain,
};
