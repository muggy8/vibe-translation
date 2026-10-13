/**
 * glossary/chunked.js — the chapter-by-chapter read pass, on the render route.
 *
 * A volume too large for one extraction call is read chapter by chapter, in reading order. Each chapter
 * goes through the same four steps the whole-installment pass does — **extract** its new terms, **file**
 * what was found in the volume's record, **research** what the record now says is worth a lookup, and
 * **render** the volume's `glossary.md` out of the record again — so the next chapter's extractor is shown
 * what the chapters before it already decided, research notes included.
 *
 * The order changed in slice 5 of `glossary/plan/01-glossary-route.md`, and the reason is the research
 * bound: it is a query over rows the record holds, so it can only run after the filing. Researching first
 * meant guessing which terms the record would accept, and it meant the answer had nowhere to be filed.
 *
 * What changed when the author agent was deleted (slice 2): there is no per-chapter *amend* pass and no
 * per-chapter *validator* agent, no findings-merge agent and no per-chapter feedback agent. The document is
 * not amended between chapters, it is re-printed; the audit is not a chapter-by-chapter reading, it is a
 * query over the whole volume's record. What is left per chapter is the reading, and the one thing a render
 * can still get wrong — a row that was there and is not any more — is checked per chapter, not at the
 * volume boundary.
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
const { fileExists, inlineReferenceMessage } = require("../utils/fs");
const { chapterSegmentNote } = require("../utils/source");

const { researchVolumeTerms } = require("./research");
const { fileGlossaryExtraction, fileGlossaryTermRows, renderGlossaryArtifact } = require("./store");
const { truncateGlossary, readTermList } = require("./extract");
const { guardCarryForwardAgainst } = require("./carry-forward");

/**
 * Read one volume chapter by chapter (the FALLBACK path, used when the whole installment is too large for
 * one extraction call): each chapter segment goes extract → file → research → render, in reading order, so
 * each chapter's extractor sees what the chapters before it published.
 *
 * The research bound is per **volume**, not per chapter: `ctx.researchTurnsLeft` starts at
 * `RESEARCH_MAX_TERMS_PER_VOLUME` and every chapter spends from the same number, and each chapter's pass
 * is narrowed to the terms that chapter just filed so a term is not looked up twice in one volume.
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
      `volume's record and re-rendering glossary.md after it. No author agent, no research agent.`
  );

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
    // The two filings come first, for the same two reasons the whole-installment pass files twice — see
    // `glossary/store.js`. The candidates are what this chapter's read pass noticed; the rows are what the
    // published file is printed from, and they are what the research pass is allowed to ask about.
    fileGlossaryExtraction(ctx, terms);
    fileGlossaryTermRows(ctx, terms);
    await researchChapterTerms(ctx, segment, si, terms);
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
 * A read that never produced a list is **not** a chapter that found nothing. It used to be reported as one:
 * the `catch` here logged "The chapter files nothing" and returned `[]`, which is the same value an honest
 * empty chapter produces, and the coverage audit counts rows rather than reads. The chapter is now recorded
 * in `ctx.extractionReads` with every paid read it took, and `glossary/store.js` prints that in the report
 * the grader reads. The chapter still files nothing and the volume still finishes — naming the hole is what
 * changed, not what the volume does with it.
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
  const chapterMessages = [...messages, { text: termsPrompt }, { text: chapterSegmentNote(bundle, segment, si) }];
  const read = await readTermList({
    label: `Volume ${values.INSTALLMENT_NUMBER} chapter ${segment.id}: the term list`,
    ask: ({ attempt, thinkingLevel }) =>
      harness.runOneShot({
        systemPrompt: termsSystemPrompt,
        messages: chapterMessages,
        label: `glossary-terms-${values.INSTALLMENT_NUMBER}-${segment.id}${attempt > 1 ? "-retry" : ""}`,
        ...(thinkingLevel ? { thinkingLevel } : {}),
      }),
  });
  const terms = read.terms;
  ctx.extractionReads = ctx.extractionReads || [];
  ctx.extractionReads.push({
    id: `chapter ${segment.id}`,
    title: segment.title,
    terms: terms.length,
    attempts: read.attempts,
    failed: read.failed,
  });
  console.log(
    `Volume ${values.INSTALLMENT_NUMBER}: extracted ${terms.length} new term(s) from chapter ${segment.id}` +
      `${read.failed ? " — NOTHING: this chapter's read never produced a list" : ""}.`
  );
  return terms;
}

/**
 * Step 3 of a chapter's pass: research the terms this chapter just filed, from the volume's remaining
 * research budget.
 *
 * Narrowed to this chapter's terms on purpose. The bound is per volume, and a chapter that re-asked every
 * researchable row the volume holds would spend the volume's twelve turns on chapter one and leave the
 * rest of the book with none.
 *
 * @param {GlossaryVolumeCtx} ctx
 * @param {import("../types").SourceSegment} segment
 * @param {number} si
 * @param {Array<{term: string, rendering: string, note: string, type: string, query: string}>} terms - What step 1 found, already filed by step 2.
 * @returns {Promise<Object>} The pass report. When the volume's budget is spent, `asked` is 0 and every
 *   researchable row of this chapter is in `skipped` — named in the log rather than quietly dropped.
 */
async function researchChapterTerms(ctx, segment, si, terms) {
  return researchVolumeTerms(ctx, { only: terms.map((term) => term.term), chapter: segment.id });
}

/**
 * Step 4 of a chapter's pass: re-render the volume's glossary out of the record, and refuse if the render
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
  runChunkedVolumeAgent,
  extractChapterTerms,
  researchChapterTerms,
  renderChapterGlossary,
};
