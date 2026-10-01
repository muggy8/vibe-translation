/**
 * translate.js — Logic for the "translate" gulp task: the first stage of the
 * local multi-model translation pipeline.
 *
 * Task: translate
 *   For each volume (in natural order):
 *     1. Resolve the volume's source bundle (utils/source.js) and load the
 *        reference artifacts (glossary.md → terminology, style-guide.md
 *        → house rules, shared-wiki.md + wiki.md + pov-map.md → background).
 *     2. For each chapter segment (reading order — the bundle's segments
 *        array, NEVER a filename sort):
 *        - Skip it when its translation-<id>.md draft exists and the state
 *          file (translation-state.json) shows the same source + reference
 *          hashes (idempotency; --force re-translates).
 *        - Split oversized chapters (TRANSLATE_CHUNK_CHARS) and translate
 *          each part with Hy-MT2 via runOneShot — NO system prompt (the
 *          model's official contract is a single user message), official
 *          sampling (temp 0.7, top_p 1.0, top_k -1, rep-pen 1.0), fast
 *          "no_think" mode by default (TRANSLATE_THINKING).
 *        - Each part after the first gets the previous part's ending as
 *          continuity context (TRANSLATE_CONTINUITY_CHARS).
 *        - Run the deterministic QA (utils/translate.js: CJK ratio, length
 *          ratio, glossary coverage) — a hard failure fails the chapter.
 *        - Persist the draft + state entry (crash-safe, per chapter).
 *     3. Merge all chapters into the volume's translation.md and write the
 *        deterministic QA report (translation-qa.md).
 *
 * The endpoint is role-specific (TRANSLATE_BASE_URL / TRANSLATE_MODEL /
 * TRANSLATE_API_KEY, falling back to the global AI_* settings). On local
 * setups the per-machine pre-translate hook (hooks/) starts the Hy-MT2
 * container; the task itself only checks the endpoint via
 * harness.assertModelServing before the first call.
 *
 * Idempotent and resumable: re-runs skip finished chapters; a changed source
 * or a regenerated glossary/style guide (reference hash) invalidates the
 * stale drafts.
 *
 * Usage:
 *   npx gulp translate              # run the full task
 *   npx gulp translate --dry-run    # dump the prompts only, no AI calls
 *   npx gulp translate --force      # re-translate even if drafts exist
 *   npx gulp translate --volume 01  # single volume
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("./types"); // JSDoc type definitions
const harness = require("./harness");
const { getTranslationTarget } = require("./get-translation-target");
const { filterVolumesByInstallment } = require("./utils/manifest");
const { ON_VOLUME_ERROR, validateRequiredEnv, resolveRunSettings, isStructuralError, structuralError } = require("./configs/shared");
const { fileExists } = require("./utils/fs");
const { resolveSourceBundle } = require("./utils/source");
const { writePromptDump } = require("./utils/prompt");
const {
  sha256,
  splitChapter,
  buildTranslationTaskLines,
  buildTranslationPrompt,
  checkTranslationQa,
  mergeVolumeTranslation,
  findMissingSegments,
  stripMarkdownFence,
  tailOf,
  loadTranslationState,
  saveTranslationState,
  roleEndpoint,
  loadVolumeReferences,
  chapterTerminology,
  glossaryBlockMaxChars,
  stripContinuityOverlap,
} = require("./utils/translate");

// ─── Paths & config ──────────────────────────────────────────────────────────

const clientDir = __dirname;
const seriesDir = process.env.SERIES_LOCATION;

const translateTemplateFile = path.join(clientDir, "user-prompts", "translate.md");

/**
 * Per-chapter draft / polished / state / report file names (inside the
 * volume folder). The segment id is unique per volume, so the files are
 * unambiguous without a bundle-base prefix.
 *
 * @param {string} segmentId - The bundle segment id (ch0 / chN / chN.K / whole).
 * @returns {{draftFile: string, polishedFile: string}}
 */
function chapterArtifactNames(segmentId) {
  return {
    draftFile: `translation-${segmentId}.md`,
    polishedFile: `polished-${segmentId}.md`,
  };
}

const STATE_FILE = "translation-state.json";
const QA_REPORT_FILE = "translation-qa.md";
const MERGED_FILE = "translation.md";

/**
 * Chapter text longer than this (chars) is split and translated per part.
 * @returns {number} TRANSLATE_CHUNK_CHARS (default 24000, minimum 2000).
 */
function translateChunkChars() {
  const parsed = parseInt(process.env.TRANSLATE_CHUNK_CHARS, 10);
  return Number.isFinite(parsed) ? Math.max(2000, parsed) : 24000;
}

/**
 * How many chars of the previous chapter's ending feed the next chapter.
 * @returns {number} TRANSLATE_CONTINUITY_CHARS (default 400; 0 = off).
 */
function translateContinuityChars() {
  const parsed = parseInt(process.env.TRANSLATE_CONTINUITY_CHARS, 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 400;
}

const chunkChars = translateChunkChars();
const continuityChars = translateContinuityChars();

/**
 * Hy-MT2 thinking mode. The model's published numbers are for the fast
 * (non-thinking) mode, so the default is "no_think"; "low"/"high" enable
 * the think tag (slower, unproven benefit for translation).
 * @returns {"no_think"|"low"|"high"}
 */
function translateThinkingMode() {
  const raw = String(process.env.TRANSLATE_THINKING ?? "no_think").trim().toLowerCase();
  if (raw === "true") return "low"; // "thinking on" without a level → low
  if (raw === "false") return "no_think";
  if (["no_think", "low", "high"].includes(raw)) return raw;
  console.warn(`[translate] unknown TRANSLATE_THINKING value "${raw}" — using "no_think".`);
  return "no_think";
}

/**
 * Hy-MT2 sampling. Official 30B-A3B recipe: temperature 0.7, top_p 1.0,
 * top_k -1, repetition_penalty 1.0 (temperature is overridable via
 * TRANSLATE_TEMPERATURE).
 * @returns {{temperature: number, topP: number, topK: number, repetitionPenalty: number}}
 */
function translateSampling() {
  const t = parseFloat(process.env.TRANSLATE_TEMPERATURE ?? "0.7");
  return {
    temperature: Number.isFinite(t) ? t : 0.7,
    topP: 1.0,
    topK: -1,
    repetitionPenalty: 1.0,
  };
}

// ─── Per-volume processing ──────────────────────────────────────────────────

/**
 * Translate one volume: per-chapter idempotent one-shot calls to the
 * translation model, deterministic QA, state persistence, and the merged
 * translation.md.
 *
 * @param {{
 *   volume: {folder: string, sourceFile: string, installmentNumber: string},
 *   volumeDir: string,
 *   bundle: {segments: Array<{id: string, file: string, title: string, chars: number}>},
 *   refs: {terms: Array<{term: string, rendering: string, section: string}>, background: string, styleRules: string, contextHash: string},
 *   template: string,
 *   endpoint: {baseUrl: string, apiKey?: string, model: string},
 *   sampling: {temperature: number, topP: number, topK: number, repetitionPenalty: number},
 *   thinkingMode: "no_think"|"low"|"high",
 *   dryRun: boolean,
 *   force: boolean,
 * }} ctx
 * @returns {Promise<{translated: number, skipped: number, qa: Array<{id: string, title: string, status: string, ok: boolean, cjk: number, lengthRatio: number, warnings: string[]}>}>}
 */
async function processTranslateVolume(ctx) {
  const { volume, volumeDir, bundle, refs, template, endpoint, sampling, thinkingMode, dryRun, force, targetLanguage } = ctx;
  const state = await loadTranslationState(path.join(volumeDir, STATE_FILE));
  const qaRows = [];
  let translated = 0;
  let skipped = 0;
  // Chapters whose model call or deterministic QA failed — isolated per
  // chapter (the draft is not written, so a re-run retries them) rather than
  // aborting the whole volume.
  let failed = 0;
  // The previous chapter's ending (feeds the continuity context of the next
  // chapter's first part).
  let prevChapterTail = "";

  // Chapters are processed SEQUENTIALLY on purpose: each chapter's prompt
  // carries the previous chapter's ending (prevChapterTail) as continuity
  // context, so chapter N+1 depends on chapter N's output. (The independent
  // tasks — verify / retranslate / polish — use runWithConcurrency instead.)
  for (const seg of bundle.segments) {
    const { draftFile, polishedFile } = chapterArtifactNames(seg.id);
    const chapterPath = path.join(volumeDir, seg.file);
    const sourceText = await fs.readFile(chapterPath, "utf8");
    const sourceHash = sha256(sourceText);
    // Only the glossary terms this chapter actually contains go into the
    // prompt — the cumulative glossary would otherwise grow with the series.
    const chapterTerms = chapterTerminology(refs, sourceText);
    if (chapterTerms.dropped > 0 && chapterTerms.present > 0) {
      console.log(
        `  Volume ${volume.installmentNumber} ${seg.id}: ${chapterTerms.present} glossary term(s) apply to this chapter ` +
          `(${refs.terms.length} in the volume glossary; ${chapterTerms.dropped - chapterTerms.present} dropped by the ${glossaryBlockMaxChars()}-char budget).`
      );
    }

    const entry = state.chapters[seg.id] || {};
    const draftPath = path.join(volumeDir, draftFile);
    let existingDraft = "";
    try {
      existingDraft = await fs.readFile(draftPath, "utf8");
    } catch {
      existingDraft = "";
    }
    const upToDate =
      !force &&
      entry.sourceHash === sourceHash &&
      entry.contextHash === refs.contextHash &&
      existingDraft.trim().length > 0;
    if (upToDate) {
      console.log(`  Volume ${volume.installmentNumber} ${seg.id}: draft up to date — skipping.`);
      skipped += 1;
      prevChapterTail = tailOf(existingDraft, continuityChars);
      qaRows.push(await buildQaRow(seg, sourceText, existingDraft, refs, "skipped (up to date)"));
      continue;
    }

    if (dryRun) {
      // Dump the first part's prompt for every chapter a live run would
      // translate (up-to-date chapters were skipped above) — one file per
      // chapter, no AI calls in dry-run.
      const parts = splitChapter(sourceText, chunkChars);
      const tasks = buildTranslationTaskLines({
        terminologyLines: chapterTerms.lines,
        background: refs.background,
        styleRules: refs.styleRules,
        continuityText: "(the previous chapter's ending would go here)",
        targetLanguage,
      });
      const prompt = buildTranslationPrompt({ template, sourceText: parts[0], tasks });
      const file = await writePromptDump(
        `translate-${volume.installmentNumber}-${seg.id}`,
        volume.installmentNumber,
        "one-shot (no system prompt — Hy-MT2 contract)",
        [
          {
            title:
              `One-shot — translate ${seg.id} ` +
              `(endpoint ${endpoint.model} @ ${endpoint.baseUrl}, thinking=${thinkingMode}, ` +
              `sampling=${JSON.stringify(sampling)})`,
            prompt,
          },
        ]
      );
      console.log(`  Volume ${volume.installmentNumber} ${seg.id}: --dry-run prompt dump → ${file}`);
      continue;
    }

    // Translate the chapter part by part (oversized chapters are split; each
    // part continues the previous one). A per-chapter try/catch isolates
    // failures: a bad chapter (truncated/empty model output, or a
    // deterministic-QA hard fail) is marked FAILED and the loop moves on
    // instead of aborting the whole volume — the draft is simply not written,
    // so a re-run retries it. prevChapterTail keeps the last good chapter's
    // ending for the next chapter's continuity context.
    try {
    const parts = splitChapter(sourceText, chunkChars);
    const partTexts = [];
    let continuity = prevChapterTail;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const tasks = buildTranslationTaskLines({
        terminologyLines: chapterTerms.lines,
        background: refs.background,
        styleRules: refs.styleRules,
        continuityText: continuity,
        targetLanguage,
      });
      const prompt = buildTranslationPrompt({ template, sourceText: part, tasks });
      console.log(
        `  Volume ${volume.installmentNumber} ${seg.id}: translating part ${i + 1}/${parts.length} ` +
          `(${part.length} chars) with ${endpoint.model}…`
      );
      const result = await harness.runOneShot({
        // NO system prompt — Hy-MT2's official contract is a single user
        // message (systemPrompt: null sends none).
        systemPrompt: null,
        messages: [{ text: prompt }],
        endpoint,
        temperature: sampling.temperature,
        sampling: {
          topP: sampling.topP,
          topK: sampling.topK,
          repetitionPenalty: sampling.repetitionPenalty,
        },
        thinking: thinkingMode,
        thinkingTemplate: "hy-mt",
        label: `translate-v${volume.installmentNumber}-${seg.id}-${parts.length > 1 ? "part" + (i + 1) : "full"}`,
      });
      const clean = stripMarkdownFence(result);
      if (!clean) {
        throw new Error(
          `Volume ${volume.installmentNumber} ${seg.id}: the model returned no content for part ${i + 1}. ` +
            `Check the run log: .logs/`
        );
      }
      // Continuity dedup: when the model repeats the previous part's ending
      // (the continuity tail it was given) at the start of its reply, strip
      // the duplicated prefix so the merged draft has no repeated passage.
      const deduped = i > 0 ? stripContinuityOverlap(partTexts[i - 1], clean) : clean;
      partTexts.push(deduped);
      continuity = tailOf(deduped, continuityChars);
    }
    const draft = partTexts.join("\n\n");

    // Deterministic QA (no AI): hard failures mean the draft is unusable —
    // fail the chapter BEFORE persisting (no corrupted draft on disk).
    const qa = checkTranslationQa({ sourceText, draftText: draft, terms: refs.terms });
    if (!qa.ok) {
      throw new Error(
        `Volume ${volume.installmentNumber} ${seg.id}: translation QA failed: ${qa.errors.join("; ")}. ` +
          `The draft was NOT written — check the model output in .logs/ and re-run.`
      );
    }

    await fs.writeFile(draftPath, draft + "\n", "utf8");
    state.chapters[seg.id] = {
      sourceHash,
      contextHash: refs.contextHash,
      // Hash of the FILE content as written (with trailing newline) — the
      // skip-checks elsewhere compare against the on-disk file.
      draftHash: sha256(draft + "\n"),
      retranslated: false,
      findingsHash: null,
      // A fresh draft invalidates any earlier polish pass (and its file).
      polishedDraftHash: null,
    };
    await fs.rm(path.join(volumeDir, polishedFile), { force: true });
    // Persist per chapter — a crash mid-volume resumes at the next chapter.
    await saveTranslationState(path.join(volumeDir, STATE_FILE), state);
    translated += 1;
    prevChapterTail = tailOf(draft, continuityChars);
    qaRows.push(await buildQaRow(seg, sourceText, draft, refs, qa.warnings));
    if (qa.warnings.length > 0) {
      console.warn(`  Volume ${volume.installmentNumber} ${seg.id}: QA warning: ${qa.warnings.join("; ")}`);
    }
    } catch (err) {
      failed += 1;
      console.error(
        `  Volume ${volume.installmentNumber} ${seg.id}: FAILED — ${err.message} The draft was NOT ` +
          `written, so the chapter will be retried on re-run (no state entry was saved).`
      );
      qaRows.push({
        id: seg.id,
        title: seg.title,
        status: `failed — ${err.message}`,
        ok: false,
        cjk: 0,
        lengthRatio: 0,
        warnings: [],
      });
    }
  }

  // Merge the volume's chapters (the polished text wins when it was produced
  // from the CURRENT draft, otherwise the draft) — rewritten even when every
  // chapter was skipped (the merged file may be missing after a crash).
  const mergedText = await mergeVolumeTranslationFiles(volumeDir, bundle, state);
  if (mergedText) {
    await fs.writeFile(path.join(volumeDir, MERGED_FILE), mergedText, "utf8");
  }
  await fs.writeFile(
    path.join(volumeDir, QA_REPORT_FILE),
    buildQaReportMarkdown(volume, qaRows),
    "utf8"
  );
  return { translated, skipped, failed, qa: qaRows };
}

/**
 * Read a file's content or "" when it does not exist.
 *
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function readFileOrEmpty(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

/**
 * Merge a volume's chapter files into the translation.md content: the
 * polished file is used when the state shows it was produced from the
 * CURRENT draft (polishedDraftHash === draftHash), otherwise the draft.
 *
 * @param {string} volumeDir
 * @param {{segments: Array<{id: string, title: string}>}} bundle
 * @param {{chapters: Object}} state
 * @returns {Promise<string>} The merged text ("" when no chapter has text).
 */
async function mergeVolumeTranslationFiles(volumeDir, bundle, state) {
  // Resolve the per-chapter texts first (the pure merge helper takes a sync
  // getter).
  const resolved = new Map();
  for (const seg of bundle.segments) {
    const { draftFile, polishedFile } = chapterArtifactNames(seg.id);
    const entry = state.chapters[seg.id] || {};
    let text = "";
    if (
      entry.draftHash &&
      entry.polishedDraftHash === entry.draftHash &&
      (await fileExists(path.join(volumeDir, polishedFile)))
    ) {
      text = await readFileOrEmpty(path.join(volumeDir, polishedFile));
    } else {
      text = await readFileOrEmpty(path.join(volumeDir, draftFile));
    }
    resolved.set(seg.id, text.trim() || null);
  }
  // Completeness gate. The merge used to skip a chapter with no text, so a
  // volume could be published as translation.md with chapters missing from the
  // middle: the file looked complete, the merge reported success, and nothing
  // said chapter 7 was never translated. A partial volume is a failure, not a
  // deliverable — and it is a STRUCTURAL one, so no ON_VOLUME_ERROR=skip can
  // walk past it.
  const missing = findMissingSegments(bundle.segments, (seg) => resolved.get(seg.id) || null);
  if (missing.length > 0) {
    throw structuralError(
      `${volumeDir}: the merged translation is INCOMPLETE — ${missing.length} of ` +
        `${bundle.segments.length} chapter(s) have no text: ${missing.map((m) => m.id).join(", ")}. ` +
        `translation.md is not written for this volume. Run the translate task to produce the ` +
        `missing drafts (a chapter that failed a model call is retried on a re-run); if a chapter ` +
        `keeps failing, check the agent transcript under .logs/.`
    );
  }
  return mergeVolumeTranslation({
    segments: bundle.segments,
    getText: (seg) => resolved.get(seg.id) || null,
  });
}

/**
 * Build one QA-report row for a chapter (re-runs the deterministic checks on
 * the given text — the report is always in sync with the files on disk).
 *
 * @param {{id: string, title: string}} seg
 * @param {string} sourceText
 * @param {string} draftText
 * @param {{terms: Array<{term: string, rendering: string}>}} refs
 * @param {string|string[]} statusOrWarnings - A status string (skipped) or
 *   the warnings array from the chapter's own QA run.
 * @returns {{id: string, title: string, status: string, ok: boolean, cjk: number, lengthRatio: number, warnings: string[]}}
 */
function buildQaRow(seg, sourceText, draftText, refs, statusOrWarnings) {
  const qa = checkTranslationQa({ sourceText, draftText, terms: refs.terms });
  const status =
    typeof statusOrWarnings === "string"
      ? statusOrWarnings
      : qa.warnings.length > 0
        ? "translated — with warnings"
        : "translated";
  const warnings = typeof statusOrWarnings === "string" ? qa.warnings : statusOrWarnings;
  return {
    id: seg.id,
    title: seg.title,
    status,
    ok: qa.ok,
    cjk: qa.cjk,
    lengthRatio: qa.lengthRatio,
    warnings,
  };
}

/**
 * Build the per-volume deterministic QA report (translation-qa.md).
 *
 * @param {{installmentNumber: string, folder: string}} volume
 * @param {Array<{id: string, title: string, status: string, ok: boolean, cjk: number, lengthRatio: number, warnings: string[]}>} qaRows
 * @returns {string} The Markdown report.
 */
function buildQaReportMarkdown(volume, qaRows) {
  const lines = [];
  lines.push(`# Translation QA — Volume ${volume.installmentNumber} (${volume.folder})`);
  lines.push("");
  lines.push(
    "_Deterministic audit of the chapter drafts (no AI): residual CJK ratio, length ratio vs the " +
      "source, and glossary-term coverage. CJK > 5% or an empty draft fails the chapter; CJK > 0.5%, " +
      "length ratio outside 0.6–2.5, and missing glossary renderings are warnings. Generated by the " +
      "translate task; refreshed on every run (including skipped chapters)._"
  );
  lines.push("");
  lines.push("| Chapter | Title | Status | CJK % | Length ratio | Warnings |");
  lines.push("|---|---|---|---|---|---|");
  for (const row of qaRows) {
    lines.push(
      `| ${row.id} | ${row.title || "—"} | ${row.ok ? row.status : row.status + " — FAILED"} | ` +
        `${(row.cjk * 100).toFixed(2)} | ${Number.isFinite(row.lengthRatio) ? row.lengthRatio.toFixed(2) : "n/a"} | ` +
        (row.warnings.length > 0 ? row.warnings.join("; ") : "—") +
        " |"
    );
  }
  lines.push("");
  const failed = qaRows.filter((r) => !r.ok);
  if (failed.length > 0) {
    lines.push(`**${failed.length} chapter(s) FAILED deterministic QA.**`);
    lines.push("");
  }
  return lines.join("\n");
}

// ─── Task entry ─────────────────────────────────────────────────────────────

/**
 * Run the translate task (all volumes, or --volume NN).
 *
 * @returns {Promise<void>}
 */
async function translate() {
  const dryRun = process.argv.includes("--dry-run");
  const force = process.argv.includes("--force");

  if (!seriesDir) {
    throw new Error("SERIES_LOCATION is not set. Please set it in .env.");
  }
  validateRequiredEnv({ dryRun });

  const endpoint = roleEndpoint("TRANSLATE");
  const sampling = translateSampling();
  const thinkingMode = translateThinkingMode();

  // Control-plane check BEFORE any call (skipped in dry-run — offline).
  if (!dryRun) {
    await harness.assertModelServing({ ...endpoint, label: "translate stage" });
  }

  const template = await fs.readFile(translateTemplateFile, "utf-8");

  // --force here means "redo THIS stage" — it does NOT re-run the intake (see getTranslationTarget).
  const manifest = await getTranslationTarget({ dryRun });
  // The target language the translation prompt is written for: .env override >
  // the intake manifest's decision > the default.
  const runSettings = resolveRunSettings(manifest);
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
    // Resolved through the manifest's installment numbers, not by parsing folder
    // names — the intake agent chooses the folder names.
    volumes = filterVolumesByInstallment(manifest, volumeArg);
    if (volumes.length === 0) {
      throw new Error(
        `No volume matching --volume ${volumeArg} (manifest volumes: ` +
          `${manifest.volumes.map((v) => `${v.installmentNumber} = ${v.folder}`).join(", ")}).`
      );
    }
    console.log(`--volume: processing only ${volumes.join(", ")}`);
  }

  console.log(
    `[translate] ${sorted.length} volume folder(s); endpoint ${endpoint.model} @ ${endpoint.baseUrl} ` +
      `(model from ${endpoint.modelSource}, base from ${endpoint.baseUrlSource}); ` +
      `thinking=${thinkingMode}; chunk=${chunkChars} chars; continuity=${continuityChars} chars.`
  );

  const failedVolumes = [];
  let totalTranslated = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (const folderName of volumes) {
    const volume = volumeByFolder.get(folderName);
    const volumeDir = path.join(seriesDir, folderName);
    try {
      const bundle = await resolveSourceBundle({ seriesDir, volume, volumeDir, force });
      const refs = await loadVolumeReferences(volumeDir);
      const result = await processTranslateVolume({
        volume,
        volumeDir,
        bundle,
        refs,
        template,
        endpoint,
        sampling,
        thinkingMode,
        dryRun,
        force,
        targetLanguage: runSettings.targetLanguage,
      });
      totalTranslated += result.translated;
      totalSkipped += result.skipped;
      totalFailed += result.failed;
      console.log(
        `[translate] Volume ${volume.installmentNumber}: ${result.translated} translated, ` +
          `${result.skipped} skipped` +
          (result.failed > 0 ? `, ${result.failed} FAILED` : "") +
          "."
      );
    } catch (err) {
      // A STRUCTURAL failure (a source file that vanished, an archive that will not
      // open, a volume whose chapters are incomplete) is never skippable: ON_VOLUME_ERROR
      //=skip exists for flaky model calls, not for a broken book.
      if (ON_VOLUME_ERROR === "skip" && !isStructuralError(err)) {
        console.error(
          `[skip] Volume ${volume.installmentNumber} (${folderName}) failed: ${err.message}`
        );
        failedVolumes.push(volume.installmentNumber);
        continue;
      }
      throw err;
    }
  }

  console.log(
    `[translate] Done: ${totalTranslated} chapter(s) translated, ${totalSkipped} skipped` +
      (totalFailed > 0 ? `, ${totalFailed} chapter(s) FAILED` : "") +
      (failedVolumes.length > 0 ? `, ${failedVolumes.length} volume(s) FAILED: ${failedVolumes.join(", ")}` : "") +
      "."
  );
  if (failedVolumes.length > 0) {
    throw new Error(
      `${failedVolumes.length} of ${volumes.length} volume(s) failed: ${failedVolumes.join(", ")} ` +
        `(ON_VOLUME_ERROR=skip — the failed volumes can be picked up on a re-run).`
    );
  }
  if (totalFailed > 0) {
    throw new Error(
      `${totalFailed} chapter(s) failed (model call or deterministic QA) and were left untranslated — ` +
        `re-run the translate task to retry them (idempotent skips keep it cheap).`
    );
  }
}

module.exports = {
  translate,
  processTranslateVolume,
  chapterArtifactNames,
  STATE_FILE,
  QA_REPORT_FILE,
  MERGED_FILE,
  mergeVolumeTranslationFiles,
  buildQaRow,
  buildQaReportMarkdown,
  translateThinkingMode,
  translateSampling,
  translateChunkChars,
  translateContinuityChars,
};