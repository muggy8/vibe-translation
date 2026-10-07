/**
 * Chapter splitting and chapter PART size planning, in tokens.
 *
 * Two independent limits (AGENTS.md gotcha 57): ADMISSION — the server rejects a
 * request whose prompt + max_tokens exceed its context, so the configured output
 * cap is part of the sum whether or not the model ever uses it; and FEASIBILITY —
 * the answer a part needs (source tokens x the output ratio x the thinking factor)
 * must fit INSIDE that cap, or the generation is cut off mid-chapter. The
 * character limit is then derived from whichever limit bound, using that chapter's
 * own measured characters-per-token.
 *
 * Part of the translate.js layer (split out of the original single file).
 */

const fs = require("fs").promises;
const path = require("path");
const tokens = require("../tokens");

const { langKey } = require("./qa");
const { chunkSafetyFraction, estimateTokens } = require("./prompt");
const { chapterArtifactNames } = require("./state");
const { readFileOrEmpty } = require("./internal");

/**
 * Split a chapter into translation-sized parts, at paragraph boundaries
 * (blank lines) wherever possible.
 *
 * Contract: the parts cover the whole input without loss — concatenating
 * them in order (ignoring whitespace) reproduces the input's content. Each
 * part is at most `maxChars` long EXCEPT single paragraphs longer than
 * `maxChars`, which are hard-split at the character level (Japanese text
 * has no word boundaries to break at).
 *
 * @param {string} text - The chapter source text.
 * @param {number} [maxChars] - Target maximum part length (default: 24000,
 *   from TRANSLATE_CHUNK_CHARS).
 * @returns {string[]} The parts, in reading order (one part for short text).
 */
function splitChapter(text, maxChars = 24000) {
  if (typeof text !== "string") return [];
  const limit = Math.max(1000, parseInt(maxChars, 10) || 24000);
  const t = text.trim();
  if (!t) return [];
  if (t.length <= limit) return [t];

  const paragraphs = t.split(/\n\s*\n/);
  const parts = [];
  let current = "";
  const flush = () => {
    if (current) {
      parts.push(current);
      current = "";
    }
  };
  for (const para of paragraphs) {
    if (!para.trim()) continue;
    if (para.length > limit) {
      // A single paragraph longer than the limit: hard-split it.
      flush();
      for (let i = 0; i < para.length; i += limit) {
        parts.push(para.slice(i, i + limit));
      }
      continue;
    }
    if (!current) {
      current = para;
    } else if (current.length + 2 + para.length <= limit) {
      current = current + "\n\n" + para;
    } else {
      flush();
      current = para;
    }
  }
  flush();
  return parts;
}

// ─── Chapter size planning (tokens, not characters) ─────────────────────────


/**
 * Expected OUTPUT tokens per token of source, per language pair.
 *
 * A translation's answer is about as long as its input IN TOKENS — measured on
 * the fixture's real Japanese→English run: 744 source tokens produced a 799-token
 * draft (1.07×) and a 778-token polish (1.05×). That is NOT the same fact as the
 * character-length band in {@link lengthBands}: a Japanese chapter gets LONGER in
 * characters and roughly the same in tokens, because the two scripts cost very
 * different amounts per character. Keeping them in separate tables is the point.
 *
 * The defaults are seeded from that one measured pair plus margin, and the
 * CJK→CJK pairs are ~1.0 because both sides are billed per Han character.
 * Override with TRANSLATION_OUTPUT_RATIO ("1.2", or "ja->en=1.1,ko->en=1.4").
 */
const DEFAULT_OUTPUT_RATIOS = {
  "ja-en": 1.1,
  "zh-en": 1.15,
  "ko-en": 1.2,
  "ja-zh": 1.0,
  "zh-ja": 1.0,
  "ko-ja": 1.05,
};

const DEFAULT_OUTPUT_RATIO = 1.25;


/**
 * TRANSLATION_OUTPUT_RATIO: a bare number for every pair, or a per-pair list
 * ("ja->en=1.1,ko->en=1.4"). Malformed input is ignored (the table stands).
 * @returns {{all: number|null, pairs: Map<string, number>}}
 */
function outputRatioSetting() {
  const raw = (process.env.TRANSLATION_OUTPUT_RATIO || "").trim();
  const all = parseFloat(raw);
  if (raw && Number.isFinite(all) && all > 0 && String(raw).match(/^[0-9.]+$/)) {
    return { all, pairs: new Map() };
  }
  const pairs = new Map();
  for (const piece of raw.split(",")) {
    const [side, value] = piece.split("=").map((s) => (s || "").trim());
    const num = parseFloat(value);
    const m = (side || "").match(/^([a-z]{2})\s*(?:->|→|-)\s*([a-z]{2})$/i);
    if (m && Number.isFinite(num) && num > 0) pairs.set(`${m[1].toLowerCase()}-${m[2].toLowerCase()}`, num);
  }
  return { all: null, pairs };
}


/**
 * The output-token ratio for one source→target pair (env override > table > wide default).
 * @param {string} sourceLanguage
 * @param {string} targetLanguage
 * @returns {number}
 */
function outputRatioFor(sourceLanguage, targetLanguage) {
  const { all, pairs } = outputRatioSetting();
  if (all) return all;
  const key = `${langKey(sourceLanguage)}-${langKey(targetLanguage)}`;
  return pairs.get(key) ?? DEFAULT_OUTPUT_RATIOS[key] ?? DEFAULT_OUTPUT_RATIO;
}


/**
 * How much of the output cap the model's own thinking is expected to eat.
 *
 * Reasoning tokens are billed as OUTPUT, so a stage that thinks while translating
 * has to fit both the answer and the thinking inside the same cap. Measured on
 * this pipeline's own logs: a thinking-heavy extraction stage produced 41,419
 * characters of reasoning for 11,837 characters of content. The translate role
 * runs `no_think` by default, which is why the default factor is 1.
 *
 * @param {string} thinkingMode - The stage's thinking dialect ("no_think" / "low" / "high").
 * @returns {number} A multiplier on the expected answer size.
 */
function thinkingOutputFactor(thinkingMode) {
  const mode = (thinkingMode || "").toLowerCase();
  if (mode === "high") return 3;
  if (mode === "low" || mode === "medium") return 2;
  return 1;
}


/**
 * Decide how big a chapter part may be — in tokens, then converted to characters
 * using THIS chapter's own measured script mix.
 *
 * Two independent limits, and the honest reason names whichever one bound:
 *
 *   1. ADMISSION — the server rejects a request when `prompt + max_tokens` exceeds
 *      its context. The configured cap is part of that sum whether or not the
 *      model ever generates that much, so it cannot be subtracted away here.
 *   2. FEASIBILITY — the answer the part needs must actually fit inside the cap,
 *      or the generation is cut off mid-chapter. This is the limit a character
 *      constant cannot see at all: it is why TRANSLATE_CHUNK_CHARS=24000 was
 *      splitting 55 of the real series' 133 chapters for a reason the numbers
 *      do not support.
 *
 * Pure and deterministic: the same files and the same endpoint give the same
 * answer, which is what keeps a mode decision reproducible between runs.
 *
 * @param {{
 *   sourceText: string,
 *   referenceTokens?: number,
 *   findingsTokens?: number,
 *   instructionsTokens?: number,
 *   roleWindow: number,
 *   outputReserve: number,
 *   outputRatio?: number,
 *   thinkingFactor?: number,
 *   hardCapChars?: number|null,
 *   safetyFraction?: number,
 * }} p - The chapter text, the tokens the prompt carries besides the chapter, the role's window and output cap, the expected answer ratio, and an explicit character ceiling the operator set.
 * @returns {{maxChars: number, maxTokens: number, binding: "admission"|"feasibility"|"override", sourceTokens: number, expectedOutputTokens: number, reason: string}}
 */
function planChapterSplit({
  sourceText,
  referenceTokens = 0,
  findingsTokens = 0,
  instructionsTokens = 0,
  roleWindow,
  outputReserve,
  outputRatio = DEFAULT_OUTPUT_RATIO,
  thinkingFactor = 1,
  hardCapChars = null,
  safetyFraction = null,
}) {
  const text = typeof sourceText === "string" ? sourceText.trim() : "";
  const sourceTokens = text ? estimateTokens(text) : 0;
  // Characters per token for THIS text — measured from its own script mix rather
  // than assumed from a language name, because that is the only conversion that
  // is true for the book in hand.
  const charsPerToken = sourceTokens > 0 ? text.length / sourceTokens : 1;
  const fraction = Number.isFinite(safetyFraction)
    ? Math.min(1, Math.max(0.1, safetyFraction))
    : chunkSafetyFraction();
  const window = Math.max(0, roleWindow || 0);
  const cap = Math.max(0, outputReserve || 0);
  const overhead = tokens.activeCoefficients().templateOverhead;
  const fixed = (referenceTokens || 0) + (findingsTokens || 0) + (instructionsTokens || 0) + overhead;

  // Limit 1: how much source the request can carry and still be admitted.
  const admissionTokens = Math.floor(window * fraction - cap - fixed);
  // Limit 2: how much source the model can answer within the output cap.
  const answerBudget = Math.floor(cap / Math.max(1, outputRatio * thinkingFactor));
  const feasibilityTokens = answerBudget;

  let maxTokens;
  let binding;
  if (window <= 0 || cap <= 0) {
    // No window or no cap known: the token rule has nothing to work with, and
    // inventing one is how a size decision becomes unexplainable. The caller
    // falls back to the character rule and says so.
    return {
      maxChars: Number.isFinite(hardCapChars) && hardCapChars > 0 ? hardCapChars : 0,
      maxTokens: 0,
      binding: "override",
      sourceTokens,
      expectedOutputTokens: 0,
      reason: "no context window or output cap known for this role — the character rule stands",
    };
  }
  if (admissionTokens <= feasibilityTokens) {
    maxTokens = admissionTokens;
    binding = "admission";
  } else {
    maxTokens = feasibilityTokens;
    binding = "feasibility";
  }
  // A part must still be worth making: a limit that rounds down below a
  // paragraph is not a plan, it is a failure to plan.
  maxTokens = Math.max(1000, maxTokens);
  const expectedOutputTokens = Math.ceil(sourceTokens * outputRatio * thinkingFactor);

  let maxChars = Math.floor(maxTokens * charsPerToken);
  if (Number.isFinite(hardCapChars) && hardCapChars > 0 && hardCapChars < maxChars) {
    maxChars = hardCapChars;
    binding = "override";
  }
  const reason =
    binding === "feasibility"
      ? `bounded by the ${cap.toLocaleString()}-token output cap: a part of ${maxTokens.toLocaleString()} source tokens answers in about ${Math.ceil(maxTokens * outputRatio * thinkingFactor).toLocaleString()}`
      : binding === "admission"
        ? `bounded by the ${window.toLocaleString()}-token window: ${maxTokens.toLocaleString()} source tokens plus ${fixed.toLocaleString()} of reference, instructions and output room`
        : `TRANSLATE_CHUNK_CHARS caps a part at ${maxChars.toLocaleString()} characters`;

  return { maxChars, maxTokens, binding, sourceTokens, expectedOutputTokens, reason };
}


/**
 * TRANSLATE_CHUNK_CHARS, but honest about whether the operator actually set it.
 *
 * Unset, it is no longer a limit: the token plan decides. Set explicitly, it is a
 * hard ceiling — an operator who says "never send more than N characters to the
 * translator" means it, and the pipeline does not overrule that with arithmetic.
 *
 * @returns {number|null} null when the variable is unset (let the token rule decide).
 */
function translateChunkCap() {
  const raw = process.env.TRANSLATE_CHUNK_CHARS;
  if (raw === undefined || String(raw).trim() === "") return null;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? Math.max(2000, parsed) : null;
}


/**
 * The character rule that stands in when the token plan has nothing to work with.
 *
 * Only the FALLBACK now: the size rule is planChapterSplit (tokens, against this role's window and
 * output cap). TRANSLATE_CHUNK_CHARS remains a hard ceiling when an operator sets it explicitly (see
 * translateChunkCap) — arithmetic does not overrule a deliberate limit (gotcha 57).
 * @returns {number} TRANSLATE_CHUNK_CHARS (default 24000, minimum 2000).
 */
function translateChunkChars() {
  const parsed = parseInt(process.env.TRANSLATE_CHUNK_CHARS, 10);
  return Number.isFinite(parsed) ? Math.max(2000, parsed) : 24000;
}


/**
 * The measured output ratio of the volumes this series has already translated.
 *
 * The pipeline's own past runs are the best available estimate of what the next
 * one will produce: for every earlier chapter, the source it read and the draft it
 * wrote are both on disk. Fail-open — with no history (the first volume) the
 * per-pair table stands, which is the same answer the old code assumed.
 *
 * @param {string[]} volumeDirs - Earlier volumes' folders, in reading order.
 * @param {{sourceLanguage?: string, targetLanguage?: string}} [opts]
 * @returns {Promise<{ratio: number|null, chapters: number, sourceTokens: number, draftTokens: number}>}
 */
async function measureOutputRatio(volumeDirs, { sourceLanguage = "", targetLanguage = "" } = {}) {
  let sourceTokens = 0;
  let draftTokens = 0;
  let chapters = 0;
  for (const dir of volumeDirs || []) {
    if (!dir) continue;
    let list;
    try {
      list = JSON.parse(await fs.readFile(path.join(dir, "chapters.json"), "utf8"));
    } catch {
      continue; // no handoff for this volume yet
    }
    for (const ch of Array.isArray(list) ? list : []) {
      if (!ch || !ch.id || !ch.file) continue;
      const { draftFile } = chapterArtifactNames(ch.id);
      const source = await readFileOrEmpty(path.join(dir, ch.file));
      const draft = await readFileOrEmpty(path.join(dir, draftFile));
      if (!source.trim() || !draft.trim()) continue;
      sourceTokens += estimateTokens(source);
      draftTokens += estimateTokens(draft);
      chapters++;
    }
  }
  if (!chapters || sourceTokens <= 0) {
    return { ratio: null, chapters: 0, sourceTokens: 0, draftTokens: 0 };
  }
  // Never let a measurement make the plan LOOSER than the table by more than
  // half: one lucky volume is not a property of the series.
  const measured = draftTokens / sourceTokens;
  const table = outputRatioFor(sourceLanguage, targetLanguage);
  return { ratio: Math.min(measured, table * 1.5), chapters, sourceTokens, draftTokens };
}

// ─── The chapter planner (one rule, two stages) ──────────────────────────────


/**
 * Build the rule that decides how big a chapter part may be — in tokens, not characters.
 *
 * The translate stage and the retranslate stage MUST use the same rule: verify graded the chapter the
 * translate stage produced, and a retranslate that cut the chapter differently would be re-scoring a
 * different book. Having the two stages each carry their own copy is how that agreement quietly
 * breaks.
 *
 * The old rule was one character constant for every chapter, every model and every language. Measured
 * against the real series it split 55 of 133 chapters for no reason the numbers supported — and every
 * split is a seam where the continuity tail has to rebuild the join and a name can drift between
 * parts. planChapterSplit bounds a part by BOTH limits that actually exist: the request the server
 * will admit, and the answer the output cap can hold.
 *
 * @param {{
 *   refs: {background?: string, styleRules?: string, voiceNotes?: string},
 *   template: string,
 *   thinkingMode: string,
 *   sourceLanguage: string,
 *   targetLanguage: string,
 *   previousVolumeDirs?: string[],
 *   roleWindow: number,
 *   outputReserve: number,
 *   label?: string,
 * }} input - The stage's references, its prompt template, and the role's context budget.
 * @returns {Promise<{ split: (text: string, carry?: {continuityText?: string, terminologyLines?: string[], findingsText?: string}) => {parts: string[], plan: Object}, ratio: Object, thinkingFactor: number }>}
 */
async function createChapterPlanner(input) {
  const { refs, template, thinkingMode, sourceLanguage, targetLanguage, roleWindow, outputReserve } = input;
  const hardCap = translateChunkCap();
  // The answer-size ratio, measured from this series' own earlier volumes when it has any (their
  // sources and drafts are both on disk), else the per-pair table. Fail-open: the first volume gets
  // the same assumption the old code made.
  const ratio = await measureOutputRatio(input.previousVolumeDirs || [], { sourceLanguage, targetLanguage });
  const outputRatio = ratio.ratio ?? outputRatioFor(sourceLanguage, targetLanguage);
  const thinkingFactor = thinkingOutputFactor(thinkingMode);

  /**
   * Split one chapter by the token plan, falling back to the character rule only when the token rule
   * has nothing to work with.
   * @param {string} text - The chapter source text.
   * @param {{continuityText?: string, terminologyLines?: string[], findingsText?: string}} [carry] - The reference material this chapter's prompt will carry.
   * @returns {{parts: string[], plan: Object}}
   */
  const split = (text, { continuityText = "", terminologyLines = [], findingsText = "" } = {}) => {
    const plan = planChapterSplit({
      sourceText: text,
      referenceTokens:
        estimateTokens(terminologyLines.join("\n")) +
        estimateTokens(refs.background || "") +
        estimateTokens(refs.styleRules || "") +
        estimateTokens(refs.voiceNotes || "") +
        estimateTokens(continuityText),
      findingsTokens: estimateTokens(findingsText),
      instructionsTokens: estimateTokens(template) + 400,
      roleWindow,
      outputReserve,
      outputRatio,
      thinkingFactor,
      hardCapChars: hardCap,
    });
    const limit = plan.maxChars > 0 ? plan.maxChars : translateChunkChars();
    return { parts: splitChapter(text, limit), plan };
  };

  return { split, ratio, outputRatio, thinkingFactor, hardCap };
}

// ─── Reference extraction (glossary / style guide) ─────────────────────────


module.exports = {
  splitChapter,
  DEFAULT_OUTPUT_RATIOS,
  DEFAULT_OUTPUT_RATIO,
  outputRatioSetting,
  outputRatioFor,
  thinkingOutputFactor,
  planChapterSplit,
  translateChunkCap,
  translateChunkChars,
  createChapterPlanner,
  measureOutputRatio,
};
