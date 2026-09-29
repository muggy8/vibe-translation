/**
 * verify-translate.js — Logic for the "verify-translate" gulp task: the
 * source-anchored verification pass of the translation pipeline.
 *
 * Task: verify-translate
 *   For each volume, for each chapter that has a translation-<id>.md draft:
 *     1. Skip it when the verification sidecar (translation-verification.json)
 *        already covers the CURRENT source + draft hashes (idempotency;
 *        --force re-verifies).
 *     2. One-shot call to the verify model (Qwen3.8-27B via VERIFY_* env):
 *        source + draft + glossary + style rules + story background
 *        (shared wiki + volume wiki + POV map — refs.background) → a
 *        0–100 score with banded rubric + severity-banded findings
 *        (system-prompts/verify-translate.md, user-prompts/verify-translate.md).
 *     3. PASS when the score >= VERIFY_PASSING_SCORE (default 70). An
 *        unparseable score is a FAIL (fail-closed) — the retranslate task
 *        gets another shot at the chapter.
 *     4. Persist the sidecar entry + write the per-volume report
 *        (translation-verification.md).
 *
 * Chapters that FAIL are retranslated by the "retranslate" task (Hy-MT2,
 * using the findings as correction instructions); the pipeline re-runs
 * verify-translate afterwards. Set VERIFY_TRANSLATE_ENABLED=false to make
 * this task a no-op (retranslate is disabled with it — they are one QA
 * chain).
 *
 * Usage:
 *   npx gulp verify-translate              # run the full task
 *   npx gulp verify-translate --dry-run    # dump the prompts only, no AI calls
 *   npx gulp verify-translate --force      # re-verify even if covered
 *   npx gulp verify-translate --volume 01  # single volume
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
const { transformUserPrompt, parseAcceptanceScore, writePromptDump } = require("./utils/prompt");
const { sha256, roleEndpoint, loadVolumeReferences, runWithConcurrency, stageConcurrency } = require("./utils/translate");
const { chapterArtifactNames } = require("./translate");

// ─── Paths & config ──────────────────────────────────────────────────────────

const clientDir = __dirname;
const seriesDir = process.env.SERIES_LOCATION;

const verifySystemPromptFile = path.join(clientDir, "system-prompts", "verify-translate.md");
const verifyTemplateFile = path.join(clientDir, "user-prompts", "verify-translate.md");

const VERIFICATION_FILE = "translation-verification.json";
const VERIFICATION_REPORT = "translation-verification.md";

/** Verification is default-ON (it is the QA chain with retranslate). */
const verifyEnabled = process.env.VERIFY_TRANSLATE_ENABLED !== "false";
/** Chapter concurrency within a volume (opt-in; default 1 = serial — the
 *  local hardware runs one inference at a time). */
const verifyConcurrency = stageConcurrency("VERIFY");
/** Score (0–100) at or above which a chapter passes verification. */
const passingScore = Math.min(100, Math.max(0, parseInt(process.env.VERIFY_PASSING_SCORE, 10) || 70));
/** The verify model's thinking level (Qwen3-style dialect). */
const verifyThinkingLevel = process.env.VERIFY_THINKING_LEVEL || "medium";
const verifyThinking = process.env.VERIFY_THINKING !== "false";
const verifyTemperature = parseFloat(process.env.VERIFY_TEMPERATURE ?? "0.2");
/** Findings are injected into the retranslate prompt — keep them bounded. */
const FINDINGS_MAX_CHARS = 6000;

/**
 * Load the verification sidecar (fail-open: missing/corrupt → {}).
 *
 * @param {string} filePath
 * @returns {Promise<{chapters: Object}>}
 */
async function loadVerificationSidecar(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || typeof data.chapters !== "object" || data.chapters === null) {
      return { chapters: {} };
    }
    return data;
  } catch {
    return { chapters: {} };
  }
}

// ─── Per-volume processing ──────────────────────────────────────────────────

/**
 * Extract the findings from the verifier's reply for the sidecar's
 * `findings` field (the retranslate prompt's "fix these problems" task).
 * The score-line prefix is dropped — it is meaningless to a retranslator —
 * keeping the reply from the "## Findings" marker on. When the marker is
 * absent (off-format reply) the whole trimmed reply is kept.
 *
 * @param {string} raw - The verifier's full reply.
 * @returns {string} The findings text, bounded to FINDINGS_MAX_CHARS.
 */
function findingsOf(raw) {
  const text = (raw || "").trim();
  const idx = text.indexOf("## Findings");
  return (idx >= 0 ? text.slice(idx) : text).slice(0, FINDINGS_MAX_CHARS);
}

/**
 * Verify one volume's chapter drafts against their sources.
 *
 * @param {{
 *   volume: {folder: string, sourceFile: string, installmentNumber: string},
 *   volumeDir: string,
 *   bundle: {segments: Array<{id: string, file: string, title: string, chars: number}>},
 *   refs: {terms: Array<{term: string, rendering: string}>, styleRules: string, background: string},
 *   systemPrompt: string,
 *   template: string,
 *   endpoint: {baseUrl: string, apiKey?: string, model: string},
 *   dryRun: boolean,
 *   force: boolean,
 * }} ctx
 * @returns {Promise<{verified: number, skipped: number, passed: number, failed: number, noDraft: number}>}
 */
async function processVerifyVolume(ctx) {
  const { volume, volumeDir, bundle, refs, systemPrompt, template, endpoint, dryRun, force } = ctx;
  const sidecarPath = path.join(volumeDir, VERIFICATION_FILE);
  const sidecar = await loadVerificationSidecar(sidecarPath);
  const rows = [];
  let verified = 0;
  let skipped = 0;
  let passed = 0;
  let failed = 0;
  let noDraft = 0;

  // Chapters are INDEPENDENT (each is verified against its own source +
  // draft), so they can run in parallel when VERIFY_CONCURRENCY > 1. Rows are
  // stored by index to keep the report in reading order.
  await runWithConcurrency(bundle.segments, verifyConcurrency, async (seg, idx) => {
    const { draftFile } = chapterArtifactNames(seg.id);
    const chapterPath = path.join(volumeDir, seg.file);
    const draftPath = path.join(volumeDir, draftFile);
    if (!(await fileExists(draftPath))) {
      console.warn(
        `  Volume ${volume.installmentNumber} ${seg.id}: no draft (${draftFile}) — run the translate task first.`
      );
      noDraft += 1;
      rows[idx] = { id: seg.id, title: seg.title, status: "no draft (run translate first)", score: null, pass: null };
      return;
    }
    const sourceText = await fs.readFile(chapterPath, "utf8");
    const draft = await fs.readFile(draftPath, "utf8");
    const sourceHash = sha256(sourceText);
    const draftHash = sha256(draft);

    const entry = sidecar.chapters[seg.id] || {};
    const covered =
      !force &&
      typeof entry.sourceHash === "string" &&
      entry.sourceHash === sourceHash &&
      typeof entry.draftHash === "string" &&
      entry.draftHash === draftHash;
    if (covered) {
      console.log(`  Volume ${volume.installmentNumber} ${seg.id}: verification up to date — skipping.`);
      skipped += 1;
      if (entry.pass) passed += 1;
      else failed += 1;
      rows[idx] = {
        id: seg.id,
        title: seg.title,
        status: "skipped (up to date)",
        score: entry.score,
        pass: entry.pass,
        findings: entry.findings,
      };
      return;
    }

    const values = {
      SOURCE_TEXT: sourceText,
      TRANSLATION_TEXT: draft,
      GLOSSARY: glossaryBlock(refs.terms),
      STYLE_RULES: refs.styleRules || "(none provided — run the style-guide task)",
      BACKGROUND: refs.background || "(none provided — run the jump-in-wiki task)",
    };
    const prompt = transformUserPrompt(template, values);

    if (dryRun) {
      // Dump the prompt for every chapter a live run would verify (no-draft
      // and already-covered chapters were skipped above) — one file per
      // chapter, no AI calls in dry-run.
      const file = await writePromptDump(
        `verify-translate-${volume.installmentNumber}-${seg.id}`,
        volume.installmentNumber,
        "one-shot (verify model)",
        [
          { title: "One-shot — verify system prompt", prompt: systemPrompt },
          {
            title:
              `One-shot — verify ${seg.id} ` +
              `(endpoint ${endpoint.model} @ ${endpoint.baseUrl}, thinking=${verifyThinking ? verifyThinkingLevel : "off"})`,
            prompt,
          },
        ]
      );
      console.log(`  Volume ${volume.installmentNumber} ${seg.id}: --dry-run prompt dump → ${file}`);
      return;
    }

    console.log(
      `  Volume ${volume.installmentNumber} ${seg.id}: verifying draft (${draft.length} chars) with ${endpoint.model}…`
    );
    const result = await harness.runOneShot({
      systemPrompt,
      messages: [{ text: prompt }],
      endpoint,
      temperature: Number.isFinite(verifyTemperature) ? verifyTemperature : 0.2,
      thinking: verifyThinking,
      thinkingLevel: verifyThinkingLevel,
      label: `verify-v${volume.installmentNumber}-${seg.id}`,
    });

    // Fail-closed: an unparseable score is a FAIL (the retranslate pass gets
    // another shot at the chapter).
    const score = parseAcceptanceScore(result);
    const pass = score !== null && score >= passingScore;
    const findings = findingsOf(result);
    sidecar.chapters[seg.id] = {
      sourceHash,
      draftHash,
      score,
      pass,
      findings,
      verifiedAt: new Date().toISOString(),
    };
    await fs.writeFile(sidecarPath, JSON.stringify(sidecar, null, 2) + "\n", "utf8");
    verified += 1;
    if (pass) passed += 1;
    else failed += 1;
    console.log(
      `  Volume ${volume.installmentNumber} ${seg.id}: score ${score === null ? "n/a (unparseable — FAIL)" : score + "/100"} → ${pass ? "PASS" : "FAIL"}.`
    );
    rows[idx] = { id: seg.id, title: seg.title, status: "verified", score, pass, findings };
  });

  await fs.writeFile(
    path.join(volumeDir, VERIFICATION_REPORT),
    buildVerificationReportMarkdown(volume, rows),
    "utf8"
  );
  return { verified, skipped, passed, failed, noDraft };
}

/**
 * Build the glossary block for the verify/polish prompts.
 *
 * @param {Array<{term: string, rendering: string}>} terms
 * @returns {string} One line per term, or the "none provided" marker.
 */
function glossaryBlock(terms) {
  if (!terms || terms.length === 0) return "(none provided — run the glossary task)";
  return terms.map((t) => `"${t.term}" → "${t.rendering}"`).join("\n");
}

/**
 * Build the per-volume verification report (translation-verification.md):
 * the score table plus each failing chapter's findings (the input the
 * retranslate task consumes).
 *
 * @param {{installmentNumber: string, folder: string}} volume
 * @param {Array<{id: string, title: string, status: string, score: number|null, pass: boolean|null, findings?: string}>} rows
 * @returns {string} The Markdown report.
 */
function buildVerificationReportMarkdown(volume, rows) {
  const lines = [];
  lines.push(`# Translation Verification — Volume ${volume.installmentNumber} (${volume.folder})`);
  lines.push("");
  lines.push(
    `_Source-anchored verification by the verify model (score 0–100, banded rubric; PASS at or above ` +
      `${passingScore}). An unparseable score is a FAIL (fail-closed). Failing chapters are ` +
      `retranslated by the "retranslate" task using the findings below, then re-verified._`
  );
  lines.push("");
  lines.push("| Chapter | Title | Status | Score | Verdict |");
  lines.push("|---|---|---|---|---|");
  for (const row of rows) {
    lines.push(
      `| ${row.id} | ${row.title || "—"} | ${row.status} | ` +
        `${row.score === null ? "n/a" : row.score + "/100"} | ${row.pass === null ? "—" : row.pass ? "PASS" : "FAIL"} |`
    );
  }
  lines.push("");
  for (const row of rows.filter((r) => r.pass === false && r.findings)) {
    lines.push(`## Findings — ${row.id} (${row.title || "untitled"})`);
    lines.push("");
    lines.push(row.findings);
    lines.push("");
  }
  return lines.join("\n");
}

// ─── Task entry ─────────────────────────────────────────────────────────────

/**
 * Run the verify-translate task (all volumes, or --volume NN).
 *
 * Returns the aggregated run summary — the translate-qa loop reads
 * `failed` to decide whether the validator is happy. (A volume that fails
 * the run under ON_VOLUME_ERROR=skip still throws, as before.)
 *
 * @returns {Promise<{verified: number, passed: number, failed: number, skipped: number, noDraft: number}>}
 */
async function verifyTranslate() {
  const dryRun = process.argv.includes("--dry-run");
  const force = process.argv.includes("--force");

  if (!verifyEnabled) {
    console.log(
      "[verify-translate] VERIFY_TRANSLATE_ENABLED=false — verification (and the retranslate pass) are disabled. Nothing to do."
    );
    return;
  }
  if (!seriesDir) {
    throw new Error("SERIES_LOCATION is not set. Please set it in .env.");
  }
  validateRequiredEnv({ dryRun });

  const endpoint = roleEndpoint("VERIFY");
  if (!dryRun) {
    await harness.assertModelServing({ ...endpoint, label: "verify-translate stage" });
  }

  const systemPrompt = await fs.readFile(verifySystemPromptFile, "utf-8");
  const template = await fs.readFile(verifyTemplateFile, "utf-8");

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
    `[verify-translate] ${sorted.length} volume folder(s); endpoint ${endpoint.model} @ ${endpoint.baseUrl} ` +
      `(model from ${endpoint.modelSource}, base from ${endpoint.baseUrlSource}); ` +
      `passing score ${passingScore}; thinking=${verifyThinking ? verifyThinkingLevel : "off"}; ` +
      `concurrency=${verifyConcurrency}.`
  );

  const failedVolumes = [];
  let totalVerified = 0;
  let totalPassed = 0;
  let totalFailed = 0;
  let totalSkipped = 0;
  let totalNoDraft = 0;

  for (const folderName of volumes) {
    const volume = volumeByFolder.get(folderName);
    const volumeDir = path.join(seriesDir, folderName);
    try {
      const bundle = await resolveSourceBundle({ seriesDir, volume, volumeDir, force });
      const refs = await loadVolumeReferences(volumeDir);
      const result = await processVerifyVolume({
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
      totalVerified += result.verified;
      totalPassed += result.passed;
      totalFailed += result.failed;
      totalSkipped += result.skipped;
      totalNoDraft += result.noDraft;
      console.log(
        `[verify-translate] Volume ${volume.installmentNumber}: ${result.verified} verified, ` +
          `${result.passed} PASS, ${result.failed} FAIL, ${result.skipped} skipped, ${result.noDraft} without draft.`
      );
    } catch (err) {
      if (ON_VOLUME_ERROR === "skip") {
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
    `[verify-translate] Done: ${totalVerified} chapter(s) verified this run — ${totalPassed} PASS, ${totalFailed} FAIL ` +
      `(FAILs are retranslated by the "retranslate" task).`
  );
  if (failedVolumes.length > 0) {
    throw new Error(
      `${failedVolumes.length} of ${volumes.length} volume(s) failed: ${failedVolumes.join(", ")}.`
    );
  }
  return {
    verified: totalVerified,
    passed: totalPassed,
    failed: totalFailed,
    skipped: totalSkipped,
    noDraft: totalNoDraft,
  };
}

module.exports = {
  verifyTranslate,
  processVerifyVolume,
  loadVerificationSidecar,
  buildVerificationReportMarkdown,
  glossaryBlock,
  findingsOf,
  VERIFICATION_FILE,
  VERIFICATION_REPORT,
  passingScore,
};