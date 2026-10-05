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
const { transformUserPrompt, parseAcceptanceScore, parseAcceptanceReply, validatorMaxStepsFor, authorMaxStepsFor, findingsMergeMaxStepsFor, writePromptDump, selectSectionsByRelevance } = require("./utils/prompt");
const { getTranslationTarget } = require("./get-translation-target");
const { filterVolumesByInstallment } = require("./utils/manifest");
const { AGENT_TOOLS_NOTE, ACCEPTANCE_WINDOW_SIZE, ACCEPTANCE_PASSING_SCORE, computeRollingAverage, meetsAcceptanceCriteria, isAcceptedState, isSourceStale, saveRollingState, ON_VOLUME_ERROR, ON_MISSING_PREVIOUS, ON_QA_LIMIT, validateRequiredEnv, resolveRunSettings, seriesArtifactFile, judgeTemperature, judgeThinking, isStructuralError, volumeFailureError, readBoolEnv } = require("./configs/shared");
const { fileExists, assertWrote, assertWroteWithFallback, assertRealOutput, writeProvenanceSidecar, inlineReferenceMessage, isPublishableArtifact, fingerprintFiles } = require("./utils/fs");
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
 *
 * "Show the last N sections" was wrong for the same reason it is wrong for the
 * glossary: the sections are one per CHARACTER, and the volume-1 cast sits at the
 * top of the document forever. At volume 17 the extractor was shown a reference
 * with the protagonists missing and rediscovered them as new characters. The
 * selection is now relevance-ordered — every character whose name occurs in the
 * volume being processed is kept, whatever position they hold in the file (see
 * selectSectionsByRelevance in utils/prompt.js).
 *
 * @param {string} content - The full character voice reference content.
 * @param {string} [sourceText] - The volume/chapter source text, used to rank sections.
 * @returns {string}
 */
function truncateVoiceRef(content, sourceText) {
  if (!content || content.length <= VOICE_REF_TRUNCATION_THRESHOLD) return content;
  const picked = selectSectionsByRelevance({
    content,
    headingRe: /^### /m,
    sourceText,
    maxUnits: VOICE_REF_TRUNCATION_MAX_ENTRIES,
    unitLabel: "character section(s)",
  });
  return picked.content;
}

// ─── Cumulative-document rules (the same shape glossary.js established) ───────
//
// The character voice reference is cumulative, and it grows the way the glossary
// did. Asking a model to reproduce it with "writeFile, complete contents" is the
// mistake that broke the glossary (AGENTS.md gotcha 64), and this stage was
// never given the fix. Observed on the live 17-volume run: the volume-01
// character-voice feedback turn made 46 tool calls — 29 reads, 15 searches, ZERO
// writes — spent 2.63M tokens, and hit its step cap while still verifying
// findings, because the one write it had been told to do was the last thing in
// its instructions.

/**
 * Seed this volume's character voice reference with the previous volume's,
 * verbatim, before any agent touches it.
 *
 * "Carry forward every previous entry" was never a job for a model: it is a file
 * copy. Copying it in makes the compile pass what the prompt always said it was
 * — the previous reference PLUS this volume's new characters and quirks — and it
 * makes `voiceWriteInstruction` able to say "edit it in place", which is the only
 * instruction that works once the reference is bigger than one reply.
 *
 * Only `character-voice.md` is seeded. `pov-map.md` is PER-VOLUME (this volume's
 * POV map), not cumulative, so it is written fresh every volume and a stale copy
 * of the previous volume's map would be worse than none.
 *
 * @param {CharacterVoiceVolumeCtx} ctx - The volume context.
 * @returns {Promise<boolean>} True when the volume's reference now starts from the
 *   previous volume's copy (so the prompts can say "edit it in place").
 */
async function seedVoiceReferenceFromPrevious(ctx) {
  const { values, isFirst, previousVoiceRefFile, voiceOutputFile } = ctx;
  if (isFirst || !previousVoiceRefFile) return false;

  let previousText;
  try {
    previousText = await fs.readFile(previousVoiceRefFile, "utf8");
  } catch (err) {
    console.warn(
      `Volume ${values.INSTALLMENT_NUMBER}: could not read the previous character voice reference ` +
        `(${previousVoiceRefFile}: ${err.message}) — the author agent will write this volume's ` +
        `reference from scratch.`
    );
    return false;
  }
  if (!previousText || previousText.trim().length === 0) {
    console.warn(
      `Volume ${values.INSTALLMENT_NUMBER}: the previous character voice reference is empty — ` +
        `the author agent will write this volume's reference from scratch.`
    );
    return false;
  }

  let replaced = false;
  try {
    const existing = await fs.readFile(voiceOutputFile, "utf8");
    replaced = existing.trim() !== previousText.trim();
  } catch {
    replaced = true; // No file yet — the copy creates it.
  }

  await fs.writeFile(voiceOutputFile, previousText, "utf8");
  ctx.voiceSeeded = true;
  // The map the compile and feedback passes need in order to find a character's
  // section without paging the whole document (see buildVoiceIndex).
  ctx.voiceIndex = buildVoiceIndex(previousText);
  if (replaced) {
    console.log(
      `Volume ${values.INSTALLMENT_NUMBER}: seeded character-voice.md from ` +
        `../${path.basename(path.dirname(previousVoiceRefFile))}/character-voice.md ` +
        `(${parseVoiceSections(previousText).length} character section(s) carried forward ` +
        `verbatim; the author agent amends it in place).`
    );
  }
  return true;
}

/**
 * The character sections of a voice reference, in file order.
 *
 * The unit the cumulative invariant is stated in — `system-prompts/character-voice.md`
 * specifies `### [Character Name]` under `## Characters`, one section per
 * character (and one per persona of a character whose narration changes).
 *
 * @param {string} markdown - The reference file content.
 * @returns {Array<{name: string, heading: string, primary: string}>} `primary` is
 *   the heading with its bracketed aliases and persona tags removed — the part
 *   that identifies WHO the section is about.
 */
function parseVoiceSections(markdown) {
  if (!markdown || typeof markdown !== "string") return [];
  const sections = [];
  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim();
    const heading = line.match(/^###\s+(.+)$/);
    if (!heading) continue;
    const text = heading[1].replace(/\*\*?/g, "").replace(/`/g, "").trim();
    if (!text || /^:?-{3,}:?$/.test(text)) continue;
    sections.push({ name: text, heading: line, primary: voicePrimaryName(text) });
  }
  return sections;
}

/**
 * The part of a character section heading that identifies the CHARACTER, with the
 * bracketed aliases and persona tags removed.
 *
 * `如月雨露（ジョーロ）【俺人格】` → `如月雨露`. The persona tag is what a
 * feedback pass is most likely to reword (「俺人格」 → 「俺」) while leaving the
 * entry intact, so the carry-forward gate must not read a reworded tag as a
 * deleted character — that is the false positive that cost the glossary a good
 * volume 02 (see glossaryTermSpans in glossary.js).
 *
 * @param {string} heading - One `### ` heading's text.
 * @returns {string} The primary name (the heading itself when it has no brackets).
 */
function voicePrimaryName(heading) {
  const primary = String(heading || "")
    .split(/[（(【\[\/]/)[0]
    .trim();
  return primary || String(heading || "").trim();
}

/**
 * Compare two voice-reference snapshots and report what the newer one LOST.
 *
 * The reference is cumulative: volume N's file must hold every character section
 * volume N-1's held. Nothing else in the stage can see a loss — the validator
 * audits this volume's source against this volume's reference, so a character who
 * only ever appeared in volume 2 is invisible to it.
 *
 * The unit is the character, counted by primary name, because a cumulative
 * reference legitimately reworded a heading but may not quietly drop a character.
 * A primary name whose section COUNT falls is a loss: 如月雨露 appearing three
 * times (俺人格 / 僕人格 / the transition) and then twice means one of those
 * entries is gone, and "the heading was renamed" cannot explain a count dropping.
 *
 * Pure and deterministic — no model call, so it runs after every pass for the
 * price of two file reads.
 *
 * @param {string} previousMarkdown - The previous volume's reference content.
 * @param {string} currentMarkdown - The reference just produced for this volume.
 * @returns {{previousCount: number, currentCount: number, missing: Array<{name: string, expected: number, found: number}>, added: string[], restructured: number}}
 */
function compareVoiceCarryForward(previousMarkdown, currentMarkdown) {
  const previous = parseVoiceSections(previousMarkdown);
  const current = parseVoiceSections(currentMarkdown);

  const countBy = (sections) => {
    const map = new Map();
    for (const s of sections) map.set(s.primary, (map.get(s.primary) || 0) + 1);
    return map;
  };
  const previousCounts = countBy(previous);
  const currentCounts = countBy(current);
  const currentNames = new Set(current.map((s) => s.primary));

  const missing = [];
  let restructured = 0;
  for (const [primary, expected] of previousCounts) {
    const found = currentCounts.get(primary) || 0;
    if (found >= expected) {
      // The character is still here. If no heading matches the old one exactly,
      // the section was reworded — legitimate, and worth reporting separately so
      // a mass rename is visible rather than silently counted as a loss.
      if (!current.some((s) => s.name === previous.find((p) => p.primary === primary)?.name)) restructured++;
      continue;
    }
    missing.push({ name: primary, expected, found });
  }

  const previousNames = new Set(previous.map((s) => s.primary));
  const added = [...new Set(current.map((s) => s.primary))].filter((n) => !previousNames.has(n));

  return {
    previousCount: previous.length,
    currentCount: current.length,
    missing,
    added,
    restructured,
  };
}

/**
 * The carry-forward gate for the character voice reference: after a pass, check
 * that this volume's reference still holds every character section the previous
 * volume's held.
 *
 * It fails the VOLUME, not the run (with ON_VOLUME_ERROR=skip the series
 * continues and the volume is named in the task's failure summary), and it moves
 * the damaged reference to `character-voice.md.rejected` so the next volume
 * cannot build on it — which is what makes the ON_MISSING_PREVIOUS cascade
 * actually fire. A failed cumulative volume normally stops the next one only
 * when its artifact is MISSING; a present-but-short one is the case
 * ON_MISSING_PREVIOUS cannot see, and every later volume would read it as the
 * series' character state.
 *
 * @param {CharacterVoiceVolumeCtx} ctx - The volume context.
 * @param {string} [stageLabel] - Which pass produced the reference.
 * @returns {Promise<void>}
 * @throws {Error} When character sections disappeared (unless the guard is
 *   disabled with VOICE_CARRY_FORWARD_GUARD=false).
 */
async function assertVoiceCarryForward(ctx, stageLabel = "the compile pass") {
  const { values, isFirst, previousVoiceRefFile } = ctx;
  if (isFirst || !previousVoiceRefFile) return;
  if (!readBoolEnv("VOICE_CARRY_FORWARD_GUARD", true)) return;

  let previousText;
  try {
    previousText = await fs.readFile(previousVoiceRefFile, "utf8");
  } catch (err) {
    // A missing previous reference is already handled by the volume loop's
    // ON_MISSING_PREVIOUS policy; the guard must not mask it with a different
    // message.
    console.warn(`Volume ${values.INSTALLMENT_NUMBER}: carry-forward check skipped (${err.message}).`);
    return;
  }
  await guardVoiceCarryForwardAgainst(ctx, previousText, stageLabel, "the previous volume's character voice reference");
}

/**
 * The same gate against an arbitrary baseline — the previous volume's reference,
 * or this volume's own reference as of the previous chapter.
 *
 * The chunked flow needs the per-chapter form: a character lost at chapter 3
 * silently becomes the base of chapters 4–10, and catching it there costs one
 * chapter of rework instead of seven built on a reference that is already
 * missing someone.
 *
 * @param {CharacterVoiceVolumeCtx} ctx - The volume context.
 * @param {string} baselineText - The document the newer one must not shrink.
 * @param {string} stageLabel - Which pass produced the newer snapshot.
 * @param {string} baselineLabel - What the older snapshot was.
 * @returns {Promise<void>}
 * @throws {Error} When character sections disappeared.
 */
async function guardVoiceCarryForwardAgainst(ctx, baselineText, stageLabel, baselineLabel) {
  if (!readBoolEnv("VOICE_CARRY_FORWARD_GUARD", true)) return;
  const { values } = ctx;

  let currentText;
  try {
    currentText = await fs.readFile(ctx.voiceOutputFile, "utf8");
  } catch (err) {
    // A missing/empty reference is already the hard stop in assertRealOutput;
    // the guard adds nothing there and must not report it as a lost character.
    console.warn(`Volume ${values.INSTALLMENT_NUMBER}: carry-forward check skipped (${err.message}).`);
    return;
  }

  const diff = compareVoiceCarryForward(baselineText, currentText);
  if (diff.missing.length === 0) {
    console.log(
      `Volume ${values.INSTALLMENT_NUMBER}: carry-forward check passed ` +
        `(${diff.previousCount} character section(s) carried${diff.restructured ? `, ${diff.restructured} reworded` : ""}, ${diff.added.length} added).`
    );
    return;
  }

  const quarantineFile = `${ctx.voiceOutputFile}.rejected`;
  try {
    await fs.rename(ctx.voiceOutputFile, quarantineFile);
    console.error(
      `Volume ${values.INSTALLMENT_NUMBER}: moved the damaged character voice reference ` +
        `(${diff.currentCount} of ${diff.previousCount} sections) to "${path.basename(quarantineFile)}" ` +
        `so the next volume cannot build on it. Re-running this volume starts from ` +
        `../${ctx.previousFolderName}/character-voice.md.`
    );
  } catch (err) {
    console.warn(
      `Volume ${values.INSTALLMENT_NUMBER}: could not move the damaged reference aside (${err.message}) ` +
        `— it is still a failure, but the next volume may read it.`
    );
  }

  const preview = diff.missing
    .slice(0, 12)
    .map((m) => `${m.name} (${m.found} of ${m.expected})`)
    .join(", ");
  throw new Error(
    `Volume ${values.INSTALLMENT_NUMBER}: ${stageLabel} dropped character section(s) that ` +
      `${baselineLabel} held — ${diff.missing.length} of ${diff.previousCount} section(s) gone ` +
      `(${preview}${diff.missing.length > 12 ? ", …" : ""}). The reference is cumulative: every ` +
      `later volume is built on it, and its copy has been moved to ` +
      `"${path.basename(quarantineFile)}" so no later volume can read a partial one. Amend ` +
      `"character-voice.md" in place with editFile instead of rewriting it (see ` +
      `voiceWriteInstruction), or set VOICE_CARRY_FORWARD_GUARD=false to allow a shrinking reference.`
  );
}

/**
 * The "who is already in the reference" block for a character-voice agent turn.
 *
 * Same reason as the glossary's index: the cumulative reference is too big to
 * read whole from the middle volumes on, and a `grep` hunt for "is ひまわり
 * already here?" is what eats a capped step budget.
 *
 * @param {CharacterVoiceVolumeCtx} ctx - The volume context; `voiceIndex` is set by
 *   seedVoiceReferenceFromPrevious.
 * @returns {string} The block, or "" when there is no index. Ends with a blank line.
 */
function voiceIndexBlock(ctx) {
  if (!ctx.voiceIndex) return "";
  return (
    `What "character-voice.md" already holds (one line per character section):\n` +
    `${ctx.voiceIndex}\n\n` +
    `Use this to find the section you are about to change and to avoid starting a second ` +
    `section for a character who is already here under another name. It is an index, not the ` +
    `document: read the section you are about to change before changing it.\n\n`
  );
}

/**
 * The compact section map built from a voice reference (see voiceIndexBlock).
 * Capped, and it says when it truncates — a prompt that silently truncates is a
 * prompt that silently ignores part of the rules (AGENTS.md gotcha 43).
 *
 * @param {string} markdown - The reference content.
 * @returns {string} The index, or "" for an empty document.
 */
function buildVoiceIndex(markdown) {
  const sections = parseVoiceSections(markdown);
  if (sections.length === 0) return "";
  const cap = Number.parseInt(process.env.VOICE_INDEX_MAX_CHARS || "12000", 10);
  const lines = sections.map((s) => s.name);
  const body = lines.join("\n");
  if (Number.isFinite(cap) && cap > 0 && body.length > cap) {
    const kept = [];
    let used = 0;
    for (const line of lines) {
      if (used + line.length + 1 > cap) break;
      kept.push(line);
      used += line.length + 1;
    }
    return (
      kept.join("\n") +
      `\n(${sections.length - kept.length} later section(s) are not listed here — the index is ` +
      `capped at ${cap} chars. Search "character-voice.md" with grep before assuming a character ` +
      `is absent.)`
    );
  }
  return body;
}

/**
 * The write instruction for a character-voice pass — ONE implementation shared by
 * the compile and feedback passes, whole and per-chapter.
 *
 * `character-voice.md` is cumulative and is seeded from the previous volume, so
 * from volume 02 on it is amended IN PLACE. `pov-map.md` is this volume's own
 * document and is always written whole. Getting these two the same way is what
 * broke the stage: the whole-file demand put the only write at the END of the
 * turn, so a pass that ran out of steps produced nothing at all.
 *
 * @param {boolean} hasExistingFile - Whether "character-voice.md" already holds the
 *   document to change (see seedVoiceReferenceFromPrevious).
 * @param {"amend"|"correct"} [mode] - "amend" adds entries; "correct" applies a
 *   validation report. Only the wording differs.
 * @returns {string} The instruction block, ending with a blank line.
 */
function voiceWriteInstruction(hasExistingFile, mode = "amend") {
  const doVerb = mode === "correct" ? "Correct" : "Amend";
  if (!hasExistingFile) {
    return (
      `How to write it — neither file exists yet in your working folder, so write both ` +
      `whole with writeFile (complete contents), in the exact section format from the system ` +
      `prompt:\n\n` +
      `- "character-voice.md" — the character voice reference.\n` +
      `- "pov-map.md" — this volume's POV map.\n\n`
    );
  }
  return (
    `How to write it — the two files are NOT the same kind of document, and they are not ` +
    `written the same way:\n\n` +
    `1. "character-voice.md" ALREADY holds the reference as of the step before this one (the ` +
    `workflow put the current version of it there). ${doVerb} it IN PLACE with editFile:\n` +
    `   - Add a new character as ONE new \`### Name\` section at the end of the Characters part.\n` +
    `   - Edit an existing character's section in place when the source shows a quirk is wrong ` +
    `or missing, and keep the rest of that section.\n` +
    `   - Update the "current through volume" header line.\n` +
    `   Do NOT rewrite "character-voice.md" with writeFile. This reference is larger than one ` +
    `reply can produce, and a write cut off part-way destroys every character it did not reach. ` +
    `Never delete a section, and never retype a section you have not just read — characters ` +
    `that fall out of this file are lost from every later volume.\n\n` +
    `2. "pov-map.md" describes ONLY this volume, so it is written whole with writeFile ` +
    `(complete contents, overwrite).\n\n` +
    `Work in priority order, and write as you go: apply the HIGH-severity findings first with ` +
    `editFile, then MEDIUM, then LOW. Do not spend the whole turn reading and verifying and ` +
    `leave the editing for the end — a turn that runs out of steps having changed nothing has ` +
    `produced nothing, while one that applied the important fixes first produced a better ` +
    `document even if it did not reach the minor ones.\n\n`
  );
}

/**
 * The recovery turn for a character-voice pass that answered in chat instead of
 * using the file tools.
 *
 * It deliberately does NOT demand a whole-file rewrite of the cumulative
 * reference — that is the instruction that broke the stage (see
 * voiceWriteInstruction), and `assertWroteWithFallback` has already put the reply
 * on disk, so there is a file to edit.
 *
 * @param {boolean} hasContent - Whether the agent produced content in its chat reply.
 * @param {boolean} hasExistingFile - Whether "character-voice.md" is the seeded,
 *   cumulative document (true) or one the agent must create (false).
 * @returns {string} The recovery prompt.
 */
function voiceRecoveryPrompt(hasContent, hasExistingFile) {
  const voicePart = hasExistingFile
    ? `Apply your changes to "character-voice.md" with editFile — add each new character as a ` +
      `new "### Name" section and edit existing sections in place. Do NOT rewrite ` +
      `"character-voice.md" from scratch with writeFile: every section that is in it now must ` +
      `still be there when you finish.`
    : `Write the complete character voice reference to "character-voice.md" with writeFile.`;
  const povPart = `Write this volume's POV map to "pov-map.md" with writeFile (complete contents).`;
  if (hasContent) {
    return (
      `You produced your answer as a chat message instead of changing the files.\n\n` +
      `${voicePart}\n\n${povPart}\n\n` +
      `Read "character-voice.md" before editing it.`
    );
  }
  return (
    `You produced no output. Read the materials, then:\n\n` +
    `${voicePart}\n\n${povPart}`
  );
}

/**
 * The step cap for this stage's author / feedback agent on this volume or chapter.
 *
 * Scaled rather than flat 30: the agent reads the cumulative reference (which no
 * longer fits in one `readFile` answer), the text it is compiling from, and (for
 * feedback) the validation report. A flat 30 is what stopped volume 01's feedback
 * turn at 46 tool calls with zero writes.
 *
 * Fail-soft: an unreadable size counts as 0, which yields the flat floor rather
 * than failing the volume over a stat call.
 *
 * @param {CharacterVoiceVolumeCtx} ctx - The volume context.
 * @param {SourceSegment|null} [seg] - The chapter being processed (chunked mode).
 * @returns {Promise<number>} The step cap.
 */
async function voiceAuthorMaxSteps(ctx, seg = null) {
  const sizeOf = async (p) => {
    try {
      return (await fs.stat(p)).size;
    } catch {
      return 0;
    }
  };
  const artifactBytes = await sizeOf(ctx.voiceOutputFile);
  const sourceBytes = seg
    ? await sizeOf(path.join(ctx.volumeDir, seg.file))
    : await sizeOf(ctx.sourceFile);
  return authorMaxStepsFor(artifactBytes, sourceBytes);
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
    voiceIndexBlock(ctx) +
    voiceWriteInstruction(Boolean(ctx.voiceSeeded), "amend") +
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
    voiceIndexBlock(ctx) +
    voiceWriteInstruction(true, "correct") +
    `Verifying the report's findings against the source is part of the job, but it is not the ` +
    `job. The report already quotes the source lines it is complaining about, so:\n` +
    `- Check a batch of findings with ONE grep (its pattern may be several phrases separated by ` +
    `|) instead of one search per finding, and read the quoted line ranges in as few readFile ` +
    `calls as the layout allows.\n` +
    `- Apply each fix with editFile as soon as it is confirmed. Do not verify everything first ` +
    `and then start editing: if you run out of steps, the fixes you already applied still stand.\n` +
    `- If a finding cannot be confirmed from the source, say so in your final summary and leave ` +
    `that entry alone rather than spending more steps on it.\n\n` +
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
  // --force here means "redo THIS stage" — it does NOT re-run the intake (see getTranslationTarget).
  const manifest = await getTranslationTarget({ dryRun });
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
    const volumeLabel = `Volume ${volume.installmentNumber}`;
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
    // Whole-installment vs chapter-by-chapter, decided against THIS stage's
    // model window and the reference it will actually inject (the previous
    // volume's cumulative reference — which is why this is decided per volume:
    // it grows every volume). See planProcessingMode in utils/source.js.
    const mode = await decideProcessingMode({
      bundle,
      label: volumeLabel,
      previousArtifactFiles: previousVoiceRefFile ? [previousVoiceRefFile] : [],
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
    const ctx = { values, folderName, volumeDir, sourceFile, bundle, chunked: mode.chunked, voiceOutputFile, povOutputFile, validationOutputFile, isFirst, previousFolderName, previousVoiceRefFile, extractPrompt, validatorPrompt, feedbackPrompt, acceptancePrompt, extractTemplate, authorTemplate, extractSystemPrompt, authorSystemPrompt, validatorSystemPrompt, acceptanceSystemPrompt, feedbackSystemPrompt, authorUserPrompt: authorTemplate, validatorUserPrompt: validatorTemplate, feedbackUserPrompt: feedbackTemplate };
    if (dryRun) {
      // Preview the instruction a live run would give: the live run seeds
      // character-voice.md from the previous volume whenever there is one, and the
      // write instruction follows that. Without this the preview would show the
      // "create it from scratch" wording for volumes that are actually amended.
      ctx.voiceSeeded = !isFirst && Boolean(previousVoiceRefFile) && (await fileExists(previousVoiceRefFile));
      // …and it shows the section map that copy produces, because a preview that
      // promises "amend it in place" while hiding the map the agent uses to find
      // the section is a preview of a different prompt.
      ctx.voiceIndex = ctx.voiceSeeded
        ? buildVoiceIndex(await fs.readFile(previousVoiceRefFile, "utf8").catch(() => ""))
        : "";
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
    await runVolumeWithModeFallback({
      label: volumeLabel,
      ctx,
      volumeDir,
      run: () => runVolume(ctx),
      // Everything a whole-installment pass writes, removed before the
      // chapter-by-chapter retry so it cannot inherit a half-written attempt.
      attemptFiles: [
        "character-voice.md",
        "pov-map.md",
        "character-voice-new.json",
        "character-voice-validation.md",
        "character-voice-validation-rolling-state.json",
      ],
      attemptGlob: /^character-voice-.*\.md$/,
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
    const finalVoiceFile = seriesArtifactFile("character-voice.md", "VOICE_OUTPUT_FILE", seriesDir);
    let lastVoice = null;
    for (let i = sorted.length - 1; i >= 0; i--) {
      const candidate = path.join(seriesDir, sorted[i], "character-voice.md");
      // Last REAL, PUBLISHABLE snapshot: an empty or stubbed one left by a failed
      // volume is not the series' current voice reference, and neither is a file
      // that is not a document at all (gotcha 58).
      if (await isPublishableArtifact(candidate, "character voice reference")) { lastVoice = candidate; break; }
    }
    if (lastVoice) { await fs.copyFile(lastVoice, finalVoiceFile); await writeProvenanceSidecar(finalVoiceFile, lastVoice); console.log(`\nCopied the final character voice reference to: ${finalVoiceFile}`); }
    else { console.log("\nNo character voice snapshots found; nothing to copy."); }
  }

  // A task that failed volumes fails the run (see configs/shared.js
  // volumeFailureError): the summary used to be printed and the task exited 0.
  const volumeError = volumeFailureError("character-voice", failedVolumes, volumes.length);
  if (volumeError) throw volumeError;
}

// The "model emitted tool-call syntax as plain text" guard (emittedToolCallAsText
// + assertRealToolCalls) is shared by every file-writing task — see
// utils/agents.js. Observed live (Qwen via an OpenAI-compatible endpoint): the
// model sometimes emits its tool calls as Qwen-native text — a `tool_call`
// wrapper around the tool name — in the content field instead of using the
// API-level tool_calls protocol. The harness only executes real tool calls, so
// such a turn performs no work yet looks like an ordinary chat reply, and the
// stale-file write check + acceptance loop would silently mask it.

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
      // Inlined (not readFile) — so the cumulative reference is bounded here.
      // Relevance-ordered: the characters this chapter actually contains are
      // shown even when they were introduced in volume 1 (see truncateVoiceRef).
      const chapterSource = await fs.readFile(path.join(ctx.volumeDir, seg.file), "utf8");
      messages.push(
        await inlineReferenceMessage(
          stateFile,
          si === 0 ? "character-voice-previous.md" : "character-voice-current.md",
          { truncate: (raw) => truncateVoiceRef(raw, chapterSource) }
        )
      );
    }
    messages.push({ text: ctx.extractPrompt }, { text: chapterSegmentNote(ctx.bundle, seg, si) });
    return harness.runOneShot({ systemPrompt: ctx.extractSystemPrompt, messages, label: `character-voice-extract-${values.INSTALLMENT_NUMBER}${labelSuffix}` });
  }
  const { sourceFile } = ctx;
  console.log(`Volume ${values.INSTALLMENT_NUMBER}: running voice/POV extraction...`);
  const messages = [{ file: sourceFile, name: path.basename(sourceFile) }, { text: ctx.extractPrompt }];
  if (ctx.previousVoiceRefFile) {
    const volumeSourceText = await fs.readFile(sourceFile, "utf8");
    messages.push(
      await inlineReferenceMessage(ctx.previousVoiceRefFile, "character-voice-previous.md", {
        truncate: (raw) => truncateVoiceRef(raw, volumeSourceText),
      })
    );
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
  const author = await harness.createAgentHandle({ name: `author-voice-${values.INSTALLMENT_NUMBER}${labelSuffix}`, systemPrompt: buildAuthorSystemPrompt(authorSystemPrompt), tools: ctx.fsGate.tools, approve: ctx.fsGate.approve, cwd: ctx.volumeDir, maxSteps: await voiceAuthorMaxSteps(ctx, seg) });
  try {
    const compileResult = await author.sendTurn(buildAuthorTurnPrompt(ctx, extractionResults, seg, si), { label: `character-voice-compile-${values.INSTALLMENT_NUMBER}${labelSuffix}` });
    assertRealToolCalls(compileResult, `the author agent (compile${seg ? `, chapter ${seg.id}` : ""})`, values.INSTALLMENT_NUMBER);
    const compileFallbackUsed = await assertWroteWithFallback([ctx.voiceOutputFile, ctx.povOutputFile], `the author agent (compile${seg ? `, chapter ${seg.id}` : ""})`, compileResult?.text);
    // Recovery turn: ONLY when a file was actually missing after the fallback —
    // never over files the agent already wrote correctly.
    if (compileFallbackUsed && process.env.AGENT_RECOVERY_ENABLED !== "false") {
      const hasContent = compileResult?.text && compileResult.text.trim().length > 0;
      const recoveryResult = await author.sendTurn(voiceRecoveryPrompt(hasContent, Boolean(ctx.voiceSeeded)), { label: `character-voice-compile-recovery-${values.INSTALLMENT_NUMBER}${labelSuffix}` });
      assertRealToolCalls(recoveryResult, `the author agent (compile recovery${seg ? `, chapter ${seg.id}` : ""})`, values.INSTALLMENT_NUMBER);
      await assertWroteWithFallback([ctx.voiceOutputFile, ctx.povOutputFile], `the author agent (compile recovery${seg ? `, chapter ${seg.id}` : ""})`, recoveryResult?.text);
    }
    // Hard stop: the recovery turn is the last chance — a still-missing,
    // empty or stubbed artifact is a failure, not an output.
    await assertRealOutput([ctx.voiceOutputFile, ctx.povOutputFile], `the author agent (compile${seg ? `, chapter ${seg.id}` : ""})`);
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
    // Exceptional-score confirmation re-grades (see utils/qa-loop.js).
    confirmationCheck: ({ index, temperature }) => acceptanceCheck(ctx, `confirm${index + 1}`, temperature),
    feedbackLogLine: () => "Calling the AI to apply the validation feedback (author agent)...",
    runFeedback: (iteration) => runFeedback(ctx),
    // The loop stops when a feedback pass leaves these byte-identical: a turn
    // that only read is not an iteration (see fingerprintFiles in utils/fs.js).
    feedbackArtifactFiles: [ctx.voiceOutputFile, ctx.povOutputFile],
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
  const author = await harness.createAgentHandle({ name: `author-voice-feedback-${values.INSTALLMENT_NUMBER}`, systemPrompt: ctx.feedbackSystemPrompt + AGENT_TOOLS_NOTE, tools: fsGate.tools, approve: fsGate.approve, cwd: volumeDir, maxSteps: await voiceAuthorMaxSteps(ctx) });
  try {
    const feedbackResult = await author.sendTurn(buildFeedbackTurnPrompt(ctx), { label: `character-voice-feedback-${values.INSTALLMENT_NUMBER}` });
    assertRealToolCalls(feedbackResult, "the author agent (feedback pass)", values.INSTALLMENT_NUMBER);
    const feedbackFallbackUsed = await assertWroteWithFallback([ctx.voiceOutputFile, ctx.povOutputFile], "the author agent (feedback pass)", feedbackResult?.text);
    // Recovery turn: ONLY when a file was actually missing after the fallback —
    // never over files the agent already wrote correctly.
    if (feedbackFallbackUsed && process.env.AGENT_RECOVERY_ENABLED !== "false") {
      const hasContent = feedbackResult?.text && feedbackResult.text.trim().length > 0;
      const recoveryResult = await author.sendTurn(voiceRecoveryPrompt(hasContent, true), { label: `character-voice-feedback-recovery-${values.INSTALLMENT_NUMBER}` });
      assertRealToolCalls(recoveryResult, "the author agent (feedback recovery)", values.INSTALLMENT_NUMBER);
      await assertWroteWithFallback([ctx.voiceOutputFile, ctx.povOutputFile], "the author agent (feedback recovery)", recoveryResult?.text);
    }
    await assertRealOutput([ctx.voiceOutputFile, ctx.povOutputFile], "the author agent (feedback pass)");
    // The cumulative invariant, re-checked after every rewrite: a feedback pass
    // that rewrote the reference from memory is how characters disappear from it
    // (see assertVoiceCarryForward).
    await assertVoiceCarryForward(ctx, "the feedback pass");
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
async function acceptanceCheck(ctx, iteration, temperature) {
  const { values, validationOutputFile, acceptancePrompt, acceptanceSystemPrompt, voiceOutputFile, povOutputFile } = ctx;
  const acceptanceOutput = await harness.runOneShot({ systemPrompt: acceptanceSystemPrompt, messages: [{ file: voiceOutputFile, name: "character-voice.md" }, { file: povOutputFile, name: "pov-map.md" }, { file: validationOutputFile, name: "character-voice-validation.md" }, { text: acceptancePrompt }], temperature: temperature ?? judgeTemperature(), ...judgeThinking("ACCEPTANCE"), label: `character-voice-acceptance-${values.INSTALLMENT_NUMBER}-${iteration}` });
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
  // Same rule as whole mode: the previous volume's reference is copied in first,
  // so each chapter's compile pass amends the current state instead of
  // reproducing it (see seedVoiceReferenceFromPrevious).
  await seedVoiceReferenceFromPrevious(ctx);
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
    // The baseline this chapter must not shrink below: the reference as of the
    // previous chapter (or the previous volume's, for chapter 0).
    const chapterBaseline = await fs.readFile(ctx.voiceOutputFile, "utf8").catch(() => null);
    try {
      await runCompile(ctx, extractionOutput, segment, si);
    } catch (err) {
      console.error(`Volume ${values.INSTALLMENT_NUMBER}: compilation failed for chapter ${segment.id}: ${err.message}. Check .logs/ for details.`);
      throw err;
    }
    // The carry-forward gate BETWEEN chapters, not just at the volume boundary:
    // catching a lost character at chapter 3 saves seven chapters of work built
    // on a reference that is already missing someone.
    if (chapterBaseline !== null) {
      await guardVoiceCarryForwardAgainst(ctx, chapterBaseline, `the compile pass (chapter ${segment.id})`, "the reference as of the previous chapter");
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
        await assertRealOutput(partialFile, `the validator agent (chapter ${segment.id})`);
      } finally { await validator.close(); }
    }
    // Findings merge: consolidate the partials into the standard report.
    const merger = await harness.createAgentHandle({ name: `validator-merge-${values.INSTALLMENT_NUMBER}-${iteration}`, systemPrompt: ctx.validatorSystemPrompt + AGENT_TOOLS_NOTE, tools: fsGate.tools, approve: fsGate.approve, cwd: volumeDir, maxSteps: findingsMergeMaxStepsFor(bundle.segments.length, (await fs.stat(ctx.voiceOutputFile).catch(() => ({ size: 0 }))).size) });
    try {
      const mergeResult = await merger.sendTurn(buildVoiceFindingsMergePrompt(ctx), { label: `character-voice-validate-merge-${values.INSTALLMENT_NUMBER}-${iteration}` });
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
    // re-grading this artifact, not by paying for a per-chapter feedback round
    // plus a second full round of per-chapter validators (see confirmPassingScore).
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
    // Per-chapter feedback (fresh agent per chapter, chapter-tagged findings).
    // Fingerprinted first: a feedback round that changed nothing is not progress,
    // and another iteration would re-audit an unchanged document.
    const beforeFeedback = await fingerprintFiles([ctx.voiceOutputFile, ctx.povOutputFile]);
    for (let si = 0; si < bundle.segments.length; si++) {
      const segment = bundle.segments[si];
      const feedbackAuthor = await harness.createAgentHandle({ name: `feedback-author-${values.INSTALLMENT_NUMBER}-${iteration}-${segment.id}`, systemPrompt: buildAuthorSystemPrompt(ctx.authorSystemPrompt), tools: fsGate.tools, approve: fsGate.approve, cwd: volumeDir, maxSteps: await voiceAuthorMaxSteps(ctx, segment) });
      try {
        const feedbackResult = await feedbackAuthor.sendTurn(buildFeedbackTurnPrompt(ctx, segment, si), { label: `character-voice-feedback-${values.INSTALLMENT_NUMBER}-${iteration}-${segment.id}` });
        assertRealToolCalls(feedbackResult, `the author agent (feedback pass, chapter ${segment.id})`, values.INSTALLMENT_NUMBER);
        const feedbackFallbackUsed = await assertWroteWithFallback([ctx.voiceOutputFile, ctx.povOutputFile], `the author agent (feedback pass, chapter ${segment.id})`, feedbackResult?.text);
        // Recovery turn: ONLY when a file was actually missing after the
        // fallback — never over files the agent already wrote correctly.
        if (feedbackFallbackUsed && process.env.AGENT_RECOVERY_ENABLED !== "false") {
          const hasContent = feedbackResult?.text && feedbackResult.text.trim().length > 0;
          const recoveryResult = await feedbackAuthor.sendTurn(voiceRecoveryPrompt(hasContent, true), { label: `character-voice-feedback-recovery-${values.INSTALLMENT_NUMBER}-${iteration}-${segment.id}` });
          assertRealToolCalls(recoveryResult, `the author agent (feedback recovery, chapter ${segment.id})`, values.INSTALLMENT_NUMBER);
          await assertWroteWithFallback([ctx.voiceOutputFile, ctx.povOutputFile], `the author agent (feedback recovery, chapter ${segment.id})`, recoveryResult?.text);
        }
        await assertRealOutput([ctx.voiceOutputFile, ctx.povOutputFile], `the author agent (feedback pass, chapter ${segment.id})`);
      } finally { await feedbackAuthor.close(); }
    }
    if ((await fingerprintFiles([ctx.voiceOutputFile, ctx.povOutputFile])) === beforeFeedback) {
      console.error(
        `Volume ${values.INSTALLMENT_NUMBER}: the per-chapter feedback round changed NOTHING — ` +
          `both artifacts are byte-identical to what they were before it. Stopping the QA loop here ` +
          `rather than paying for another round of per-chapter validators over an unchanged document. ` +
          `Check the feedback agents' turn logs in .logs/ for turns that only read (the usual shape: ` +
          `step cap reached before anything was written).`
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
    // The cumulative invariant, re-checked after every feedback round.
    await assertVoiceCarryForward(ctx, "the feedback pass");
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
  // The previous volume's reference is copied in BEFORE any agent touches the
  // folder, so the compile pass amends a real file instead of reproducing a
  // document too large for one reply (see seedVoiceReferenceFromPrevious).
  await seedVoiceReferenceFromPrevious(ctx);
  try { await runCompile(ctx, extractionOutput); } catch (err) { console.error(`Volume ${values.INSTALLMENT_NUMBER}: compilation failed: ${err.message}. Check .logs/ for details.`); throw err; }
  await assertVoiceCarryForward(ctx, "the compile pass");
  await runQaLoop(ctx);
}

// Export
module.exports = { characterVoice, parseVoiceQuirks, truncateVoiceRef, emittedToolCallAsText, buildExtractTurnPrompt, buildAuthorTurnPrompt, buildValidatorTurnPrompt, buildFeedbackTurnPrompt, buildVoiceFindingsMergePrompt, buildExtractSystemPrompt, buildAuthorSystemPrompt, buildValidatorSystemPrompt, runVolume, runExtract, runCompile, runQaLoop, runChunkedVolume, runChunkedQaLoop, acceptanceCheck, seedVoiceReferenceFromPrevious, parseVoiceSections, voicePrimaryName, compareVoiceCarryForward, assertVoiceCarryForward, guardVoiceCarryForwardAgainst, buildVoiceIndex, voiceIndexBlock, voiceWriteInstruction, voiceRecoveryPrompt, voiceAuthorMaxSteps };
