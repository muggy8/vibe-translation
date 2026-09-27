/**
 * polish.js — Logic for the "polish" gulp task: the final pass of the
 * translation pipeline.
 *
 * Task: polish
 *   For each volume, for each chapter that has a translation-<id>.md draft:
 *     1. Skip it when the state shows the polished-<id>.md file was produced
 *        from the CURRENT draft (polishedDraftHash === draftHash) —
 *        idempotency; --force re-polishes.
 *     2. One-shot call to the edit model (Qwen3.8-27B via EDIT_* env):
 *        source + current draft + glossary + style rules + character voice
 *        notes → the complete polished chapter (system-prompts/polish.md,
 *        user-prompts/polish.md). Thinking is ON (default: medium) — the
 *        polish pass benefits from deliberation and runs last.
 *     3. Regression guard (deterministic): if the polished text FAILS the
 *        QA that the draft passed, or LOSES glossary coverage the draft had,
 *        the polished text is rejected and the draft is kept (the chapter is
 *        left unpolished and retried on the next run).
 *     4. Write polished-<id>.md, record polishedDraftHash in the state, and
 *        re-merge the volume's translation.md (polished text wins).
 *
 * Usage:
 *   npx gulp polish              # run the full task
 *   npx gulp polish --dry-run    # dump the prompts only, no AI calls
 *   npx gulp polish --force      # re-polish even if up to date
 *   npx gulp polish --volume 01  # single volume
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("./types"); // JSDoc type definitions
const harness = require("./harness");
const { getTranslationTarget } = require("./get-translation-target");
const { ON_VOLUME_ERROR, validateRequiredEnv } = require("./configs/shared");
const { fileExists } = require("./utils/fs");
const { resolveSourceBundle } = require("./utils/source");
const { transformUserPrompt, writePromptDump } = require("./utils/prompt");
const {
  sha256,
  checkTranslationQa,
  stripMarkdownFence,
  loadTranslationState,
  saveTranslationState,
  roleEndpoint,
  loadVolumeReferences,
} = require("./utils/translate");
const { chapterArtifactNames, mergeVolumeTranslationFiles } = require("./translate");
const { glossaryBlock } = require("./verify-translate");

// ─── Paths & config ──────────────────────────────────────────────────────────

const clientDir = __dirname;
const seriesDir = process.env.SERIES_LOCATION;

const polishSystemPromptFile = path.join(clientDir, "system-prompts", "polish.md");
const polishTemplateFile = path.join(clientDir, "user-prompts", "polish.md");

const POLISH_QA_REPORT = "polish-qa.md";

const polishThinkingLevel = process.env.EDIT_THINKING_LEVEL || "medium";
const polishThinking = process.env.EDIT_THINKING !== "false";
const polishTemperature = parseFloat(process.env.EDIT_TEMPERATURE ?? "0.6");

// ─── Per-volume processing ──────────────────────────────────────────────────

/**
 * Polish one volume's chapter drafts.
 *
 * @param {{
 *   volume: {folder: string, sourceFile: string, installmentNumber: string},
 *   volumeDir: string,
 *   bundle: {segments: Array<{id: string, file: string, title: string, chars: number}>},
 *   refs: {terms: Array<{term: string, rendering: string}>, styleRules: string, voiceNotes: string},
 *   systemPrompt: string,
 *   template: string,
 *   endpoint: {baseUrl: string, apiKey?: string, model: string},
 *   dryRun: boolean,
 *   force: boolean,
 * }} ctx
 * @returns {Promise<{polished: number, skipped: number, rejected: number, noDraft: number}>}
 */
async function processPolishVolume(ctx) {
  const { volume, volumeDir, bundle, refs, systemPrompt, template, endpoint, dryRun, force } = ctx;
  const state = await loadTranslationState(path.join(volumeDir, "translation-state.json"));
  const rows = [];
  let polished = 0;
  let skipped = 0;
  let rejected = 0;
  let noDraft = 0;

  for (const seg of bundle.segments) {
    const { draftFile, polishedFile } = chapterArtifactNames(seg.id);
    const chapterPath = path.join(volumeDir, seg.file);
    const draftPath = path.join(volumeDir, draftFile);
    const polishedPath = path.join(volumeDir, polishedFile);
    if (!(await fileExists(draftPath))) {
      console.warn(`  Volume ${volume.installmentNumber} ${seg.id}: no draft — run translate first.`);
      noDraft += 1;
      rows.push({ id: seg.id, title: seg.title, status: "no draft", ok: true, warnings: [] });
      continue;
    }
    const sourceText = await fs.readFile(chapterPath, "utf8");
    const draft = await fs.readFile(draftPath, "utf8");
    const sEntry = state.chapters[seg.id] || {};

    const upToDate =
      !force &&
      sEntry.draftHash === sha256(draft) &&
      sEntry.polishedDraftHash === sEntry.draftHash &&
      (await fileExists(polishedPath));
    if (upToDate) {
      console.log(`  Volume ${volume.installmentNumber} ${seg.id}: polish up to date — skipping.`);
      skipped += 1;
      rows.push({ id: seg.id, title: seg.title, status: "skipped (up to date)", ok: true, warnings: [] });
      continue;
    }

    const values = {
      SOURCE_TEXT: sourceText,
      TRANSLATION_TEXT: draft,
      GLOSSARY: glossaryBlock(refs.terms),
      STYLE_RULES: refs.styleRules || "(none provided — run the style-guide task)",
      VOICE_NOTES: refs.voiceNotes || "(none provided — run the character-voice task)",
    };
    const prompt = transformUserPrompt(template, values);

    if (dryRun) {
      // Dump the prompt for every chapter a live run would polish (no-draft
      // and up-to-date chapters were skipped above) — one file per chapter,
      // no AI calls in dry-run.
      const file = await writePromptDump(
        `polish-${volume.installmentNumber}-${seg.id}`,
        volume.installmentNumber,
        "one-shot (edit model)",
        [
          { title: "One-shot — polish system prompt", prompt: systemPrompt },
          {
            title:
              `One-shot — polish ${seg.id} ` +
              `(endpoint ${endpoint.model} @ ${endpoint.baseUrl}, thinking=${polishThinking ? polishThinkingLevel : "off"})`,
            prompt,
          },
        ]
      );
      console.log(`  Volume ${volume.installmentNumber} ${seg.id}: --dry-run prompt dump → ${file}`);
      continue;
    }

    console.log(
      `  Volume ${volume.installmentNumber} ${seg.id}: polishing draft (${draft.length} chars) with ${endpoint.model}…`
    );
    const result = await harness.runOneShot({
      systemPrompt,
      messages: [{ text: prompt }],
      endpoint,
      temperature: Number.isFinite(polishTemperature) ? polishTemperature : 0.6,
      thinking: polishThinking,
      thinkingLevel: polishThinkingLevel,
      label: `polish-v${volume.installmentNumber}-${seg.id}`,
    });
    const clean = stripMarkdownFence(result);
    if (!clean) {
      throw new Error(
        `Volume ${volume.installmentNumber} ${seg.id}: the model returned no content for the polish pass. ` +
          `Check .logs/ and re-run.`
      );
    }

    // Regression guard: the polish pass must not make things WORSE — a
    // polished text that fails the QA the draft passed, or that loses
    // glossary coverage the draft had, is rejected and the draft is kept.
    const qaDraft = checkTranslationQa({ sourceText, draftText: draft, terms: refs.terms });
    const qaPolished = checkTranslationQa({ sourceText, draftText: clean, terms: refs.terms });
    const regressed =
      (!qaPolished.ok && qaDraft.ok) || qaPolished.missingTerms.length > qaDraft.missingTerms.length;
    if (regressed) {
      console.warn(
        `  Volume ${volume.installmentNumber} ${seg.id}: polish REGRESSED (errors: ${
          qaPolished.errors.join("; ")
        }; missing terms ${qaDraft.missingTerms.length} → ${qaPolished.missingTerms.length}) — ` +
          `keeping the draft.`
      );
      rejected += 1;
      rows.push({
        id: seg.id,
        title: seg.title,
        status: "polish rejected (regression — draft kept)",
        ok: true,
        warnings: qaPolished.warnings,
      });
      continue;
    }

    await fs.writeFile(polishedPath, clean + "\n", "utf8");
    // Write the FULL entry shape: when the state entry was missing (state
    // file lost, pre-existing draft) the merge step still finds the
    // polished text (it keys on draftHash) and the next run sees the
    // chapter as up to date. draftHash is the hash of the draft content the
    // polish pass just read (the polished file was produced from it).
    const draftHash = sha256(draft);
    state.chapters[seg.id] = {
      sourceHash: sEntry.sourceHash ?? sha256(sourceText),
      contextHash: sEntry.contextHash ?? refs.contextHash,
      draftHash,
      retranslated: sEntry.retranslated ?? false,
      findingsHash: sEntry.findingsHash ?? null,
      polishedDraftHash: draftHash,
    };
    await saveTranslationState(path.join(volumeDir, "translation-state.json"), state);
    polished += 1;
    rows.push({
      id: seg.id,
      title: seg.title,
      status: "polished",
      ok: qaPolished.ok,
      warnings: qaPolished.warnings,
    });
    if (qaPolished.warnings.length > 0) {
      console.warn(
        `  Volume ${volume.installmentNumber} ${seg.id}: QA warning: ${qaPolished.warnings.join("; ")}`
      );
    }
  }

  // Re-merge the volume (the polished text wins now).
  const mergedText = await mergeVolumeTranslationFiles(volumeDir, bundle, state);
  if (mergedText) {
    await fs.writeFile(path.join(volumeDir, "translation.md"), mergedText, "utf8");
  }
  const lines = [
    `# Polish QA — Volume ${volume.installmentNumber} (${volume.folder})`,
    "",
    "_Deterministic checks on the polished chapters (regression guard: a polished text that fails the",
    "QA the draft passed, or loses glossary coverage, is rejected and the draft is kept)._",
    "",
    "| Chapter | Title | Status | Warnings |",
    "|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.id} | ${r.title || "—"} | ${r.status} | ${r.warnings.length > 0 ? r.warnings.join("; ") : "—"} |`
    ),
    "",
  ];
  await fs.writeFile(path.join(volumeDir, POLISH_QA_REPORT), lines.join("\n"), "utf8");
  return { polished, skipped, rejected, noDraft };
}

// ─── Task entry ─────────────────────────────────────────────────────────────

/**
 * Run the polish task (all volumes, or --volume NN).
 *
 * @returns {Promise<void>}
 */
async function polish() {
  const dryRun = process.argv.includes("--dry-run");
  const force = process.argv.includes("--force");

  if (!seriesDir) {
    throw new Error("SERIES_LOCATION is not set. Please set it in .env.");
  }
  validateRequiredEnv({ dryRun });

  const endpoint = roleEndpoint("EDIT");
  if (!dryRun) {
    await harness.assertModelServing({ ...endpoint, label: "polish stage" });
  }

  const systemPrompt = await fs.readFile(polishSystemPromptFile, "utf-8");
  const template = await fs.readFile(polishTemplateFile, "utf-8");

  const manifest = await getTranslationTarget({ force, dryRun });
  const sorted = manifest.volumes.map((v) => v.folder);
  const volumeByFolder = new Map(manifest.volumes.map((v) => [v.folder, v]));
  if (sorted.length === 0) {
    throw new Error(`No volume folders found in ${seriesDir}.`);
  }

  const volumeArg =
    (process.argv.find((a) => a.startsWith("--volume=")) || "").replace("--volume=", "") ||
    (process.argv.includes("--volume")
      ? process.argv[process.argv.indexOf("--volume") + 1]
      : null);
  let volumes = sorted;
  if (volumeArg) {
    const wanted = String(parseInt(volumeArg, 10)).padStart(2, "0");
    volumes = sorted.filter((name) => {
      const m = name.match(/\((\d+)\)\s*$/);
      return m && m[1].padStart(2, "0") === wanted;
    });
    if (volumes.length === 0) {
      throw new Error(`No volume folder matching --volume ${volumeArg}.`);
    }
    console.log(`--volume: processing only volume ${wanted}`);
  }

  console.log(
    `[polish] ${sorted.length} volume folder(s); endpoint ${endpoint.model} @ ${endpoint.baseUrl}; ` +
      `thinking=${polishThinking ? polishThinkingLevel : "off"}.`
  );

  const failedVolumes = [];
  let totalPolished = 0;
  let totalRejected = 0;

  for (const folderName of volumes) {
    const volume = volumeByFolder.get(folderName);
    const volumeDir = path.join(seriesDir, folderName);
    try {
      const bundle = await resolveSourceBundle({ seriesDir, volume, volumeDir, force });
      const refs = await loadVolumeReferences(volumeDir);
      const result = await processPolishVolume({
        volume,
        volumeDir,
        bundle,
        refs,
        systemPrompt,
        template,
        endpoint,
        dryRun,
        force,
      });
      totalPolished += result.polished;
      totalRejected += result.rejected;
      console.log(
        `[polish] Volume ${volume.installmentNumber}: ${result.polished} polished, ` +
          `${result.rejected} rejected (draft kept), ${result.skipped} skipped, ${result.noDraft} without draft.`
      );
    } catch (err) {
      if (ON_VOLUME_ERROR === "skip") {
        console.error(`[skip] Volume ${volume.installmentNumber} (${folderName}) failed: ${err.message}`);
        failedVolumes.push(volume.installmentNumber);
        continue;
      }
      throw err;
    }
  }

  console.log(
    `[polish] Done: ${totalPolished} chapter(s) polished, ${totalRejected} rejected ` +
      `(rejected chapters keep their draft and retry on the next run).`
  );
  if (failedVolumes.length > 0) {
    throw new Error(
      `${failedVolumes.length} of ${volumes.length} volume(s) failed: ${failedVolumes.join(", ")}.`
    );
  }
}

module.exports = {
  polish,
  processPolishVolume,
  POLISH_QA_REPORT,
};