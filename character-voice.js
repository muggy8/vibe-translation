/**
 * character-voice.js — Logic for the "character-voice" gulp task: building the
 * canonical character voice reference and POV map for a Japanese light novel
 * series, driven from the source text, one volume at a time.
 *
 * Task: character-voice
 *   For each volume (in natural order):
 *     1. Read the volume's source text and the previous character voice reference.
 *     2. Extract new voice quirks and POV analysis using a one-shot call.
 *     3. Compile the cumulative character voice reference and per-volume POV map.
 *     4. Save per-volume snapshots.
 *     5. Run the QA loop with score-based acceptance (the model scores each
 *        validation 0–100; the rolling average of recent scores must reach
 *        PASSING_SCORE, default 70 — see configs/shared.js).
 *   After all volumes: the last volume's character-voice.md is copied to
 *   VOICE_OUTPUT_FILE (default <SERIES_LOCATION>/character-voice.md).
 *
 * Idempotent: a volume whose outputs already exist and pass acceptance is
 * skipped (unless --force). If any volume is regenerated, all later volumes
 * are regenerated too (each volume's reference builds on the previous one's).
 *
 * Usage:
 *   npx gulp character-voice             # run the full task
 *   npx gulp character-voice --dry-run   # transform the prompts only, no API call
 *   npx gulp character-voice --force     # regenerate even if already processed
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("./types");
const harness = require("./harness");
const { transformUserPrompt, parseAcceptanceScore, parseAcceptanceReply, validatorMaxStepsFor, writePromptDump } = require("./utils/prompt");
const { getTranslationTarget } = require("./get-translation-target");
const { filterVolumesByInstallment } = require("./utils/manifest");
const { AGENT_TOOLS_NOTE, ACCEPTANCE_WINDOW_SIZE, ACCEPTANCE_PASSING_SCORE, computeRollingAverage, meetsAcceptanceCriteria, isAcceptedState, isSourceStale, saveRollingState, ON_VOLUME_ERROR, ON_MISSING_PREVIOUS, ON_QA_LIMIT, validateRequiredEnv, resolveRunSettings, seriesArtifactFile } = require("./configs/shared");
const { fileExists, assertWrote, assertWroteWithFallback, writeProvenanceSidecar } = require("./utils/fs");
const { runSharedQaLoop } = require("./utils/qa-loop");
const {
  resolveSourceBundle,
  shouldProcessChunked,
  sourceMaterialLine,
  chapterSegmentNote,
  chapterContextBlock,
} = require("./utils/source");

const clientDir = __dirname;
const seriesDir = process.env.SERIES_LOCATION;

const extractSystemPromptFile = path.join(clientDir, "system-prompts", "character-voice-extract.md");
const extractUserPromptTemplateFile = path.join(clientDir, "user-prompts", "character-voice-extract.md");
const authorSystemPromptFile = path.join(clientDir, "system-prompts", "character-voice.md");
const authorUserPromptTemplateFile = path.join(clientDir, "user-prompts", "character-voice.md");
const validatorSystemPromptFile = path.join(clientDir, "system-prompts", "character-voice-validator.md");
const validatorUserPromptTemplateFile = path.join(clientDir, "user-prompts", "character-voice-validator.md");
const acceptanceSystemPromptFile = path.join(clientDir, "system-prompts", "character-voice-acceptance.md");
const acceptanceUserPromptTemplateFile = path.join(clientDir, "user-prompts", "character-voice-acceptance.md");
const feedbackSystemPromptFile = path.join(clientDir, "system-prompts", "character-voice-feedback.md");
const feedbackUserPromptTemplateFile = path.join(clientDir, "user-prompts", "character-voice-feedback.md");

const maxValidationIterations = Math.max(1, parseInt(process.env.QA_MAX_ITERATIONS, 10) || 10);
const VOICE_REF_TRUNCATION_THRESHOLD = 64 * 1024;
const VOICE_REF_TRUNCATION_MAX_ENTRIES = 200;

/**
 * Parse the AI's extraction output into an array of voice quirk / POV entries.
 * @param {string} output - The raw AI output.
 * @returns {Array<Object>}
 */
function parseVoiceQuirks(output) {
  if (!output || typeof output !== "string") return [];
  let text = output.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) text = fenceMatch[1].trim();
  const firstBracket = text.indexOf("[");
  const lastBracket = text.lastIndexOf("]");
  if (firstBracket === -1 || lastBracket === -1 || lastBracket < firstBracket) {
    throw new Error("No JSON array found in the character-voice extraction output.");
  }
  const parsed = JSON.parse(text.slice(firstBracket, lastBracket + 1));
  if (!Array.isArray(parsed)) {
    throw new Error("The character-voice extraction output was not a JSON array.");
  }
  return parsed.filter((entry) => entry && typeof entry.type === "string");
}

/**
 * Truncate a character voice reference if it exceeds the threshold.
 * @param {string} content - The full character voice reference content.
 * @returns {string}
 */
function truncateVoiceRef(content) {
  if (!content || content.length <= VOICE_REF_TRUNCATION_THRESHOLD) return content;
  const allSections = content.match(/^### .+[\s\S]*?(?=^### |$)/gm);
  if (!allSections || allSections.length <= VOICE_REF_TRUNCATION_MAX_ENTRIES) return content;
  const header = content.split(/^### /m)[0];
  const keep = allSections.slice(-VOICE_REF_TRUNCATION_MAX_ENTRIES);
  return [header, `[TRUNCATED: previous reference has ${allSections.length} sections. Showing last ${keep.length}.]`, keep.join("\n\n")].join("\n\n");
}

/**
 * Build the extraction turn prompt for a single volume.
 * @param {CharacterVoiceVolumeCtx} ctx
 * @returns {string}
 */
function buildExtractTurnPrompt(ctx) {
  return transformUserPrompt(ctx.extractUserPrompt, ctx.values);
}

/**
 * Build the author (compile) turn prompt for a single volume.
 *
 * The preamble names every material at its real path: the previous volume's
 * reference lives in the previous volume's folder
 * (`../<previous folder>/character-voice.md`), not in the working folder —
 * the same convention as glossary.js, so the agent never has to guess where
 * to read. With `seg` set (chunked fallback) the pass is scoped to one
 * chapter.
 *
 * @param {CharacterVoiceVolumeCtx} ctx
 * @param {string} extractionResults
 * @param {SourceSegment|null} [seg] - The chapter being processed (fallback).
 * @param {number} [si] - Zero-based position in reading order.
 * @returns {string}
 */
function buildAuthorTurnPrompt(ctx, extractionResults, seg = null, si = null) {
  const { isFirst, previousFolderName } = ctx;
  const amendPrompt = transformUserPrompt(ctx.authorUserPrompt, {
    ...ctx.values,
    EXTRACTION_RESULTS: extractionResults || "(none — this is the first volume)",
  });
  let sourceLine;
  let previousRefLine;
  let chapterBlock = "";
  if (seg) {
    sourceLine = `- The chapter source: "${seg.file}" (same folder)`;
    previousRefLine =
      si === 0
        ? isFirst
          ? "- The previous character voice reference: (absent — this is the first volume)"
          : `- The previous character voice reference: "../${previousFolderName}/character-voice.md"`
        : `- The current character voice reference (state after the earlier chapters of this volume): "character-voice.md" (same folder)`;
    chapterBlock = chapterContextBlock(ctx.values, ctx.bundle, seg, si);
  } else {
    sourceLine = ctx.bundle
      ? sourceMaterialLine(ctx.bundle)
      : `- The volume source: "${path.basename(ctx.sourceFile)}" (same folder)`;
    previousRefLine = isFirst
      ? "- The previous character voice reference: (absent — this is the first volume)"
      : `- The previous character voice reference: "../${previousFolderName}/character-voice.md"`;
  }
  return (
    `Working folder: the volume folder (you are in it).\n\n` +
    chapterBlock +
    `Materials (read with readFile before writing anything):\n` +
    `${sourceLine}\n` +
    previousRefLine +
    `\n\n` +
    `Write the complete character voice reference to the file "character-voice.md" in your working folder (writeFile, complete contents).\n` +
    `Write the per-volume POV map to the file "pov-map.md" in your working folder (writeFile, complete contents).\n\n` +
    amendPrompt
  );
}

/**
 * Build the validator turn prompt for a single volume. With `seg` set
 * (chunked fallback) the pass audits ONE chapter and writes a partial report.
 *
 * @param {CharacterVoiceVolumeCtx} ctx
 * @param {SourceSegment|null} [seg] - The chapter being audited (fallback).
 * @param {number} [si] - Zero-based position in reading order.
 * @returns {string}
 */
function buildValidatorTurnPrompt(ctx, seg = null, si = null) {
  const { isFirst, previousFolderName } = ctx;
  const previousRefLine = isFirst
    ? ""
    : `- The previous character voice reference: "../${previousFolderName}/character-voice.md"\n`;
  const reportFile = seg ? `character-voice-validation-${seg.id}.md` : "character-voice-validation.md";
  let sourceLine;
  let chapterBlock = "";
  if (seg) {
    sourceLine = `- The chapter source: "${seg.file}" (same folder)`;
    chapterBlock =
      chapterContextBlock(ctx.values, ctx.bundle, seg, si) +
      `This is a per-chapter validation pass: audit the reference and POV map against ONE chapter only. ` +
      `Tag every finding with the chapter id "${seg.id}" (e.g. a prefix "[${seg.id}] ").\n`;
  } else {
    sourceLine = ctx.bundle
      ? sourceMaterialLine(ctx.bundle)
      : `- The volume source: "${path.basename(ctx.sourceFile)}" (same folder)`;
  }
  return (
    `Working folder: the volume folder (you are in it).\n\n` +
    chapterBlock +
    `Materials (read with readFile before writing anything):\n` +
    `${sourceLine}\n` +
    `- The amended character voice reference under audit: "character-voice.md" (same folder)\n` +
    `- The POV map under audit: "pov-map.md" (same folder)\n` +
    previousRefLine +
    `\n` +
    `Write the complete validation report to the file "${reportFile}" in your working folder (writeFile, exact format from the system prompt).\n\n` +
    transformUserPrompt(ctx.validatorUserPrompt, ctx.values)
  );
}

/**
 * Build the feedback turn prompt for a single volume. With `seg` set
 * (chunked fallback) the pass applies the chapter-tagged findings only.
 *
 * @param {CharacterVoiceVolumeCtx} ctx
 * @param {SourceSegment|null} [seg] - The chapter whose findings are applied (fallback).
 * @param {number} [si] - Zero-based position in reading order.
 * @returns {string}
 */
function buildFeedbackTurnPrompt(ctx, seg = null, si = null) {
  const { isFirst, previousFolderName } = ctx;
  const previousRefLine = isFirst
    ? ""
    : `- The previous character voice reference: "../${previousFolderName}/character-voice.md"\n`;
  let sourceLine;
  let chapterBlock = "";
  let scopeLine = "";
  if (seg) {
    sourceLine = `- The chapter source: "${seg.file}" (same folder)`;
    chapterBlock = chapterContextBlock(ctx.values, ctx.bundle, seg, si);
    scopeLine = ` — apply ONLY the findings tagged with chapter "${seg.id}"`;
  } else {
    sourceLine = ctx.bundle
      ? sourceMaterialLine(ctx.bundle)
      : `- The volume source: "${path.basename(ctx.sourceFile)}" (same folder)`;
  }
  return (
    `Working folder: the volume folder (you are in it).\n\n` +
    chapterBlock +
    `The validation report "character-voice-validation.md" in your working folder is your work order${scopeLine}.\n` +
    `Materials (read with readFile before changing anything):\n` +
    `${sourceLine}\n` +
    `- The current character voice reference to correct: "character-voice.md" (same folder)\n` +
    `- The current POV map to correct: "pov-map.md" (same folder)\n` +
    previousRefLine +
    `\n` +
    `Apply the report's findings and write the complete corrected files back to "character-voice.md" and "pov-map.md" using writeFile (complete contents).\n\n` +
    transformUserPrompt(ctx.feedbackUserPrompt, ctx.values)
  );
}

/**
 * The findings-merge turn prompt (chunked fallback): consolidates the
 * per-chapter partial reports into the standard character-voice-validation.md
 * so the unchanged acceptance one-shot can score it.
 *
 * @param {CharacterVoiceVolumeCtx} ctx
 * @returns {string}
 */
function buildVoiceFindingsMergePrompt(ctx) {
  const list = ctx.bundle.segments
    .map((s) => `- "character-voice-validation-${s.id}.md" (chapter ${s.id})`)
    .join("\n");
  return (
    `Working folder: the volume folder (you are in it).\n\n` +
    `You are consolidating the per-chapter validation partials of volume ` +
    `${ctx.values.INSTALLMENT_NUMBER} into the single standard validation report.\n` +
    `Materials (read with readFile before writing anything):\n` +
    list +
    `\n\n` +
    `Write the consolidated report to the file "character-voice-validation.md" in your ` +
    `working folder (writeFile, complete contents) using EXACTLY the report format ` +
    `from your system prompt. Preserve the chapter tags on the findings, keep every ` +
    `valid finding (deduplicate repeats), and produce the summary/verdict sections ` +
    `the format requires, as if you had audited the whole volume in one pass.`
  );
}

function buildExtractSystemPrompt(base) { return base + AGENT_TOOLS_NOTE; }
function buildAuthorSystemPrompt(base) { return base + AGENT_TOOLS_NOTE; }
function buildValidatorSystemPrompt(base) { return base + AGENT_TOOLS_NOTE; }

/**
 * The gulp task entry point for the character-voice workflow.
 */
async function characterVoice() {
  const dryRun = process.argv.includes("--dry-run");
  const force = process.argv.includes("--force");
  // Force the chapter-by-chapter fallback for every multi-chapter epub volume
  // (the default is whole-installment processing; the fallback also triggers
  // automatically when the whole text exceeds SOURCE_CHUNK_THRESHOLD_CHARS).
  const chunkedArg = process.argv.includes("--chunked");
  const volumeArg =
    (process.argv.find((a) => a.startsWith("--volume=")) || "").replace("--volume=", "") ||
    (process.argv.includes("--volume")
      ? process.argv[process.argv.indexOf("--volume") + 1]
      : null);
  console.log("character-voice task starting...");
  validateRequiredEnv({ dryRun });
  const manifest = await getTranslationTarget({ force, dryRun });
  // Series name + languages: .env override > the intake manifest's decision >
  // the default (see resolveRunSettings in configs/shared.js).
  const runSettings = resolveRunSettings(manifest);
  // Use the module-level seriesDir (SERIES_LOCATION) — NOT manifest.seriesLocation.
  // That field is provenance metadata from the machine that generated the
  // manifest: after a Windows→Linux migration the cached "C:\..." path is not
  // absolute, and every file op would silently resolve relative to the CWD
  // (observed live: ENOENT on <CWD>/C:\...\test_story(1)/...). glossary.js and
  // jump-in-wiki.js already use the env value; getTranslationTarget() above
  // fails loudly if SERIES_LOCATION is unset or missing.
  // The manifest's order IS the reading order the intake agent decided — it is
  // used as-is, never re-sorted by parsing folder names.
  const sorted = manifest.volumes.map((v) => v.folder);
  const volumeByFolder = new Map(manifest.volumes.map((v) => [v.folder, v]));
  // "--volume 01" is resolved through the manifest's installment numbers (an
  // exact folder name also works). A no-match fails loudly (a silent exit would
  // masquerade as a successful no-op in an un-monitored run).
  const volumes = volumeArg ? filterVolumesByInstallment(manifest, volumeArg) : sorted;
  if (volumes.length === 0) {
    throw new Error(
      `No volume matching --volume ${volumeArg} (manifest volumes: ` +
        `${manifest.volumes.map((v) => `${v.installmentNumber} = ${v.folder}`).join(", ")}).`
    );
  }
  let regeneratedAny = false;
  const failedVolumes = [];
  for (const folderName of volumes) {
    try {
    // Index into the FULL sorted list (not the filtered one) so --volume runs
    // still resolve the correct manifest entry and previous volume.
    const i = sorted.indexOf(folderName);
    const volume = volumeByFolder.get(folderName);
    const values = { INSTALLMENT_NUMBER: volume.installmentNumber, SOURCE_NAME: runSettings.seriesName, SOURCE_LANGUAGE: runSettings.sourceLanguage, TARGET_LANGUAGE: runSettings.targetLanguage };
    const volumeDir = path.join(seriesDir, folderName);
    // Resolve the source into a bundle (utils/source.js): plain-text sources
    // pass through as-is (the default whole-installment path); .epub sources
    // are normalized once (cached) into per-chapter + whole Markdown files.
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
    const voiceOutputFile = path.join(volumeDir, "character-voice.md");
    const povOutputFile = path.join(volumeDir, "pov-map.md");
    const validationOutputFile = path.join(volumeDir, "character-voice-validation.md");
    // The previous volume's reference (the in-progress reference). Absent for
    // the first volume. The agent-mode turn prompts name it at its real
    // relative path (../<previous folder>/character-voice.md) — the same
    // convention as glossary.js.
    const isFirst = i === 0;
    let previousVoiceRefFile = null;
    let previousFolderName = null;
    if (!isFirst) {
      previousFolderName = sorted[i - 1];
      previousVoiceRefFile = path.join(seriesDir, previousFolderName, "character-voice.md");
      if (!(await fileExists(previousVoiceRefFile))) {
        if (dryRun) {
          console.warn(
            `Volume ${values.INSTALLMENT_NUMBER}: --dry-run: the previous character voice reference ` +
              `(${previousVoiceRefFile}) does not exist yet — a live run would stop ` +
              `here. Continuing the prompt preview.`
          );
        } else if (ON_MISSING_PREVIOUS === "skip") {
          console.log(
            `Volume ${values.INSTALLMENT_NUMBER}: previous character voice reference not found ` +
              `(${previousVoiceRefFile}) — skipping this volume ` +
              `(ON_MISSING_PREVIOUS=skip).`
          );
          continue;
        } else {
          throw new Error(
            `Previous character voice reference not found: ${previousVoiceRefFile}. ` +
              `Process the earlier volume first (or re-run without --force), ` +
              `or set ON_MISSING_PREVIOUS=skip to skip this volume.`
          );
        }
      }
    }
    const extractSystemPrompt = await fs.readFile(extractSystemPromptFile, "utf8");
    const extractTemplate = await fs.readFile(extractUserPromptTemplateFile, "utf8");
    const authorSystemPrompt = await fs.readFile(authorSystemPromptFile, "utf8");
    const authorTemplate = await fs.readFile(authorUserPromptTemplateFile, "utf8");
    const validatorSystemPrompt = await fs.readFile(validatorSystemPromptFile, "utf8");
    const validatorTemplate = await fs.readFile(validatorUserPromptTemplateFile, "utf8");
    const acceptanceSystemPrompt = await fs.readFile(acceptanceSystemPromptFile, "utf8");
    const acceptanceTemplate = await fs.readFile(acceptanceUserPromptTemplateFile, "utf8");
    const feedbackSystemPrompt = await fs.readFile(feedbackSystemPromptFile, "utf8");
    const feedbackTemplate = await fs.readFile(feedbackUserPromptTemplateFile, "utf8");
    const extractPrompt = transformUserPrompt(extractTemplate, values);
    const validatorPrompt = transformUserPrompt(validatorTemplate, values);
    const feedbackPrompt = transformUserPrompt(feedbackTemplate, values);
    const acceptancePrompt = transformUserPrompt(acceptanceTemplate, values);
    const ctx = { values, folderName, volumeDir, sourceFile, bundle, chunked: processChunked, voiceOutputFile, povOutputFile, validationOutputFile, isFirst, previousFolderName, previousVoiceRefFile, extractPrompt, validatorPrompt, feedbackPrompt, acceptancePrompt, extractTemplate, authorTemplate, extractSystemPrompt, authorSystemPrompt, validatorSystemPrompt, acceptanceSystemPrompt, feedbackSystemPrompt, authorUserPrompt: authorTemplate, validatorUserPrompt: validatorTemplate, feedbackUserPrompt: feedbackTemplate };
    if (dryRun) {
      const illustrative = JSON.stringify([{ type: "voice", character: "ex", quirkType: "sentenceEnding", description: "ex", examples: ["ex"], formalityLevel: "plain", notes: "ex" }]);
      const sections = [
        { title: "One-shot — extraction system prompt", prompt: extractSystemPrompt },
        { title: "One-shot — extraction user prompt", prompt: extractPrompt },
        { title: "AGENT — author system prompt", prompt: buildAuthorSystemPrompt(authorSystemPrompt) },
        { title: "AGENT — author turn (illustrative)", prompt: buildAuthorTurnPrompt(ctx, illustrative) },
        { title: "AGENT — validator system prompt", prompt: buildValidatorSystemPrompt(validatorSystemPrompt) },
        { title: "AGENT — validator turn", prompt: buildValidatorTurnPrompt(ctx) },
        { title: "AGENT — feedback turn", prompt: buildFeedbackTurnPrompt(ctx) },
        { title: "One-shot — acceptance user prompt", prompt: acceptancePrompt },
      ];
      // Chunked (fallback) volumes: dump the chapter-scoped variants too.
      if (ctx.chunked && bundle.segments.length > 1) {
        const seg = bundle.segments[0];
        sections.push(
          { title: "CHUNKED — per-chapter extraction user prompt (first chapter)", prompt: extractPrompt + "\n\n" + chapterSegmentNote(bundle, seg, 0) },
          { title: "CHUNKED — segment author turn (illustrative)", prompt: buildAuthorTurnPrompt(ctx, illustrative, seg, 0) },
          { title: "CHUNKED — segment validator turn (first chapter)", prompt: buildValidatorTurnPrompt(ctx, seg, 0) },
          { title: "CHUNKED — findings merge turn", prompt: buildVoiceFindingsMergePrompt(ctx) },
          { title: "CHUNKED — segment feedback turn (first chapter)", prompt: buildFeedbackTurnPrompt(ctx, seg, 0) }
        );
      }
      const dumpFile = await writePromptDump("character-voice", values.INSTALLMENT_NUMBER, "agent", sections);
      console.log(`Volume ${values.INSTALLMENT_NUMBER}: --dry-run: prompts dumped to ${dumpFile}`);
      continue;
    }
    let skip = false;
    if (!force && !regeneratedAny && (await fileExists(voiceOutputFile)) && (await fileExists(povOutputFile))) {
      const stateFilePath = validationOutputFile.replace(".md", "-rolling-state.json");
      const { loadRollingState } = require("./configs/shared");
      const state = await loadRollingState(stateFilePath);
      if (state) {
        const avg = computeRollingAverage(state.results);
        skip = isAcceptedState(state);
        if (skip && isSourceStale(state, bundle)) {
          skip = false;
          console.log(`Volume ${values.INSTALLMENT_NUMBER}: the source file changed since the last run (fingerprint mismatch) — regenerating instead of skipping.`);
        }
        if (skip) { console.log(`Volume ${values.INSTALLMENT_NUMBER}: rolling-state (${state.results.length} checks, avg ${avg.toFixed(1)}/100) meets the criterion. Skipping.`); }
      }
    }
    if (skip) { console.log(`Volume ${values.INSTALLMENT_NUMBER}: voice reference and POV map already exist and passed. Skipping.`); continue; }
    regeneratedAny = true;
    await runVolume(ctx);
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
  if (volumeArg || dryRun) {
    console.log(volumeArg ? "\n--volume: skipping the series-root copy." : "\n--dry-run: skipping the series-root copy (dry runs make no file writes).");
  }
  else {
    const finalVoiceFile = seriesArtifactFile("character-voice.md", "VOICE_OUTPUT_FILE", seriesDir);
    let lastVoice = null;
    for (let i = sorted.length - 1; i >= 0; i--) {
      const candidate = path.join(seriesDir, sorted[i], "character-voice.md");
      if (await fileExists(candidate)) { lastVoice = candidate; break; }
    }
    if (lastVoice) { await fs.copyFile(lastVoice, finalVoiceFile); await writeProvenanceSidecar(finalVoiceFile, lastVoice); console.log(`\nCopied the final character voice reference to: ${finalVoiceFile}`); }
    else { console.log("\nNo character voice snapshots found; nothing to copy."); }
  }
}

/**
 * Detect the "model emitted tool-call syntax as plain text" failure mode.
 *
 * Observed live (Qwen via an OpenAI-compatible endpoint): the model sometimes
 * emits its tool calls as Qwen-native text — a `tool_call` wrapper around the
 * tool name, e.g. `tool_call <function=readFile>…` or `tool_call <listFiles>…` —
 * in the content field instead of using the API-level tool_calls protocol. The
 * harness only executes real tool calls, so such a turn performs no work at all,
 * yet it looks like an ordinary (short) chat reply, so the stale-file write
 * check and the acceptance loop would silently mask it and burn every
 * validation iteration.
 *
 * @param {Object|null} result - The result object returned by an agent sendTurn.
 * @returns {boolean} True when the turn made no real tool calls and its text
 *   contains tool-call markers (the malformed-tool-call signature).
 */
function emittedToolCallAsText(result) {
  if (!result) return false;
  if (Array.isArray(result.toolCalls) && result.toolCalls.length > 0) return false;
  const text = typeof result.text === "string" ? result.text : "";
  return text.includes("tool_call") || text.includes("<function=");
}

/**
 * Fail loudly when an agent turn made no real tool calls because the model
 * emitted tool-call syntax as plain text (see emittedToolCallAsText). Throws a
 * diagnostic error instead of letting the stale-file write check mask the
 * no-op turn.
 *
 * @param {Object|null} result - The result object returned by an agent sendTurn.
 * @param {string} who - Who the agent was (for the error message).
 * @param {string} volumeLabel - The volume label (for the error message).
 * @returns {void}
 */
function assertRealToolCalls(result, who, volumeLabel) {
  if (!emittedToolCallAsText(result)) return;
  throw new Error(
    `Volume ${volumeLabel}: ${who} emitted tool-call syntax as plain text ` +
      `("tool_call" / <function=…>) instead of using the tool-calling API, so no ` +
      `file tools ran — nothing was read or written. See the agent transcript in ` +
      `.logs/ for the exact turn. This is an intermittent model/endpoint issue ` +
      `with OpenAI tool_calls (the smoke test 'npm run smoke fs' can pass even ` +
      `when it happens). Re-run the task; if it persists, check the endpoint.`
  );
}

/**
 * Run the extraction stage: one-shot call to extract voice quirks and POV info.
 * With `seg` set (chunked fallback) the extraction is scoped to one chapter:
 * the source message is the chapter file and the cumulative reference is the
 * previous volume's reference (first chapter) or the current in-volume state.
 *
 * @param {CharacterVoiceVolumeCtx} ctx
 * @param {SourceSegment|null} [seg] - The chapter being extracted (fallback).
 * @param {number} [si] - Zero-based position in reading order.
 * @returns {Promise<string>}
 */
async function runExtract(ctx, seg = null, si = null) {
  const { values } = ctx;
  const labelSuffix = seg ? `-${seg.id}` : "";
  if (seg) {
    console.log(`Volume ${values.INSTALLMENT_NUMBER}: running voice/POV extraction for chapter ${seg.id}...`);
    const messages = [{ file: path.join(ctx.volumeDir, seg.file), name: seg.file }];
    const stateFile = si === 0 ? ctx.previousVoiceRefFile : ctx.voiceOutputFile;
    if (stateFile) {
      messages.push({ file: stateFile, name: si === 0 ? "character-voice-previous.md" : "character-voice-current.md" });
    }
    messages.push({ text: ctx.extractPrompt }, { text: chapterSegmentNote(ctx.bundle, seg, si) });
    return harness.runOneShot({ systemPrompt: ctx.extractSystemPrompt, messages, label: `character-voice-extract-${values.INSTALLMENT_NUMBER}${labelSuffix}` });
  }
  const { sourceFile } = ctx;
  console.log(`Volume ${values.INSTALLMENT_NUMBER}: running voice/POV extraction...`);
  const messages = [{ file: sourceFile, name: path.basename(sourceFile) }, { text: ctx.extractPrompt }];
  if (ctx.previousVoiceRefFile) {
    messages.push({ file: ctx.previousVoiceRefFile, name: "character-voice-previous.md" });
  }
  return harness.runOneShot({ systemPrompt: ctx.extractSystemPrompt, messages, label: `character-voice-extract-${values.INSTALLMENT_NUMBER}` });
}

/**
 * Run the compile stage: author agent writes character-voice.md and pov-map.md.
 * With `seg` set (chunked fallback) the pass is scoped to one chapter.
 *
 * @param {CharacterVoiceVolumeCtx} ctx
 * @param {string} extractionOutput
 * @param {SourceSegment|null} [seg] - The chapter being processed (fallback).
 * @param {number} [si] - Zero-based position in reading order.
 */
async function runCompile(ctx, extractionOutput, seg = null, si = null) {
  const { values, authorSystemPrompt } = ctx;
  const labelSuffix = seg ? `-${seg.id}` : "";
  let parsed = [];
  let extractionResults = "";
  try {
    parsed = parseVoiceQuirks(extractionOutput);
    extractionResults = JSON.stringify(parsed, null, 2);
  } catch (err) {
    console.warn(`Volume ${values.INSTALLMENT_NUMBER}: extraction parse failed: ${err.message}. Using raw output.`);
    extractionResults = extractionOutput;
  }
  console.log(`Volume ${values.INSTALLMENT_NUMBER}: running voice/POV compilation${seg ? ` for chapter ${seg.id}` : ""}...`);
  const author = await harness.createAgentHandle({ name: `author-voice-${values.INSTALLMENT_NUMBER}${labelSuffix}`, systemPrompt: buildAuthorSystemPrompt(authorSystemPrompt), tools: ctx.fsGate.tools, approve: ctx.fsGate.approve, cwd: ctx.volumeDir, maxSteps: 30 });
  try {
    const compileResult = await author.sendTurn(buildAuthorTurnPrompt(ctx, extractionResults, seg, si), { label: `character-voice-compile-${values.INSTALLMENT_NUMBER}${labelSuffix}` });
    assertRealToolCalls(compileResult, `the author agent (compile${seg ? `, chapter ${seg.id}` : ""})`, values.INSTALLMENT_NUMBER);
    const compileFallbackUsed = await assertWroteWithFallback([ctx.voiceOutputFile, ctx.povOutputFile], `the author agent (compile${seg ? `, chapter ${seg.id}` : ""})`, compileResult?.text);
    // Recovery turn: ONLY when a file was actually missing after the fallback —
    // never over files the agent already wrote correctly.
    if (compileFallbackUsed && process.env.AGENT_RECOVERY_ENABLED !== "false") {
      const hasContent = compileResult?.text && compileResult.text.trim().length > 0;
      const recoveryPrompt = hasContent ? `You were asked to write "character-voice.md" and "pov-map.md" using writeFile, but you replied in chat. Please rewrite both files using writeFile now with the exact same content.` : `You produced no output. Please read the materials and write "character-voice.md" and "pov-map.md" using writeFile now.`;
      const recoveryResult = await author.sendTurn(recoveryPrompt, { label: `character-voice-compile-recovery-${values.INSTALLMENT_NUMBER}${labelSuffix}` });
      assertRealToolCalls(recoveryResult, `the author agent (compile recovery${seg ? `, chapter ${seg.id}` : ""})`, values.INSTALLMENT_NUMBER);
      await assertWroteWithFallback([ctx.voiceOutputFile, ctx.povOutputFile], `the author agent (compile recovery${seg ? `, chapter ${seg.id}` : ""})`, recoveryResult?.text);
    }
    console.log(`Volume ${values.INSTALLMENT_NUMBER}: saved voice reference to ${ctx.voiceOutputFile} and POV map to ${ctx.povOutputFile}${seg ? ` (after chapter ${seg.id})` : ""}`);
  } finally { await author.close(); }
}

/**
 * QA loop: validator -> acceptance -> feedback (the shared loop in
 * utils/qa-loop.js — this wrapper supplies the character-voice-specific
 * pieces: validator naming/prompts, the acceptance check, the feedback
 * stage, and the log lines).
 * @param {CharacterVoiceVolumeCtx} ctx
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
    createValidatorAgent: async (iteration) => harness.createAgentHandle({ name: `validator-voice-${values.INSTALLMENT_NUMBER}-${iteration}`, systemPrompt: ctx.validatorSystemPrompt + AGENT_TOOLS_NOTE, tools: fsGate.tools, approve: fsGate.approve, cwd: volumeDir, maxSteps: validatorMaxStepsFor((await fs.stat(sourceFile)).size) }),
    buildValidatorTurn: (iteration) => buildValidatorTurnPrompt(ctx),
    validatorLabel: (iteration) => `character-voice-validate-${values.INSTALLMENT_NUMBER}-${iteration}`,
    validatorRecoveryLabel: (iteration) => `character-voice-validate-recovery-${values.INSTALLMENT_NUMBER}-${iteration}`,
    validatorRecoveryPrompt: (hasContent) => hasContent ? `You were asked to write "character-voice-validation.md" using writeFile, but you replied in chat. Please rewrite the report using writeFile now with the same content.` : `You produced no output. Please write the validation report to "character-voice-validation.md" using writeFile now.`,
    assertRealToolCalls: (result, who) => assertRealToolCalls(result, who, values.INSTALLMENT_NUMBER),
    acceptanceLogLine: () => "Calling the AI for the acceptance check...",
    acceptanceCheck: (iteration) => acceptanceCheck(ctx, iteration),
    feedbackLogLine: () => "Calling the AI to apply the validation feedback (author agent)...",
    runFeedback: (iteration) => runFeedback(ctx),
    limitReachedLogLine: () => `Volume ${values.INSTALLMENT_NUMBER}: reached the validation iteration limit (${maxValidationIterations}) without a passing grade.`,
  });
  ctx.limitReached = result.limitReached;
  return result;
}

/**
 * Run the feedback stage: fresh author agent applies validation feedback.
 * @param {CharacterVoiceVolumeCtx} ctx
 */
async function runFeedback(ctx) {
  const { values, volumeDir, fsGate } = ctx;
  const author = await harness.createAgentHandle({ name: `author-voice-feedback-${values.INSTALLMENT_NUMBER}`, systemPrompt: ctx.feedbackSystemPrompt + AGENT_TOOLS_NOTE, tools: fsGate.tools, approve: fsGate.approve, cwd: volumeDir, maxSteps: 30 });
  try {
    const feedbackResult = await author.sendTurn(buildFeedbackTurnPrompt(ctx), { label: `character-voice-feedback-${values.INSTALLMENT_NUMBER}` });
    assertRealToolCalls(feedbackResult, "the author agent (feedback pass)", values.INSTALLMENT_NUMBER);
    const feedbackFallbackUsed = await assertWroteWithFallback([ctx.voiceOutputFile, ctx.povOutputFile], "the author agent (feedback pass)", feedbackResult?.text);
    // Recovery turn: ONLY when a file was actually missing after the fallback —
    // never over files the agent already wrote correctly.
    if (feedbackFallbackUsed && process.env.AGENT_RECOVERY_ENABLED !== "false") {
      const hasContent = feedbackResult?.text && feedbackResult.text.trim().length > 0;
      const recoveryPrompt = hasContent ? `You were asked to write "character-voice.md" and "pov-map.md" using writeFile, but you replied in chat. Please rewrite both files using writeFile now.` : `You produced no output. Please read the materials and write "character-voice.md" and "pov-map.md" using writeFile now.`;
      const recoveryResult = await author.sendTurn(recoveryPrompt, { label: `character-voice-feedback-recovery-${values.INSTALLMENT_NUMBER}` });
      assertRealToolCalls(recoveryResult, "the author agent (feedback recovery)", values.INSTALLMENT_NUMBER);
      await assertWroteWithFallback([ctx.voiceOutputFile, ctx.povOutputFile], "the author agent (feedback recovery)", recoveryResult?.text);
    }
  } finally { await author.close(); }
}

/**
 * Shared acceptance check: always a tool-less single-shot call.
 * The model scores the audited output 0–100 (100 = perfect, 0 = atrocious);
 * the score — not a binary verdict — is what the rolling window tracks.
 * @param {CharacterVoiceVolumeCtx} ctx
 * @param {number} iteration
 * @returns {Promise<number | null>} The parsed score (0–100), or `null`
 *   when no valid score could be extracted (treated as a failed check).
 */
async function acceptanceCheck(ctx, iteration) {
  const { values, validationOutputFile, acceptancePrompt, acceptanceSystemPrompt, voiceOutputFile, povOutputFile } = ctx;
  const acceptanceOutput = await harness.runOneShot({ systemPrompt: acceptanceSystemPrompt, messages: [{ file: voiceOutputFile, name: "character-voice.md" }, { file: povOutputFile, name: "pov-map.md" }, { file: validationOutputFile, name: "character-voice-validation.md" }, { text: acceptancePrompt }], label: `character-voice-acceptance-${values.INSTALLMENT_NUMBER}-${iteration}` });
  const reply = parseAcceptanceReply(acceptanceOutput);
  if (reply === null) {
    console.log(`Volume ${values.INSTALLMENT_NUMBER}: acceptance check: no valid score in response (got: ${JSON.stringify(acceptanceOutput.trim().slice(0, 120))}). Counting this check as a failure.`);
  } else {
    console.log(`Volume ${values.INSTALLMENT_NUMBER}: acceptance check: score ${reply.score}/100` + (reply.band ? ` (band: ${reply.band})` : "") + (reply.note ? ` — ${reply.note}` : "") + ` (passing score: ${ACCEPTANCE_PASSING_SCORE})`);
  }
  return reply ? reply.score : null;
}

/**
 * Process a single volume chapter by chapter (the FALLBACK path, used when
 * the whole installment is too large for one pass): each chapter segment goes
 * through the same stage sequence a whole volume does — extract → compile —
 * chained so each chapter builds on the previous one's reference state. The
 * QA loop then validates the finished volume chapter by chapter (per-chapter
 * partial reports → findings merge → acceptance) with per-chapter feedback.
 *
 * @param {CharacterVoiceVolumeCtx} ctx - The volume context (must include bundle).
 */
async function runChunkedVolume(ctx) {
  const { values, bundle } = ctx;
  console.log(
    `Volume ${values.INSTALLMENT_NUMBER}: chapter-by-chapter fallback ` +
      `(${bundle.segments.length} segments, ${bundle.wholeChars} chars whole)...`
  );
  // Create fsGate BEFORE any compile so the author agent has file tools
  // (createGatedFsTools is async and must be awaited — see runVolume).
  const fsGate = await harness.createGatedFsTools({ cwd: ctx.volumeDir, allowedDirs: [ctx.volumeDir] });
  ctx.fsGate = fsGate;
  const chunkedExtractions = [];
  for (let si = 0; si < bundle.segments.length; si++) {
    const segment = bundle.segments[si];
    let extractionOutput = "";
    try {
      extractionOutput = await runExtract(ctx, segment, si);
    } catch (err) {
      console.error(`Volume ${values.INSTALLMENT_NUMBER}: extraction failed for chapter ${segment.id}: ${err.message}. Check .logs/ for details.`);
      throw err;
    }
    // Accumulate the parsed entries so the whole volume's "new" results are
    // persisted once (see the write after the loop).
    try {
      chunkedExtractions.push(...parseVoiceQuirks(extractionOutput));
    } catch {
      // Unparseable chapter output — runCompile falls back to the raw text;
      // nothing structured to persist for this chapter.
    }
    try {
      await runCompile(ctx, extractionOutput, segment, si);
    } catch (err) {
      console.error(`Volume ${values.INSTALLMENT_NUMBER}: compilation failed for chapter ${segment.id}: ${err.message}. Check .logs/ for details.`);
      throw err;
    }
  }
  // Persist the volume's extraction results (the new quirks/POV entries) so
  // the translation handoff (utils/handoff.js) can render a "what's new in
  // this volume" section without re-calling the AI.
  try {
    await fs.writeFile(path.join(ctx.volumeDir, "character-voice-new.json"), JSON.stringify(chunkedExtractions, null, 2) + "\n", "utf8");
  } catch (err) {
    console.warn(`Volume ${values.INSTALLMENT_NUMBER}: could not persist character-voice-new.json (${err.message}) — continuing.`);
  }
  await runChunkedQaLoop(ctx);
}

/**
 * Chunked (fallback) QA loop: per-chapter validator passes (fresh agent per
 * chapter) write character-voice-validation-<id>.md partials; a findings-merge
 * agent consolidates them into the standard character-voice-validation.md; the
 * unchanged acceptance one-shot scores it; on a failed window, per-chapter
 * feedback agents apply the chapter-tagged findings.
 *
 * @param {CharacterVoiceVolumeCtx} ctx - The volume context (must include ctx.fsGate).
 */
async function runChunkedQaLoop(ctx) {
  const { values, bundle, volumeDir, validationOutputFile, fsGate } = ctx;
  const recentRollingScores = [];
  for (let iteration = 1; iteration <= maxValidationIterations; iteration++) {
    console.log(`Volume ${values.INSTALLMENT_NUMBER}: validation iteration ${iteration}/${maxValidationIterations} (chapter by chapter)...`);
    // Per-chapter validation partials (fresh agent per chapter).
    for (let si = 0; si < bundle.segments.length; si++) {
      const segment = bundle.segments[si];
      const partialFile = path.join(volumeDir, `character-voice-validation-${segment.id}.md`);
      const validator = await harness.createAgentHandle({ name: `validator-voice-${values.INSTALLMENT_NUMBER}-${iteration}-${segment.id}`, systemPrompt: ctx.validatorSystemPrompt + AGENT_TOOLS_NOTE, tools: fsGate.tools, approve: fsGate.approve, cwd: volumeDir, maxSteps: validatorMaxStepsFor((await fs.stat(path.join(volumeDir, segment.file))).size) });
      try {
        const validateResult = await validator.sendTurn(buildValidatorTurnPrompt(ctx, segment, si), { label: `character-voice-validate-${values.INSTALLMENT_NUMBER}-${iteration}-${segment.id}` });
        assertRealToolCalls(validateResult, `the validator agent (chapter ${segment.id})`, values.INSTALLMENT_NUMBER);
        const validateFallbackUsed = await assertWroteWithFallback(partialFile, `the validator agent (chapter ${segment.id})`, validateResult?.text);
        // Recovery turn: ONLY when the partial was actually missing after the
        // fallback — never over a file the agent already wrote correctly.
        if (validateFallbackUsed && process.env.AGENT_RECOVERY_ENABLED !== "false") {
          const hasContent = validateResult?.text && validateResult.text.trim().length > 0;
          const recoveryPrompt = hasContent ? `You were asked to write the validation report to "${path.basename(partialFile)}" using writeFile, but you replied with the content in your chat message instead. Please rewrite the complete report using writeFile now.` : `You produced no output. Please read the materials and write the complete validation report to "${path.basename(partialFile)}" using writeFile now.`;
          const recoveryResult = await validator.sendTurn(recoveryPrompt, { label: `character-voice-validate-recovery-${values.INSTALLMENT_NUMBER}-${iteration}-${segment.id}` });
          assertRealToolCalls(recoveryResult, `the validator agent (recovery, chapter ${segment.id})`, values.INSTALLMENT_NUMBER);
          await assertWroteWithFallback(partialFile, `the validator agent (recovery, chapter ${segment.id})`, recoveryResult?.text);
        }
      } finally { await validator.close(); }
    }
    // Findings merge: consolidate the partials into the standard report.
    const merger = await harness.createAgentHandle({ name: `validator-merge-${values.INSTALLMENT_NUMBER}-${iteration}`, systemPrompt: ctx.validatorSystemPrompt + AGENT_TOOLS_NOTE, tools: fsGate.tools, approve: fsGate.approve, cwd: volumeDir, maxSteps: 20 });
    try {
      const mergeResult = await merger.sendTurn(buildVoiceFindingsMergePrompt(ctx), { label: `character-voice-validate-merge-${values.INSTALLMENT_NUMBER}-${iteration}` });
      assertRealToolCalls(mergeResult, "the findings-merge agent", values.INSTALLMENT_NUMBER);
      await assertWroteWithFallback(validationOutputFile, "the findings-merge agent", mergeResult?.text);
    } finally { await merger.close(); }
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
    if (meetsAcceptanceCriteria(recentRollingScores)) {
      const avg = computeRollingAverage(recentRollingScores);
      console.log(`Volume ${values.INSTALLMENT_NUMBER}: rolling average ${avg.toFixed(1)}/100 (${recentRollingScores.length} checks) meets the passing score ${ACCEPTANCE_PASSING_SCORE}. Accepted.`);
      break;
    }
    // Per-chapter feedback (fresh agent per chapter, chapter-tagged findings).
    for (let si = 0; si < bundle.segments.length; si++) {
      const segment = bundle.segments[si];
      const feedbackAuthor = await harness.createAgentHandle({ name: `feedback-author-${values.INSTALLMENT_NUMBER}-${iteration}-${segment.id}`, systemPrompt: buildAuthorSystemPrompt(ctx.authorSystemPrompt), tools: fsGate.tools, approve: fsGate.approve, cwd: volumeDir, maxSteps: 30 });
      try {
        const feedbackResult = await feedbackAuthor.sendTurn(buildFeedbackTurnPrompt(ctx, segment, si), { label: `character-voice-feedback-${values.INSTALLMENT_NUMBER}-${iteration}-${segment.id}` });
        assertRealToolCalls(feedbackResult, `the author agent (feedback pass, chapter ${segment.id})`, values.INSTALLMENT_NUMBER);
        const feedbackFallbackUsed = await assertWroteWithFallback([ctx.voiceOutputFile, ctx.povOutputFile], `the author agent (feedback pass, chapter ${segment.id})`, feedbackResult?.text);
        // Recovery turn: ONLY when a file was actually missing after the
        // fallback — never over files the agent already wrote correctly.
        if (feedbackFallbackUsed && process.env.AGENT_RECOVERY_ENABLED !== "false") {
          const hasContent = feedbackResult?.text && feedbackResult.text.trim().length > 0;
          const recoveryPrompt = hasContent ? `You were asked to write "character-voice.md" and "pov-map.md" using writeFile, but you replied in chat. Please rewrite both files using writeFile now.` : `You produced no output. Please read the materials and write "character-voice.md" and "pov-map.md" using writeFile now.`;
          const recoveryResult = await feedbackAuthor.sendTurn(recoveryPrompt, { label: `character-voice-feedback-recovery-${values.INSTALLMENT_NUMBER}-${iteration}-${segment.id}` });
          assertRealToolCalls(recoveryResult, `the author agent (feedback recovery, chapter ${segment.id})`, values.INSTALLMENT_NUMBER);
          await assertWroteWithFallback([ctx.voiceOutputFile, ctx.povOutputFile], `the author agent (feedback recovery, chapter ${segment.id})`, recoveryResult?.text);
        }
      } finally { await feedbackAuthor.close(); }
    }
    if (iteration === maxValidationIterations) {
      ctx.limitReached = true;
      console.log(`Volume ${values.INSTALLMENT_NUMBER}: reached the validation iteration limit without a passing grade. The last feedback pass is unvalidated; re-run to validate it.`);
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
 * Process a single volume: extract -> compile -> QA loop. Chunked (fallback)
 * volumes take runChunkedVolume instead.
 * @param {CharacterVoiceVolumeCtx} ctx
 */
async function runVolume(ctx) {
  const { values } = ctx;
  // Chunked (fallback) volumes take the per-chapter flow instead.
  if (ctx.chunked) {
    await runChunkedVolume(ctx);
    return;
  }
  let extractionOutput = "";
  try { extractionOutput = await runExtract(ctx); } catch (err) { console.error(`Volume ${values.INSTALLMENT_NUMBER}: extraction failed: ${err.message}. Check .logs/ for details.`); throw err; }
  // Persist the volume's extraction results (the new quirks/POV entries) so
  // the translation handoff (utils/handoff.js) can render a "what's new in
  // this volume" section without re-calling the AI.
  try {
    await fs.writeFile(path.join(ctx.volumeDir, "character-voice-new.json"), JSON.stringify(parseVoiceQuirks(extractionOutput), null, 2) + "\n", "utf8");
  } catch (err) {
    console.warn(`Volume ${values.INSTALLMENT_NUMBER}: could not persist character-voice-new.json (${err.message}) — continuing.`);
  }
  // Create fsGate BEFORE runCompile so the author agent has file tools.
  // createGatedFsTools is async — it must be awaited, otherwise fsGate is a
  // Promise and ctx.fsGate.tools/approve are undefined, so the agents are
  // created with no tools at all (observed live: the model then emitted
  // tool-call syntax as plain text and the run failed mid-way).
  const fsGate = await harness.createGatedFsTools({ cwd: ctx.volumeDir, allowedDirs: [ctx.volumeDir] });
  ctx.fsGate = fsGate;
  try { await runCompile(ctx, extractionOutput); } catch (err) { console.error(`Volume ${values.INSTALLMENT_NUMBER}: compilation failed: ${err.message}. Check .logs/ for details.`); throw err; }
  await runQaLoop(ctx);
}

// Export
module.exports = { characterVoice, parseVoiceQuirks, truncateVoiceRef, emittedToolCallAsText, buildExtractTurnPrompt, buildAuthorTurnPrompt, buildValidatorTurnPrompt, buildFeedbackTurnPrompt, buildVoiceFindingsMergePrompt, buildExtractSystemPrompt, buildAuthorSystemPrompt, buildValidatorSystemPrompt, runVolume, runExtract, runCompile, runQaLoop, runChunkedVolume, runChunkedQaLoop, acceptanceCheck };
