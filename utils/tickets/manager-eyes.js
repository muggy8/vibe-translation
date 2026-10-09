/**
 * What the manager is allowed to have looked at. The boundary is checked on the ANSWER, not the question: the diagnostics team may ask anything it needs to, but a reply that cites the run's logs, a `.js`, a prompt or `hooks/` is refused at the point where the boundary would actually leak.
 *
 * Part of the tickets.js layer (split out of the original single file).
 */

/**
 * The things a customer of this pipeline cannot see.
 *
 * This is the boundary the whole role split rests on: the delivery manager uses the product, it does
 * not maintain it. It may read the plan of record, what each volume folder holds, the step reports,
 * the ledger, the tickets and the publish report. It may not read the code, the prompts, or the run
 * transcripts — those are what the diagnostics team is FOR.
 *
 * The table is enforced on the manager's ANSWERS to the diagnostics team's questions
 * (`recordAnswer`), which is where the boundary would actually leak: a question like "does the
 * volume folder hold a `.rejected` file?" is fine, and the answer must cite a folder listing, not a
 * transcript. A question that cannot be answered from here is refused at the generator, in
 * `utils/diagnostics.js` — so the conversation cannot stall on something neither side can say.
 */
const MANAGER_EYES = [
  {
    id: "run-transcripts",
    // The transcripts moved next to the series (`<SERIES_LOCATION>/.run/logs/`); the old repo-root
    // name is kept in the pattern because a reply quoting a folder from before the move is quoting
    // the same kind of thing. The run's RECORDS (`.run/postmortem/`) are NOT here on purpose: the
    // manager reads the step reports, the ledger and the tickets.
    pattern: /(^|[\\/])(?:\.logs|\.run[\\/]logs)([\\/]|$)/,
    because:
      "the run transcripts are the diagnostics team's own material. A manager quoting a chat " +
      "history is quoting something it was not allowed to read.",
  },
  {
    id: "source-code",
    pattern: /\.(js|ts|mjs|cjs)\b/i,
    because: "the manager does not read the code. That is the diagnostics team's job.",
  },
  {
    id: "prompt-files",
    pattern: /(^|[\\/])(system|user)-prompts([\\/]|$)/,
    because: "the prompts are part of the product's internals, not part of what a customer sees.",
  },
  {
    id: "pipeline-hooks",
    pattern: /(^|[\\/])hooks([\\/]|$)/,
    because: "the per-machine hooks are this machine's configuration, and only the account owner changes them.",
  },
  {
    id: "this-module",
    pattern: /(^|[\\/])utils([\\/]|$)/,
    because: "the pipeline's own source lives under utils/ — the manager reads reports, not code.",
  },
];


/**
 * Can the manager cite this path?
 *
 * @param {string} filePath
 * @returns {{allowed: boolean, because: string|null, id: string|null}}
 */
function customerMayRead(filePath) {
  const text = String(filePath || "").replace(/\\/g, "/");
  if (!text.trim()) return { allowed: false, because: "an answer must name the file it is talking about", id: "no-path" };
  for (const rule of MANAGER_EYES) {
    if (rule.pattern.test(text)) return { allowed: false, because: rule.because, id: rule.id };
  }
  return { allowed: true, because: null, id: null };
}


/**
 * Compare two question strings. The manager quotes the question it is answering; small differences
 * in quoting (trailing punctuation, whitespace) are not a reason to refuse an honest answer.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function sameQuestion(a, b) {
  const norm = (s) => String(s || "").trim().replace(/\s+/g, " ").replace(/[?.!]+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

// ─── Ticket shape: a question, not an order ───────────────────────────────────


module.exports = {
  MANAGER_EYES,
  customerMayRead,
  sameQuestion,
};
