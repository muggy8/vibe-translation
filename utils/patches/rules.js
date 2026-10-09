/**
 * The tables themselves — the constraints on the role, written as data: the patch statuses, the checks the machine pins, the banned diff, the project-source whitelist, the scripted-model answer keys, and the proposal contract. None of it is a knob, because a constraint the role can switch off is not a constraint (gotcha 70).
 *
 * Part of the patches.js layer (split out of the original single file).
 */

const path = require("path");
const { DELIVERABLE_SIGNALS } = require("../delivery-verify");
const utilsDir = path.resolve(__dirname, "..");

const ROOT = path.join(utilsDir, "..");

// ─── Statuses ─────────────────────────────────────────────────────────────────


/**
 * The life of a patch. Deliberately short: every status is a question somebody still owes an answer.
 *
 * `proposed`  — the team wrote it. Uncommitted, unjudged, live in the working tree.
 * `verified`  — the pinned checks ran against it and passed. Still unjudged.
 * `accepted`  — the manager said yes. Not yet committed: the commit is the dev team's act.
 * `rejected`  — the manager said no. The working tree must be put back.
 * `committed` — the change is in `main`. The ticket closes on the deliverable, not here.
 *
 * @type {string[]}
 */
const PATCH_STATUSES = ["proposed", "verified", "accepted", "rejected", "committed"];


/** Statuses where the change is in the working tree and nobody has said whether it stays. */
const UNJUDGED_STATUSES = ["proposed", "verified"];

// ─── The checks ───────────────────────────────────────────────────────────────


/**
 * The commands a patch must pass. Run by this module, not reported by the team.
 *
 * `npm test` already ends with the whole offline pipeline, so the second entry looks redundant. It is
 * not: `npm test` is a **list**, and a list is the thing a patch could shorten. Running the pipeline
 * loop by name is the half of the gate that does not depend on the list still being complete — and
 * `package.json`'s test chain is checked separately (`testChainIsIntact`) so a patch cannot quietly
 * drop a test from it.
 *
 * @type {Array<{id: string, command: string, args: string[], why: string}>}
 */
const REQUIRED_CHECKS = [
  {
    id: "npm-test",
    command: "npm",
    args: ["test"],
    why:
      "every offline suite, including the whole pipeline run against the scripted model. The real " +
      "harness, the real agent loop and the real file tools are in this gate, not a mock of them.",
  },
  {
    id: "pipeline-loop",
    command: "npm",
    args: ["run", "pipeline-loop"],
    why:
      "the ten tasks in gulp order on a fixture series, then a second pass that must make zero model " +
      "calls. Named explicitly because `npm test` is a list, and a patch that edits the list is the " +
      "exact move this gate exists to refuse.",
  },
];


/**
 * How long one pinned check may run before it is killed and reported as failed.
 *
 * A code constant rather than a knob, for the same reason the check list is one: a timeout the role
 * under test can raise is not a timeout. `npm run pipeline-loop` is a whole pipeline against a scripted
 * model and legitimately takes minutes; 30 minutes is far above that and far below "forever", which is
 * the state where an un-monitored run stops being un-monitored.
 */
const CHECK_TIMEOUT_MS = 30 * 60 * 1000;

// ─── The banned diff ──────────────────────────────────────────────────────────


/**
 * The files a patch may not touch.
 *
 * The reason this list exists in code: the dev team is the first role in this pipeline that can change
 * the code that decides what is allowed. `utils/tickets.js` refuses banned *options*; this refuses
 * banned *edits*, because the cheapest way to make a finding disappear is now a line of code rather
 * than a setting. Every entry names the escalation, same as `BANNED_OPTIONS` does: if the team genuinely
 * believes one of these is the right answer, it says so in `ownerNote`, in prose, to the account owner —
 * the only role that may un-check a guard.
 *
 * @type {Array<{id: string, pattern: RegExp|null, catchAll?: boolean, because: string, escalateTo: string}>}
 */
const BANNED_PATCH_PATHS = [
  {
    id: "constraint-tables",
    // The table AND every module it was split into. `utils/tickets.js` is the public face
    // of a layer whose rules now live in `utils/tickets/`, so a pattern that ends in `.js`
    // protects the cover of the book and not the book — and the cover is the file a
    // well-meaning reader would never edit anyway.
    pattern: /^utils\/(?:tickets|resume|delivery-verify|ledger|runlock|patches)(?:\.js|\/)/,
    because:
      "these are the rules that constrain the manager, the diagnostics team and this team: the " +
      "banned-option filter, the closed action menu, the deliverable signal table, the anti-spin " +
      "ledger, the run lock, and the patch channel itself. A role that can edit the rules that judge " +
      "it is not being judged.",
    escalateTo:
      "the account owner. If one of these tables is genuinely wrong, say so in ownerNote with the " +
      "evidence — the tables' reasons are written down, so the argument has somewhere to land.",
  },
  {
    id: "constraint-tests",
    pattern: /^test\/test-(?:tickets|resume|delivery-verify|ledger|delivery-act|diagnostics|patches)\.js$/,
    because:
      "these are the tests that pin the constraints above. Editing the test that proves a guard works " +
      "is how a guard becomes decoration while the suite stays green (gotcha 67: a check that can " +
      "never fail is not a check).",
    escalateTo: "the account owner, who is the only role that may relax one of these guarantees.",
  },
  {
    id: "edit-hooks",
    pattern: /^hooks\//,
    because:
      "hooks/ is per-machine configuration that decides which model grades the work (gotcha 22). It is " +
      "not tracked source, and a patch that changes it changes the answer key rather than the answer.",
    escalateTo: "the account owner, who owns this machine's hooks.",
  },
  {
    id: "edit-env",
    pattern: /^\.env(?:\.example)?$/,
    because:
      ".env is the account owner's configuration. A patch that changes a threshold, a guard, or an " +
      "endpoint is not a bug fix, it is a policy change wearing a patch.",
    escalateTo: "the account owner. `.env.example` documents defaults; it is not where a default moves.",
  },
  {
    id: "edit-machine-state",
    pattern: /(?:^|\/)(?:\.run|\.postmortem|\.logs|\.dry-run|node_modules)\//,
    because:
      "these are the run's own records and generated state — the reports, the ledger, the " +
      "tickets, the patch channel, the transcripts and the prompt dumps, wherever the run keeps " +
      "them (they now sit next to the series, in <SERIES_LOCATION>/.run/). They are the " +
      "before-side of every acceptance comparison: editing them edits the evidence a decision " +
      "was made from (Tier C: delete-evidence).",
    escalateTo: "the account owner. Nothing downstream of a run is a patch target.",
  },
  {
    id: "edit-corpus",
    pattern: null,
    catchAll: true,
    because:
      "the volumes, the staged books and everything the pipeline produced from them are the " +
      "deliverable. The dev team fixes the machine that reads them; it does not edit the book, and it " +
      "does not delete a quarantined artifact to make a finding go away.",
    escalateTo: "the account owner, who is the only role that touches the corpus.",
  },
  {
    id: "path-outside-project",
    pattern: null,
    catchAll: true,
    because:
      "this path cannot be expressed as a file inside ai-client/, so it is outside the project the dev " +
      "team is allowed to change. Declare project-relative paths (`glossary.js`, `utils/prompt.js`).",
    escalateTo: "the account owner, if the fix really belongs somewhere other than ai-client/.",
  },
];


/** The folders that are the project's own source. Everything else under `ai-client/` is generated. */
const PROJECT_SOURCE_DIRS = [
  "test/",
  "utils/",
  "configs/",
  "system-prompts/",
  "user-prompts/",
];


/**
 * Files that carry the pipeline's expected answers. Not banned — a prompt change legitimately has to
 * update the scripted model that answers those prompts — but a patch touching them is reported loudly,
 * because the same edit can also make a test pass by changing what the test expects.
 *
 * @type {Array<{pattern: RegExp, because: string}>}
 */
const ANSWER_KEY_FILES = [
  {
    pattern: /^test\/(?:fake-workflow|prompt-audit)\.js$/,
    because:
      "this file carries the scripted answers and the rules that read them. A change here can make a " +
      "failing suite pass without changing any behaviour, so it must be named in couldBreak.",
  },
  {
    pattern: /^test\/calibration\//,
    because:
      "these are the known-defect pairs the grader is measured against. Editing them moves the answer " +
      "key, and must be named in couldBreak.",
  },
];


/**
 * What a dev-team proposal must say. Fail-closed on the required half, like `parseAcceptanceReply`
 * and `validateDiagnosisShape` (gotcha 7): a proposal that cannot be read is not a thin proposal, it
 * is a failed check.
 *
 * @type {Array<{field: string, required: boolean, why: string}>}
 */
const PROPOSAL_CONTRACT = [
  {
    field: "summary",
    required: true,
    why:
      "what changed, in language the manager can repeat. The manager cannot read the diff, so this is " +
      "the only description of the change that reaches the person who decides.",
  },
  {
    field: "why",
    required: true,
    why:
      "the mechanism the patch fixes, not the finding it removes. A proposal that says only what is " +
      "different cannot be told apart from one that removed a check.",
  },
  {
    field: "files",
    required: true,
    why:
      "every file the patch touched. Cross-checked against the working tree: a file that changed " +
      "without being named is an unreviewed edit, and it is refused.",
  },
  {
    field: "couldBreak",
    required: true,
    why:
      "what this change could damage. A provider that cannot say what it might break is asking the " +
      "customer to trust it, and this pipeline has already paid for that kind of trust (gotcha 65).",
  },
  {
    field: "expected",
    required: true,
    why:
      "what the patch expects to move in the DELIVERABLE, named in the units the acceptance test " +
      "measures (DELIVERABLE_SIGNALS). Naming a signal that does not exist is refused: the team may " +
      "not invent its own scoreboard (gotcha 73).",
  },
  {
    field: "verify",
    required: true,
    why:
      "how the manager checks it worked afterwards — a folder listing, a term count, a report, the " +
      "published text. Something a reader with no code access can actually look at.",
  },
  { field: "questions", required: false, why: "what the team needs from the manager before it commits." },
  {
    field: "ownerNote",
    required: false,
    why:
      "if the right answer is something the manager may not be offered — un-checking a guard, editing " +
      "a constraint table, touching the corpus — say it here, in prose, for the account owner.",
  },
];


/** The signal names a proposal may name. Anything else is an invented scoreboard. */
const SIGNAL_NAMES = DELIVERABLE_SIGNALS.map((s) => s.name);


/** The directions a signal can move, same words the signal table uses. */
const SIGNAL_DIRECTIONS = ["up", "down"];

/**
 * "The finding disappears" as the only stated check. Flagged, not refused — the same deliberate split
 * as `filterOptions` in utils/tickets.js: the thing that rejects it is the before/after comparison of
 * the deliverable, not this module (gotcha 70/73).
 *
 * The table itself is NOT here. It lives in utils/tickets.js and is imported, because the same shape
 * arrives from three directions — an option's `verify`, a patch's `verify`, and the manager's
 * accept/reject reason — and two copies of a phrase list drift until one of them stops catching things.
 * (This module had its own copy for exactly one session, and the copy was what let "volume 15 passes
 * now" through as a reason to accept a patch.)
 */


module.exports = {
  ROOT,
  PATCH_STATUSES,
  UNJUDGED_STATUSES,
  REQUIRED_CHECKS,
  CHECK_TIMEOUT_MS,
  BANNED_PATCH_PATHS,
  PROJECT_SOURCE_DIRS,
  ANSWER_KEY_FILES,
  PROPOSAL_CONTRACT,
  SIGNAL_NAMES,
  SIGNAL_DIRECTIONS,
};
