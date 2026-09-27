/**
 * glossary.js — Logic for the "glossary" gulp task: building the canonical
 * target-language glossary for the series, driven from the source text, one
 * volume at a time.
 *
 * Task: glossary
 *   For each volume (in natural order):
 *     1. Read the volume's source text and the previous volume's glossary
 *        snapshot (the in-progress glossary; absent for the first volume).
 *     2. Extract only the NEW terms found in this volume's source (not already
 *        in the previous glossary) using the extraction prompts
 *        (system-prompts/glossary-terms.md and user-prompts/glossary-terms.md).
 *        (A single-shot call in both modes: exhaustive one-pass JSON.)
 *     3. Research those new terms:
 *        - agent: a researcher agent (harness.js) with
 *          Wikipedia tools decides per term what to search and extract, and
 *          writes the notes to <volume folder>/glossary-research.md.
 *     4. Amend the glossary — carry forward every existing term and add the
 *        new ones — using the amend prompts (system-prompts/glossary.md and
 *        user-prompts/glossary.md):
 *        - agent: an author agent (per-volume session) reads the
 *          materials with file tools and writes glossary.md directly.
 *     5. Save a per-volume snapshot to <volume folder>/glossary.md.
 *     6. Run the QA loop with the score-based acceptance criterion:
 *          a. Validate the glossary against the source (glossary-validator.md)
 *             — an independent validator agent writes the report.
 *          b. Acceptance check (glossary-acceptance.md): the model scores
 *             the glossary 0–100 (always a tool-less single-shot call).
 *          c. Track each score in a rolling window (default: last 5
 *             checks). When the window meets the acceptance criterion
 *             (rolling average of scores >= ACCEPTANCE_PASSING_SCORE,
 *             default 70 — see configs/shared.js) and we have at least
 *             MIN_SAMPLES (default: 3) checks, accept and stop.
 *          d. Otherwise, apply the feedback (glossary-feedback.md) and
 *             repeat from (a). In agent mode the same author session
 *             that wrote the glossary applies it.
 *   After all volumes, the last volume's glossary.md is copied to the series
 *   root (GLOSSARY_OUTPUT_FILE, default <SERIES_LOCATION>/glossary.md).
 *
 * Idempotent: a volume whose glossary already exists and passes the acceptance
 * check is skipped (unless --force). If any volume is regenerated, all later
 * volumes are regenerated too (each volume's glossary is built on the previous
 * one's, so a change propagates forward).
 *
 * Usage:
 *   npx gulp glossary             # run the full task
 *   npx gulp glossary --dry-run   # transform the prompts only, no API/research
 *   npx gulp glossary --force     # regenerate even if the glossary exists
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("./types"); // JSDoc type definitions
const harness = require("./harness");
const { transformUserPrompt, parseAcceptanceScore, validatorMaxStepsFor, writePromptDump } = require("./utils/prompt");
const { getTranslationTarget } = require("./get-translation-target");
const { AGENT_TOOLS_NOTE, RESEARCH_CONCURRENCY, ACCEPTANCE_WINDOW_SIZE, ACCEPTANCE_PASSING_SCORE, computeRollingAverage, meetsAcceptanceCriteria, isAcceptedState, saveRollingState, ON_VOLUME_ERROR, ON_MISSING_PREVIOUS, ON_QA_LIMIT, validateRequiredEnv } = require("./configs/shared");
const { fileExists, assertWrote, assertWroteWithFallback } = require("./utils/fs");
const {
  resolveSourceBundle,
  shouldProcessChunked,
  sourceMaterialLine,
  sourceSegmentListLine,
  chapterSegmentNote,
  chapterContextBlock,
} = require("./utils/source");

// ─── Paths ──────────────────────────────────────────────────────────────────

const clientDir = __dirname;
const seriesDir = process.env.SERIES_LOCATION;

const termsSystemPromptFile = path.join(clientDir, "system-prompts", "glossary-terms.md");
const termsUserPromptTemplateFile = path.join(clientDir, "user-prompts", "glossary-terms.md");
const glossarySystemPromptFile = path.join(clientDir, "system-prompts", "glossary.md");
const glossaryUserPromptTemplateFile = path.join(clientDir, "user-prompts", "glossary.md");
const validatorSystemPromptFile = path.join(clientDir, "system-prompts", "glossary-validator.md");
const validatorUserPromptTemplateFile = path.join(clientDir, "user-prompts", "glossary-validator.md");
const acceptanceSystemPromptFile = path.join(clientDir, "system-prompts", "glossary-acceptance.md");
const acceptanceUserPromptTemplateFile = path.join(clientDir, "user-prompts", "glossary-acceptance.md");
const feedbackSystemPromptFile = path.join(clientDir, "system-prompts", "glossary-feedback.md");
const feedbackUserPromptTemplateFile = path.join(clientDir, "user-prompts", "glossary-feedback.md");

// Maximum number of validation -> acceptance -> feedback iterations per volume
// before the glossary is left as-is. Read from .env, defaulting to 3.
const maxValidationIterations = Math.max(
  1,
  parseInt(process.env.QA_MAX_ITERATIONS, 10) || 3
);

// Whether to run web research for the new terms (default: enabled).
const researchEnabled = process.env.RESEARCH_ENABLED !== "false";

// ── Context window protection ────────────────────────────────────────────────

/**
 * When the previous glossary exceeds this size (bytes), truncate it to the
 * most recent entries so the author/validator agents don't overflow the
 * context window. The glossary is cumulative, so earlier entries are
 * carried forward unchanged — only conflicts with new terms need checking.
 *
 * @type {number}
 */
const GLOSSARY_TRUNCATION_THRESHOLD = 64 * 1024; // 64KB

/**
 * Maximum number of glossary entries to include when truncating.
 *
 * @type {number}
 */
const GLOSSARY_TRUNCATION_MAX_ENTRIES = 200;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Parse the AI's term-list output into an array of { term, type, query }.
 * Tolerates markdown fences and surrounding prose.
 *
 * @param {string} output - The raw AI output.
 * @returns {Array<{term: string, type: string, query: string}>}
 */
function parseTerms(output) {
  if (!output || typeof output !== "string") {
    return [];
  }
  let text = output.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }
  const firstBracket = text.indexOf("[");
  const lastBracket = text.lastIndexOf("]");
  if (firstBracket === -1 || lastBracket === -1 || lastBracket < firstBracket) {
    throw new Error("No JSON array found in the term-list output.");
  }
  const parsed = JSON.parse(text.slice(firstBracket, lastBracket + 1));
  if (!Array.isArray(parsed)) {
    throw new Error("The term-list output was not a JSON array.");
  }
  return parsed
    .filter((entry) => entry && typeof entry.term === "string" && entry.term.trim() !== "")
    .map((entry) => ({
      term: entry.term.trim(),
      type: typeof entry.type === "string" && entry.type.trim() !== "" ? entry.type.trim() : "concept",
      query: typeof entry.query === "string" && entry.query.trim() !== "" ? entry.query.trim() : entry.term.trim(),
    }));
}

// ─── Context truncation helpers ──────────────────────────────────────────────

/**
 * Truncate a glossary file to the most recent entries if it exceeds the
 * configured threshold. Returns the full content when under the threshold,
 * or the truncated content (with a header note) when over it.
 *
 * @param {string} content - The full glossary file content.
 * @returns {string} The (possibly truncated) content.
 */
function truncateGlossary(content) {
  if (!content || content.length <= GLOSSARY_TRUNCATION_THRESHOLD) {
    return content;
  }
  // Split by term entries: each term starts with "- " followed by the term name
  // and a colon or parenthesis (e.g. "- TermName: " or "- TermName (")).
  const entries = content.split(/^(- .+?[:\(])/m);
  // entries is: [header, term1Marker, term1Body, term2Marker, term2Body, ...]
  // Collect the header and term blocks.
  const header = entries[0];
  const termBlocks = [];
  for (let i = 1; i < entries.length - 1; i += 2) {
    termBlocks.push(entries[i] + entries[i + 1]);
  }
  if (termBlocks.length <= GLOSSARY_TRUNCATION_MAX_ENTRIES) {
    return content;
  }
  // Keep the last N entries.
  const keep = termBlocks.splice(-GLOSSARY_TRUNCATION_MAX_ENTRIES);
  const truncated = [
    header,
    `[TRUNCATED: previous glossary has ${termBlocks.length + keep.length} entries. ` +
      `Showing last ${keep.length} entries. Earlier entries are carried forward unchanged.]`,
    keep.join("\n"),
  ].join("\n\n");
  return truncated;
}

// ─── Parallel research helpers ──────────────────────────────────────────────

/**
 * Build a per-term research prompt that targets exactly one line in
 * glossary-research.md. Each call receives a unique term index so the
 * agent knows which "- (pending)" line to replace.
 *
 * @param {GlossaryVolumeCtx} ctx - The volume context.
 * @param {{term: string, type: string, query: string}} term - The term to research.
 * @param {number} index - Zero-based index of the term (used for approximate line counting).
 * @param {SourceSegment|null} [seg] - When set (chunked fallback), the term
 *   section lives under this chapter's heading instead of a line number.
 * @returns {string}
 */
function buildPerTermResearchPrompt(ctx, term, index, seg = null) {
  const { values } = ctx;
  // Approximate line number: each term in the skeleton gets ~3 lines
  const approxLine = 4 + index * 3;
  const sourceContextLine = seg
    ? `Context you may consult (optional): the chapter source "${seg.file}" (same folder) — read it selectively with readFile/grep if you need disambiguation; you do not need to read it all.`
    : ctx.bundle
      ? `${ctx.chunked ? sourceSegmentListLine(ctx.bundle) : sourceMaterialLine(ctx.bundle)} — read it selectively with readFile/grep if you need disambiguation; you do not need to read it all.`
      : `Context you may consult (optional): the volume source "${ctx.folderName}.md" (same folder) — read it selectively with readFile/grep if you need disambiguation; you do not need to read it all.`;
  const target = seg
    ? `the "- (pending)" line under the "### ${term.term}" heading in the "## Chapter ${seg.id}" section`
    : `that term's "- (pending)" line (approximately line ${approxLine})`;
  return (
    `Working folder: the volume folder (you are in it).\n\n` +
    `${sourceContextLine}\n\n` +
    `Your task: research the following term and write your notes to the file ` +
    `"glossary-research.md" in your working folder:\n\n` +
    `Term: ${term.term} (${term.type}) — suggested query: ${term.query}\n\n` +
    `The file "glossary-research.md" already exists. It contains a "- (pending)" ` +
    `placeholder line for this term (${target}). ` +
    `Use editFile to replace ONLY that "- (pending)" line with your final ` +
    `research notes. Do not modify any other term's notes.\n\n` +
    `Per-term budget: at most 2 wiki_search calls and 1 wiki_extract call. Start ` +
    `from the suggested query; search in the source language first, then English ` +
    `if useful.\n\n` +
    `Final notes format (replacing the "- (pending)" line):\n` +
    `- <page title> (<lang>) — <URL>\n` +
    `  <1-3 sentence summary: what the term is and any established ` +
    `${values.TARGET_LANGUAGE} name>\n\n` +
    `Rules:\n` +
    `- Report only what the tools actually say — no speculation, no invented references.\n` +
    `- Never paste file contents into your chat reply.\n` +
    `- When done, reply with a short summary.\n` +
    `- If the term is not found on Wikipedia, write: "- (not found) — no relevant results.\n  The term may be specific to this series; check the source text for context."`
  );
}

/**
 * Research a single term using a dedicated agent. The agent targets exactly
 * one unique line in glossary-research.md via editFile, so multiple agents
 * can run in parallel without conflicts.
 *
 * @param {GlossaryVolumeCtx} ctx - The volume context.
 * @param {{term: string, type: string, query: string}} term - The term to research.
 * @param {number} index - Zero-based index of the term.
 * @param {SourceSegment|null} [seg] - The chapter the term was extracted from
 *   (chunked fallback only; scopes the optional source read to that chapter).
 * @returns {Promise<void>}
 */
async function researchOneTerm(ctx, term, index, seg = null) {
  // Fail loudly on a wiring bug instead of registering undefined tools —
  // an undefined tool entry makes the model's first call throw the cryptic
  // "Cannot read properties of undefined (reading 'execute')" (observed live
  // when ctx.wikiTools was never assigned).
  const wikiTools = ctx.wikiTools;
  if (!wikiTools || !wikiTools.wiki_search || !wikiTools.wiki_extract) {
    throw new Error(
      `Volume ${ctx.values.INSTALLMENT_NUMBER}: the per-term researcher agent has no ` +
        `wiki tools (ctx.wikiTools is missing or incomplete). Set ` +
        `ctx.wikiTools = harness.createWikiTools() in runVolumeAgent before researchBatch runs.`
    );
  }
  const agent = await harness.createAgentHandle({
    name: `researcher-${term.term.replace(/\s+/g, "-")}`,
    systemPrompt: RESEARCHER_SYSTEM_PROMPT,
    tools: { wiki_search: wikiTools.wiki_search, wiki_extract: wikiTools.wiki_extract, ...ctx.fsGate.tools },
    approve: ctx.fsGate.approve,
    cwd: ctx.volumeDir,
    maxSteps: 15, // 2 wiki_search + 1 wiki_extract + 1 editFile + overhead
  });
  try {
    await agent.sendTurn(
      buildPerTermResearchPrompt(ctx, term, index, seg),
      { label: `glossary-research-term-${ctx.values.INSTALLMENT_NUMBER}-${term.term.slice(0, 20)}` }
    );
  } finally {
    await agent.close();
  }
}

/**
 * Research a batch of terms concurrently (Promise.allSettled).
 * Failed terms leave their "- (pending)" placeholder in place.
 *
 * @param {GlossaryVolumeCtx} ctx - The volume context.
 * @param {Array<{term: string, type: string, query: string, _idx: number}>} batch - Terms to research in this batch (each with a _idx property for the original index).
 * @param {SourceSegment|null} [seg] - The chapter the batch was extracted from
 *   (chunked fallback only).
 * @returns {Promise<void>}
 */
async function researchBatch(ctx, batch, seg = null) {
  const results = await Promise.allSettled(
    batch.map((term) => researchOneTerm(ctx, term, term._idx, seg))
  );
  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length > 0) {
    console.warn(
      `Volume ${ctx.values.INSTALLMENT_NUMBER}: ${failed.length}/${batch.length} term(s) failed research`
    );
  }
}

// ─── Agent-mode prompt builders ─────────────────────────────────────────────
// The exact prompts the agent-mode stages send are built here (not inline in
// the run loops) so --dry-run can dump them and the tests can assert on them
// without any AI call.

/** The researcher agent's system prompt (static). */
const RESEARCHER_SYSTEM_PROMPT =
  "You are a reference researcher supporting the translation of a novel series. " +
  "For each new glossary term you are given, find out what it is (character, place, " +
  "item, faction, or concept) using the wiki_search and wiki_extract tools " +
  "(Wikipedia), and write concise notes a translator can use to pick a canonical " +
  "target-language rendering. You also have file tools for the working folder " +
  "described in the request. Report only what the tool results actually say — no " +
  "speculation, no invented references. Never paste file contents into your chat " +
  "reply; when done, reply with a short summary.";

/**
 * The researcher agent's turn prompt (agent mode).
 *
 * @param {GlossaryVolumeCtx} ctx - The volume context.
 * @param {Array<{term: string, type: string, query: string}>} terms - The new terms.
 * @returns {string}
 */
function buildGlossaryResearcherTurnPrompt(ctx, terms) {
  const { values } = ctx;
  const termsListText = terms
    .map((t) => `- ${t.term} (${t.type}) — suggested query: ${t.query}`)
    .join("\n");
  const sourceContextLine = ctx.bundle
    ? `${ctx.chunked ? sourceSegmentListLine(ctx.bundle) : sourceMaterialLine(ctx.bundle)} — read it selectively with readFile/grep if a term needs disambiguation; you do not need to read it all.`
    : `Context you may consult (optional): the volume source "${ctx.folderName}.md" (same folder) — read it selectively with readFile/grep if a term needs disambiguation; you do not need to read it all.`;
  return (
    `Working folder: the volume folder (you are in it).\n\n` +
    `${sourceContextLine}\n\n` +
    `The notes file "glossary-research.md" in your working folder already exists and ` +
    `contains a section for each of the following terms, each with the placeholder ` +
    `line "- (pending)":\n${termsListText}\n\n` +
    `Your job: for each term, research it, then IMMEDIATELY use editFile to replace ` +
    `that term's "- (pending)" line with its final notes. Do not wait until the end ` +
    `to write anything — save progress after every term.\n\n` +
    `Per-term budget: at most 2 wiki_search calls and 1 wiki_extract call. Start ` +
    `from the suggested query; search in the source language first, then English ` +
    `if useful.\n\n` +
    `Final notes format for each term (replacing the "- (pending)" line):\n` +
    `- <page title> (<lang>) — <URL>\n` +
    `  <1-3 sentence summary: what the term is and any established ` +
    `${values.TARGET_LANGUAGE} name>\n\n` +
    `Rules:\n` +
    `- If a term has no external reference, replace "- (pending)" with ` +
    `"- (no external reference found)".\n` +
    `- Keep each term's notes under about 5 lines.\n` +
    `- If you are running low on steps, stop researching and make sure every ` +
    `remaining "- (pending)" line has been replaced (a short note or ` +
    `"- (no external reference found)" is fine).`
  );
}

/**
 * The author agent's turn prompt (agent mode): the amended-glossary request
 * with the term list and research-notes references filled in.
 *
 * With `seg` set (chunked fallback) the prompt is scoped to one chapter: the
 * source line names the chapter file, and the "previous glossary" line points
 * at the previous volume (first chapter) or at the current in-volume state
 * (later chapters).
 *
 * @param {GlossaryVolumeCtx} ctx - The volume context (must include glossaryTemplate).
 * @param {Array<{term: string, type: string, query: string}>} terms - The new terms.
 * @param {boolean} researchNotesAvailable - Whether glossary-research.md exists.
 * @param {SourceSegment|null} [seg] - The chapter being processed (fallback).
 * @param {number} [si] - Zero-based position of the chapter in reading order.
 * @returns {string}
 */
function buildGlossaryAuthorTurnPrompt(ctx, terms, researchNotesAvailable, seg = null, si = null) {
  const { values, isFirst, previousFolderName } = ctx;
  const termsListText =
    terms.length > 0
      ? terms.map((t) => `- ${t.term} (${t.type})`).join("\n")
      : "(no new terms found in this volume)";
  const researchNotesPlaceholder = researchNotesAvailable
    ? `The research notes for the new terms are in the file "glossary-research.md" in your working folder (read it with readFile).`
    : "(research disabled or no new terms to research)";
  const amendPrompt = transformUserPrompt(ctx.glossaryTemplate, {
    ...values,
    TERMS_LIST: termsListText,
    RESEARCH_NOTES: researchNotesPlaceholder,
  });
  let sourceLine;
  let previousGlossaryLine;
  let chapterBlock = "";
  if (seg) {
    sourceLine = `- The chapter source: "${seg.file}" (same folder)`;
    previousGlossaryLine =
      si === 0
        ? isFirst
          ? "- The previous glossary: (absent — this is the first volume)"
          : `- The previous glossary: "../${previousFolderName}/glossary.md"`
        : `- The current glossary (state after the earlier chapters of this volume): "glossary.md" (same folder)`;
    chapterBlock = chapterContextBlock(values, ctx.bundle, seg, si);
  } else {
    sourceLine =
      ctx.bundle
        ? sourceMaterialLine(ctx.bundle)
        : `- The volume source: "${ctx.folderName}.md" (same folder)`;
    previousGlossaryLine = isFirst
      ? "- The previous glossary: (absent — this is the first volume)"
      : `- The previous glossary: "../${previousFolderName}/glossary.md"`;
  }
  return (
    `Working folder: the volume folder (you are in it).\n\n` +
    chapterBlock +
    `Materials (read with readFile before writing anything):\n` +
    `${sourceLine}\n` +
    previousGlossaryLine +
    `\n\n` +
    `Write the complete amended glossary to the file "glossary.md" in your working ` +
    `folder (writeFile, complete contents).\n\n` +
    amendPrompt
  );
}

/**
 * The validator agent's turn prompt (agent mode, one fresh agent per QA
 * iteration).
 *
 * @param {GlossaryVolumeCtx} ctx - The volume context (must include validatorPrompt).
 * @returns {string}
 */
function buildGlossaryValidatorTurnPrompt(ctx) {
  const { isFirst, previousFolderName } = ctx;
  const previousGlossaryLine = isFirst
    ? ""
    : `- The previous glossary: "../${previousFolderName}/glossary.md"\n`;
  const sourceLine = ctx.bundle
    ? sourceMaterialLine(ctx.bundle)
    : `- The volume source: "${ctx.folderName}.md" (same folder)`;
  return (
    `Working folder: the volume folder (you are in it).\n\n` +
    `Materials (read with readFile before writing anything):\n` +
    `${sourceLine}\n` +
    `- The amended glossary under audit: "glossary.md" (same folder)\n` +
    previousGlossaryLine +
    `\n` +
    `Write the complete validation report to the file "glossary-validation.md" in ` +
    `your working folder (writeFile, exact format from the system prompt).\n\n` +
    ctx.validatorPrompt
  );
}

/**
 * The author agent's feedback turn prompt (agent mode).
 *
 * @param {GlossaryVolumeCtx} ctx - The volume context (must include feedbackPrompt).
 * @returns {string}
 */
function buildGlossaryFeedbackTurnPrompt(ctx) {
  const { isFirst, previousFolderName } = ctx;
  const previousGlossaryLine = isFirst
    ? ""
    : `- The previous glossary: "../${previousFolderName}/glossary.md"\n`;
  const sourceLine = ctx.bundle
    ? sourceMaterialLine(ctx.bundle)
    : `- The volume source: "${ctx.folderName}.md" (same folder)`;
  return (
    `Working folder: the volume folder (you are in it).\n\n` +
    `The validation report "glossary-validation.md" in your working folder is your ` +
    `work order.\n` +
    `Materials (read with readFile before changing anything):\n` +
    `${sourceLine}\n` +
    `- The current glossary to correct: "glossary.md" (same folder)\n` +
    previousGlossaryLine +
    `\n` +
    `Apply the report's findings and write the complete corrected glossary back to ` +
    `"glossary.md" using writeFile (complete contents, overwrite). Use editFile only for ` +
    `targeted fixes. Make the smallest changes that resolve each valid finding.\n\n` +
    ctx.feedbackPrompt
  );
}

/**
 * Run the glossary task.
 */
async function glossary() {
  const dryRun = process.argv.includes("--dry-run");
  const force = process.argv.includes("--force");
  // Force the chapter-by-chapter fallback for every multi-chapter epub volume
  // (the default is whole-installment processing; the fallback also triggers
  // automatically when the whole text exceeds SOURCE_CHUNK_THRESHOLD_CHARS).
  const chunkedArg = process.argv.includes("--chunked");

  if (!seriesDir) {
    throw new Error("SERIES_LOCATION is not set. Please set it in .env.");
  }
  // Fail fast (before any AI call) if required env vars are missing — the
  // aggregated message names every missing variable (SERIES_NAME, and
  // AI_API_KEY when not --dry-run).
  validateRequiredEnv({ dryRun });

  // Load the system prompts.
  const termsSystemPrompt = await fs.readFile(termsSystemPromptFile, "utf-8");
  const glossarySystemPrompt = await fs.readFile(glossarySystemPromptFile, "utf-8");
  const validatorSystemPrompt = await fs.readFile(validatorSystemPromptFile, "utf-8");
  const acceptanceSystemPrompt = await fs.readFile(acceptanceSystemPromptFile, "utf-8");
  const feedbackSystemPrompt = await fs.readFile(feedbackSystemPromptFile, "utf-8");

  // Load the prompt templates.
  const termsTemplate = await fs.readFile(termsUserPromptTemplateFile, "utf-8");
  const glossaryTemplate = await fs.readFile(glossaryUserPromptTemplateFile, "utf-8");
  const validatorTemplate = await fs.readFile(validatorUserPromptTemplateFile, "utf-8");
  const acceptanceTemplate = await fs.readFile(acceptanceUserPromptTemplateFile, "utf-8");
  const feedbackTemplate = await fs.readFile(feedbackUserPromptTemplateFile, "utf-8");

  // Discover the volumes with the AI-driven translation-target manifest (see
  // get-translation-target.js). It yields, in reading order, each volume's
  // folder and its exact source file, so nothing below has to guess names.
  const manifest = await getTranslationTarget({ force, dryRun });
  const sorted = manifest.volumes.map((v) => v.folder);
  const volumeByFolder = new Map(manifest.volumes.map((v) => [v.folder, v]));

  if (sorted.length === 0) {
    throw new Error(`No volume folders found in ${seriesDir}.`);
  }

  // Optional: process a single volume only ("--volume 01" or "--volume=01"),
  // e.g. for a live test before a full-series run. The previous volume is
  // still looked up in the full series (so --volume 05 needs volume 04).
  const volumeArg =
    (process.argv.find((a) => a.startsWith("--volume=")) || "").replace("--volume=", "") ||
    (process.argv.includes("--volume")
      ? process.argv[process.argv.indexOf("--volume") + 1]
      : null);
  let volumes = sorted;
  if (volumeArg) {
    const wanted = String(parseInt(volumeArg, 10)).padStart(2, "0");
    volumes = sorted.filter((name) => {
      const m = name.match(/\((\d+)\)\s*$/);
      return m && m[1].padStart(2, "0") === wanted;
    });
    if (volumes.length === 0) {
      throw new Error(`No volume folder matching --volume ${volumeArg}.`);
    }
    console.log(`--volume: processing only volume ${wanted}`);
  }

  console.log(`Found ${sorted.length} volume folder(s). Processing in order...`);

  // Once any volume is regenerated, all later volumes must be regenerated too
  // (each volume's glossary is built on the previous one's).
  let regeneratedAny = false;
  const failedVolumes = [];

  for (const folderName of volumes) {
    try {
    const i = sorted.indexOf(folderName);
    const volume = volumeByFolder.get(folderName);
    const volumeDir = path.join(seriesDir, folderName);
    // Resolve the source into a bundle: plain-text sources pass through as-is
    // (the default whole-installment path); .epub sources are normalized once
    // (cached) into <base>-whole.md + per-chapter files + images/ in the
    // volume folder. The pipelines then work on plain text only.
    const bundle = await resolveSourceBundle({ seriesDir, volume, volumeDir, force });
    const sourceFile = bundle.wholePath;
    const processChunked = shouldProcessChunked(bundle, { forceChunked: chunkedArg });
    console.log(
      `Volume ${volume.installmentNumber}: source "${path.basename(bundle.originalPath)}" → ${bundle.format} ` +
        `(${bundle.wholeChars} chars, ${bundle.segments.length} segment(s)) — processing ` +
        (processChunked
          ? "chapter by chapter (fallback: whole installment too large for one pass)"
          : "as the whole installment (default)") +
        "."
    );
    const glossaryOutputFile = path.join(volumeDir, "glossary.md");
    const validationOutputFile = path.join(volumeDir, "glossary-validation.md");
    const researchNotesFile = path.join(volumeDir, "glossary-research.md");

    if (!(await fileExists(bundle.originalPath))) {
      throw new Error(`Required source file not found: ${bundle.originalPath}`);
    }

    const values = {
      INSTALLMENT_NUMBER: volume.installmentNumber,
      SOURCE_NAME: process.env.SERIES_NAME,
      SOURCE_LANGUAGE: process.env.TRANSLATION_SOURCE_LANGUAGE || "Japanese",
      TARGET_LANGUAGE: process.env.TRANSLATION_TARGET_LANGUAGE || "English",
    };

    // The previous volume's glossary (the in-progress glossary). Absent for the
    // first volume.
    const isFirst = i === 0;
    let previousGlossaryFile = null;
    let previousFolderName = null;
    if (!isFirst) {
      previousFolderName = sorted[i - 1];
      previousGlossaryFile = path.join(seriesDir, previousFolderName, "glossary.md");
      if (!(await fileExists(previousGlossaryFile))) {
        if (dryRun) {
          console.warn(
            `Volume ${values.INSTALLMENT_NUMBER}: --dry-run: the previous glossary ` +
              `(${previousGlossaryFile}) does not exist yet — a live run would stop ` +
              `here. Continuing the prompt preview.`
          );
        } else if (ON_MISSING_PREVIOUS === "skip") {
          console.log(
            `Volume ${values.INSTALLMENT_NUMBER}: previous glossary not found ` +
              `(${previousGlossaryFile}) — skipping this volume ` +
              `(ON_MISSING_PREVIOUS=skip).`
          );
          continue;
        } else {
          throw new Error(
            `Previous glossary not found: ${previousGlossaryFile}. ` +
              `Process the earlier volume first (or re-run without --force), ` +
              `or set ON_MISSING_PREVIOUS=skip to skip this volume.`
          );
        }
      }
    }

    // Transform the prompts that use only the standard placeholders.
    const termsPrompt = transformUserPrompt(termsTemplate, values);
    const validatorPrompt = transformUserPrompt(validatorTemplate, values);
    const feedbackPrompt = transformUserPrompt(feedbackTemplate, values);
    const acceptancePrompt = transformUserPrompt(acceptanceTemplate, values);

    const ctx = {
      values,
      folderName,
      volumeDir,
      sourceFile,
      bundle,
      chunked: processChunked,
      glossaryOutputFile,
      validationOutputFile,
      researchNotesFile,
      isFirst,
      previousFolderName,
      previousGlossaryFile,
      termsPrompt,
      validatorPrompt,
      feedbackPrompt,
      acceptancePrompt,
      glossaryTemplate,
      termsSystemPrompt,
      glossarySystemPrompt,
      validatorSystemPrompt,
      acceptanceSystemPrompt,
      feedbackSystemPrompt,
    };

    if (dryRun) {
      // The term-dependent prompts carry an illustrative term list (the real
      // list only exists after the extraction call, which dry-run skips).
      const illustrativeTerms = [
        { term: "（例の用語）", type: "character", query: "（例の用語）" },
      ];
      const sections = [
        { title: "One-shot — terms extraction system prompt", prompt: termsSystemPrompt },
        { title: "One-shot — terms extraction user prompt", prompt: termsPrompt },
        { title: "AGENT — researcher system prompt", prompt: RESEARCHER_SYSTEM_PROMPT },
        {
          title: "AGENT — per-term researcher turn (illustrative term list, concurrency=" + RESEARCH_CONCURRENCY + ")",
          prompt: buildPerTermResearchPrompt(ctx, illustrativeTerms[0], 0),
        },
        { title: "AGENT — author system prompt", prompt: glossarySystemPrompt + AGENT_TOOLS_NOTE },
        {
          title: "AGENT — author turn (illustrative term list)",
          prompt: buildGlossaryAuthorTurnPrompt(ctx, illustrativeTerms, false),
        },
        { title: "AGENT — validator system prompt", prompt: validatorSystemPrompt + AGENT_TOOLS_NOTE },
        { title: "AGENT — validator turn", prompt: buildGlossaryValidatorTurnPrompt(ctx) },
        { title: "AGENT — feedback turn (applied by the author session)", prompt: buildGlossaryFeedbackTurnPrompt(ctx) },
        { title: "One-shot — acceptance user prompt (always tool-less)", prompt: acceptancePrompt },
      ];
      // Chunked (fallback) volumes: dump the chapter-scoped variants too.
      if (ctx.chunked && bundle.segments.length > 1) {
        const seg = bundle.segments[0];
        sections.push(
          {
            title: "CHUNKED — per-chapter terms extraction user prompt (first chapter)",
            prompt: termsPrompt + "\n\n" + chapterSegmentNote(bundle, seg, 0),
          },
          {
            title: "CHUNKED — segment author turn (illustrative term list)",
            prompt: buildGlossaryAuthorTurnPrompt(ctx, illustrativeTerms, false, seg, 0),
          },
          {
            title: "CHUNKED — segment validator turn (first chapter)",
            prompt: buildGlossarySegmentValidatorPrompt(ctx, seg, 0),
          },
          { title: "CHUNKED — findings merge turn", prompt: buildGlossaryFindingsMergePrompt(ctx) },
          {
            title: "CHUNKED — segment feedback turn (first chapter)",
            prompt: buildGlossarySegmentFeedbackPrompt(ctx, seg, 0),
          }
        );
      }
      const dumpFile = await writePromptDump(
        "glossary",
        values.INSTALLMENT_NUMBER,
        "agent",
        sections
      );
      console.log(
        `Volume ${values.INSTALLMENT_NUMBER}: --dry-run: no AI calls. ` +
          `The exact prompts (agent-mode turns + tool-less stages) ` +
          `are written to ${dumpFile}`
      );
      continue;
    }

    // Idempotency: skip a volume whose glossary already exists and met the
    // score-based acceptance criterion, unless a previous volume was
    // regenerated (which would make it stale).
    //
    // Instead of re-calling the AI, we read the persisted rolling window
    // state file (glossary-validation-rolling-state.json) and recompute the
    // acceptance decision deterministically.  If the state file is missing
    // or corrupt we fall back to regenerating (fail-open).
    let skip = false;
    if (!force && !regeneratedAny && (await fileExists(glossaryOutputFile))) {
      const stateFilePath = validationOutputFile.replace(".md", "-rolling-state.json");
      const { loadRollingState } = require("./configs/shared");
      const state = await loadRollingState(stateFilePath);
      if (state) {
        const avg = computeRollingAverage(state.results);
        skip = isAcceptedState(state);
        if (skip) {
          console.log(
            `Volume ${values.INSTALLMENT_NUMBER}: rolling-state ` +
              `(${state.results.length} checks, avg ${avg.toFixed(1)}) ` +
              `meets the criterion. Skipping.`
          );
        }
      }
      // state === null → skip stays false (fail-open)
    }
    if (skip) {
      console.log(
        `Volume ${values.INSTALLMENT_NUMBER}: glossary already exists and passed. Skipping.`
      );
      continue;
    }

    // A volume is being (re)generated; later volumes depend on it.
    regeneratedAny = true;

    await runVolumeAgent(ctx);
    } catch (err) {
      // Volume-level error isolation (ON_VOLUME_ERROR): "skip" records the
      // failure and continues with the next volume (an un-monitored run must
      // not die on one broken volume); "abort" (default) rethrows and fails
      // the task as before.
      if (ON_VOLUME_ERROR !== "skip") throw err;
      failedVolumes.push({ folder: folderName, error: err });
      const entry = volumeByFolder.get(folderName);
      console.error(
        `[skip] Volume ${entry ? entry.installmentNumber : folderName} ` +
          `(${folderName}) failed: ${err.message} — continuing with the next ` +
          `volume (ON_VOLUME_ERROR=skip).`
      );
    }
  }

  if (failedVolumes.length > 0) {
    console.error(
      `\n${failedVolumes.length} of ${volumes.length} volume(s) failed: ` +
        `${failedVolumes.map((v) => `${v.folder} (${v.error.message})`).join("; ")}. ` +
        `Re-run the task (idempotent) to pick them up.`
    );
  }

  // Copy the last volume's glossary to the series root for easy access
  // (skipped for single-volume runs, which would publish a stale snapshot).
  if (volumeArg) {
    console.log("\n--volume: skipping the series-root copy (single-volume run).");
  } else {
    const finalGlossaryFile =
      process.env.GLOSSARY_OUTPUT_FILE || path.join(seriesDir, "glossary.md");
    let lastGlossary = null;
    for (let i = sorted.length - 1; i >= 0; i--) {
      const candidate = path.join(seriesDir, sorted[i], "glossary.md");
      if (await fileExists(candidate)) {
        lastGlossary = candidate;
        break;
      }
    }
    if (lastGlossary) {
      await fs.copyFile(lastGlossary, finalGlossaryFile);
      console.log(`\nCopied the final glossary to: ${finalGlossaryFile}`);
    } else {
      console.log("\nNo glossary snapshots found; nothing to copy to the series root.");
    }
  }
}

/**
 * Shared acceptance check: always a tool-less single-shot call.
 * The model scores the audited output 0–100 (100 = perfect, 0 = atrocious);
 * the score — not a binary verdict — is what the rolling window tracks.
 *
 * @param {GlossaryVolumeCtx} ctx - The volume context (see glossary()).
 * @param {number} iteration - The current QA iteration (for the log label).
 * @returns {Promise<number | null>} The parsed score (0–100), or `null` when
 *   no valid score could be extracted (treated as a failed check).
 */
async function acceptanceCheck(ctx, iteration) {
  const { values, validationOutputFile, acceptancePrompt, acceptanceSystemPrompt } = ctx;
  const acceptanceOutput = await harness.runOneShot({
    systemPrompt: acceptanceSystemPrompt,
    messages: [
      { file: validationOutputFile, name: "glossary-validation.md" },
      { text: acceptancePrompt },
    ],
    label: `glossary-acceptance-${values.INSTALLMENT_NUMBER}-${iteration}`,
  });
  const score = parseAcceptanceScore(acceptanceOutput);
  if (score === null) {
    console.log(
      `Volume ${values.INSTALLMENT_NUMBER}: acceptance check: no valid score in ` +
        `response (got: ${JSON.stringify(acceptanceOutput.trim().slice(0, 120))}). ` +
        `Counting this check as a failure.`
    );
  } else {
    console.log(
      `Volume ${values.INSTALLMENT_NUMBER}: acceptance check: score ${score}/100 ` +
        `(passing score: ${ACCEPTANCE_PASSING_SCORE})`
    );
  }
  return score;
}

/**
 * The per-chapter validator turn prompt (chunked fallback). Each pass audits
 * the glossary against ONE chapter and writes a partial report named
 * glossary-validation-<id>.md; the findings-merge pass consolidates the
 * partials into the standard glossary-validation.md.
 *
 * @param {GlossaryVolumeCtx} ctx - The volume context.
 * @param {SourceSegment} segment - The chapter being audited.
 * @param {number} si - Zero-based position in reading order.
 * @returns {string}
 */
function buildGlossarySegmentValidatorPrompt(ctx, segment, si) {
  const { values, isFirst, previousFolderName } = ctx;
  const partialFile = `glossary-validation-${segment.id}.md`;
  const previousGlossaryLine = isFirst
    ? ""
    : `- The previous glossary: "../${previousFolderName}/glossary.md"\n`;
  return (
    `Working folder: the volume folder (you are in it).\n\n` +
    chapterContextBlock(values, ctx.bundle, segment, si) +
    `This is a per-chapter validation pass: audit the glossary against ONE chapter only.\n` +
    `Materials (read with readFile before writing anything):\n` +
    `- The chapter source: "${segment.file}" (same folder)\n` +
    `- The glossary under audit: "glossary.md" (same folder)\n` +
    previousGlossaryLine +
    `\n` +
    `Check that everything this chapter introduces (terms, names, concepts) is ` +
    `covered correctly in the glossary, and that nothing contradicts the chapter. ` +
    `Tag every finding with the chapter id "${segment.id}" (e.g. a prefix "[${segment.id}] ").\n` +
    `Write the partial validation report to the file "${partialFile}" in your working ` +
    `folder (writeFile, the report format from the system prompt).\n\n` +
    ctx.validatorPrompt
  );
}

/**
 * The findings-merge turn prompt (chunked fallback): consolidates the
 * per-chapter partial reports into the standard glossary-validation.md so the
 * unchanged acceptance one-shot can score it.
 *
 * @param {GlossaryVolumeCtx} ctx - The volume context.
 * @returns {string}
 */
function buildGlossaryFindingsMergePrompt(ctx) {
  const { values } = ctx;
  const list = ctx.bundle.segments
    .map((s) => `- "glossary-validation-${s.id}.md" (chapter ${s.id})`)
    .join("\n");
  return (
    `Working folder: the volume folder (you are in it).\n\n` +
    `You are consolidating the per-chapter validation partials of volume ` +
    `${values.INSTALLMENT_NUMBER} into the single standard validation report.\n` +
    `Materials (read with readFile before writing anything):\n` +
    list +
    `\n\n` +
    `Write the consolidated report to the file "glossary-validation.md" in your ` +
    `working folder (writeFile, complete contents) using EXACTLY the report format ` +
    `from your system prompt. Preserve the chapter tags on the findings, keep every ` +
    `valid finding (deduplicate repeats), and produce the summary/verdict sections ` +
    `the format requires, as if you had audited the whole volume in one pass.`
  );
}

/**
 * The per-chapter feedback turn prompt (chunked fallback): applies the
 * chapter-tagged findings of the consolidated report to the glossary.
 *
 * @param {GlossaryVolumeCtx} ctx - The volume context.
 * @param {SourceSegment} segment - The chapter whose findings are applied.
 * @param {number} si - Zero-based position in reading order.
 * @returns {string}
 */
function buildGlossarySegmentFeedbackPrompt(ctx, segment, si) {
  const { values } = ctx;
  return (
    `Working folder: the volume folder (you are in it).\n\n` +
    chapterContextBlock(values, ctx.bundle, segment, si) +
    `The validation report "glossary-validation.md" in your working folder is your ` +
    `work order — apply ONLY the findings tagged with chapter "${segment.id}".\n` +
    `Materials (read with readFile before changing anything):\n` +
    `- The chapter source: "${segment.file}" (same folder)\n` +
    `- The current glossary to correct: "glossary.md" (same folder)\n` +
    `\n` +
    `Apply the chapter's findings and write the complete corrected glossary back to ` +
    `"glossary.md" using writeFile (complete contents, overwrite). Use editFile only ` +
    `for targeted fixes. Make the smallest changes that resolve each valid finding; ` +
    `do not touch entries this chapter's findings do not concern.\n\n` +
    ctx.feedbackPrompt
  );
}

/**
 * Create or extend the skeleton-first research notes file with this chapter's
 * terms (chunked fallback). Chapter 1 creates the file with the volume header;
 * later chapters append a "## Chapter <id>" section. Each term gets a
 * "### <term>" heading with a "- (pending)" placeholder line.
 *
 * @param {string} researchNotesFile - Absolute path of glossary-research.md.
 * @param {{INSTALLMENT_NUMBER: string}} values - The volume values.
 * @param {SourceSegment} segment - The chapter being researched.
 * @param {Array<{term: string, type: string, query: string}>} terms - Its new terms.
 * @param {boolean} isFirstChapter - True for the first chapter of the volume.
 * @returns {Promise<void>}
 */
async function appendResearchSkeleton(researchNotesFile, values, segment, terms, isFirstChapter) {
  const section = [`## Chapter ${segment.id} — ${segment.title}`, ""];
  for (const t of terms) {
    section.push(`### ${t.term}`);
    section.push("- (pending)");
  }
  section.push("");
  const text = section.join("\n");
  if (isFirstChapter || !(await fileExists(researchNotesFile))) {
    await fs.writeFile(
      researchNotesFile,
      `# Research Notes — Volume ${values.INSTALLMENT_NUMBER}\n\n${text}`,
      "utf8"
    );
  } else {
    await fs.appendFile(researchNotesFile, `\n${text}`, "utf8");
  }
}

/**
 * Process a single volume chapter by chapter (the FALLBACK path, used when
 * the whole installment is too large for one pass): each chapter segment goes
 * through the same stage sequence a whole volume does — extract → research →
 * amend — chained so each chapter builds on the previous one's glossary
 * state. The QA loop then validates the finished volume chapter by chapter
 * (per-chapter partial reports → findings merge → acceptance) with
 * per-chapter feedback passes.
 *
 * @param {GlossaryVolumeCtx} ctx - The volume context (must include bundle).
 */
async function runChunkedVolumeAgent(ctx) {
  const {
    values,
    bundle,
    volumeDir,
    glossaryOutputFile,
    researchNotesFile,
    isFirst,
    previousGlossaryFile,
    termsPrompt,
    termsSystemPrompt,
  } = ctx;
  console.log(
    `Volume ${values.INSTALLMENT_NUMBER}: chapter-by-chapter fallback ` +
      `(${bundle.segments.length} segments, ${bundle.wholeChars} chars whole)...`
  );

  const fsGate = await harness.createGatedFsTools({ cwd: volumeDir, allowedDirs: [volumeDir] });
  ctx.fsGate = fsGate;
  ctx.wikiTools = harness.createWikiTools();

  // Stale stray from earlier runs (same name anchor as the whole flow).
  const strayGlossary = path.join(volumeDir, `glossary-${values.INSTALLMENT_NUMBER}.md`);
  if (await fileExists(strayGlossary)) {
    await fs.rm(strayGlossary);
    console.log(`Removed the stale file "${strayGlossary}" (leftover from a previous run).`);
  }

  for (let si = 0; si < bundle.segments.length; si++) {
    const segment = bundle.segments[si];
    // 1. Extract this chapter's new terms (one-shot). The cumulative reference
    // is the previous volume's glossary for the first chapter and the current
    // in-volume glossary afterwards.
    console.log(
      `Volume ${values.INSTALLMENT_NUMBER}: chapter ${segment.id} (${segment.title}), ` +
        `${si + 1}/${bundle.segments.length} — extracting terms...`
    );
    const messages = [{ file: path.join(volumeDir, segment.file), name: segment.file }];
    const stateFile = si === 0 ? previousGlossaryFile : glossaryOutputFile;
    if (stateFile) {
      messages.push({ file: stateFile, name: si === 0 ? "glossary-previous.md" : "glossary-current.md" });
    }
    messages.push({ text: termsPrompt }, { text: chapterSegmentNote(bundle, segment, si) });
    const termsOutput = await harness.runOneShot({
      systemPrompt: termsSystemPrompt,
      messages,
      label: `glossary-terms-${values.INSTALLMENT_NUMBER}-${segment.id}`,
    });
    let terms = [];
    try {
      terms = parseTerms(termsOutput);
    } catch (err) {
      console.warn(
        `Volume ${values.INSTALLMENT_NUMBER}: could not parse the term list for ` +
          `chapter ${segment.id} (${err.message}). Continuing without research.`
      );
    }
    console.log(
      `Volume ${values.INSTALLMENT_NUMBER}: extracted ${terms.length} new term(s) from chapter ${segment.id}.`
    );

    // 2. Research this chapter's new terms (skeleton-first, appended per chapter).
    if (researchEnabled && terms.length > 0) {
      console.log(
        `Volume ${values.INSTALLMENT_NUMBER}: researching ${terms.length} new term(s) ` +
          `of chapter ${segment.id} (concurrency=${RESEARCH_CONCURRENCY})...`
      );
      await appendResearchSkeleton(researchNotesFile, values, segment, terms, si === 0);
      const termsWithIndices = terms.map((term, idx) => ({ ...term, _idx: idx }));
      for (let i = 0; i < termsWithIndices.length; i += RESEARCH_CONCURRENCY) {
        const batch = termsWithIndices.slice(i, i + RESEARCH_CONCURRENCY);
        await researchBatch(ctx, batch, segment);
        if (i + RESEARCH_CONCURRENCY < termsWithIndices.length) {
          const delayMs = parseInt(process.env.RESEARCH_DELAY_MS, 10) || 300;
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }
    }

    // 3. Amend the glossary with this chapter's terms (fresh author agent).
    console.log(
      `Volume ${values.INSTALLMENT_NUMBER}: amending the glossary with chapter ${segment.id} (author agent)...`
    );
    await generateGlossary(ctx, terms, researchEnabled && terms.length > 0, segment, si);
  }

  // QA loop: per-chapter validation partials → findings merge → acceptance.
  await runChunkedQaLoop(ctx);
}

/**
 * Chunked (fallback) QA loop: per-chapter validator passes (fresh agent per
 * chapter) write glossary-validation-<id>.md partials; a findings-merge agent
 * consolidates them into the standard glossary-validation.md; the unchanged
 * acceptance one-shot scores it; on a failed window, per-chapter feedback
 * agents apply the chapter-tagged findings.
 *
 * @param {GlossaryVolumeCtx} ctx - The volume context (must include ctx.fsGate).
 */
async function runChunkedQaLoop(ctx) {
  const { values, bundle, volumeDir, glossaryOutputFile, validationOutputFile } = ctx;
  const fsGate = ctx.fsGate;
  const recentRollingScores = [];

  for (let iteration = 1; iteration <= maxValidationIterations; iteration++) {
    console.log(
      `Volume ${values.INSTALLMENT_NUMBER}: validation iteration ` +
        `${iteration}/${maxValidationIterations} (chapter by chapter)...`
    );

    // Per-chapter validation partials (fresh agent per chapter).
    for (let si = 0; si < bundle.segments.length; si++) {
      const segment = bundle.segments[si];
      const partialFile = path.join(volumeDir, `glossary-validation-${segment.id}.md`);
      const validator = await harness.createAgentHandle({
        name: `validator-${values.INSTALLMENT_NUMBER}-${iteration}-${segment.id}`,
        systemPrompt: ctx.validatorSystemPrompt + AGENT_TOOLS_NOTE,
        tools: fsGate.tools,
        approve: fsGate.approve,
        cwd: volumeDir,
        maxSteps: validatorMaxStepsFor((await fs.stat(path.join(volumeDir, segment.file))).size),
      });
      try {
        const validateResult = await validator.sendTurn(
          buildGlossarySegmentValidatorPrompt(ctx, segment, si),
          { label: `glossary-validate-${values.INSTALLMENT_NUMBER}-${iteration}-${segment.id}` }
        );
        await assertWroteWithFallback(
          partialFile,
          `the validator agent (chapter ${segment.id})`,
          validateResult?.text
        );
      } finally {
        await validator.close();
      }
    }

    // Findings merge: consolidate the partials into the standard report.
    const merger = await harness.createAgentHandle({
      name: `validator-merge-${values.INSTALLMENT_NUMBER}-${iteration}`,
      systemPrompt: ctx.validatorSystemPrompt + AGENT_TOOLS_NOTE,
      tools: fsGate.tools,
      approve: fsGate.approve,
      cwd: volumeDir,
      maxSteps: 20,
    });
    try {
      const mergeResult = await merger.sendTurn(
        buildGlossaryFindingsMergePrompt(ctx),
        { label: `glossary-validate-merge-${values.INSTALLMENT_NUMBER}-${iteration}` }
      );
      await assertWroteWithFallback(validationOutputFile, "the findings-merge agent", mergeResult?.text);
    } finally {
      await merger.close();
    }

    // Acceptance (unchanged: tool-less one-shot over the standard report).
    const score = await acceptanceCheck(ctx, iteration);
    if (score !== null) {
      recentRollingScores.push(score);
      if (recentRollingScores.length > ACCEPTANCE_WINDOW_SIZE) recentRollingScores.shift();
    }
    const stateFilePath = validationOutputFile.replace(".md", "-rolling-state.json");
    await saveRollingState(stateFilePath, recentRollingScores);

    if (meetsAcceptanceCriteria(recentRollingScores)) {
      const avg = computeRollingAverage(recentRollingScores);
      console.log(
        `Volume ${values.INSTALLMENT_NUMBER}: rolling average ${avg.toFixed(1)}/100 ` +
          `(${recentRollingScores.length} checks) meets the passing score ` +
          `${ACCEPTANCE_PASSING_SCORE}. Accepted.`
      );
      break;
    }

    // Per-chapter feedback (fresh agent per chapter, chapter-tagged findings).
    for (let si = 0; si < bundle.segments.length; si++) {
      const segment = bundle.segments[si];
      const feedbackAuthor = await harness.createAgentHandle({
        name: `feedback-author-${values.INSTALLMENT_NUMBER}-${iteration}-${segment.id}`,
        systemPrompt: ctx.glossarySystemPrompt + AGENT_TOOLS_NOTE,
        tools: fsGate.tools,
        approve: fsGate.approve,
        cwd: volumeDir,
        maxSteps: 40,
      });
      try {
        const feedbackResult = await feedbackAuthor.sendTurn(
          buildGlossarySegmentFeedbackPrompt(ctx, segment, si),
          { label: `glossary-feedback-${values.INSTALLMENT_NUMBER}-${iteration}-${segment.id}` }
        );
        await assertWroteWithFallback(
          glossaryOutputFile,
          `the author agent (feedback pass, chapter ${segment.id})`,
          feedbackResult?.text
        );
      } finally {
        await feedbackAuthor.close();
      }
    }

    if (iteration === maxValidationIterations) {
      ctx.limitReached = true;
      console.log(
        `Volume ${values.INSTALLMENT_NUMBER}: reached the validation iteration limit ` +
          `without a passing grade. The last feedback pass is unvalidated; re-run to validate it.`
      );
      if (ON_QA_LIMIT === "fail") {
        throw new Error(
          `Volume ${values.INSTALLMENT_NUMBER}: hit the validation iteration limit ` +
            `without a passing grade (ON_QA_LIMIT=fail).`
        );
      }
      break;
    }
  }
}

/**
 * Process a single volume: extract terms -> research (researcher agent) ->
 * amend the glossary (author agent) -> QA loop (validator agent + acceptance
 * + feedback). Chunked (fallback) volumes take runChunkedVolumeAgent instead.
 *
 * @param {GlossaryVolumeCtx} ctx - The volume context (see glossary()).
 */
async function runVolumeAgent(ctx) {
  const {
    values,
    folderName,
    volumeDir,
    sourceFile,
    glossaryOutputFile,
    researchNotesFile,
    isFirst,
    previousFolderName,
    previousGlossaryFile,
    termsPrompt,
    termsSystemPrompt,
  } = ctx;

  // Chunked (fallback) volumes take the per-chapter flow instead.
  if (ctx.chunked) {
    await runChunkedVolumeAgent(ctx);
    return;
  }

  // Pass 1: extract the new terms (single-shot, as in classic mode — an
  // exhaustive one-pass JSON extraction that needs no tools).
  console.log(`Volume ${values.INSTALLMENT_NUMBER}: extracting new terms...`);
  const baseMessages = [{ file: sourceFile, name: path.basename(sourceFile) }];
  if (!isFirst) {
    baseMessages.push({ file: previousGlossaryFile, name: "glossary-previous.md" });
  }
  const termsOutput = await harness.runOneShot({
    systemPrompt: termsSystemPrompt,
    messages: [...baseMessages, { text: termsPrompt }],
    label: `glossary-terms-${values.INSTALLMENT_NUMBER}`,
  });
  let terms = [];
  try {
    terms = parseTerms(termsOutput);
  } catch (err) {
    console.warn(
      `Volume ${values.INSTALLMENT_NUMBER}: could not parse the term list ` +
        `(${err.message}). Continuing without research.`
    );
  }
  console.log(
    `Volume ${values.INSTALLMENT_NUMBER}: extracted ${terms.length} new term(s).`
  );

  // File tools gated to this volume's folder (reads are allowed anywhere,
  // so the agents can also read the volume source and the previous volume).
  const fsGate = await harness.createGatedFsTools({
    cwd: volumeDir,
    allowedDirs: [volumeDir],
  });
  ctx.fsGate = fsGate;

  // Wikipedia research tools for the per-term researcher agents (pass 2 below).
  // createWikiTools() is synchronous — it just wraps research.js with the
  // current RESEARCH_* env settings. (Observed live: this assignment was
  // missing, so the researcher agents were created with wiki_search/
  // wiki_extract set to undefined and the model's first tool call threw
  // "Cannot read properties of undefined (reading 'execute')".)
  ctx.wikiTools = harness.createWikiTools();

  // Remove stale strays from earlier runs (agent name drift): a per-volume
  // classic-style name like "glossary-01.md" is never written by the
  // workflow itself, so anything like that is leftover garbage.
  const strayGlossary = path.join(volumeDir, `glossary-${values.INSTALLMENT_NUMBER}.md`);
  if (await fileExists(strayGlossary)) {
    await fs.rm(strayGlossary);
    console.log(
      `Removed the stale file "glossary-${values.INSTALLMENT_NUMBER}.md" (leftover from a previous run).`
    );
  }

  // Pass 2: research the new terms with parallel agents (one per term, batched).
  const researchNotesAvailable = researchEnabled && terms.length > 0;
  if (researchNotesAvailable) {
    console.log(
      `Volume ${values.INSTALLMENT_NUMBER}: researching ${terms.length} new term(s) ` +
        `in parallel (concurrency=${RESEARCH_CONCURRENCY})...`
    );
    // Skeleton-first: the workflow creates the notes file with a "- (pending)"
    // placeholder under every term; each parallel agent replaces its own
    // placeholder via editFile. Even a crashed run leaves a usable skeleton.
    const skeletonLines = ["# Research Notes — Volume " + values.INSTALLMENT_NUMBER, ""];
    for (let ti = 0; ti < terms.length; ti++) {
      skeletonLines.push(`### ${terms[ti].term}`);
      skeletonLines.push("- (pending)");
    }
    skeletonLines.push("");
    await fs.writeFile(researchNotesFile, skeletonLines.join("\n"), "utf8");

    // Tag each term with its original index so the batch function can
    // pass the correct line number to the per-term prompt.
    const termsWithIndices = terms.map((term, idx) => ({ ...term, _idx: idx }));

    // Process terms in batches.
    for (let i = 0; i < termsWithIndices.length; i += RESEARCH_CONCURRENCY) {
      const batch = termsWithIndices.slice(i, i + RESEARCH_CONCURRENCY);
      await researchBatch(ctx, batch);
      // Politeness delay between batches (not within a batch, which runs in parallel).
      if (i + RESEARCH_CONCURRENCY < termsWithIndices.length) {
        const delayMs = parseInt(process.env.RESEARCH_DELAY_MS, 10) || 300;
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    if (!(await fileExists(researchNotesFile))) {
      console.warn(
        `Volume ${values.INSTALLMENT_NUMBER}: the research notes file is missing ` +
          `(the agent deleted it?); continuing without research.`
      );
    } else {
      const remaining = (
        await fs.readFile(researchNotesFile, "utf8")
      ).split("- (pending)").length - 1;
      if (remaining > 0) {
        console.warn(
          `Volume ${values.INSTALLMENT_NUMBER}: research finished with ${remaining} ` +
            `term(s) still unresolved (placeholder left in place).`
        );
      }
    }
  }

  // Pass 3: amend the glossary with the author agent (standalone — creates and
  // closes its own session; no persistent context across QA iterations).
  console.log(
    `Volume ${values.INSTALLMENT_NUMBER}: amending the glossary (author agent)...`
  );

  await generateGlossary(ctx, terms, researchNotesAvailable);

  // QA loop: fresh validator per iteration + fresh author for feedback.
  await runQaLoop(ctx);
}

/**
 * Generate (or regenerate) the glossary using a standalone author agent.
 * The agent is created and closed within this function — no persistent session.
 * With `seg` set (chunked fallback) the pass is scoped to one chapter: the
 * prompt names the chapter file and the current in-volume state.
 *
 * @param {GlossaryVolumeCtx} ctx - The volume context.
 * @param {Array<{term: string, type: string, query: string}>} terms - The new terms.
 * @param {boolean} researchNotesAvailable - Whether research notes exist.
 * @param {SourceSegment|null} [seg] - The chapter being processed (fallback).
 * @param {number} [si] - Zero-based position of the chapter in reading order.
 * @returns {Promise<void>}
 */
async function generateGlossary(ctx, terms, researchNotesAvailable, seg = null, si = null) {
  const { values, volumeDir, glossaryOutputFile } = ctx;
  const labelSuffix = seg ? `-${seg.id}` : "";

  const author = await harness.createAgentHandle({
    name: `author-${values.INSTALLMENT_NUMBER}${labelSuffix}`,
    systemPrompt: ctx.glossarySystemPrompt + AGENT_TOOLS_NOTE,
    tools: ctx.fsGate.tools,
    approve: ctx.fsGate.approve,
    cwd: volumeDir,
    maxSteps: 40,
  });
  try {
    const amendResult = await author.sendTurn(
      buildGlossaryAuthorTurnPrompt(ctx, terms, researchNotesAvailable, seg, si),
      { label: `glossary-amend-${values.INSTALLMENT_NUMBER}${labelSuffix}` }
    );
    const fallbackUsed = await assertWroteWithFallback(
      glossaryOutputFile,
      "the author agent",
      amendResult?.text
    );

    // Recovery turn: if the model replied in chat instead of writeFile,
    // send a second turn asking it to write the file using the content
    // it already generated (the model's session still has that context).
    if (fallbackUsed && process.env.AGENT_RECOVERY_ENABLED !== "false") {
      console.log(
        `Volume ${values.INSTALLMENT_NUMBER}: sending recovery turn ` +
          `(model replied in chat instead of writeFile)...`
      );
      const hasContent = amendResult?.text && amendResult.text.trim().length > 0;
      const recoveryPrompt = hasContent
        ? `You were asked to write the complete glossary to "glossary.md" using writeFile, but you replied with the content in your chat message instead.\n\n` +
          `The file has been temporarily written from your chat reply, but it must be written properly using writeFile. ` +
          `Please rewrite the complete glossary to "glossary.md" using writeFile now. Use the exact same content you generated in your previous message.`
        : `You were asked to write the complete glossary to "glossary.md" using writeFile, but you produced no output.\n\n` +
          `Please read the source materials and write the complete glossary to "glossary.md" using writeFile now.`;
      const recoveryResult = await author.sendTurn(
        recoveryPrompt,
        { label: `glossary-recovery-${values.INSTALLMENT_NUMBER}` }
      );
      // Overwrite with the recovery output (may be the same content, now via writeFile).
      await assertWroteWithFallback(
        glossaryOutputFile,
        "the author agent (recovery)",
        recoveryResult?.text
      );
    }

    console.log(
      `Volume ${values.INSTALLMENT_NUMBER}: saved the glossary to ${glossaryOutputFile}`
    );
  } finally {
    await author.close();
  }
}

/**
 * QA loop: independent validator agent (fresh per iteration) ->
 * score-based acceptance check (0–100, see configs/shared.js) ->
 * feedback applied by a fresh author agent (no persistent session — each
 * feedback pass starts with a clean context that includes the validation
 * report and current glossary).
 *
 * @param {GlossaryVolumeCtx} ctx - The volume context (must include ctx.fsGate).
 */
async function runQaLoop(ctx) {
  const {
    values,
    volumeDir,
    sourceFile,
    glossaryOutputFile,
    validationOutputFile,
  } = ctx;
  const fsGate = ctx.fsGate;
  // Rolling window of recent acceptance scores (0–100). A score of `null`
  // (unparseable acceptance response) counts as a failed check (fail-closed)
  // and is not stored in the window.
  const recentRollingScores = [];

  for (let iteration = 1; iteration <= maxValidationIterations; iteration++) {
    console.log(
      `Volume ${values.INSTALLMENT_NUMBER}: validation iteration ` +
        `${iteration}/${maxValidationIterations}...`
    );

    // Validate with an independent validator agent (fresh per iteration).
    const validator = await harness.createAgentHandle({
      name: `validator-${values.INSTALLMENT_NUMBER}-${iteration}`,
      systemPrompt: ctx.validatorSystemPrompt + AGENT_TOOLS_NOTE,
      tools: fsGate.tools,
      approve: fsGate.approve,
      cwd: volumeDir,
      // scaled to the source size (see validatorMaxStepsFor)
      maxSteps: validatorMaxStepsFor((await fs.stat(sourceFile)).size),
    });
    try {
      const validateResult = await validator.sendTurn(
        buildGlossaryValidatorTurnPrompt(ctx),
        { label: `glossary-validate-${values.INSTALLMENT_NUMBER}-${iteration}` }
      );
      await assertWroteWithFallback(
        validationOutputFile,
        "the validator agent",
        validateResult?.text
      );

      // Recovery turn: if the validator replied in chat instead of writeFile,
      // send a second turn asking it to write the report using writeFile.
      if (process.env.AGENT_RECOVERY_ENABLED !== "false") {
        const hasContent = validateResult?.text && validateResult.text.trim().length > 0;
        const recoveryPrompt = hasContent
          ? `You were asked to write the validation report to "glossary-validation.md" using writeFile, but you replied with the content in your chat message instead.\n\n` +
            `The file has been temporarily written from your chat reply, but it must be written properly using writeFile. ` +
            `Please rewrite the complete validation report to "glossary-validation.md" using writeFile now. Use the exact same content you generated in your previous message.`
          : `You were asked to write the validation report to "glossary-validation.md" using writeFile, but you produced no output.\n\n` +
            `Please read the source materials and write the complete validation report to "glossary-validation.md" using writeFile now.`;
        const validateRecoveryResult = await validator.sendTurn(
          recoveryPrompt,
          { label: `glossary-validate-recovery-${values.INSTALLMENT_NUMBER}-${iteration}` }
        );
        await assertWroteWithFallback(
          validationOutputFile,
          "the validator agent (recovery)",
          validateRecoveryResult?.text
        );
      }
    } finally {
      await validator.close();
    }

    // Acceptance check (always one-shot, tool-less) — the model scores the
    // glossary 0–100.
    const score = await acceptanceCheck(ctx, iteration);

    // Record the score in the rolling window (null = unparseable, already
    // logged as a failure; not stored).
    if (score !== null) {
      recentRollingScores.push(score);
      if (recentRollingScores.length > ACCEPTANCE_WINDOW_SIZE) {
        recentRollingScores.shift();
      }
    }

    // Persist the rolling window to disk so that a re-run can recover the
    // exact acceptance state without re-calling the AI.
    const stateFilePath = validationOutputFile.replace(".md", "-rolling-state.json");
    await saveRollingState(stateFilePath, recentRollingScores);

    // Check the acceptance criterion: if we have enough samples and the
    // window meets it, accept and stop (skip feedback).
    if (meetsAcceptanceCriteria(recentRollingScores)) {
      const avg = computeRollingAverage(recentRollingScores);
      console.log(
        `Volume ${values.INSTALLMENT_NUMBER}: rolling average ${avg.toFixed(1)}/100 ` +
          `(${recentRollingScores.length} checks) meets the passing score ` +
          `${ACCEPTANCE_PASSING_SCORE}. Accepted.`
      );
      break;
    }

    // Apply the feedback with a fresh author agent (no persistent session).
    // The feedback prompt is self-contained: it includes the validation report
    // and the current glossary so the agent has all context it needs.
    console.log(`Volume ${values.INSTALLMENT_NUMBER}: applying validation feedback (fresh author agent)...`);

    const feedbackAuthor = await harness.createAgentHandle({
      name: `feedback-author-${values.INSTALLMENT_NUMBER}-${iteration}`,
      systemPrompt: ctx.glossarySystemPrompt + AGENT_TOOLS_NOTE,
      tools: ctx.fsGate.tools,
      approve: ctx.fsGate.approve,
      cwd: volumeDir,
      maxSteps: 40,
    });
    try {
      const feedbackResult = await feedbackAuthor.sendTurn(
        buildGlossaryFeedbackTurnPrompt(ctx),
        { label: `glossary-feedback-${values.INSTALLMENT_NUMBER}-${iteration}` }
      );
      const feedbackFallbackUsed = await assertWroteWithFallback(
        glossaryOutputFile,
        "the author agent (feedback pass)",
        feedbackResult?.text
      );

      // Recovery turn for feedback pass: if the model produced no output,
      // re-send the full feedback task.
      if (feedbackFallbackUsed && process.env.AGENT_RECOVERY_ENABLED !== "false") {
        const hasContent = feedbackResult?.text && feedbackResult.text.trim().length > 0;
        const recoveryPrompt = hasContent
          ? `You were asked to write the complete glossary to "glossary.md" using writeFile, but you replied with the content in your chat message instead.\n\n` +
            `The file has been temporarily written from your chat reply, but it must be written properly using writeFile. ` +
            `Please rewrite the complete glossary to "glossary.md" using writeFile now. Use the exact same content you generated in your previous message.`
          : `You were asked to write the complete glossary to "glossary.md" using writeFile, but you produced no output.\n\n` +
            `Please read the source materials and the validation report and write the corrected glossary to "glossary.md" using writeFile now.`;
        const feedbackRecoveryResult = await feedbackAuthor.sendTurn(
          recoveryPrompt,
          { label: `glossary-feedback-recovery-${values.INSTALLMENT_NUMBER}-${iteration}` }
        );
        await assertWroteWithFallback(
          glossaryOutputFile,
          "the author agent (feedback recovery)",
          feedbackRecoveryResult?.text
        );
      }
    } finally {
      await feedbackAuthor.close();
    }

    if (iteration === maxValidationIterations) {
      ctx.limitReached = true;
      console.log(
        `Volume ${values.INSTALLMENT_NUMBER}: reached the validation iteration limit ` +
          `without a passing grade. The last feedback pass is unvalidated; ` +
          `re-run to validate it.`
      );
      if (ON_QA_LIMIT === "fail") {
        throw new Error(
          `Volume ${values.INSTALLMENT_NUMBER}: hit the validation iteration limit ` +
            `without a passing grade (ON_QA_LIMIT=fail).`
        );
      }
      break;
    }
  }
}

// ─── Export for use as a module ─────────────────────────────────────────────

module.exports = {
  glossary,
  parseTerms,
  truncateGlossary,
  buildPerTermResearchPrompt,
  researchOneTerm,
  researchBatch,
  RESEARCHER_SYSTEM_PROMPT,
  buildGlossaryResearcherTurnPrompt,
  buildGlossaryAuthorTurnPrompt,
  buildGlossaryValidatorTurnPrompt,
  buildGlossaryFeedbackTurnPrompt,
  buildGlossarySegmentValidatorPrompt,
  buildGlossaryFindingsMergePrompt,
  buildGlossarySegmentFeedbackPrompt,
  appendResearchSkeleton,
  runChunkedVolumeAgent,
  runChunkedQaLoop,
};
