/**
 * utils/manager.js — the delivery manager's own decision, as one tool-less call.
 *
 * Everything else in this layer is deterministic. `utils/resume.js` reads the state, `delivery.js`
 * gates and executes, `utils/delivery-verify.js` measures the result, `utils/tickets.js` and
 * `utils/patches.js` are the channels to the teams that CAN see the code. What was missing is the
 * judgment in between — *"of the moves available to me right now, which one do I make next?"* — and
 * that is the only thing in this layer that needs a model.
 *
 * Three rules make that call survivable, and they are the module:
 *
 * 1. **It is a one-shot, not an agent.** `harness.runOneShot` with no tools: a shaped report goes
 *    in, one JSON action comes out. The manager's whole guarantee is that it never sees the code
 *    (AGENTS.md §3.6), and an agent handle IS a set of file-reading tools — handing the manager a
 *    tool set would turn the boundary into a sentence in a prompt instead of a capability it does
 *    not have. It is also the first reader of `DELIVERY_MAX_TOKENS`: a decision is a few thousand
 *    tokens, and it must not be able to spend a stage's reply budget writing prose.
 *
 * 2. **It chooses from a menu; it cannot invent a move.** The caller hands in the moves the current
 *    state actually supports (`offerMoves`), and `validateManagerAction` refuses anything else by
 *    name. `DELIVERY_ACTIONS` already closes the vocabulary of *primitives* a plan may name; this
 *    closes the vocabulary of *decisions*, because "run glossary" is not a legal answer when the
 *    triage says glossary's problem is a gate (gotcha 71) and "apply this patch" was never anybody's
 *    move (gotcha 75).
 *
 * 3. **The reply is parsed fail-closed, and the two claims that need proving are proved against the
 *    records.** `endIsProvable` refuses "I'm done" while a ticket is open, a patch is unjudged, or
 *    the triage's own verdict is not `nothing-to-do`; `safeToAcceptAutomatically` refuses an
 *    unattended accept for anything that is not ordinary project code with green pinned checks.
 *    A model asserting a result is not a result — that is gotcha 70's rule applied to the manager's
 *    own final sentence.
 *
 * What this module deliberately does NOT do: it does not execute anything, it does not read the disk
 * (the caller hands it the records it already read), and it does not decide for the account owner —
 * `escalate` is an action precisely so that "this needs a human" is a move the loop can make instead
 * of a thing it has to fake.
 */

require("../types"); // JSDoc type definitions

const harness = require("../harness");
const { runTurnWithHooks, MANAGER_TASK } = require("./hooks");
const { judgeTemperature, judgeThinking } = require("../configs/shared");
const { extractJsonObject } = require("./manifest");
const { customerMayRead, sameQuestion, unansweredQuestions } = require("./tickets");
const { judgmentReasonIsSound, patchTouchesBanned, isProjectSourcePath, UNJUDGED_STATUSES } = require("./patches");

/**
 * The manager's own reply budget. `DELIVERY_MAX_TOKENS` existed in `.env` with no reader; this is it.
 *
 * There is deliberately no token BUDGET here (no `DELIVERY_TOKEN_BUDGET`) — the ceiling on one
 * decision is the model's own output cap, and what stops a spin is the ledger, not a spending limit
 * (AGENTS.md §9, "The delivery manager"). A spending limit would hide the spin behind a cost error,
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
- The same action against the same finding that has already failed twice will be refused. Volume 15
  of this series is the case: re-running a deterministic gate reproduces the identical quarantine,
  because the finding was never about the data.

Answer with ONE fenced \`\`\`json block and nothing after it.`;

/**
 * One ticket, rendered for the role that cannot see the code.
 *
 * @param {import("./tickets").Ticket} ticket
 * @returns {string}
 */
function renderTicketForManager(ticket) {
  const lines = [
    `### ${ticket.id} — ${ticket.step}${ticket.volume ? ` volume ${ticket.volume}` : ""} — ${ticket.finding}`,
    `status: ${ticket.status}`,
    `your question: ${ticket.question}`,
  ];
  if (ticket.evidence && ticket.evidence.length) {
    lines.push("what you looked at:");
    // `note` is the field `utils/tickets.js` stores (`TicketEvidence` is `{file, note}`); a renderer
    // that reaches for a field the record does not have prints `undefined` to the one role that has
    // to decide from it.
    for (const e of ticket.evidence) lines.push(`  - ${e.file}: ${e.note || ""}`);
  }
  if (ticket.tried && ticket.tried.length) {
    lines.push("already tried (read out of the ledger, not from memory):");
    for (const t of ticket.tried) lines.push(`  - ${t.action} → ${t.outcome}${t.ledgerId ? ` (${t.ledgerId})` : ""}`);
  }
  if (ticket.ruledOut && ticket.ruledOut.length) {
    lines.push("ruled out:");
    for (const r of ticket.ruledOut) lines.push(`  - ${r}`);
  }

  const diag = ticket.diagnosis;
  if (diag) {
    lines.push("");
    lines.push("**their answer:**");
    lines.push(`cause: ${diag.cause}`);
    if (diag.recommend) lines.push(`they recommend: ${diag.recommend}`);
    if (diag.read && diag.read.length) {
      lines.push(`they say they read: ${diag.read.join(", ")}`);
    }
    if (diag.citedWithoutReading && diag.citedWithoutReading.length) {
      lines.push(
        `note: they named ${diag.citedWithoutReading.join(", ")} as evidence but that turn never opened ` +
          `it — their answer is weaker than it looks.`
      );
    }
    if (diag.attemptedWrites && diag.attemptedWrites.length) {
      lines.push(
        `note: that turn tried ${diag.attemptedWrites.length} write(s) and the read-only gate refused ` +
          `every one (${diag.attemptedWrites.map((w) => w.path).join(", ")}).`
      );
    }
  }

  const waiting = (diag && diag.questions ? diag.questions : []).filter(
    (q) => !((ticket.answers || []).some((a) => String(a.question).trim() === String(q).trim()))
  );
  if (waiting.length) {
    lines.push("");
    lines.push("**waiting on you:**");
    for (const q of waiting) lines.push(`  - ${q}`);
  }

  const options = ticket.options || [];
  if (options.length) {
    lines.push("");
    lines.push("**options you may choose from:**");
    for (const o of options) {
      const flags = [];
      if (o.requiresCodeChange) flags.push("needs the dev team");
      if (o.outcomeOnlyVerification) {
        flags.push('its only stated check is "the finding disappears" — the before/after comparison of the deliverable is what judges it');
      }
      lines.push(`  - ${o.id}: ${o.label}`);
      lines.push(
        `      cost ${o.cost || "?"} · touches ${o.touches ? o.touches.join(", ") : "?"} · risk ${o.risk || "?"}`
      );
      lines.push(`      how to check it worked: ${o.verify || "?"}${flags.length ? ` · ${flags.join(" · ")}` : ""}`);
    }
  }
  if (ticket.noUsableOptions) {
    lines.push("");
    lines.push(
      "**every option they offered was refused by the filter.** What they actually believe is in " +
        "ownerNote, which is written for the account owner and not for you. Your move here is " +
        "`escalate`, not a workaround."
    );
  }
  if (ticket.refusedOptions && ticket.refusedOptions.length) {
    lines.push("");
    lines.push("**options that are NOT on your menu** (kept visible so you know they were considered):");
    for (const r of ticket.refusedOptions) {
      lines.push(`  - ${r.option.label}: ${r.because} Goes to ${r.escalateTo}.`);
    }
  }
  if (ticket.choice) {
    lines.push("");
    lines.push(`you chose ${ticket.choice.optionId}: ${ticket.choice.reason}`);
  }
  return lines.join("\n");
}

/**
 * One patch proposal, rendered for the role that cannot read a diff.
 *
 * @param {import("./patches").Patch} patch
 * @returns {string}
 */
function renderPatchForManager(patch) {
  const lines = [
    `### ${patch.id} (${patch.status}) — answers ${patch.ticketId} option ${patch.optionId} — ${patch.step}` +
      `${patch.volume ? ` volume ${patch.volume}` : ""}`,
    `what changed: ${patch.summary || "(none given)"}`,
    `why it fixes the mechanism: ${patch.why || "(none given)"}`,
    `what it could break: ${patch.couldBreak || "(none given)"}`,
  ];
  if (patch.expected && patch.expected.length) {
    lines.push("what they expect to move in the deliverable:");
    for (const e of patch.expected) lines.push(`  - ${e.signal} ${e.direction}: ${e.why}`);
  }
  if (patch.verify) lines.push(`how to check it: ${patch.verify}`);
  lines.push(`files they say they touched (${(patch.files || []).length}): ${(patch.files || []).join(", ") || "none"}`);
  const verdict = patch.checkVerdict;
  if (verdict && verdict.accepted) {
    lines.push("the pinned checks ran and passed: " + (patch.checks || []).map((c) => `${c.id} exit ${c.exitCode}`).join(", "));
  } else if (verdict) {
    if (verdict.missing.length) lines.push(`checks that NEVER RAN: ${verdict.missing.join(", ")}`);
    if (verdict.failed.length) lines.push(`checks that FAILED: ${verdict.failed.join(", ")}`);
  } else {
    lines.push("the pinned checks have never run on this patch.");
  }
  if (patch.warnings && patch.warnings.length) {
    for (const w of patch.warnings) lines.push(`note: ${w.message || w.kind}`);
  }
  if (patch.refusedWrites && patch.refusedWrites.length) {
    lines.push(
      `note: that team tried ${patch.refusedWrites.length} write(s) the boundary refused ` +
        `(${patch.refusedWrites.map((w) => `${w.path}: ${w.reason}`).join("; ")}).`
    );
  }
  if (patch.refusedAttempts && patch.refusedAttempts.length) {
    lines.push(`note: this is attempt ${patch.refusedAttempts.length + 1}. Earlier attempts were refused for:`);
    for (const a of patch.refusedAttempts) {
      for (const p of a.problems || []) lines.push(`  - ${p.message}`);
    }
  }
  if (patch.ownerNote) {
    lines.push(`**ownerNote (written for the account owner, not for you):** ${patch.ownerNote}`);
  }
  if (patch.decision) {
    lines.push(`your decision: ${patch.decision.outcome} — ${patch.decision.reason}`);
  }
  return lines.join("\n");
}

/**
 * The whole brief for one decision.
 *
 * Bounded by construction: every section here is a record this layer already wrote for a human
 * reader. Nothing is read from the disk, and nothing that matches `customerMayRead`'s refusals
 * (.logs/, a .js, a prompt, hooks/, utils/) appears in it — the one exception is a patch's declared
 * file list, which is the change the manager is being asked to judge and is the only place a file
 * name reaches this role at all.
 *
 * @param {Object} args
 * @param {import("./resume").ResumePlan} args.plan - The triage, as `planResume` wrote it.
 * @param {ManagerMove[]} args.moves - The offered menu.
 * @param {import("./tickets").Ticket[]} [args.tickets] - The open tickets.
 * @param {import("./patches").Patch[]} [args.patches] - The patches waiting for a judgment.
 * @returns {string}
 */
function renderManagerBrief({ plan, moves, tickets = [], patches = [] }) {
  const out = [MANAGER_RULES, "", "---", ""];

  out.push(`## The question`);
  out.push(
    `A run against "${plan.seriesDir}" has been assessed. You have not read the code and you are not ` +
      `going to. Choose the next move from the list at the end of this message.`
  );
  out.push("");

  out.push(`## What the triage says`);
  out.push(`verdict: ${plan.verdict}`);
  out.push(plan.headline);
  for (const step of plan.steps || []) {
    const bits = [step.actionName || step.action];
    if (step.fromVolume) bits.push(`from volume ${step.fromVolume}`);
    if (step.cascade) bits.push("cascade");
    if (step.countsAsIntervention) bits.push("counts as an intervention");
    out.push(`- ${step.step}: ${bits.join(", ")}`);
    for (const r of step.reasons || []) out.push(`    ${r}`);
  }
  if (plan.notes && plan.notes.length) {
    out.push("");
    out.push("notes that are not actions:");
    for (const n of plan.notes) out.push(`- ${n}`);
  }
  if (plan.recurring && plan.recurring.length) {
    out.push("");
    out.push("findings that survived an earlier recorded run (structural, not transient):");
    for (const r of plan.recurring) {
      out.push(`- ${r.finding} in ${r.runs} run(s)${r.steps.length ? ` (${r.steps.join(", ")})` : ""}`);
    }
  }
  out.push("");

  const d = plan.deliverable;
  out.push(`## The deliverable (what the pipeline actually published)`);
  if (!d) {
    out.push("There is no publish report yet. That means the translation stage has not produced a book, " +
      "not that the book is fine.");
  } else {
    const c = d.counts || {};
    out.push(
      `${c.published || 0} published · ${c.unverified || 0} unverified · ${c.missing || 0} missing · ` +
        `${c.emptyInSource || 0} empty in the source (a hole in the book, not in the run) · ` +
        `of ${c.total || 0} chapters`
    );
    if (typeof c.scoreMedian === "number") out.push(`median verification score: ${c.scoreMedian}`);
    if (c.crossChapterHigh) out.push(`cross-chapter HIGH findings: ${c.crossChapterHigh}`);
    if (c.variantConflicts) out.push(`rendering-variant conflicts: ${c.variantConflicts}`);
  }
  out.push("");

  const budget = plan.interventionBudget;
  const spent = plan.interventionsByStep || {};
  if (Object.keys(spent).length) {
    out.push(`## Your remaining attempts on each step (budget ${budget} per step)`);
    for (const [step, used] of Object.entries(spent)) {
      out.push(`- ${step}: ${used} used, ${Math.max(0, budget - used)} left`);
    }
    out.push("");
  }

  if (tickets.length) {
    out.push(`## Tickets open with the support teams`);
    for (const t of tickets) out.push(renderTicketForManager(t), "");
  }

  if (patches.length) {
    out.push(`## Patches waiting for your judgment`);
    out.push(
      `These are already in the working tree. Until you judge them, the pipeline cannot be run: it ` +
        `would be running code nobody accepted.`
    );
    out.push("");
    for (const p of patches) out.push(renderPatchForManager(p), "");
  }

  out.push(`## The moves available to you right now`);
  if (!moves.length) {
    out.push(
      `None. Nothing on this state is executable for you, which means the correct answer is ` +
        `"escalate" with what the account owner has to decide.`
    );
  }
  for (const m of moves) out.push(`- ${m.label}`);
  out.push("");

  out.push(`## Answer as`);
  out.push("```json");
  out.push(
    JSON.stringify(
      {
        action: "one of: " + MANAGER_ACTIONS.map((a) => a.name).join(" | "),
        reason: "why this move, now, in one or two sentences",
        step: "for run: the step exactly as offered",
        ticket: "for diagnose / answer / choose / fix: the ticket id",
        answer: "for answer: your reply to their question",
        question: "for answer: which question, quoted from the ticket (say it when the ticket has more than one open)",
        option: "for choose: the option id",
        patch: "for judge: the patch id",
        outcome: "for judge: accept or reject",
        note: "for escalate: what the account owner must decide",
      },
      null,
      2
    )
  );
  out.push("```");
  out.push("Only the fields your action needs. Nothing after the block.");
  return out.join("\n");
}

// ─── The reply: fail-closed parse ─────────────────────────────────────────────

/**
 * Pull the machine-readable block out of a reply that reasoned in prose first.
 *
 * The LAST fenced block wins, for the same reason `utils/devteam.js` takes the last one: a real
 * answer thinks out loud and puts the JSON at the end, and `extractJsonObject`'s first-brace-to-
 * last-brace rule mangles a reply that quotes a JSON example on its way to the real one.
 *
 * @param {string} text
 * @returns {Object|null} - null when nothing parseable is there.
 */
function extractActionJson(text) {
  const raw = String(text || "");
  const fences = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  for (let i = fences.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(fences[i].trim());
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // Not the block. Keep looking backwards.
    }
  }
  try {
    const salvaged = extractJsonObject(raw);
    if (salvaged) {
      const parsed = JSON.parse(salvaged);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    }
  } catch {
    // Fall through to the refusal below.
  }
  return null;
}

/**
 * Parse and shape-check one manager reply. Fail-closed, like `parseAcceptanceReply` and
 * `validateProposalShape`: an unparseable decision is a failed check, never a default action.
 *
 * There is no "safe default" here on purpose. Defaulting to `end` would end a run that is not
 * finished; defaulting to `run` would spend a real run's worth of model calls on a guess.
 *
 * @param {string} reply - The model's raw reply.
 * @returns {{action: ManagerAction|null, problems: Array<{kind: string, message: string}>, warnings: Array<{kind: string, message: string}>}}
 */
function parseManagerAction(reply) {
  const problems = [];
  const warnings = [];
  const raw = extractActionJson(reply);
  if (!raw) {
    return {
      action: null,
      problems: [
        {
          kind: "unparseable",
          message:
            `the reply contains no parseable JSON action block. Answer with one fenced \`\`\`json block ` +
            `containing action / reason and the fields that action needs.`,
        },
      ],
      warnings,
    };
  }

  const action = String(raw.action || "").trim();
  if (!action) {
    problems.push({ kind: "missing-field", message: "action is required: one of " + [...ACTION_NAMES].join(" | ") });
  } else if (!ACTION_NAMES.has(action)) {
    problems.push({
      kind: "unknown-action",
      message:
        `"${action}" is not a move the delivery manager may make. The whole vocabulary is: ` +
        `${MANAGER_ACTIONS.map((a) => a.name).join(", ")}.`,
    });
  }

  const reason = typeof raw.reason === "string" ? raw.reason.trim() : "";
  if (!reason) {
    problems.push({
      kind: "missing-field",
      message: "reason is required for every action: a decision nobody wrote down is not reviewable afterwards.",
    });
  } else if (reason.length < 30) {
    warnings.push({
      kind: "thin-reason",
      message: `the reason is ${reason.length} characters. The ledger and the report are what a human reads ` +
        `six runs later; one clause is the whole record of why this run did what it did.`,
    });
  }

  const spec = ACTION_BY_NAME.get(action);
  if (spec) {
    for (const field of spec.needs) {
      const value = raw[field];
      const empty =
        value === undefined || value === null || (typeof value === "string" && !value.trim());
      if (empty) {
        problems.push({
          kind: "missing-field",
          message: `${field} is required for action "${action}": ${spec.what}`,
        });
      }
    }
  }

  if (raw.outcome !== undefined && raw.outcome !== "accept" && raw.outcome !== "reject") {
    problems.push({ kind: "bad-value", message: `outcome must be "accept" or "reject", not ${JSON.stringify(raw.outcome)}` });
  }

  // Extra fields are not a refusal: a model that answers `step` on a `judge` action has said
  // something harmless, and refusing it would be a rule about style rather than about safety.
  const allowed = new Set(["action", "reason", "step", "ticket", "answer", "option", "patch", "outcome", "note"]);
  const extra = Object.keys(raw).filter((k) => !allowed.has(k));
  if (extra.length) warnings.push({ kind: "extra-fields", message: `ignored field(s): ${extra.join(", ")}` });

  if (problems.length) return { action: null, problems, warnings };
  return { action: raw, problems, warnings };
}

// ─── The menu gate: is this move actually on the menu? ────────────────────────

/**
 * The words in a sentence that look like a file path.
 *
 * Used to check a manager's ANSWER against `customerMayRead` (gotcha 74): the diagnostics team may
 * ask about anything it needs to, but a reply may only cite what a customer is allowed to have seen.
 * Two shapes are picked up — anything with a separator in it (`utils/prompt.js`, `hooks/pre-glossary.sh`,
 * `.logs/summary.log`), and any bare word with a code or document extension (`index.js`, `glossary.md`).
 *
 * Deliberately loose on the false-positive side: `1.5/2.5` and `01-03` come back as "paths" and pass
 * the check, because a refusal that accuses an honest answer is a check the next incident routes
 * around (gotcha 65).
 *
 * @param {string} text
 * @returns {string[]}
 */
function pathishWords(text) {
  const NAME = "[A-Za-z0-9_.\\-\\u3040-\\u30FF()]+";
  const re = new RegExp(
    `(?:${NAME}[\\\\/])+${NAME}|\\b${NAME}\\.(?:js|mjs|cjs|ts|md|json|txt|epub|sh|py)\\b`,
    "gi"
  );
  return (String(text || "").match(re) || []).map((w) => w.replace(/\\/g, "/"));
}

/**
 * Refuse a decision the current state does not support.
 *
 * This is the manager-side twin of `delivery.js`'s `gateMenu`, and it exists for the same reason:
 * `planResume` already only names menu entries, and `delivery.js` re-checks them at execution time,
 * because the proposal is a document and execution is the thing with consequences. A model's answer
 * is neither — it is the thing that decides which of them happens next.
 *
 * Every refusal names what WAS available, because a refusal that does not name the usable move is
 * the kind of refusal people switch off (gotcha 65).
 *
 * @param {ManagerAction} action - A parsed action.
 * @param {Object} ctx
 * @param {ManagerMove[]} ctx.moves - The offered menu.
 * @param {import("./tickets").Ticket[]} [ctx.tickets] - The open tickets.
 * @param {import("./patches").Patch[]} [ctx.patches] - The patches.
 * @param {import("./resume").ResumePlan} [ctx.plan] - Needed to prove `end`.
 * @returns {{allowed: boolean, why: string|null, kind: string|null}}
 */
function validateManagerAction(action, { moves = [], tickets = [], patches = [], plan = null }) {
  const refuse = (kind, why) => ({ allowed: false, why, kind });
  const spec = ACTION_BY_NAME.get(action.action);
  if (!spec) return refuse("unknown-action", `"${action.action}" is not a move the delivery manager may make.`);

  if (spec.offered) {
    const match = moves.find((m) => {
      if (m.kind !== action.action) return false;
      if (action.action === "run") return m.step === action.step;
      return true;
    });
    if (!match) {
      const offered = moves.filter((m) => m.kind === action.action).map((m) => m.label);
      return refuse(
        "not-offered",
        `there is no "${action.action}" move on the menu for this state.` +
          (offered.length
            ? ` The ${action.action} moves available are: ${offered.join(" | ")}.`
            : ` Nothing on this state supports a ${action.action} move right now.`)
      );
    }
  }

  const findTicket = (id) => tickets.find((t) => t.id === id);

  switch (action.action) {
    case "diagnose": {
      const ticket = findTicket(action.ticket);
      if (!ticket) {
        return refuse(
          "unknown-ticket",
          `there is no open ticket ${action.ticket}. Open tickets: ${tickets.map((t) => t.id).join(", ") || "none"}. ` +
            `A ticket is opened by the triage when a re-run stops working, not by you on request.`
        );
      }
      if (ticket.diagnosis) {
        return refuse(
          "already-answered",
          `ticket ${ticket.id} has already been answered${ticket.diagnosis.attempts ? ` (${ticket.diagnosis.attempts} time(s))` : ""}. ` +
            `A second diagnosis of the same ticket is the account owner's call (\`diagnose.js --reask\`), not yours. ` +
            `Your moves here are: answer their question, choose an option, or escalate.`
        );
      }
      return { allowed: true, why: null, kind: null };
    }

    case "answer": {
      const ticket = findTicket(action.ticket);
      if (!ticket) {
        return refuse("unknown-ticket", `there is no open ticket ${action.ticket}.`);
      }
      const asked = (ticket.diagnosis && ticket.diagnosis.questions) || [];
      if (!asked.length) {
        return refuse(
          "no-question",
          `ticket ${ticket.id} asked you nothing, so there is nothing to answer. Its options are what you have to work with.`
        );
      }
      const open = unansweredQuestions(ticket);
      if (!open.length) {
        return refuse(
          "already-answered",
          `every question on ticket ${ticket.id} has been answered once already. Each question is answered exactly once: ` +
            "if an answer was wrong or incomplete, say so in the next request for a diagnosis (`diagnose.js --reask`) rather than overwrite it."
        );
      }
      // WHICH question is being answered is part of the decision, not a detail: a ticket can hold
      // several open questions, `recordAnswer` matches one exactly, and `diagnose.js` refuses to guess
      // when there is more than one. Naming it here means the loop can pass the team's own wording
      // through rather than the manager's paraphrase of it.
      let question = null;
      if (action.question) {
        question = open.find((q) => sameQuestion(q, action.question));
        if (!question) {
          if (asked.some((q) => sameQuestion(q, action.question))) {
            return refuse(
              "already-answered",
              `"${action.question}" is already answered on ticket ${ticket.id}. Every question is answered once.`
            );
          }
          return refuse(
            "unknown-question",
            `"${action.question}" is not a question ticket ${ticket.id} asked. It is waiting on: ${open
              .map((q) => `"${q}"`)
              .join(" / ")}.`
          );
        }
      } else if (open.length > 1) {
        return refuse(
          "question-unnamed",
          `ticket ${ticket.id} has ${open.length} open questions, so an answer has to say which one it answers: ${open
            .map((q) => `"${q}"`)
            .join(" / ")}.`
        );
      } else {
        question = open[0];
      }
      // The boundary is checked on the ANSWER, not the question (gotcha 74). Anything in the reply
      // that looks like a path goes through `customerMayRead`, so a manager cannot answer by quoting
      // the code it is not allowed to have read.
      for (const file of pathishWords(String(action.answer))) {
        const read = customerMayRead(file);
        if (!read.allowed) {
          return refuse(
            "cited-forbidden",
            `your answer cites ${file}: ${read.because} Answer from the volume folders, the reports, or the plan of record.`
          );
        }
      }
      return { allowed: true, why: null, kind: null, question };
    }

    case "choose": {
      const ticket = findTicket(action.ticket);
      if (!ticket) return refuse("unknown-ticket", `there is no open ticket ${action.ticket}.`);
      if (!ticket.diagnosis) {
        return refuse("not-answered", `ticket ${ticket.id} has no answer yet, so it has no options. Ask the diagnostics team first.`);
      }
      const option = (ticket.options || []).find((o) => o.id === action.option);
      if (!option) {
        const refused = (ticket.refusedOptions || []).find((r) => r.option.id === action.option);
        if (refused) {
          return refuse(
            "banned-option",
            `option ${action.option} was refused when it was offered: ${refused.because} It goes to ${refused.escalateTo}. ` +
              `The allowed options are: ${(ticket.options || []).map((o) => o.id).join(", ") || "none"}.`
          );
        }
        return refuse(
          "unknown-option",
          `there is no option ${action.option} on ticket ${ticket.id}. The allowed ones are: ${
            (ticket.options || []).map((o) => o.id).join(", ") || "none"
          }.`
        );
      }
      return { allowed: true, why: null, kind: null };
    }

    case "fix": {
      const ticket = findTicket(action.ticket);
      if (!ticket) return refuse("unknown-ticket", `there is no open ticket ${action.ticket}.`);
      if (!ticket.choice) {
        return refuse(
          "not-chosen",
          `ticket ${ticket.id} has no chosen option. You call in the dev team by CHOOSING an option marked ` +
            `"needs the dev team", never by describing a fix.`
        );
      }
      const option = (ticket.options || []).find((o) => o.id === ticket.choice.optionId);
      if (!option || !option.requiresCodeChange) {
        return refuse(
          "option-not-code",
          `the option you chose on ${ticket.id} (${ticket.choice.optionId}) does not require a code change. ` +
            `The dev team is for the options that do.`
        );
      }
      const existing = patches.find((p) => p.ticketId === ticket.id);
      if (existing) {
        return refuse(
          "patch-exists",
          `ticket ${ticket.id} already has patch ${existing.id} (${existing.status}). One team at a time, and an ` +
            `unjudged patch already gates the pipeline. Judge ${existing.id} first.`
        );
      }
      return { allowed: true, why: null, kind: null };
    }

    case "judge": {
      const patch = patches.find((p) => p.id === action.patch);
      if (!patch) {
        return refuse(
          "unknown-patch",
          `there is no patch ${action.patch} waiting for a judgment. Waiting: ${
            patches.filter((p) => UNJUDGED_STATUSES.includes(p.status)).map((p) => p.id).join(", ") || "none"
          }.`
        );
      }
      if (!UNJUDGED_STATUSES.includes(patch.status)) {
        return refuse(
          "already-judged",
          `patch ${patch.id} is ${patch.status}; it has already been decided${
            patch.decision ? ` (${patch.decision.outcome}: ${patch.decision.reason})` : ""
          }. A decision is not re-made.`
        );
      }
      const sound = judgmentReasonIsSound(action.reason);
      if (!sound.ok) {
        return refuse(
          "unsound-reason",
          `that is not a judgment about the patch: it says the complaint stopped, not what the change does. ` +
            `Judge the change — which mechanism it fixes, which deliverable signal it expects to move, what it ` +
            `could break (gotcha 70).`
        );
      }
      return { allowed: true, why: null, kind: null };
    }

    case "escalate": {
      const note = String(action.note || "").trim();
      if (note.length < 20) {
        return refuse(
          "thin-escalation",
          `an escalation has to say what the account owner is being asked to decide, in a sentence they can act ` +
            `on. ${note.length} characters is not that.`
        );
      }
      return { allowed: true, why: null, kind: null };
    }

    case "end": {
      const proof = endIsProvable({ plan, tickets, patches });
      if (!proof.provable) {
        return refuse(
          "end-not-provable",
          `you may not end this run: ${proof.reasons.join("; ")}. "Nothing left to complain about" is not the ` +
            `test — the records are.`
        );
      }
      return { allowed: true, why: null, kind: null };
    }

    default:
      return { allowed: true, why: null, kind: null };
  }
}

// ─── The two claims that have to be proved ────────────────────────────────────

/**
 * Is "the run is finished" provable?
 *
 * Four things, all read out of records this layer already wrote:
 * 1. the triage's own verdict is `nothing-to-do` — every step left what it claims to have, and no
 *    unread gate evidence is lying in a volume folder (gotcha 71: evidence is not damage, but it is
 *    not nothing either);
 * 2. no ticket is open — an unanswered question with the teams is an unfinished piece of work;
 * 3. no patch is unjudged — an unjudged patch is live code in the tree (gotcha 75);
 * 4. the deliverable is clean — no chapter MISSING and no chapter published UNVERIFIED. Every step
 *    can finish while the book is not finished, and `planResume` says so in its notes; a manager that
 *    calls that "done" is reporting a book it never read.
 *
 * `EMPTY IN SOURCE` is deliberately NOT a failure here: a hole in the book is a fact about the
 * source, not a failure of the run (gotcha 40), and refusing to end over it would mean no series with
 * an image-only page could ever be reported as finished.
 *
 * @param {Object} args
 * @param {import("./resume").ResumePlan|null} [args.plan]
 * @param {import("./tickets").Ticket[]} [args.tickets]
 * @param {import("./patches").Patch[]} [args.patches]
 * @returns {{provable: boolean, reasons: string[]}}
 */
function endIsProvable({ plan = null, tickets = [], patches = [] }) {
  const reasons = [];
  if (!plan) {
    return { provable: false, reasons: ["there is no triage to read: the plan of record could not be read"] };
  }
  if (plan.verdict !== "nothing-to-do") {
    reasons.push(
      `the triage's own verdict is "${plan.verdict}"${plan.headline ? ` — ${plan.headline}` : ""}`
    );
  }
  const open = (tickets || []).filter((t) => t.status !== "closed");
  if (open.length) {
    reasons.push(`${open.length} ticket(s) still open: ${open.map((t) => `${t.id} (${t.status})`).join(", ")}`);
  }
  const unjudged = (patches || []).filter((p) => UNJUDGED_STATUSES.includes(p.status));
  if (unjudged.length) {
    reasons.push(`${unjudged.length} patch(es) in the working tree without your judgment: ${unjudged.map((p) => `${p.id} (${p.status})`).join(", ")}`);
  }
  const d = plan.deliverable;
  if (d && d.counts) {
    const c = d.counts;
    if (c.missing) reasons.push(`${c.missing} chapter(s) MISSING from the published book`);
    if (c.unverified) reasons.push(`${c.unverified} chapter(s) published UNVERIFIED`);
  }
  return { provable: reasons.length === 0, reasons };
}

/**
 * A patch this loop may accept without a human.
 *
 * The account owner's decision of 2026-10-06: an unattended run may accept a patch on its own when
 * the change is **ordinary project code**, the **pinned checks are green**, and the deliverable does
 * not regress. Anything else stops and waits. This is that boundary, written as data.
 *
 * What the banned-path table already guarantees (guard tables, their tests, `hooks/`, `.env`, the
 * machine state, the corpus, anything outside `ai-client/`) is assumed here and not re-litigated.
 * What it does NOT cover is the rest of what judges this pipeline, and those are the entries below:
 * a patch that edits the thresholds, the sandbox, the runner, or a test is a patch that changed the
 * evidence its own acceptance rests on — and `npm test` going green afterwards proves nothing,
 * because the test is now the one the patch wrote.
 *
 * @typedef {Object} AutoAcceptVerdict
 * @property {boolean} safe
 * @property {string[]} reasons - Every reason it is NOT safe (empty when safe).
 * @property {string[]} notes - What was checked, so a report can show the basis of an unattended accept.
 */

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

/**
 * @param {string} file - A declared patch path (project-relative).
 * @returns {{id: string, because: string}|null}
 */
function notOrdinaryCode(file) {
  const text = String(file || "").replace(/\\/g, "/").replace(/^\.\/+/, "");
  for (const rule of NOT_ORDINARY_CODE) {
    if (rule.pattern.test(text)) return rule;
  }
  return null;
}

/**
 * @param {import("./patches").Patch} patch
 * @param {{outcome: string, regressions: Array<{name: string, from: number|null, to: number|null}>}|null} [comparison]
 *   The before/after measurement of the deliverable, when one exists (the cascade that ran after the
 *   patch landed, or a re-verify). Produced by `compareDeliverable` in `utils/delivery-verify.js`.
 * @returns {AutoAcceptVerdict}
 */
function safeToAcceptAutomatically(patch, comparison = null) {
  const reasons = [];
  const notes = [];
  if (!patch) return { safe: false, reasons: ["there is no patch to judge"], notes };

  // 1. The pinned checks ran, and passed. "The team says it ran them" is not this — the harness
  //    gives an agent no shell, so the machine ran them or they did not happen (gotcha 75).
  const verdict = patch.checkVerdict;
  if (!verdict || !verdict.accepted) {
    if (verdict && verdict.missing.length) reasons.push(`the pinned checks never ran: ${verdict.missing.join(", ")}`);
    if (verdict && verdict.failed.length) reasons.push(`a pinned check failed: ${verdict.failed.join(", ")}`);
    if (!verdict) reasons.push("the pinned checks have never been run on this patch");
  } else {
    notes.push(`pinned checks green: ${(patch.checks || []).map((c) => `${c.id} exit ${c.exitCode}`).join(", ")}`);
  }

  // 2. Ordinary project code: inside the project whitelist, outside the banned table, and not one of
  //    the things that judge the patch.
  const files = patch.files || [];
  if (!files.length) reasons.push("the patch declares no files, so there is nothing to attribute it to");
  const banned = patchTouchesBanned(files);
  for (const b of banned) reasons.push(`it touches a banned path (${b.file}): ${b.because}`);
  for (const f of files) {
    if (!isProjectSourcePath(f)) reasons.push(`${f} is not project source`);
    const notOrdinary = notOrdinaryCode(f);
    if (notOrdinary) reasons.push(`${f} is not ordinary code (${notOrdinary.id}): ${notOrdinary.because}`);
  }
  if (!reasons.length && files.length) notes.push(`${files.length} ordinary project file(s): ${files.join(", ")}`);

  // 3. The team's own claims are complete enough for a role that cannot read the diff to judge them.
  //    A warning on a patch is this module saying "the evidence here is thinner than it looks" —
  //    which is exactly the situation that should not be decided unattended.
  if (patch.warnings && patch.warnings.length) {
    for (const w of patch.warnings) reasons.push(`the patch carries a warning: ${w.message || w.kind}`);
  }
  if (String(patch.summary || "").trim().length < 60) {
    reasons.push("the summary is too short for a role that cannot read the diff to judge on");
  }
  if (!patch.expected || !patch.expected.length) {
    reasons.push("the patch names no deliverable signal it expects to move, so nothing measurable was claimed");
  }

  // 4. The team escalated in prose. `ownerNote` is where "I believe the guard is wrong" belongs, and a
  //    team that wrote one has already said this is the account owner's decision (gotcha 70/74).
  if (String(patch.ownerNote || "").trim()) {
    reasons.push("the team wrote an ownerNote, which is a route to the account owner, not to an auto-accept");
  }
  if (patch.questions && patch.questions.length) {
    reasons.push(`the team asked ${patch.questions.length} question(s) back, so the change is not settled`);
  }

  // 5. No deliverable regression — when a measurement exists. At judgment time it usually does not:
  //    the real before/after comes from the cascade that runs AFTER the patch is accepted, and the
  //    loop must report that outcome rather than assume it (see autopilot.js).
  if (comparison && comparison.outcome === "worse") {
    reasons.push(
      `the deliverable measured WORSE against this patch: ${(comparison.regressions || [])
        .map((m) => `${m.name} ${m.from} → ${m.to}`)
        .join("; ")}`
    );
  } else if (comparison) {
    notes.push(`deliverable measured ${comparison.outcome}`);
  }

  return { safe: reasons.length === 0, reasons, notes };
}

// ─── The call ─────────────────────────────────────────────────────────────────

/**
 * Ask the manager for the next move.
 *
 * One tool-less `runOneShot`, wrapped in `runTurnWithHooks(MANAGER_TASK, …)` so `pre-manager` fires
 * before it and `post-manager` after: the guarantee that the manager's model is the one serving is
 * the role's, not the caller's (AGENTS.md §3 "Pipeline hooks"). It samples like a grader —
 * `JUDGE_TEMPERATURE` + `STAGE_THINKING_LEVEL` — because a decision is a judgment over records that
 * are already on disk, not a document being written (gotcha 59).
 *
 * @param {Object} args
 * @param {import("./resume").ResumePlan} args.plan
 * @param {ManagerMove[]} args.moves
 * @param {import("./tickets").Ticket[]} [args.tickets]
 * @param {import("./patches").Patch[]} [args.patches]
 * @param {(line: string) => void} [args.log]
 * @returns {Promise<{ok: boolean, action: ManagerAction|null, problems: Object[], warnings: Object[], reply: string, refusal: string|null, kind: string|null, maxTokens: number}>}
 */
async function managerDecision({ plan, moves, tickets = [], patches = [], log = (line) => console.log(line) }) {
  const brief = renderManagerBrief({ plan, moves, tickets, patches });
  const maxTokens = managerMaxTokens();
  log(
    `asking the delivery manager (${brief.length} characters of state, ${moves.length} offered move(s), ` +
      `reply cap ${maxTokens})…`
  );

  const dialect = judgeThinking("MANAGER");
  let reply;
  try {
    reply = await runTurnWithHooks(MANAGER_TASK, () =>
      harness.runOneShot({
        systemPrompt: null,
        messages: [{ text: brief }],
        temperature: judgeTemperature(),
        thinking: dialect.thinking,
        thinkingLevel: dialect.thinkingLevel,
        maxTokens,
        label: "delivery-manager",
      })
    );
  } catch (err) {
    // A manager call that died is not a decision. The most likely cause on this machine is the wrong
    // container serving (every container advertises the same model id — gotcha 22), and the tell for
    // it is an empty or absent answer, so the refusal has to name that suspicion out loud.
    return {
      ok: false,
      action: null,
      problems: [],
      warnings: [],
      reply: "",
      refusal:
        `the manager call failed: ${err.message}. If the answer was empty, suspect the wrong model ` +
        `container serving: every container on this machine advertises the same model id, and the only ` +
        `record of which one the \`pre-manager\` hook started is hooks/.model-switch-state.`,
      kind: "call-failed",
      maxTokens,
    };
  }

  const parsed = parseManagerAction(reply);
  if (!parsed.action) {
    return {
      ok: false,
      action: null,
      problems: parsed.problems,
      warnings: parsed.warnings,
      reply,
      refusal: parsed.problems.map((p) => p.message).join(" | "),
      kind: parsed.problems[0] ? parsed.problems[0].kind : "unparseable",
      maxTokens,
    };
  }

  const gate = validateManagerAction(parsed.action, { moves, tickets, patches, plan });
  if (!gate.allowed) {
    return {
      ok: false,
      action: parsed.action,
      problems: [{ kind: gate.kind, message: gate.why }],
      warnings: parsed.warnings,
      reply,
      refusal: gate.why,
      kind: gate.kind,
      maxTokens,
    };
  }

  return {
    ok: true,
    action: parsed.action,
    problems: [],
    warnings: parsed.warnings,
    reply,
    refusal: null,
    kind: null,
    maxTokens,
  };
}

module.exports = {
  MANAGER_ACTIONS,
  ACTION_MENU_ENTRIES,
  MANAGER_RULES,
  NOT_ORDINARY_CODE,
  managerMaxTokens,
  renderTicketForManager,
  renderPatchForManager,
  renderManagerBrief,
  extractActionJson,
  parseManagerAction,
  pathishWords,
  validateManagerAction,
  endIsProvable,
  safeToAcceptAutomatically,
  notOrdinaryCode,
  managerDecision,
};
