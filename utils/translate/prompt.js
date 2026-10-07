/**
 * What the model is actually asked, and how the ask is fitted to the role's
 * context window.
 *
 * buildTranslationPrompt is the official single-user-message shape of the
 * translation model. fitPromptBudget / buildBudgetedTaskLines do the honest
 * trimming: when something has to go, the drop is LOGGED and written into
 * translation-qa.md under "Reference material the model did NOT see" — a stage
 * that silently truncated a glossary was a stage that silently ignored
 * terminology law (gotcha 43). Source text, verification findings and the
 * instructions are never trimmed.
 *
 * Part of the translate.js layer (split out of the original single file).
 */

const fs = require("fs").promises;
const tokens = require("../tokens");

/**
 * Build the numbered [Translation Tasks] lines for the Hy-MT2 translate
 * prompt, following the official "Personalization" format: terminology
 * references, background context, style constraints, optional continuity
 * and findings, then the no-commentary constraint and the translate
 * command (always last).
 *
 * @param {{terminologyLines?: string[], background?: string, styleRules?: string, voiceNotes?: string, continuityText?: string, continuitySource?: string, findingsText?: string, scopeText?: string, targetLanguage?: string}} p
 * @returns {string[]} The task lines, WITHOUT numbering (the caller numbers
 *   them — the numbering must be contiguous).
 */
function buildTranslationTaskLines({
  terminologyLines = [],
  background = "",
  styleRules = "",
  voiceNotes = "",
  continuityText = "",
  continuitySource = "the previous chapter",
  findingsText = "",
  scopeText = "",
  targetLanguage = "English",
}) {
  const indent = (text) =>
    text
      .split("\n")
      .map((l) => (l ? "   " + l : l))
      .join("\n");
  const tasks = [];
  if (terminologyLines.length > 0) {
    tasks.push(
      "Reference the following translations — render every occurrence of the source form exactly as given:\n" +
        terminologyLines.map((l) => "   " + l).join("\n")
    );
  }
  if (background && background.trim()) {
    tasks.push("Use this background context for names, places, and the plot:\n" + indent(background));
  }
  if (styleRules && styleRules.trim()) {
    tasks.push("The translation style must strictly conform to these house rules:\n" + indent(styleRules));
  }
  if (voiceNotes && voiceNotes.trim()) {
    tasks.push(
      "These characters' established speech patterns must be preserved:\n" + indent(voiceNotes)
    );
  }
  if (continuityText && continuityText.trim()) {
    tasks.push(
      `This text continues after ${continuitySource}, which ended with: "${continuityText}" ` +
        "Keep names, tense, register, and voice consistent with it."
    );
  }
  if (scopeText && scopeText.trim()) {
    tasks.push(scopeText.trim());
  }
  if (findingsText && findingsText.trim()) {
    tasks.push(
      "A previous translation of this text had the following problems — your translation MUST fix all of them:\n" +
        indent(findingsText)
    );
  }
  tasks.push(
    "ONLY output the translated result, without any additional explanation, commentary, or code fences."
  );
  tasks.push(`Translate the [Source Text] into ${targetLanguage}.`);
  return tasks;
}


/**
 * Fill the translate/retranslate user-prompt template (the official
 * Hy-MT2 single-user-message shape: [Source Text] block, then the numbered
 * [Translation Tasks] list).
 *
 * @param {{template: string, sourceText: string, tasks: string[]}} p
 * @returns {string} The final single user message.
 */
function buildTranslationPrompt({ template, sourceText, tasks }) {
  const numbered = tasks.map((t, i) => `${i + 1}. **${t}**`).join("\n");
  return template
    .replaceAll("{{SOURCE_TEXT}}", sourceText)
    .replaceAll("{{TASKS}}", numbered);
}


/**
 * A conservative token estimate for a piece of text.
 *
 * Implemented in utils/tokens.js (the one place the estimate lives) and
 * re-exported here for the call sites and tests that have always imported it
 * from this module. See that file for the coefficients, the per-model
 * calibration, and why the estimate must stay an over-estimate.
 *
 * @param {string} text
 * @returns {number} Estimated token count (rounded up).
 */
const estimateTokens = tokens.estimateTokens;

const chunkSafetyFraction = tokens.chunkSafetyFraction;


/**
 * Make sure the token estimates this stage uses describe the model this stage is
 * about to run on.
 *
 * The translation stage runs up to four DIFFERENT models (translate / verify /
 * edit / audit), and the prompt budget, the cross-chapter audit's windowing and
 * the per-chapter invalidation all estimate with these coefficients. A number
 * measured against the translator is the wrong number for the auditor, so each
 * task calibrates for its own role at its own start. Inside one process the
 * lookup is cached per endpoint, so a 17-volume run probes once per role, and
 * the translate-qa loop re-points the estimate at each half-round's model.
 *
 * Fail-soft (see ensureTokenCalibration): a probe that cannot run leaves the
 * built-in coefficients, which over-count. Token accounting must never be the
 * reason a run dies.
 *
 * @param {{endpoint: Object, bundle: SourceBundle, label: string, dryRun?: boolean}} p
 * @returns {Promise<Object>} The coefficients now in force.
 */
async function calibrateStageTokens({ endpoint, bundle, label, dryRun = false }) {
  let sample = "";
  try {
    if (bundle && bundle.wholePath) sample = await fs.readFile(bundle.wholePath, "utf8");
  } catch {
    // No readable whole-installment file — ensureTokenCalibration then falls
    // back to the built-in coefficients and says so.
  }
  return tokens.ensureTokenCalibration(endpoint, { sampleText: sample, label, dryRun });
}


/**
 * Fit the injected reference blocks into the model's context window, and SAY
 * what was dropped.
 *
 * Every stage injects terminology, story background, style rules and voice
 * notes on top of the chapter text. As the series grows those blocks grow, and
 * the request eventually exceeds the server's window — which the server reports
 * as a rejected call, and which the pipeline used to discover only by failing.
 * Trimming is unavoidable; trimming in SILENCE is not acceptable, because "the
 * model never saw the style rules" is exactly the kind of fact a reader of the
 * run must be able to see.
 *
 * Trim order (least useful first): voice notes → background → style rules →
 * terminology tail → continuity. The chapter text, the findings and the
 * instructions are never trimmed — if the source alone does not fit, the caller
 * must split the chapter (TRANSLATE_CHUNK_CHARS), not drop the text.
 *
 * @param {{
 *   blocks: Array<{name: string, text: string, priority: number}>,
 *   fixedTokens: number,
 *   roleWindow: number,
 *   outputReserve: number,
 * }} p - blocks to fit, plus the tokens already committed (source + instructions), the role's context window and the output cap to leave room for.
 * @returns {{blocks: Array<{name: string, text: string}>, dropped: Array<{name: string, chars: number}>, estimatedTokens: number, fits: boolean}}
 */
function fitPromptBudget({ blocks, fixedTokens, roleWindow, outputReserve, templateOverhead }) {
  // The chat wrapper is billed ONCE, here, exactly as tokenBudgetFor bills it for
  // the pre-production stages. The two budgets must describe the same request:
  // estimating per block and never subtracting the wrapper made them disagree.
  const overhead = Number.isFinite(templateOverhead)
    ? templateOverhead
    : tokens.activeCoefficients().templateOverhead;
  const budget = Math.max(0, roleWindow - outputReserve - fixedTokens - overhead);
  const kept = [];
  const dropped = [];
  // Highest priority first: keep the most useful blocks whole, and cut the
  // least useful ones down or out.
  const ordered = [...(blocks || [])].sort((a, b) => b.priority - a.priority);
  let used = 0;
  for (const block of ordered) {
    const text = block.text || "";
    if (!text.trim()) continue;
    const blockTokens = estimateTokens(text);
    if (used + blockTokens <= budget) {
      kept.push({ name: block.name, text });
      used += blockTokens;
      continue;
    }
    // Partially keep what fits (cut whole lines from the end, so a glossary
    // keeps its head rather than being sliced mid-entry).
    const lines = text.split("\n");
    const partial = [];
    let partialTokens = 0;
    for (const line of lines) {
      const lineTokens = estimateTokens(line + "\n");
      if (used + partialTokens + lineTokens > budget) break;
      partial.push(line);
      partialTokens += lineTokens;
    }
    if (partial.length > 0) {
      const omitted = lines.length - partial.length;
      kept.push({
        name: block.name,
        text:
          partial.join("\n") +
          `\n(… ${omitted} further line(s) of the ${block.name} were dropped to fit the ${roleWindow}-token context window)`,
      });
      used += partialTokens;
      dropped.push({ name: block.name, chars: text.length - partial.join("\n").length });
    } else {
      dropped.push({ name: block.name, chars: text.length });
    }
  }
  return {
    blocks: kept,
    dropped,
    estimatedTokens: fixedTokens + overhead + used,
    templateOverhead: overhead,
    // "fits" means "everything was kept whole". A partial keep is still a loss
    // the caller must act on, so it is not reported as fitting.
    fits: dropped.length === 0,
  };
}


/**
 * Log a budget decision in one greppable line (and return the text the QA row
 * records), so a trimmed chapter is visible in both the run log and the report.
 *
 * @param {Array<{name: string, chars: number}>} dropped
 * @param {string} label - The chapter label (e.g. "Volume 03 ch5").
 * @returns {string} "" when nothing was dropped, else the sentence for the QA row.
 */
function describeDroppedBlocks(dropped, label) {
  if (!dropped || dropped.length === 0) return "";
  const text = `prompt trimmed for the context window — dropped ${dropped.map((d) => `${d.name} (${d.chars} chars)`).join(", ")}`;
  console.warn(`  ${label}: ${text}`);
  return text;
}


/**
 * Build the translation task lines under the model's context budget.
 *
 * The thin wrapper the four translation stages call: it fits the reference
 * blocks into the role's window (fitPromptBudget), rebuilds the task lines from
 * what survived, and returns the drop list so the caller can log it and record
 * it in the chapter's QA row.
 *
 * @param {{
 *   background?: string,
 *   styleRules?: string,
 *   voiceNotes?: string,
 *   terminologyLines?: string[],
 *   continuityText?: string,
 *   continuitySource?: string,
 *   findingsText?: string,
 *   sourceText: string,
 *   template: string,
 *   roleWindow: number,
 *   outputReserve: number,
 *   targetLanguage?: string,
 *   label?: string,
 * }} p
 * @returns {{tasks: string[], dropped: Array<{name: string, chars: number}>, estimatedTokens: number}}
 */
function buildBudgetedTaskLines({
  background = "",
  styleRules = "",
  voiceNotes = "",
  terminologyLines = [],
  continuityText = "",
  continuitySource = "the previous chapter",
  findingsText = "",
  scopeText = "",
  sourceText,
  template,
  roleWindow,
  outputReserve,
  targetLanguage = "English",
  label = "",
}) {
  // What the request carries no matter what: the chapter text, the prompt
  // template, and the fixed instruction lines. These are never trimmed — a
  // chapter that does not fit with them must be split (TRANSLATE_CHUNK_CHARS),
  // not squeezed by dropping the book.
  // The scope line is an instruction (it is what stops a passage pass from
  // re-translating the whole chapter), so it is fixed like the findings.
  const fixedTokens =
    estimateTokens(sourceText) +
    estimateTokens(template) +
    estimateTokens(findingsText) +
    estimateTokens(scopeText) +
    120;
  const terminologyText = terminologyLines.join("\n");
  const fitted = fitPromptBudget({
    blocks: [
      // Highest priority first (kept whole longest). Terminology is the one
      // block a later stage cannot repair, so it out-ranks atmosphere.
      { name: "glossary", text: terminologyText, priority: 5 },
      { name: "continuity", text: continuityText, priority: 4 },
      { name: "style rules", text: styleRules, priority: 3 },
      { name: "story background", text: background, priority: 2 },
      { name: "voice notes", text: voiceNotes, priority: 1 },
    ],
    fixedTokens,
    roleWindow,
    outputReserve,
  });
  const pick = (name) => {
    const b = fitted.blocks.find((x) => x.name === name);
    return b ? b.text : "";
  };
  if (fitted.dropped.length > 0 && label) describeDroppedBlocks(fitted.dropped, label);
  return {
    tasks: buildTranslationTaskLines({
      terminologyLines: pick("glossary") ? pick("glossary").split("\n") : [],
      background: pick("story background"),
      styleRules: pick("style rules"),
      voiceNotes: pick("voice notes"),
      continuityText: pick("continuity"),
      continuitySource,
      findingsText,
      scopeText,
      targetLanguage,
    }),
    dropped: fitted.dropped,
    estimatedTokens: fitted.estimatedTokens,
  };
}

// ─── Chapter-list consistency (the handoff vs the extraction) ────────────────


module.exports = {
  buildTranslationTaskLines,
  buildTranslationPrompt,
  estimateTokens,
  chunkSafetyFraction,
  calibrateStageTokens,
  fitPromptBudget,
  describeDroppedBlocks,
  buildBudgetedTaskLines,
};
