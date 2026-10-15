/**
 * The public entry point every one of the ten tasks calls.
 *
 * readUsableManifest is the SINGLE door to the committed plan and it returns null —
 * never a half-valid object — on any parse or validation failure (gotcha 33): the first
 * version logged 'cached manifest is invalid, re-running intake' and then returned that
 * same manifest on the next line, so an old-schema plan went to every downstream task
 * and a half-written file crashed a task with 'manifest.volumes is not iterable'.
 * getTranslationTarget then reuses a valid plan or runs intake, protects the committed
 * layout, gates the result, and publishes the plan of record plus translation-plan.md.
 * The live series dir always comes from SERIES_LOCATION (env), never from the
 * manifest's seriesLocation field — that field is provenance, and a Windows C:\... path
 * baked into it is not absolute on Linux (gotcha 11).
 *
 * Part of the get-translation-target.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("../types"); // JSDoc type definitions
const harness = require("../harness");
const {
  extractJsonObject,
  installmentNumberFromDir,
  normalizeInstallmentNumber,
  sanitizeFolderName,
  filterVolumesByInstallment,
} = require("../utils/manifest");
const { fileExists } = require("../utils/fs");
const { structuralError, DEFAULT_SOURCE_LANGUAGE, DEFAULT_TARGET_LANGUAGE } = require("../configs/shared");
const { REGISTER_MANIFEST_KEY, describeRegisterDeclaration } = require("../utils/reference-store/register");

const { confidenceGate, findDuplicateSources, manifestSourcesExist, validateManifest } = require("./validate");
const { firstManifestProblem, runDiscoveryAgent } = require("./agent");
const { DISCOVERY_RETRY_DELAY_MS, DRAFT_MANIFEST_FILE_NAME, MANIFEST_FILE_NAME, MANIFEST_SCHEMA, PLAN_FILE_NAME, discoverMaxAttempts, discoverStrict } = require("./config");
const { applyCommittedLayout, readCommittedLayout } = require("./committed");
const { volumeIntegrityProblems } = require("./integrity");
const { buildDeterministicManifest } = require("./deterministic");

/**
 * Log what the pipeline is about to act on — the intake agent's decisions are
 * configuration now, so every run states them up front.
 *
 * @param {TranslationTargetManifest} manifest - The validated manifest.
 * @returns {void}
 */
function logManifestSummary(manifest) {
  const d = manifest.discovery || {};
  harness.logLine(
    `[get-translation-target] ${manifest.volumes.length} volume(s); series ` +
      `"${manifest.seriesName}"; ${manifest.sourceLanguage} -> ${manifest.targetLanguage}.`
  );
  // Which of those two languages somebody actually WORKED OUT, stated every time the plan is read.
  // The target language is always a setting (the intake is told it is fixed). The source language is
  // supposed to be a finding from the book — and until now a plan could carry the settings' default
  // and the log could not tell that apart from a decision. `sourceLanguageOrigin` is the field.
  const origin = manifest.sourceLanguageOrigin;
  if (origin === "assumed") {
    harness.logLine(
      `[get-translation-target] source language ASSUMED, not measured: no intake agent read these books ` +
        `and TRANSLATION_SOURCE_LANGUAGE is unset, so the plan of record carries the settings' default ` +
        `"${DEFAULT_SOURCE_LANGUAGE}". Every stage that measures the source — the glossary and voice ` +
        `read passes, the wiki, the QA residue check — will measure that language. Run "npx gulp ` +
        `discover" without --dry-run to have the intake work it out from the books.`
    );
  } else if (origin === "declared") {
    harness.logLine(
      `[get-translation-target] source language DECLARED by TRANSLATION_SOURCE_LANGUAGE ` +
        `("${manifest.sourceLanguage}"), not measured from the book: the intake's own answer was ` +
        `overridden, which is what the override is for.`
    );
  } else if (origin === "measured") {
    harness.logLine(
      `[get-translation-target] source language measured by the intake from the books: ` +
        `"${manifest.sourceLanguage}".`
    );
  } else {
    harness.logLine(
      `[get-translation-target] source language origin NOT RECORDED: this plan of record predates the ` +
        `"sourceLanguageOrigin" field, so nothing here says whether "${manifest.sourceLanguage}" was ` +
        `read out of the books or assumed. Re-run "npx gulp discover --force" to record it.`
    );
  }
  if (d.summary) harness.logLine(`[get-translation-target] intake: ${d.summary}`);
  if (d.confidence && typeof d.confidence === "object") {
    const parts = Object.entries(d.confidence).map(([k, v]) => `${k}=${v}`);
    if (parts.length) harness.logLine(`[get-translation-target] confidence: ${parts.join(", ")}`);
  }
  if (Array.isArray(d.excluded) && d.excluded.length > 0) {
    harness.logLine(
      `[get-translation-target] excluded ${d.excluded.length} file(s): ` +
        d.excluded.map((e) => `${e.file} (${e.reason})`).join("; ")
    );
  }
  // The register declaration, stated out loud at intake (plan 06 slice 3). The three states mean three
  // different things to the character-voice stage, and a summary that prints only "register: yes/no"
  // cannot tell an empty declaration — a decision a book is allowed to make, with a reason attached —
  // from a plan that predates the block and will therefore be refused.
  const register = describeRegisterDeclaration(manifest[REGISTER_MANIFEST_KEY]);
  if (register.state === "declared") {
    harness.logLine(
      `[get-translation-target] register: ${register.axes.length} axis/axes declared for this series — ` +
        register.axes.map((axis) => `"${axis.id}" (${axis.values.length} value(s))`).join(", ") +
        ". The character-voice stage asks these questions of this book, and no others."
    );
  } else if (register.state === "empty") {
    harness.logLine(
      `[get-translation-target] register: this series declares NO register questions, and says why: ` +
        `"${register.note}". The character-voice stage runs and files no axis-bearing claim.`
    );
  } else if (register.state === "absent") {
    harness.logLine(
      `[get-translation-target] register: this plan of record has no "${REGISTER_MANIFEST_KEY}" block. ` +
        `Every other stage runs; the character-voice stage refuses until the intake writes one, because ` +
        `there is no axis list in the pipeline to fall back on, in any language.`
    );
  } else {
    harness.logLine(
      `[get-translation-target] register: the "${REGISTER_MANIFEST_KEY}" block is malformed:\n  ` +
        register.problems.join("\n  ")
    );
  }
}


/**
 * Read the committed plan of record and decide whether it is still usable.
 *
 * Returns null — never a half-valid manifest — when the file is missing,
 * unparseable, fails validation, was generated for a different series location,
 * or lists a source file that has gone. Every caller then produces a fresh plan.
 *
 * (The bug this helper exists to prevent: the old code logged "cached manifest
 * is invalid … re-running intake" and then returned the invalid manifest on the
 * next line, because the parse/validate failure left the object in hand. An
 * unsanitized folder name, an un-normalized installment number, or a half-written
 * file then went to every downstream task.)
 *
 * @param {string} seriesDir - The SERIES_LOCATION path.
 * @param {string} manifestPath - The manifest file.
 * @param {{why?: string}} [opts] - How to phrase the follow-up in the log.
 * @returns {Promise<TranslationTargetManifest|null>} The usable manifest, or null.
 */
async function readUsableManifest(seriesDir, manifestPath, { why = "re-running intake" } = {}) {
  if (!(await fileExists(manifestPath))) return null;
  let cached;
  try {
    cached = extractJsonObject(await fs.readFile(manifestPath, "utf-8"));
  } catch (err) {
    harness.logLine(
      `[get-translation-target] cached manifest could not be parsed (${err.message}); ${why}.`
    );
    return null;
  }
  const problem = firstManifestProblem(cached);
  if (problem) {
    harness.logLine(`[get-translation-target] cached manifest is invalid (${problem.message}); ${why}.`);
    return null;
  }
  // A manifest generated for a different series location is stale even when
  // every listed (relative) source file still exists — e.g. after migrating
  // machines: a Windows "C:\..." seriesLocation is not absolute on Linux, so
  // any consumer trusting it would resolve every file op relative to the CWD.
  // (Observed live: a Windows-generated manifest was reused on Linux and the
  // character-voice task crashed with ENOENT on <CWD>/C:\.../test_story(1).)
  if (cached.seriesLocation && path.resolve(cached.seriesLocation) !== path.resolve(seriesDir)) {
    harness.logLine(
      `[get-translation-target] cached manifest was generated for ${cached.seriesLocation}, ` +
        `not ${seriesDir}; ${why}.`
    );
    return null;
  }
  if (!(await manifestSourcesExist(seriesDir, cached))) {
    harness.logLine(
      `[get-translation-target] cached manifest is stale (a listed source file is missing); ${why}.`
    );
    return null;
  }
  return cached;
}


/**
 * Get (or produce) the translation-target manifest for SERIES_LOCATION.
 *
 *   - dryRun: no AI call. The committed plan of record is previewed when one
 *     exists (so the preview always matches the real run); otherwise a
 *     deterministic layout is built (keeps --dry-run offline).
 *   - Otherwise an existing valid schema-2 manifest is reused unless intake is
 *     forced, a listed source file has gone, or its seriesLocation no longer
 *     matches SERIES_LOCATION. An INVALID cached manifest is never reused.
 *   - When the intake must run: snapshot the committed layout, run the intake
 *     agent (up to DISCOVER_MAX_ATTEMPTS fresh agents), validate its plan, keep
 *     committed folder names stable, check every source file exists, reject the
 *     same book listed twice, and apply the confidence gate. Then stamp the
 *     authoritative fields and persist.
 *
 * `forceIntake` is the ONLY way to re-run the intake on a valid plan. The
 * tasks' `--force` deliberately does NOT set it: --force means "redo THIS
 * stage", and re-running the intake nine times in one pipeline run (once per
 * task) burned model calls and risked re-deciding a plan that was already fine.
 * Re-decide the plan on purpose with `npx gulp discover --force`.
 *
 * Intake still runs automatically when it must — no usable plan exists, the
 * plan is invalid, or a listed source file has gone missing.
 *
 * @param {{forceIntake?: boolean, dryRun?: boolean}} [opts]
 * @returns {Promise<TranslationTargetManifest>} The validated manifest.
 */
async function getTranslationTarget({ forceIntake = false, dryRun = false } = {}) {
  const seriesDir = process.env.SERIES_LOCATION;
  if (!seriesDir) {
    throw new Error("SERIES_LOCATION is not set. Please set it in .env.");
  }
  let stat;
  try {
    stat = await fs.stat(seriesDir);
  } catch {
    throw new Error(`SERIES_LOCATION does not exist or is not accessible: ${seriesDir}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`SERIES_LOCATION is not a directory: ${seriesDir}`);
  }

  // .env wins over the manifest; an unset value is left to the intake agent.
  // The target language is never left to the agent — the agent cannot know which language the account
  // owner wants to read the books in (see intake/prompts.js `fixedValuesBlock`) — so it is resolved
  // here from the settings' own default rather than from a literal this file invented.
  const overrides = {
    seriesName: process.env.SERIES_NAME || undefined,
    sourceLanguage: process.env.TRANSLATION_SOURCE_LANGUAGE || undefined,
    targetLanguage: process.env.TRANSLATION_TARGET_LANGUAGE || DEFAULT_TARGET_LANGUAGE,
  };

  const manifestPath = path.join(seriesDir, MANIFEST_FILE_NAME);
  const planPath = path.join(seriesDir, PLAN_FILE_NAME);

  // --dry-run: no AI calls. Preview the committed plan when there is one.
  // Building a layout from scratch instead used to preview a DIFFERENT order
  // and re-stage every book into a second set of folders next to the committed
  // ones — including the files the intake agent had deliberately excluded
  // (observed: an art book and a preview sample came back as volumes 01 and 03,
  // and the litter then showed up as "existing folders" on the next intake).
  if (dryRun) {
    const committedPlan = await readUsableManifest(seriesDir, manifestPath, {
      why: "no preview of it is possible",
    });
    if (committedPlan) {
      harness.logLine(
        `[get-translation-target] dry-run: previewing the committed plan of record ` +
          `(${manifestPath}); no layout was built and nothing was written.`
      );
      logManifestSummary(committedPlan);
      return committedPlan;
    }
    // The fallback is the opposite of the preview above, and saying so matters: the line
    // `readUsableManifest` logs used to end "…previewing the committed plan instead" even when it had
    // just REFUSED that manifest (it was written for another series location), and then this branch
    // built a layout by scanning the folder. The log described a plan nobody used while a scan picked
    // the volume's source file — which is how a dry run ended up reading the pipeline's own audit
    // report as the novel.
    harness.logLine(
      `[get-translation-target] dry-run: no committed plan of record is usable here, so the layout is ` +
        `being built by scanning ${seriesDir} with no AI call. This preview is NOT the committed plan.`
    );
    // Nobody read a book on this path — no intake agent ran — so no language was MEASURED. Either the
    // operator declared one in .env, or the settings' own default filled it and this plan says so out
    // loud rather than presenting "Japanese" as a finding. `sourceLanguageOrigin` is the field that
    // carries the distinction into the plan of record.
    const sourceLanguageOrigin = overrides.sourceLanguage ? "declared" : "assumed";
    const manifest = await buildDeterministicManifest(seriesDir, {
      sourceLanguage: overrides.sourceLanguage || DEFAULT_SOURCE_LANGUAGE,
      targetLanguage: overrides.targetLanguage,
      seriesName: overrides.seriesName,
    });
    manifest.sourceLanguageOrigin = sourceLanguageOrigin;
    if (manifest.volumes.length === 0) {
      throw new Error(
        `No volumes found in ${seriesDir}: no volume folder holding a book and no ` +
          `source files (.epub/.txt/.md) at the series root.`
      );
    }
    validateManifest(manifest);
    logManifestSummary(manifest);
    return manifest;
  }

  // Reuse a cached manifest unless intake is forced or the plan is stale — and
  // only a manifest that still validates (see readUsableManifest).
  if (!forceIntake) {
    const cached = await readUsableManifest(seriesDir, manifestPath);
    if (cached) {
      harness.logLine(`[get-translation-target] reusing the existing manifest (${manifestPath}).`);
      logManifestSummary(cached);
      return cached;
    }
  }

  // The committed layout is read BEFORE the agent runs (it is told about it) and
  // applied again after, so a plan that ignores it cannot orphan finished work.
  const committed = await readCommittedLayout(seriesDir);
  const attempts = discoverMaxAttempts();
  const sourceHashes = new Map(); // shared across attempts: the same books are re-checked every attempt
  let manifest = null;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const candidate = await runDiscoveryAgent(seriesDir, {
        overrides,
        committed,
        // A book listed twice is shown to the agent as its own correction task
        // (it can fix that); the same check runs again here as the final gate.
        extraChecks: (m) => findDuplicateSources(seriesDir, m, sourceHashes),
      });
      validateManifest(candidate);
      const warnings = await applyCommittedLayout(seriesDir, candidate, committed);
      for (const warning of warnings) harness.logLine(`[get-translation-target] ${warning}`);
      if (discoverStrict() && warnings.length > 0) {
        // A deliberate policy choice, not a model mistake: retrying cannot make
        // the agent respect it, so fail now instead of burning the attempts.
        const fatal = new Error(
          `the intake agent renamed ${warnings.length} volume folder(s) that already ` +
            `hold pipeline output (DISCOVER_STRICT=true): ${warnings[0]}`
        );
        fatal.fatal = true;
        throw fatal;
      }
      const duplicate = await findDuplicateSources(seriesDir, candidate, sourceHashes);
      if (duplicate) {
        throw new Error(`${duplicate} (inspect ${manifestPath}).`);
      }
      // Both halves of "is this a real volume": the agent's own narrative
      // judgment, and the objective shape of the staged file. A failure here
      // gives the agent a correction turn on the next attempt.
      const integrityProblems = await volumeIntegrityProblems(seriesDir, candidate);
      if (integrityProblems.length > 0) {
        throw new Error(
          `the intake plan lists ${integrityProblems.length} volume(s) that are not sound ` +
            `books:\n  ${integrityProblems.join("\n  ")}`
        );
      }
      if (!(await manifestSourcesExist(seriesDir, candidate))) {
        throw new Error(
          `the intake agent produced a manifest that references source files that ` +
            `do not exist (inspect ${manifestPath}).`
        );
      }
      const gate = confidenceGate(candidate);
      if (!gate.ok) {
        throw new Error(
          gate.reason
            ? `the intake plan was rejected: ${gate.reason}, and DISCOVER_MIN_CONFIDENCE=${gate.min} ` +
              `requires the agent to report one for every decision. Read ${planPath} and ` +
              `${manifestPath}, or set DISCOVER_MIN_CONFIDENCE=0 to accept an unmeasured plan.`
            : `the intake agent reported low confidence (${gate.worstKey} = ${gate.worst}, ` +
              `DISCOVER_MIN_CONFIDENCE=${gate.min}). Read ${planPath} and the evidence ` +
              `in ${manifestPath}: a wrong reading order corrupts every cumulative ` +
              `artifact, so the run stops here. Set DISCOVER_MIN_CONFIDENCE=0 to accept ` +
              `the plan anyway, or fix the folder and re-run with --force.`
        );
      }
      manifest = candidate;
      break;
    } catch (err) {
      lastError = err;
      if (err && err.fatal) throw err;
      harness.logLine(
        `[get-translation-target] intake attempt ${attempt}/${attempts} failed: ${err.message}`
      );
      if (attempt < attempts) {
        harness.logLine(
          `[get-translation-target] retrying intake in ${DISCOVERY_RETRY_DELAY_MS / 1000}s...`
        );
        await new Promise((resolve) => setTimeout(resolve, DISCOVERY_RETRY_DELAY_MS));
      }
    }
  }
  if (!manifest) {
    // Structural: without a plan of record there is nothing any later step can
    // do, so ON_TASK_ERROR=continue must not walk the rest of the pipeline into
    // the same wall (observed live: a rejected plan made all nine steps re-run
    // the intake, three attempts each, the last ones against the translator
    // container the translate hook had just switched in — which cannot act as an
    // agent at all, so it answered with nothing).
    throw structuralError(
      `Series intake failed after ${attempts} attempt(s): ` +
        `${lastError ? lastError.message : "unknown error"} Inspect ${manifestPath}, ` +
        `${planPath}, and the run log in the run's log folder, then re-run with --force.`
    );
  }

  // Stamp the authoritative fields: the live SERIES_LOCATION always wins over
  // the agent's copy, and a .env override always wins over the agent's decision.
  manifest.schema = MANIFEST_SCHEMA;
  manifest.seriesLocation = seriesDir;
  manifest.seriesName = overrides.seriesName || manifest.seriesName;
  manifest.seriesNameAlt = manifest.seriesNameAlt || manifest.seriesName;
  manifest.sourceLanguage = overrides.sourceLanguage || manifest.sourceLanguage;
  // Where the source language came from, recorded rather than implied: the agent read the books and
  // answered ("measured"), the operator pinned it in .env and the agent's answer was replaced
  // ("declared"), or nothing answered and the settings' default filled it ("assumed" — which only the
  // no-AI deterministic preview above can produce, because a plan the agent wrote is validated as
  // having a non-empty source language).
  manifest.sourceLanguageOrigin = overrides.sourceLanguage ? "declared" : "measured";
  manifest.targetLanguage = overrides.targetLanguage;
  manifest.generator = "get-translation-target.js";
  manifest.generatedAt = new Date().toISOString();
  // Publish atomically: write beside the plan of record, then rename over it.
  // A crash mid-write used to leave a half-written manifest, which the next run
  // rejected (readUsableManifest) and had to rebuild from scratch.
  const tempPath = `${manifestPath}.writing`;
  await fs.writeFile(tempPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  await fs.rename(tempPath, manifestPath);
  // The agent's draft has served its purpose; keep the series folder clean.
  await fs.unlink(path.join(seriesDir, DRAFT_MANIFEST_FILE_NAME)).catch(() => {});
  harness.logLine(
    `[get-translation-target] wrote the manifest to ${manifestPath} ` +
      `(${manifest.volumes.length} volumes).`
  );
  logManifestSummary(manifest);
  return manifest;
}


/**
 * Run the intake on its own (the "discover" gulp task): produce or refresh the
 * plan of record and say where it landed, without running any other stage.
 * With dryRun it previews the committed plan (or a deterministic layout when
 * there is none) — no AI call, and no plan of record written.
 *
 * @param {{force?: boolean, dryRun?: boolean}} [opts]
 * @returns {Promise<TranslationTargetManifest>}
 */
async function discoverSeries({ force = false, dryRun = false } = {}) {
  require("../configs/shared").validateRequiredEnv({ dryRun });
  // The discover task is the ONE place --force means "re-run the intake".
  const manifest = await getTranslationTarget({ forceIntake: force, dryRun });
  const dir = process.env.SERIES_LOCATION;
  if (dryRun) {
    // A dry run never writes the plan of record — say so, or the log reads as
    // if the manifest existed on disk.
    harness.logLine(
      `[discover] dry-run preview only: ${manifest.volumes.length} volume(s), no AI call. ` +
        `Nothing was written to ${path.join(dir, MANIFEST_FILE_NAME)}; ` +
        `run "npx gulp discover" (no --dry-run) to commit the plan of record.`
    );
    return manifest;
  }
  harness.logLine(
    `[discover] plan of record: ${path.join(dir, MANIFEST_FILE_NAME)}; ` +
      `human-readable plan: ${path.join(dir, PLAN_FILE_NAME)}.`
  );
  return manifest;
}

// ─── Export for use as a module ─────────────────────────────────────────────


module.exports = {
  logManifestSummary,
  readUsableManifest,
  getTranslationTarget,
  discoverSeries,
};
