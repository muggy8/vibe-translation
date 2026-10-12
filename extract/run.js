/**
 * extract/run.js — the extraction step: resolve every volume's bundle, audit it, record what was found.
 *
 * WHAT THIS STEP OWNS (`utils/source/plan/01-extraction-step.md` §2). Extraction used to belong to
 * nobody: eleven callers resolved a volume's bundle, none of them checked what they got, and none of
 * them reported it. That is how a converter that split 蒲田 into 蒲かま田た sat in all 17 volumes
 * unnoticed (gotcha 123), and how a folder named `(01)` beside an archive named `(1).epub` made four
 * stages believe a 102,892-token novel was a 2,394-token single-segment source (gotcha 119). This step
 * is the place that question is asked and answered, once, before anything is built on the answer.
 *
 * IT DOES NOT REPLACE THOSE CALLERS. They stay exactly as they are and become cache hits on work that
 * has already been checked. `resolveSourceBundle` is the same door for all of them; this step is the
 * one that runs the audit over what came through it and writes the result down.
 *
 * NO MODEL, ANYWHERE. No harness, no one-shot, no agent, no prompt file. Every question this step
 * answers is answered by code over a checksum and a file listing, which is why it can run on every
 * volume of every series for free and be re-run as often as anybody likes (§4). The one model call it
 * can cause is not its own: `openSeriesRun` goes through the shared intake door, and a series with no
 * usable plan of record makes that door run the intake agent — the same behaviour every other stage
 * has, and the reason `extract` sits after `discover`.
 *
 * WHAT THE SEVERITIES DO (§3, the account owner's decision of 2026-10-12).
 *   - **HIGH fails the step.** The step audits every volume first, writes every report, and then
 *     throws a STRUCTURAL error. Structural, not ordinary: `ON_TASK_ERROR=continue` exists so an
 *     un-monitored run survives a flaky model call, and a book whose extraction is broken is not a
 *     flaky model call — continuing means seventeen volumes of artifacts built on text the audit says
 *     is wrong. The marker the gulp wrapper writes is what lets `index.js` know the kind across the
 *     process boundary, and the runner stops before `glossary` is started.
 *   - **MEDIUM is recorded and printed**, and the run continues.
 *   - **The counts are not findings.** Chapters, characters, guides set aside, images, packaging
 *     excluded: the measurement that turns "this ran" into "this ran, and here is what it saw".
 *
 * WHY IT AUDITS EVERY VOLUME BEFORE IT FAILS. A model stage stops at the first broken volume because
 * every volume costs tokens. This one costs nothing, so a single run answers "what is wrong with my
 * books?" for all of them instead of one volume per attempt — and the reports are on disk for the
 * operator to read while deciding what to do.
 *
 * Part of the extract step (extract.js).
 */

const fs = require("fs").promises;
const path = require("path");

require("../types"); // JSDoc type definitions

const { structuralError } = require("../configs/shared");
const { readRunArgs, openSeriesRun } = require("../utils/series-run");
const { resolveSourceBundle, auditExtractedVolume } = require("../utils/source");
const { BUNDLE_SCHEMA_VERSION } = require("../utils/source/config");
const { postMortemDir } = require("../utils/postmortem");
const { ensureRunStateGitignore } = require("../configs/run-state");

const { bundleCachePresent, bundleStateOf } = require("./bundle-state");
const { writeVolumeReport, writeSeriesSummary, extractionReportBase } = require("./reports");

/** @typedef {import("./reports").ExtractionVolumeRecord} ExtractionVolumeRecord */
/** @typedef {import("./bundle-state").BundleState} BundleState */
/** @typedef {import("../utils/source/audit/audit").ExtractionAudit} ExtractionAudit */

/**
 * How many images this volume's extraction wrote.
 *
 * Read from the extraction's own manifest (`images/manifest.json`, utils/source/images.js) rather than
 * from a directory count, because the manifest is the record of what the book carried and a directory
 * can hold a leftover from an older extraction. The directory count is the fallback for a bundle whose
 * manifest is missing — and the count is then the honest lower bound, not a guess.
 *
 * @param {SourceBundle} bundle - The resolved bundle.
 * @returns {Promise<number>} Image count (0 when the volume has no images folder).
 */
async function imageCountOf(bundle) {
  if (!bundle.imagesDir) return 0;
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(bundle.imagesDir, "manifest.json"), "utf8"));
    if (Array.isArray(parsed.images)) return parsed.images.length;
  } catch {
    /* fall through to the directory count */
  }
  try {
    return (await fs.readdir(bundle.imagesDir)).filter((name) => name !== "manifest.json").length;
  } catch {
    return 0;
  }
}

/**
 * The record for one volume: the bundle's measurement plus the audit's findings.
 *
 * @param {Object} p
 * @param {TranslationTargetVolume} p.volume - The plan of record's volume entry.
 * @param {SourceBundle} p.bundle - The resolved bundle.
 * @param {ExtractionAudit} p.audit - What `auditExtractedVolume` found.
 * @param {BundleState} p.action - Which of the two the step did to this volume's bundle.
 * @param {number} p.images - Image count.
 * @returns {ExtractionVolumeRecord}
 */
function recordOf({ volume, bundle, audit, action, images }) {
  const guides = bundle.rubyGuides || null;
  const number = (value) => (Number.isFinite(value) ? value : 0);
  return {
    step: "extract",
    installment: volume.installmentNumber || volume.folder,
    folder: volume.folder,
    action,
    sourceFile: volume.sourceFile || "",
    sourceFormat: bundle.format,
    sourceFingerprint: bundle.sourceFingerprint || null,
    // An epub bundle that reaches this step is ALWAYS at the current schema: `resolveSourceBundle`
    // re-extracts a cache whose `schema` is anything else. A plain-text source has no bundle schema.
    bundleSchema: bundle.format === "epub" ? BUNDLE_SCHEMA_VERSION : null,
    counts: {
      chapters: audit.counts.chapters,
      packaging: audit.counts.packaging,
      characters: number(bundle.wholeChars),
      guides: guides ? number(guides.guides) : 0,
      guideChars: guides ? number(guides.guideChars) : 0,
      images,
      HIGH: audit.counts.HIGH,
      MEDIUM: audit.counts.MEDIUM,
      findings: audit.counts.findings,
    },
    chapters: bundle.segments.map((s) => ({
      id: s.id,
      title: s.title || "",
      file: s.file,
      chars: Number.isFinite(s.chars) ? s.chars : null,
      bodyChars: Number.isFinite(s.bodyChars) ? s.bodyChars : null,
      empty: typeof s.empty === "boolean" ? s.empty : null,
      syntheticTitle: s.syntheticTitle === true,
    })),
    packaging: (Array.isArray(bundle.packaging) ? bundle.packaging : []).map((p) => ({
      title: p.title || "",
      reason: p.reason || "",
      pages: number(p.pages),
      bodyChars: number(p.bodyChars),
      textChars: number(p.textChars),
    })),
    findings: audit.findings,
    error: null,
  };
}

/**
 * Print what the step saw for one volume: the counts, then every finding.
 *
 * @param {ExtractionVolumeRecord} record
 * @returns {void}
 */
function printVolumeResult(record) {
  const c = record.counts;
  console.log(
    `[extract] Volume ${record.installment} · ${c.chapters} chapter(s), ${c.packaging} packaging ` +
      `group(s), ${c.characters} characters, ${c.guides} guide(s) set aside, ${c.images} image(s)` +
      (c.findings === 0 ? " · audit clean" : ` · ${c.HIGH} HIGH, ${c.MEDIUM} MEDIUM`)
  );
  for (const f of record.findings) {
    console.log(`[extract] Volume ${record.installment} · [${f.severity}] ${f.kind} — ${f.file}: ${f.message}`);
  }
}

/**
 * Resolve, audit and record one volume.
 *
 * @param {Object} p
 * @param {string} p.seriesDir - The series folder.
 * @param {TranslationTargetVolume} p.volume - The plan of record's volume entry.
 * @param {boolean} p.force - `--force`: re-extract whatever the cache says.
 * @param {string} p.outDir - The run's records folder.
 * @returns {Promise<ExtractionVolumeRecord>} The record. `error` is set when the volume could not be
 *   read or audited; the record is still returned so the series summary names the volume that failed.
 */
async function extractOneVolume({ seriesDir, volume, force, outDir }) {
  const volumeDir = path.join(seriesDir, volume.folder);
  const failed = (/** @type {string} */ error) => ({
    step: "extract",
    installment: volume.installmentNumber || volume.folder,
    folder: volume.folder,
    action: null,
    sourceFile: volume.sourceFile || "",
    sourceFormat: null,
    sourceFingerprint: null,
    bundleSchema: null,
    counts: { chapters: 0, packaging: 0, characters: 0, guides: 0, guideChars: 0, images: 0, HIGH: 0, MEDIUM: 0, findings: 0 },
    chapters: [],
    packaging: [],
    findings: [],
    error,
  });

  let record;
  try {
    const cacheWasThere = await bundleCachePresent(volumeDir);
    const bundle = await resolveSourceBundle({ seriesDir, volume, volumeDir, force });
    const action = bundleStateOf({ bundle, cacheWasThere, volume });
    const audit = auditExtractedVolume({ volume, bundle, volumeFiles: await fs.readdir(volumeDir) });
    record = recordOf({ volume, bundle, audit, action, images: await imageCountOf(bundle) });
    console.log(action.line);
  } catch (err) {
    const message = String((err && err.message) || err);
    console.error(
      `[extract] Volume ${volume.installmentNumber || volume.folder} (${volume.folder}) · FAILED — ${message}`
    );
    record = failed(message);
  }

  const written = await writeVolumeReport({ record, outDir });
  if (record.error) return record;
  printVolumeResult(record);
  console.log(`[extract] Volume ${record.installment} · report → ${written.markdown}`);
  return record;
}

/**
 * The `extract` step.
 *
 * @param {{argv?: string[]}} [opts] - `argv` overrides `process.argv` for a caller that is not a gulp task.
 * @returns {Promise<{volumes: number, HIGH: number, MEDIUM: number, reports: {markdown: string, json: string}|null}>}
 * @throws {Error} A STRUCTURAL error when any volume's extraction produced a HIGH finding or could not
 *   be read at all — the extraction is the one input every later artifact is built on.
 */
async function extractVolumes({ argv } = {}) {
  const args = readRunArgs(argv || process.argv);
  const seriesDir = process.env.SERIES_LOCATION;
  if (!seriesDir) throw new Error("SERIES_LOCATION is not set. Please set it in .env.");

  if (args.dryRun) {
    // There is nothing to rehearse: this step sends no prompt, so there is nothing to dump, and it
    // writes nothing into a volume folder. Saying that is more useful than pretending to plan.
    console.log(
      "[extract] --dry-run: this step makes no model call and has no prompt to dump. It opens no " +
        "archive and writes nothing. Run it for real — the audit costs nothing."
    );
    return { volumes: 0, HIGH: 0, MEDIUM: 0, reports: null };
  }

  const outDir = postMortemDir();
  await fs.mkdir(outDir, { recursive: true });
  // The container's own ignore rule (logs/ and dry-run/ stay out, the records stay in). Written by the
  // run rather than by the repository, so it travels with the folder (configs/run-state.js).
  ensureRunStateGitignore();

  const run = await openSeriesRun({ seriesDir, dryRun: false, volumeArg: args.volumeArg });
  console.log(
    `[extract] ${run.volumes.length} volume(s) of "${run.runSettings.seriesName}" · converter schema ` +
      `${BUNDLE_SCHEMA_VERSION}${args.force ? " · --force: re-extracting every volume" : ""}`
  );

  /** @type {ExtractionVolumeRecord[]} */
  const records = [];
  for (const folder of run.volumes) {
    records.push(
      await extractOneVolume({ seriesDir, volume: run.volumeByFolder.get(folder), force: args.force, outDir })
    );
  }

  // The summary is written BEFORE anything is thrown: a run that stops on a bad book has to leave the
  // account owner the account of what is wrong, not a stack trace.
  const summary = await writeSeriesSummary({ records, seriesName: run.runSettings.seriesName, outDir });

  const HIGH = records.reduce((n, r) => n + r.counts.HIGH, 0);
  const MEDIUM = records.reduce((n, r) => n + r.counts.MEDIUM, 0);
  const broken = records.filter((r) => r.counts.HIGH > 0 || r.error);
  console.log(
    `[extract] series: ${records.length} volume(s), ${records.reduce((n, r) => n + r.counts.chapters, 0)} ` +
      `chapter(s), ${HIGH} HIGH, ${MEDIUM} MEDIUM — summary → ${summary.markdown}`
  );

  if (records.length === 0) {
    // STRUCTURAL: a step that audited nothing has not audited the series, and an empty report must
    // never be filed as a clean one (AGENTS.md rule 4).
    throw structuralError(
      `extract: no volume was audited (${seriesDir}). The plan of record named volumes but none was ` +
        `resolved — the step cannot report a series it did not look at.`
    );
  }

  if (broken.length > 0) {
    const detail = broken
      .map((r) =>
        r.error
          ? `${r.installment} (${r.folder}) could not be read: ${r.error}`
          : `${r.installment} (${r.folder}): ${r.findings
              .filter((f) => f.severity === "HIGH")
              .map((f) => f.kind)
              .join(", ")}`
      )
      .join("; ");
    // STRUCTURAL on purpose. `ON_TASK_ERROR=continue` is for a flaky model call; a book whose
    // extraction is broken is not flaky and re-running cannot fix it, and every later step builds on
    // this text (configs/shared/failures.js).
    throw structuralError(
      `extract: ${broken.length} of ${records.length} volume(s) failed the extraction audit — ${detail}. ` +
        `The extraction is the one input every artifact downstream is built on, so the run stops here ` +
        `rather than spending a glossary stage on text the audit already says is wrong. ` +
        `What it found: ${summary.markdown}` +
        broken.map((r) => ` and ${path.join(outDir, `${extractionReportBase(r.installment)}.md`)}`).join("")
    );
  }

  return { volumes: records.length, HIGH, MEDIUM, reports: summary };
}

module.exports = { extractVolumes, extractOneVolume, recordOf, imageCountOf, printVolumeResult };
