/**
 * parseDiagnosisReply and validateDiagnosisShape — fail-closed on the contract the way parseAcceptanceReply is fail-closed on a grade: no cause, no options, an option missing label/touches/cost/risk/verify, a bad cost word, or a question only a code reader can answer are REFUSED; a thin cause, no cited reading, a recommendation naming no offered option, or an outcome-only verify are WARNINGS.
 *
 * Part of the diagnostics.js layer (split out of the original single file).
 */

const { extractJsonObject } = require("../manifest");
const tickets = require("../tickets");

const { CODE_ONLY_QUESTION, DIAGNOSIS_CONTRACT, DIAGNOSIS_COSTS } = require("./contract");

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
  problems.push(...causeProblems(cause));
  warnings.push(...causeWarnings(cause));

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
    const parsed = readDiagnosisOption(raw, index);
    problems.push(...parsed.problems);
    warnings.push(...parsed.warnings);
    if (parsed.option) options.push(parsed.option);
  });

  const questions = Array.isArray(diagnosis.questions) ? diagnosis.questions.map((q) => String(q).trim()).filter(Boolean) : [];
  problems.push(...unanswerableQuestionProblems(questions));

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
 * The cause: the one part of a diagnosis the manager cannot verify for themselves.
 *
 * A missing cause is a problem (the role's whole job is to explain a mechanism). A short one is a
 * warning, because "the guard fired" is the finding restated rather than an explanation of it, and the
 * length is not something a machine can judge better than the reader who has to act on it.
 *
 * @param {string} cause - The trimmed cause, or "" when the reply gave none.
 * @returns {Array<{kind: string, message: string}>} The problems.
 */
function causeProblems(cause) {
  if (cause) return [];
  return [
    {
      kind: "no-cause",
      message:
        `a diagnosis must state the cause: the mechanism that produced this finding, in language a ` +
        `customer can follow. ${DIAGNOSIS_CONTRACT[0].why}`,
    },
  ];
}

/**
 * @param {string} cause
 * @returns {Array<{kind: string, message: string}>} The warnings.
 */
function causeWarnings(cause) {
  if (!cause || cause.length >= 60) return [];
  return [
    {
      kind: "thin-cause",
      message: `the cause is ${cause.length} characters. Name the mechanism, not the label — "the guard fired" is the finding, restated.`,
    },
  ];
}

/**
 * One option, read against the five things every option must say.
 *
 * An option missing one of them is not repaired here: it is reported, because an option the manager
 * cannot judge is worse than no option — it looks like a decision was offered.
 *
 * @param {Object} raw - What the reply offered.
 * @param {number} index - Zero-based position, for the message.
 * @returns {{option: DiagnosisOption|null, problems: Array<{kind: string, message: string}>, warnings: Array<{kind: string, message: string}>}}
 */
function readDiagnosisOption(raw, index) {
  const problems = [];
  const warnings = [];
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
    return { option: null, problems, warnings };
  }

  /** @type {DiagnosisOption} */
  const option = { label, touches, cost, risk, verify, requiresCodeChange: Boolean(raw.requiresCodeChange) };
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
  return { option, problems, warnings };
}

/**
 * The questions a diagnosis may ask back — checked against who is being asked.
 *
 * The manager answers tickets by reading reports, not code. A question that requires reading the code
 * is not a question, it is the diagnostics team's own work handed sideways (gotcha 70).
 *
 * @param {string[]} questions - The trimmed questions the reply asked.
 * @returns {Array<{kind: string, message: string}>} The problems.
 */
function unanswerableQuestionProblems(questions) {
  const problems = [];
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
  return problems;
}


module.exports = {
  parseDiagnosisReply,
  verificationIsOutcomeOnly,
  questionIsAnswerableByCustomer,
  validateDiagnosisShape,
};
