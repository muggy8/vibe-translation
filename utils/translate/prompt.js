/**
 * What the model is actually asked, and how the ask is fitted to the role's
 * context window.
 *
 * buildTranslationPrompt is the canonical instTrans shape of the Index-Translate
 * translation model: a header naming the genre and the target language, a
 * 【源文】 block, a numbered 【约束要求】 list of 【硬性要求】 (binary) and
 * 【注意】 (graded) constraints, and the output-only suffix. fitPromptBudget /
 * buildBudgetedTaskLines do the honest trimming: when something has to go, the
 * drop is LOGGED and written into translation-qa.md under "Reference material
 * the model did NOT see" — a stage that silently truncated a glossary was a
 * stage that silently ignored terminology law (gotcha 43). Source text,
 * verification findings and the instructions are never trimmed.
 *
 * Part of the translate.js layer (split out of the original single file).
 */

const fs = require("fs").promises;
const tokens = require("../tokens");

// ─── The instTrans instruction language ─────────────────────────────────────

/**
 * The two constraint markers of the instTrans format. The model's instruction
 * following is trained and benchmarked (instTrans / IFMTBench) on THIS
 * scaffolding, and the official client emits nothing else — so the markers,
 * the header and the suffix are Chinese even when the text they introduce
 * (a glossary rendering, a house style rule) is English. The markers are what
 * route the constraint; the content is read in whatever language it is in.
 */
const HARD_MARKER = "【硬性要求】";
const SOFT_MARKER = "【注意】";

/** The block labels of the canonical prompt. */
const SOURCE_BLOCK = "【源文】";
const CONSTRAINTS_BLOCK = "【约束要求】";

/**
 * The header's two forms, and the block the numbered constraints sit in. The
 * canonical prompt has a constrained form and a plain one, and the official
 * client picks between them by whether any constraint was supplied — so these
 * are exported constants the template is checked against, not prose the
 * builder guesses at. When a chapter's constraints all got trimmed away, the
 * prompt drops the constraint block and says the plain thing instead of
 * promising constraints that are not there.
 */
const HEADER_CONSTRAINED_CLAUSE = "，并且严格遵循所有约束要求。";
const HEADER_PLAIN_CLAUSE = "，直接输出翻译结果，不要进行任何解释。";
const CONSTRAINTS_SECTION = `\n${CONSTRAINTS_BLOCK}\n`;

/**
 * Language names in the spelling the model was trained with: the official
 * prompt builder maps every language code to the Chinese name and puts that in
 * the header. An unmapped name is passed through as written (the client does
 * the same), so an unusual target language still works — it is just not the
 * name the model saw during training.
 */
const LANGUAGE_NAMES = {
  english: "英语",
  chinese: "中文",
  zh: "中文",
  german: "德语",
  french: "法语",
  spanish: "西班牙语",
  japanese: "日语",
  ja: "日语",
  korean: "韩语",
  ko: "韩语",
  portuguese: "葡萄牙语",
  russian: "俄语",
  arabic: "阿拉伯语",
  italian: "意大利语",
  dutch: "荷兰语",
  polish: "波兰语",
  romanian: "罗马尼亚语",
  swedish: "瑞典语",
  turkish: "土耳其语",
  hindi: "印地语",
  vietnamese: "越南语",
  thai: "泰语",
  indonesian: "印尼语",
  malay: "马来语",
  filipino: "菲律宾语",
};


/**
 * The Chinese name of a language the pipeline names in English (the manifest's
 * sourceLanguage / targetLanguage), or the name as written when it is not in
 * the table.
 *
 * @param {string} name
 * @returns {string} "" for an empty/absent name — an omitted source language is
 *   the official client's `--source auto`, which the model handles.
 */
function languageName(name) {
  const raw = String(name || "").trim();
  if (!raw) return "";
  return LANGUAGE_NAMES[raw.toLowerCase()] || raw;
}


/**
 * The genre the header names. The model's genre/domain slot is part of the
 * canonical header, and the family's own list includes 小说 (novel) — the
 * right one for a light novel. TRANSLATE_GENRE overrides it (e.g. 文本 for the
 * neutral default the client ships with).
 *
 * @returns {string}
 */
function translateGenre() {
  const raw = String(process.env.TRANSLATE_GENRE ?? "").trim();
  return raw || "小说";
}


/**
 * Build the numbered 【约束要求】 lines for the Index-Translate translate
 * prompt, in the canonical instTrans order: the hard constraints first
 * (terminology law, the correction tasks, the scope of a passage pass), then
 * the graded ones (house style, character voice, background, continuity).
 *
 * @param {{terminologyLines?: string[], disputedTerms?: string[], background?: string, styleRules?: string, voiceNotes?: string, continuityText?: string, continuitySource?: string, findingsText?: string, scopeText?: string}} p
 * @returns {string[]} The constraint lines, each already carrying its 【硬性要求】 /
 *   【注意】 marker and WITHOUT numbering (the caller numbers them — the
 *   numbering must be contiguous).
 */
function buildTranslationTaskLines({
  terminologyLines = [],
  disputedTerms = [],
  background = "",
  styleRules = "",
  voiceNotes = "",
  continuityText = "",
  continuitySource = "上一章节",
  findingsText = "",
  scopeText = "",
}) {
  const indent = (text) =>
    text
      .split("\n")
      .map((l) => (l ? "   " + l : l))
      .join("\n");

  // Hard constraints: each one is binary — it either holds or the attempt is
  // wrong. Terminology is first because it is the one thing no later stage can
  // repair, and it is the constraint the model's hard-constraint training is
  // built around.
  const hard = [];
  if (terminologyLines.length > 0) {
    // The model's own client emits the glossary as ONE line of 、-joined pairs
    // (`【硬性要求】专名/术语对照: A→B、C→D`), and every instTrans benchmark case
    // carries it that way. It is a gate in the benchmark's own scoring, so this
    // is the one block whose exact shape is worth matching rather than approximating.
    hard.push(HARD_MARKER + "专名/术语对照: " + terminologyLines.join("、"));
    // Named once, not stamped on each pair: a challenged rendering is still the
    // rendering the chapter must use, and the correction happens in the glossary.
    const challenged = disputedTerms.filter((t) => terminologyLines.some((l) => l.startsWith(`${t}→`)));
    if (challenged.length > 0) {
      hard.push(
        HARD_MARKER +
          `上述术语中 ${challenged.join("、")} 的给定译法正在复核，仍须严格照用，不得自行改译（修正在术语表中完成）`
      );
    }
  }
  if (findingsText && findingsText.trim()) {
    hard.push(
      HARD_MARKER +
        "上一版译文存在以下问题，本次译文必须全部修正：\n" +
        indent(findingsText)
    );
  }
  if (scopeText && scopeText.trim()) hard.push(HARD_MARKER + scopeText.trim());

  // Soft constraints: graded, not binary — tone, register, and consistency
  // across sentences are exactly the family's 软约束 categories.
  const soft = [];
  if (styleRules && styleRules.trim()) {
    soft.push(SOFT_MARKER + "译文风格必须严格符合以下规则：\n" + indent(styleRules));
  }
  if (voiceNotes && voiceNotes.trim()) {
    soft.push(SOFT_MARKER + "以下角色既定的说话方式必须保留：\n" + indent(voiceNotes));
  }
  if (background && background.trim()) {
    soft.push(SOFT_MARKER + "人名、地名与剧情的背景信息：\n" + indent(background));
  }
  if (continuityText && continuityText.trim()) {
    soft.push(
      SOFT_MARKER +
        `本段紧接在${continuitySource}之后，上文结尾为"${continuityText}"。` +
        "人名、时态、语域与语气须与其保持一致。"
    );
  }
  return [...hard, ...soft];
}


/**
 * Fill the translate/retranslate user-prompt template (the canonical instTrans
 * single-user-message shape: the header, the 【源文】 block, the numbered
 * 【约束要求】 list, and the output-only suffix).
 *
 * @param {{template: string, sourceText: string, tasks: string[], sourceLanguage?: string, targetLanguage?: string, genre?: string}} p
 * @returns {string} The final single user message.
 */
function buildTranslationPrompt({ template, sourceText, tasks, sourceLanguage = "", targetLanguage = "English", genre }) {
  const header = template.includes(HEADER_CONSTRAINED_CLAUSE)
    ? HEADER_CONSTRAINED_CLAUSE
    : HEADER_PLAIN_CLAUSE;
  let out = template
    .replaceAll("{{SOURCE_LANGUAGE}}", languageName(sourceLanguage))
    .replaceAll("{{GENRE}}", genre || translateGenre())
    .replaceAll("{{TARGET_LANGUAGE}}", languageName(targetLanguage))
    .replaceAll("{{SOURCE_TEXT}}", sourceText);
  if (tasks.length === 0) {
    // Nothing to constrain: the plain canonical shape, with no empty
    // 【约束要求】 block promising constraints the prompt does not carry.
    out = out
      .replaceAll(header, HEADER_PLAIN_CLAUSE)
      .replaceAll(CONSTRAINTS_SECTION + "{{TASKS}}\n\n", "\n\n")
      .replaceAll(CONSTRAINTS_SECTION + "{{TASKS}}", "\n\n");
    return out.replaceAll("{{TASKS}}", "").trim() + "\n";
  }
  const numbered = tasks.map((t, i) => `${i + 1}. ${t}`).join("\n");
  return out.replaceAll("{{TASKS}}", numbered);
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
 * Build the translation task lines under the model's context budget, and the
 * final user message they go into.
 *
 * The thin wrapper the four translation stages call: it fits the reference
 * blocks into the role's window (fitPromptBudget), rebuilds the task lines from
 * what survived, fills the prompt template with them, and returns the drop list
 * so the caller can log it and record it in the chapter's QA row. The language
 * names and the genre are filled HERE rather than at each call site: the
 * budget and the request must describe the same message, and a stage that
 * budgeted one header and sent another is exactly the drift this wrapper exists
 * to prevent.
 *
 * @param {{
 *   background?: string,
 *   styleRules?: string,
 *   voiceNotes?: string,
 *   terminologyLines?: string[],
 *   disputedTerms?: string[],
 *   continuityText?: string,
 *   continuitySource?: string,
 *   findingsText?: string,
 *   sourceText: string,
 *   template: string,
 *   roleWindow: number,
 *   outputReserve: number,
 *   sourceLanguage?: string,
 *   targetLanguage?: string,
 *   genre?: string,
 *   label?: string,
 * }} p
 * @returns {{tasks: string[], prompt: string, dropped: Array<{name: string, chars: number}>, estimatedTokens: number}}
 */
function buildBudgetedTaskLines({
  background = "",
  styleRules = "",
  voiceNotes = "",
  terminologyLines = [],
  disputedTerms = [],
  continuityText = "",
  continuitySource = "上一章节",
  findingsText = "",
  scopeText = "",
  sourceText,
  template,
  roleWindow,
  outputReserve,
  sourceLanguage = "",
  targetLanguage = "English",
  genre,
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
  // The glossary is trimmed by LINES (so a long glossary keeps its head) but
  // emitted as ONE joined line, so the "N further lines were dropped" marker has
  // to be separated from the pairs before they are joined — otherwise the marker
  // becomes a term.
  const glossaryLines = pick("glossary") ? pick("glossary").split("\n") : [];
  const trimNote = glossaryLines.find((l) => l.startsWith("(… "));
  const terms = glossaryLines.filter((l) => !l.startsWith("(… "));
  const tasks = buildTranslationTaskLines({
    terminologyLines: terms,
    disputedTerms,
    background: pick("story background"),
    styleRules: pick("style rules"),
    voiceNotes: pick("voice notes"),
    continuityText: pick("continuity"),
    continuitySource,
    findingsText,
    scopeText,
  });
  if (trimNote) tasks.push(HARD_MARKER + trimNote);
  return {
    tasks,
    prompt: buildTranslationPrompt({
      template,
      sourceText,
      tasks,
      sourceLanguage,
      targetLanguage,
      genre,
    }),
    dropped: fitted.dropped,
    estimatedTokens: fitted.estimatedTokens,
  };
}

// ─── Chapter-list consistency (the handoff vs the extraction) ────────────────


module.exports = {
  HARD_MARKER,
  SOFT_MARKER,
  SOURCE_BLOCK,
  CONSTRAINTS_BLOCK,
  HEADER_CONSTRAINED_CLAUSE,
  HEADER_PLAIN_CLAUSE,
  CONSTRAINTS_SECTION,
  LANGUAGE_NAMES,
  languageName,
  translateGenre,
  buildTranslationTaskLines,
  buildTranslationPrompt,
  estimateTokens,
  chunkSafetyFraction,
  calibrateStageTokens,
  fitPromptBudget,
  describeDroppedBlocks,
  buildBudgetedTaskLines,
};
