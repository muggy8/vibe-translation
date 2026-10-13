/**
 * glossary/chunked.js — the chapter-by-chapter read pass, on the render route.
 *
 * A volume too large for one extraction call is read chapter by chapter, in reading order. Each chapter
 * goes through the same three steps the whole-installment pass does — **extract** its new terms, **research**
 * them, **file** what was found in the volume's record — and then the volume's `glossary.md` is **rendered**
 * out of the record again, so the next chapter's extractor is shown what the chapters before it already
 * decided.
 *
 * What changed when the author agent was deleted (slice 2 of `glossary/plan/01-glossary-route.md`): there is
 * no per-chapter *amend* pass and no per-chapter *validator* agent, no findings-merge agent and no
 * per-chapter feedback agent. The document is not amended between chapters, it is re-printed; the audit is
 * not a chapter-by-chapter reading, it is a query over the whole volume's record. What is left per chapter
 * is the reading, and the one thing a render can still get wrong — a row that was there and is not any
 * more — is checked per chapter, not at the volume boundary.
 *
 * That between-chapter gate is why the render happens per chapter at all. The observed damage on the live
 * 17-volume run happened DURING volume 06's per-chapter passes, not at its end, and catching it at chapter
 * 3 saves eight chapters of work built on a broken base.
 *
 * Part of the glossary.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("../types"); // JSDoc type definitions
const harness = require("../harness");
const { STAGE_CONCURRENCY: RESEARCH_CONCURRENCY } = require("../configs/shared");
const { fileExists, inlineReferenceMessage } = require("../utils/fs");
const { chapterSegmentNote } = require("../utils/source");

const { pendingPlaceholder, researchBatch } = require("./research");
const { fileGlossaryExtraction, fileGlossaryTermRows, renderGlossaryArtifact } = require("./store");
const { researchEnabled } = require("./config");
const { parseTerms, truncateGlossary } = require("./extract");
const { guardCarryForwardAgainst } = require("./carry-forward");

/**
 * Create or extend the skeleton-first research notes file with this chapter's
 * terms (chunked fallback). Chapter 1 creates the file with the volume header;
 * later chapters append a "## Chapter <id>" section. Each term gets a
 * "### <term>" heading with a unique "- (pending: <term>)" placeholder line.
 *
 * @param {string} researchNotesFile - Absolute path of glossary-research.md.
 * @param {{INSTALLMENT_NUMBER: string}} values - The volume values.
 * @param {import("../types").SourceSegment} segment - The chapter being researched.
 * @param {Array<{term: string, rendering: string, note: string, type: string, query: string}>} terms - Its new terms.
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
 * Read one volume chapter by chapter (the FALLBACK path, used when the whole installment is too large for
 * one extraction call): each chapter segment goes extract → research → file, in reading order, and the
 * volume's `glossary.md` is rendered out of the record after every chapter so each chapter's extractor sees
 * what the chapters before it decided.
 *
 * The volume is left rendered and the between-chapter gate has run; the acceptance gate is the volume-level
 * one in `glossary/qa.js`, which the caller runs for both routes.
 *
 * @param {GlossaryVolumeCtx} ctx - The volume context (must include bundle).
 * @returns {Promise<Array<Object>>} Every chapter's extracted terms, in reading order.
 */
async function runChunkedVolumeAgent(ctx) {
  const { values, bundle, volumeDir } = ctx;
  console.log(
    `Volume ${values.INSTALLMENT_NUMBER}: chapter-by-chapter read ` +
      `(${bundle.segments.length} segments, ${bundle.wholeChars} chars whole) — filing each chapter into the ` +
      `volume's record and re-rendering ${"glossary.md"} after it. No author agent.`
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
    const terms = await extractChapterTerms(ctx, segment, si);
    allChunkedTerms.push(...terms);
    await researchChapterTerms(ctx, segment, si, terms);
    // Two filings, from the same list, for the same two reasons the whole-installment pass files twice —
    // see `glossary/store.js`. The candidates are what this chapter's read pass noticed; the rows are what
    // the published file is printed from.
    fileGlossaryExtraction(ctx, terms);
    fileGlossaryTermRows(ctx, terms);
    await renderChapterGlossary(ctx, segment, si);
  }

  // Persist the volume's new-term extraction (all chapters) so the translation handoff (utils/handoff.js)
  // can render a "what's new in this volume" section without re-calling the AI.
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
  return allChunkedTerms;
}


/**
 * Step 1 of a chapter's pass: extract this chapter's new terms (one-shot).
 *
 * The cumulative reference handed to the extractor is the previous volume's glossary for the first chapter
 * and this volume's own rendered file afterwards — so each chapter is read against what the chapters before
 * it already published, not against a snapshot from before this volume started.
 *
 * A reply that cannot be parsed is not a failure of the volume: the chapter continues without research, and
 * its own text is still filed. A chapter that returned nothing files nothing, which the coverage audit
 * counts.
 *
 * @param {GlossaryVolumeCtx} ctx
 * @param {import("../types").SourceSegment} segment - The chapter being read.
 * @param {number} si - Zero-based position in reading order.
 * @returns {Promise<Array<{term: string, rendering: string, note: string, type: string, query: string}>>} The chapter's new terms.
 */
async function extractChapterTerms(ctx, segment, si) {
  const { values, bundle, volumeDir, glossaryOutputFile, previousGlossaryFile, termsPrompt, termsSystemPrompt } = ctx;
  console.log(
    `Volume ${values.INSTALLMENT_NUMBER}: chapter ${segment.id} (${segment.title}), ` +
      `${si + 1}/${bundle.segments.length} — extracting terms...`
  );
  const messages = [{ file: path.join(volumeDir, segment.file), name: segment.file }];
  const stateFile = si === 0 ? previousGlossaryFile : glossaryOutputFile;
  if (stateFile) {
    // The truncation is ranked by what THIS chapter actually contains (see truncateGlossary), so the
    // cumulative glossary shown to the extractor is the part of it that matters for this chapter.
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
  console.log(
    `Volume ${values.INSTALLMENT_NUMBER}: extracted ${terms.length} new term(s) from chapter ${segment.id}.`
  );
  return terms;
}

/**
 * Step 2 of a chapter's pass: research this chapter's new terms (skeleton-first, appended per chapter).
 *
 * The skeleton is written before any research runs, so a volume that dies half-way still has a file naming
 * every term it meant to look up.
 *
 * @param {GlossaryVolumeCtx} ctx
 * @param {import("../types").SourceSegment} segment
 * @param {number} si
 * @param {Array<{term: string, rendering: string, note: string, type: string, query: string}>} terms - What step 1 found.
 * @returns {Promise<void>}
 */
async function researchChapterTerms(ctx, segment, si, terms) {
  if (!researchEnabled || terms.length === 0) return;
  const { values, researchNotesFile } = ctx;
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

/**
 * Step 3 of a chapter's pass: re-render the volume's glossary out of the record, and refuse if the render
 * lost a row the previous chapter's render held.
 *
 * The baseline is read BEFORE the render and compared after it. On this route nothing between the two is a
 * model turn, so a loss here is not an agent rewriting a document from memory — it is the record or the
 * render itself dropping a row, which is the failure the render route has to earn its keep against. The
 * first chapter's baseline is the previous run's file for this volume (or nothing, on a clean run), and
 * every later chapter's is this volume's own previous render.
 *
 * @param {GlossaryVolumeCtx} ctx
 * @param {import("../types").SourceSegment} segment
 * @param {number} si
 * @returns {Promise<void>}
 * @throws {Error} When this chapter's render dropped a row the glossary already held, or the render refuses.
 */
async function renderChapterGlossary(ctx, segment, si) {
  const { values, glossaryOutputFile } = ctx;
  let chapterBaseline = null;
  try {
    chapterBaseline = await fs.readFile(glossaryOutputFile, "utf8");
  } catch {
    chapterBaseline = null; // No glossary yet — this chapter's render creates it.
  }

  // Only the first render of the volume moves an existing file aside: from chapter 2 on, the file being
  // replaced is this volume's own previous render, and a pile of `.rejected` copies of the same in-progress
  // document is noise, not evidence.
  const rendered = await renderGlossaryArtifact(ctx, { moveAside: si === 0 });
  if (!rendered.ok) {
    throw new Error(
      `Volume ${values.INSTALLMENT_NUMBER}: ${rendered.refusal.rule} — ${rendered.refusal.because} ` +
        `(fix: ${rendered.refusal.fix})`
    );
  }

  if (chapterBaseline !== null) {
    await guardCarryForwardAgainst(
      ctx,
      chapterBaseline,
      `the render after chapter ${segment.id}`,
      "the glossary as of the previous chapter"
    );
  }
}


module.exports = {
  appendResearchSkeleton,
  runChunkedVolumeAgent,
  extractChapterTerms,
  researchChapterTerms,
  renderChapterGlossary,
};
