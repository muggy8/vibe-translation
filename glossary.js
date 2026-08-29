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
 *     6. Run the QA loop with a rolling-average acceptance criterion:
 *          a. Validate the glossary against the source (glossary-validator.md)
 *             — an independent validator agent writes the report.
 *          b. Acceptance check (glossary-acceptance.md): PASS or FAIL
 *             (always a tool-less single-shot call).
 *          c. Track each acceptance result in a rolling window (default:
 *             last 5 checks). When the rolling pass rate meets the
 *             threshold (default: 0.60 = 3 of 5) and we have at least
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
const { transformUserPrompt, isPassingVerdict, validatorMaxStepsFor, writePromptDump } = require("./utils/prompt");
const { getTranslationTarget } = require("./get-translation-target");
const { AGENT_TOOLS_NOTE, RESEARCH_CONCURRENCY, ROLLING_WINDOW_SIZE, ROLLING_ACCEPTANCE_THRESHOLD, ROLLING_MIN_SAMPLES, computeRollingAverage, saveRollingState } = require("./configs/shared");
const { fileExists, assertWrote, assertWroteWithFallback } = require("./utils/fs");

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
  parseInt(process.env.MAX_VALIDATION_ITERATIONS, 10) || 3
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
 * @returns {string}
 */
function buildPerTermResearchPrompt(ctx, term, index) {
  const { values, folderName } = ctx;
  // Approximate line number: each term in the skeleton gets ~3 lines
  const approxLine = 4 + index * 3;
  return (
    `Working folder: the volume folder (you are in it).\n\n` +
    `Context you may consult (optional): the volume source "${folderName}.md" (same folder) — ` +
    `read it selectively with readFile/grep if you need disambiguation; you do ` +
    `not need to read it all.\n\n` +
    `Your task: research the following term and write your notes to the file ` +
    `"glossary-research.md" in your working folder:\n\n` +
    `Term: ${term.term} (${term.type}) — suggested query: ${term.query}\n\n` +
    `The file "glossary-research.md" already exists. It contains a "- (pending)" ` +
    `placeholder line for this term (approximately line ${approxLine}). ` +
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
 * @returns {Promise<void>}
 */
async function researchOneTerm(ctx, term, index) {
  const agent = await harness.createAgentHandle({
    name: `researcher-${term.term.replace(/\s+/g, "-")}`,
    systemPrompt: RESEARCHER_SYSTEM_PROMPT,
    tools: { wiki_search: ctx.wikiTools?.wiki_search, wiki_extract: ctx.wikiTools?.wiki_extract, ...ctx.fsGate.tools },
    approve: ctx.fsGate.approve,
    cwd: ctx.volumeDir,
    maxSteps: 15, // 2 wiki_search + 1 wiki_extract + 1 editFile + overhead
  });
  try {
    await agent.sendTurn(
      buildPerTermResearchPrompt(ctx, term, index),
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
 * @returns {Promise<void>}
 */
async function researchBatch(ctx, batch) {
  const results = await Promise.allSettled(
    batch.map((term) => researchOneTerm(ctx, term, term._idx))
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
  const { values, folderName } = ctx;
  const termsListText = terms
    .map((t) => `- ${t.term} (${t.type}) — suggested query: ${t.query}`)
    .join("\n");
  return (
    `Working folder: the volume folder (you are in it).\n\n` +
    `Context you may consult (optional): the volume source "${folderName}.md" (same folder) — ` +
    `read it selectively with readFile/grep if a term needs disambiguation; you do ` +
    `not need to read it all.\n\n` +
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
 * @param {GlossaryVolumeCtx} ctx - The volume context (must include glossaryTemplate).
 * @param {Array<{term: string, type: string, query: string}>} terms - The new terms.
 * @param {boolean} researchNotesAvailable - Whether glossary-research.md exists.
 * @returns {string}
 */
function buildGlossaryAuthorTurnPrompt(ctx, terms, researchNotesAvailable) {
  const { values, folderName, isFirst, previousFolderName } = ctx;
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
  const previousGlossaryLine = isFirst
    ? "- The previous glossary: (absent — this is the first volume)"
    : `- The previous glossary: "../${previousFolderName}/glossary.md"`;
  return (
    `Working folder: the volume folder (you are in it).\n\n` +
    `Materials (read with readFile before writing anything):\n` +
    `- The volume source: "${folderName}.md" (same folder)\n` +
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
  const { folderName, isFirst, previousFolderName } = ctx;
  const previousGlossaryLine = isFirst
    ? ""
    : `- The previous glossary: "../${previousFolderName}/glossary.md"\n`;
  return (
    `Working folder: the volume folder (you are in it).\n\n` +
    `Materials (read with readFile before writing anything):\n` +
    `- The volume source: "${folderName}.md" (same folder)\n` +
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
  const { folderName, isFirst, previousFolderName } = ctx;
  const previousGlossaryLine = isFirst
    ? ""
    : `- The previous glossary: "../${previousFolderName}/glossary.md"\n`;
  return (
    `Working folder: the volume folder (you are in it).\n\n` +
    `The validation report "glossary-validation.md" in your working folder is your ` +
    `work order.\n` +
    `Materials (read with readFile before changing anything):\n` +
    `- The volume source: "${folderName}.md" (same folder)\n` +
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

  if (!seriesDir) {
    throw new Error("SERIES_LOCATION is not set. Please set it in .env.");
  }
  if (!process.env.SERIES_NAME_SOURCE) {
    throw new Error("SERIES_NAME_SOURCE is not set. Please set it in .env.");
  }

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

  for (const folderName of volumes) {
    const i = sorted.indexOf(folderName);
    const volume = volumeByFolder.get(folderName);
    const volumeDir = path.join(seriesDir, folderName);
    const sourceFile = path.resolve(seriesDir, volume.sourceFile);
    const glossaryOutputFile = path.join(volumeDir, "glossary.md");
    const validationOutputFile = path.join(volumeDir, "glossary-validation.md");
    const researchNotesFile = path.join(volumeDir, "glossary-research.md");

    if (!(await fileExists(sourceFile))) {
      throw new Error(`Required source file not found: ${sourceFile}`);
    }

    const values = {
      INSTALLMENT_NUMBER: volume.installmentNumber,
      SOURCE_NAME: process.env.SERIES_NAME_SOURCE,
      SOURCE_LANGUAGE: process.env.SOURCE_LANGUAGE || "Japanese",
      TARGET_LANGUAGE: process.env.TARGET_LANGUAGE || "English",
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
        } else {
          throw new Error(
            `Previous glossary not found: ${previousGlossaryFile}. ` +
              `Process the earlier volume first (or re-run without --force).`
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

    // Idempotency: skip a volume whose glossary already exists and passed
    // the rolling-average acceptance criterion, unless a previous volume was
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
        skip =
          state.results.length >= ROLLING_MIN_SAMPLES &&
          avg >= ROLLING_ACCEPTANCE_THRESHOLD;
        if (skip) {
          console.log(
            `Volume ${values.INSTALLMENT_NUMBER}: rolling-state ` +
              `(${state.results.length} checks, avg ${avg.toFixed(2)}) ` +
              `meets threshold. Skipping.`
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
 *
 * @param {GlossaryVolumeCtx} ctx - The volume context (see glossary()).
 * @param {number} iteration - The current QA iteration (for the log label).
 * @returns {Promise<boolean>} True for a passing verdict.
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
  const accepted = isPassingVerdict(acceptanceOutput);
  console.log(
    `Volume ${values.INSTALLMENT_NUMBER}: acceptance check: ${accepted ? "PASS" : "FAIL"}`
  );
  return accepted;
}

/**
 * Process a single volume: extract terms -> research (researcher agent) ->
 * amend the glossary (author agent) -> QA loop (validator agent + acceptance
 * + feedback).
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
 *
 * @param {GlossaryVolumeCtx} ctx - The volume context.
 * @param {Array<{term: string, type: string, query: string}>} terms - The new terms.
 * @param {boolean} researchNotesAvailable - Whether research notes exist.
 * @returns {Promise<void>}
 */
async function generateGlossary(ctx, terms, researchNotesAvailable) {
  const { values, volumeDir, glossaryOutputFile, sourceFile } = ctx;

  const author = await harness.createAgentHandle({
    name: `author-${values.INSTALLMENT_NUMBER}`,
    systemPrompt: ctx.glossarySystemPrompt + AGENT_TOOLS_NOTE,
    tools: ctx.fsGate.tools,
    approve: ctx.fsGate.approve,
    cwd: volumeDir,
    maxSteps: 40,
  });
  try {
    const amendResult = await author.sendTurn(
      buildGlossaryAuthorTurnPrompt(ctx, terms, researchNotesAvailable),
      { label: `glossary-amend-${values.INSTALLMENT_NUMBER}` }
    );
    const fallbackUsed = await assertWroteWithFallback(
      glossaryOutputFile,
      "the author agent",
      amendResult?.text
    );

    // Recovery turn: if the model replied in chat instead of writeFile,
    // send a second turn asking it to write the file using the content
    // it already generated (the model's session still has that context).
    if (fallbackUsed && process.env.RECOVERY_ENABLED !== "false") {
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
 * rolling-average acceptance check -> feedback applied by a fresh author
 * agent (no persistent session — each feedback pass starts with a clean
 * context that includes the validation report and current glossary).
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
  // Rolling window of recent acceptance results (true = pass, false = fail).
  const recentRollingResults = [];

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
      if (process.env.RECOVERY_ENABLED !== "false") {
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

    // Acceptance check (always one-shot, tool-less).
    const accepted = await acceptanceCheck(ctx, iteration);

    // Record result in rolling window.
    recentRollingResults.push(accepted);
    if (recentRollingResults.length > ROLLING_WINDOW_SIZE) {
      recentRollingResults.shift();
    }

    // Persist the rolling window to disk so that a re-run can recover the
    // exact acceptance state without re-calling the AI.
    const stateFilePath = validationOutputFile.replace(".md", "-rolling-state.json");
    await saveRollingState(stateFilePath, recentRollingResults);

    // Check rolling average: if we have enough samples and the pass rate
    // meets the threshold, accept and stop (skip feedback).
    if (recentRollingResults.length >= ROLLING_MIN_SAMPLES) {
      const avg = computeRollingAverage(recentRollingResults);
      if (avg >= ROLLING_ACCEPTANCE_THRESHOLD) {
        const passCount = recentRollingResults.filter(Boolean).length;
        console.log(
          `Volume ${values.INSTALLMENT_NUMBER}: rolling average ${avg.toFixed(2)} ` +
            `(${passCount}/${recentRollingResults.length} passes) meets threshold ` +
            `${ROLLING_ACCEPTANCE_THRESHOLD}. Accepted.`
        );
        break;
      }
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
      if (feedbackFallbackUsed && process.env.RECOVERY_ENABLED !== "false") {
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
      console.log(
        `Volume ${values.INSTALLMENT_NUMBER}: reached the validation iteration limit ` +
          `without a passing grade. The last feedback pass is unvalidated; ` +
          `re-run to validate it.`
      );
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
};
