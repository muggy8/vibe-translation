/**
 * glossary/store.js — this stage's side of the volume's reference record.
 *
 * Slice 6 built the door; slice 2 of `glossary/plan/01-glossary-route.md` made it the **only** door. The
 * store itself is `utils/reference-store/`; this file is the glossary stage's own glue: when the record is
 * opened, what gets filed in it, what gets **rendered out of it**, and when it is audited. It lives here
 * rather than in `utils/reference-store/` because it knows the stage's file names and its context object,
 * and in its own file rather than in `task.js` because `qa.js` and `chunked.js` need it too.
 *
 * The stage's whole route, in the order this file supports it:
 *
 *   `openGlossaryRecord` → `fileGlossaryExtraction` (what the read pass noticed) →
 *   `fileGlossaryTermRows` (what the glossary will publish) → `renderGlossaryArtifact` (the published
 *   file) → `auditGlossaryArtifact` + `glossaryGradeSample` (the gate) → `sealGlossaryRecord`.
 *
 * **No agent reaches any of this.** No tool, no prompt, no agent-facing query. That is slice 7.
 *
 * Nothing here is behind a setting. The glossary stage opens the volume's record on every volume it
 * builds (`glossary/task.js`), because the record is where the stage's findings live: a run that
 * skipped it would publish a glossary with nothing behind it and leave the next volume with nothing
 * to copy forward. The switch that used to sit in front of this file is deleted — see
 * `glossary/plan/01-glossary-route.md` §4 and `docs/environment.md`.
 *
 * What a `null` return still means: no record is open for this volume. That happens on a `--dry-run`
 * (which never reaches the store block) and on a volume the run skipped before opening one, and it
 * is the guarantee `test/test-reference-store-pipeline.js` pins — the glue writes nothing when there
 * is no record, so a stage that never opened one cannot half-write a volume.
 *
 * One asymmetry worth naming, because it is the shape of the pipeline rather than a preference: the
 * glossary stage **does** seal the volume, and the character-voice stage seals it again. `npx gulp`
 * runs each stage over every volume before the next stage starts, so "the end of a volume's
 * pre-production" is not one moment — volume 05's glossary is built before volume 01's voice reference
 * exists. Sealing is therefore the end of each stage's work on that volume, and it is idempotent: the
 * marker says the record is published, and the second seal marks the rows the voice stage added.
 *
 * What that sentence used to claim — that a half-finished volume is stopped by a voice-mirror marker
 * rather than by the seal, naming an `openVolumeRecord` option that does not exist — was wrong, and it
 * was wrong in the direction that mattered: the seal IS the gate, `reference-volume-unsealed` is HIGH,
 * and it is the check that stopped volume 02 from starting at all when volume 01's rebuild published a
 * record and never sealed it (gotcha 102). The voice mirror marker (`documentMirrored`) does real work
 * too, but a different work: it decides whether the **coverage question is asked at all** for this
 * volume, so a volume whose voice stage never ran is caught by the sealing check and not by a coverage
 * finding that would be a false positive.
 *
 * @module glossary/store
 */

const fs = require("fs").promises;
const path = require("path");
require("../types"); // JSDoc type definitions
const {
  openVolumeRecord,
  importVolumeExtraction,
  importGlossaryExtraction,
  renderGlossary,
  moveArtifactAside,
  auditVolumeRecord,
  sealVolumeRecord,
  buildGradeSample,
  glossaryNewestSections,
  rosterReconciliationLog,
} = require("../utils/reference-store");
// The finding constructor, used only to NAME a term-list read that never answered (see
// auditGlossaryArtifact). Reaching for the post-mortem's own constructor rather than inventing a local
// finding shape is what keeps the kind, its severity and its declared level in one vocabulary.
const { finding } = require("../utils/postmortem");
const { extractionReadReport } = require("./extract");

/** The artifact this stage publishes, for the audit report's headings. */
const GLOSSARY_ARTIFACT_NAME = "glossary.md";

/** The same file name, as `moveArtifactAside` wants it: a name inside the volume folder. */
const OUTPUT_FILE_NAME = "glossary.md";

/**
 * Open this volume's reference record, carrying the previous volume's published record in first.
 *
 * A refusal here stops the volume: the integrity gate inside copy-forward is the rule that a volume
 * whose character-voice reference lost characters may not be copied forward, with no exception.
 *
 * @param {{ values: Object, folderName: string, seriesDir: string, previousFolderName: string|null }} ctx
 * @param {number|null} previousVolume - The previous volume's installment number, when there is one.
 * @returns {{ok: boolean, opened: Object|null, error: string|null}}
 */
function openGlossaryRecord(ctx, previousVolume) {
  const opened = openVolumeRecord({
    volume: ctx.values.INSTALLMENT_NUMBER,
    folder: ctx.folderName,
    seriesDir: ctx.seriesDir,
    previousVolume,
    previousFolder: ctx.previousFolderName || null,
    bundleSegments: ctx.bundle && ctx.bundle.segments ? ctx.bundle.segments : null,
  });
  if (opened.ok) {
    const backfill = opened.glossaryBackfill;
    if (backfill && backfill.ran) {
      console.log(
        `Volume ${ctx.values.INSTALLMENT_NUMBER}: the reference record held no glossary rows of its own, so it read this ` +
          `volume's published ${GLOSSARY_ARTIFACT_NAME} into itself (${backfill.imported} new row(s), ${backfill.carried} ` +
          `already held from earlier volumes, ${backfill.refused.length} refused for want of a line this volume's text prints).`
      );
    }
    for (const line of rosterReconciliationLog(ctx.values.INSTALLMENT_NUMBER, opened.roster)) console.log(line);
    return { ok: true, opened, error: null };
  }
  const detail = opened.findings.map((f) => `${f.severity} ${f.kind}: ${f.message}`).join("\n  ");
  return {
    ok: false,
    opened,
    error:
      `the reference record could not be opened, so this volume is not built.\n  ` +
      `${opened.refusal.because}\n  Fix: ${opened.refusal.fix}` +
      (detail ? `\n  Findings:\n  ${detail}` : ""),
  };
}

/**
 * File this volume's extracted new terms in its record.
 *
 * These are not glossary rows and never render as one: they are the record of what this volume's
 * extraction pass found, which is what makes "the glossary has no row for a term the extractor found"
 * a query with a number in it instead of something a validator agent might notice.
 *
 * @param {{ values: Object, folderName: string, seriesDir: string, refStore: Object|null }} ctx
 * @param {Array<Object>} terms - The parsed `glossary-new-terms.json`.
 * @returns {Object|null} The import report, or null when no record is open.
 */
function fileGlossaryExtraction(ctx, terms) {
  if (!ctx.refStore) return null;
  const filed = importVolumeExtraction({
    volume: ctx.values.INSTALLMENT_NUMBER,
    folder: ctx.folderName,
    seriesDir: ctx.seriesDir,
    newTerms: terms,
  });
  const found = filed.terms;
  console.log(
    `Volume ${ctx.values.INSTALLMENT_NUMBER}: reference record filed ${found.importedCount} new term(s) ` +
      `(${found.carried.length} already filed); ${found.refused.length} refused because the volume's text ` +
      "does not print them."
  );
  return found;
}

/**
 * File this volume's extracted terms in its record **as glossary rows** — the rows the published file
 * is rendered from.
 *
 * This is the half `fileGlossaryExtraction` is not. That door files the extraction's terms as
 * `source_stage: "extract"` candidates, which the render deliberately ignores: "the glossary covers this
 * term" has to be a question about the published document, not about whether an extractor noticed the
 * word. This door files the published half, under the document scope this stage's handle carries, and it
 * is the only thing in the stage that puts a target-language rendering into the record.
 *
 * A row the read pass returned without a rendering is **refused**, not filed with an empty English
 * column, and the refusal says who owes the rendering. That refusal is the guard that keeps this stage
 * from reporting success while shipping a table with a blank column — which is what publishing a render
 * of a record nobody filled in would otherwise look like.
 *
 * @param {{ values: Object, folderName: string, seriesDir: string, refStore: Object|null }} ctx
 * @param {Array<Object>} terms - The parsed `glossary-new-terms.json`, with the read pass's renderings.
 * @returns {Object|null} The import report, or null when no record is open.
 */
function fileGlossaryTermRows(ctx, terms) {
  if (!ctx.refStore) return null;
  const filed = importGlossaryExtraction(ctx.refStore, terms);
  ctx.storeTermRows = filed;
  console.log(
    `Volume ${ctx.values.INSTALLMENT_NUMBER}: reference record filed ${filed.importedCount} glossary row(s) ` +
      `from this volume's read pass (${filed.carried.length} already held from earlier volumes, ` +
      `${filed.refused.length} refused, ${filed.castRegistered} cast entr(ies) registered).`
  );
  if (filed.missingRendering.length) {
    console.error(
      `Volume ${ctx.values.INSTALLMENT_NUMBER}: ${filed.missingRendering.length} term(s) came back from the ` +
        `read pass with no target-language rendering and were NOT filed as glossary rows: ` +
        `${filed.missingRendering.slice(0, 12).join(", ")}` +
        `${filed.missingRendering.length > 12 ? `, … ${filed.missingRendering.length - 12} more` : ""}. ` +
        `The published glossary cannot contain a term with an empty rendering column, so these entries are ` +
        `missing from it. Fix: the extraction prompt's ` +
        "`rendering` field."
    );
  }
  return filed;
}

/**
 * The opening lines a rendered glossary gets when its record holds no document prose of its own.
 *
 * The authored file had these lines because an agent wrote the file; the render has no agent, so the two
 * lines the document's shape actually depends on are built here, from the values the stage already has.
 * The style-policy paragraph and the series-title paragraph an authored glossary carried are **not**
 * reproduced — nothing in the record holds them, and a renderer that invented them would be writing
 * criticism instead of printing rows. Measured and reported in `glossary/plan/01-glossary-route.md` §7.
 *
 * @param {{ SOURCE_NAME: string, SOURCE_LANGUAGE: string, TARGET_LANGUAGE: string, INSTALLMENT_NUMBER: string }} values
 * @returns {string} The title block, without a trailing newline.
 */
function glossaryTitleBlock(values) {
  return [
    `# Glossary — ${values.SOURCE_NAME}`,
    "",
    `_Canonical ${values.TARGET_LANGUAGE} renderings for translating ${values.SOURCE_NAME} ` +
      `(${values.SOURCE_LANGUAGE} → ${values.TARGET_LANGUAGE}). Current through volume ${values.INSTALLMENT_NUMBER}._`,
    "",
    "_Rendered from this volume's reference record: every row below is a row the record holds, and every " +
    "row was checked against a line the book prints._",
  ].join("\n");
}

/**
 * Publish this volume's `glossary.md` by **rendering it out of the volume's record**.
 *
 * Cumulative by construction, and not because this function copies anything: the record this volume
 * opened was copied forward from the previous volume's sealed record, so every earlier volume's rows are
 * already in it and `renderGlossary` prints all of them, in the order their own volume filed them. That
 * is the same shape `renderVoice` and `renderPovMap` have (and the same trap gotcha 108 records: a
 * render of a volume that has volumes before it must not print only that volume's own claims — the test
 * that pins this stage's render prints the earlier volumes' rows is `test/test-glossary-render-route.js`).
 *
 * An existing file is moved aside through the shared numbered door rather than overwritten, so a re-run
 * keeps the file it replaced as evidence. `moveAside: false` is the chapter-by-chapter route's second and
 * later renders: the file being replaced is this volume's own previous render, and a pile of `.rejected`
 * copies of one in-progress document is noise, not evidence.
 *
 * @param {{ values: Object, folderName: string, seriesDir: string, volumeDir: string, glossaryOutputFile: string, refStore: Object|null }} ctx
 * @param {{ moveAside?: boolean }} [opts]
 * @returns {Promise<{ok: boolean, bytes: number, rows: number, sections: number, movedAside: string[], refusal: Object|null}>}
 */
async function renderGlossaryArtifact(ctx, { moveAside = true } = {}) {
  if (!ctx.refStore) {
    return {
      ok: false,
      bytes: 0,
      rows: 0,
      sections: 0,
      movedAside: [],
      refusal: {
        verb: "render_glossary",
        rule: "reference-record-not-open",
        because: "this volume's reference record is not open, and the glossary is rendered out of that record.",
        fix: "open the volume's record (`openVolumeRecord`) before rendering.",
      },
    };
  }
  const markdown = renderGlossary(ctx.refStore, {
    volume: ctx.values.INSTALLMENT_NUMBER,
    title: glossaryTitleBlock(ctx.values),
  });
  const sections = (markdown.match(/^## /gm) || []).length;
  // Every section's table costs one header line (`| Japanese | English | Notes |`) that matches the
  // same shape as a data row; the separator line (`|---|---|---|`) does not. So the row count is the
  // table lines minus one per section.
  const tableLines = (markdown.match(/^\| (?!-)/gm) || []).length;
  const rows = Math.max(0, tableLines - sections);
  const bytes = Buffer.byteLength(markdown, "utf8");

  if (rows <= 0) {
    return {
      ok: false,
      bytes,
      rows: 0,
      sections,
      movedAside: [],
      markdown,
      refusal: {
        verb: "render_glossary",
        rule: "glossary-render-has-no-rows",
        because:
          `this volume's record holds no glossary rows, so rendering it produced a ${bytes}-byte file with a ` +
          "title and nothing in it. The existing `glossary.md` was left where it is: a render with no rows is " +
          "not allowed to replace a published glossary.",
        fix:
          "the volume's read pass has to return terms WITH a target-language rendering, and the record has to file " +
          "them (`fileGlossaryTermRows`). A term list with no renderings is refused at filing on purpose.",
      },
    };
  }

  const aside = moveAside ? moveArtifactAside(ctx.volumeDir, OUTPUT_FILE_NAME) : { ok: true, moved: null, keptAside: [] };
  if (!aside.ok) {
    return { ok: false, bytes: 0, rows, sections, movedAside: [], refusal: aside.refusal };
  }
  await fs.writeFile(ctx.glossaryOutputFile, markdown, "utf8");
  const movedAside = aside.moved ? [path.basename(aside.moved)] : [];
  if (movedAside.length) {
    console.log(
      `Volume ${ctx.values.INSTALLMENT_NUMBER}: the glossary this volume already had was moved to ` +
        `${movedAside.join(", ")} before the render replaced it.`
    );
  }
  ctx.glossaryRendered = { rows, sections, bytes };
  console.log(
    `Volume ${ctx.values.INSTALLMENT_NUMBER}: rendered ${OUTPUT_FILE_NAME} out of the volume's record — ` +
      `${rows} row(s) across ${sections} section(s), ${bytes} bytes, no model call.`
  );
  return { ok: true, bytes, rows, sections, movedAside, refusal: null, markdown };
}

/**
 * Run the deterministic audit and write the report the validator agent used to write.
 *
 * The report is the audit's own markdown **plus the block about how this volume's term lists were read**
 * (`glossary/extract.js`'s `extractionReadReport`). It is appended here rather than in `glossary/qa.js`,
 * because this is the function that owns the report's content, and it is the mirror of
 * `character-voice/store.js`'s `auditVoiceArtifact`, which appends its own `readingReport` the same way.
 * The reason both stages do it: a glossary built from ten reads of which one never answered is a different
 * artifact from one built from ten that answered, and the grader's message list already contains this file
 * — so this is the one place the hole reaches the gate without inventing a second gate.
 *
 * Each read that never produced a list also becomes a finding (`chapter-extraction-never-answered`, HIGH,
 * declared MAJOR in the level table). **What that finding does and does not reach, stated plainly:** it is
 * in the report the grader reads, it is on the console, and it is on `ctx.extractionFindings` for the
 * stage's caller. It is NOT in the delivery layer's triage or the volume-halt gate, because the post-mortem
 * assesses a finished step from the disk (`utils/postmortem/run.js` → `volume.js` / `file.js`) and nothing
 * on a stage's own finding list is on the disk. Closing that needs a new declared sidecar in
 * `utils/artifacts/preproduction.js` or a finding channel in `utils/postmortem/volume.js` — both outside
 * this slice's allowed edits, and both an owner's call. See `/tmp/opencode/json-schema-questions.md`.
 *
 * @param {{ values: Object, refStore: Object|null, glossaryOutputFile: string, storeTermRows: Object|null, extractionReads?: Array<Object> }} ctx
 * @param {{ refused?: Array<Object> }} [opts] - The filings this volume refused, so the report names them
 *   instead of leaving a term the read pass found unexplained.
 * @returns {Promise<Object|null>} The audit, its markdown carrying the read block, or null when no record is open.
 */
async function auditGlossaryArtifact(ctx, { refused } = {}) {
  if (!ctx.refStore) return null;
  const markdown = await fs.readFile(ctx.glossaryOutputFile, "utf8").catch(() => "");
  const audit = auditVolumeRecord(ctx.refStore, {
    title: "Glossary",
    file: GLOSSARY_ARTIFACT_NAME,
    markdown,
    refused: refused !== undefined ? refused : (ctx.storeTermRows && ctx.storeTermRows.refused) || [],
  });

  // The reading half of the report, and the findings it produces.
  const reads = Array.isArray(ctx.extractionReads) ? ctx.extractionReads : [];
  const volume = ctx.values.INSTALLMENT_NUMBER;
  const readReport = extractionReadReport(reads, { volume });
  const neverAnswered = reads.filter((read) => read.failed);
  ctx.extractionFindings = neverAnswered.map((read) =>
    finding(
      "HIGH",
      "chapter-extraction-never-answered",
      "glossary",
      volume,
      GLOSSARY_ARTIFACT_NAME,
      `${read.id}: this volume's glossary was built from a term-list read that never produced a list ` +
        `(${(read.attempts || []).map((a) => `${a.thinkingLevel}: ${a.failure ? a.failure.kind : "no answer"}`).join("; ")}). ` +
        `Every term that read was supposed to find is missing from this glossary and from every later ` +
        `volume's, because the glossary is copied forward.`
    )
  );
  for (const found of ctx.extractionFindings) console.error(`Volume ${volume}: HIGH ${found.kind}: ${found.message}`);

  ctx.storeAudit = readReport ? { ...audit, markdown: `${audit.markdown}\n${readReport}` } : audit;
  console.log(
    `Volume ${ctx.values.INSTALLMENT_NUMBER}: deterministic audit — ${audit.findings.length} finding(s), ` +
      `${audit.highFindings.length} at HIGH; ${audit.checked} citation(s) re-checked against the source text.` +
      `${ctx.extractionFindings.length ? ` Plus ${ctx.extractionFindings.length} read(s) that never answered (see the report).` : ""}`
  );
  return ctx.storeAudit;
}

/**
 * The sample the acceptance grader is shown instead of the whole glossary.
 *
 * @param {{ values: Object, refStore: Object|null, glossaryOutputFile: string }} ctx
 * @returns {Promise<string|null>} The sample text, or null when no record is open (the grader then
 *   gets the whole file, exactly as it does today).
 */
async function glossaryGradeSample(ctx) {
  if (!ctx.refStore) return null;
  const markdown = await fs.readFile(ctx.glossaryOutputFile, "utf8").catch(() => null);
  if (markdown === null) return null;
  const sample = buildGradeSample(markdown, {
    file: GLOSSARY_ARTIFACT_NAME,
    volume: ctx.values.INSTALLMENT_NUMBER,
    heading: "## ",
    newestSections: glossaryNewestSections(ctx.refStore),
  });
  console.log(
    `Volume ${ctx.values.INSTALLMENT_NUMBER}: graded sample — ${sample.sectionsShown} of ` +
      `${sample.sectionsTotal} section(s), ${sample.chars} characters.`
  );
  return sample.text;
}

/**
 * Move this volume's rendered glossary aside when the gate refused it.
 *
 * The same door the character-voice route uses (`character-voice/assemble.js`), and for the same reason:
 * a rendered artifact cannot be rewritten into a better one, so a failing grade has exactly one correct
 * outcome — stop, keep the file as evidence, and leave the record a draft so the next volume's
 * copy-forward refuses it with `reference-volume-unsealed`. Numbering (`.rejected`, `.rejected.2`, …) is
 * the shared door's, so a volume that fails twice keeps both failures.
 *
 * @param {{ values: Object, volumeDir: string }} ctx
 * @returns {Promise<string[]>} The names actually moved aside.
 */
async function quarantineGlossaryArtifact(ctx) {
  const aside = moveArtifactAside(ctx.volumeDir, OUTPUT_FILE_NAME);
  if (!aside.ok) {
    console.warn(
      `Volume ${ctx.values.INSTALLMENT_NUMBER}: could not move ${OUTPUT_FILE_NAME} aside ` +
        `(${aside.refusal.because}) — the volume is still a failure.`
    );
    return [];
  }
  if (!aside.moved) return [];
  if (aside.keptAside.length) {
    console.log(
      `Volume ${ctx.values.INSTALLMENT_NUMBER}: this volume has now been quarantined ${aside.slot} times. ` +
        `The earlier rejection(s) are kept: ${aside.keptAside.map((p) => path.basename(p)).join(", ")}.`
    );
  }
  return [path.basename(aside.moved)];
}

/**
 * Seal this volume's record at the end of the glossary stage's work on it — when the acceptance
 * gate accepted that work.
 *
 * The gate is the seal's precondition, not an advisory. `sealVolumeRecord` is what makes a
 * volume's record published and frozen, and freezing a record nobody signed off is how a bad
 * volume becomes seventeen volumes' worth of foundation: the next volume's copy-forward would
 * carry it, and the `reference-volume-unsealed` HIGH finding that exists to stop exactly that
 * would never fire. So a volume whose QA loop ran out its iterations under `ON_QA_LIMIT=accept`
 * leaves its record a draft, and the draft is what stops the next volume (gotcha 102).
 *
 * Idempotent, and deliberately not the last seal the volume gets — see the module header.
 *
 * @param {{ values: Object, refStore: Object|null, qaAccepted?: boolean }} ctx
 * @returns {{sealed: boolean, because: string|null}} What happened, so a caller and a log can see
 *   that a draft was left on purpose rather than by an accident on the way out.
 */
function sealGlossaryRecord(ctx) {
  if (!ctx.refStore) return { sealed: false, because: "no record is open for this volume" };
  if (ctx.qaAccepted !== true) {
    const volume = ctx.values.INSTALLMENT_NUMBER;
    console.log(
      `Volume ${volume}: the acceptance gate did not accept this volume's glossary, so its reference record is ` +
        "left a DRAFT and is not sealed. The next volume's copy-forward will refuse to build on it — that refusal " +
        "is the gate. Re-run the volume to grade it again, or reopen the record to re-derive it."
    );
    return { sealed: false, because: "the acceptance gate did not accept this volume" };
  }
  const sealed = sealVolumeRecord(ctx.refStore);
  console.log(
    `Volume ${ctx.values.INSTALLMENT_NUMBER}: reference record sealed by the glossary stage ` +
      `(${sealed.sealedRows} row(s) newly sealed${sealed.alreadySealed ? ", the record was already published" : ""}).`
  );
  return { sealed: true, because: null };
}

module.exports = {
  GLOSSARY_ARTIFACT_NAME,
  OUTPUT_FILE_NAME,
  openGlossaryRecord,
  fileGlossaryExtraction,
  fileGlossaryTermRows,
  glossaryTitleBlock,
  renderGlossaryArtifact,
  auditGlossaryArtifact,
  glossaryGradeSample,
  quarantineGlossaryArtifact,
  sealGlossaryRecord,
};
