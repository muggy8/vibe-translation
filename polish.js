/**
 * polish.js — Logic for the "polish" gulp task: the final pass of the
 * translation pipeline.
 *
 * Task: polish
 *   For each volume, for each chapter that has a translation-<id>.md draft:
 *     1. Skip it when the state shows the polished-<id>.md file was produced
 *        from the CURRENT draft AND passed the drift check
 *        (draftHash === polishedDraftHash === polishVerifiedDraftHash) —
 *        idempotency; --force re-polishes. A polished file from a
 *        pre-inspector run (no polishVerifiedDraftHash) is drift-checked
 *        instead of re-polished (one inspector call, no fresh pass).
 *     2. One-shot call to the edit model (Qwen3.8-27B via EDIT_* env):
 *        current draft + glossary + style rules + character voice notes →
 *        the complete polished chapter (system-prompts/polish.md,
 *        user-prompts/polish.md). The polisher sees NO source text — its
 *        role is surface cleanup of already-verified text (no re-translation
 *        by a non-translation model). Thinking is ON (default: medium).
 *     3. Deterministic regression guard: if the polished text FAILS the QA
 *        the draft passed, or LOSES glossary coverage the draft had, the
 *        attempt is rejected and the guard's findings become correction
 *        tasks for the next attempt.
 *     4. AI drift check (source-aware, default-ON): a one-shot auditor on
 *        the SAME endpoint (system-prompts/polish-verify.md,
 *        user-prompts/polish-verify.md) scores whether the polished text
 *        preserves the verified draft's meaning, using the source as ground
 *        truth → 0–100 (fail-closed: unparseable = FAIL).
 *        PASS >= POLISH_VERIFY_PASSING_SCORE (default 70).
 *     5. Steps 2–4 loop up to POLISH_QA_MAX_ROUNDS (default 3) attempts per
 *        chapter: a FAIL re-polishes with the findings injected as a
 *        numbered "fix these" task (the retranslate pattern). On
 *        exhaustion the polished text is rejected, the draft is kept, and
 *        the last findings persist in the state — the next run re-polishes
 *        with them (or --force for a fresh attempt).
 *     6. On PASS: write polished-<id>.md, record polishedDraftHash +
 *        polishVerifiedDraftHash in the state, write the
 *        polish-verification.json sidecar, and re-merge the volume's
 *        translation.md (polished text wins).
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
const { transformUserPrompt, parseAcceptanceScore, writePromptDump } = require("./utils/prompt");
const {
  sha256,
  checkTranslationQa,
  buildPolishGuardFindings,
  stripMarkdownFence,
  loadTranslationState,
  saveTranslationState,
  roleEndpoint,
  loadVolumeReferences,
} = require("./utils/translate");
const { chapterArtifactNames, mergeVolumeTranslationFiles } = require("./translate");
const { glossaryBlock, loadVerificationSidecar, findingsOf } = require("./verify-translate");

// ─── Paths & config ──────────────────────────────────────────────────────────

const clientDir = __dirname;
const seriesDir = process.env.SERIES_LOCATION;

const polishSystemPromptFile = path.join(clientDir, "system-prompts", "polish.md");
const polishTemplateFile = path.join(clientDir, "user-prompts", "polish.md");
const polishVerifySystemPromptFile = path.join(clientDir, "system-prompts", "polish-verify.md");
const polishVerifyTemplateFile = path.join(clientDir, "user-prompts", "polish-verify.md");

const POLISH_QA_REPORT = "polish-qa.md";
const POLISH_VERIFICATION_FILE = "polish-verification.json";

const polishThinkingLevel = process.env.EDIT_THINKING_LEVEL || "medium";
const polishThinking = process.env.EDIT_THINKING !== "false";
const polishTemperature = parseFloat(process.env.EDIT_TEMPERATURE ?? "0.6");

/** The source-aware drift inspector — default-ON (the semantic backstop for
 *  the source-free polish pass). POLISH_VERIFY_ENABLED=false gates the pass
 *  on the deterministic regression guard only. */
const polishVerifyEnabled = process.env.POLISH_VERIFY_ENABLED !== "false";
/** Score (0–100) at or above which a polished text passes the drift check. */
const polishVerifyPassingScore = Math.min(
  100,
  Math.max(0, parseInt(process.env.POLISH_VERIFY_PASSING_SCORE, 10) || 70)
);
/** Drift-inspector sampling temperature (a judgment call — low, like verification). */
const polishVerifyTemperature = parseFloat(process.env.POLISH_VERIFY_TEMPERATURE ?? "0.2");
/** Max [polish + drift check] attempts per chapter (a FAIL re-polishes with
 *  the findings injected as correction tasks). */
const polishMaxRounds = (() => {
  const parsed = parseInt(process.env.POLISH_QA_MAX_ROUNDS, 10);
  return Number.isFinite(parsed) ? Math.max(1, parsed) : 3;
})();
/** Findings injected into the re-polish prompt — keep them bounded (a
 *  numbered correction task, not a document to re-read). */
const POLISH_FINDINGS_MAX_CHARS = 3000;

// ─── Per-volume processing ──────────────────────────────────────────────────

/**
 * Polish one volume's chapter drafts.
 *
 * @param {{
 *   volume: {folder: string, sourceFile: string, installmentNumber: string},
 *   volumeDir: string,
 *   bundle: {segments: Array<{id: string, file: string, title: string, chars: number}>},
 *   refs: {terms: Array<{term: string, rendering: string}>, styleRules: string, voiceNotes: string, contextHash: string},
 *   systemPrompt: string,
 *   template: string,
 *   verifySystemPrompt: string|null,
 *   verifyTemplate: string|null,
 *   endpoint: {baseUrl: string, apiKey?: string, model: string},
 *   dryRun: boolean,
 *   force: boolean,
 * }} ctx
 * @returns {Promise<{polished: number, skipped: number, rejected: number, noDraft: number}>}
 */
async function processPolishVolume(ctx) {
  const {
    volume,
    volumeDir,
    bundle,
    refs,
    systemPrompt,
    template,
    verifySystemPrompt,
    verifyTemplate,
    endpoint,
    dryRun,
    force,
  } = ctx;
  const state = await loadTranslationState(path.join(volumeDir, "translation-state.json"));
  const sidecar = await loadVerificationSidecar(path.join(volumeDir, POLISH_VERIFICATION_FILE));
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
      rows.push({ id: seg.id, title: seg.title, status: "no draft", ok: true, score: null, warnings: [] });
      continue;
    }
    const sourceText = await fs.readFile(chapterPath, "utf8");
    const draft = await fs.readFile(draftPath, "utf8");
    const sourceHash = sha256(sourceText);
    const draftHash = sha256(draft);
    const sEntry = state.chapters[seg.id] || {};

    const upToDate =
      !force &&
      sEntry.draftHash === draftHash &&
      sEntry.polishedDraftHash === draftHash &&
      sEntry.polishVerifiedDraftHash === draftHash &&
      (await fileExists(polishedPath));
    if (upToDate) {
      console.log(`  Volume ${volume.installmentNumber} ${seg.id}: polish up to date — skipping.`);
      skipped += 1;
      rows.push({ id: seg.id, title: seg.title, status: "skipped (up to date)", ok: true, score: null, warnings: [] });
      continue;
    }

    // A polished file produced from the CURRENT draft but never drift-verified
    // (a pre-inspector run): inspect the existing text instead of re-polishing
    // (one inspector call, no fresh stochastic pass).
    const hasExistingPolish =
      !force && sEntry.polishedDraftHash === draftHash && (await fileExists(polishedPath));

    // Findings persisted by a previously rejected run seed the first attempt.
    let findings =
      !hasExistingPolish && typeof sEntry.polishFindings === "string" && sEntry.polishFindings
        ? sEntry.polishFindings
        : "";

    if (dryRun) {
      // Dump the prompts for every chapter a live run would polish (no-draft
      // and up-to-date chapters were skipped above) — one file per chapter,
      // no AI calls in dry-run. The drift-check prompt's polished-text input
      // is the output of the polish call (unavailable in dry-run).
      const values = {
        TRANSLATION_TEXT: draft,
        GLOSSARY: glossaryBlock(refs.terms),
        STYLE_RULES: refs.styleRules || "(none provided — run the style-guide task)",
        VOICE_NOTES: refs.voiceNotes || "(none provided — run the character-voice task)",
        POLISH_FINDINGS: findings ? findings.slice(0, POLISH_FINDINGS_MAX_CHARS) : "(none — first pass)",
      };
      const prompt = transformUserPrompt(template, values);
      const entries = [
        { title: "One-shot — polish system prompt", prompt: systemPrompt },
        {
          title:
            `One-shot — polish ${seg.id} ` +
            `(endpoint ${endpoint.model} @ ${endpoint.baseUrl}, thinking=${polishThinking ? polishThinkingLevel : "off"})`,
          prompt,
        },
      ];
      if (verifySystemPrompt) {
        const vPrompt = transformUserPrompt(verifyTemplate, {
          SOURCE_TEXT: sourceText,
          DRAFT_TEXT: draft,
          POLISHED_TEXT: "(dry-run: the polished output of the call above — not available)",
          GLOSSARY: glossaryBlock(refs.terms),
        });
        entries.push(
          { title: "One-shot — polish drift-check system prompt", prompt: verifySystemPrompt },
          {
            title:
              `One-shot — polish drift-check ${seg.id} ` +
              `(endpoint ${endpoint.model} @ ${endpoint.baseUrl}, thinking=${polishThinking ? polishThinkingLevel : "off"})`,
            prompt: vPrompt,
          }
        );
      }
      const file = await writePromptDump(
        `polish-${volume.installmentNumber}-${seg.id}`,
        volume.installmentNumber,
        "one-shot (edit model)",
        entries
      );
      console.log(`  Volume ${volume.installmentNumber} ${seg.id}: --dry-run prompt dump → ${file}`);
      continue;
    }

    // The guard + drift-check loop: up to polishMaxRounds attempts per
    // chapter. A FAIL re-polishes with the findings injected as a numbered
    // "fix these" task (the retranslate pattern); on exhaustion the polished
    // text is rejected, the draft is kept, and the last findings persist in
    // the state (the next run re-polishes with them — --force re-polishes a
    // fresh attempt).
    let attemptText = hasExistingPolish ? (await fs.readFile(polishedPath, "utf8")) : null;
    let accepted = false;
    let acceptedText = null;
    let lastScore = null;
    let lastQa = null;
    let attempts = 0;

    for (let round = 1; round <= polishMaxRounds && !accepted; round++) {
      attempts = round;

      if (attemptText === null) {
        // Fresh polish (attempt 1) or re-polish with the previous attempt's
        // findings. The polisher sees NO source text — surface cleanup only.
        const values = {
          TRANSLATION_TEXT: draft,
          GLOSSARY: glossaryBlock(refs.terms),
          STYLE_RULES: refs.styleRules || "(none provided — run the style-guide task)",
          VOICE_NOTES: refs.voiceNotes || "(none provided — run the character-voice task)",
          POLISH_FINDINGS: findings ? findings.slice(0, POLISH_FINDINGS_MAX_CHARS) : "(none — first pass)",
        };
        const prompt = transformUserPrompt(template, values);
        console.log(
          `  Volume ${volume.installmentNumber} ${seg.id}: polishing draft (${draft.length} chars) ` +
            `with ${endpoint.model}… (attempt ${round}/${polishMaxRounds})`
        );
        const result = await harness.runOneShot({
          systemPrompt,
          messages: [{ text: prompt }],
          endpoint,
          temperature: Number.isFinite(polishTemperature) ? polishTemperature : 0.6,
          thinking: polishThinking,
          thinkingLevel: polishThinkingLevel,
          label: `polish-v${volume.installmentNumber}-${seg.id}${polishMaxRounds > 1 ? `-r${round}` : ""}`,
        });
        attemptText = stripMarkdownFence(result);
        if (!attemptText) {
          throw new Error(
            `Volume ${volume.installmentNumber} ${seg.id}: the model returned no content for the polish pass. ` +
              `Check .logs/ and re-run.`
          );
        }
      }

      // Deterministic regression guard (free — no AI call): the polished text
      // must not make things WORSE than the draft.
      const qaDraft = checkTranslationQa({ sourceText, draftText: draft, terms: refs.terms });
      const qaPolished = checkTranslationQa({ sourceText, draftText: attemptText, terms: refs.terms });
      lastQa = qaPolished;
      const regressed =
        (!qaPolished.ok && qaDraft.ok) || qaPolished.missingTerms.length > qaDraft.missingTerms.length;
      if (regressed) {
        findings = buildPolishGuardFindings(qaPolished);
        lastScore = null;
        console.warn(
          `  Volume ${volume.installmentNumber} ${seg.id}: attempt ${round} — deterministic guard rejected the ` +
            `polish (errors: ${qaPolished.errors.join("; ")}; missing terms ` +
            `${qaDraft.missingTerms.length} → ${qaPolished.missingTerms.length})` +
            (round < polishMaxRounds ? " — re-polishing with the findings." : ".")
        );
        attemptText = null;
        continue;
      }

      if (!polishVerifyEnabled) {
        // Inspector disabled: the deterministic guard is the only gate.
        accepted = true;
        acceptedText = attemptText;
        break;
      }

      // AI drift check (source-aware): the polish pass must not change the
      // verified draft's meaning. Same endpoint as the polish call — no model
      // switch on the shared-port local setup.
      const vPrompt = transformUserPrompt(verifyTemplate, {
        SOURCE_TEXT: sourceText,
        DRAFT_TEXT: draft,
        POLISHED_TEXT: attemptText,
        GLOSSARY: glossaryBlock(refs.terms),
      });
      console.log(
        `  Volume ${volume.installmentNumber} ${seg.id}: drift-checking the polished text ` +
          `(${attemptText.length} chars) with ${endpoint.model}…`
      );
      const vResult = await harness.runOneShot({
        systemPrompt: verifySystemPrompt,
        messages: [{ text: vPrompt }],
        endpoint,
        temperature: Number.isFinite(polishVerifyTemperature) ? polishVerifyTemperature : 0.2,
        thinking: polishThinking,
        thinkingLevel: polishThinkingLevel,
        label: `polish-verify-v${volume.installmentNumber}-${seg.id}${polishMaxRounds > 1 ? `-r${round}` : ""}`,
      });
      // Fail-closed: an unparseable score is a FAIL (the loop gets another shot).
      const score = parseAcceptanceScore(vResult);
      const pass = score !== null && score >= polishVerifyPassingScore;
      lastScore = score;
      if (pass) {
        accepted = true;
        acceptedText = attemptText;
        console.log(
          `  Volume ${volume.installmentNumber} ${seg.id}: drift check ${score}/100 → PASS (attempt ${round}).`
        );
        break;
      }
      findings = findingsOf(vResult);
      console.warn(
        `  Volume ${volume.installmentNumber} ${seg.id}: drift check ` +
          `${score === null ? "n/a (unparseable — FAIL)" : score + "/100"} → FAIL (attempt ${round})` +
          (round < polishMaxRounds ? " — re-polishing with the findings." : ".")
      );
      attemptText = null;
    }

    if (accepted) {
      await fs.writeFile(polishedPath, acceptedText + "\n", "utf8");
      // Write the FULL entry shape: when the state entry was missing (state
      // file lost, pre-existing draft) the merge step still finds the
      // polished text (it keys on draftHash) and the next run sees the
      // chapter as up to date. draftHash is the hash of the draft content the
      // polish pass just read (the polished file was produced from it);
      // polishVerifiedDraftHash marks it as drift-checked.
      state.chapters[seg.id] = {
        sourceHash: sEntry.sourceHash ?? sourceHash,
        contextHash: sEntry.contextHash ?? refs.contextHash,
        draftHash,
        retranslated: sEntry.retranslated ?? false,
        findingsHash: sEntry.findingsHash ?? null,
        polishedDraftHash: draftHash,
        polishVerifiedDraftHash: draftHash,
        polishScore: lastScore,
        polishFindings: null,
        polishFindingsHash: null,
      };
      sidecar.chapters[seg.id] = {
        sourceHash,
        draftHash,
        score: lastScore,
        pass: true,
        findings: polishVerifyEnabled ? "(no findings)" : "(inspector disabled — deterministic guard only)",
        verifiedAt: new Date().toISOString(),
      };
      await saveTranslationState(path.join(volumeDir, "translation-state.json"), state);
      await fs.writeFile(
        path.join(volumeDir, POLISH_VERIFICATION_FILE),
        JSON.stringify(sidecar, null, 2) + "\n",
        "utf8"
      );
      polished += 1;
      rows.push({
        id: seg.id,
        title: seg.title,
        status: `polished (attempt ${attempts}, drift ${
          polishVerifyEnabled ? (lastScore === null ? "n/a" : lastScore + "/100") : "off"
        })`,
        ok: lastQa ? lastQa.ok : true,
        score: lastScore,
        warnings: lastQa ? lastQa.warnings : [],
      });
      if (lastQa && lastQa.warnings.length > 0) {
        console.warn(
          `  Volume ${volume.installmentNumber} ${seg.id}: QA warning: ${lastQa.warnings.join("; ")}`
        );
      }
      continue;
    }

    // Rejected: the draft is kept. Drop any polished file for the current
    // draft (a legacy unverified one) so the merge publishes the DRAFT, and
    // persist the last attempt's findings — the next run re-polishes with
    // them as correction tasks (--force gives a fresh attempt).
    await fs.rm(polishedPath, { force: true });
    state.chapters[seg.id] = {
      sourceHash: sEntry.sourceHash ?? sourceHash,
      contextHash: sEntry.contextHash ?? refs.contextHash,
      draftHash,
      retranslated: sEntry.retranslated ?? false,
      findingsHash: sEntry.findingsHash ?? null,
      polishedDraftHash: null,
      polishVerifiedDraftHash: null,
      polishScore: lastScore,
      polishFindings: findings,
      polishFindingsHash: findings ? sha256(findings) : null,
    };
    sidecar.chapters[seg.id] = {
      sourceHash,
      draftHash,
      score: lastScore,
      pass: false,
      findings,
      verifiedAt: new Date().toISOString(),
    };
    await saveTranslationState(path.join(volumeDir, "translation-state.json"), state);
    await fs.writeFile(
      path.join(volumeDir, POLISH_VERIFICATION_FILE),
      JSON.stringify(sidecar, null, 2) + "\n",
      "utf8"
    );
    rejected += 1;
    console.warn(
      `  Volume ${volume.installmentNumber} ${seg.id}: polish REJECTED after ${attempts} attempt(s) — ` +
        `keeping the draft (findings saved; the next run re-polishes with them, or use --force for a fresh attempt).`
    );
    rows.push({
      id: seg.id,
      title: seg.title,
      status: `polish rejected after ${attempts} attempt(s) — draft kept`,
      ok: true,
      score: lastScore,
      warnings: lastQa ? lastQa.warnings : [],
    });
  }

  // Re-merge the volume (the polished text wins now).
  const mergedText = await mergeVolumeTranslationFiles(volumeDir, bundle, state);
  if (mergedText) {
    await fs.writeFile(path.join(volumeDir, "translation.md"), mergedText, "utf8");
  }
  const lines = [
    `# Polish QA — Volume ${volume.installmentNumber} (${volume.folder})`,
    "",
    "_Polish pass (the polisher sees NO source text) gated by the deterministic regression guard" +
      (polishVerifyEnabled
        ? ` and the source-aware drift inspector (score 0–100; PASS at or above ${polishVerifyPassingScore}; ` +
          `an unparseable score is a FAIL).`
        : " only (POLISH_VERIFY_ENABLED=false).") +
      " A failed attempt re-polishes with the findings injected; a rejected chapter keeps its draft.",
    "",
    "| Chapter | Title | Status | Drift Score | Warnings |",
    "|---|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.id} | ${r.title || "—"} | ${r.status} | ${r.score === null ? "—" : r.score + "/100"} | ${
          r.warnings.length > 0 ? r.warnings.join("; ") : "—"
        } |`
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
  const verifySystemPrompt = polishVerifyEnabled
    ? await fs.readFile(polishVerifySystemPromptFile, "utf-8")
    : null;
  const verifyTemplate = polishVerifyEnabled
    ? await fs.readFile(polishVerifyTemplateFile, "utf-8")
    : null;

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
      `thinking=${polishThinking ? polishThinkingLevel : "off"}; ` +
      `drift inspector ${polishVerifyEnabled ? `ON (PASS ≥ ${polishVerifyPassingScore}/100)` : "OFF (deterministic guard only)"}; ` +
      `max ${polishMaxRounds} attempt(s)/chapter.`
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
        verifySystemPrompt,
        verifyTemplate,
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
  POLISH_VERIFICATION_FILE,
};