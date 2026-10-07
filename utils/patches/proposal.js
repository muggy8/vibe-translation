/**
 * The proposal contract (fail-closed, like the acceptance grade), the claim it must make in units the deliverable measurement actually counts, and the door a dev turn reaches the record through. A judgment reason is checked, not just required: 'volume 15 passes now' is the complaint stopping, not the change being sound.
 *
 * Part of the patches.js layer (split out of the original single file).
 */

const { OUTCOME_ONLY_CHECK, verificationIsOutcomeOnly } = require("../tickets");

const { normalizeProjectPath, patchTouchesAnswerKey, patchTouchesBanned } = require("./path-rules");
const { PROPOSAL_CONTRACT, SIGNAL_DIRECTIONS, SIGNAL_NAMES } = require("./rules");
const { testChainIsIntact } = require("./checks");
const { patchPaths, readPatches, writePatches } = require("./record");

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


module.exports = {
  judgmentReasonIsSound,
  validateProposalShape,
  declaredChangesMatch,
  recordProposal,
};
