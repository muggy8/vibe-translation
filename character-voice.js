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
 *     5. Run the QA loop with rolling-average acceptance.
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
const { transformUserPrompt, isPassingVerdict, validatorMaxStepsFor, writePromptDump } = require("./utils/prompt");
const { getTranslationTarget } = require("./get-translation-target");
const { AGENT_TOOLS_NOTE, ROLLING_WINDOW_SIZE, ROLLING_ACCEPTANCE_THRESHOLD, ROLLING_MIN_SAMPLES, computeRollingAverage, saveRollingState } = require("./configs/shared");
const { fileExists, assertWrote, assertWroteWithFallback } = require("./utils/fs");

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

const maxValidationIterations = Math.max(1, parseInt(process.env.MAX_VALIDATION_ITERATIONS, 10) || 10);
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
 * to read.
 *
 * @param {CharacterVoiceVolumeCtx} ctx
 * @param {string} extractionResults
 * @returns {string}
 */
function buildAuthorTurnPrompt(ctx, extractionResults) {
  const { sourceFile, isFirst, previousFolderName } = ctx;
  const amendPrompt = transformUserPrompt(ctx.authorUserPrompt, {
    ...ctx.values,
    EXTRACTION_RESULTS: extractionResults || "(none — this is the first volume)",
  });
  const previousRefLine = isFirst
    ? "- The previous character voice reference: (absent — this is the first volume)"
    : `- The previous character voice reference: "../${previousFolderName}/character-voice.md"`;
  return (
    `Working folder: the volume folder (you are in it).\n\n` +
    `Materials (read with readFile before writing anything):\n` +
    `- The volume source: "${path.basename(sourceFile)}" (same folder)\n` +
    previousRefLine +
    `\n\n` +
    `Write the complete character voice reference to the file "character-voice.md" in your working folder (writeFile, complete contents).\n` +
    `Write the per-volume POV map to the file "pov-map.md" in your working folder (writeFile, complete contents).\n\n` +
    amendPrompt
  );
}

/**
 * Build the validator turn prompt for a single volume.
 * @param {CharacterVoiceVolumeCtx} ctx
 * @returns {string}
 */
function buildValidatorTurnPrompt(ctx) {
  const { sourceFile, isFirst, previousFolderName } = ctx;
  const previousRefLine = isFirst
    ? ""
    : `- The previous character voice reference: "../${previousFolderName}/character-voice.md"\n`;
  return (
    `Working folder: the volume folder (you are in it).\n\n` +
    `Materials (read with readFile before writing anything):\n` +
    `- The volume source: "${path.basename(sourceFile)}" (same folder)\n` +
    `- The amended character voice reference under audit: "character-voice.md" (same folder)\n` +
    `- The POV map under audit: "pov-map.md" (same folder)\n` +
    previousRefLine +
    `\n` +
    `Write the complete validation report to the file "character-voice-validation.md" in your working folder (writeFile, exact format from the system prompt).\n\n` +
    transformUserPrompt(ctx.validatorUserPrompt, ctx.values)
  );
}

/**
 * Build the feedback turn prompt for a single volume.
 * @param {CharacterVoiceVolumeCtx} ctx
 * @returns {string}
 */
function buildFeedbackTurnPrompt(ctx) {
  const { sourceFile, isFirst, previousFolderName } = ctx;
  const previousRefLine = isFirst
    ? ""
    : `- The previous character voice reference: "../${previousFolderName}/character-voice.md"\n`;
  return (
    `Working folder: the volume folder (you are in it).\n\n` +
    `The validation report "character-voice-validation.md" in your working folder is your work order.\n` +
    `Materials (read with readFile before changing anything):\n` +
    `- The volume source: "${path.basename(sourceFile)}" (same folder)\n` +
    `- The current character voice reference to correct: "character-voice.md" (same folder)\n` +
    `- The current POV map to correct: "pov-map.md" (same folder)\n` +
    previousRefLine +
    `\n` +
    `Apply the report's findings and write the complete corrected files back to "character-voice.md" and "pov-map.md" using writeFile (complete contents).\n\n` +
    transformUserPrompt(ctx.feedbackUserPrompt, ctx.values)
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
  const volumeArg = process.argv.includes("--volume")
    ? process.argv[process.argv.indexOf("--volume") + 1] : null;
  console.log("character-voice task starting...");
  const manifest = await getTranslationTarget();
  const seriesDir = manifest.seriesLocation;
  const sorted = manifest.volumes.map((v) => v.folder).sort((a, b) => {
    return parseInt(a.match(/\((\d+)\)/)?.[1]||"999",10) - parseInt(b.match(/\((\d+)\)/)?.[1]||"999",10);
  });
  const volumeByFolder = new Map(manifest.volumes.map((v) => [v.folder, v]));
  const volumes = volumeArg ? sorted.filter((f) => f===volumeArg) : sorted;
  if (volumes.length===0) { console.log("No volumes found. Exiting."); return; }
  let regeneratedAny = false;
  for (const folderName of volumes) {
    // Index into the FULL sorted list (not the filtered one) so --volume runs
    // still resolve the correct manifest entry and previous volume.
    const i = sorted.indexOf(folderName);
    const volume = volumeByFolder.get(folderName);
    const values = { INSTALLMENT_NUMBER: volume.installmentNumber, SOURCE_NAME: manifest.seriesName, SOURCE_LANGUAGE: process.env.SOURCE_LANGUAGE||"Japanese", TARGET_LANGUAGE: process.env.TARGET_LANGUAGE||"English" };
    const volumeDir = path.join(seriesDir, folderName);
    const sourceFile = path.join(seriesDir, volume.sourceFile);
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
        } else {
          throw new Error(
            `Previous character voice reference not found: ${previousVoiceRefFile}. ` +
              `Process the earlier volume first (or re-run without --force).`
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
    const ctx = { values, folderName, volumeDir, sourceFile, voiceOutputFile, povOutputFile, validationOutputFile, isFirst, previousFolderName, previousVoiceRefFile, extractPrompt, validatorPrompt, feedbackPrompt, acceptancePrompt, extractTemplate, authorTemplate, extractSystemPrompt, authorSystemPrompt, validatorSystemPrompt, acceptanceSystemPrompt, feedbackSystemPrompt, authorUserPrompt: authorTemplate, validatorUserPrompt: validatorTemplate, feedbackUserPrompt: feedbackTemplate };
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
        skip = state.results.length >= ROLLING_MIN_SAMPLES && avg >= ROLLING_ACCEPTANCE_THRESHOLD;
        if (skip) { console.log(`Volume ${values.INSTALLMENT_NUMBER}: rolling-state (${state.results.length} checks, avg ${avg.toFixed(2)}) meets threshold. Skipping.`); }
      }
    }
    if (skip) { console.log(`Volume ${values.INSTALLMENT_NUMBER}: voice reference and POV map already exist and passed. Skipping.`); continue; }
    regeneratedAny = true;
    await runVolume(ctx);
  }
  if (volumeArg) { console.log("\n--volume: skipping the series-root copy."); }
  else {
    const finalVoiceFile = process.env.VOICE_OUTPUT_FILE || path.join(seriesDir, "character-voice.md");
    let lastVoice = null;
    for (let i = sorted.length - 1; i >= 0; i--) {
      const candidate = path.join(seriesDir, sorted[i], "character-voice.md");
      if (await fileExists(candidate)) { lastVoice = candidate; break; }
    }
    if (lastVoice) { await fs.copyFile(lastVoice, finalVoiceFile); console.log(`\nCopied the final character voice reference to: ${finalVoiceFile}`); }
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
 * @param {CharacterVoiceVolumeCtx} ctx
 * @returns {Promise<string>}
 */
async function runExtract(ctx) {
  const { values, sourceFile } = ctx;
  console.log(`Volume ${values.INSTALLMENT_NUMBER}: running voice/POV extraction...`);
  const messages = [{ file: sourceFile, name: path.basename(sourceFile) }, { text: ctx.extractPrompt }];
  if (ctx.previousVoiceRefFile) {
    messages.push({ file: ctx.previousVoiceRefFile, name: "character-voice-previous.md" });
  }
  return harness.runOneShot({ systemPrompt: ctx.extractSystemPrompt, messages, label: `character-voice-extract-${values.INSTALLMENT_NUMBER}` });
}

/**
 * Run the compile stage: author agent writes character-voice.md and pov-map.md.
 * @param {CharacterVoiceVolumeCtx} ctx
 * @param {string} extractionOutput
 */
async function runCompile(ctx, extractionOutput) {
  const { values, authorSystemPrompt } = ctx;
  let parsed = [];
  let extractionResults = "";
  try {
    parsed = parseVoiceQuirks(extractionOutput);
    extractionResults = JSON.stringify(parsed, null, 2);
  } catch (err) {
    console.warn(`Volume ${values.INSTALLMENT_NUMBER}: extraction parse failed: ${err.message}. Using raw output.`);
    extractionResults = extractionOutput;
  }
  console.log(`Volume ${values.INSTALLMENT_NUMBER}: running voice/POV compilation...`);
  const author = await harness.createAgentHandle({ name: `author-voice-${values.INSTALLMENT_NUMBER}`, systemPrompt: buildAuthorSystemPrompt(authorSystemPrompt), tools: ctx.fsGate.tools, approve: ctx.fsGate.approve, cwd: ctx.volumeDir, maxSteps: 30 });
  try {
    const compileResult = await author.sendTurn(buildAuthorTurnPrompt(ctx, extractionResults), { label: `character-voice-compile-${values.INSTALLMENT_NUMBER}` });
    assertRealToolCalls(compileResult, "the author agent (compile)", values.INSTALLMENT_NUMBER);
    await assertWroteWithFallback([ctx.voiceOutputFile, ctx.povOutputFile], "the author agent (compile)", compileResult?.text);
    if (process.env.RECOVERY_ENABLED !== "false") {
      const hasContent = compileResult?.text && compileResult.text.trim().length > 0;
      const recoveryPrompt = hasContent ? `You were asked to write "character-voice.md" and "pov-map.md" using writeFile, but you replied in chat. Please rewrite both files using writeFile now with the exact same content.` : `You produced no output. Please read the materials and write "character-voice.md" and "pov-map.md" using writeFile now.`;
      const recoveryResult = await author.sendTurn(recoveryPrompt, { label: `character-voice-compile-recovery-${values.INSTALLMENT_NUMBER}` });
      assertRealToolCalls(recoveryResult, "the author agent (compile recovery)", values.INSTALLMENT_NUMBER);
      await assertWroteWithFallback([ctx.voiceOutputFile, ctx.povOutputFile], "the author agent (compile recovery)", recoveryResult?.text);
    }
    console.log(`Volume ${values.INSTALLMENT_NUMBER}: saved voice reference to ${ctx.voiceOutputFile} and POV map to ${ctx.povOutputFile}`);
  } finally { await author.close(); }
}

/**
 * QA loop: validator -> acceptance -> feedback.
 * @param {CharacterVoiceVolumeCtx} ctx
 */
async function runQaLoop(ctx) {
  const { values, volumeDir, sourceFile, validationOutputFile, fsGate } = ctx;
  const recentRollingResults = [];
  for (let iteration = 1; iteration <= maxValidationIterations; iteration++) {
    console.log(`Volume ${values.INSTALLMENT_NUMBER}: validation iteration ${iteration}/${maxValidationIterations}...`);
    const validator = await harness.createAgentHandle({ name: `validator-voice-${values.INSTALLMENT_NUMBER}-${iteration}`, systemPrompt: ctx.validatorSystemPrompt + AGENT_TOOLS_NOTE, tools: fsGate.tools, approve: fsGate.approve, cwd: volumeDir, maxSteps: validatorMaxStepsFor((await fs.stat(sourceFile)).size) });
    try {
      const validateResult = await validator.sendTurn(buildValidatorTurnPrompt(ctx), { label: `character-voice-validate-${values.INSTALLMENT_NUMBER}-${iteration}` });
      assertRealToolCalls(validateResult, "the validator agent", values.INSTALLMENT_NUMBER);
      await assertWroteWithFallback(validationOutputFile, "the validator agent", validateResult?.text);
      if (process.env.RECOVERY_ENABLED !== "false") {
        const hasContent = validateResult?.text && validateResult.text.trim().length > 0;
        const recoveryPrompt = hasContent ? `You were asked to write "character-voice-validation.md" using writeFile, but you replied in chat. Please rewrite the report using writeFile now with the same content.` : `You produced no output. Please write the validation report to "character-voice-validation.md" using writeFile now.`;
        const recoveryResult = await validator.sendTurn(recoveryPrompt, { label: `character-voice-validate-recovery-${values.INSTALLMENT_NUMBER}-${iteration}` });
        assertRealToolCalls(recoveryResult, "the validator agent (recovery)", values.INSTALLMENT_NUMBER);
        await assertWroteWithFallback(validationOutputFile, "the validator agent (recovery)", recoveryResult?.text);
      }
      console.log("Calling the AI for the acceptance check...");
      const accepted = await acceptanceCheck(ctx, iteration);
      recentRollingResults.push(accepted);
      if (accepted) {
        const passCount = recentRollingResults.filter(Boolean).length;
        console.log(`Volume ${values.INSTALLMENT_NUMBER}: acceptance check: PASS (${passCount}/${recentRollingResults.length} passes)`);
        break;
      }
      if (recentRollingResults.length >= ROLLING_MIN_SAMPLES) {
        const avg = computeRollingAverage(recentRollingResults);
        if (avg >= ROLLING_ACCEPTANCE_THRESHOLD) {
          const passCount = recentRollingResults.filter(Boolean).length;
          console.log(`Volume ${values.INSTALLMENT_NUMBER}: rolling average ${avg.toFixed(2)} (${passCount}/${recentRollingResults.length} passes) meets threshold. Accepted.`);
          break;
        }
      }
      console.log("Calling the AI to apply the validation feedback (author agent)...");
      await runFeedback(ctx);
      const stateFilePath = validationOutputFile.replace(".md", "-rolling-state.json");
      await saveRollingState(stateFilePath, recentRollingResults);
      if (iteration === maxValidationIterations) {
        ctx.limitReached = true;
        console.log(`Volume ${values.INSTALLMENT_NUMBER}: reached the validation iteration limit (${maxValidationIterations}) without a passing grade.`);
      }
    } finally { await validator.close(); }
  }
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
    await assertWroteWithFallback([ctx.voiceOutputFile, ctx.povOutputFile], "the author agent (feedback pass)", feedbackResult?.text);
    if (process.env.RECOVERY_ENABLED !== "false") {
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
 * @param {CharacterVoiceVolumeCtx} ctx
 * @param {number} iteration
 * @returns {Promise<boolean>}
 */
async function acceptanceCheck(ctx, iteration) {
  const { values, validationOutputFile, acceptancePrompt, acceptanceSystemPrompt } = ctx;
  const acceptanceOutput = await harness.runOneShot({ systemPrompt: acceptanceSystemPrompt, messages: [{ file: validationOutputFile, name: "character-voice-validation.md" }, { text: acceptancePrompt }], label: `character-voice-acceptance-${values.INSTALLMENT_NUMBER}-${iteration}` });
  const accepted = isPassingVerdict(acceptanceOutput);
  console.log(`Volume ${values.INSTALLMENT_NUMBER}: acceptance check: ${accepted ? "PASS" : "FAIL"}`);
  return accepted;
}

/**
 * Process a single volume: extract -> compile -> QA loop.
 * @param {CharacterVoiceVolumeCtx} ctx
 */
async function runVolume(ctx) {
  const { values } = ctx;
  let extractionOutput = "";
  try { extractionOutput = await runExtract(ctx); } catch (err) { console.error(`Volume ${values.INSTALLMENT_NUMBER}: extraction failed: ${err.message}. Check .logs/ for details.`); throw err; }
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
module.exports = { characterVoice, parseVoiceQuirks, truncateVoiceRef, emittedToolCallAsText, buildExtractTurnPrompt, buildAuthorTurnPrompt, buildValidatorTurnPrompt, buildFeedbackTurnPrompt, buildExtractSystemPrompt, buildAuthorSystemPrompt, buildValidatorSystemPrompt, runExtract, runCompile, runQaLoop, acceptanceCheck };
