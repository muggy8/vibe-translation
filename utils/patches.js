/**
 * utils/patches.js — the patch channel: the only way a code change reaches this pipeline.
 *
 * The delivery manager (delivery.js, utils/resume.js) reads reports and deliverables and never reads
 * code. The diagnostics team (utils/diagnostics.js) reads the code and may not change it. This module
 * is the third role's channel: the **dev team**, the one role that may change a file — and the only
 * way it reaches the pipeline is through a record the manager can judge without reading the code.
 *
 * The analogy the account owner chose (plan §2): the manager is a customer on a support contract, and
 * the diagnostics and dev teams are the provider. A provider does not hand the customer a diff and ask
 * which lines to keep. It says what it changed, why, what it could break, and what it expects to move —
 * and the customer accepts or rejects that.
 *
 * Four rules make that safe, and each one is enforced here rather than written in a prompt:
 *
 *   1. **A patch is opened by a ticket, never by a request.** `createPatch` is the only door. It
 *      refuses unless the ticket is `chosen` and the chosen option says it needs a code change. The
 *      manager summons the dev team the same way it summons the diagnostics team: by picking an item
 *      off the list it was offered. It cannot write an instruction about code, because it has none.
 *   2. **A patch may not weaken the thing that judges it.** `BANNED_PATCH_PATHS` refuses edits to the
 *      constraint tables (the banned-option filter, the action menu, the deliverable signal table, the
 *      anti-spin ledger, the run lock, this module) and to the machine's own configuration (`hooks/`,
 *      `.env`, `.postmortem/`, `.logs/`) and to anything outside `ai-client/`. This is gotcha 70's rule
 *      at the file level: a filter the constrained role can edit is not a filter.
 *   3. **A patch shows its changes, the way a diagnosis shows its reading.** The working tree is
 *      fingerprinted before the dev turn and again after it. A file that changed without being declared
 *      is a **refusal** — an unreviewed edit is worse than an unreviewed citation, because it lands. A
 *      declared file that did not actually change is a warning, not a lie worth stopping a run over.
 *   4. **Tests are RUN, not claimed.** `REQUIRED_CHECKS` is a constant list of commands this module
 *      executes. A proposal cannot be accepted while a check is missing or failed, and the list is on
 *      the banned-to-edit list, so the team cannot shorten the gate it has to pass.
 *
 * What the manager may NOT do is apply anything. `acceptPatch` records a decision and runs nothing: a
 * code change takes effect through act mode's wipe-and-cascade (gotcha 66), because a running Node
 * process cannot pick up a changed module, and the skip-checks do not know the code changed. The
 * commit to `main` is the acceptance act, and only the dev team's CLI makes it (`fix.js --commit`).
 *
 * Where the patch lives: the working tree of `main`, uncommitted, while the manager judges it. That is
 * the dangerous part of this design and it is worth saying out loud — the working tree IS what
 * `npm run pipeline` executes, so an unjudged patch is live code the moment it is written. Two things
 * hold it: the run lock (a patch may not be written while a run is in progress, gotcha 66), and
 * `pendingPatches()`, which act mode refuses to run past. A rejected patch is reverted, not left there.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const { postMortemDir } = require("./postmortem");
const { readTickets, ticketPaths, OUTCOME_ONLY_CHECK, verificationIsOutcomeOnly } = require("./tickets");
const { DELIVERABLE_SIGNALS } = require("./delivery-verify");

const ROOT = path.join(__dirname, "..");

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
    pattern: /^utils\/(?:tickets|resume|delivery-verify|ledger|runlock|patches)\.js$/,
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
    pattern: /^(?:\.postmortem|\.logs|\.dry-run|node_modules)\//,
    because:
      "these are the run's own records and generated state. The ledger, the tickets, the post-mortem " +
      "reports and the transcripts are the before-side of every acceptance comparison — editing them " +
      "edits the evidence a decision was made from (Tier C: delete-evidence).",
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
 * Look a banned rule up by id, so a refusal can name the rule it is applying even when the rule is a
 * catch-all rather than a pattern match.
 *
 * @param {string} id
 * @returns {Object|null}
 */
function ruleById(id) {
  return BANNED_PATCH_PATHS.find((rule) => rule.id === id) || null;
}

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
 * The `npm test` chain may only grow. A patch that removes a test file from it is refused by name.
 *
 * @param {string} before - The `npm test` script as it was.
 * @param {string} after - The `npm test` script as the patch left it.
 * @returns {{ok: boolean, removed: string[], added: string[]}}
 */
function testChainIsIntact(before, after) {
  const filesOf = (script) =>
    String(script || "")
      .split("&&")
      .map((part) => {
        const m = part.match(/node\s+([^\s]+\.js)/);
        return m ? m[1].replace(/\\/g, "/") : null;
      })
      .filter(Boolean);
  const was = filesOf(before);
  const now = filesOf(after);
  const removed = was.filter((f) => !now.includes(f));
  const added = now.filter((f) => !was.includes(f));
  return { ok: removed.length === 0, removed, added };
}

/**
 * Which banned rule a file hits, if any.
 *
 * @param {string} filePath - Project-relative path (`glossary.js`, `utils/tickets.js`), or an absolute
 *   path that lies under `root`.
 * @param {string} [root] - The folder project-relative means relative to. The dev turn's tool gate
 *   passes its own cwd; everything else uses this project's root.
 * @returns {{banned: boolean, rule: Object|null}}
 */
function patchPathIsBanned(filePath, root = ROOT) {
  const rel = normalizeProjectPath(filePath, root);
  if (!rel) return { banned: true, rule: ruleById("path-outside-project") };

  // The named rules FIRST, each with its own reason, so a refusal can say which rule it hit. A refusal
  // that says "not allowed" without naming the rule is the refusal a reader routes around.
  for (const rule of BANNED_PATCH_PATHS) {
    if (rule.catchAll || !rule.pattern) continue;
    if (rule.pattern.test(rel)) return { banned: true, rule };
  }

  // Everything left that is not project source is the corpus (a staged book, a volume's artifacts, a
  // fixture series) — the deliverable, and not a patch target.
  if (!isProjectSourcePath(rel)) return { banned: true, rule: ruleById("edit-corpus") };
  if (corpusIsNamedArtifact(rel)) return { banned: true, rule: ruleById("edit-corpus") };

  return { banned: false, rule: null };
}

/**
 * Which folders and root files are the project's own source, as opposed to what the pipeline produced.
 *
 * Written as a whitelist rather than a blacklist on purpose: `ai-client/` also holds generated output
 * (`test-series/`, `.postmortem/`, `.logs/`), and a patch channel whose default is "allowed unless
 * listed" would default to editing the run's own evidence.
 *
 * @param {string} rel - A normalized, project-relative path.
 * @returns {boolean}
 */
function isProjectSourcePath(rel) {
  if (PROJECT_SOURCE_DIRS.some((dir) => rel.startsWith(dir))) return true;
  // Root-level modules and the two documents that describe them. A folder name is not a file: a path
  // with a slash in it is either a source folder above or something the pipeline generated.
  return /^[^/]+\.(?:js|md|json)$/.test(rel);
}

/**
 * A generated artifact of the pipeline, wherever it sits (`test-series/…`, a fixture series folder).
 * Those are output, and output is not a patch target.
 *
 * Deliberately NOT applied to the prompt files: `system-prompts/glossary.md` is source that a patch may
 * legitimately change, and it shares a name with the artifact the glossary task writes.
 *
 * @param {string} rel
 * @returns {boolean}
 */
function corpusIsNamedArtifact(rel) {
  return (
    rel.startsWith("test-series/") ||
    rel.includes("/test_story") ||
    rel.endsWith(".rejected") ||
    rel.endsWith(".rejected.md") ||
    rel.endsWith(".rejected-passage.md") ||
    rel.endsWith(".provenance.json") ||
    rel.endsWith("-rolling-state.json") ||
    rel.endsWith("-bundle.meta.json")
  );
}

/**
 * Every file a patch touches, checked against the banned list.
 *
 * @param {string[]} files
 * @returns {Array<{file: string, because: string, escalateTo: string, rule: string}>}
 */
function patchTouchesBanned(files) {
  const out = [];
  for (const f of files || []) {
    const verdict = patchPathIsBanned(f);
    if (verdict.banned && verdict.rule) {
      out.push({
        file: normalizeProjectPath(f),
        rule: verdict.rule.id,
        because: verdict.rule.because,
        escalateTo: verdict.rule.escalateTo,
      });
    }
  }
  return out;
}

/**
 * Files whose edit has to be declared loudly, because the same edit can weaken the check instead of
 * the thing being checked.
 *
 * @param {string[]} files
 * @returns {Array<{file: string, because: string}>}
 */
function patchTouchesAnswerKey(files) {
  const out = [];
  for (const f of files || []) {
    const rel = normalizeProjectPath(f);
    for (const key of ANSWER_KEY_FILES) {
      if (key.pattern.test(rel)) out.push({ file: rel, because: key.because });
    }
  }
  return out;
}

// ─── The proposal contract ────────────────────────────────────────────────────

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

/**
 * A judgment reason that states the result instead of the judgment.
 *
 * The manager's accept/reject reason is the half an account owner reads afterwards. "I accepted it
 * because volume 15 passes now" is the same demand `validateTicketShape` refuses on the manager's
 * question, arriving from the other end of the conversation (gotcha 70).
 *
 * The escape hatch is honest about what it is: a reason that names the outcome AND names a quantity of
 * the deliverable is allowed, because "the finding disappears, but the glossary keeps all 460 rows" is
 * a real judgment a human wants written down. This is a shape check, not a mind reader — the same
 * disclaimer `validateTicketShape` carries, and for the same reason: the before/after comparison of the
 * deliverable is what catches a demand phrased cleverly.
 *
 * @param {string} reason
 * @returns {{ok: boolean, matched: string|null}}
 */
function judgmentReasonIsSound(reason) {
  const text = String(reason || "").trim();
  if (!text) return { ok: false, matched: null };
  const outcomeOnly = OUTCOME_ONLY_CHECK.find((re) => re.test(text));
  if (outcomeOnly && !/\b(?:glossary|term|chapter|voice|style|wiki|deliverable|signal)\b/i.test(text)) {
    return {
      ok: false,
      matched: outcomeOnly.source,
    };
  }
  return { ok: true, matched: null };
}

/**
 * Validate a proposal against the contract.
 *
 * @param {Object} proposal
 * @returns {{problems: Object[], warnings: Object[], proposal: Object}}
 *   `problems` refuse the patch; `warnings` travel with it into `patches.md`.
 */
function validateProposalShape(proposal) {
  const problems = [];
  const warnings = [];
  const p = proposal && typeof proposal === "object" ? proposal : {};

  for (const field of PROPOSAL_CONTRACT) {
    const value = p[field.field];
    const empty =
      value === undefined ||
      value === null ||
      (typeof value === "string" && !value.trim()) ||
      (Array.isArray(value) && value.length === 0);
    if (field.required && empty) {
      problems.push({ kind: "missing-field", field: field.field, message: `${field.field} is required: ${field.why}` });
    }
  }

  if (p.summary && String(p.summary).trim().length < 60) {
    warnings.push({
      kind: "thin-summary",
      message:
        `the summary is ${String(p.summary).trim().length} characters. The manager cannot read the ` +
        `diff, so a one-line summary is the whole evidence it has to decide on.`,
    });
  }

  if (Array.isArray(p.files)) {
    const bad = p.files.filter((f) => !normalizeProjectPath(f));
    if (bad.length) problems.push({ kind: "unusable-path", message: `unusable file path(s): ${bad.join(", ")}` });
    const banned = patchTouchesBanned(p.files);
    for (const b of banned) {
      problems.push({
        kind: "banned-path",
        file: b.file,
        rule: b.rule,
        message: `${b.file} may not be edited by a patch: ${b.because} It goes to ${b.escalateTo}`,
      });
    }
    for (const k of patchTouchesAnswerKey(p.files)) {
      warnings.push({
        kind: "answer-key-touched",
        file: k.file,
        message: `${k.file} carries the pipeline's expected answers: ${k.because}`,
      });
    }
  }

  if (Array.isArray(p.expected)) {
    for (const e of p.expected) {
      if (!e || typeof e !== "object") {
        problems.push({ kind: "bad-expected", message: "every expected entry is {signal, direction, why}." });
        continue;
      }
      if (!SIGNAL_NAMES.includes(e.signal)) {
        problems.push({
          kind: "unknown-signal",
          signal: String(e.signal),
          message:
            `"${e.signal}" is not a signal the acceptance test measures. Name one of: ` +
            `${SIGNAL_NAMES.join(", ")}. A fix argued in units nobody measures cannot be checked.`,
        });
      } else if (!SIGNAL_DIRECTIONS.includes(e.direction)) {
        problems.push({
          kind: "bad-direction",
          signal: e.signal,
          message: `expected "${e.signal}" must say "up" or "down" — the same words the signal table uses.`,
        });
      } else if (!String(e.why || "").trim()) {
        problems.push({ kind: "expected-without-why", signal: e.signal, message: `why should "${e.signal}" move?` });
      }
    }
  }

  if (p.verify && verificationIsOutcomeOnly(p.verify)) {
    warnings.push({
      kind: "outcome-only-verification",
      message:
        `the only stated check is that the finding disappears ("${p.verify}"). That is available for ` +
        `free by switching a check off, so it is not evidence. The before/after comparison of the ` +
        `deliverable (utils/delivery-verify.js) is what will judge this patch.`,
    });
  }

  return { problems, warnings, proposal: p };
}

// ─── The record ───────────────────────────────────────────────────────────────

/**
 * @typedef {Object} PatchExpected
 * @property {string} signal - A name from DELIVERABLE_SIGNALS.
 * @property {("up"|"down")} direction - Which way it should move.
 * @property {string} why - The mechanism that moves it.
 */

/**
 * @typedef {Object} PatchCheck
 * @property {string} id - One of REQUIRED_CHECKS.
 * @property {string} command - The command as run.
 * @property {number|null} exitCode - What it actually returned. Null when it never ran.
 * @property {boolean} passed
 * @property {string} [tail] - The last lines of its output, so a failure is readable.
 * @property {string} at
 */

/**
 * @typedef {Object} Patch
 * @property {string} id - `PATCH-<n>`.
 * @property {string} ticketId - The ticket this patch answers. The only door a patch has.
 * @property {string} optionId - The option the manager chose that required a code change.
 * @property {string} step - Copied from the ticket, so a patch is attributable to a step.
 * @property {string|null} volume
 * @property {string} finding
 * @property {("proposed"|"verified"|"accepted"|"rejected"|"committed")} status
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string[]} files - Declared by the team, cross-checked against the working tree.
 * @property {string} [summary]
 * @property {string} [why]
 * @property {string} [couldBreak]
 * @property {PatchExpected[]} [expected]
 * @property {string} [verify]
 * @property {string[]} [questions]
 * @property {string} [ownerNote]
 * @property {Array<{tool: string, path: string, reason: string}>} [refusedWrites] - Writes the gate stopped.
 * @property {Array<{file: string, because: string, escalateTo: string}>} [refusedPaths]
 * @property {Array<{kind: string, message: string}>} [warnings]
 * @property {Array<{at: string, files: string[], problems: Object[], warnings: Object[]}>} [refusedAttempts]
 *   Proposals that were refused before the one now attached. Kept, never silently replaced.
 * @property {PatchCheck[]} [checks]
 * @property {{accepted: boolean, missing: string[], failed: string[]}} [checkVerdict]
 * @property {{outcome: string, reason: string, decidedBy: string, at: string}} [decision]
 * @property {{hash: string, at: string, files: string[]}} [commit]
 * @property {Object} [reverted]
 * @property {Object} [usage] - The dev turn's token usage, recorded like the diagnosis's.
 * @property {{chunks: number, toolCalls: number, offloads: number, offloadedTokens: number,
 *   compactions: number, endedAs: string|null}} [turnShape] - How the dev turn actually ran: how
 *   many tool calls it made, how many pieces it needed, how much of its reading it had to set aside
 *   on disk, and how it ended. Replaces the step cap this role no longer has.
 */

/**
 * @returns {{json: string, markdown: string}} Where patches live: beside the tickets and the ledger.
 */
function patchPaths() {
  const dir = postMortemDir();
  return { json: path.join(dir, "patches.json"), markdown: path.join(dir, "patches.md") };
}

/**
 * Read the patch file. A corrupt record is reported, never reported as "no patches" — the same rule
 * as `readTickets` and `readUsableManifest` (gotcha 33/69): an empty-looking history is how a decision
 * disappears.
 *
 * @param {string} [filePath]
 * @returns {{patches: Patch[], error: string|null}}
 */
function readPatches(filePath = patchPaths().json) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { patches: [], error: null };
    return { patches: [], error: `cannot read ${filePath}: ${err.message}` };
  }
  if (!raw.trim()) return { patches: [], error: null };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { patches: [], error: `${filePath} does not parse (${err.message}). It is not being treated as empty.` };
  }
  if (!parsed || !Array.isArray(parsed.patches)) {
    return { patches: [], error: `${filePath} has no "patches" array. It is not being treated as empty.` };
  }
  return { patches: parsed.patches, error: null };
}

/**
 * Write the patch file, and the human-readable half beside it.
 *
 * @param {Patch[]} patches
 * @param {{json: string, markdown: string}} [paths]
 * @returns {{written: boolean, error: string|null}}
 */
function writePatches(patches, paths = patchPaths()) {
  try {
    fs.mkdirSync(path.dirname(paths.json), { recursive: true });
    fs.writeFileSync(paths.json, JSON.stringify({ patches, writtenAt: new Date().toISOString() }, null, 2) + "\n", "utf8");
    fs.writeFileSync(paths.markdown, renderPatchesMarkdown(patches), "utf8");
    return { written: true, error: null };
  } catch (err) {
    return { written: false, error: `cannot write ${paths.json}: ${err.message}` };
  }
}

/**
 * @param {string} id
 * @param {Patch[]} [patches]
 * @returns {Patch|null}
 */
function findPatch(id, patches = readPatches().patches) {
  return (patches || []).find((p) => p.id === id) || null;
}

/**
 * Patches whose change is sitting in the working tree with nobody having said whether it stays.
 *
 * This is the guard act mode runs against: the working tree of `main` is what `npm run pipeline`
 * executes, so running a step while a patch is unjudged runs code the manager has not accepted.
 *
 * @param {{json: string, markdown: string}} [paths] - A patch file other than the live one (a test fixture).
 * @returns {Patch[]}
 */
function pendingPatches(paths = patchPaths()) {
  return readPatches(paths.json).patches.filter((p) => UNJUDGED_STATUSES.includes(p.status));
}

/**
 * Patches whose code is still in the working tree with nobody having accepted it.
 *
 * Wider than `pendingPatches`, and the difference is the point: a REJECTED patch is judged, but its
 * edits are still sitting in the tree until somebody reverts them. Running a step while that is true
 * runs code the manager said no to. So the list act mode refuses against is "unjudged, or refused and
 * not yet put back".
 *
 * @param {{json: string, markdown: string}} [paths]
 * @returns {Patch[]}
 */
function unresolvedPatches(paths = patchPaths()) {
  return readPatches(paths.json).patches.filter((p) => UNJUDGED_STATUSES.includes(p.status) || (p.status === "rejected" && !p.reverted));
}

/**
 * @param {string} ticketId
 * @param {{json: string, markdown: string}} [paths]
 * @returns {Patch|null}
 */
function patchForTicket(ticketId, paths = patchPaths()) {
  return readPatches(paths.json).patches.find((p) => p.ticketId === ticketId) || null;
}

// ─── The door ─────────────────────────────────────────────────────────────────

/**
 * Open a patch for a ticket. The only way a code change gets requested in this pipeline.
 *
 * The manager does not describe a fix. It chose an option the diagnostics team offered, and that
 * option said it needs a code change; this reads that choice and nothing else. A ticket with
 * `noUsableOptions` is refused on purpose: every option was refused because the decision belongs to
 * the account owner, and a dev team summoned onto that ticket would be doing the account owner's
 * job for them (gotcha 70).
 *
 * @param {Object} input
 * @param {string} input.ticketId
 * @param {string} [input.optionId] - Defaults to the ticket's recorded choice.
 * @param {{json: string, markdown: string}} [input.paths]
 * @param {Object} [input.ticketPathsOverride]
 * @returns {{patch: Patch|null, error: string|null}}
 */
function createPatch({ ticketId, optionId, paths = patchPaths(), ticketsFile = ticketPaths().json }) {
  const { tickets, error: ticketsError } = readTickets(ticketsFile);
  if (ticketsError) return { patch: null, error: `the ticket channel cannot be read: ${ticketsError}` };

  const ticket = (tickets || []).find((t) => t.id === ticketId);
  if (!ticket) return { patch: null, error: `no ticket ${ticketId}. A patch answers a ticket; there is no other way in.` };
  if (ticket.status === "closed") {
    return { patch: null, error: `ticket ${ticketId} is closed. A closed ticket has an answer already.` };
  }
  if (ticket.status === "open" || !ticket.diagnosis) {
    return {
      patch: null,
      error:
        `ticket ${ticketId} has no diagnosis yet. The order is: ask, get the options, choose one. A ` +
        `dev team that starts before the diagnosis is guessing at the cause instead of fixing it.`,
    };
  }
  if (ticket.noUsableOptions) {
    return {
      patch: null,
      error:
        `ticket ${ticketId} has no usable option: every option the diagnostics team offered was refused ` +
        `by the banned-option filter, and what it actually believes is written for the account owner. ` +
        `A dev team cannot be sent to a decision that belongs to the account owner.`,
    };
  }
  if (!ticket.choice) {
    return {
      patch: null,
      error:
        `ticket ${ticketId} has no recorded choice. The manager chooses an option, in writing, with a ` +
        `reason; that choice is what asks for a code change.`,
    };
  }

  const chosen = (ticket.options || []).find((o) => o.id === ticket.choice.optionId);
  if (!chosen) return { patch: null, error: `the chosen option ${ticket.choice.optionId} is not on ticket ${ticketId}.` };
  if (optionId && optionId !== chosen.id) {
    return {
      patch: null,
      error:
        `option ${optionId} was not the one chosen for ${ticketId}. The dev team works on the option the ` +
        `manager chose, not on a different one picked later.`,
    };
  }
  if (!chosen.requiresCodeChange) {
    return {
      patch: null,
      error:
        `option ${chosen.id} ("${chosen.label}") does not need a code change. It is a move the manager ` +
        `can make itself through the action menu — sending it to the dev team would pay a code change ` +
        `for something the manager was already allowed to do.`,
    };
  }

  const existing = patchForTicket(ticketId, paths);
  if (existing) {
    return {
      patch: null,
      error:
        `ticket ${ticketId} already has ${existing.id} (${existing.status}). One team at a time: a second ` +
        `patch on the same ticket would put two unjudged changes in the same working tree.`,
    };
  }

  const open = readPatches(paths.json).patches.filter((p) => UNJUDGED_STATUSES.includes(p.status));
  if (open.length) {
    return {
      patch: null,
      error:
        `${open.map((p) => `${p.id} (${p.status}, ticket ${p.ticketId})`).join(", ")} is already in the ` +
        `working tree, unjudged. One team at a time — the tree is what the next run executes, and two ` +
        `unjudged changes in it cannot be judged separately. Accept or reject ${open[0].id} first.`,
    };
  }

  const all = readPatches(paths.json).patches;
  const patch = {
    id: `PATCH-${String(all.length + 1).padStart(3, "0")}`,
    ticketId,
    optionId: chosen.id,
    optionLabel: chosen.label,
    step: ticket.step,
    volume: ticket.volume || null,
    finding: ticket.finding,
    status: "proposed",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    files: [],
    chosenReason: ticket.choice.reason,
  };

  const written = writePatches([...all, patch], paths);
  if (written.error) return { patch: null, error: written.error };
  return { patch, error: null };
}

// ─── The proposal lands ───────────────────────────────────────────────────────

/**
 * Cross-check the declared files against the files the working tree actually changed.
 *
 * The direction that matters is the one a diagnosis does not have: an undeclared change is not a
 * missing citation, it is an edit nobody reviewed. It is refused. A declared file that did not change
 * is a warning — the team said it would touch something and did not, which is worth knowing but is
 * not damage (same honesty rule as `crossCheckReads`, gotcha 74).
 *
 * @param {string[]} declared
 * @param {string[]} actual - Project-relative paths the tree reports as changed.
 * @returns {{undeclared: string[], unchanged: string[], ok: boolean}}
 */
function declaredChangesMatch(declared, actual) {
  const norm = (list) => (list || []).map((f) => normalizeProjectPath(f)).filter(Boolean);
  const dec = new Set(norm(declared));
  const act = new Set(norm(actual));
  const undeclared = [...act].filter((f) => !dec.has(f));
  const unchanged = [...dec].filter((f) => !act.has(f));
  return { undeclared, unchanged, ok: undeclared.length === 0 };
}

/**
 * Attach the dev team's proposal to the patch record.
 *
 * This is the only door from a dev-team turn to a patch, for the same reason `recordDiagnosis` is the
 * only door from a diagnosis to a ticket: the checks it runs (the banned-path list, the contract, the
 * declared-vs-actual cross-check) cannot be skipped by a caller that composes its own record.
 *
 * @param {string} patchId
 * @param {Object} reply - The proposal, plus the turn's real evidence.
 * @param {string[]} reply.files
 * @param {string[]} [reply.actualChanges] - What the working tree actually reports as changed.
 * @param {Array<{tool: string, path: string, reason: string}>} [reply.refusedWrites]
 * @param {{before: string|null, after: string|null}} [reply.chain] - The `npm test` script read before
 *   the dev turn and again after it. Checked here, inside the door, so no caller can skip it.
 * @param {Object} [reply.usage]
 * @param {Object} [reply.turnShape] - How the dev turn actually ran (see `turnShapeOf` in
 *   utils/agents.js). Replaces the step cap this role no longer has.
 * @param {{json: string, markdown: string}} [paths]
 * @returns {{patch: Patch|null, problems: Object[], warnings: Object[], error: string|null}}
 */
function recordProposal(patchId, reply, paths = patchPaths()) {
  const all = readPatches(paths.json).patches;
  const patch = all.find((p) => p.id === patchId);
  if (!patch) return { patch: null, problems: [], warnings: [], error: `no patch ${patchId} to attach a proposal to` };
  if (patch.status !== "proposed") {
    return { patch: null, problems: [], warnings: [], error: `patch ${patchId} is ${patch.status}; a proposal is attached once, before it is judged.` };
  }
  if (patch.summary) {
    return {
      patch: null,
      problems: [],
      warnings: [],
      error:
        `patch ${patchId} already has a proposal. A second one would replace the description the manager ` +
        `may already be reading. Refused attempts are recorded in refusedAttempts; the attached proposal ` +
        `is written once.`,
    };
  }

  const checked = validateProposalShape(reply);
  const cross = declaredChangesMatch((reply && reply.files) || [], (reply && reply.actualChanges) || []);
  if (!cross.ok) {
    checked.problems.push({
      kind: "undeclared-change",
      files: cross.undeclared,
      message:
        `the working tree changed ${cross.undeclared.map((f) => `\`${f}\``).join(", ")} which the proposal ` +
        `does not name. An edit the manager was not told about is not reviewable, so it is refused here ` +
        `rather than reported later.`,
    });
  }
  for (const f of cross.unchanged) {
    checked.warnings.push({
      kind: "declared-but-unchanged",
      file: f,
      message: `${f} was named in the proposal and the working tree does not report it as changed.`,
    });
  }

  // The gate's own list, read before the dev turn and again after it. `package.json` is not a banned
  // file — a patch may legitimately edit it — but `npm test` is a LIST, and a list a patch can shorten
  // is not a gate. This is the check the banned-path table cannot do, because shortening the chain
  // does not require naming `package.json` in the proposal at all.
  if (reply.chain) {
    const chain = testChainIsIntact(reply.chain.before, reply.chain.after);
    if (!chain.ok) {
      checked.problems.push({
        kind: "test-chain-shortened",
        files: chain.removed,
        message:
          `the \`npm test\` chain no longer runs ${chain.removed.join(", ")}. Those are the tests that ` +
          `pin the constraints on this channel, and a suite that stopped running is a guard that became ` +
          `decoration while the suite still looks green (gotcha 67). It goes to the account owner.`,
      });
    } else if (chain.added.length) {
      checked.warnings.push({
        kind: "test-chain-grew",
        files: chain.added,
        message:
          `the \`npm test\` chain now also runs ${chain.added.join(", ")}. Adding a test is allowed and ` +
          `worth naming, because the gate this patch has to pass is the thing that changed.`,
      });
    }
  }

  if (checked.problems.length) {
    // The refusal is recorded even though the proposal is not: a patch that was stopped has to be
    // visible, or the next reader assumes nobody tried.
    patch.refusedAttempts = (patch.refusedAttempts || []).concat([
      {
        at: new Date().toISOString(),
        files: ((reply && reply.files) || []).map((f) => normalizeProjectPath(f)).filter(Boolean),
        problems: checked.problems,
        warnings: checked.warnings,
      },
    ]);
    patch.refusedPaths = patchTouchesBanned((reply && reply.files) || []);
    patch.refusedWrites = (reply && reply.refusedWrites) || [];
    patch.problems = checked.problems;
    patch.updatedAt = new Date().toISOString();
    const written = writePatches(all, paths);
    return { patch: written.error ? null : patch, problems: checked.problems, warnings: checked.warnings, error: written.error || "the proposal does not meet the contract (see the problems below)." };
  }

  patch.files = (reply.files || []).map((f) => normalizeProjectPath(f));
  patch.summary = String(reply.summary).trim();
  patch.why = String(reply.why).trim();
  patch.couldBreak = String(reply.couldBreak).trim();
  patch.expected = reply.expected.map((e) => ({ signal: e.signal, direction: e.direction, why: String(e.why).trim() }));
  patch.verify = String(reply.verify).trim();
  patch.questions = (reply.questions || []).map((q) => String(q).trim()).filter(Boolean);
  patch.ownerNote = String(reply.ownerNote || "");
  patch.refusedWrites = (reply.refusedWrites) || [];
  patch.refusedPaths = patchTouchesBanned(patch.files);
  patch.warnings = checked.warnings;
  // A later attempt that passes does not erase the earlier one that did not, but it does stop the
  // earlier one being read as the current state: `problems` means "what is wrong with THIS proposal",
  // and `refusedAttempts` is the history. Without the split, `patches.md` prints "Why this proposal
  // was refused" on a patch that was accepted.
  patch.problems = [];
  patch.usage = reply.usage || null;
  patch.turnShape = reply.turnShape || null;
  // The test chain as it stood before and after the turn, kept on the record. `validateProposalShape`
  // already refuses a chain that lost a suite, but the numbers behind that judgment belong next to the
  // proposal: a reader deciding whether to accept the patch is entitled to see what the pinned checks
  // ran when the team finished, not just that they still ran.
  patch.testChain = reply.chain || null;
  patch.updatedAt = new Date().toISOString();

  const written = writePatches(all, paths);
  return { patch: written.error ? null : patch, problems: [], warnings: checked.warnings, error: written.error || null };
}

// ─── The checks ───────────────────────────────────────────────────────────────

/**
 * Judge a set of recorded checks. A patch is verifiable only when every pinned command ran and exited 0.
 *
 * @param {PatchCheck[]} checks
 * @returns {{accepted: boolean, missing: string[], failed: string[]}}
 */
function judgeChecks(checks) {
  const ran = checks || [];
  const missing = REQUIRED_CHECKS.filter((c) => !ran.some((r) => r.id === c.id)).map((c) => c.id);
  const failed = ran
    .filter((r) => !r.passed)
    .map((r) => (r.exitCode === null ? `${r.id} did not run` : `${r.id} exited ${r.exitCode}`));
  return { accepted: missing.length === 0 && failed.length === 0, missing, failed };
}

/**
 * Record the result of the pinned checks on a patch.
 *
 * The commands are run by `runChecks` in this module and the result reaches the patch only through
 * `recordChecks`. A proposal cannot be accepted while a check is missing or failed — the point of
 * running them is that the team does not get to say it ran them.
 *
 * @param {string} patchId
 * @param {PatchCheck[]} checks
 * @param {{json: string, markdown: string}} [paths]
 * @returns {{patch: Patch|null, verdict: Object, error: string|null}}
 */
function recordChecks(patchId, checks, paths = patchPaths()) {
  const all = readPatches(paths.json).patches;
  const patch = all.find((p) => p.id === patchId);
  if (!patch) return { patch: null, verdict: judgeChecks([]), error: `no patch ${patchId}` };
  if (patch.status !== "proposed" && patch.status !== "verified") {
    return { patch: null, verdict: judgeChecks(patch.checks || []), error: `patch ${patchId} is ${patch.status}; its checks are not re-run after a decision.` };
  }
  patch.checks = normalizeChecks(checks);
  patch.checkVerdict = judgeChecks(patch.checks);
  patch.status = patch.checkVerdict.accepted ? "verified" : "proposed";
  patch.updatedAt = new Date().toISOString();
  const written = writePatches(all, paths);
  return { patch: written.error ? null : patch, verdict: patch.checkVerdict, error: written.error || null };
}

/**
 * Put a recorded check into the shape the record stores, from the pinned table rather than from the
 * caller's claim.
 *
 * The command a check claims to have run is not stored verbatim: it is taken from `REQUIRED_CHECKS`, so
 * a record cannot quietly report a different (softer) command than the one that was pinned. An id that
 * is not pinned is dropped, and `judgeChecks` then reports it as missing — a check that is not on the
 * list is not a check.
 *
 * @param {Array<Object>} checks
 * @returns {PatchCheck[]}
 */
function normalizeChecks(checks) {
  const out = [];
  for (const raw of checks || []) {
    const pinned = REQUIRED_CHECKS.find((c) => c.id === (raw && raw.id));
    if (!pinned) continue;
    const exitCode = Number.isInteger(raw.exitCode) ? raw.exitCode : null;
    out.push({
      id: pinned.id,
      command: `${pinned.command} ${pinned.args.join(" ")}`.trim(),
      exitCode,
      passed: exitCode === 0,
      tail: String(raw.tail || "").slice(-4000),
      at: raw.at || new Date().toISOString(),
    });
  }
  return out;
}

/**
 * Run the pinned checks. The machine runs them; the team does not get to say it ran them.
 *
 * Lives here rather than in `fix.js` for two reasons: it is the half of the patch channel a test can
 * exercise without a model, and `fix.js` is meant to stay thin.
 *
 * The `checks` argument NARROWS which pinned commands to run; it cannot replace one. Each entry is
 * looked up in `REQUIRED_CHECKS` by id and the pinned command is what gets executed, so a caller that
 * handed this function `{id: "npm-test", command: "echo ok"}` would still get `npm test` run, and its
 * real exit code recorded. Combined with `normalizeChecks` (which re-derives the command on the way
 * into the record), there is no path through this module that reports a softer gate than the pinned one.
 *
 * Run through a shell because `npm` is a `.cmd` shim on Windows and a bare spawn does not resolve it.
 * The command string comes from `REQUIRED_CHECKS`, a code constant, never from a proposal.
 *
 * @param {{root?: string, checks?: Array<{id: string}>, timeoutMs?: number}} [opts]
 * @returns {PatchCheck[]} - One record per pinned command that ran, in the pinned order.
 */
function runChecks({ root = ROOT, checks = REQUIRED_CHECKS, timeoutMs = CHECK_TIMEOUT_MS } = {}) {
  const wanted = new Set((checks || []).map((c) => c && c.id));
  const out = [];
  for (const pinned of REQUIRED_CHECKS) {
    if (wanted.size && !wanted.has(pinned.id)) continue;
    const command = `${pinned.command} ${pinned.args.join(" ")}`.trim();
    let res;
    try {
      res = spawnSync(command, { shell: true, cwd: root, encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
    } catch (err) {
      res = { error: err, status: undefined, stdout: "", stderr: String(err && err.message) };
    }
    const exitCode = res.status === undefined || res.error ? null : res.status;
    const tail = `${res.stdout || ""}${res.stderr || ""}`.slice(-4000);
    const record = {
      id: pinned.id,
      command,
      exitCode,
      passed: exitCode === 0,
      tail: exitCode === 0 ? "" : tail,
      at: new Date().toISOString(),
    };
    if (res.error) record.note = `the check could not be started: ${res.error.message}`;
    else if (exitCode !== null && exitCode !== 0 && res.signal) record.note = `the check was killed by ${res.signal}`;
    out.push(record);
  }
  return out;
}

// ─── The manager's judgment ───────────────────────────────────────────────────

/**
 * The manager accepts or rejects a patch. It never applies one.
 *
 * Accepting runs nothing, deliberately. A code change takes effect through act mode's wipe-and-cascade
 * (gotcha 66): a running process cannot pick up a changed module, and the skip-checks do not know the
 * code changed, so "accept" that also re-ran a step would be two decisions in one command and the
 * expensive one would happen before the manager had read the proposal properly.
 *
 * @param {string} patchId
 * @param {{reason: string, decidedBy?: string}} judgment
 * @param {{json: string, markdown: string}} [paths]
 * @returns {{patch: Patch|null, error: string|null}}
 */
function acceptPatch(patchId, judgment, paths = patchPaths()) {
  return decidePatch(patchId, "accepted", judgment, paths);
}

/**
 * @param {string} patchId
 * @param {{reason: string, decidedBy?: string}} judgment
 * @param {{json: string, markdown: string}} [paths]
 * @returns {{patch: Patch|null, error: string|null}}
 */
function rejectPatch(patchId, judgment, paths = patchPaths()) {
  return decidePatch(patchId, "rejected", judgment, paths);
}

function decidePatch(patchId, outcome, judgment, paths) {
  const all = readPatches(paths.json).patches;
  const patch = all.find((p) => p.id === patchId);
  if (!patch) return { patch: null, error: `no patch ${patchId}` };
  if (patch.status === "committed") {
    return { patch: null, error: `patch ${patchId} is committed. A commit is not undone by a judgment; it is undone by a revert, by the account owner.` };
  }
  if (patch.status === "accepted" || patch.status === "rejected") {
    return { patch: null, error: `patch ${patchId} is already ${patch.status}. A decision is recorded once.` };
  }
  if (!patch.summary) {
    return { patch: null, error: `patch ${patchId} has no proposal attached yet. There is nothing to judge.` };
  }
  const reason = String((judgment && judgment.reason) || "").trim();
  if (!reason) {
    return { patch: null, error: "a judgment must carry the reason it was made for — the same rule as a ticket choice (utils/tickets.js)." };
  }
  const sound = judgmentReasonIsSound(reason);
  if (!sound.ok) {
    return {
      patch: null,
      error:
        `the reason states only that the finding is gone. That is answerable by removing the thing that ` +
        `reported the finding, which is the failure this whole channel exists to refuse (gotcha 70). Say ` +
        `what about the DELIVERABLE made this acceptable or not.`,
    };
  }
  const verdict = patch.checkVerdict || judgeChecks(patch.checks || []);
  if (outcome === "accepted" && !verdict.accepted) {
    const parts = [];
    if (verdict.missing.length) parts.push(`not run: ${verdict.missing.join(", ")}`);
    if (verdict.failed.length) parts.push(`failed: ${verdict.failed.join(", ")}`);
    return {
      patch: null,
      error:
        `patch ${patchId} cannot be accepted while its checks are not green (${parts.join("; ")}). Run ` +
        `npm run fix -- --verify=${patchId}. The checks are run by the machine, not claimed by the team.`,
    };
  }

  patch.decision = { outcome, reason, decidedBy: (judgment && judgment.decidedBy) || "manager", at: new Date().toISOString() };
  patch.status = outcome;
  patch.updatedAt = new Date().toISOString();
  const written = writePatches(all, paths);
  return { patch: written.error ? null : patch, error: written.error || null };
}

// ─── The commit and the revert ────────────────────────────────────────────────

/**
 * The working tree inside `ai-client/`, as git reports it.
 *
 * Scoped on purpose. This repository's working tree is deliberately dirty outside `ai-client/` — the
 * translation output the account owner is working through — and a patch channel that looked at the
 * whole tree would either refuse everything or sweep the corpus into a commit. `git add -A` is never
 * used here for the same reason.
 *
 * @param {string} [root] - The project root.
 * @returns {{files: Array<{status: string, path: string}>, error: string|null}}
 */
function workingTreeChanges(root = ROOT) {
  const repo = gitRootOf(root);
  if (repo.error) return { files: [], error: repo.error };
  const scope = path.relative(repo.root, path.resolve(root)) || ".";
  let out;
  try {
    // `-uall`, not the default: git collapses a folder whose contents are all new into `outer/`, and
    // this list has to name FILES. `commitPatch` compares it against the patch's declared files, and
    // `revertPatch` prints the created ones for the account owner to remove — "the folder `utils/new/`"
    // is not something either of those can act on.
    out = execFileSync("git", ["-C", repo.root, "status", "--porcelain", "-uall", "--", scope], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    return { files: [], error: `git status failed: ${String(err.stderr || err.message).trim()}` };
  }
  const files = out
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.trim())
    .map((line) => ({ status: line.slice(0, 2).trim(), path: normalizeProjectPath(line.slice(3).trim()) }))
    .filter((f) => f.path);
  return { files, error: null, repoRoot: repo.root };
}

/**
 * Where the repository actually is, asked of git rather than guessed from the folder layout.
 *
 * `ai-client/` is a subdirectory of this repository, so "the git root" is not `path.resolve(root, "..")`
 * in general — it is whatever git says, which is also what makes the same code work against a throwaway
 * fixture repository in a test.
 *
 * @param {string} [root]
 * @returns {{root: string, error: null} | {root: null, error: string}}
 */
function gitRootOf(root = ROOT) {
  try {
    const out = execFileSync("git", ["-C", path.resolve(root), "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { root: out.trim(), error: null };
  } catch (err) {
    return {
      root: null,
      error:
        `git cannot be read from ${root}: ${String(err.stderr || err.message).trim()}. The patch ` +
        `channel needs git, because "what did this patch change?" is a question about the working tree.`,
    };
  }
}

/**
 * Commit an accepted patch to `main`, staging exactly the files it declared.
 *
 * Only the dev team's CLI calls this. The commit is the acceptance act: until it happens the change is
 * a proposal sitting in a working tree, and the pipeline's own reload boundary (gotcha 66) means the
 * change only becomes the code a run executes when a run starts after it.
 *
 * @param {string} patchId
 * @param {{root?: string, message?: string, paths?: {json: string, markdown: string}}} [opts]
 * @returns {{commit: Object|null, error: string|null, extra?: string[]}}
 */
function commitPatch(patchId, { root = ROOT, message, paths = patchPaths() } = {}) {
  const all = readPatches(paths.json).patches;
  const patch = all.find((p) => p.id === patchId);
  if (!patch) return { commit: null, error: `no patch ${patchId}` };
  if (patch.status !== "accepted") {
    return {
      commit: null,
      error:
        `patch ${patchId} is ${patch.status}. The commit to main is the acceptance act, and only the ` +
        `manager's acceptance opens it.`,
    };
  }
  if (!patch.files || !patch.files.length) {
    return { commit: null, error: `patch ${patchId} declares no files. A commit with no declared paths is a commit of whatever happens to be in the tree.` };
  }

  const tree = workingTreeChanges(root);
  if (tree.error) return { commit: null, error: tree.error };
  const declared = new Set(patch.files.map((f) => normalizeProjectPath(f)));
  const extra = tree.files.map((f) => f.path).filter((f) => !declared.has(f));
  if (extra.length) {
    return {
      commit: null,
      extra,
      error:
        `the working tree holds ${extra.length} change(s) inside ai-client/ that ${patchId} does not name: ` +
        `${extra.map((f) => `\`${f}\``).join(", ")}. Committing now would sweep them into a commit nobody ` +
        `reviewed. Either declare them or put them back.`,
    };
  }

  const banned = patchTouchesBanned(patch.files);
  if (banned.length) {
    return {
      commit: null,
      error: `${patchId} touches files a patch may not edit: ${banned.map((b) => `${b.file} (${b.rule})`).join(", ")}. ${banned[0].because}`,
    };
  }

  const gitRoot = gitRootOf(root);
  if (gitRoot.error) return { commit: null, error: gitRoot.error };
  const args = ["-C", gitRoot.root, "add", "--", ...patch.files];
  try {
    execFileSync("git", args, { stdio: ["ignore", "pipe", "pipe"] });
    execFileSync(
      "git",
      ["-C", gitRoot.root, "commit", "-m", message || commitMessageFor(patch), "--", ...patch.files],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    const hash = execFileSync("git", ["-C", gitRoot.root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    patch.commit = { hash, at: new Date().toISOString(), files: patch.files.slice(), message: message || commitMessageFor(patch) };
    patch.status = "committed";
    patch.updatedAt = patch.commit.at;
    const written = writePatches(all, paths);
    if (written.error) return { commit: null, error: written.error };
    return { commit: patch.commit, error: null };
  } catch (err) {
    return { commit: null, error: `git commit failed: ${String(err.stderr || err.message).trim()}` };
  }
}

/**
 * @param {Patch} patch
 * @returns {string}
 */
function commitMessageFor(patch) {
  return (
    `fix(${patch.step}): ${patch.summary || patch.finding}\n\n` +
    `Ticket ${patch.ticketId}, option ${patch.optionId} (${patch.optionLabel || "unnamed"}).\n` +
    `Why: ${patch.why || "not stated"}\n` +
    `Accepted by ${patch.decision ? patch.decision.decidedBy : "?"}: ${patch.decision ? patch.decision.reason : "no reason recorded"}\n` +
    `Checks: ${(patch.checks || []).map((c) => `${c.id} ${c.passed ? "ok" : `FAILED (${c.exitCode})`}`).join(", ") || "none"}\n` +
    `Could break: ${patch.couldBreak || "not stated"}`
  );
}

/**
 * Put the working tree back after a rejection.
 *
 * Restores the files git tracks. A file the patch CREATED is left in place and named out loud: deleting
 * a file is Tier C (`delete-evidence`), and the patch channel does not get to decide that. The honest
 * failure is the one that says which files are still there and who removes them.
 *
 * @param {string} patchId
 * @param {{root?: string, paths?: {json: string, markdown: string}}} [opts]
 * @returns {{restored: string[], leftBehind: string[], error: string|null}}
 */
function revertPatch(patchId, { root = ROOT, paths = patchPaths() } = {}) {
  const all = readPatches(paths.json).patches;
  const patch = all.find((p) => p.id === patchId);
  if (!patch) return { restored: [], leftBehind: [], error: `no patch ${patchId}` };
  if (patch.status !== "rejected") {
    return { restored: [], leftBehind: [], error: `patch ${patchId} is ${patch.status}. Only a rejected patch is reverted.` };
  }
  const gitRoot = gitRootOf(root);
  if (gitRoot.error) return { restored: [], leftBehind: [], error: gitRoot.error };
  const tree = workingTreeChanges(root);
  if (tree.error) return { restored: [], leftBehind: [], error: tree.error };

  const mine = tree.files.filter((f) => (patch.files || []).includes(f.path));
  const tracked = mine.filter((f) => f.status !== "??");
  const created = mine.filter((f) => f.status === "??");

  /** @type {string[]} */
  const restored = [];
  for (const f of tracked) {
    try {
      execFileSync("git", ["-C", gitRoot.root, "checkout", "--", f.path], { stdio: ["ignore", "pipe", "pipe"] });
      restored.push(f.path);
    } catch (err) {
      return { restored, leftBehind: created.map((c) => c.path), error: `git checkout failed for ${f.path}: ${String(err.stderr || err.message).trim()}` };
    }
  }

  patch.reverted = { restored, leftBehind: created.map((c) => c.path), at: new Date().toISOString() };
  patch.updatedAt = patch.reverted.at;
  writePatches(all, paths);
  return { restored, leftBehind: created.map((c) => c.path), error: null };
}

/**
 * The `npm test` script as it currently stands in `package.json`.
 *
 * Read before the dev turn and again after it, so `testChainIsIntact` can answer the question the
 * banned-path list cannot: a patch is not allowed to edit `package.json`'s test chain at all, but the
 * chain is also what the gate runs, so a chain that quietly lost a suite has to be caught even by a
 * patch that never names `package.json` in its proposal.
 *
 * @param {string} [root]
 * @returns {{script: string|null, error: string|null}}
 */
function readTestChain(root = ROOT) {
  try {
    const raw = fs.readFileSync(path.join(root, "package.json"), "utf8");
    const pkg = JSON.parse(raw);
    return { script: (pkg.scripts && pkg.scripts.test) || "", error: null };
  } catch (err) {
    return { script: null, error: `cannot read the npm test chain from ${root}/package.json: ${err.message}` };
  }
}

// ─── Reading it ───────────────────────────────────────────────────────────────

/**
 * The proposal as the manager reads it: no diff, no code, and every number in units it can check.
 *
 * @param {Patch} patch
 * @returns {string}
 */
function renderProposalMarkdown(patch) {
  const lines = [
    `### ${patch.id} — ${patch.step}${patch.volume ? ` volume ${patch.volume}` : ""} — ${patch.finding}`,
    `Status: ${patch.status}`,
    ``,
    `**Answers:** ${patch.ticketId}, option ${patch.optionId}${patch.optionLabel ? ` ("${patch.optionLabel}")` : ""}`,
    patch.chosenReason ? `**Why the manager chose that option:** ${patch.chosenReason}` : "",
    ``,
    `**What changed:**`,
    patch.summary || "*(not stated)*",
    ``,
    `**The mechanism it fixes:**`,
    patch.why || "*(not stated)*",
    ``,
    `**Files it touched:**`,
    ...((patch.files || []).length ? patch.files.map((f) => `- \`${f}\``) : ["*(none declared)*"]),
    ``,
    `**What it could break:**`,
    patch.couldBreak || "*(not stated)*",
    ``,
    `**What it expects to move in the deliverable:**`,
    ...((patch.expected || []).length
      ? patch.expected.map((e) => `- \`${e.signal}\` ${e.direction} — ${e.why}`)
      : ["*(nothing stated)*"]),
    ``,
    `**How the manager checks it:**`,
    patch.verify || "*(not stated)*",
  ];

  if ((patch.questions || []).length) {
    lines.push(``, `**Questions back to the manager:**`);
    for (const q of patch.questions) lines.push(`- ${q}`);
  }
  if (patch.ownerNote) {
    lines.push(``, `**For the account owner only** (not something the manager may accept):`, patch.ownerNote);
  }

  lines.push(``, `**The checks the machine ran:**`);
  if ((patch.checks || []).length) {
    for (const c of patch.checks) {
      lines.push(`- \`${c.command}\` → ${c.passed ? "passed" : `FAILED (exit ${c.exitCode === null ? "never ran" : c.exitCode})`}`);
      if (!c.passed && c.tail) lines.push(`  - ${String(c.tail).split("\n").slice(-3).join("\n  - ")}`);
    }
  } else {
    lines.push("- *(none yet — run `npm run fix -- --verify=" + patch.id + "`)*");
  }
  // A check that never ran is not the same as a check that passed, and a list of only the ones that
  // ran reads like the whole gate did. The verdict is printed next to the list so the manager cannot
  // infer "green" from a short one.
  const verdict = patch.checkVerdict;
  if (verdict && (verdict.missing.length || verdict.failed.length)) {
    if (verdict.missing.length) lines.push(`- **never ran:** ${verdict.missing.join(", ")}`);
    if (verdict.failed.length) lines.push(`- **failed:** ${verdict.failed.join(", ")}`);
    lines.push(`- This patch is ${verdict.accepted ? "not blocked by its checks" : "not acceptable yet"}.`);
  }

  if ((patch.refusedWrites || []).length) {
    lines.push(``, `**Writes the sandbox gate stopped during that turn:**`);
    for (const w of patch.refusedWrites) lines.push(`- \`${w.tool}\` on \`${w.path}\` — ${w.reason}`);
  }
  if ((patch.refusedPaths || []).length) {
    lines.push(``, `**Files this patch was refused for touching:**`);
    for (const b of patch.refusedPaths) lines.push(`- \`${b.file}\` — ${b.because}\n  - goes to: ${b.escalateTo}`);
  }
  if ((patch.warnings || []).length) {
    lines.push(``, `**Warnings:**`);
    for (const w of patch.warnings) lines.push(`- ${w.message}`);
  }
  if ((patch.problems || []).length) {
    lines.push(``, `**Why this proposal was refused:**`);
    for (const p of patch.problems) lines.push(`- ${p.message}`);
  }
  if ((patch.refusedAttempts || []).length) {
    lines.push(``, `**Attempts the machine refused before this one** (kept so a stopped attempt is not mistaken for nobody trying):`);
    for (const a of patch.refusedAttempts) {
      const files = (a.files || []).length ? a.files.map((f) => `\`${f}\``).join(", ") : "no files named";
      lines.push(`- ${a.at}, ${files}:`);
      for (const p of a.problems || []) lines.push(`  - refused: ${p.message}`);
      for (const w of a.warnings || []) lines.push(`  - warned: ${w.message}`);
    }
  }
  if (patch.decision) {
    lines.push(``, `**Decision:** ${patch.decision.outcome} by ${patch.decision.decidedBy} — ${patch.decision.reason}`);
  }
  if (patch.commit) {
    lines.push(``, `**Committed:** \`${patch.commit.hash}\` (${patch.commit.files.length} file(s)) at ${patch.commit.at}`);
  }
  if (patch.reverted) {
    lines.push(
      ``,
      `**Reverted:** ${patch.reverted.restored.length} file(s) restored from git` +
        (patch.reverted.leftBehind.length
          ? `. Still in the tree, created by this patch, for the account owner to remove: ${patch.reverted.leftBehind.map((f) => `\`${f}\``).join(", ")}`
          : "")
    );
  }
  if (patch.turnShape || patch.usage) {
    const u = patch.usage || {};
    const s = patch.turnShape;
    const ran = s
      ? `${s.toolCalls} tool call(s) over ${s.chunks} chunk(s), no step cap` +
        (s.offloads
          ? `, ${s.offloads} read answer(s) set aside on disk (${s.offloadedTokens} tokens)`
          : "") +
        `, ended: ${s.endedAs || "not recorded"}`
      : "shape not recorded";
    lines.push(``, `*Dev turn: ${ran}; ${u.input || "?"} input / ${u.output || "?"} output tokens.*`);
  }
  return lines.filter((l) => l !== "").join("\n");
}

/**
 * @param {Patch} patch
 * @returns {string}
 */
function renderPatchMarkdown(patch) {
  return renderProposalMarkdown(patch) + "\n";
}

/**
 * Every patch as Markdown, newest last — the file a human reads.
 * @param {Patch[]} [patches]
 * @returns {string}
 */
function renderPatchesMarkdown(patches = readPatches().patches) {
  const header = [
    "# Patch proposals",
    "",
    "What the dev team changed, why, what it could break, and what the machine ran to prove it.",
    "The delivery manager accepts or rejects these; it never applies one, and only the dev team commits.",
    "",
  ];
  if (!patches.length) {
    return `${header.join("\n")}No patches. Nothing has been proposed, so nothing is waiting in the working tree.\n`;
  }
  const pending = patches.filter((p) => UNJUDGED_STATUSES.includes(p.status));
  // A rejected patch is judged, but its edits are still in the tree until somebody reverts them, and
  // the tree is what the next run executes. Saying "nothing unjudged" while that is true would be the
  // one sentence in this file that is actively wrong.
  const unreverted = patches.filter((p) => p.status === "rejected" && !p.reverted);
  let headline;
  if (pending.length) {
    headline =
      `**${pending.length} unjudged change(s) in the working tree of \`main\`:** ${pending
        .map((p) => `${p.id} (${p.status})`)
        .join(", ")}. The pipeline runs whatever is in this tree, so act mode refuses to run a step while one is waiting.`;
  } else if (unreverted.length) {
    headline =
      `**${unreverted.length} rejected patch(es) still in the working tree:** ${unreverted
        .map((p) => p.id)
        .join(", ")}. The manager said no to this code and it is still what the next run would execute. ` +
      `Put it back: ${unreverted.map((p) => `npm run fix -- --revert=${p.id}`).join("  ")}`;
  } else {
    headline = "Nothing unjudged is in the working tree.";
  }
  const body = [headline, "", ...patches.map(renderProposalMarkdown)];
  return `${header.join("\n")}${body.join("\n")}\n`;
}

// ─── Path helpers ─────────────────────────────────────────────────────────────

/**
 * Normalise a path to project-relative forward slashes, and reject the ones that cannot mean that.
 *
 * An absolute path is resolved against `root` rather than refused outright: the dev team's brief names
 * the project root in full, and a channel that refused every path the role was told to use would refuse
 * the work, not the danger. An absolute path that is genuinely outside `root` still returns `null`,
 * which is what makes `path-outside-project` the refusal it is.
 *
 * @param {string} p
 * @param {string} [root]
 * @returns {string|null}
 */
function normalizeProjectPath(p, root = ROOT) {
  const raw = String(p || "").trim();
  // An absolute path is not automatically outside the project. `renderTicketForDev` names the project
  // root in full, so a dev team that uses the path it was handed must land inside the project, not be
  // refused for every write it attempts. An absolute path OUTSIDE the root is still `null`, because
  // `null` is what makes `path-outside-project` the refusal it is.
  if (path.isAbsolute(raw)) {
    const relToRoot = path.relative(path.resolve(root), path.normalize(raw)).replace(/\\/g, "/");
    if (!relToRoot || relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) return null;
    return relToRoot.replace(/^ai-client\//, "") || null;
  }
  let rel = raw.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  if (rel.startsWith("../") || rel.startsWith("~/")) return null;
  while (rel.startsWith("./")) rel = rel.slice(2);
  if (!rel) return null;
  if (rel.split("/").includes("..")) return null;
  // Strip the `ai-client/` prefix a git path from the repository root carries.
  if (rel.startsWith("ai-client/")) rel = rel.slice("ai-client/".length);
  return rel || null;
}

module.exports = {
  ROOT,
  PATCH_STATUSES,
  UNJUDGED_STATUSES,
  REQUIRED_CHECKS,
  CHECK_TIMEOUT_MS,
  BANNED_PATCH_PATHS,
  ANSWER_KEY_FILES,
  PROPOSAL_CONTRACT,
  SIGNAL_NAMES,
  // `OUTCOME_ONLY_CHECK` and `verificationIsOutcomeOnly` are deliberately NOT re-exported here. The
  // table lives in utils/tickets.js and is read from there by both sides, so there is one list to
  // argue with rather than two that drift (see the comment above `judgmentReasonIsSound`).
  patchPaths,
  readPatches,
  writePatches,
  findPatch,
  pendingPatches,
  unresolvedPatches,
  patchForTicket,
  createPatch,
  recordProposal,
  validateProposalShape,
  judgmentReasonIsSound,
  testChainIsIntact,
  patchPathIsBanned,
  patchTouchesBanned,
  patchTouchesAnswerKey,
  isProjectSourcePath,
  corpusIsNamedArtifact,
  ruleById,
  declaredChangesMatch,
  judgeChecks,
  recordChecks,
  normalizeChecks,
  runChecks,
  acceptPatch,
  rejectPatch,
  commitPatch,
  revertPatch,
  workingTreeChanges,
  gitRootOf,
  readTestChain,
  commitMessageFor,
  renderProposalMarkdown,
  renderPatchMarkdown,
  renderPatchesMarkdown,
  normalizeProjectPath,
};
