/**
 * utils/diagnostics.js — the diagnostics team: the role that CAN see the code.
 *
 * The delivery manager (delivery.js, utils/resume.js) is a *customer* of this pipeline: it reads
 * reports and deliverables, it may re-run steps, and it never reads a `.js`, a prompt or a
 * transcript. When re-running stops working it opens a ticket (utils/tickets.js). This module is
 * the other side of that ticket — the support team that is handed the whole machine: the code, the
 * prompts, the run transcripts in `.logs/**`, and every artifact.
 *
 * The analogy the account owner chose (plan §2, 2026-10-05): the manager is a tightly-integrated
 * SaaS **client**; diagnostics and the dev team are the **provider**. A provider with a support
 * contract reads its own logs, explains the cause, offers options with their costs, recommends one,
 * and asks the client clarifying questions back — and the client answers only from what it can see.
 *
 * Three rules make that safe, and each one is enforced in code rather than written in a prompt:
 *
 *   1. **Read-only, enforced twice.** The agent is handed only the three read tools, so it is never
 *      tempted to reach for a write (gotcha 8: advertising a tool the sandbox will refuse wastes a
 *      capped step on the model discovering that fact). And the approve gate refuses every mutating
 *      call anyway, as the backstop — exactly the `withoutDeleteFile` + kept-refusal pattern. A
 *      refusal is **recorded** and reaches the ticket and the human-readable report: a silently
 *      dropped write attempt is a diagnostics team that quietly tried to fix the data.
 *   2. **The options are filtered on this side of the conversation.** `utils/tickets.js` refuses
 *      banned options when they are offered, not when they are chosen, because a manager given a
 *      menu picks the cheap item on it (gotcha 70). So a diagnosis reaches a ticket through
 *      `recordDiagnosis`, which runs the filter internally — there is no path from a model reply to
 *      a ticket that skips it.
 *   3. **A diagnosis shows its reading.** The turn's real tool calls are recorded next to the files
 *      the reply *claims* it read, and a claim the turn never made is reported. "The guard reads
 *      only the first column" is a fact about a file; if nobody opened the file, it is a guess.
 *
 * What it deliberately does NOT do: it does not fix anything. It has no write access, and the role
 * that changes a file is the dev team (plan §5, Phase 6). A diagnosis ends as options on a ticket.
 *
 * Cost (plan §9): the deterministic post-mortem is the free tier, and only what it flags is worth a
 * model call. A ticket is exactly that flag — it exists because re-running already failed twice.
 * The turn is UNCAPPED and keeps its own working window by setting its old read answers aside on disk
 * (see the note below `DIAGNOSIS_COSTS`, and `utils/context.js`): what bounds it is the repetition
 * detector and the turn clock, not a step count, because a step count is what made the diagnosis this
 * role actually ran answer with nothing.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const harness = require("../harness");
const { assertRealToolCalls, turnShapeOf } = require("./agents");
const { extractJsonObject } = require("./manifest");
const { fingerprintFiles } = require("./fs");
const tickets = require("./tickets");
const { runTurnWithHooks, MANAGER_TASK } = require("./hooks");
const { readTickets, ticketPaths, recordDiagnosis } = tickets;

const ROOT = path.join(__dirname, "..");
const SYSTEM_PROMPT_FILE = path.join(ROOT, "system-prompts", "diagnostics.md");

/**
 * The tools a mutating agent could reach for. `deleteFile` is never offered by the harness at all
 * (gotcha 8); it is listed here so the gate names it if a future library version injects it.
 */
const MUTATING_TOOL_NAMES = ["writeFile", "editFile", "deleteFile"];

/** The whole tool set the diagnostics role is advertised: senses, no hands. */
const READ_TOOL_NAMES = ["readFile", "listFiles", "grep"];

/** The sentence the model sees when the gate refuses, and the sentence the ticket records. */
const READ_ONLY_REFUSAL =
  "the diagnostics role has no write access — it explains and offers options; the dev team is the " +
  "only role that changes a file, and the account owner is the only role that un-checks a guard";

/** The three cost words an option may use. Free/cheap/expensive, not a token figure a guess invented. */
const DIAGNOSIS_COSTS = ["free", "cheap", "expensive"];

/**
 * This role has NO step cap and no token budget, on purpose (CONTEXT-MANAGEMENT-DESIGN.md §7.1).
 * The old cap (3 steps per 32 KB page, ceiling 120) was the shape of the failure this role actually
 * had: a 73-call, 7.2M-token diagnosis that spent its last 39 steps re-opening the same file because
 * its transcript had grown past what the server would accept, and answered with nothing. A cap cannot
 * fix that — it only decides how early the turn dies. What bounds this turn instead: the repetition
 * detector (the same call, the same answer, three times = it is spinning, stop it), the turn clock
 * (`AGENT_TURN_MAX_MS`, a wall not a budget), and the offload store that lets a long read stay
 * available after it leaves the working window (`utils/context.js`).
 */

/**
 * @typedef {Object} DiagnosisOption
 * @property {string} label - What the option is, in one line the manager can repeat.
 * @property {string[]} touches - The files or settings it changes. Required: an option that does
 *   not say what it touches is not arguable.
 * @property {("free"|"cheap"|"expensive")} cost - One of DIAGNOSIS_COSTS.
 * @property {string} risk - What it could break.
 * @property {string} verify - How the manager checks it worked — which is where "the finding
 *   disappears" gets flagged, because that answer is available for free (gotcha 70/73).
 * @property {boolean} [requiresCodeChange] - True when only the dev team can carry it out.
 * @property {string} [id] - Assigned by `attachOptions` (utils/tickets.js).
 * @property {boolean} [outcomeOnlyVerification] - Stamped by `filterOptions` (utils/tickets.js) when
 *   `verify` names only the finding vanishing. NOT a refusal — see the deliberate split below.
 */

/**
 * @typedef {Object} Diagnosis
 * @property {string} cause - The mechanism, in plain language.
 * @property {DiagnosisOption[]} options
 * @property {string} [recommend] - The label of one option, plus why.
 * @property {string[]} [questions] - Clarifying questions back to the manager. Each must be
 *   answerable by someone who can only see the book and the reports.
 * @property {string[]} [read] - The files the team says it read. Cross-checked against the turn's
 *   real tool calls; a claim the turn never made is reported.
 * @property {string} [ownerNote] - Prose for the account owner alone. This is where "I actually
 *   believe the guard is wrong" belongs, because that is not an option the manager may choose.
 */

/**
 * The reply contract, as data — so a refusal can name the field that is missing instead of saying
 * "malformed". Same shape of idea as `validateTicketShape` on the manager's side of the channel.
 */
const DIAGNOSIS_CONTRACT = [
  {
    field: "cause",
    required: true,
    why:
      "the mechanism that produced the finding, in language a customer can follow. A diagnosis " +
      "with no cause is a list of options, which is what a manager can already do for free.",
  },
  {
    field: "options",
    required: true,
    why:
      "at least one, each with label / touches / cost / risk / verify. An option that does not say " +
      "what it touches or how to check it cannot be judged by anyone who has not read the code.",
  },
  { field: "recommend", required: false, why: "which option, and why — the part a provider owes a client." },
  {
    field: "questions",
    required: false,
    why:
      "what the team needs from the manager. Ask something a customer can answer: what the book " +
      "looks like, what the owner intended, which report said what. Never 'what does this function " +
      "do' — the manager cannot read it.",
  },
  {
    field: "read",
    required: false,
    why:
      "the files actually opened. Recorded against the turn's real tool calls either way, so this " +
      "is the team's chance to point at its evidence, not the evidence itself.",
  },
  {
    field: "ownerNote",
    required: false,
    why:
      "if the right answer is something the manager may not be offered — un-checking a guard, " +
      "changing a threshold — say it here, in prose, for the account owner. It is not an option.",
  },
];

/**
 * Questions only a code reader can answer. The manager's answers are checked against what a
 * customer may read (utils/tickets.js `customerMayRead`); a question that cannot be answered from
 * there is refused here, at the generator, so the conversation does not stall on a question nobody
 * in the manager's role can reply to.
 *
 * Honest about what this is: a shape check. It catches the forms such a question actually takes.
 */
const CODE_ONLY_QUESTION = [
  { pattern: /\b(?:what|how|which|where)\b[^\n]{0,40}\b(?:code|source|function|method|module|implementation|internals?)\b/i, because: "the manager cannot read the code" },
  { pattern: /\b(?:code|function|method|module|source file)\b[^\n]{0,40}\b(?:does|says|contains|implements|defines)\b/i, because: "the manager cannot read the code" },
  { pattern: /\bshow (?:me )?(?:the|your) (?:code|source|diff|patch)\b/i, because: "the manager cannot read a diff" },
  { pattern: /\.(js|ts)\b/i, because: "the manager may not open a source file" },
  { pattern: /\b(?:system|user)-prompts\//i, because: "the manager may not open a prompt file" },
  { pattern: /\.logs\//i, because: "the run transcripts belong to the diagnostics team, not to the manager" },
  { pattern: /\b(?:read|open|look at|check)\b[^\n]{0,30}\b(?:the |that )?(?:source|code|\.js file)\b/i, because: "the manager cannot open it" },
];

/**
 * The tool note appended to the system prompt in code (the convention: prompt files stay
 * mode-agnostic, mode-specific text is appended here). It promises exactly the tools the role has —
 * the mistake `AGENT_TOOLS_NOTE` cannot be reused for is that it promises five and demands writing.
 *
 * It names the two memory tools the harness adds for this role (`manage_context` / `recall_memory`,
 * `utils/context.js`) because a tool the agent was never told about is a tool it does not use, and
 * this role's failure was exactly that: a 73-call turn that kept re-opening the same file because it
 * had no way to put an old read down. The working-window line is described here too — it is printed
 * on every tool answer, and an agent that does not know what it means ignores it.
 */
const DIAGNOSIS_TOOLS_NOTE = `

## Your tools (read-only — this is not a suggestion)

You have three senses and two memory tools, and nothing else: \`readFile(filePath)\`,
\`listFiles(dirPath)\`, \`grep(pattern, dirPath, glob?, ignoreCase?)\`, \`manage_context(note?)\` and
\`recall_memory(query, limit?)\`.
There is no writeFile, no editFile, no deleteFile. You cannot create, change or remove a file, and
the sandbox refuses the attempt rather than ignoring it — an attempt is recorded on the ticket.

- \`grep\` and \`listFiles\` take a FOLDER, not a file. To search one file, pass its folder and use
  \`glob\` as a filename ENDING (\`".md"\`, not \`"*.md"\` — a wildcard matches nothing).
- \`readFile\` takes a file. A cumulative artifact may be long: read the part you need, or grep for
  the span, instead of paging through a whole document.
- You may read anywhere in the project: the code, the prompts, the run transcripts under \`.logs/\`,
  every artifact, and the reports in \`.postmortem/\`.

## Your working window (read this before you read anything)

You have no step limit: this turn ends when you answer, when you start repeating yourself, or when
the clock runs out. What DOES run out is how much text you can hold in mind at once, and every tool
answer ends with a line saying how full that is:

\`| working window: 57,500 / 262,144 tokens (22%)\`

- **getting full** — call \`manage_context()\` BEFORE your next read. It sets aside the oldest read
  answers and leaves a note of where they went, so the turn can keep going.
- **FULL** — call it immediately. The next read is at risk of being cut off.
- Setting a read aside is not forgetting it. \`recall_memory("a phrase from it")\` searches everything
  this turn has set aside and brings back the matching part, named with the file it came from. Recall
  it instead of opening the whole file again.

Work in one pass: grep to locate, read what you located, then answer. Do not re-read a file you have
already read — if you cannot recall what it said, search what you set aside.`;

/**
 * Build the read-only tool set and its gate.
 *
 * Two layers, both load-bearing (gotcha 8's pattern, applied to writes): the advertised set has no
 * mutating tool, so the model is never offered a promise the sandbox will not keep; and the gate
 * refuses every mutating call anyway, so a tool injected by a future library version, or a caller
 * that composes its own set, still hits the wall. The refusal is RECORDED — a dropped attempt is a
 * diagnostics team that quietly tried to repair the data, and the account owner is the only reader
 * who would never find out.
 *
 * @param {Object} cfg
 * @param {string} cfg.cwd - The agent's working directory (the project root: it reads the code).
 * @param {string} cfg.allowedDirs - Folders the underlying fs gate would allow writes to. Irrelevant
 *   to the outcome (every write is refused) but required by `createGatedFsTools`, and kept narrow so
 *   the backstop gate is the only thing doing the work.
 * @returns {Promise<{tools: Object, approve: Function, refusals: Object[], advertised: string[], dropped: string[]}>}
 */
async function readOnlyFsTools({ cwd = ROOT, allowedDirs = [ROOT] }) {
  const { tools, approve: fsApprove } = await harness.createGatedFsTools({ cwd, allowedDirs });

  /** @type {Array<{tool: string, path: string, reason: string, at: string}>} */
  const refusals = [];

  const approve = (call) => {
    const toolName = call && call.toolName;
    if (MUTATING_TOOL_NAMES.includes(toolName)) {
      const input = (call && call.input) || {};
      const target = input.filePath || input.dirPath || input.path || "(no path given)";
      refusals.push({ tool: toolName, path: target, reason: READ_ONLY_REFUSAL, at: new Date().toISOString() });
      harness.logLine(`  [diagnostics] REFUSED ${toolName} on ${target}: ${READ_ONLY_REFUSAL}.`);
      return false;
    }
    // Reads go through the harness gate unchanged (it allows reads anywhere, refuses archives).
    return fsApprove(call);
  };

  const advertised = {};
  for (const name of READ_TOOL_NAMES) {
    if (tools && tools[name]) advertised[name] = tools[name];
  }
  const dropped = Object.keys(tools || {}).filter((name) => !READ_TOOL_NAMES.includes(name));

  return { tools: advertised, approve, refusals, advertised: Object.keys(advertised), dropped };
}

/**
 * Read the system prompt for the role. Fails loudly rather than diagnosing with no brief: a support
 * team with no instructions answers with a guess.
 * @returns {string}
 */
function loadSystemPrompt() {
  let text;
  try {
    text = fs.readFileSync(SYSTEM_PROMPT_FILE, "utf8");
  } catch (err) {
    throw new Error(
      `diagnostics: cannot read ${SYSTEM_PROMPT_FILE} (${err.code || err.message}). ` +
        `The diagnostics role's brief is not optional.`
    );
  }
  if (!text.trim()) throw new Error(`diagnostics: ${SYSTEM_PROMPT_FILE} is empty.`);
  return text;
}

/**
 * The turn's input: the ticket, and nothing else.
 *
 * The evidence is named by path, not inlined. This role's whole advantage over the manager is that
 * it can open those files itself; inlining them would pay for a copy of something it is about to
 * read anyway, and would quietly replace "it read the evidence" with "it was told about it".
 *
 * @param {import("./tickets").Ticket} ticket
 * @param {{seriesDir: string, root: string}} where
 * @returns {string}
 */
function renderTicketForDiagnosis(ticket, { seriesDir, root }) {
  const lines = [
    `## Ticket ${ticket.id}`,
    ``,
    `Step: ${ticket.step}${ticket.volume ? ` | volume: ${ticket.volume}` : ""} | finding: ${ticket.finding}`,
    ``,
    `**The question being asked:**`,
    ticket.question,
    ``,
    `**What the manager saw** (it reads reports and deliverables, never code):`,
    ...(ticket.evidence || []).map((e) => `- \`${e.file}\` — ${e.note}`),
  ];
  if ((ticket.tried || []).length) {
    lines.push(``, `**What has already been tried** (copied out of the run ledger, so it is a record, not a claim):`);
    for (const t of ticket.tried) {
      lines.push(`- ${t.action}${t.volume ? ` (volume ${t.volume})` : ""} → ${t.outcome || "no outcome recorded"}${t.ledgerId ? ` (${t.ledgerId})` : ""}`);
    }
  }
  if ((ticket.ruledOut || []).length) {
    lines.push(``, `**What the manager ruled out:**`);
    for (const r of ticket.ruledOut) lines.push(`- ${r}`);
  }

  lines.push(
    ``,
    `**Where to look:**`,
    `- the series folder: \`${seriesDir}\``,
    `- the step reports and the run ledger: \`${path.relative(root, ticketPaths().json).replace(/[\\/]+$/, "")}\`'s folder`,
    `- the run transcripts (full chat histories, tool calls and their results, streaming dumps): \`.logs/\``,
    `- the code and the prompts: \`ai-client/\` (this project's root is \`${root}\`)`,
    ``,
    `Answer with the JSON object described in your brief. Every option must name what it touches,`,
    `what it costs, what it could break, and how the manager should verify it afterwards.`,
    `The manager cannot read code, prompts or transcripts — so anything you want it to check must be`,
    `something it can see: a folder listing, a term count, a report, the published text.`
  );
  return lines.join("\n");
}

/**
 * Parse the reply under the contract. Fail-closed, like the acceptance replies: an answer that
 * cannot be read is not an empty diagnosis, it is a failed check (gotcha 7).
 *
 * @param {string|null} text - The agent turn's final text.
 * @returns {{diagnosis: Diagnosis|null, problems: Array<{kind: string, message: string}>}}
 */
function parseDiagnosisReply(text) {
  if (typeof text !== "string" || !text.trim()) {
    return {
      diagnosis: null,
      problems: [
        {
          kind: "empty-reply",
          message:
            "the diagnostics turn produced no answer. The turn's tool calls are still in the run " +
            "log under .logs/ — read them before re-asking, because a turn that ran out of steps " +
            "while reading is a different problem from a turn that answered nothing.",
        },
      ],
    };
  }

  // Prefer the LAST fenced JSON block: a real answer reasons in prose first and puts the machine-
  // readable part at the end. extractJsonObject takes first-{ to last-}, which mangles a reply that
  // quotes a JSON example inside its prose.
  let raw = null;
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)]
    .map((m) => m[1])
    .filter((block) => block.trim().startsWith("{"));
  for (let i = fences.length - 1; i >= 0 && raw === null; i -= 1) {
    try {
      raw = JSON.parse(fences[i].trim());
    } catch {
      /* try the previous block */
    }
  }
  if (raw === null) {
    try {
      raw = extractJsonObject(text);
    } catch (err) {
      return {
        diagnosis: null,
        problems: [
          {
            kind: "unparseable",
            message:
              `the reply does not contain the JSON object the brief asks for (${err.message}). ` +
              `Write the answer as one fenced \`\`\`json block with cause / options / recommend / ` +
              `questions / read. Prose alone is not a diagnosis another program can act on.`,
          },
        ],
      };
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      diagnosis: null,
      problems: [{ kind: "not-an-object", message: "the reply parsed as something other than one JSON object." }],
    };
  }
  return { diagnosis: raw, problems: [] };
}

/**
 * Is this option's stated check "the finding disappears"?
 *
 * The rule lives in `utils/tickets.js` (see `OUTCOME_ONLY_CHECK` there for why it is a FLAG and not
 * a refusal), because `attachOptions` stamps it on the option as it enters the ticket. It is
 * re-exported here so the diagnosis validator can warn about the same shape the ticket records.
 */
const verificationIsOutcomeOnly = tickets.verificationIsOutcomeOnly;

/**
 * Can this question be answered by someone who may only read the book and the reports?
 * @param {string} question
 * @returns {{answerable: boolean, because: string|null}}
 */
function questionIsAnswerableByCustomer(question) {
  const text = String(question || "");
  for (const rule of CODE_ONLY_QUESTION) {
    const hit = text.match(rule.pattern);
    if (hit) return { answerable: false, because: rule.because, matched: hit[0] };
  }
  return { answerable: true, because: null };
}

/**
 * Check a parsed diagnosis against the contract.
 *
 * Problems refuse the reply; warnings are recorded on the ticket. The distinction matters: an
 * unparseable or fieldless reply is not a diagnosis and must not reach the manager as one, while an
 * option whose only check is "the finding disappears" is a legitimate option that the acceptance
 * test — not this filter — is supposed to reject (gotcha 70/73). Silently dropping it here would be
 * the bug this codebase keeps getting told about.
 *
 * @param {Diagnosis} diagnosis
 * @returns {{ok: boolean, diagnosis: Diagnosis, problems: Array<{kind: string, message: string}>, warnings: Array<{kind: string, message: string}>}}
 */
function validateDiagnosisShape(diagnosis) {
  const problems = [];
  const warnings = [];

  if (!diagnosis || typeof diagnosis !== "object") {
    return { ok: false, diagnosis: null, problems: [{ kind: "no-diagnosis", message: "nothing to validate." }], warnings };
  }

  const cause = typeof diagnosis.cause === "string" ? diagnosis.cause.trim() : "";
  if (!cause) {
    problems.push({
      kind: "no-cause",
      message:
        `a diagnosis must state the cause: the mechanism that produced this finding, in language a ` +
        `customer can follow. ${DIAGNOSIS_CONTRACT[0].why}`,
    });
  } else if (cause.length < 60) {
    warnings.push({
      kind: "thin-cause",
      message: `the cause is ${cause.length} characters. Name the mechanism, not the label — "the guard fired" is the finding, restated.`,
    });
  }

  const rawOptions = Array.isArray(diagnosis.options) ? diagnosis.options : [];
  if (!rawOptions.length) {
    problems.push({
      kind: "no-options",
      message:
        "a diagnosis must offer at least one option, each with label / touches / cost / risk / verify. " +
        "If the honest answer is 'nothing the manager can do', say that in ownerNote and offer the " +
        "escalation as the option.",
    });
  }

  /** @type {DiagnosisOption[]} */
  const options = [];
  rawOptions.forEach((raw, index) => {
    const label = raw && typeof raw.label === "string" ? raw.label.trim() : "";
    const touches = Array.isArray(raw && raw.touches) ? raw.touches.map((t) => String(t).trim()).filter(Boolean) : [];
    const cost = raw && typeof raw.cost === "string" ? raw.cost.trim().toLowerCase() : "";
    const risk = raw && typeof raw.risk === "string" ? raw.risk.trim() : "";
    const verify = raw && typeof raw.verify === "string" ? raw.verify.trim() : "";
    const missing = [];
    if (!label) missing.push("label");
    if (!touches.length) missing.push("touches");
    if (!DIAGNOSIS_COSTS.includes(cost)) missing.push("cost");
    if (!risk) missing.push("risk");
    if (!verify) missing.push("verify");
    if (missing.length) {
      problems.push({
        kind: "option-incomplete",
        message:
          `option ${index + 1}${label ? ` ("${label}")` : ""} is missing ${missing.join(", ")}. ` +
          `Every option must say what it touches, what it costs (${DIAGNOSIS_COSTS.join(" / ")}), ` +
          `what it could break, and how the manager verifies it afterwards.`,
      });
      return;
    }
    /** @type {DiagnosisOption} */
    const option = {
      label,
      touches,
      cost,
      risk,
      verify,
      requiresCodeChange: Boolean(raw.requiresCodeChange),
    };
    if (verificationIsOutcomeOnly(verify)) {
      option.outcomeOnlyVerification = true;
      warnings.push({
        kind: "outcome-only-verification",
        message:
          `option "${label}" offers "the finding disappears" as its only check. That answer is ` +
          `available for free — switching a check off moves every report that names the finding ` +
          `(gotcha 73). It is NOT refused here: rejecting it is the job of the before/after ` +
          `comparison of the deliverable (utils/delivery-verify.js), which is the only thing in ` +
          `this codebase that can tell "the book got better" from "the complaint stopped".`,
      });
    }
    options.push(option);
  });

  const questions = Array.isArray(diagnosis.questions) ? diagnosis.questions.map((q) => String(q).trim()).filter(Boolean) : [];
  for (const q of questions) {
    const verdict = questionIsAnswerableByCustomer(q);
    if (!verdict.answerable) {
      problems.push({
        kind: "unanswerable-question",
        message:
          `the question "${q}" can only be answered by someone who can read ${verdict.matched}. ` +
          `The manager may read the plan of record, what each volume folder holds, the step reports, ` +
          `the ledger and the publish report — nothing else. Ask about the book, the reports, or what ` +
          `the account owner intended.`,
      });
    }
  }

  const read = Array.isArray(diagnosis.read) ? diagnosis.read.map((r) => String(r).trim()).filter(Boolean) : [];
  if (!read.length) {
    warnings.push({
      kind: "no-reading-cited",
      message:
        "the reply names no file it read. The turn's real tool calls are recorded anyway, so this " +
        "only costs the reader the trail — cite the files your conclusion came from.",
    });
  }

  const recommend = typeof diagnosis.recommend === "string" ? diagnosis.recommend.trim() : "";
  if (recommend && options.length && !options.some((o) => recommend.includes(o.label))) {
    warnings.push({
      kind: "recommendation-names-nothing",
      message:
        `the recommendation ("${recommend}") does not name any offered option. Recommend one of the ` +
        `labels you listed, or say plainly that none of them is worth the manager's time.`,
    });
  }

  const out = { ...diagnosis, cause, options, questions, read, recommend };
  return { ok: problems.length === 0, diagnosis: out, problems, warnings };
}

/**
 * Normalise a path for comparing a claimed read against an observed tool call.
 * @param {string} p
 * @returns {string}
 */
function normalizeReadPath(p) {
  return String(p || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
}

/**
 * Cross-check the files the reply claims it read against the files the turn actually opened.
 *
 * The point is the direction that matters: a diagnosis that cites a file nobody opened is a guess
 * wearing the shape of evidence. (The other direction — a read the reply forgot to mention — is
 * harmless, so it is reported as information, not as a fault.)
 *
 * Two rules keep the check from accusing an honest turn:
 *   - a `grep`/`listFiles` call names a FOLDER and reads everything in it, so it covers a claim
 *     about a file inside that folder;
 *   - a call that ERRORED covers nothing. "I searched it and the search failed" is not reading, and
 *     counting it would let a reply cite a file it only managed to fail to open.
 *
 * And a third, because this role now sets its old reads aside instead of holding them: a
 * `recall_memory` call covers the file its match came from. Setting a read down and bringing the
 * sentence back is reading, not guessing.
 *
 * @param {string[]} claimed - The reply's `read` list.
 * @param {Array<{name: string, input: Object, output: *, error: string|null}>} observed - The turn's tool calls.
 * @returns {{observed: Array<{tool: string, path: string, errored?: boolean}>, unsupported: string[], unmentioned: string[]}}
 */
function crossCheckReads(claimed, observed) {
  const opened = (observed || [])
    .filter((call) => READ_TOOL_NAMES.includes(call.name))
    .map((call) => ({
      tool: call.name,
      // `readFile` names a file; `grep`/`listFiles` name a FOLDER and walk it (gotcha 60). The two
      // cover different claims, and treating them the same is how a honest diagnosis gets accused.
      path: normalizeReadPath((call.input && (call.input.filePath || call.input.dirPath || call.input.pattern)) || ""),
      scopedToFolder: !call.input?.filePath,
      errored: Boolean(call.error),
    }));

  // What the turn can prove it saw: a file it opened whole, and every file inside a folder it
  // searched or listed. A call that ERRORED proves nothing — "I grepped it and the grep died" is not
  // reading, and counting it would let a diagnosis cite a file it only failed to open.
  const files = new Set(opened.filter((o) => !o.errored && !o.scopedToFolder).map((o) => o.path));
  const folders = new Set(
    opened.filter((o) => !o.errored && o.scopedToFolder && o.path).map((o) => o.path)
  );

  // A `recall_memory` call IS reading. This role now sets its old read answers aside on disk instead
  // of holding them, and a recall brings the text back with the file it came from recorded on the
  // match. Without this rule the new memory tools would manufacture gotcha 74's exact false
  // positive: a diagnosis that read `utils/glossary.js`, set it aside, recalled the sentence it
  // needed, and cited the file would be reported as citing something it never opened.
  const recalled = [];
  const recalledPaths = new Set();
  for (const call of observed || []) {
    if (call.name !== "recall_memory" || call.error) continue;
    for (const p of recalledSourceFiles(call.output)) {
      const path = normalizeReadPath(p);
      if (!path || recalledPaths.has(path)) continue;
      recalledPaths.add(path);
      recalled.push({ tool: "recall_memory", path });
    }
  }

  const covers = (p) =>
    files.has(p) ||
    recalledPaths.has(p) ||
    [...folders].some((f) => f === "." || f === "" || p.startsWith(`${f}/`));

  const claimedSet = new Set((claimed || []).map(normalizeReadPath).filter(Boolean));
  const unsupported = [...claimedSet].filter((p) => !covers(p));
  // `unmentioned` stays the READ calls only: a recall that matched five files is a lookup, not five
  // documents the turn read, and reporting each match as "you read this and never mentioned it"
  // would turn a memory tool into a warning machine.
  const unmentioned = [...new Set(opened.map((o) => o.path))].filter((p) => p && !claimedSet.has(p));
  return {
    observed: [
      ...opened.map(({ tool, path: p, errored }) => ({ tool, path: p, ...(errored ? { errored: true } : {}) })),
      ...recalled,
    ],
    unsupported,
    unmentioned,
  };
}

/**
 * The files a `recall_memory` answer names as the source of what it brought back.
 *
 * Defensive about the shape on purpose: the AI SDK wraps a tool's JSON answer as
 * `{ type: "json", value: {…} }`, the harness has recorded a bare object and a string in other
 * places, and a cross-check that silently reads nothing would report an honest diagnosis as a
 * guessed one (gotcha 74).
 *
 * @param {*} output - The recorded output of one `recall_memory` call.
 * @returns {string[]} The source file paths its matches came from.
 */
function recalledSourceFiles(output) {
  let value = output;
  if (value && typeof value === "object" && value.type === "json" && value.value !== undefined) {
    value = value.value;
  }
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  const out = new Set();
  for (const match of (value && Array.isArray(value.matched) ? value.matched : [])) {
    if (match && typeof match.sourceFile === "string" && match.sourceFile) out.add(match.sourceFile);
    for (const f of (match && Array.isArray(match.sourceFiles) ? match.sourceFiles : [])) {
      if (typeof f === "string" && f) out.add(f);
    }
  }
  return [...out];
}

/**
 * Every mutating tool call the turn made, from both layers of the read-only guarantee.
 *
 * Two layers, and which one fires depends on how the attempt was made (gotcha 8):
 *   - the tool SET: `readOnlyFsTools` hands the agent only the three read tools, so a call to
 *     `writeFile` never reaches the sandbox — the provider answers "Model tried to call unavailable
 *     tool 'writeFile'". That is recorded in the turn's `toolCalls`, not in the gate's log.
 *   - the approve gate: the backstop, for a mutating tool that ever does reach the sandbox. It
 *     logs its own refusal.
 * Recording only the gate's log would report "the team did not try" for the common case where it
 * tried and the tool set said no — which is exactly the fact the account owner needs.
 *
 * @param {Array<{tool: string, path: string, reason: string, at: string}>} refusals - The gate's own log.
 * @param {Array<{name: string, input?: Object, error?: string|null}>} toolCalls - The turn's real calls.
 * @returns {Array<{tool: string, path: string, reason: string, at: string, layer: string}>}
 */
function collectWriteAttempts(refusals, toolCalls) {
  const out = (refusals || []).map((r) => ({ ...r, layer: "the approve gate" }));
  const seen = new Set(out.map((r) => `${r.tool}\u0000${r.path}`));
  for (const call of toolCalls || []) {
    if (!MUTATING_TOOL_NAMES.includes(call.name)) continue;
    const target = (call.input && (call.input.filePath || call.input.dirPath)) || "(no path given)";
    const key = `${call.name}\u0000${target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      tool: call.name,
      path: target,
      reason:
        `the diagnostics role is not offered ${call.name} at all — the tool set refused the call ` +
        `before it reached the sandbox. ${READ_ONLY_REFUSAL}`,
      at: new Date().toISOString(),
      layer: "the tool set",
    });
  }
  return out;
}

/**
 * The files a ticket points at, and how big they are — measured so a turn's reading can be described
 * afterwards, not so a cap can be computed from it (this role has no step cap; see the note under
 * `DIAGNOSIS_COSTS`).
 *
 * Missing files count as zero rather than failing: a ticket whose evidence is gone is a different
 * problem (and the turn will discover that by itself), and inventing bytes for it would report a size
 * nobody measured.
 *
 * @param {import("./tickets").Ticket} ticket
 * @param {string[]} extraFiles
 * @param {string} [seriesDir] - The series the ticket is about. A ticket's evidence is named the
 *   way the triage named it — relative to the series folder — so resolving it only against this
 *   repo would find nothing and report an empty footprint for the biggest artifact.
 * @returns {Promise<{bytes: number, files: string[]}>}
 */
async function evidenceFootprint(ticket, extraFiles = [], seriesDir = "") {
  const candidates = [...(ticket.evidence || []).map((e) => e.file), ...extraFiles];
  const bases = [ROOT, seriesDir, ticket.seriesDir || ""].filter(Boolean);
  let bytes = 0;
  const files = [];
  for (const raw of candidates) {
    for (const base of bases) {
      const abs = path.isAbsolute(raw) ? raw : path.join(base, raw);
      try {
        const stat = await fs.promises.stat(abs);
        if (stat.isFile()) {
          bytes += stat.size;
          files.push(abs);
          break;
        }
      } catch {
        /* try the next base */
      }
    }
  }
  return { bytes, files };
}

/**
 * Can this ticket be asked, before anything expensive is decided?
 *
 * The three refusals `diagnoseTicket` makes before it reaches a model are readable off the ticket
 * record, and a caller needs to know them BEFORE it switches a model container in. On this machine a
 * container switch means loading a model (gotcha 22), and "already answered" is the common case in a
 * loop that re-reads the state every iteration — so the CLI asks this first and only fires the
 * `pre-manager` hook for a request that can actually reach the endpoint.
 *
 * One implementation, two readers: `diagnoseTicket` calls this itself, so the CLI's decision and the
 * module's refusal cannot drift.
 *
 * @param {Object|null} ticket - The ticket record, or null when the id is not in the file.
 * @param {Object} [opts]
 * @param {boolean} [opts.reask] - The `--reask` flag.
 * @param {string} [opts.jsonPath] - Where the tickets live, for the "no ticket" message.
 * @returns {{askable: boolean, error: string|null}}
 */
function diagnosisIsAskable(ticket, { ticketId = "", reask = false, jsonPath = "" } = {}) {
  const id = ticket ? ticket.id : ticketId;
  if (!ticket) {
    return {
      askable: false,
      error:
        `no ticket ${id} in ${jsonPath || "the ticket file"}. Run "node diagnose.js --open" to list the ones ` +
        `that are waiting, or "npm run delivery" to see why there are none.`,
    };
  }
  if (ticket.status === "closed") {
    return {
      askable: false,
      error: `ticket ${ticket.id} is closed (${ticket.closure ? ticket.closure.outcome : "no outcome recorded"}). A closed ticket is not re-asked; open a new one if the finding came back.`,
    };
  }
  const priorAttempts = (ticket.diagnosis && ticket.diagnosis.attempts) || 0;
  if (ticket.diagnosis && !reask) {
    return {
      askable: false,
      error:
        `ticket ${ticket.id} already has a diagnosis (attempt ${priorAttempts}). Re-asking the same question ` +
        `until a cheaper answer appears is the same spin the ledger refuses (gotcha 69). Pass --reask when a ` +
        `second opinion is genuinely wanted — for example after the manager answered a question the team asked.`,
    };
  }
  return { askable: true, error: null };
}

/**
 * Ask the diagnostics team one ticket.
 *
 * @param {Object} cfg
 * @param {string} cfg.ticketId - The ticket to answer.
 * @param {string} cfg.seriesDir - The series the ticket is about (SERIES_LOCATION).
 * @param {string} [cfg.root] - The project root the agent may read (defaults to this repo).
 * @param {boolean} [cfg.reask] - Ask again when the ticket already has a diagnosis.
 * @param {{json?: string, markdown?: string}} [cfg.paths] - Ticket file override (tests).
 * @returns {Promise<{ok: boolean, refused: boolean, ticket: Object|null, diagnosis: Object|null,
 *   allowed: Object[], refusedOptions: Object[], writeAttempts: Object[], problems: Object[],
 *   warnings: Object[], usage: Object|null, error: string|null}>}
 */
async function diagnoseTicket({ ticketId, seriesDir, root = ROOT, reask = false, paths = ticketPaths() }) {
  const fail = (error, extra = {}) => ({
    ok: false,
    refused: true,
    ticket: null,
    diagnosis: null,
    allowed: [],
    refusedOptions: [],
    writeAttempts: [],
    problems: [],
    warnings: [],
    usage: null,
    error,
    ...extra,
  });

  const store = readTickets(paths.json);
  const ticket = store.tickets.find((t) => t.id === ticketId);
  // The same three refusals the CLI asks about before it switches a model container in (see
  // `diagnosisIsAskable`). Kept here so no caller can reach the turn by skipping that question.
  const askable = diagnosisIsAskable(ticket, { ticketId, reask, jsonPath: paths.json });
  if (!askable.askable) return fail(askable.error);

  const where = { seriesDir, root };
  const footprint = await evidenceFootprint(ticket, [], seriesDir);
  // The evidence size is PRINTED, not spent on a cap. This turn is uncapped, so the number that
  // explains a long diagnosis afterwards is "how much it was pointed at", and the run log is where
  // the account owner reads it.
  harness.logLine(
    `[diagnostics] ${ticket.id}: evidence is ${footprint.files.length} file(s), ` +
      `${footprint.bytes} bytes — uncapped turn, old read answers offloaded to disk as it fills`
  );

  const gate = await readOnlyFsTools({ cwd: root, allowedDirs: [root] });

  // The role's read-only promise, checked against the disk rather than asserted: hash what the
  // ticket points at before the turn and again after it. `fingerprintFiles` is the same rule the QA
  // loop uses to tell a rewrite from a no-op (gotcha 65) — here it is the difference between
  // "a support team that only looked" and one that quietly edited the corpus it was asked about.
  // The window includes the per-machine hooks that wrap the turn, because a hook is a side effect
  // this machine chose and "the state moved while we were asking" is the honest reading of it.
  const before = await fingerprintFiles(footprint.files);

  // `pre-manager` / `post-manager` fire HERE, around the turn, not in the CLI that typed the command.
  // Two reasons, both about cost and honesty: every refusal this module makes (no ticket, a closed
  // ticket, a ticket already answered) happens first, so a request that never reaches the model never
  // pays for a container switch (gotcha 22); and this turn is a tool-calling agent, which a container
  // that cannot call tools answers with nothing at all (gotcha 51) — so "the support model is the one
  // serving" has to be guaranteed by the role that makes the call. Which container that is stays
  // entirely the hook's business (AGENTS.md §3, "hook names are role labels, never model names").
  const result = await runTurnWithHooks(MANAGER_TASK, async () => {
    const agent = await harness.createAgentHandle({
      name: "diagnostics",
      systemPrompt: loadSystemPrompt() + DIAGNOSIS_TOOLS_NOTE,
      tools: gate.tools,
      approve: gate.approve,
      cwd: root,
      // The delivery-layer context management: no step cap, the working window is reported on every
      // tool answer, and old read answers are set aside on disk where they stay recallable
      // (`utils/context.js`). The harness adds `manage_context` / `recall_memory` to the tool set for
      // a managed role — this module does not add them itself, so the read-only tool SET stays the
      // three senses the contract pins (gotcha 74) and the two memory tools come in through the
      // harness, which is also what keeps `collectWriteAttempts`' "not advertised" layer honest.
      contextManagement: true,
    });
    try {
      const reply = await agent.sendTurn(renderTicketForDiagnosis(ticket, where), {
        label: `diagnose-${ticket.id}`,
      });
      assertRealToolCalls(reply, "the diagnostics agent", ticket.volume || ticket.step);
      return reply;
    } finally {
      await agent.close();
    }
  });

  const after = await fingerprintFiles(footprint.files);
  const moved = before !== after;

  // Both layers of the read-only guarantee, recorded together (gotcha 8's two-layer pattern):
  //   - the tool SET refused it: the mutating tools are never advertised, so the model's attempt
  //     dies before it reaches the sandbox ("Model tried to call unavailable tool 'writeFile'");
  //   - the approve gate refused it: the backstop for a mutating tool that ever reaches here.
  // Whichever layer fired, the attempt is recorded, because "the support team tried to repair the
  // data while it was being asked to explain it" is information the account owner should see.
  const attempts = collectWriteAttempts(gate.refusals, result.toolCalls);

  const parsed = parseDiagnosisReply(result.text);
  if (!parsed.diagnosis) {
    return {
      ok: false,
      refused: false,
      ticket,
      diagnosis: null,
      allowed: [],
      refusedOptions: [],
      writeAttempts: attempts,
      problems: parsed.problems,
      warnings: [],
      usage: result.usage || null,
      error: "the diagnostics team could not answer this ticket (see the problems below).",
    };
  }

  const checked = validateDiagnosisShape(parsed.diagnosis);
  const reads = crossCheckReads(checked.diagnosis.read, result.toolCalls || []);
  const warnings = [...checked.warnings];
  if (reads.unsupported.length) {
    warnings.push({
      kind: "cited-without-reading",
      message:
        `the reply cites ${reads.unsupported.length} file(s) the turn never opened: ` +
        `${reads.unsupported.join(", ")}. The turn's real tool calls are recorded with this ` +
        `diagnosis, so a conclusion that names an unread file is visible as one.`,
    });
  }
  if (moved) {
    warnings.push({
      kind: "state-moved-during-diagnosis",
      message:
        "the files this ticket points at changed while the diagnosis was running. This role has no " +
        "write access, so something else is writing them — a pipeline run is in progress. Read the " +
        "diagnosis as a snapshot of a moving state.",
    });
  }

  if (!checked.ok) {
    return {
      ok: false,
      refused: false,
      ticket,
      diagnosis: null,
      allowed: [],
      refusedOptions: [],
      writeAttempts: attempts,
      problems: checked.problems,
      warnings,
      usage: result.usage || null,
      error: "the diagnostics reply does not meet the contract (see the problems below).",
    };
  }

  // The only door from a model reply to a ticket: recordDiagnosis runs the banned-option filter
  // internally, so there is no way to attach a diagnosis that skips it (gotcha 70).
  const written = recordDiagnosis(
    ticketId,
    {
      cause: checked.diagnosis.cause,
      options: checked.diagnosis.options,
      recommend: checked.diagnosis.recommend,
      questions: checked.diagnosis.questions,
      ownerNote: checked.diagnosis.ownerNote || "",
      read: checked.diagnosis.read,
      observedReads: reads.observed,
      citedWithoutReading: reads.unsupported,
      attemptedWrites: attempts,
      // How the turn actually ran, in place of the step cap it used to run under. This role is
      // uncapped (see the note under `DIAGNOSIS_COSTS`), so a record naming a cap it never had would
      // state a limit that does not exist — and the next reader would go looking for a ceiling to
      // raise. The useful facts are how many pieces the turn needed, how much of its reading it had
      // to set aside on disk, and how it ended.
      turnShape: turnShapeOf(result),
      usage: result.usage || null,
      stateMovedDuringDiagnosis: moved,
    },
    paths
  );

  return {
    ok: !written.error,
    refused: false,
    ticket: written.ticket,
    diagnosis: written.ticket ? written.ticket.diagnosis : null,
    allowed: written.allowed,
    refusedOptions: written.refused,
    writeAttempts: attempts,
    problems: [],
    warnings,
    usage: result.usage || null,
    error: written.error || null,
  };
}

/**
 * One answered ticket as Markdown — the half a human reads.
 * @param {import("./tickets").Ticket} ticket
 * @returns {string}
 */
function renderDiagnosisMarkdown(ticket) {
  const d = ticket && ticket.diagnosis;
  if (!d) return "";
  const lines = [`**Diagnosis** (by the diagnostics team, attempt ${d.attempts || 1}):`, ``, d.cause];
  if (d.recommend) lines.push(``, `**Recommended:** ${d.recommend}`);
  if ((d.questions || []).length) {
    lines.push(``, `**Questions back to the manager:**`);
    for (const q of d.questions) lines.push(`- ${q}`);
  }
  if (d.ownerNote) {
    lines.push(``, `**For the account owner only** (not an option the manager may be offered):`, d.ownerNote);
  }
  if ((d.read || []).length) lines.push(``, `**Files it says it read:** ${d.read.map((r) => `\`${r}\``).join(", ")}`);
  if ((d.citedWithoutReading || []).length) {
    lines.push(``, `**Cited but never opened by that turn:** ${d.citedWithoutReading.map((r) => `\`${r}\``).join(", ")}`);
  }
  if ((d.attemptedWrites || []).length) {
    lines.push(``, `**Write attempts refused by the read-only role:**`);
    for (const w of d.attemptedWrites) {
      const layer = w.layer ? ` (stopped by ${w.layer})` : "";
      lines.push(`- \`${w.tool}\` on \`${w.path}\`${layer} — ${w.reason}`);
    }
  }
  return lines.join("\n");
}

module.exports = {
  MUTATING_TOOL_NAMES,
  READ_TOOL_NAMES,
  DIAGNOSIS_COSTS,
  DIAGNOSIS_CONTRACT,
  DIAGNOSIS_TOOLS_NOTE,
  READ_ONLY_REFUSAL,
  readOnlyFsTools,
  loadSystemPrompt,
  renderTicketForDiagnosis,
  parseDiagnosisReply,
  validateDiagnosisShape,
  verificationIsOutcomeOnly,
  questionIsAnswerableByCustomer,
  crossCheckReads,
  collectWriteAttempts,
  evidenceFootprint,
  diagnosisIsAskable,
  diagnoseTicket,
  renderDiagnosisMarkdown,
};
