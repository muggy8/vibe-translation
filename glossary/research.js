/**
 * Researching the new terms against Wikipedia.
 *
 * Skeleton-first: the workflow pre-writes glossary-research.md with a `- (pending)`
 * line under every term and each agent replaces its OWN placeholder by editing one
 * unique line, so there are no write conflicts and a crashed run still leaves a
 * usable skeleton.
 *
 * Part of the glossary.js layer (split out of the original single file).
 */

require("dotenv").config();
require("../types"); // JSDoc type definitions
const harness = require("../harness");
const { emittedToolCallAsText, assertRealToolCalls } = require("../utils/agents");
const {
  resolveSourceBundle,
  decideProcessingMode,
  sourceMaterialLine,
  sourceSegmentListLine,
  chapterSegmentNote,
  chapterContextBlock,
} = require("../utils/source");

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
    ? `Context you may consult (optional): the chapter source "${seg.file}" (same folder) — search it with grep (dirPath "." and glob "${seg.file}") or read it selectively with readFile if you need disambiguation; you do not need to read it all.`
    : ctx.bundle
      ? `${ctx.chunked ? sourceSegmentListLine(ctx.bundle) : sourceMaterialLine(ctx.bundle)} — search it with grep (dirPath "." and glob set to the file's name) or read it selectively with readFile if you need disambiguation; you do not need to read it all.`
      : `Context you may consult (optional): the volume source "${ctx.folderName}.md" (same folder) — search it with grep (dirPath "." and glob "${ctx.folderName}.md") or read it selectively with readFile if you need disambiguation; you do not need to read it all.`;
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
    `Use editFile to replace ONLY that exact line (its oldString is ` +
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
    ? `${ctx.chunked ? sourceSegmentListLine(ctx.bundle) : sourceMaterialLine(ctx.bundle)} — search it with grep (dirPath "." and glob set to the file's name) or read it selectively with readFile if a term needs disambiguation; you do not need to read it all.`
    : `Context you may consult (optional): the volume source "${ctx.folderName}.md" (same folder) — search it with grep (dirPath "." and glob "${ctx.folderName}.md") or read it selectively with readFile if a term needs disambiguation; you do not need to read it all.`;
  return (
    `Working folder: the volume folder (you are in it).\n\n` +
    `${sourceContextLine}\n\n` +
    `The notes file "glossary-research.md" in your working folder already exists and ` +
    `contains a section for each of the following terms, each with a UNIQUE placeholder ` +
    `line of the form "- (pending: <term>)" (the term's own name inside the parentheses):\n` +
    `${termsListText}\n\n` +
    `Your job: for each term, research it, then IMMEDIATELY use editFile to replace ` +
    `that term's placeholder line (oldString "- (pending: <that term's name>)") with its final notes. ` +
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
 * The unique placeholder line for one term in the research skeleton.
 *
 * It embeds the term so a parallel agent's editFile can target EXACTLY its own
 * line. A bare "- (pending)" is not unique: with two terms in the file, the
 * agent's editFile oldString would match two lines and the edit is ambiguous (and
 * fails), so the term's notes would never land.
 *
 * @param {string} term - The term being researched.
 * @returns {string}
 */
function pendingPlaceholder(term) {
  return `- (pending: ${term})`;
}


module.exports = {
  buildPerTermResearchPrompt,
  researchOneTerm,
  researchBatch,
  RESEARCHER_SYSTEM_PROMPT,
  buildGlossaryResearcherTurnPrompt,
  pendingPlaceholder,
};
