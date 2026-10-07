/**
 * The reply shape it must answer in (cause, options each with what it touches / its cost / its risk / how the manager checks it, a recommendation, questions back, and an ownerNote), the cost vocabulary, and the tool note appended in code — because AGENT_TOOLS_NOTE promises five tools and tells the agent to write its output with them, which for a read-only role is an instruction it cannot obey, and a model that follows it spends capped steps reasoning about a write it is not allowed to do.
 *
 * Part of the diagnostics.js layer (split out of the original single file).
 */

const path = require("path");
const utilsDir = path.resolve(__dirname, "..");

const ROOT = path.join(utilsDir, "..");

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


module.exports = {
  ROOT,
  SYSTEM_PROMPT_FILE,
  MUTATING_TOOL_NAMES,
  READ_TOOL_NAMES,
  READ_ONLY_REFUSAL,
  DIAGNOSIS_COSTS,
  DIAGNOSIS_CONTRACT,
  CODE_ONLY_QUESTION,
  DIAGNOSIS_TOOLS_NOTE,
};
