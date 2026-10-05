/**
 * style-guide.js — Logic for the "style-guide" gulp task: building the
 * canonical style guide (house-style policies for rendering source-language
 * constructs in the target language) for a Japanese light novel series,
 * driven from the source text, one volume at a time.
 *
 * Task: style-guide
 *   For each volume (in natural order):
 *     1. Read the volume's source text and the previous style guide.
 *     2. Extract new style-relevant constructs using a one-shot call.
 *     3. Compile the cumulative style guide.
 *     4. Save per-volume snapshots.
 *     5. Run the QA loop with score-based acceptance (the model scores each
 *        validation 0–100; the rolling average of recent scores must reach
 *        PASSING_SCORE, default 70 — see configs/shared.js).
 *   After all volumes: the last volume's style-guide.md is copied to
 *   STYLE_OUTPUT_FILE (default <SERIES_LOCATION>/style-guide.md).
 *
 * Idempotent: a volume whose output already exists and passes acceptance is
 * skipped (unless --force). If any volume is regenerated, all later volumes
 * are regenerated too (each volume's guide builds on the previous one's).
 *
 * The style guide is the "how do I write it" policy layer the other three
 * pipelines do not cover: the glossary says what to call things,
 * character-voice says how characters sound, the wiki says what is
 * happening — the style guide says how source-language constructs (honorifics,
 * pronouns, sentence-ending particles, internal-monologue markers,
 * onomatopoeia, POV/scene markers, tense, punctuation, wordplay) get rendered
 * in the target language.
 *
 * Usage:
 *   npx gulp style-guide             # run the full task
 *   npx gulp style-guide --dry-run   # transform the prompts only, no API call
 *   npx gulp style-guide --force     # regenerate even if already processed
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("./types");
const harness = require("./harness");
const { transformUserPrompt, parseAcceptanceScore, parseAcceptanceReply, validatorMaxStepsFor, authorMaxStepsFor, findingsMergeMaxStepsFor, writePromptDump, selectSectionsByRelevance } = require("./utils/prompt");
const { getTranslationTarget } = require("./get-translation-target");
const { filterVolumesByInstallment } = require("./utils/manifest");
const { AGENT_TOOLS_NOTE, ACCEPTANCE_WINDOW_SIZE, ACCEPTANCE_PASSING_SCORE, computeRollingAverage, meetsAcceptanceCriteria, isAcceptedState, isSourceStale, saveRollingState, ON_VOLUME_ERROR, ON_MISSING_PREVIOUS, ON_QA_LIMIT, validateRequiredEnv, resolveRunSettings, seriesArtifactFile, judgeTemperature, judgeThinking, isStructuralError, volumeFailureError, readBoolEnv } = require("./configs/shared");
const { fileExists, assertWroteWithFallback, assertRealOutput, writeProvenanceSidecar, inlineReferenceMessage, isPublishableArtifact, fingerprintFiles } = require("./utils/fs");
const { emittedToolCallAsText, assertRealToolCalls } = require("./utils/agents");
const { runSharedQaLoop, confirmExceptionalScore, confirmPassingScore, runVolumeWithModeFallback } = require("./utils/qa-loop");
const {
  resolveSourceBundle,
  decideProcessingMode,
  sourceMaterialLine,
  chapterSegmentNote,
  chapterContextBlock,
} = require("./utils/source");

const clientDir = __dirname;
const seriesDir = process.env.SERIES_LOCATION;

// Context-window protection for the cumulative guide: same threshold as the
// glossary / voice reference (the guide is cumulative in exactly the same way).
const STYLE_GUIDE_TRUNCATION_THRESHOLD = 64 * 1024;
const STYLE_GUIDE_TRUNCATION_MAX_SECTIONS = 40;

/**
 * Truncate a style guide to its most recent `## ` sections when it exceeds the
 * threshold. The guide is cumulative, so older policies are carried forward
 * unchanged in the file itself — the newest sections are where a new construct
 * would conflict.
 *
 * (The glossary and voice reference have had truncators since their inception;
 * the style guide is cumulative in exactly the same way and had none.)
 *
 * @param {string} content - The full style-guide content.
 * @returns {string} The (possibly truncated) content.
 */
function truncateStyleGuide(content, sourceText) {
  if (!content || content.length <= STYLE_GUIDE_TRUNCATION_THRESHOLD) return content;
  // Relevance-ordered (see selectSectionsByRelevance in utils/prompt.js): a
  // section whose quoted source-language pattern occurs in the volume being
  // processed is kept whatever its position, so the honorific rules decided in
  // volume 1 are not dropped just because they were written first.
  const picked = selectSectionsByRelevance({
    content,
    headingRe: /^##[ \t]+/m,
    sourceText,
    maxUnits: STYLE_GUIDE_TRUNCATION_MAX_SECTIONS,
    unitLabel: "section(s)",
  });
  return picked.content;
}

const extractSystemPromptFile = path.join(clientDir, "system-prompts", "style-guide-extract.md");
const extractUserPromptTemplateFile = path.join(clientDir, "user-prompts", "style-guide-extract.md");
const authorSystemPromptFile = path.join(clientDir, "system-prompts", "style-guide.md");
const authorUserPromptTemplateFile = path.join(clientDir, "user-prompts", "style-guide.md");
const validatorSystemPromptFile = path.join(clientDir, "system-prompts", "style-guide-validator.md");
const validatorUserPromptTemplateFile = path.join(clientDir, "user-prompts", "style-guide-validator.md");
const acceptanceSystemPromptFile = path.join(clientDir, "system-prompts", "style-guide-acceptance.md");
const acceptanceUserPromptTemplateFile = path.join(clientDir, "user-prompts", "style-guide-acceptance.md");
const feedbackSystemPromptFile = path.join(clientDir, "system-prompts", "style-guide-feedback.md");
const feedbackUserPromptTemplateFile = path.join(clientDir, "user-prompts", "style-guide-feedback.md");

const maxValidationIterations = Math.max(1, parseInt(process.env.QA_MAX_ITERATIONS, 10) || 10);

// ─── Cumulative-document rules (the same shape glossary.js established) ───────
//
// The style guide is cumulative and grows volume by volume, so it hits the same
// wall the glossary did (AGENTS.md gotcha 64) and the character-voice reference
// was about to hit: "writeFile, complete contents" becomes impossible, the agent
// pages the file, runs out of steps, and rebuilds the document from memory. The
// stage carried a flat `maxSteps: 30` for its author and feedback agents — the
// same flat cap that stopped volume 01's character-voice feedback turn at 46 tool
// calls with zero writes.

/**
 * Seed this volume's style guide with the previous volume's, verbatim, before any
 * agent touches it. "Carry forward every existing rule" is a file copy, not a
 * model task; with the baseline in place the compile pass amends a real file and
 * `styleWriteInstruction` can say so.
 *
 * @param {StyleGuideVolumeCtx} ctx - The volume context.
 * @returns {Promise<boolean>} True when the volume's guide now starts from the
 *   previous volume's copy.
 */
async function seedStyleGuideFromPrevious(ctx) {
  const { values, isFirst, previousStyleGuideFile, styleOutputFile } = ctx;
  if (isFirst || !previousStyleGuideFile) return false;

  let previousText;
  try {
    previousText = await fs.readFile(previousStyleGuideFile, "utf8");
  } catch (err) {
    console.warn(
      `Volume ${values.INSTALLMENT_NUMBER}: could not read the previous style guide ` +
        `(${previousStyleGuideFile}: ${err.message}) — the author agent will write this ` +
        `volume's guide from scratch.`
    );
    return false;
  }
  if (!previousText || previousText.trim().length === 0) {
    console.warn(
      `Volume ${values.INSTALLMENT_NUMBER}: the previous style guide is empty — the author ` +
        `agent will write this volume's guide from scratch.`
    );
    return false;
  }

  let replaced = false;
  try {
    const existing = await fs.readFile(styleOutputFile, "utf8");
    replaced = existing.trim() !== previousText.trim();
  } catch {
    replaced = true;
  }

  await fs.writeFile(styleOutputFile, previousText, "utf8");
  ctx.styleSeeded = true;
  ctx.styleIndex = buildStyleIndex(previousText);
  if (replaced) {
    console.log(
      `Volume ${values.INSTALLMENT_NUMBER}: seeded style-guide.md from ` +
        `../${path.basename(path.dirname(previousStyleGuideFile))}/style-guide.md ` +
        `(${parseStyleSections(previousText).length} section(s), ` +
        `${countStyleRules(previousText)} rule(s) carried forward verbatim; the author agent ` +
        `amends it in place).`
    );
  }
  return true;
}

/**
 * The `##` sections of a style guide, in file order.
 *
 * The guide's category set is fixed by `system-prompts/style-guide.md` (Address &
 * Honorifics, Pronouns, …, Open Questions), which makes the category headings the
 * one cumulative unit this document can be compared on. Individual rules are free
 * prose bullets, and comparing prose is how a guard starts calling an improvement
 * a loss (the mistake that cost the glossary a good volume 02).
 *
 * @param {string} markdown - The guide file content.
 * @returns {Array<{name: string}>} The section names, in file order.
 */
function parseStyleSections(markdown) {
  if (!markdown || typeof markdown !== "string") return [];
  const sections = [];
  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim();
    const heading = line.match(/^##\s+(.+)$/);
    if (!heading) continue;
    const name = heading[1].replace(/\*\*?/g, "").replace(/`/g, "").trim();
    if (!name) continue;
    sections.push({ name });
  }
  return sections;
}

/**
 * Count the rule bullets in a style guide (a size signal, reported, never a
 * threshold — a guide that says the same thing in fewer words is not damaged).
 *
 * @param {string} markdown - The guide file content.
 * @returns {number} The number of top-level bullet lines.
 */
function countStyleRules(markdown) {
  if (!markdown || typeof markdown !== "string") return 0;
  return markdown.split("\n").filter((line) => /^\s*[-*] \S/.test(line)).length;
}

/**
 * The compact "what the guide already holds" map for an agent turn: each section
 * and how many rules it has. Enough to place a new rule without paging a document
 * too big to read whole, and small enough to inline.
 *
 * @param {string} markdown - The guide content.
 * @returns {string} The index, or "" for an empty document.
 */
function buildStyleIndex(markdown) {
  const sections = parseStyleSections(markdown);
  if (sections.length === 0) return "";
  const body = sections.map((s) => `- ${s.name}`).join("\n");
  const rules = countStyleRules(markdown);
  return `${body}\n(${rules} bullet rule(s) across ${sections.length} section(s).)`.trim();
}

/**
 * Compare two style-guide snapshots and report what the newer one LOST.
 *
 * The unit is the category section, because that is the part this document
 * specifies exactly. A missing category means every rule inside it is gone.
 *
 * @param {string} previousMarkdown - The previous volume's guide content.
 * @param {string} currentMarkdown - The guide just produced for this volume.
 * @returns {{previousCount: number, currentCount: number, missing: Array<{name: string}>, added: string[], previousRules: number, currentRules: number}}
 */
function compareStyleCarryForward(previousMarkdown, currentMarkdown) {
  const previous = parseStyleSections(previousMarkdown);
  const current = parseStyleSections(currentMarkdown);
  const currentNames = new Set(current.map((s) => s.name));
  const previousNames = new Set(previous.map((s) => s.name));
  const missing = previous.filter((s) => !currentNames.has(s.name));
  const added = current.filter((s) => !previousNames.has(s.name)).map((s) => s.name);
  return {
    previousCount: previous.length,
    currentCount: current.length,
    missing,
    added,
    previousRules: countStyleRules(previousMarkdown),
    currentRules: countStyleRules(currentMarkdown),
  };
}

/**
 * The carry-forward gate for the style guide: after a pass, check that this
 * volume's guide still holds every category section the previous volume's held.
 *
 * Deliberately narrower than the glossary's and character-voice's gates: a style
 * guide's content is free prose, and a guard that compares prose calls an
 * improvement a loss. What it CAN check honestly is the section set the prompt
 * specifies — a guide missing "Address & Honorifics" has lost everything in it.
 * A drop in the rule count is reported, not failed, for the same reason.
 *
 * @param {StyleGuideVolumeCtx} ctx - The volume context.
 * @param {string} [stageLabel] - Which pass produced the guide.
 * @returns {Promise<void>}
 * @throws {Error} When category sections disappeared (unless the guard is
 *   disabled with STYLE_CARRY_FORWARD_GUARD=false).
 */
async function assertStyleCarryForward(ctx, stageLabel = "the compile pass") {
  const { values, isFirst, previousStyleGuideFile } = ctx;
  if (isFirst || !previousStyleGuideFile) return;
  if (!readBoolEnv("STYLE_CARRY_FORWARD_GUARD", true)) return;

  let previousText;
  try {
    previousText = await fs.readFile(previousStyleGuideFile, "utf8");
  } catch (err) {
    console.warn(`Volume ${values.INSTALLMENT_NUMBER}: carry-forward check skipped (${err.message}).`);
    return;
  }
  await guardStyleCarryForwardAgainst(ctx, previousText, stageLabel, "the previous volume's style guide");
}

/**
 * The same gate against an arbitrary baseline — the previous volume's guide, or
 * this volume's own guide as of the previous chapter (chunked mode).
 *
 * @param {StyleGuideVolumeCtx} ctx - The volume context.
 * @param {string} baselineText - The document the newer one must not shrink.
 * @param {string} stageLabel - Which pass produced the newer snapshot.
 * @param {string} baselineLabel - What the older snapshot was.
 * @returns {Promise<void>}
 * @throws {Error} When category sections disappeared.
 */
async function guardStyleCarryForwardAgainst(ctx, baselineText, stageLabel, baselineLabel) {
  if (!readBoolEnv("STYLE_CARRY_FORWARD_GUARD", true)) return;
  const { values, styleOutputFile } = ctx;

  let currentText;
  try {
    currentText = await fs.readFile(styleOutputFile, "utf8");
  } catch (err) {
    console.warn(`Volume ${values.INSTALLMENT_NUMBER}: carry-forward check skipped (${err.message}).`);
    return;
  }

  const diff = compareStyleCarryForward(baselineText, currentText);
  if (diff.missing.length === 0) {
    const ruleNote =
      diff.currentRules < diff.previousRules
        ? `, ${diff.previousRules - diff.currentRules} fewer bullet rule(s) — reported, not failed`
        : "";
    console.log(
      `Volume ${values.INSTALLMENT_NUMBER}: carry-forward check passed ` +
        `(${diff.previousCount} section(s) carried, ${diff.added.length} added, ` +
        `${diff.currentRules} rule(s)${ruleNote}).`
    );
    return;
  }

  const quarantineFile = `${styleOutputFile}.rejected`;
  try {
    await fs.rename(styleOutputFile, quarantineFile);
    console.error(
      `Volume ${values.INSTALLMENT_NUMBER}: moved the damaged style guide (${diff.currentCount} of ` +
        `${diff.previousCount} sections) to "${path.basename(quarantineFile)}" so the next volume ` +
        `cannot build on it. Re-running this volume starts from ../${ctx.previousFolderName}/style-guide.md.`
    );
  } catch (err) {
    console.warn(
      `Volume ${values.INSTALLMENT_NUMBER}: could not move the damaged guide aside (${err.message}) ` +
        `— it is still a failure, but the next volume may read it.`
    );
  }

  throw new Error(
    `Volume ${values.INSTALLMENT_NUMBER}: ${stageLabel} dropped style-guide section(s) that ` +
      `${baselineLabel} held — ${diff.missing.map((s) => s.name).join(", ")}. The guide is ` +
      `cumulative: every later volume is built on it, and its copy has been moved to ` +
      `"${path.basename(quarantineFile)}" so no later volume can read a partial one. Amend ` +
      `"style-guide.md" in place with editFile instead of rewriting it (see ` +
      `styleWriteInstruction), or set STYLE_CARRY_FORWARD_GUARD=false to allow a shrinking guide.`
  );
}

/**
 * The "what the guide already holds" block for a style-guide agent turn.
 * @param {StyleGuideVolumeCtx} ctx - The volume context; `styleIndex` is set by
 *   seedStyleGuideFromPrevious.
 * @returns {string} The block, or "" when there is no index. Ends with a blank line.
 */
function styleIndexBlock(ctx) {
  if (!ctx.styleIndex) return "";
  return (
    `What "style-guide.md" already holds, by section:\n` +
    `${ctx.styleIndex}\n\n` +
    `Use this to choose the section a new rule belongs in. It is an index, not the document: ` +
    `read the rules you are about to change before changing them.\n\n`
  );
}

/**
 * The write instruction for a style-guide pass — shared by the compile and
 * feedback passes, whole and per-chapter. See voiceWriteInstruction /
 * glossaryWriteInstruction: the cumulative document is edited IN PLACE, and the
 * whole-file write is only for a file that does not exist yet.
 *
 * @param {boolean} hasExistingFile - Whether "style-guide.md" already holds the
 *   document to change.
 * @param {"amend"|"correct"} [mode] - "amend" adds rules; "correct" applies a report.
 * @returns {string} The instruction block, ending with a blank line.
 */
function styleWriteInstruction(hasExistingFile, mode = "amend") {
  const doVerb = mode === "correct" ? "Correct" : "Amend";
  if (!hasExistingFile) {
    return (
      `How to write it: the file "style-guide.md" in your working folder does not exist yet, ` +
      `so write the complete guide to it with writeFile (complete contents), in the exact ` +
      `section format from the system prompt.\n\n`
    );
  }
  return (
    `How to write it — "style-guide.md" in your working folder ALREADY holds the guide as of ` +
    `the step before this one (the workflow put the current version of it there). ` +
    `${doVerb} it IN PLACE with editFile:\n\n` +
    `- Add each new rule as ONE new bullet inside the right existing section.\n` +
    `- Replace an existing rule only when the source text shows it is wrong, and keep the rest ` +
    `of its section.\n` +
    `- Add to the "Open Questions" section rather than guessing an undecidable construct.\n` +
    `- Update the "current through volume" header line.\n\n` +
    `Do NOT rewrite the whole file with writeFile. This guide is larger than one reply can ` +
    `produce, and a write cut off part-way destroys every rule it did not reach. Never delete a ` +
    `section, and never retype a rule you have not just read — rules that fall out of this file ` +
    `are lost from every later volume.\n\n` +
    `Work in priority order, and write as you go: apply the HIGH-severity findings first with ` +
    `editFile, then MEDIUM, then LOW. A turn that runs out of steps having changed nothing ` +
    `produced nothing; one that applied the important fixes first produced a better guide even ` +
    `if it never reached the minor ones.\n\n`
  );
}

/**
 * The recovery turn for a style-guide pass that answered in chat instead of using
 * the file tools. It edits, because demanding a whole-file rewrite of a document
 * larger than one reply is how a recovery turn destroys what it was sent to fix.
 *
 * @param {boolean} hasContent - Whether the agent produced content in its chat reply.
 * @param {boolean} hasExistingFile - Whether "style-guide.md" is the seeded guide.
 * @returns {string} The recovery prompt.
 */
function styleRecoveryPrompt(hasContent, hasExistingFile) {
  const guidePart = hasExistingFile
    ? `Apply your changes to "style-guide.md" with editFile — add each new rule as a bullet in ` +
      `the right section and edit existing rules in place. Do NOT rewrite "style-guide.md" from ` +
      `scratch with writeFile: every section and rule that is in it now must still be there when ` +
      `you finish.`
    : `Write the complete style guide to "style-guide.md" with writeFile.`;
  if (hasContent) {
    return `You produced your answer as a chat message instead of changing the file.\n\n${guidePart}\n\nRead "style-guide.md" before editing it.`;
  }
  return `You produced no output. Read the materials, then: ${guidePart}`;
}

/**
 * The step cap for this stage's author / feedback agent on this volume or chapter
 * (see authorMaxStepsFor — a flat 30 is what stopped the sibling stage's feedback
 * turn at 46 tool calls with zero writes).
 *
 * @param {StyleGuideVolumeCtx} ctx - The volume context.
 * @param {SourceSegment|null} [seg] - The chapter being processed (chunked mode).
 * @returns {Promise<number>} The step cap.
 */
async function styleAuthorMaxSteps(ctx, seg = null) {
  const sizeOf = async (p) => {
    try {
      return (await fs.stat(p)).size;
    } catch {
      return 0;
    }
  };
  const artifactBytes = await sizeOf(ctx.styleOutputFile);
  const sourceBytes = seg
    ? await sizeOf(path.join(ctx.volumeDir, seg.file))
    : await sizeOf(ctx.sourceFile);
  return authorMaxStepsFor(artifactBytes, sourceBytes);
}

/**
 * Parse the AI's extraction output into an array of style-construct entries.
 * @param {string} output - The raw AI output.
 * @returns {Array<Object>}
 */
function parseStyleObservations(output) {
  if (!output || typeof output !== "string") return [];
  let text = output.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) text = fenceMatch[1].trim();
  const firstBracket = text.indexOf("[");
  const lastBracket = text.lastIndexOf("]");
  if (firstBracket === -1 || lastBracket === -1 || lastBracket < firstBracket) {
    throw new Error("No JSON array found in the style-guide extraction output.");
  }
  const parsed = JSON.parse(text.slice(firstBracket, lastBracket + 1));
  if (!Array.isArray(parsed)) {
    throw new Error("The style-guide extraction output was not a JSON array.");
  }
  return parsed.filter((entry) => entry && typeof entry.category === "string");
}

/**
 * Build the extraction turn prompt for a single volume.
 * @param {StyleGuideVolumeCtx} ctx
 * @returns {string}
 */
function buildExtractTurnPrompt(ctx) {
  return transformUserPrompt(ctx.extractUserPrompt, ctx.values);
}

/**
 * Build the author (compile) turn prompt for a single volume.
 *
 * The preamble names every material at its real path: the previous volume's
 * guide lives in the previous volume's folder
 * (`../<previous folder>/style-guide.md`) — the same convention as
 * character-voice.js — so the agent never has to guess where to read.
 * With `seg` set (chunked fallback) the pass is scoped to one chapter.
 *
 * @param {StyleGuideVolumeCtx} ctx
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
  let previousGuideLine;
  let chapterBlock = "";
  if (seg) {
    sourceLine = `- The chapter source: "${seg.file}" (same folder)`;
    previousGuideLine =
      si === 0
        ? isFirst
          ? "- The previous style guide: (absent — this is the first volume)"
          : `- The previous style guide: "../${previousFolderName}/style-guide.md"`
        : `- The current style guide (state after the earlier chapters of this volume): "style-guide.md" (same folder)`;
    chapterBlock = chapterContextBlock(ctx.values, ctx.bundle, seg, si);
  } else {
    sourceLine = ctx.bundle
      ? sourceMaterialLine(ctx.bundle)
      : `- The volume source: "${path.basename(ctx.sourceFile)}" (same folder)`;
    previousGuideLine = isFirst
      ? "- The previous style guide: (absent — this is the first volume)"
      : `- The previous style guide: "../${previousFolderName}/style-guide.md"`;
  }
  return (
    `Working folder: the volume folder (you are in it).\n\n` +
    chapterBlock +
    `Materials (read with readFile before writing anything):\n` +
    `${sourceLine}\n` +
    previousGuideLine +
    `\nOptional cross-reference material (read if present in your working folder):\n` +
    `- "glossary.md" — the current glossary snapshot (canonical names)\n` +
    `- "character-voice.md" — the current character voice reference (formality and voice data)\n` +
    `\n` +
    styleIndexBlock(ctx) +
    styleWriteInstruction(Boolean(ctx.styleSeeded), "amend") +
    amendPrompt
  );
}

/**
 * Build the validator turn prompt for a single volume. With `seg` set
 * (chunked fallback) the pass audits ONE chapter and writes a partial report.
 *
 * @param {StyleGuideVolumeCtx} ctx
 * @param {SourceSegment|null} [seg] - The chapter being audited (fallback).
 * @param {number} [si] - Zero-based position in reading order.
 * @returns {string}
 */
function buildValidatorTurnPrompt(ctx, seg = null, si = null) {
  const { isFirst, previousFolderName } = ctx;
  const previousGuideLine = isFirst
    ? ""
    : `- The previous style guide: "../${previousFolderName}/style-guide.md"\n`;
  const reportFile = seg ? `style-guide-validation-${seg.id}.md` : "style-guide-validation.md";
  let sourceLine;
  let chapterBlock = "";
  if (seg) {
    sourceLine = `- The chapter source: "${seg.file}" (same folder)`;
    chapterBlock =
      chapterContextBlock(ctx.values, ctx.bundle, seg, si) +
      `This is a per-chapter validation pass: audit the style guide against ONE chapter only. ` +
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
    `- The amended style guide under audit: "style-guide.md" (same folder)\n` +
    previousGuideLine +
    `\n` +
    `Write the complete validation report to the file "${reportFile}" in your working folder (writeFile, exact format from the system prompt).\n\n` +
    transformUserPrompt(ctx.validatorUserPrompt, ctx.values)
  );
}

/**
 * Build the feedback turn prompt for a single volume. With `seg` set
 * (chunked fallback) the pass applies the chapter-tagged findings only.
 *
 * @param {StyleGuideVolumeCtx} ctx
 * @param {SourceSegment|null} [seg] - The chapter whose findings are applied (fallback).
 * @param {number} [si] - Zero-based position in reading order.
 * @returns {string}
 */
function buildFeedbackTurnPrompt(ctx, seg = null, si = null) {
  const { isFirst, previousFolderName } = ctx;
  const previousGuideLine = isFirst
    ? ""
    : `- The previous style guide: "../${previousFolderName}/style-guide.md"\n`;
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
    `The validation report "style-guide-validation.md" in your working folder is your work order${scopeLine}.\n` +
    `Materials (read with readFile before changing anything):\n` +
    `${sourceLine}\n` +
    `- The current style guide to correct: "style-guide.md" (same folder)\n` +
    previousGuideLine +
    `\n` +
    styleIndexBlock(ctx) +
    styleWriteInstruction(true, "correct") +
    `Verifying the report's findings against the source is part of the job, but it is not the ` +
    `job. The report already quotes the source lines it is complaining about, so:\n` +
    `- Check a batch of findings with ONE grep (its pattern may be several phrases separated by ` +
    `|) instead of one search per finding, and read the quoted line ranges in as few readFile ` +
    `calls as the layout allows.\n` +
    `- Apply each fix with editFile as soon as it is confirmed. Do not verify everything first ` +
    `and then start editing: if you run out of steps, the fixes you already applied still stand.\n` +
    `- If a finding cannot be confirmed from the source, say so in your final summary and leave ` +
    `that rule alone rather than spending more steps on it.\n\n` +
    transformUserPrompt(ctx.feedbackUserPrompt, ctx.values)
  );
}

/**
 * The findings-merge turn prompt (chunked fallback): consolidates the
 * per-chapter partial reports into the standard style-guide-validation.md so
 * the unchanged acceptance one-shot can score it.
 *
 * @param {StyleGuideVolumeCtx} ctx
 * @returns {string}
 */
function buildStyleFindingsMergePrompt(ctx) {
  const list = ctx.bundle.segments
    .map((s) => `- "style-guide-validation-${s.id}.md" (chapter ${s.id})`)
    .join("\n");
  return (
    `Working folder: the volume folder (you are in it).\n\n` +
    `You are consolidating the per-chapter validation partials of volume ` +
    `${ctx.values.INSTALLMENT_NUMBER} into the single standard validation report.\n` +
    `Materials (read with readFile before writing anything):\n` +
    list +
    `\n\n` +
    `Write the consolidated report to the file "style-guide-validation.md" in your ` +
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
 * The gulp task entry point for the style-guide workflow.
 */
async function styleGuide() {
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
  console.log("style-guide task starting...");
  validateRequiredEnv({ dryRun });
  // --force here means "redo THIS stage" — it does NOT re-run the intake (see getTranslationTarget).
  const manifest = await getTranslationTarget({ dryRun });
  // Series name + languages: .env override > the intake manifest's decision >
  // the default (see resolveRunSettings in configs/shared.js).
  const runSettings = resolveRunSettings(manifest);
  // Use the module-level seriesDir (SERIES_LOCATION) — NOT manifest.seriesLocation.
  // That field is provenance metadata from the machine that generated the
  // manifest: after a Windows→Linux migration the cached "C:\..." path is not
  // absolute, and every file op would silently resolve relative to the CWD.
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
    const volumeLabel = `Volume ${volume.installmentNumber}`;
    const styleOutputFile = path.join(volumeDir, "style-guide.md");
    const validationOutputFile = path.join(volumeDir, "style-guide-validation.md");
    // The previous volume's guide (the in-progress guide). Absent for the
    // first volume. The agent-mode turn prompts name it at its real relative
    // path (../<previous folder>/style-guide.md) — the same convention as
    // character-voice.js.
    const isFirst = i === 0;
    let previousStyleGuideFile = null;
    let previousFolderName = null;
    if (!isFirst) {
      previousFolderName = sorted[i - 1];
      previousStyleGuideFile = path.join(seriesDir, previousFolderName, "style-guide.md");
      if (!(await fileExists(previousStyleGuideFile))) {
        if (dryRun) {
          console.warn(
            `Volume ${values.INSTALLMENT_NUMBER}: --dry-run: the previous style guide ` +
              `(${previousStyleGuideFile}) does not exist yet — a live run would stop ` +
              `here. Continuing the prompt preview.`
          );
        } else if (ON_MISSING_PREVIOUS === "skip") {
          console.log(
            `Volume ${values.INSTALLMENT_NUMBER}: previous style guide not found ` +
              `(${previousStyleGuideFile}) — skipping this volume ` +
              `(ON_MISSING_PREVIOUS=skip).`
          );
          continue;
        } else {
          throw new Error(
            `Previous style guide not found: ${previousStyleGuideFile}. ` +
              `Process the earlier volume first (or re-run without --force), ` +
              `or set ON_MISSING_PREVIOUS=skip to skip this volume.`
          );
        }
      }
    }
    // Whole-installment vs chapter-by-chapter, decided against THIS stage's
    // model window and the reference it will actually inject (the previous
    // volume's cumulative guide — decided per volume because it grows every
    // volume). See planProcessingMode in utils/source.js.
    const mode = await decideProcessingMode({
      bundle,
      label: volumeLabel,
      previousArtifactFiles: previousStyleGuideFile ? [previousStyleGuideFile] : [],
      forceChunked: chunkedArg,
      dryRun,
    });
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
    const ctx = { values, folderName, volumeDir, sourceFile, bundle, chunked: mode.chunked, styleOutputFile, validationOutputFile, isFirst, previousFolderName, previousStyleGuideFile, extractPrompt, validatorPrompt, feedbackPrompt, acceptancePrompt, extractTemplate, authorTemplate, extractSystemPrompt, authorSystemPrompt, validatorSystemPrompt, acceptanceSystemPrompt, feedbackSystemPrompt, authorUserPrompt: authorTemplate, validatorUserPrompt: validatorTemplate, feedbackUserPrompt: feedbackTemplate };

    if (dryRun) {
      // Preview the instruction a live run would give: the live run seeds
      // style-guide.md from the previous volume whenever there is one.
      ctx.styleSeeded = !isFirst && Boolean(previousStyleGuideFile) && (await fileExists(previousStyleGuideFile));
      // …and it shows the section map that copy produces (see the same note in
      // glossary.js and character-voice.js).
      ctx.styleIndex = ctx.styleSeeded
        ? buildStyleIndex(await fs.readFile(previousStyleGuideFile, "utf8").catch(() => ""))
        : "";
      const illustrative = JSON.stringify([{ category: "honorific", pattern: "ex", description: "ex", examples: ["ex"], frequency: "high", notes: "ex" }]);
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
          { title: "CHUNKED — findings merge turn", prompt: buildStyleFindingsMergePrompt(ctx) },
          { title: "CHUNKED — segment feedback turn (first chapter)", prompt: buildFeedbackTurnPrompt(ctx, seg, 0) }
        );
      }
      const dumpFile = await writePromptDump("style-guide", values.INSTALLMENT_NUMBER, "agent", sections);
      console.log(`Volume ${values.INSTALLMENT_NUMBER}: --dry-run: prompts dumped to ${dumpFile}`);
      continue;
    }
    let skip = false;
    if (!force && !regeneratedAny && (await fileExists(styleOutputFile))) {
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
    if (skip) { console.log(`Volume ${values.INSTALLMENT_NUMBER}: style guide already exists and passed. Skipping.`); continue; }
    regeneratedAny = true;
    await runVolumeWithModeFallback({
      label: volumeLabel,
      ctx,
      volumeDir,
      run: () => runVolume(ctx),
      attemptFiles: [
        "style-guide.md",
        "style-guide-new.json",
        "style-guide-validation.md",
        "style-guide-validation-rolling-state.json",
      ],
      attemptGlob: /^style-guide-.*\.md$/,
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
  if (volumeArg || dryRun) {
    console.log(volumeArg ? "\n--volume: skipping the series-root copy." : "\n--dry-run: skipping the series-root copy (dry runs make no file writes).");
  }
  else {
    const finalStyleFile = seriesArtifactFile("style-guide.md", "STYLE_OUTPUT_FILE", seriesDir);
    let lastStyle = null;
    for (let i = sorted.length - 1; i >= 0; i--) {
      const candidate = path.join(seriesDir, sorted[i], "style-guide.md");
      // Last REAL, PUBLISHABLE snapshot: an empty or stubbed one left by a failed
      // volume is not the series' current style guide, and neither is a file that
      // is not a document at all (gotcha 58).
      if (await isPublishableArtifact(candidate, "style guide")) { lastStyle = candidate; break; }
    }
    if (lastStyle) { await fs.copyFile(lastStyle, finalStyleFile); await writeProvenanceSidecar(finalStyleFile, lastStyle); console.log(`\nCopied the final style guide to: ${finalStyleFile}`); }
    else { console.log("\nNo style guide snapshots found; nothing to copy."); }
  }

  // A task that failed volumes fails the run (see configs/shared.js
  // volumeFailureError): the summary used to be printed and the task exited 0.
  const volumeError = volumeFailureError("style-guide", failedVolumes, volumes.length);
  if (volumeError) throw volumeError;
}


// The "model emitted tool-call syntax as plain text" guard (emittedToolCallAsText
// + assertRealToolCalls) is shared by every file-writing task — see
// utils/agents.js (AGENTS.md gotcha 18).

/**
 * Run the extraction stage: one-shot call to extract style-relevant constructs.
 * With `seg` set (chunked fallback) the extraction is scoped to one chapter:
 * the source message is the chapter file and the cumulative reference is the
 * previous volume's guide (first chapter) or the current in-volume state.
 *
 * @param {StyleGuideVolumeCtx} ctx
 * @param {SourceSegment|null} [seg] - The chapter being extracted (fallback).
 * @param {number} [si] - Zero-based position in reading order.
 * @returns {Promise<string>}
 */
async function runExtract(ctx, seg = null, si = null) {
  const { values } = ctx;
  const labelSuffix = seg ? `-${seg.id}` : "";
  if (seg) {
    console.log(`Volume ${values.INSTALLMENT_NUMBER}: running style-convention extraction for chapter ${seg.id}...`);
    const messages = [{ file: path.join(ctx.volumeDir, seg.file), name: seg.file }];
    const stateFile = si === 0 ? ctx.previousStyleGuideFile : ctx.styleOutputFile;
    if (stateFile) {
      // Inlined (not readFile) — so the cumulative guide is bounded here, and
      // bounded by RELEVANCE: a policy whose quoted pattern occurs in this
      // chapter is shown whatever section order it happens to sit in.
      const chapterSource = await fs.readFile(path.join(ctx.volumeDir, seg.file), "utf8");
      messages.push(
        await inlineReferenceMessage(
          stateFile,
          si === 0 ? "style-guide-previous.md" : "style-guide-current.md",
          { truncate: (raw) => truncateStyleGuide(raw, chapterSource) }
        )
      );
    }
    messages.push({ text: ctx.extractPrompt }, { text: chapterSegmentNote(ctx.bundle, seg, si) });
    return harness.runOneShot({ systemPrompt: ctx.extractSystemPrompt, messages, label: `style-guide-extract-${values.INSTALLMENT_NUMBER}${labelSuffix}` });
  }
  const { sourceFile } = ctx;
  console.log(`Volume ${values.INSTALLMENT_NUMBER}: running style-convention extraction...`);
  const messages = [{ file: sourceFile, name: path.basename(sourceFile) }, { text: ctx.extractPrompt }];
  if (ctx.previousStyleGuideFile) {
    const volumeSourceText = await fs.readFile(sourceFile, "utf8");
    messages.push(
      await inlineReferenceMessage(ctx.previousStyleGuideFile, "style-guide-previous.md", {
        truncate: (raw) => truncateStyleGuide(raw, volumeSourceText),
      })
    );
  }
  return harness.runOneShot({ systemPrompt: ctx.extractSystemPrompt, messages, label: `style-guide-extract-${values.INSTALLMENT_NUMBER}` });
}


/**
 * Run the compile stage: author agent writes style-guide.md. With `seg` set
 * (chunked fallback) the pass is scoped to one chapter.
 * @param {StyleGuideVolumeCtx} ctx
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
    parsed = parseStyleObservations(extractionOutput);
    extractionResults = JSON.stringify(parsed, null, 2);
  } catch (err) {
    console.warn(`Volume ${values.INSTALLMENT_NUMBER}: extraction parse failed: ${err.message}. Using raw output.`);
    extractionResults = extractionOutput;
  }
  console.log(`Volume ${values.INSTALLMENT_NUMBER}: running style-guide compilation${seg ? ` for chapter ${seg.id}` : ""}...`);
  const author = await harness.createAgentHandle({ name: `author-style-${values.INSTALLMENT_NUMBER}${labelSuffix}`, systemPrompt: buildAuthorSystemPrompt(authorSystemPrompt), tools: ctx.fsGate.tools, approve: ctx.fsGate.approve, cwd: ctx.volumeDir, maxSteps: await styleAuthorMaxSteps(ctx, seg) });
  try {
    const compileResult = await author.sendTurn(buildAuthorTurnPrompt(ctx, extractionResults, seg, si), { label: `style-guide-compile-${values.INSTALLMENT_NUMBER}${labelSuffix}` });
    assertRealToolCalls(compileResult, `the author agent (compile${seg ? `, chapter ${seg.id}` : ""})`, values.INSTALLMENT_NUMBER);
    const compileFallbackUsed = await assertWroteWithFallback(ctx.styleOutputFile, `the author agent (compile${seg ? `, chapter ${seg.id}` : ""})`, compileResult?.text);
    // Recovery turn: ONLY when the file was actually missing after the
    // fallback — never over a file the agent already wrote correctly.
    if (compileFallbackUsed && process.env.AGENT_RECOVERY_ENABLED !== "false") {
      const hasContent = compileResult?.text && compileResult.text.trim().length > 0;
      const recoveryResult = await author.sendTurn(styleRecoveryPrompt(hasContent, Boolean(ctx.styleSeeded)), { label: `style-guide-compile-recovery-${values.INSTALLMENT_NUMBER}${labelSuffix}` });
      assertRealToolCalls(recoveryResult, `the author agent (compile recovery${seg ? `, chapter ${seg.id}` : ""})`, values.INSTALLMENT_NUMBER);
      await assertWroteWithFallback(ctx.styleOutputFile, `the author agent (compile recovery${seg ? `, chapter ${seg.id}` : ""})`, recoveryResult?.text);
    }
    // Hard stop: the recovery turn is the last chance — a still-missing,
    // empty or stubbed guide is a failure, not an output.
    await assertRealOutput(ctx.styleOutputFile, `the author agent (compile${seg ? `, chapter ${seg.id}` : ""})`);
    console.log(`Volume ${values.INSTALLMENT_NUMBER}: saved style guide to ${ctx.styleOutputFile}${seg ? ` (after chapter ${seg.id})` : ""}`);
  } finally { await author.close(); }
}


/**
 * QA loop: validator -> acceptance -> feedback (the shared loop in
 * utils/qa-loop.js — this wrapper supplies the style-guide-specific
 * pieces: validator naming/prompts, the acceptance check, the feedback
 * stage, and the log lines).
 * @param {StyleGuideVolumeCtx} ctx
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
    createValidatorAgent: async (iteration) => harness.createAgentHandle({ name: `validator-style-${values.INSTALLMENT_NUMBER}-${iteration}`, systemPrompt: ctx.validatorSystemPrompt + AGENT_TOOLS_NOTE, tools: fsGate.tools, approve: fsGate.approve, cwd: volumeDir, maxSteps: validatorMaxStepsFor((await fs.stat(sourceFile)).size) }),
    buildValidatorTurn: (iteration) => buildValidatorTurnPrompt(ctx),
    validatorLabel: (iteration) => `style-guide-validate-${values.INSTALLMENT_NUMBER}-${iteration}`,
    validatorRecoveryLabel: (iteration) => `style-guide-validate-recovery-${values.INSTALLMENT_NUMBER}-${iteration}`,
    validatorRecoveryPrompt: (hasContent) => hasContent ? `You were asked to write "style-guide-validation.md" using writeFile, but you replied in chat. Please rewrite the report using writeFile now with the same content.` : `You produced no output. Please write the validation report to "style-guide-validation.md" using writeFile now.`,
    assertRealToolCalls: (result, who) => assertRealToolCalls(result, who, values.INSTALLMENT_NUMBER),
    acceptanceLogLine: () => "Calling the AI for the acceptance check...",
    acceptanceCheck: (iteration) => acceptanceCheck(ctx, iteration),
    // Exceptional-score confirmation re-grades (see utils/qa-loop.js).
    confirmationCheck: ({ index, temperature }) => acceptanceCheck(ctx, `confirm${index + 1}`, temperature),
    feedbackLogLine: () => "Calling the AI to apply the validation feedback (author agent)...",
    runFeedback: (iteration) => runFeedback(ctx),
    // The loop stops when a feedback pass leaves this byte-identical: a turn
    // that only read is not an iteration (see fingerprintFiles in utils/fs.js).
    feedbackArtifactFiles: [ctx.styleOutputFile],
    limitReachedLogLine: () => `Volume ${values.INSTALLMENT_NUMBER}: reached the validation iteration limit (${maxValidationIterations}) without a passing grade.`,
  });
  ctx.limitReached = result.limitReached;
  return result;
}


/**
 * Run the feedback stage: fresh author agent applies validation feedback.
 * With `seg` set (chunked fallback) the pass applies the chapter-tagged
 * findings only.
 * @param {StyleGuideVolumeCtx} ctx
 * @param {SourceSegment|null} [seg] - The chapter whose findings are applied (fallback).
 * @param {number} [si] - Zero-based position in reading order.
 */
async function runFeedback(ctx, seg = null, si = null) {
  const { values, volumeDir, fsGate } = ctx;
  const labelSuffix = seg ? `-${seg.id}` : "";
  const author = await harness.createAgentHandle({ name: `author-style-feedback-${values.INSTALLMENT_NUMBER}${labelSuffix}`, systemPrompt: ctx.feedbackSystemPrompt + AGENT_TOOLS_NOTE, tools: fsGate.tools, approve: fsGate.approve, cwd: volumeDir, maxSteps: await styleAuthorMaxSteps(ctx, seg) });
  try {
    const feedbackResult = await author.sendTurn(buildFeedbackTurnPrompt(ctx, seg, si), { label: `style-guide-feedback-${values.INSTALLMENT_NUMBER}${labelSuffix}` });
    assertRealToolCalls(feedbackResult, `the author agent (feedback pass${seg ? `, chapter ${seg.id}` : ""})`, values.INSTALLMENT_NUMBER);
    const feedbackFallbackUsed = await assertWroteWithFallback(ctx.styleOutputFile, `the author agent (feedback pass${seg ? `, chapter ${seg.id}` : ""})`, feedbackResult?.text);
    // Recovery turn: ONLY when the file was actually missing after the
    // fallback — never over a file the agent already wrote correctly.
    if (feedbackFallbackUsed && process.env.AGENT_RECOVERY_ENABLED !== "false") {
      const hasContent = feedbackResult?.text && feedbackResult.text.trim().length > 0;
      const recoveryResult = await author.sendTurn(styleRecoveryPrompt(hasContent, true), { label: `style-guide-feedback-recovery-${values.INSTALLMENT_NUMBER}${labelSuffix}` });
      assertRealToolCalls(recoveryResult, `the author agent (feedback recovery${seg ? `, chapter ${seg.id}` : ""})`, values.INSTALLMENT_NUMBER);
      await assertWroteWithFallback(ctx.styleOutputFile, `the author agent (feedback recovery${seg ? `, chapter ${seg.id}` : ""})`, recoveryResult?.text);
    }
    await assertRealOutput(ctx.styleOutputFile, `the author agent (feedback pass${seg ? `, chapter ${seg.id}` : ""})`);
    // The cumulative invariant, re-checked after every rewrite: a feedback pass
    // that rewrote the guide from memory is how sections disappear from it.
    await assertStyleCarryForward(ctx, "the feedback pass");
  } finally { await author.close(); }
}

/**
 * Shared acceptance check: always a tool-less single-shot call.
 * The model sees the style guide ITSELF plus its validation report (the
 * report is a guide, not the source of truth) and scores it 0–100
 * (100 = perfect, 0 = atrocious) as a JSON reply {score, band, note};
 * the score — not a binary verdict — is what the rolling window tracks.
 * @param {StyleGuideVolumeCtx} ctx
 * @param {number} iteration
 * @returns {Promise<number | null>} The parsed score (0–100), or `null`
 *   when no valid score could be extracted (treated as a failed check).
 */
async function acceptanceCheck(ctx, iteration, temperature) {
  const { values, validationOutputFile, acceptancePrompt, acceptanceSystemPrompt, styleOutputFile } = ctx;
  const acceptanceOutput = await harness.runOneShot({ systemPrompt: acceptanceSystemPrompt, messages: [{ file: styleOutputFile, name: "style-guide.md" }, { file: validationOutputFile, name: "style-guide-validation.md" }, { text: acceptancePrompt }], temperature: temperature ?? judgeTemperature(), ...judgeThinking("ACCEPTANCE"), label: `style-guide-acceptance-${values.INSTALLMENT_NUMBER}-${iteration}` });
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
 * chained so each chapter builds on the previous one's guide state. The QA
 * loop then validates the finished volume chapter by chapter (per-chapter
 * partial reports → findings merge → acceptance) with per-chapter feedback.
 *
 * @param {StyleGuideVolumeCtx} ctx - The volume context (must include bundle).
 */
async function runChunkedVolume(ctx) {
  const { values, bundle } = ctx;
  console.log(
    `Volume ${values.INSTALLMENT_NUMBER}: chapter-by-chapter fallback ` +
      `(${bundle.segments.length} segments, ${bundle.wholeChars} chars whole)...`
  );
  // Create fsGate BEFORE any compile so the author agent has file tools.
  const fsGate = await harness.createGatedFsTools({ cwd: ctx.volumeDir, allowedDirs: [ctx.volumeDir] });
  ctx.fsGate = fsGate;
  // Same rule as whole mode: the previous volume's guide is copied in first, so
  // each chapter's compile pass amends the current state instead of reproducing it.
  await seedStyleGuideFromPrevious(ctx);
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
      chunkedExtractions.push(...parseStyleObservations(extractionOutput));
    } catch {
      // Unparseable chapter output — runCompile falls back to the raw text;
      // nothing structured to persist for this chapter.
    }
    // The baseline this chapter must not shrink below: the guide as of the
    // previous chapter (or the previous volume's, for chapter 0).
    const chapterBaseline = await fs.readFile(ctx.styleOutputFile, "utf8").catch(() => null);
    try {
      await runCompile(ctx, extractionOutput, segment, si);
    } catch (err) {
      console.error(`Volume ${values.INSTALLMENT_NUMBER}: compilation failed for chapter ${segment.id}: ${err.message}. Check .logs/ for details.`);
      throw err;
    }
    if (chapterBaseline !== null) {
      await guardStyleCarryForwardAgainst(ctx, chapterBaseline, `the compile pass (chapter ${segment.id})`, "the guide as of the previous chapter");
    }
  }
  // Persist the volume's extraction results (the new style constructs) so
  // the translation handoff (utils/handoff.js) can render a "what's new in
  // this volume" section without re-calling the AI.
  try {
    await fs.writeFile(path.join(ctx.volumeDir, "style-guide-new.json"), JSON.stringify(chunkedExtractions, null, 2) + "\n", "utf8");
  } catch (err) {
    console.warn(`Volume ${values.INSTALLMENT_NUMBER}: could not persist style-guide-new.json (${err.message}) — continuing.`);
  }
  await runChunkedQaLoop(ctx);
}

/**
 * Chunked (fallback) QA loop: per-chapter validator passes (fresh agent per
 * chapter) write style-guide-validation-<id>.md partials; a findings-merge
 * agent consolidates them into the standard style-guide-validation.md; the
 * unchanged acceptance one-shot scores it; on a failed window, per-chapter
 * feedback applies the chapter-tagged findings.
 *
 * @param {StyleGuideVolumeCtx} ctx - The volume context (must include ctx.fsGate).
 */
async function runChunkedQaLoop(ctx) {
  const { values, bundle, volumeDir, validationOutputFile, fsGate } = ctx;
  const recentRollingScores = [];
  for (let iteration = 1; iteration <= maxValidationIterations; iteration++) {
    console.log(`Volume ${values.INSTALLMENT_NUMBER}: validation iteration ${iteration}/${maxValidationIterations} (chapter by chapter)...`);
    // Per-chapter validation partials (fresh agent per chapter).
    for (let si = 0; si < bundle.segments.length; si++) {
      const segment = bundle.segments[si];
      const partialFile = path.join(volumeDir, `style-guide-validation-${segment.id}.md`);
      const validator = await harness.createAgentHandle({ name: `validator-style-${values.INSTALLMENT_NUMBER}-${iteration}-${segment.id}`, systemPrompt: ctx.validatorSystemPrompt + AGENT_TOOLS_NOTE, tools: fsGate.tools, approve: fsGate.approve, cwd: volumeDir, maxSteps: validatorMaxStepsFor((await fs.stat(path.join(volumeDir, segment.file))).size) });
      try {
        const validateResult = await validator.sendTurn(buildValidatorTurnPrompt(ctx, segment, si), { label: `style-guide-validate-${values.INSTALLMENT_NUMBER}-${iteration}-${segment.id}` });
        assertRealToolCalls(validateResult, `the validator agent (chapter ${segment.id})`, values.INSTALLMENT_NUMBER);
        const validateFallbackUsed = await assertWroteWithFallback(partialFile, `the validator agent (chapter ${segment.id})`, validateResult?.text);
        // Recovery turn: ONLY when the partial was actually missing after the
        // fallback — never over a file the agent already wrote correctly.
        if (validateFallbackUsed && process.env.AGENT_RECOVERY_ENABLED !== "false") {
          const hasContent = validateResult?.text && validateResult.text.trim().length > 0;
          const recoveryPrompt = hasContent ? `You were asked to write the validation report to "${path.basename(partialFile)}" using writeFile, but you replied with the content in your chat message instead. Please rewrite the complete report using writeFile now.` : `You produced no output. Please read the materials and write the complete validation report to "${path.basename(partialFile)}" using writeFile now.`;
          const recoveryResult = await validator.sendTurn(recoveryPrompt, { label: `style-guide-validate-recovery-${values.INSTALLMENT_NUMBER}-${iteration}-${segment.id}` });
          assertRealToolCalls(recoveryResult, `the validator agent (recovery, chapter ${segment.id})`, values.INSTALLMENT_NUMBER);
          await assertWroteWithFallback(partialFile, `the validator agent (recovery, chapter ${segment.id})`, recoveryResult?.text);
        }
        await assertRealOutput(partialFile, `the validator agent (chapter ${segment.id})`);
      } finally { await validator.close(); }
    }
    // Findings merge: consolidate the partials into the standard report.
    const merger = await harness.createAgentHandle({ name: `validator-merge-${values.INSTALLMENT_NUMBER}-${iteration}`, systemPrompt: ctx.validatorSystemPrompt + AGENT_TOOLS_NOTE, tools: fsGate.tools, approve: fsGate.approve, cwd: volumeDir, maxSteps: findingsMergeMaxStepsFor(bundle.segments.length, (await fs.stat(ctx.styleOutputFile).catch(() => ({ size: 0 }))).size) });
    try {
      const mergeResult = await merger.sendTurn(buildStyleFindingsMergePrompt(ctx), { label: `style-guide-validate-merge-${values.INSTALLMENT_NUMBER}-${iteration}` });
      assertRealToolCalls(mergeResult, "the findings-merge agent", values.INSTALLMENT_NUMBER);
      await assertWroteWithFallback(validationOutputFile, "the findings-merge agent", mergeResult?.text);
      await assertRealOutput(validationOutputFile, "the findings-merge agent");
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
    // The same exceptional-score confirmation the whole-installment loop runs
    // (utils/qa-loop.js) — a consensus accepts the volume without the per-chapter
    // feedback round below.
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
      console.log(`Volume ${values.INSTALLMENT_NUMBER}: rolling average ${avg.toFixed(1)}/100 (${recentRollingScores.length} checks) meets the passing score ${ACCEPTANCE_PASSING_SCORE}. Accepted.`);
      break;
    }
    // A grade that already passes earns the window's remaining samples by
    // re-grading this guide, not by paying for a per-chapter feedback round plus
    // a second full round of per-chapter validators (see confirmPassingScore).
    const passing = await confirmPassingScore({
      score,
      recentRollingScores,
      confirmationCheck: ({ index, temperature }) => acceptanceCheck(ctx, `confirm${index + 1}`, temperature),
      volumeLabel: `Volume ${values.INSTALLMENT_NUMBER}`,
      stateFile: stateFilePath,
      sourceFingerprint: ctx.bundle ? ctx.bundle.sourceFingerprint : undefined,
    });
    if (passing.accepted) {
      ctx.acceptedBy = "passing-consensus";
      break;
    }
    // Per-chapter feedback (chapter-tagged findings only). Fingerprinted first: a
    // feedback round that changed nothing is not progress, and another iteration
    // would re-audit an unchanged document.
    const beforeFeedback = await fingerprintFiles(ctx.styleOutputFile);
    for (let si = 0; si < bundle.segments.length; si++) {
      await runFeedback(ctx, bundle.segments[si], si);
    }
    if ((await fingerprintFiles(ctx.styleOutputFile)) === beforeFeedback) {
      console.error(
        `Volume ${values.INSTALLMENT_NUMBER}: the per-chapter feedback round changed NOTHING — ` +
          `style-guide.md is byte-identical to what it was before it. Stopping the QA loop here rather ` +
          `than paying for another round of per-chapter validators over an unchanged document. Check the ` +
          `feedback agents' turn logs in .logs/ for turns that only read (the usual shape: step cap ` +
          `reached before anything was written).`
      );
      ctx.limitReached = true;
      await saveRollingState(stateFilePath, recentRollingScores, {
        sourceFingerprint: ctx.bundle ? ctx.bundle.sourceFingerprint : undefined,
        stalled: true,
      });
      if (ON_QA_LIMIT === "fail") {
        throw new Error(
          `Volume ${values.INSTALLMENT_NUMBER}: the feedback round applied nothing (ON_QA_LIMIT=fail).`
        );
      }
      break;
    }
    if (iteration === maxValidationIterations) {
      ctx.limitReached = true;
      console.log(`Volume ${values.INSTALLMENT_NUMBER}: reached the validation iteration limit (${maxValidationIterations}) without a passing grade. The last feedback pass is unvalidated; re-run to validate it.`);
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
 * @param {StyleGuideVolumeCtx} ctx
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
  // Persist the volume's extraction results (the new style constructs) so
  // the translation handoff (utils/handoff.js) can render a "what's new in
  // this volume" section without re-calling the AI.
  try {
    await fs.writeFile(path.join(ctx.volumeDir, "style-guide-new.json"), JSON.stringify(parseStyleObservations(extractionOutput), null, 2) + "\n", "utf8");
  } catch (err) {
    console.warn(`Volume ${values.INSTALLMENT_NUMBER}: could not persist style-guide-new.json (${err.message}) — continuing.`);
  }
  // Create fsGate BEFORE runCompile so the author agent has file tools.
  // createGatedFsTools is async — it must be awaited, otherwise fsGate is a
  // Promise and ctx.fsGate.tools/approve are undefined, so the agents are
  // created with no tools at all.
  const fsGate = await harness.createGatedFsTools({ cwd: ctx.volumeDir, allowedDirs: [ctx.volumeDir] });
  ctx.fsGate = fsGate;
  // The previous volume's guide is copied in BEFORE any agent touches the folder,
  // so the compile pass amends a real file instead of reproducing a document too
  // large for one reply (see seedStyleGuideFromPrevious).
  await seedStyleGuideFromPrevious(ctx);
  try { await runCompile(ctx, extractionOutput); } catch (err) { console.error(`Volume ${values.INSTALLMENT_NUMBER}: compilation failed: ${err.message}. Check .logs/ for details.`); throw err; }
  await assertStyleCarryForward(ctx, "the compile pass");
  await runQaLoop(ctx);
}

// Export
module.exports = { styleGuide, parseStyleObservations, truncateStyleGuide, emittedToolCallAsText, buildExtractTurnPrompt, buildAuthorTurnPrompt, buildValidatorTurnPrompt, buildFeedbackTurnPrompt, buildStyleFindingsMergePrompt, buildExtractSystemPrompt, buildAuthorSystemPrompt, buildValidatorSystemPrompt, runExtract, runCompile, runQaLoop, runFeedback, runChunkedVolume, runChunkedQaLoop, acceptanceCheck, seedStyleGuideFromPrevious, parseStyleSections, countStyleRules, buildStyleIndex, styleIndexBlock, styleWriteInstruction, styleRecoveryPrompt, styleAuthorMaxSteps, compareStyleCarryForward, assertStyleCarryForward, guardStyleCarryForwardAgainst };

