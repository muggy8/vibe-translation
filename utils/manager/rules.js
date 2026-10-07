/**
 * The closed vocabulary of DECISIONS (run / diagnose / answer / choose / fix / judge / escalate / end) — different from DELIVERY_ACTIONS, which is the vocabulary of pipeline PRIMITIVES — plus ACTION_MENU_ENTRIES mapping each decision to the entry that gives it a command, so a decision the loop cannot carry out is caught by a test instead of discovered by a run. MANAGER_RULES is the standing contract, restated once per call so every decision in a run is made under one contract.
 *
 * Part of the manager.js layer (split out of the original single file).
 */

require("../../types"); // JSDoc type definitions

/**
 * The manager's own reply budget. `DELIVERY_MAX_TOKENS` existed in `.env` with no reader; this is it.
 *
 * There is deliberately no token BUDGET here (no `DELIVERY_TOKEN_BUDGET`) — the ceiling on one
 * decision is the model's own output cap, and what stops a spin is the ledger, not a spending limit
 * (docs/environment.md, "The delivery manager"). A spending limit would hide the spin behind a cost error,
 * and the spin is the thing this layer exists to catch (gotcha 69).
 *
 * @returns {number} - Default 131072, minimum 1024.
 */
function managerMaxTokens() {
  const n = parseInt(process.env.DELIVERY_MAX_TOKENS, 10);
  return Number.isFinite(n) && n >= 1024 ? n : 131072;
}


// ─── The closed decision menu ─────────────────────────────────────────────────
/**
 * The eight moves the manager may name. `DELIVERY_ACTIONS` (in `utils/resume.js`) is the menu of
 * pipeline *primitives*; this is the menu of *decisions*, and the two are different because most of
 * what the manager does is not running the pipeline: it is asking, answering, choosing, judging, and
 * stopping.
 *
 * `needs` is the field contract `parseManagerAction` enforces. `offered` says whether the move must
 * appear in `offerMoves` before it is legal — the ones that do are the ones that name a thing on the
 * menu, and the ones that do not are the ones validated against a record instead (a ticket, a patch).
 *
 * @typedef {Object} ManagerActionSpec
 * @property {string} name
 * @property {string} what - The move, in language the model is being asked to act on.
 * @property {string[]} needs - Required fields beyond `action` and `reason`.
 * @property {boolean} offered - True when the move is only legal if the caller offered it.
 */
const MANAGER_ACTIONS = [
  {
    name: "run",
    what:
      "Run one step through the pipeline's own command. You may name only a step the triage says is " +
      "unfinished, and only in the form it offered.",
    needs: ["step"],
    offered: true,
  },
  {
    name: "diagnose",
    what:
      "Ask the diagnostics team to answer one open ticket. They can open the code, the prompts and the " +
      "run transcripts; you cannot, and that is the point of asking them.",
    needs: ["ticket"],
    offered: false,
  },
  {
    name: "answer",
    what:
      "Reply to one of the diagnostics team's clarifying questions. You may only say what a customer is " +
      "allowed to see: the volume folders, the reports, the plan of record. An answer that cites code, " +
      "a prompt, a transcript or a hook is refused.",
    needs: ["ticket", "answer"],
    offered: false,
  },
  {
    name: "choose",
    what:
      "Pick one of the ALLOWED options on an answered ticket, and say why. An option the filter refused " +
      "is not on the menu, and it is not yours to reach for.",
    needs: ["ticket", "option", "reason"],
    offered: false,
  },
  {
    name: "fix",
    what:
      "Call in the dev team for a chosen option that requires a code change. You describe the need by " +
      "choosing the option; you never describe a fix in prose, and you never write one.",
    needs: ["ticket"],
    offered: false,
  },
  {
    name: "judge",
    what:
      "Accept or reject a patch the dev team proposed, with a reason about what the change does. You " +
      "may not edit it, extend it, apply it yourself, or accept it because the complaint stopped.",
    needs: ["patch", "outcome", "reason"],
    offered: false,
  },
  {
    name: "escalate",
    what:
      "Stop, and name the move that belongs to the account owner. This is not a failure state: a Tier C " +
      "move (un-check a guard, delete evidence, edit a hook or a prompt, rename a volume) is one you may " +
      "name but never make, and saying so is the correct end of a run.",
    needs: ["note"],
    offered: false,
  },
  {
    name: "end",
    what:
      "The run is finished. This is checked against the records before it is accepted: nothing missing, " +
      "no ticket open, no patch unjudged, the deliverable clean. Saying it is not enough.",
    needs: [],
    offered: false,
  },
];


const ACTION_NAMES = new Set(MANAGER_ACTIONS.map((a) => a.name));

const ACTION_BY_NAME = new Map(MANAGER_ACTIONS.map((a) => [a.name, a]));


/**
 * Which entry of the closed pipeline menu (`DELIVERY_ACTIONS`, in `utils/resume.js`) each decision
 * maps to.
 *
 * The two menus are different lists on purpose — one names pipeline *primitives*, the other names
 * *decisions* — but they must not drift apart in the direction that matters: a decision the manager
 * is allowed to make has to have a command behind it, or the menu is a report. `test/test-manager.js`
 * asserts every name here exists on `DELIVERY_ACTIONS` and is available (not Tier C).
 *
 * `end` is the one verb with no entry, and that is not an omission: it runs nothing. It is proved
 * against the records by `endIsProvable`, and a "finish" primitive would be a command that claims a
 * result instead of checking one (gotcha 70).
 *
 * @type {Object<string, string[]>}
 */
const ACTION_MENU_ENTRIES = {
  run: ["resume-here", "re-run-step", "wipe-and-cascade", "re-translate-volume", "re-audit"],
  diagnose: ["open-ticket"],
  answer: ["answer-question"],
  choose: ["choose-option"],
  fix: ["dev-team-patch"],
  judge: ["judge-patch"],
  escalate: ["stop-and-report"],
  end: [],
};

/**
 * The reply shape, as the model is told it. Kept as data so the brief and the parser cannot drift.
 *
 * @typedef {Object} ManagerAction
 * @property {string} action - One of MANAGER_ACTIONS.
 * @property {string} reason - Why this move, now. Required for every action: a decision with no
 *   stated reason is not reviewable afterwards.
 * @property {string} [step] - `run`: the step named on the offered menu.
 * @property {string} [ticket] - `diagnose` / `answer` / `choose` / `fix`: the ticket id.
 * @property {string} [answer] - `answer`: the reply to the team's question.
 * @property {string} [question] - `answer`: WHICH question, quoted from the ticket. Optional when the
 *   ticket has exactly one open question; required when it has more, because `recordAnswer` matches
 *   one exactly and `diagnose.js` refuses to guess.
 * @property {string} [option] - `choose`: the option id (`<ticketId>/O<n>`).
 * @property {string} [patch] - `judge`: the patch id.
 * @property {("accept"|"reject")} [outcome] - `judge`.
 * @property {string} [note] - `escalate`: what the account owner has to decide.
 */

/**
 * One move the caller is offering. Built from the current plan and records by `autopilot.js`
 * (`offerMoves`), so the menu is a fact about the state rather than a guess by the model.
 *
 * @typedef {Object} ManagerMove
 * @property {("run"|"diagnose"|"answer"|"choose"|"fix"|"judge"|"escalate"|"end")} kind
 * @property {string} label - The line the manager reads, e.g. `run glossary (re-run-step, free)`.
 * @property {string} [step] - For `run`.
 * @property {string} [actionName] - The `DELIVERY_ACTIONS` entry this run maps to.
 * @property {string} [ticket] - For the ticket moves.
 * @property {string} [option] - For `choose`.
 * @property {string} [patch] - For `judge`.
 * @property {boolean} [countsAsIntervention] - Copied from the menu entry, so the manager can see
 *   which moves cost it one of its attempts on that step.
 */

// ─── The brief: what the manager is allowed to read ───────────────────────────


/**
 * The standing rules, in the manager's own words. This is the system half of the call: it never
 * changes per iteration, so a run's decisions are all made under one stated contract.
 *
 * Note what is NOT here: no instruction to "be careful", no instruction to "prefer cheap options".
 * Those are the prompt-shaped rules this codebase refuses (gotcha 70) — the menu, the budget, the
 * anti-spin gate and the banned-option filter are what enforce them, and a sentence that asks for
 * them is a sentence nothing checks.
 */
const MANAGER_RULES = `You are the delivery manager for a translation pipeline. You are a CUSTOMER of
this software with a support contract, not an employee of it.

What you may read: the plan of record, what each volume folder actually holds, the deterministic
step assessments, the run ledger, the publish report, the tickets, and the patch proposals written
for you in language you can act on.

What you may never read, and never ask for: the source code, the prompts, the run transcripts under
.logs/, and the per-machine hooks. Three teams exist to look at those for you. Asking for them, or
reasoning about a fix in them, is refused by the machine rather than discouraged by this text.

What you may do: run the pipeline's own command for a step the triage says is unfinished; re-run a
step; wipe a step's declared outputs and let the cascade rebuild the tail; open a ticket; answer a
question the diagnostics team asked you; choose among the options the filter allowed; call in the dev
team for an option that needs a code change; accept or reject a patch; stop and name a decision that
belongs to the account owner.

What you may never do: edit or apply a code change (accept or reject only); delete anything; turn off
a guard, a threshold, a run policy or the ledger; use --allow-fail or --allow-no-glossary; lower
PASSING_SCORE; remove a report or a .rejected file; touch hooks/ or .env; rename a volume folder;
touch the staged books or the "old (do not touch)" folder; run the intake agent. If one of those is
genuinely the right answer, the diagnostics team says so in prose to the account owner (ownerNote),
and your move is "escalate".

Two things about your own limits:
- Picking up unfinished work is free. Destroying finished work is an intervention, and each step has
  a limited number of them. When a step is out of attempts, the honest move is a ticket, not a
  cleverer re-run.
- The same action against the same finding that has already failed twice will be refused. And when a
  deterministic gate removed an output, re-running that step rebuilds the file and the same check
  refuses it again: the finding is about the check, not about the data, so the move is the ticket.
  Whether anything has actually been attempted is written in the state below, where the run ledger
  records it — count it there, and do not assume an attempt that is not written down.

Answer with ONE fenced \`\`\`json block and nothing after it.`;


/**
 * Files a patch may not touch even though the banned-path table lets them through — each one is a
 * thing that judges the patch rather than a thing the pipeline does.
 */
const NOT_ORDINARY_CODE = [
  {
    id: "test-chain",
    pattern: /(^|[\\/])package\.json$/,
    because:
      "package.json holds the pinned check chain. A patch that narrows `npm test` narrows the evidence " +
      "its own acceptance is judged on (the case `testChainIsIntact` exists to catch).",
  },
  {
    id: "test-suite",
    pattern: /(^|[\\/])test([\\/]|$)/,
    because:
      "a test is the evidence the pinned checks produce. A patch that edits the test it is graded by is " +
      "not an ordinary code change, whatever the banned-path table says about the specific file.",
  },
  {
    id: "thresholds",
    pattern: /(^|[\\/])configs([\\/])shared\.js$/,
    because:
      "configs/shared.js holds PASSING_SCORE and the acceptance criteria every scored gate uses. Those " +
      "are the account owner's knobs, not a fix.",
  },
  {
    id: "sandbox",
    pattern: /(^|[\\/])harness\.js$/,
    because:
      "harness.js is the sandbox and the AI layer: the file-tool gate, the read caps, the truncation " +
      "guards, the call deadline. A patch that widens it is a patch that widened what it may do.",
  },
  {
    id: "runner",
    pattern: /(^|[\\/])(index|gulpfile)\.js$/,
    because:
      "index.js and gulpfile.js are the process-per-step boundary that makes a patch take effect at all " +
      "(gotcha 66). Changing them changes what " +
      "\"the fix is now the code the next step runs\" means.",
  },
  {
    id: "prompt-files",
    pattern: /(^|[\\/])(system|user)-prompts([\\/]|$)/,
    because:
      "the prompts are what the pipeline asks. A patch that changes one changes the work being judged, " +
      "and the prompt audit is not a substitute for the account owner reading it.",
  },
  {
    id: "agent-map",
    pattern: /(^|[\\/])AGENTS\.md$/,
    because:
      "AGENTS.md is the map every later agent works from. Rewriting the map is not a bug fix.",
  },
];


module.exports = {
  managerMaxTokens,
  MANAGER_ACTIONS,
  ACTION_NAMES,
  ACTION_BY_NAME,
  ACTION_MENU_ENTRIES,
  MANAGER_RULES,
  NOT_ORDINARY_CODE,
};
