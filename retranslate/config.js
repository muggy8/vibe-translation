/**
 * The retranslate stage's own settings.
 *
 * Part of the retranslate.js layer (split out of the original single file).
 */

const path = require("path");
const { PASSING_SCORE, readBoolEnv } = require("../configs/shared");
const { stageConcurrency } = require("../utils/translate");
const { translateContinuityChars } = require("../translate");

const clientDir = path.resolve(__dirname, "..");

const seriesDir = process.env.SERIES_LOCATION;
const translateTemplateFile = path.join(clientDir, "user-prompts", "translate.md");

/** Verification is default-ON — retranslate is its correction pass. */
const verifyEnabled = process.env.VERIFY_TRANSLATE_ENABLED !== "false";

/** Chapter concurrency within a volume (opt-in; default 1 = serial — the local hardware runs one inference at a time). */
const retranslateConcurrency = stageConcurrency("RETRANSLATE");

/** Findings injected into the retranslate prompt (bounded — they are a numbered correction task, not a document to re-read). */
const RETRANSLATE_FINDINGS_CHARS = 3000;

/** Same continuity budget as the translate stage; the part SIZE is planned in tokens per chapter (see planChapterSplit), not by one character constant. */
const continuityChars = translateContinuityChars();

/**
 * (#6) How many times a chapter may be retranslated against an IDENTICAL set of verification findings
 * before the stall guard skips it. Default 2 = the single retranslate plus one extra fresh stochastic
 * shot (the translator runs at temp 0.7, so a repeat can succeed). Set 1 to restore retranslate-once.
 */
const retranslateRetryBudget = Math.max(1, parseInt(process.env.TRANSLATE_QA_RETRY_BUDGET, 10) || 2);

/**
 * How far below the passing line a chapter must sit before a whole-chapter rewrite is worth it when
 * the findings are only MEDIUM/LOW (see worthRetranslating). Default 5.
 */
const retranslateValueMargin = Math.max(0, parseInt(process.env.TRANSLATE_RETRANSLATE_VALUE_MARGIN, 10) || 5);

/**
 * Targeted correction (DEFAULT-ON): when the verification findings quote spans that can be located in
 * the source, re-translate ONLY those passages and stitch the corrected text back into the draft.
 *
 * The whole-chapter pass is the blunt instrument: one bad sentence costs a full chapter of generation
 * and a fresh chance to break something that was already right. The findings quote short source spans,
 * so the spans can be found, and `planTargetedRepair` refuses the shortcut whenever the source↔draft
 * mapping is not trustworthy (paragraph counts disagree, a quote cannot be found, the affected span
 * covers the chapter, or a draft paragraph is not a plausible rendering of its source paragraph) — in
 * which case the chapter gets the whole pass it always got.
 *
 * Set TRANSLATE_TARGETED_FIX=false to always rewrite whole chapters.
 */
const targetedFixEnabled = readBoolEnv("TRANSLATE_TARGETED_FIX", true);

/** Draft paragraphs of the surrounding translated text given to a passage pass on each side, so names / tense / voice match at the seams. */
const TARGETED_CONTEXT_BLOCKS = 2;

module.exports = {
  clientDir,
  seriesDir,
  translateTemplateFile,
  verifyEnabled,
  retranslateConcurrency,
  RETRANSLATE_FINDINGS_CHARS,
  continuityChars,
  retranslateRetryBudget,
  retranslateValueMargin,
  targetedFixEnabled,
  TARGETED_CONTEXT_BLOCKS,
  PASSING_SCORE,
};
