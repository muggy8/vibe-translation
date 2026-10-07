/**
 * The task entry point and the per-volume whole-installment pass: resolve the plan
 * of record, walk the volumes in reading order, and keep the cumulative cascade —
 * regenerating any volume regenerates every later one, because their glossaries
 * would otherwise build on a stale base.
 *
 * Part of the glossary.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("../types"); // JSDoc type definitions
const harness = require("../harness");
const { transformUserPrompt, parseAcceptanceScore, parseAcceptanceReply, validatorMaxStepsFor, authorMaxStepsFor, findingsMergeMaxStepsFor, writePromptDump } = require("../utils/prompt");
const { getTranslationTarget } = require("../get-translation-target");
const { filterVolumesByInstallment } = require("../utils/manifest");
const { AGENT_TOOLS_NOTE, STAGE_CONCURRENCY: RESEARCH_CONCURRENCY, ACCEPTANCE_WINDOW_SIZE, ACCEPTANCE_PASSING_SCORE, computeRollingAverage, meetsAcceptanceCriteria, isAcceptedState, isSourceStale, saveRollingState, ON_VOLUME_ERROR, ON_MISSING_PREVIOUS, ON_QA_LIMIT, validateRequiredEnv, resolveRunSettings, seriesArtifactFile, judgeTemperature, judgeThinking, isStructuralError, volumeFailureError, readBoolEnv } = require("../configs/shared");
const { fileExists, assertWrote, assertWroteWithFallback, assertRealOutput, writeProvenanceSidecar, inlineReferenceMessage, isPublishableArtifact, fingerprintFiles } = require("../utils/fs");
const { loadGlossaryDisputes } = require("../utils/disputes");
const { runSharedQaLoop, confirmExceptionalScore, confirmPassingScore, runVolumeWithModeFallback } = require("../utils/qa-loop");
const {
  resolveSourceBundle,
  decideProcessingMode,
  sourceMaterialLine,
  sourceSegmentListLine,
  chapterSegmentNote,
  chapterContextBlock,
} = require("../utils/source");

const { acceptanceSystemPromptFile, acceptanceUserPromptTemplateFile, feedbackSystemPromptFile, feedbackUserPromptTemplateFile, glossarySystemPromptFile, glossaryUserPromptTemplateFile, researchEnabled, seriesDir, termsSystemPromptFile, termsUserPromptTemplateFile, validatorSystemPromptFile, validatorUserPromptTemplateFile } = require("./config");
const { buildDisputesNote, buildUnusedEntriesNote } = require("./notes");
const { RESEARCHER_SYSTEM_PROMPT, buildPerTermResearchPrompt, pendingPlaceholder, researchBatch } = require("./research");
const { buildGlossaryAuthorTurnPrompt, buildGlossaryFeedbackTurnPrompt, buildGlossaryFindingsMergePrompt, buildGlossarySegmentFeedbackPrompt, buildGlossarySegmentValidatorPrompt, buildGlossaryValidatorTurnPrompt } = require("./prompts");
const { assertGlossaryCarryForward, buildGlossaryIndex, seedGlossaryFromPrevious } = require("./carry-forward");
const { writeGlossaryCoverageReport } = require("./coverage");
const { parseTerms, truncateGlossary } = require("./extract");
const { runChunkedVolumeAgent } = require("./chunked");
const { generateGlossary } = require("./amend");
const { runQaLoop } = require("./qa");

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
      // The preview must show the prompt the LIVE run would use. A live run
      // copies the previous volume's glossary into this volume's folder before
      // the author turn (seedGlossaryFromPrevious), so from volume 02 on the
      // author is told to edit that file in place — not to recreate it.
      ctx.glossarySeeded = !isFirst;
      // …and it shows the term map that copy produces, because a preview that
      // promises "amend it in place" while hiding the map the agent uses to find
      // the row is a preview of a different prompt.
      ctx.glossaryIndex = previousGlossaryFile
        ? buildGlossaryIndex(await fs.readFile(previousGlossaryFile, "utf8").catch(() => ""))
        : "";
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
      const { loadRollingState } = require("../configs/shared");
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
      // "Last EXISTING" means last REAL, PUBLISHABLE one: an empty or
      // scaffold-stub snapshot left by a failed volume is not the series' current
      // glossary, and neither is a file that is not a document at all (gotcha 58).
      if (await isPublishableArtifact(candidate, "glossary")) {
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
  //
  // The previous volume's glossary is copied in first (deterministic, no model
  // call), so the agent amends a real file instead of reproducing a document
  // too large for one reply to write. See seedGlossaryFromPrevious.
  await seedGlossaryFromPrevious(ctx);

  console.log(
    `Volume ${values.INSTALLMENT_NUMBER}: amending the glossary (author agent)...`
  );

  await generateGlossary(ctx, terms, researchNotesAvailable);
  await assertGlossaryCarryForward(ctx, "the amend pass");

  // QA loop: fresh validator per iteration + fresh author for feedback.
  await runQaLoop(ctx);
}


module.exports = {
  glossary,
  runVolumeAgent,
};
