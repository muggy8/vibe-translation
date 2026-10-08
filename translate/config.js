/**
 * The translator's own settings: the TRANSLATE_* endpoint, the thinking dialect, the model's own decoding recipe, the continuity tail, and `TRANSLATE_CHUNK_CHARS` — which is a CEILING ONLY when an operator sets it explicitly (translateChunkCap returns null when unset, and the token plan decides). Arithmetic does not overrule a deliberate limit (gotcha 57).
 *
 * Part of the translate.js layer (split out of the original single file).
 */

require("dotenv").config();
const path = require("path");
require("../types"); // JSDoc type definitions
const projectRoot = path.resolve(__dirname, "..");

const clientDir = projectRoot;

const seriesDir = process.env.SERIES_LOCATION;


const translateTemplateFile = path.join(clientDir, "user-prompts", "translate.md");

// Per-chapter artifact names and the per-volume file names (chapterArtifactNames,
// STATE_FILE, QA_REPORT_FILE, MERGED_FILE, readFileOrEmpty) now live in
// utils/translate.js — all four translation tasks need them, and keeping them in
// a task module made the tasks import from each other. They are re-exported
// below so existing imports keep working.


/**
 * Chapter text longer than this (chars) is split and translated per part.
 *
 * Only the FALLBACK now: the size rule is planChapterSplit (tokens, against this
 * role's window and output cap). This number stands in when the token rule has
 * nothing to work with, and TRANSLATE_CHUNK_CHARS remains a hard ceiling when an
 * operator sets it explicitly (see translateChunkCap).
 *
 * The rule itself lives in utils/translate/split.js next to the token plan it
 * falls back to, because the chapter planner needs it and a task module must not
 * be imported by a shared helper. It is re-exported below so existing imports
 * keep working.
 */
const { translateChunkChars } = require("../utils/translate");


/**
 * How many chars of the previous chapter's ending feed the next chapter.
 * @returns {number} TRANSLATE_CONTINUITY_CHARS (default 400; 0 = off).
 */
function translateContinuityChars() {
  const parsed = parseInt(process.env.TRANSLATE_CONTINUITY_CHARS, 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 400;
}


const continuityChars = translateContinuityChars();


/**
 * Index-Translate thinking mode. The model's published numbers are for the fast
 * (non-thinking) mode, so the default is "no_think" — and for this model the ask
 * is not optional: its chat template opens a think tag whenever the request does
 * not set `enable_thinking`, so "no_think" is what has to be SENT (see
 * thinkingExtraBody's "index-mt" dialect). "low"/"high" enable thinking; the
 * template has no levels, so both mean "think".
 * @returns {"no_think"|"low"|"high"}
 */
function translateThinkingMode() {
  const raw = String(process.env.TRANSLATE_THINKING ?? "no_think").trim().toLowerCase();
  if (raw === "true") return "low"; // "thinking on" without a level → low
  if (raw === "false") return "no_think";
  if (["no_think", "low", "high"].includes(raw)) return raw;
  console.warn(`[translate] unknown TRANSLATE_THINKING value "${raw}" — using "no_think".`);
  return "no_think";
}


/**
 * Index-Translate sampling. The family's published decoding is greedy — the
 * released client sends `temperature: 0` and the report's numbers are measured
 * that way — and top_p / top_k / penalties are left at the server's neutral
 * values (temperature is overridable via TRANSLATE_TEMPERATURE).
 *
 * Greedy is also what the stage's idempotency assumes: a chapter re-run against
 * an identical prompt reproduces an identical draft. Raising the temperature
 * buys the QA loop a fresh roll at the cost of that (see retranslateRetryBudget).
 * @returns {{temperature: number, topP: number, topK: number, repetitionPenalty: number}}
 */
function translateSampling() {
  const t = parseFloat(process.env.TRANSLATE_TEMPERATURE ?? "0");
  return {
    temperature: Number.isFinite(t) ? t : 0,
    topP: 1.0,
    topK: -1,
    repetitionPenalty: 1.0,
  };
}

// ─── Per-volume processing ──────────────────────────────────────────────────


module.exports = {
  clientDir,
  seriesDir,
  translateTemplateFile,
  translateChunkChars,
  translateContinuityChars,
  continuityChars,
  translateThinkingMode,
  translateSampling,
};
