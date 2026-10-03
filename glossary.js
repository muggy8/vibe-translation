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
 *             (rolling average of scores >= PASSING_SCORE,
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
const { transformUserPrompt, parseAcceptanceScore, parseAcceptanceReply, validatorMaxStepsFor, writePromptDump } = require("./utils/prompt");
const { getTranslationTarget } = require("./get-translation-target");
const { filterVolumesByInstallment } = require("./utils/manifest");
const { AGENT_TOOLS_NOTE, STAGE_CONCURRENCY: RESEARCH_CONCURRENCY, ACCEPTANCE_WINDOW_SIZE, ACCEPTANCE_PASSING_SCORE, computeRollingAverage, meetsAcceptanceCriteria, isAcceptedState, isSourceStale, saveRollingState, ON_VOLUME_ERROR, ON_MISSING_PREVIOUS, ON_QA_LIMIT, validateRequiredEnv, resolveRunSettings, seriesArtifactFile, judgeTemperature, isStructuralError, volumeFailureError } = require("./configs/shared");
const { fileExists, assertWrote, assertWroteWithFallback, assertRealOutput, writeProvenanceSidecar, inlineReferenceMessage, hasRealOutput } = require("./utils/fs");
const { loadGlossaryDisputes } = require("./utils/disputes");
const { emittedToolCallAsText, assertRealToolCalls } = require("./utils/agents");
const { runSharedQaLoop, confirmExceptionalScore, runVolumeWithModeFallback } = require("./utils/qa-loop");
const {
  resolveSourceBundle,
  decideProcessingMode,
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
 * Truncate a glossary file to the entries that MATTER for the volume being
 * processed, when it exceeds the configured threshold. Returns the full content
 * when under the threshold, or the truncated content (with a header note) when
 * over it.
 *
 * The old rule was "drop the oldest rows in document order". A glossary is
 * organised by SECTION (Characters, Places, Items…), not by when entries were
 * added — so the head of the Characters table is the volume-1 main cast, and
 * dropping "the oldest rows" threw away exactly the entries a later volume is
 * most likely to contain. The extractor was then shown 200 rows that excluded
 * the protagonists and duly rediscovered them as brand-new terms, volume after
 * volume.
 *
 * The selection is now deterministic and relevance-ordered: rows whose source
 * term actually occurs in THIS volume's text are kept first (in document order),
 * then the remaining rows. Section structure and table headers are preserved; a
 * section whose rows are all omitted loses its heading, so the model is never
 * told about a section it cannot see.
 *
 * @param {string} content - The full glossary file content.
 * @param {string} [sourceText] - The volume/chapter source text, used to rank rows by whether the term occurs in it.
 * @returns {string} The (possibly truncated) content.
 */
function truncateGlossary(content, sourceText) {
  if (!content || content.length <= GLOSSARY_TRUNCATION_THRESHOLD) return content;

  // Group the file into runs: a table (consecutive "|…" lines) or a single
  // other line. Inside a table, line 0 is the column header and line 1 the
  // |---| separator; everything after that is one term entry.
  //
  // (Rewritten: this helper used to split on "- Term:" list items, but the
  // glossary the workflow prompts for is a set of Markdown TABLES
  // (`| source | rendering | notes |`), so the split found zero entries and the
  // helper returned the file unchanged no matter how big it got — the
  // truncation AGENTS.md describes had never actually happened.)
  const lines = content.split("\n");
  const runs = [];
  let currentSection = null;
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,6}\s+/.test(lines[i].trim())) {
      currentSection = runs.length;
      runs.push({ kind: "line", block: [lines[i]] });
      continue;
    }
    if (lines[i].trim().startsWith("|")) {
      const start = i;
      while (i + 1 < lines.length && lines[i + 1].trim().startsWith("|")) i++;
      const block = lines.slice(start, i + 1);
      runs.push({
        kind: "table",
        block,
        dataFrom: block.length > 1 ? 2 : block.length,
        section: currentSection,
      });
      continue;
    }
    runs.push({ kind: "line", block: [lines[i]] });
  }

  // Every data row, tagged with the section heading it belongs to and whether
  // its source term occurs in the text being translated.
  const src = (sourceText || "").trim();
  const rows = [];
  runs.forEach((run, runIdx) => {
    if (run.kind !== "table") return;
    for (let k = run.dataFrom; k < run.block.length; k++) {
      const cells = run.block[k].split("|").map((c) => c.trim()).filter((c) => c !== "");
      rows.push({
        runIdx,
        lineIdx: k,
        term: cells[0] || "",
        occurs: src ? cells[0] && src.includes(cells[0]) : null,
      });
    }
  });
  const totalData = rows.length;
  if (totalData <= GLOSSARY_TRUNCATION_MAX_ENTRIES) return content;

  // Relevance first, document order within each group. Without a source text the
  // old behavior is kept (the newest window, and the note says so).
  const hasSource = Boolean(src);
  const ordered = hasSource
    ? [...rows].sort((a, b) => {
        const d = (a.occurs ? 0 : 1) - (b.occurs ? 0 : 1);
        if (d !== 0) return d;
        if (a.runIdx !== b.runIdx) return a.runIdx - b.runIdx;
        return a.lineIdx - b.lineIdx;
      })
    : [...rows].reverse();
  const keep = new Set(ordered.slice(0, GLOSSARY_TRUNCATION_MAX_ENTRIES).map((r) => `${r.runIdx}:${r.lineIdx}`));
  const keptOccurs = ordered.slice(0, GLOSSARY_TRUNCATION_MAX_ENTRIES).filter((r) => r.occurs === true).length;
  const dropped = totalData - keep.size;

  // Re-render the runs, keeping only the rows that survived, and dropping a
  // heading whose tables lost every row.
  const out = [];
  const droppedSections = new Set();
  for (const [runIdx, run] of runs.entries()) {
    if (run.kind !== "table") continue;
    const kept = [];
    for (let k = run.dataFrom; k < run.block.length; k++) {
      if (keep.has(`${runIdx}:${k}`)) kept.push(run.block[k]);
    }
    if (kept.length === 0) {
      droppedSections.add(run.section);
      continue;
    }
    out.push({ runIdx, lines: [...run.block.slice(0, run.dataFrom), ...kept] });
  }
  const keptRunIdx = new Set(out.map((o) => o.runIdx));
  const final = [];
  for (const [runIdx, run] of runs.entries()) {
    if (run.kind === "table") {
      const rendered = out.find((o) => o.runIdx === runIdx);
      if (rendered) final.push(...rendered.lines);
      continue;
    }
    // A heading whose tables were truncated away entirely is dropped, so the
    // model is not told about a section it cannot see.
    if (/^#{1,6}\s+/.test(run.block[0].trim()) && droppedSections.has(runIdx)) continue;
    final.push(...run.block);
  }

  const keptCount = totalData - dropped;
  final.splice(
    1,
    0,
    "",
    src
      ? `[TRUNCATED: this glossary has ${totalData} term rows. Showing ${keptCount} of them — every row ` +
        `whose source term occurs in the text being translated (${keptOccurs} such row(s) are included), ` +
        `then the rest in document order. ${dropped} row(s)${droppedSections.size ? ` and ${droppedSections.size} fully omitted section(s)` : ""} ` +
        `are not shown; they are carried forward UNCHANGED in the file itself, so do not re-add a term ` +
        `as new merely because it is absent from what you can see here.]`
      : `[TRUNCATED: this glossary has ${totalData} term rows. Showing the ${keptCount} in document order; ` +
        `${dropped} row(s)${droppedSections.size ? ` and ${droppedSections.size} fully omitted section(s)` : ""} are omitted. ` +
        `Earlier entries are carried forward unchanged in the file itself — reconcile NEW terms against what is shown here.]`
  );
  return final.join("\n");
}

/**
 * Turn the previous volume's coverage audit into a note for THIS volume's
 * extraction pass (report → input).
 *
 * `glossary-coverage.json` already knows which entries were never used: the terms
 * carried in the cumulative glossary that do not occur once in the volume they
 * were built for. Without this note the glossary only ever grows — a term
 * hallucinated in volume 3 is carried forward by every later volume's amend pass
 * and nobody is ever told it has never been seen. With it, the extractor is
 * handed the list and asked to reconsider it.
 *
 * Bounded on purpose: a 200-term list pasted into a prompt is noise, and the
 * point is to raise the worst offenders, not to restate the whole glossary.
 *
 * @param {Object|null} coverage - The parsed `glossary-coverage.json` of the previous volume.
 * @param {number} [limit] - How many zero-occurrence terms to name.
 * @returns {string} "" when there is nothing to say.
 */
/**
 * Turn the open glossary disputes into a first-class input for the amend pass.
 *
 * The dispute came from a model reading the SOURCE and concluding that the
 * glossary entry is wrong. The amend pass is the only place that can settle it,
 * and it must settle it EXPLICITLY: either correct the entry, or record why the
 * canonical rendering stands. Silence is not an answer — an unresolved dispute
 * reappears in every later volume's verification.
 *
 * @param {Array<Object>} disputes - The parsed series dispute queue.
 * @param {string} installmentNumber - The volume being amended (for the header).
 * @param {number} [limit] - How many disputes to name (bounded: a 200-row list is noise).
 * @returns {string} "" when there is nothing open.
 */
function buildDisputesNote(disputes, installmentNumber, limit = 40) {
  const list = Array.isArray(disputes) ? disputes : [];
  if (list.length === 0) return "";
  const shown = list.slice(0, limit);
  const lines = [
    "",
    "",
    `## Open glossary disputes (challenged during translation of earlier volumes)`,
    "",
    `These renderings were challenged by the translation verifier while working on ` +
      `another volume: the verifier read the source text and found the canonical ` +
      `rendering contradicts it. For EACH one below, volume ${installmentNumber}'s ` +
      `amendment must either (a) correct the entry to the rendering the source supports, ` +
      `or (b) keep the canonical rendering and record, in the entry's Notes column, ` +
      `the evidence that makes it stand. Do not leave a dispute unaddressed and do ` +
      `not silently drop the entry.`,
    "",
  ];
  for (const d of shown) {
    lines.push(`- **${d.term}** — glossary says "${d.canonical || "?"}"; ` +
      `challenged as "${d.proposed || "(no alternative proposed)"}"`);
    if (d.sourceQuote) lines.push(`  - Evidence from the source: "${d.sourceQuote}"`);
    else lines.push(`  - **No source quote recorded** — check it against this volume's source before changing anything.`);
    const raised = Array.isArray(d.raised) ? d.raised : [];
    if (raised.length > 0) {
      lines.push(`  - Raised in: ${raised.map((r) => `volume ${r.volume}${r.chapter ? ` ${r.chapter}` : ""}`).join(", ")}`);
    }
  }
  if (list.length > shown.length) {
    lines.push(`- …and ${list.length - shown.length} more (see glossary-disputes.md at the series root).`);
  }
  return lines.join("\n");
}

function buildUnusedEntriesNote(coverage, limit = 40) {
  const terms = coverage && Array.isArray(coverage.terms) ? coverage.terms : [];
  if (terms.length === 0) return "";
  const zero = terms.filter((t) => t && typeof t.occurrences === "number" && t.occurrences === 0);
  if (zero.length === 0) return "";
  const named = zero.slice(0, limit).map((t) => `- ${t.term}${t.section ? ` (${t.section})` : ""}`);
  const rest = zero.length - named.length;
  return (
    `\n\n## Entries the previous volume never used\n` +
    `The coverage audit of volume ${coverage.volume} found ${zero.length} glossary entr(ies) that do not ` +
    `occur ONCE in that volume's text:\n${named.join("\n")}` +
    (rest > 0 ? `\n- … and ${rest} more.` : "") +
    `\n\nFor each one you can see in the current glossary: if it is a real term that simply does not ` +
    `appear in these chapters, keep it unchanged. If it has no support in the text at all, treat it as a ` +
    `candidate for removal (or for a corrected source form) and say so in the glossary's notes rather ` +
    `than carrying it forward silently.\n`
  );
}

// ─── Malformed-tool-call guard ──────────────────────────────────────────────

// The "model emitted tool-call syntax as plain text" guard (emittedToolCallAsText
// + assertRealToolCalls) is shared by every file-writing task — see
// utils/agents.js (AGENTS.md gotcha 18).

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
  const placeholder = pendingPlaceholder(term.term);
  const target = seg
    ? `the "${placeholder}" line under the "### ${term.term}" heading in the "## Chapter ${seg.id}" section`
    : `that term's "${placeholder}" line (approximately line ${approxLine})`;
  return (
    `Working folder: the volume folder (you are in it).\n\n` +
    `${sourceContextLine}\n\n` +
    `Your task: research the following term and write your notes to the file ` +
    `"glossary-research.md" in your working folder:\n\n` +
    `Term: ${term.term} (${term.type}) — suggested query: ${term.query}\n\n` +
    `The file "glossary-research.md" already exists. It contains the unique ` +
    `placeholder line "${placeholder}" for this term (${target}). ` +
    `Use editFile to replace ONLY that exact line (its oldText is ` +
    `"${placeholder}") with your final research notes. Do not modify any other ` +
    `term's notes.\n\n` +
    `Per-term budget: at most 2 wiki_search calls and 1 wiki_extract call. Start ` +
    `from the suggested query; search in the source language first, then English ` +
    `if useful.\n\n` +
    `Final notes format (replacing the "${placeholder}" line):\n` +
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
    const researchResult = await agent.sendTurn(
      buildPerTermResearchPrompt(ctx, term, index, seg),
      { label: `glossary-research-term-${ctx.values.INSTALLMENT_NUMBER}-${term.term.slice(0, 20)}` }
    );
    assertRealToolCalls(researchResult, `the researcher agent for "${term.term}"`, ctx.values.INSTALLMENT_NUMBER);
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
    `contains a section for each of the following terms, each with a UNIQUE placeholder ` +
    `line of the form "- (pending: <term>)" (the term's own name inside the parentheses):\n` +
    `${termsListText}\n\n` +
    `Your job: for each term, research it, then IMMEDIATELY use editFile to replace ` +
    `that term's placeholder line (oldText "- (pending: <that term's name>)") with its final notes. ` +
    `Each placeholder is unique to its term, so the edit can never touch another term's ` +
    `notes. Do not wait until the end to write anything — save progress after every term.\n\n` +
    `Per-term budget: at most 2 wiki_search calls and 1 wiki_extract call. Start ` +
    `from the suggested query; search in the source language first, then English ` +
    `if useful.\n\n` +
    `Final notes format for each term (replacing that term's "- (pending: <term>)" line):\n` +
    `- <page title> (<lang>) — <URL>\n` +
    `  <1-3 sentence summary: what the term is and any established ` +
    `${values.TARGET_LANGUAGE} name>\n\n` +
    `Rules:\n` +
    `- If a term has no external reference, replace its "- (pending: <term>)" line with ` +
    `"- (no external reference found)".\n` +
    `- Keep each term's notes under about 5 lines.\n` +
    `- If you are running low on steps, stop researching and make sure every ` +
    `remaining "- (pending: <term>)" line has been replaced (a short note or ` +
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
    // The disputes queue is a first-class input: the amend pass is the only
    // stage that can settle a challenged rendering, so it has to see it.
    DISPUTES: (ctx.disputesText || "").trim() || "(no open glossary disputes)",
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
  // --force here means "redo THIS stage" — it does NOT re-run the intake (see getTranslationTarget).
  const manifest = await getTranslationTarget({ dryRun });
  // Series name + languages: .env override > the intake manifest's decision >
  // the default (one rule for every stage — see resolveRunSettings).
  const runSettings = resolveRunSettings(manifest);
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
  // "--volume NN" is resolved through the manifest's installment numbers, not by
  // parsing folder names — the intake agent chooses the folder names.
  let volumes = sorted;
  if (volumeArg) {
    volumes = filterVolumesByInstallment(manifest, volumeArg);
    if (volumes.length === 0) {
      throw new Error(
        `No volume matching --volume ${volumeArg} (manifest volumes: ` +
          `${manifest.volumes.map((v) => `${v.installmentNumber} = ${v.folder}`).join(", ")}).`
      );
    }
    console.log(`--volume: processing only ${volumes.join(", ")}`);
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
    const volumeLabel = `Volume ${volume.installmentNumber}`;
    const glossaryOutputFile = path.join(volumeDir, "glossary.md");
    const validationOutputFile = path.join(volumeDir, "glossary-validation.md");
    const researchNotesFile = path.join(volumeDir, "glossary-research.md");

    if (!(await fileExists(bundle.originalPath))) {
      throw new Error(`Required source file not found: ${bundle.originalPath}`);
    }

    const values = {
      INSTALLMENT_NUMBER: volume.installmentNumber,
      SOURCE_NAME: runSettings.seriesName,
      SOURCE_LANGUAGE: runSettings.sourceLanguage,
      TARGET_LANGUAGE: runSettings.targetLanguage,
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

    // Report → input: the previous volume's coverage audit (which glossary entries
    // were never used) is handed to this volume's extraction pass.
    let unusedEntriesNote = "";
    if (previousFolderName) {
      try {
        const coveragePath = path.join(seriesDir, previousFolderName, "glossary-coverage.json");
        if (await fileExists(coveragePath)) {
          unusedEntriesNote = buildUnusedEntriesNote(JSON.parse(await fs.readFile(coveragePath, "utf8")));
        }
      } catch (err) {
        console.warn(
          `Volume ${values.INSTALLMENT_NUMBER}: could not read the previous volume's coverage audit ` +
            `(${err.message}) — extraction proceeds without it.`
        );
      }
    }

    // Report → input: the glossary disputes the translation stage raised
    // (verify-translate found that the SOURCE contradicts a canonical rendering).
    // Without this the glossary only ever grows and a wrong entry is carried
    // forward by every later volume while the QA loop argues about it each time.
    let disputesText = "";
    try {
      const disputes = await loadGlossaryDisputes(seriesDir);
      disputesText = buildDisputesNote(disputes, values.INSTALLMENT_NUMBER);
      if (disputesText) {
        console.log(
          `Volume ${values.INSTALLMENT_NUMBER}: ${disputes.length} open glossary dispute(s) ` +
            `are part of this volume's amendment task.`
        );
      }
    } catch (err) {
      console.warn(
        `Volume ${values.INSTALLMENT_NUMBER}: could not read the glossary disputes queue ` +
          `(${err.message}) — amending without them.`
      );
    }

    // Whole-installment vs chapter-by-chapter, decided against THIS stage's
    // model window and the reference it will actually inject (the previous
    // volume's cumulative glossary — decided per volume because it grows every
    // volume). See planProcessingMode in utils/source.js.
    const mode = await decideProcessingMode({
      bundle,
      label: volumeLabel,
      previousArtifactFiles: previousGlossaryFile ? [previousGlossaryFile] : [],
      forceChunked: chunkedArg,
      dryRun,
    });

    // Transform the prompts that use only the standard placeholders.
    const termsPrompt = transformUserPrompt(termsTemplate, values) + unusedEntriesNote;
    const validatorPrompt = transformUserPrompt(validatorTemplate, values);
    const feedbackPrompt = transformUserPrompt(feedbackTemplate, values);
    const acceptancePrompt = transformUserPrompt(acceptanceTemplate, values);

    const ctx = {
      values,
      folderName,
      volumeDir,
      sourceFile,
      bundle,
      chunked: mode.chunked,
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
      disputesText,
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
        if (skip && isSourceStale(state, bundle)) {
          skip = false;
          console.log(
            `Volume ${values.INSTALLMENT_NUMBER}: the source file changed since ` +
              `the last run (fingerprint mismatch) — regenerating instead of skipping.`
          );
        }
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
      // The coverage report is deterministic (no AI) — refresh it even on a
      // skip so a source change is visible without a full regeneration.
      await writeGlossaryCoverageReport(ctx);
      console.log(
        `Volume ${values.INSTALLMENT_NUMBER}: glossary already exists and passed. Skipping.`
      );
      continue;
    }

    // A volume is being (re)generated; later volumes depend on it.
    regeneratedAny = true;

    await runVolumeWithModeFallback({
      label: volumeLabel,
      ctx,
      volumeDir,
      run: async () => {
        await runVolumeAgent(ctx);
        // Deterministic term-coverage audit of the finished glossary (no AI) —
        // also the per-volume "terms used here" index for the translation stage.
        await writeGlossaryCoverageReport(ctx);
      },
      attemptFiles: [
        "glossary.md",
        "glossary-new-terms.json",
        "glossary-research.md",
        "glossary-validation.md",
        "glossary-validation-rolling-state.json",
        "glossary-coverage.md",
        "glossary-coverage.json",
      ],
      attemptGlob: /^glossary-.*\.md$/,
    });
    } catch (err) {
      // Volume-level error isolation (ON_VOLUME_ERROR): "skip" records the
      // failure and continues with the next volume (an un-monitored run must
      // not die on one broken volume); "abort" (default) rethrows and fails
      // the task as before.
      // A STRUCTURAL failure is never skippable (see configs/shared.js structuralError).
      if (ON_VOLUME_ERROR !== "skip" || isStructuralError(err)) throw err;
      failedVolumes.push({ folder: folderName, error: err });
      const entry = volumeByFolder.get(folderName);
      console.error(
        `[skip] Volume ${entry ? entry.installmentNumber : folderName} ` +
          `(${folderName}) failed: ${err.message} — continuing with the next ` +
          `volume (ON_VOLUME_ERROR=skip).`
      );
    }
  }

  // Copy the last volume's glossary to the series root for easy access
  // (skipped for single-volume runs, which would publish a stale snapshot).
  if (volumeArg || dryRun) {
    console.log(
      volumeArg
        ? "\n--volume: skipping the series-root copy (single-volume run)."
        : "\n--dry-run: skipping the series-root copy (dry runs make no file writes)."
    );
  } else {
    const finalGlossaryFile = seriesArtifactFile("glossary.md", "GLOSSARY_OUTPUT_FILE", seriesDir);
    let lastGlossary = null;
    for (let i = sorted.length - 1; i >= 0; i--) {
      const candidate = path.join(seriesDir, sorted[i], "glossary.md");
      // "Last EXISTING" means last REAL one: an empty or scaffold-stub snapshot
      // left by a failed volume is not the series' current glossary.
      if (await hasRealOutput(candidate)) {
        lastGlossary = candidate;
        break;
      }
    }
    if (lastGlossary) {
      await fs.copyFile(lastGlossary, finalGlossaryFile);
      await writeProvenanceSidecar(finalGlossaryFile, lastGlossary);
      console.log(`\nCopied the final glossary to: ${finalGlossaryFile}`);
    } else {
      console.log("\nNo glossary snapshots found; nothing to copy to the series root.");
    }
  }

  // A task that failed volumes fails the run. The summary used to be printed and
  // the task exited 0, so an overnight run with every volume broken looked like a
  // success and the pipeline marched on into the audit and the translation stage.
  const volumeError = volumeFailureError("glossary", failedVolumes, volumes.length);
  if (volumeError) throw volumeError;
}

/**
 * Shared acceptance check: always a tool-less single-shot call.
 * The model sees the glossary ITSELF plus its validation report (the
 * report is a guide, not the source of truth) and scores it 0–100
 * (100 = perfect, 0 = atrocious) as a JSON reply {score, band, note};
 * the score — not a binary verdict — is what the rolling window tracks.
 *
 * @param {GlossaryVolumeCtx} ctx - The volume context (see glossary()).
 * @param {number} iteration - The current QA iteration (for the log label).
 * @returns {Promise<number | null>} The parsed score (0–100), or `null` when
 *   no valid score could be extracted (treated as a failed check).
 */
async function acceptanceCheck(ctx, iteration, temperature) {
  const { values, validationOutputFile, acceptancePrompt, acceptanceSystemPrompt, glossaryOutputFile } = ctx;
  const acceptanceOutput = await harness.runOneShot({
    systemPrompt: acceptanceSystemPrompt,
    messages: [
      { file: glossaryOutputFile, name: "glossary.md" },
      { file: validationOutputFile, name: "glossary-validation.md" },
      { text: acceptancePrompt },
    ],
    // A grader, not a writer: JUDGE_TEMPERATURE (the house writing temperature
    // used to apply here, which made the acceptance score needlessly noisy).
    temperature: temperature ?? judgeTemperature(),
    label: `glossary-acceptance-${values.INSTALLMENT_NUMBER}-${iteration}`,
  });
  const reply = parseAcceptanceReply(acceptanceOutput);
  if (reply === null) {
    console.log(
      `Volume ${values.INSTALLMENT_NUMBER}: acceptance check: no valid score in ` +
        `response (got: ${JSON.stringify(acceptanceOutput.trim().slice(0, 120))}). ` +
        `Counting this check as a failure.`
    );
  } else {
    console.log(
      `Volume ${values.INSTALLMENT_NUMBER}: acceptance check: score ${reply.score}/100` +
        (reply.band ? ` (band: ${reply.band})` : "") +
        (reply.note ? ` — ${reply.note}` : "") +
        ` (passing score: ${ACCEPTANCE_PASSING_SCORE})`
    );
  }
  return reply ? reply.score : null;
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
/**
 * The unique placeholder line for one term in the research skeleton.
 *
 * It embeds the term so a parallel agent's editFile can target EXACTLY its own
 * line. A bare "- (pending)" is not unique: with two terms in the file, the
 * agent's editFile oldText would match two lines and the edit is ambiguous (and
 * fails), so the term's notes would never land.
 *
 * @param {string} term - The term being researched.
 * @returns {string}
 */
function pendingPlaceholder(term) {
  return `- (pending: ${term})`;
}

/**
 * Create or extend the skeleton-first research notes file with this chapter's
 * terms (chunked fallback). Chapter 1 creates the file with the volume header;
 * later chapters append a "## Chapter <id>" section. Each term gets a
 * "### <term>" heading with a unique "- (pending: <term>)" placeholder line.
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
    section.push(pendingPlaceholder(t.term));
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

  const allChunkedTerms = [];
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
      // The truncation is ranked by what THIS chapter actually contains (see
      // truncateGlossary), so the cumulative glossary shown to the extractor is
      // the part of it that matters for this chapter.
      const chapterSource = await fs.readFile(path.join(volumeDir, segment.file), "utf8");
      messages.push(
        await inlineReferenceMessage(stateFile, si === 0 ? "glossary-previous.md" : "glossary-current.md", {
          truncate: (raw) => truncateGlossary(raw, chapterSource),
        })
      );
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
    allChunkedTerms.push(...terms);
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

  // Persist the volume's new-term extraction (all chapters) so the
  // translation handoff (utils/handoff.js) can render a "what's new in this
  // volume" section without re-calling the AI.
  try {
    await fs.writeFile(
      path.join(volumeDir, "glossary-new-terms.json"),
      JSON.stringify(allChunkedTerms, null, 2) + "\n",
      "utf8"
    );
  } catch (err) {
    console.warn(
      `Volume ${values.INSTALLMENT_NUMBER}: could not persist glossary-new-terms.json (${err.message}) — continuing.`
    );
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
        assertRealToolCalls(validateResult, `the validator agent (chapter ${segment.id})`, values.INSTALLMENT_NUMBER);
        const validateFallbackUsed = await assertWroteWithFallback(
          partialFile,
          `the validator agent (chapter ${segment.id})`,
          validateResult?.text
        );
        // Recovery turn: ONLY when the partial was actually missing after the
        // fallback — never over a file the agent already wrote correctly.
        if (validateFallbackUsed && process.env.AGENT_RECOVERY_ENABLED !== "false") {
          const hasContent = validateResult?.text && validateResult.text.trim().length > 0;
          const recoveryPrompt = hasContent
            ? `You were asked to write the validation report to "${path.basename(partialFile)}" using writeFile, but you replied with the content in your chat message instead. Please rewrite the complete report using writeFile now.`
            : `You produced no output. Please read the materials and write the complete validation report to "${path.basename(partialFile)}" using writeFile now.`;
          const recoveryResult = await validator.sendTurn(recoveryPrompt, {
            label: `glossary-validate-recovery-${values.INSTALLMENT_NUMBER}-${iteration}-${segment.id}`,
          });
          assertRealToolCalls(recoveryResult, `the validator agent (recovery, chapter ${segment.id})`, values.INSTALLMENT_NUMBER);
          await assertWroteWithFallback(
            partialFile,
            `the validator agent (recovery, chapter ${segment.id})`,
            recoveryResult?.text
          );
        }
        await assertRealOutput(partialFile, `the validator agent (chapter ${segment.id})`);
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
      assertRealToolCalls(mergeResult, "the findings-merge agent", values.INSTALLMENT_NUMBER);
      await assertWroteWithFallback(validationOutputFile, "the findings-merge agent", mergeResult?.text);
      await assertRealOutput(validationOutputFile, "the findings-merge agent");
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
    await saveRollingState(stateFilePath, recentRollingScores, {
      sourceFingerprint: ctx.bundle ? ctx.bundle.sourceFingerprint : undefined,
    });

    // The same exceptional-score confirmation the whole-installment loop runs
    // (utils/qa-loop.js): a top-band grade is re-graded at temperature 0 and the
    // calm judging temperature, and a consensus accepts the volume WITHOUT the
    // expensive per-chapter feedback round below.
    const exceptional = await confirmExceptionalScore({
      score,
      recentRollingScores,
      confirmationCheck: ({ index, temperature }) => acceptanceCheck(ctx, `confirm${index + 1}`, temperature),
      volumeLabel: `Volume ${values.INSTALLMENT_NUMBER}`,
      stateFile: stateFilePath,
      sourceFingerprint: ctx.bundle ? ctx.bundle.sourceFingerprint : undefined,
    });
    if (exceptional.accepted) {
      // The chunked loop's contract: the only other way out of the loop is the
      // iteration limit (which sets ctx.limitReached). Reaching here means the
      // consensus accepted the volume, so record HOW it was accepted for the
      // run summary and stop before the per-chapter feedback round.
      ctx.acceptedBy = "exceptional-consensus";
      break;
    }

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
        assertRealToolCalls(feedbackResult, `the author agent (feedback pass, chapter ${segment.id})`, values.INSTALLMENT_NUMBER);
        const feedbackFallbackUsed = await assertWroteWithFallback(
          glossaryOutputFile,
          `the author agent (feedback pass, chapter ${segment.id})`,
          feedbackResult?.text
        );
        // Recovery turn: ONLY when the glossary was actually missing after the
        // fallback — never over a file the agent already wrote correctly.
        if (feedbackFallbackUsed && process.env.AGENT_RECOVERY_ENABLED !== "false") {
          const hasContent = feedbackResult?.text && feedbackResult.text.trim().length > 0;
          const recoveryPrompt = hasContent
            ? `You were asked to write the complete glossary to "glossary.md" using writeFile, but you replied with the content in your chat message instead. Please rewrite the complete glossary using writeFile now.`
            : `You produced no output. Please read the materials and write the complete glossary to "glossary.md" using writeFile now.`;
          const recoveryResult = await feedbackAuthor.sendTurn(recoveryPrompt, {
            label: `glossary-feedback-recovery-${values.INSTALLMENT_NUMBER}-${iteration}-${segment.id}`,
          });
          assertRealToolCalls(recoveryResult, `the author agent (feedback recovery, chapter ${segment.id})`, values.INSTALLMENT_NUMBER);
          await assertWroteWithFallback(
            glossaryOutputFile,
            `the author agent (feedback recovery, chapter ${segment.id})`,
            recoveryResult?.text
          );
        }
        await assertRealOutput(glossaryOutputFile, `the author agent (feedback pass, chapter ${segment.id})`);
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
    // Inlined (not readFile) — so the cumulative glossary is bounded here.
    const volumeSourceText = await fs.readFile(sourceFile, "utf8");
    baseMessages.push(
      await inlineReferenceMessage(previousGlossaryFile, "glossary-previous.md", {
        truncate: (raw) => truncateGlossary(raw, volumeSourceText),
      })
    );
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
  // Persist the volume's new-term extraction so the translation handoff
  // (utils/handoff.js) can render a "what's new in this volume" section
  // without re-calling the AI.
  try {
    await fs.writeFile(
      path.join(volumeDir, "glossary-new-terms.json"),
      JSON.stringify(terms, null, 2) + "\n",
      "utf8"
    );
  } catch (err) {
    console.warn(
      `Volume ${values.INSTALLMENT_NUMBER}: could not persist glossary-new-terms.json (${err.message}) — continuing.`
    );
  }

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
      skeletonLines.push(pendingPlaceholder(terms[ti].term));
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
      const remainingText = await fs.readFile(researchNotesFile, "utf8");
      // Count the unique "- (pending: <term>)" lines still present (a bare
      // "- (pending)" split would not match the new unique format).
      const remaining = (remainingText.match(/^- \(pending: .+\)$/gm) || []).length;
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
    assertRealToolCalls(amendResult, `the author agent (amend${seg ? `, chapter ${seg.id}` : ""})`, values.INSTALLMENT_NUMBER);
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
      assertRealToolCalls(recoveryResult, "the author agent (recovery)", values.INSTALLMENT_NUMBER);
      // Overwrite with the recovery output (may be the same content, now via writeFile).
      await assertWroteWithFallback(
        glossaryOutputFile,
        "the author agent (recovery)",
        recoveryResult?.text
      );
    }
    // Hard stop: the recovery turn is the last chance — a still-missing or
    // empty glossary is a failure, not an output.
    await assertRealOutput(glossaryOutputFile, "the author agent");

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
 * report and current glossary). Runs the shared loop from utils/qa-loop.js
 * with the glossary-specific pieces supplied here.
 *
 * @param {GlossaryVolumeCtx} ctx - The volume context (must include ctx.fsGate).
 */
async function runQaLoop(ctx) {
  const { values, volumeDir, sourceFile, validationOutputFile, fsGate } = ctx;
  const result = await runSharedQaLoop({
    volumeLabel: `Volume ${values.INSTALLMENT_NUMBER}`,
    maxIterations: maxValidationIterations,
    onQaLimit: ON_QA_LIMIT,
    validationOutputFile,
    stateFile: validationOutputFile.replace(".md", "-rolling-state.json"),
    sourceFingerprint: ctx.bundle ? ctx.bundle.sourceFingerprint : undefined,
    createValidatorAgent: async (iteration) => harness.createAgentHandle({
      name: `validator-${values.INSTALLMENT_NUMBER}-${iteration}`,
      systemPrompt: ctx.validatorSystemPrompt + AGENT_TOOLS_NOTE,
      tools: fsGate.tools,
      approve: fsGate.approve,
      cwd: volumeDir,
      // scaled to the source size (see validatorMaxStepsFor)
      maxSteps: validatorMaxStepsFor((await fs.stat(sourceFile)).size),
    }),
    buildValidatorTurn: (iteration) => buildGlossaryValidatorTurnPrompt(ctx),
    validatorLabel: (iteration) => `glossary-validate-${values.INSTALLMENT_NUMBER}-${iteration}`,
    validatorRecoveryLabel: (iteration) => `glossary-validate-recovery-${values.INSTALLMENT_NUMBER}-${iteration}`,
    validatorRecoveryPrompt: (hasContent) => hasContent
      ? `You were asked to write the validation report to "glossary-validation.md" using writeFile, but you replied with the content in your chat message instead.\n\n` +
        `The file has been temporarily written from your chat reply, but it must be written properly using writeFile. ` +
        `Please rewrite the complete validation report to "glossary-validation.md" using writeFile now. Use the exact same content you generated in your previous message.`
      : `You were asked to write the validation report to "glossary-validation.md" using writeFile, but you produced no output.\n\n` +
        `Please read the source materials and write the complete validation report to "glossary-validation.md" using writeFile now.`,
    assertRealToolCalls: (result, who) => assertRealToolCalls(result, who, values.INSTALLMENT_NUMBER),
    acceptanceCheck: (iteration) => acceptanceCheck(ctx, iteration),
    // Exceptional-score confirmation re-grades (see utils/qa-loop.js): the same
    // artifact, graded again — the loop asks for temperature 0 on the first one.
    confirmationCheck: ({ index, temperature }) => acceptanceCheck(ctx, `confirm${index + 1}`, temperature),
    feedbackLogLine: () => `Volume ${values.INSTALLMENT_NUMBER}: applying validation feedback (fresh author agent)...`,
    runFeedback: (iteration) => runGlossaryFeedback(ctx, iteration),
    limitReachedLogLine: () => `Volume ${values.INSTALLMENT_NUMBER}: reached the validation iteration limit without a passing grade. The last feedback pass is unvalidated; re-run to validate it.`,
  });
  ctx.limitReached = result.limitReached;
  return result;
}

/**
 * The glossary feedback stage (called by the shared QA loop in
 * utils/qa-loop.js): a fresh author agent applies the validation report to
 * the glossary. The feedback prompt is self-contained: it includes the
 * validation report and the current glossary so the agent has all context
 * it needs.
 *
 * @param {GlossaryVolumeCtx} ctx - The volume context (must include ctx.fsGate).
 * @param {number} iteration - The current QA iteration (agent name + labels).
 */
async function runGlossaryFeedback(ctx, iteration) {
  const { values, volumeDir, glossaryOutputFile } = ctx;

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
    assertRealToolCalls(feedbackResult, "the author agent (feedback pass)", values.INSTALLMENT_NUMBER);
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
      assertRealToolCalls(feedbackRecoveryResult, "the author agent (feedback recovery)", values.INSTALLMENT_NUMBER);
      await assertWroteWithFallback(
        glossaryOutputFile,
        "the author agent (feedback recovery)",
        feedbackRecoveryResult?.text
      );
    }
    await assertRealOutput(glossaryOutputFile, "the author agent (feedback pass)");
  } finally {
    await feedbackAuthor.close();
  }
}

// ─── Deterministic term-coverage audit ──────────────────────────────────────
// The glossary validator checks completeness with judgment (an LLM); this
// audit adds the deterministic half — exact occurrence counts of every
// glossary term in this volume's source text — and doubles as the
// per-volume "terms used here" index the translation stage needs (the
// cumulative glossary grows; a translator of volume N only needs the terms
// volume N actually uses).

/**
 * Parse the source-language terms out of a glossary Markdown file.
 *
 * Walks the table rows and keeps the FIRST column, tracking the `## `
 * section each row belongs to. For each maximal run of consecutive table
 * rows, the first row (header) and the second row (separator, e.g.
 * `|---|---|---|`) are skipped. Emphasis-wrapped cells are normalized.
 *
 * @param {string} markdown - The glossary file content.
 * @returns {Array<{term: string, section: string}>} One entry per term row,
 *   in file order.
 */
function parseGlossaryTableTerms(markdown) {
  if (!markdown || typeof markdown !== "string") return [];
  const entries = [];
  let section = "";
  let tableRows = [];
  const flushTable = () => {
    // Row 0 = header, row 1 = separator — data starts at row 2.
    for (let ri = 2; ri < tableRows.length; ri++) {
      const cells = tableRows[ri]
        .split("|")
        .map((c) => c.trim())
        .filter((c) => c !== "");
      if (cells.length === 0) continue;
      let term = cells[0].trim();
      term = term.replace(/^`+|`+$/g, "").trim();
      term = term.replace(/^\*+|\*+$/g, "").trim();
      term = term.replace(/^_+|_+$/g, "").trim();
      if (!term) continue;
      if (/^:?-{3,}:?$/.test(term)) continue; // stray separator
      if (/^\[.*\]$/.test(term)) continue; // unrendered template placeholder
      entries.push({ term, section });
    }
    tableRows = [];
  };
  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim();
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      flushTable();
      section = heading[1].replace(/\*/g, "").trim();
      continue;
    }
    if (line.startsWith("|")) {
      tableRows.push(line);
      continue;
    }
    flushTable();
  }
  flushTable();
  return entries;
}

/**
 * Count (non-overlapping) occurrences of a term in a source text.
 *
 * Substring matching is the correct semantics for Japanese (no word
 * boundaries) and works for any script; glossary terms are proper nouns, so
 * the few false positives from shorter embedded terms are acceptable for a
 * coverage audit.
 *
 * @param {string} sourceText - The whole-volume source text.
 * @param {string} term - The source-language term to count.
 * @returns {number} The occurrence count.
 */
function countTermOccurrences(sourceText, term) {
  if (!sourceText || !term || typeof sourceText !== "string" || typeof term !== "string") {
    return 0;
  }
  let count = 0;
  let idx = sourceText.indexOf(term);
  while (idx !== -1) {
    count++;
    idx = sourceText.indexOf(term, idx + Math.max(1, term.length));
  }
  return count;
}

/**
 * Build the glossary coverage report (pure — testable without the filesystem).
 *
 * @param {{seriesName: string, installmentNumber: string, entries: Array<{term: string, section: string}>, sourceText: string}} p
 * @returns {string} The Markdown report.
 */
function buildGlossaryCoverageReportMarkdown({ seriesName, installmentNumber, entries, sourceText }) {
  const rows = [];
  const zeroTerms = [];
  for (const e of entries) {
    const count = countTermOccurrences(sourceText, e.term);
    rows.push(`| ${e.term} | ${e.section || "—"} | ${count} |`);
    if (count === 0) zeroTerms.push(e);
  }
  const lines = [];
  lines.push(`# Glossary Coverage — ${seriesName}, Volume ${installmentNumber}`);
  lines.push("");
  lines.push(
    "_Deterministic audit: each glossary term's occurrence count in this volume's source text " +
      "(substring match — the correct semantics for Japanese). Generated by the glossary task; no AI involved. " +
      "A zero-occurrence term is a candidate for a hallucinated entry or a term this volume no longer uses; " +
      "the AI validator's completeness check (terms present in the source but missing from the glossary) is " +
      "the complementary, judgment-based half of this audit._"
  );
  lines.push("");
  lines.push(`## Term occurrences (${entries.length} glossary terms)`);
  lines.push("");
  lines.push("| Term | Section | Occurrences |");
  lines.push("|---|---|---|");
  if (rows.length === 0) {
    lines.push("| (no terms parsed from the glossary) | — | — |");
  } else {
    lines.push(...rows);
  }
  lines.push("");
  lines.push("## Terms with zero occurrences");
  lines.push("");
  if (zeroTerms.length === 0) {
    lines.push("(none — every glossary term appears in this volume's source)");
  } else {
    for (const e of zeroTerms) lines.push(`- ${e.term} (${e.section || "—"})`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Write the deterministic term-coverage report for one volume
 * (glossary-coverage.md) — no AI call. Runs after the glossary is accepted
 * (and on the skip path, to keep the report fresh when the source changes).
 *
 * Best-effort by design: this audit is supplementary, so a failure is logged
 * as a warning and never fails an already-accepted volume.
 *
 * @param {GlossaryVolumeCtx} ctx - The volume context (must include bundle,
 *   glossaryOutputFile, values).
 * @returns {Promise<void>}
 */
async function writeGlossaryCoverageReport(ctx) {
  const { values, volumeDir, bundle, glossaryOutputFile } = ctx;
  const reportFile = path.join(volumeDir, "glossary-coverage.md");
  const jsonFile = path.join(volumeDir, "glossary-coverage.json");
  try {
    const glossaryContent = await fs.readFile(glossaryOutputFile, "utf-8");
    const sourceText = await fs.readFile(bundle.wholePath, "utf-8");
    const entries = parseGlossaryTableTerms(glossaryContent);
    const report = buildGlossaryCoverageReportMarkdown({
      seriesName: values.SOURCE_NAME,
      installmentNumber: values.INSTALLMENT_NUMBER,
      entries,
      sourceText,
    });
    await fs.writeFile(reportFile, report, "utf-8");
    // Machine-readable sidecar (same data as the Markdown table) — the
    // translation stage can load it for per-term "used in this volume" lookups
    // without parsing Markdown.
    await fs.writeFile(
      jsonFile,
      JSON.stringify(
        {
          seriesName: values.SOURCE_NAME,
          volume: values.INSTALLMENT_NUMBER,
          terms: entries.map((e) => ({
            term: e.term,
            section: e.section || null,
            occurrences: countTermOccurrences(sourceText, e.term),
          })),
        },
        null,
        2
      ) + "\n",
      "utf-8"
    );
    const zero = entries.filter((e) => countTermOccurrences(sourceText, e.term) === 0).length;
    console.log(
      `Volume ${values.INSTALLMENT_NUMBER}: glossary coverage report written ` +
        `(${entries.length} terms, ${zero} with zero occurrences) → ${reportFile} + ${path.basename(jsonFile)}`
    );
  } catch (err) {
    console.warn(
      `Volume ${values.INSTALLMENT_NUMBER}: could not write the glossary coverage report ` +
        `(${err.message}) — continuing.`
    );
  }
}

// ─── Export for use as a module ─────────────────────────────────────────────

module.exports = {
  glossary,
  parseTerms,
  truncateGlossary,
  buildUnusedEntriesNote,
  buildDisputesNote,
  emittedToolCallAsText,
  assertRealToolCalls,
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
  runGlossaryFeedback,
  parseGlossaryTableTerms,
  countTermOccurrences,
  buildGlossaryCoverageReportMarkdown,
  writeGlossaryCoverageReport,
};
