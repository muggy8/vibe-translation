/**
 * The task entry point and the per-volume whole-installment pass: resolve the plan
 * of record, walk the volumes in reading order, and keep the cumulative cascade —
 * regenerating any volume regenerates every later one, because their glossaries
 * would otherwise build on a stale base.
 *
 * The series plumbing (flags, plan of record, previous-volume gate, idempotency skip,
 * series-root publish, per-volume error policy) is the shared `utils/series-run` layer;
 * what is left here is the glossary's own decisions.
 *
 * Part of the glossary.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("../types"); // JSDoc type definitions
const harness = require("../harness");
const { transformUserPrompt, writePromptDump } = require("../utils/prompt");
const { validateRequiredEnv } = require("../configs/shared");
const { fileExists, inlineReferenceMessage } = require("../utils/fs");
const { loadGlossaryDisputes } = require("../utils/disputes");
const { runVolumeWithModeFallback } = require("../utils/qa-loop");
const { readRunArgs, openSeriesRun, locatePreviousVolume, requirePreviousArtifacts, volumeAlreadyAccepted, publishLatestToSeriesRoot, runVolumeSeries } = require("../utils/series-run");
const {
  resolveSourceBundle,
  decideProcessingMode,
  chapterSegmentNote,
} = require("../utils/source");

const { acceptanceSystemPromptFile, acceptanceUserPromptTemplateFile, seriesDir, termsSystemPromptFile, termsUserPromptTemplateFile } = require("./config");
const { buildDisputesNote, buildUnusedEntriesNote } = require("./notes");
const { researchVolumeTerms, RESEARCH_SYSTEM_PROMPT, buildResearchReadingPrompt } = require("./research");
const { RESEARCH_MAX_TERMS_PER_VOLUME } = require("./researchable");
const { assertGlossaryCarryForward } = require("./carry-forward");
const { openGlossaryRecord, fileGlossaryExtraction, fileGlossaryTermRows, renderGlossaryArtifact, quarantineGlossaryArtifact, sealGlossaryRecord } = require("./store");
const { writeGlossaryCoverageReport } = require("./coverage");
const { truncateGlossary, readTermList, termsResponseFormat } = require("./extract");
const { runChunkedVolumeAgent } = require("./chunked");
const { runQaLoop } = require("./qa");

/** The glossary stage's own file names inside a volume folder. */
const OUTPUT_FILE = "glossary.md";
const VALIDATION_FILE = "glossary-validation.md";
const RESEARCH_FILE = "glossary-research.md";
const NEW_TERMS_FILE = "glossary-new-terms.json";

/**
 * Read the glossary stage's prompt pair for each of the two roles it still has.
 *
 * The stage used to load five pairs: terms, author, validator, feedback and acceptance. The author agent
 * and the feedback agent are deleted (slice 2 of `glossary/plan/01-glossary-route.md`), and the validator
 * agent was already replaced by the record's queries (slice 1 made the record unconditional), so the three
 * pairs are gone from the stage and from `glossary/config.js` with it. What is left is the one call that
 * decides what the glossary contains and the one call that judges it.
 *
 * @returns {Promise<Object>} `{ termsSystemPrompt, termsTemplate, acceptanceSystemPrompt, acceptanceTemplate }`.
 */
async function loadPromptFiles() {
  const read = (file) => fs.readFile(file, "utf-8");
  return {
    termsSystemPrompt: await read(termsSystemPromptFile),
    acceptanceSystemPrompt: await read(acceptanceSystemPromptFile),
    termsTemplate: await read(termsUserPromptTemplateFile),
    acceptanceTemplate: await read(acceptanceUserPromptTemplateFile),
  };
}

/**
 * Run the glossary task.
 *
 * The cascade flag is the cumulative invariant: once any volume is regenerated, every LATER volume
 * is regenerated too, because its glossary was built on the artifact that just changed.
 */
async function glossary() {
  const { dryRun, force, chunked, volumeArg } = readRunArgs();

  if (!seriesDir) {
    throw new Error("SERIES_LOCATION is not set. Please set it in .env.");
  }
  // Fail fast (before any AI call) if required env vars are missing — the aggregated message names
  // every missing variable (SERIES_NAME is never required; the intake step decides it).
  validateRequiredEnv({ dryRun });

  const prompts = await loadPromptFiles();
  const { manifest, runSettings, folders, volumes, volumeByFolder } = await openSeriesRun({ seriesDir, dryRun, volumeArg });
  console.log(`Found ${folders.length} volume folder(s). Processing in order...`);

  const cascade = { regeneratedAny: false };
  const run = { folders, volumeByFolder, runSettings, prompts, dryRun, force, chunked, cascade };
  await runVolumeSeries("glossary", {
    volumes,
    folders,
    volumeByFolder,
    processVolume: (folderName, index) => processGlossaryVolume({ folderName, index }, run),
    // Copy the last volume's glossary to the series root for easy access (skipped for
    // single-volume runs, which would publish a stale snapshot).
    afterVolumes: () =>
      publishLatestToSeriesRoot({
        seriesDir,
        folders,
        fileName: OUTPUT_FILE,
        envKey: "GLOSSARY_OUTPUT_FILE",
        label: "glossary",
        volumeArg,
        dryRun,
      }),
  });
}


/**
 * One volume of the glossary run: resolve its source, its base, and its processing mode; then
 * preview it, skip it, or build it.
 *
 * @param {{ folderName: string, index: number }} target - The volume and its position in the reading order.
 * @param {{
 *   folders: string[],
 *   volumeByFolder: Map<string, Object>,
 *   runSettings: {seriesName: string, sourceLanguage: string, targetLanguage: string},
 *   prompts: Object,
 *   dryRun: boolean,
 *   force: boolean,
 *   chunked: boolean,
 *   cascade: { regeneratedAny: boolean },
 * }} run - What every volume of this run shares.
 * @returns {Promise<void>}
 */
async function processGlossaryVolume({ folderName, index }, run) {
  const { folders, volumeByFolder, runSettings, prompts, dryRun, force, chunked, cascade } = run;
  const volume = volumeByFolder.get(folderName);
  const volumeDir = path.join(seriesDir, folderName);
  const values = {
    INSTALLMENT_NUMBER: volume.installmentNumber,
    SOURCE_NAME: runSettings.seriesName,
    SOURCE_LANGUAGE: runSettings.sourceLanguage,
    TARGET_LANGUAGE: runSettings.targetLanguage,
  };

  // Resolve the source into a bundle: plain-text sources pass through as-is (the default
  // whole-installment path); .epub sources are normalized once (cached) into <base>-whole.md +
  // per-chapter files + images/ in the volume folder. The pipelines then work on plain text only.
  const bundle = await resolveSourceBundle({ seriesDir, volume, volumeDir, force });
  if (!(await fileExists(bundle.originalPath))) {
    throw new Error(`Required source file not found: ${bundle.originalPath}`);
  }

  const { ctx, proceed } = await buildVolumeContext({
    folderName, index, folders, volumeByFolder, runSettings, prompts, values, bundle, volumeDir, volume, dryRun, chunked,
  });
  if (!proceed) return;

  if (dryRun) {
    await dumpVolumePreview(ctx);
    return;
  }

  // Idempotency: skip a volume whose glossary already exists and met the score-based acceptance
  // criterion, unless a previous volume was regenerated (which would make it stale).
  if (await volumeAlreadyAccepted({
    installmentNumber: values.INSTALLMENT_NUMBER,
    outputFiles: [ctx.glossaryOutputFile],
    validationOutputFile: ctx.validationOutputFile,
    bundle,
    force,
    regeneratedAny: cascade.regeneratedAny,
    artifactLabel: "glossary",
  })) {
    // The coverage report is deterministic (no AI) — refresh it even on a skip so a source change
    // is visible without a full regeneration.
    await writeGlossaryCoverageReport(ctx);
    return;
  }

  // A volume is being (re)generated; later volumes depend on it.
  cascade.regeneratedAny = true;

  // Open this volume's reference record, carrying the previous volume's published record in first.
  // The integrity gate inside that copy is the hard stop — a volume whose character-voice reference
  // lost characters this volume's text contains is not carried forward, with no exception and no
  // downgrade. There is no switch in front of this block: the record is where this stage's findings
  // live, so a run that skipped it would be a run that published a glossary with nothing behind it.
  const previous = ctx.previousFolderName ? volumeByFolder.get(ctx.previousFolderName) : null;
  const attempt = openGlossaryRecord(ctx, previous ? previous.installmentNumber : null);
  if (!attempt.ok) throw new Error(`Volume ${values.INSTALLMENT_NUMBER}: ${attempt.error}`);
  ctx.refStore = attempt.opened.store;
  ctx.storeCarried = attempt.opened.carried;

  await runVolumeWithModeFallback({
    label: `Volume ${volume.installmentNumber}`,
    ctx,
    volumeDir,
    run: async () => {
      await runVolumeAgent(ctx);
      // Deterministic term-coverage audit of the finished glossary (no AI) — also the per-volume
      // "terms used here" index for the translation stage.
      await writeGlossaryCoverageReport(ctx);
    },
    attemptFiles: [
      OUTPUT_FILE,
      NEW_TERMS_FILE,
      RESEARCH_FILE,
      VALIDATION_FILE,
      "glossary-validation-rolling-state.json",
      "glossary-coverage.md",
      "glossary-coverage.json",
    ],
    attemptGlob: /^glossary-.*\.md$/,
  });

  // The glossary stage seals the volume at the end of its own work on it, and the character-voice
  // stage seals it again at the end of its work (see glossary/store.js's header for why the seal is
  // per stage and not per volume). Closing here only releases this stage's handle.
  //
  // The seal is the END of the volume's pre-production, so it is reached only by a volume the
  // acceptance gate accepted. A volume that ran out of QA iterations under ON_QA_LIMIT=accept is
  // left a draft on purpose: the next volume's copy-forward then refuses it with
  // `reference-volume-unsealed` (HIGH), which is the gate — publishing a record nobody signed off
  // would let every later volume build on it.
  sealGlossaryRecord(ctx);
  if (ctx.refStore) {
    ctx.refStore.close();
    ctx.refStore = null;
  }
}


/**
 * Assemble the volume context: the previous volume's glossary (the base this one amends), the
 * notes fed back from the previous volume's audits, and the processing mode.
 *
 * @returns {Promise<{ ctx: GlossaryVolumeCtx, proceed: boolean }>} `proceed` false when the
 *   run policy said to skip this volume (a missing base).
 */
async function buildVolumeContext({ folderName, index, folders, volumeByFolder, runSettings, prompts, values, bundle, volumeDir, volume, dryRun, chunked }) {
  const { isFirst, previousFolderName } = locatePreviousVolume({ folders, index, volumeByFolder });

  // The previous volume's glossary (the in-progress glossary). Absent for the first volume.
  const previous = await requirePreviousArtifacts({
    seriesDir,
    previousFolderName,
    fileNames: [OUTPUT_FILE],
    label: "glossary",
    installmentNumber: values.INSTALLMENT_NUMBER,
    dryRun,
  });
  const previousGlossaryFile = previous.files[0] || null;
  if (previous.skipVolume) return { ctx: null, proceed: false };

  const ctx = {
    values,
    folderName,
    volumeDir,
    sourceFile: bundle.wholePath,
    bundle,
    isFirst,
    previousFolderName,
    previousGlossaryFile,
    glossaryOutputFile: path.join(volumeDir, OUTPUT_FILE),
    validationOutputFile: path.join(volumeDir, VALIDATION_FILE),
    researchNotesFile: path.join(volumeDir, RESEARCH_FILE),
    termsSystemPrompt: prompts.termsSystemPrompt,
    acceptanceSystemPrompt: prompts.acceptanceSystemPrompt,
    // Set by the QA loop when it ends on an accepted grade. It starts false so a volume that threw
    // on the way there — or retried through the mode fallback — cannot inherit an earlier yes.
    qaAccepted: false,
    // The research bound, carried on the context because the chapter-by-chapter route spends it a chapter
    // at a time and the bound is per volume. A volume that re-enters this function gets a fresh number,
    // which is what a (re)generated volume is owed.
    researchTurnsLeft: RESEARCH_MAX_TERMS_PER_VOLUME,
    researchLog: null,
    // One entry per term-list read this volume paid for, in reading order, each carrying every paid
    // attempt. The whole-installment route writes one entry; the chapter-by-chapter route appends one per
    // chapter. `glossary/store.js` turns it into the block the grader reads, so "this volume's glossary is
    // missing a chapter's worth of terms" is a fact on disk rather than a line in a log nobody opens.
    extractionReads: [],
  };

  // Report → input: the previous volume's coverage audit (which glossary entries were never used)
  // is handed to this volume's extraction pass.
  ctx.disputesText = await collectFeedbackNotes(ctx, values);

  // Transform the prompts that use only the standard placeholders. The extraction prompt carries the
  // previous volume's unused-entry audit and the open disputes on the end of it: the read pass is the one
  // place a rendering is now chosen, so it is the one place that has to know a rendering is contested.
  ctx.termsPrompt =
    transformUserPrompt(prompts.termsTemplate, values) +
    (ctx.unusedEntriesNote || "") +
    (ctx.disputesText || "");
  ctx.acceptancePrompt = transformUserPrompt(prompts.acceptanceTemplate, values);

  // Whole-installment vs chapter-by-chapter, decided against THIS stage's model window and the
  // reference it will actually inject (the previous volume's cumulative glossary — decided per
  // volume because it grows every volume). See planProcessingMode in utils/source.js.
  const mode = await decideProcessingMode({
    bundle,
    label: `Volume ${volume.installmentNumber}`,
    previousArtifactFiles: previousGlossaryFile ? [previousGlossaryFile] : [],
    forceChunked: chunked,
    dryRun,
  });
  ctx.chunked = mode.chunked;

  return { ctx, proceed: true };
}


/**
 * Read the two channels that feed a volume's amendment task: the previous volume's unused-entry
 * audit, and the glossary disputes the translation stage raised.
 *
 * Without the second one the glossary only ever grows and a wrong entry is carried forward by every
 * later volume while the QA loop argues about it each time. Both are best-effort: a queue that
 * cannot be read degrades to "amend without it" rather than failing the volume.
 *
 * @param {GlossaryVolumeCtx} ctx - The volume context (mutated with `unusedEntriesNote` / `disputesText`).
 * @param {{INSTALLMENT_NUMBER: string}} values
 * @returns {Promise<string>} The disputes note.
 */
async function collectFeedbackNotes(ctx, values) {
  const { INSTALLMENT_NUMBER } = values;
  ctx.unusedEntriesNote = "";
  if (ctx.previousFolderName) {
    try {
      const coveragePath = path.join(seriesDir, ctx.previousFolderName, "glossary-coverage.json");
      if (await fileExists(coveragePath)) {
        ctx.unusedEntriesNote = buildUnusedEntriesNote(JSON.parse(await fs.readFile(coveragePath, "utf8")));
      }
    } catch (err) {
      console.warn(
        `Volume ${INSTALLMENT_NUMBER}: could not read the previous volume's coverage audit ` +
          `(${err.message}) — extraction proceeds without it.`
      );
    }
  }

  try {
    const disputes = await loadGlossaryDisputes(seriesDir);
    ctx.disputesText = buildDisputesNote(disputes, INSTALLMENT_NUMBER);
    if (ctx.disputesText) {
      console.log(
        `Volume ${INSTALLMENT_NUMBER}: ${disputes.length} open glossary dispute(s) ` +
          `are part of this volume's amendment task.`
      );
    }
  } catch (err) {
    console.warn(
      `Volume ${INSTALLMENT_NUMBER}: could not read the glossary disputes queue ` +
        `(${err.message}) — amending without them.`
    );
  }
  return ctx.disputesText;
}


/**
 * `--dry-run`: write the exact prompts a live run would send, and make no AI call.
 *
 * The preview must match the live run, and the live run has three one-shot kinds and no agent turn at
 * all: the read pass that decides what the glossary contains, the research reading call that says what a
 * looked-up term refers to, and the grade that judges the result. The lookup itself is an HTTP request
 * made by code, and the document is written by `renderGlossary`, which is code — so the preview says what
 * the render will be asked to print instead of pretending to be it.
 *
 * @param {GlossaryVolumeCtx} ctx
 * @returns {Promise<void>}
 */
async function dumpVolumePreview(ctx) {
  const { values } = ctx;
  // The term-dependent prompts carry an illustrative term (the real list only exists after the
  // extraction call, which dry-run skips, and the research list only exists after the filing).
  const illustrativeRow = {
    term: "（例の用語）",
    rendering: "Example Term",
    notes: "Real brand named outright in chapter 3",
    section: "Terms & Concepts",
  };
  const sections = [
    { title: "One-shot — terms extraction system prompt", prompt: ctx.termsSystemPrompt },
    { title: "One-shot — terms extraction user prompt", prompt: ctx.termsPrompt },
    { title: "One-shot — research reading system prompt (tool-less)", prompt: RESEARCH_SYSTEM_PROMPT },
    {
      title: `ONE-SHOT — research reading prompt (illustrative term; at most ${RESEARCH_MAX_TERMS_PER_VOLUME} per volume, and the lookup is made by code, not by the model)`,
      prompt: buildResearchReadingPrompt(
        { ...illustrativeRow, targetLanguage: values.TARGET_LANGUAGE },
        [{ lang: "ja", title: "（例の用語）", url: "https://ja.wikipedia.org/wiki/（例の用語）", extract: "（例の用語）は…" }]
      ),
    },
    {
      title: "CODE — the artifact this stage publishes (no prompt, no model call)",
      prompt:
        `glossary.md is rendered by utils/reference-store/glossary-adapter.js's renderGlossary() out of this ` +
        `volume's reference record: the document's own prose first, then every row the record holds, in the ` +
        `order their own volume filed them. The rows come from the extraction answer above, filed through ` +
        `glossary/store.js's fileGlossaryTermRows(). A row's Notes cell also carries the research notes filed ` +
        `against its term (utils/reference-store/research-notes.js), merged at render time — the row itself is ` +
        `never edited. Nothing an agent writes reaches this file.`,
    },
    { title: "One-shot — acceptance user prompt (always tool-less)", prompt: ctx.acceptancePrompt },
  ];
  // Chunked (fallback) volumes: dump the chapter-scoped variant of the read pass too.
  if (ctx.chunked && ctx.bundle.segments.length > 1) {
    const seg = ctx.bundle.segments[0];
    sections.push({
      title: "CHUNKED — per-chapter terms extraction user prompt (first chapter)",
      prompt: ctx.termsPrompt + "\n\n" + chapterSegmentNote(ctx.bundle, seg, 0),
    });
  }
  const dumpFile = await writePromptDump("glossary", values.INSTALLMENT_NUMBER, "agent", sections);
  console.log(
    `Volume ${values.INSTALLMENT_NUMBER}: --dry-run: no AI calls. ` +
      `The exact prompts (agent-mode turns + tool-less stages) are written to ${dumpFile}`
  );
}


/**
 * Process a single volume: extract the terms (one model call per chapter-group) -> file what was found
 * in the volume's record -> research what the record says is worth a lookup -> **render `glossary.md` out
 * of the record** -> run the cumulative gate -> grade it.
 *
 * There is no author agent here, no research agent, and no file an agent writes. The published glossary is
 * the record's own content, printed by `renderGlossary`, which is cumulative because the record this volume
 * opened was copied forward from the previous volume's sealed record. What the stage asks the model for is
 * the content of a row — the term, its canonical rendering and a note — what a looked-up term refers to,
 * and one grade for the result.
 *
 * Research sits between the filing and the render, and that order is the whole point of slice 5: the bound
 * is a query over rows the record already holds, and the answer is filed back onto the record before the
 * render prints it. Research before the filing would have to guess which terms the record would accept.
 *
 * @param {GlossaryVolumeCtx} ctx - The volume context (see glossary()).
 */
async function runVolumeAgent(ctx) {
  const { values } = ctx;

  if (ctx.chunked) {
    // Per chapter: extract → research → file → re-render → between-chapter gate. The last chapter's render
    // is the volume's published file, so the tail below is the same tail the whole-installment route runs.
    await runChunkedVolumeAgent(ctx);
  } else {
    await prepareVolumeFolder(ctx);
    const terms = await extractNewTerms(ctx);
    // Two filings, on purpose, from the same list. These are the extractor's claims — the record of what
    // this volume's read pass found — which is what makes "the glossary has no row for a term the
    // extractor found" a query with a number in it. They are NOT rendered.
    fileGlossaryExtraction(ctx, terms);
    // And these are the published rows: term, canonical rendering, note, section, each with its quote
    // checked against the book. This is the only thing in the stage that puts a rendering into the record,
    // and it is what `renderGlossary` prints.
    fileGlossaryTermRows(ctx, terms);

    // Research runs AFTER the filing, on purpose: the bound is a query over what the record now holds,
    // so a term the evidence rule refused never costs a lookup, a term an earlier volume already
    // published never costs one either, and the number of reading calls is the number of this volume's
    // researchable rows capped at RESEARCH_MAX_TERMS_PER_VOLUME. What the answer becomes is a row of the
    // record (`fileResearchNote`), which is how it reaches the rendered file below.
    await researchVolumeTerms(ctx);

    console.log(`Volume ${values.INSTALLMENT_NUMBER}: rendering the glossary out of the volume's record...`);
    const rendered = await renderGlossaryArtifact(ctx);
    if (!rendered.ok) {
      throw new Error(`Volume ${values.INSTALLMENT_NUMBER}: ${rendered.refusal.rule} — ${rendered.refusal.because} (fix: ${rendered.refusal.fix})`);
    }
  }

  // The cumulative invariant, unchanged: a plain-code gate over the file the render just wrote, against
  // the previous volume's published file. A render that lost a carried-forward row is the same failure
  // whatever produced the file.
  await assertGlossaryCarryForward(ctx, "the render");

  await runQaLoop(ctx);

  if (!ctx.qaAccepted) {
    const moved = await quarantineGlossaryArtifact(ctx);
    throw new Error(
      `Volume ${values.INSTALLMENT_NUMBER}: the acceptance gate did not accept the rendered glossary. ` +
        `${moved.length ? `${moved.join(", ")} — the file was moved aside so the next volume cannot build on it.` : ""} ` +
        "This stage has no rewrite pass: the glossary is rendered from the volume's record, so the only way to " +
        "change what it says is to read the volume again or contest a row. The record is left a draft, and the " +
        "next volume's copy-forward refuses it."
    );
  }
}


/**
 * Pass 1 — extract this volume's new terms (one tool-less call: an exhaustive one-pass JSON
 * extraction that needs no tools), persist them for the translation handoff, and return the list.
 *
 * The previous volume's glossary is INLINED (not offered as a readFile) so the cumulative glossary
 * is bounded here: the whole 17-volume glossary sitting in the extraction turn is how the extraction
 * starts inventing rows.
 *
 * The read is paid for at most twice (`readTermList`), and a read that never produced a list comes back
 * as `failed: true` rather than as an empty list. What that replaces is the `catch` below: this used to
 * parse what came back, and on a parse failure log "Continuing without research" and hand the volume an
 * empty list — the same value
 * a volume with genuinely nothing new produces. The whole-installment read is the ONLY reading pass
 * this route has, so a volume whose one read failed published a glossary of carried rows only, and
 * every later volume copied that forward.
 *
 * @param {GlossaryVolumeCtx} ctx
 * @returns {Promise<Array<{term: string, type: string, query: string}>>} The extracted terms. Empty when the volume has nothing new — and also empty when the read never answered, which `ctx.extractionReads` is what tells apart.
 */
async function extractNewTerms(ctx) {
  const { values, sourceFile, previousGlossaryFile, termsPrompt, termsSystemPrompt } = ctx;
  console.log(`Volume ${values.INSTALLMENT_NUMBER}: extracting new terms...`);
  const baseMessages = [{ file: sourceFile, name: path.basename(sourceFile) }];
  if (!ctx.isFirst) {
    const volumeSourceText = await fs.readFile(sourceFile, "utf8");
    baseMessages.push(
      await inlineReferenceMessage(previousGlossaryFile, "glossary-previous.md", {
        truncate: (raw) => truncateGlossary(raw, volumeSourceText),
      })
    );
  }
  const read = await readTermList({
    label: `Volume ${values.INSTALLMENT_NUMBER}: the term list`,
    ask: ({ attempt, thinkingLevel }) =>
      harness.runOneShot({
        systemPrompt: termsSystemPrompt,
        messages: [...baseMessages, { text: termsPrompt }],
        label: `glossary-terms-${values.INSTALLMENT_NUMBER}${attempt > 1 ? "-retry" : ""}`,
        responseFormat: termsResponseFormat(),
        ...(thinkingLevel ? { thinkingLevel } : {}),
      }),
  });
  const terms = read.terms;
  ctx.extractionReads = [
    {
      id: `volume ${values.INSTALLMENT_NUMBER}`,
      title: "whole installment (one read for the whole book)",
      terms: terms.length,
      attempts: read.attempts,
      failed: read.failed,
    },
  ];
  console.log(
    `Volume ${values.INSTALLMENT_NUMBER}: extracted ${terms.length} new term(s)` +
      `${read.failed ? " — NOTHING: the read never produced a list, and this route has no other reading pass" : ""}.`
  );
  // Persist the volume's new-term extraction so the translation handoff (utils/handoff.js) can
  // render a "what's new in this volume" section without re-calling the AI.
  try {
    await fs.writeFile(
      path.join(ctx.volumeDir, NEW_TERMS_FILE),
      JSON.stringify(terms, null, 2) + "\n",
      "utf8"
    );
  } catch (err) {
    console.warn(
      `Volume ${values.INSTALLMENT_NUMBER}: could not persist ${NEW_TERMS_FILE} (${err.message}) — continuing.`
    );
  }
  return terms;
}


/**
 * Clear the strays an earlier run left behind in this volume's folder.
 *
 * This used to be `openAgentTools`, and it also created the gated file tools and the wiki tools. Nothing
 * in this stage opens an agent any more — the read pass and the research reading call are both tool-less
 * one-shots, and the research lookup is made by code through `research.js` — so the sandbox has nothing
 * to sandbox and creating it would be advertising a tool the stage never uses (AGENTS.md rule 2).
 *
 * @param {{ values: Object, volumeDir: string }} ctx - The volume being built.
 * @returns {Promise<void>}
 */
async function prepareVolumeFolder(ctx) {
  const { values, volumeDir } = ctx;

  // Remove stale strays from earlier runs (agent name drift): a per-volume classic-style name like
  // "glossary-01.md" is never written by the workflow itself, so anything like that is leftover garbage.
  const strayGlossary = path.join(volumeDir, `glossary-${values.INSTALLMENT_NUMBER}.md`);
  if (await fileExists(strayGlossary)) {
    await fs.rm(strayGlossary);
    console.log(
      `Removed the stale file "glossary-${values.INSTALLMENT_NUMBER}.md" (leftover from a previous run).`
    );
  }
}


module.exports = {
  glossary,
  runVolumeAgent,
  prepareVolumeFolder,
};
