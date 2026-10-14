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
 *   `fileGlossaryTermRows` (what the glossary will publish) → `fileGlossaryRevisions` (what this volume
 *   says an earlier volume published wrongly) → `renderGlossaryArtifact` (the published file) →
 *   `auditGlossaryArtifact` + `glossaryGradeSample` (the gate) → `sealGlossaryRecord`.
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
  importGlossaryRevisions,
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
 * The block the validation report carries about **what this volume revised**.
 *
 * The mirror of `extractionReadReport`, for the same reason and with the same destination: a glossary
 * where volume 7 changed a rendering volume 1 published is a different artifact from one where nothing
 * was changed, and the acceptance grader's message list already contains this file. The gate cannot
 * re-derive the change from the published file — the file prints the new rendering and one history line
 * — so the report is where the replaced rendering, the line the revision came from, and the reason are
 * all named together.
 *
 * Refused revisions are named with the rule that refused them. That is the half that matters most: a
 * read pass that proposed a revision justified by the previous glossary's own row rather than by this
 * volume's book has to be visible, or the next volume gets the same silent rewrite the last series run
 * produced twice and never reported.
 *
 * @param {{filed: Array<Object>, replaced: Array<Object>, alreadyFiled: Array<string>, refused: Array<Object>}|null} revisions - What `fileGlossaryRevisions` returned.
 * @param {{volume: string|number}} opts
 * @returns {string} A markdown block, or "" when this volume revised nothing and refused nothing.
 */
function revisionReport(revisions, { volume }) {
  if (!revisions) return "";
  const filed = Array.isArray(revisions.filed) ? revisions.filed : [];
  const replaced = Array.isArray(revisions.replaced) ? revisions.replaced : [];
  const refused = Array.isArray(revisions.refused) ? revisions.refused : [];
  const already = Array.isArray(revisions.alreadyFiled) ? revisions.alreadyFiled : [];
  if (!filed.length && !refused.length && !already.length) return "";

  const out = [
    "## Revisions this volume filed",
    "",
    "_A revision replaces a rendering an **earlier volume** published. The earlier row is not edited and " +
      "not removed: it stays in the record marked `superseded`, and the published file prints the new " +
      "rendering with a line naming the old one and the volume it was in force from. A revision is filed " +
      `only when the line it quotes is in volume ${volume}'s own text. ` +
      (refused.length
        ? `${refused.length} proposed revision(s) were refused.`
        : filed.length
          ? " Every proposed revision was filed."
          : ""),
    "",
  ];

  if (filed.length) {
    /**
     * One stored column read as the array it holds.
     *
     * `getFact` hands back the row as the database holds it, and `examples` / `evidence` are JSON columns.
     * A report that printed them raw would print `["禁忌の書","the Forbidden Book"]` where it means to
     * print the two cells it is comparing.
     *
     * @param {Object|string|null} value
     * @returns {Array<Object>}
     */
    const column = (value) => {
      if (Array.isArray(value)) return value;
      try {
        const parsed = JSON.parse(String(value || "[]"));
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    };
    out.push("| term | replaced rendering | new rendering | in force from | the line it comes from | why |");
    out.push("| --- | --- | --- | --- | --- | --- |");
    for (let i = 0; i < filed.length; i += 1) {
      const fact = filed[i] || {};
      const before = replaced[i] || {};
      const examples = column(fact.examples);
      const evidence = column(fact.evidence);
      const quote = evidence.length ? String(evidence[0].quote || "") : "";
      const cell = (value) => String(value || "").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
      out.push(
        `| ${cell(before.term || examples[0])} | ${cell(before.rendering)} | ${cell(examples[1])} | ` +
          `volume ${volume} (replacing volume ${before.appliesFromVolume ?? "?"}) | ` +
          `${cell(quote ? `"${quote}"` : "—")} | ${cell(fact.body || "—")} |`
      );
    }
    out.push("");
  }

  if (already.length) {
    const distinct = [...new Set(already)];
    out.push(
      `${distinct.length} term(s) were already settled by this volume's own revision and were not filed twice` +
        `${distinct.length < already.length ? ` (${already.length} proposals in total, one per chapter that read them)` : ""}: ` +
        `${distinct.join(", ")}.`
    );
    out.push("");
  }

  if (refused.length) {
    // One line per distinct refusal, with how many times it was proposed. The chapter-by-chapter route
    // asks every chapter the same question, and a report that printed the same refusal twelve times
    // would bury the one fact the grader needs: which term kept the rendering it already had.
    /** @type {Map<string, {item: Object, times: number}>} */
    const byRule = new Map();
    for (const item of refused) {
      const key = `${item.rule}|${item.term}|${item.rendering}|${item.quote}`;
      const seen = byRule.get(key);
      if (seen) seen.times += 1;
      else byRule.set(key, { item, times: 1 });
    }
    out.push(
      `**${refused.length} revision proposal(s) were refused${byRule.size === refused.length ? "" : ` (${byRule.size} distinct)`}, and the term keeps the rendering it already had.**`
    );
    out.push("");
    for (const { item, times } of byRule.values()) {
      out.push(
        `- \`${item.rule}\` — "${item.term}" → "${item.rendering}"${times > 1 ? ` (proposed ${times} times)` : ""}: ${item.because}` +
          `${item.reason ? `\n  the answer's stated reason: ${item.reason}` : ""}`
      );
    }
    out.push("");
  }

  return out.join("\n");
}

/**
 * File this volume's revisions in its record — the renderings of **earlier volumes' rows** that this
 * volume's own text shows to be wrong.
 *
 * The third filing door, and the only one that touches a term the record already holds.
 * `fileGlossaryExtraction` files what the read pass noticed (never rendered); `fileGlossaryTermRows`
 * files the new published rows; this one files a **replacement row** beside the row it replaces, which
 * is the only legal way to change a term an earlier volume already published, because a sealed row is
 * never edited.
 *
 * It refuses rather than warns. A revision whose quote is not in this volume's text is not filed with a
 * note attached to it — it is not filed at all, and the term keeps the rendering it had. That is the
 * guard against the failure this feature would otherwise create: a later volume silently rewriting what
 * every earlier volume was translated against.
 *
 * @param {{ values: Object, folderName: string, seriesDir: string, refStore: Object|null }} ctx
 * @param {Array<Object>} revisions - The read pass's `revisions` array.
 * @returns {Object|null} The filing report, or null when no record is open.
 */
function fileGlossaryRevisions(ctx, revisions) {
  if (!ctx.refStore) return null;
  const filed = importGlossaryRevisions(ctx.refStore, revisions);
  // The chapter-by-chapter route files per chapter and audits once, so the report has to describe the
  // whole volume. Accumulating is what makes the revision that landed in chapter 1 still be named in the
  // report the grader reads after chapter twelve.
  const prior = ctx.storeRevisions;
  ctx.storeRevisions = prior
    ? {
        ok: prior.ok && filed.ok,
        filed: [...prior.filed, ...filed.filed],
        replaced: [...prior.replaced, ...filed.replaced],
        alreadyFiled: [...prior.alreadyFiled, ...filed.alreadyFiled],
        refused: [...prior.refused, ...filed.refused],
      }
    : filed;
  const volume = ctx.values.INSTALLMENT_NUMBER;
  if (filed.filed.length || filed.refused.length || filed.alreadyFiled.length) {
    console.log(
      `Volume ${volume}: reference record filed ${filed.filed.length} revision(s) of terms earlier volumes ` +
        `published (${filed.alreadyFiled.length} already filed, ${filed.refused.length} refused).`
    );
  }
  for (const item of filed.refused) {
    console.error(
      `Volume ${volume}: revision of "${item.term}" → "${item.rendering}" REFUSED — ${item.rule}: ${item.because}`
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
 * (`glossary/extract.js`'s `extractionReadReport`) **plus the block about what this volume revised**
 * (`revisionReport`). It is appended here rather than in `glossary/qa.js`, because this is the function
 * that owns the report's content, and it is the mirror of `character-voice/store.js`'s
 * `auditVoiceArtifact`, which appends its own `readingReport` the same way. The reason both stages do it:
 * a glossary built from ten reads of which one never answered is a different artifact from one built from
 * ten that answered, and a glossary that quietly changed what volume 1 said is a different artifact from
 * one that did not — and the grader's message list already contains this file, so this is the one place
 * those facts reach the gate without inventing a second gate.
 *
 * Each read that never produced a list also becomes a finding (`chapter-extraction-never-answered`, HIGH,
 * declared MAJOR in the level table). **What that finding reaches, stated plainly.** It is in the report the
 * grader reads, it is on the console, it is on `ctx.extractionFindings`, and — since the finding channel was
 * built — `glossary/task.js` hands that list to `utils/series-run/findings.js` at the end of every volume it
 * read, which writes it into the run's records (`utils/postmortem/channel.js`). The post-mortem then reads it
 * back while assessing this volume (`utils/postmortem/run.js` → `channel.js`), so the finding is a finding:
 * routed by its level through the resume triage, able to halt the volume walk at the volume boundary
 * (`utils/postmortem/halt.js`), recorded in the ledger, and printed in the step's own report. The level is
 * the table's, never this stage's: the channel stores severity, kind, file and message and looks the level
 * up again when it reads the record back.
 * A refused revision is still named in the report and on the console and is still NOT a finding kind, because
 * a kind the delivery layer cannot reach is a promise rather than a guard (gotcha 138) — and adding a kind is
 * a row in `utils/postmortem/levels.js`, which is the account owner's decision.
 *
 * @param {{ values: Object, refStore: Object|null, glossaryOutputFile: string, storeTermRows: Object|null, storeRevisions?: Object|null, extractionReads?: Array<Object> }} ctx
 * @param {{ refused?: Array<Object> }} [opts] - The filings this volume refused, so the report names them
 *   instead of leaving a term the read pass found unexplained.
 * @returns {Promise<Object|null>} The audit, its markdown carrying the read and revision blocks, or null
 *   when no record is open.
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

  ctx.storeAudit = null;
  const revisionBlock = revisionReport(ctx.storeRevisions, { volume });
  const extraBlocks = [readReport, revisionBlock].filter(Boolean).join("\n");
  ctx.storeAudit = extraBlocks ? { ...audit, markdown: `${audit.markdown}\n${extraBlocks}` } : audit;
  console.log(
    `Volume ${ctx.values.INSTALLMENT_NUMBER}: deterministic audit — ${audit.findings.length} finding(s), ` +
      `${audit.highFindings.length} at HIGH; ${audit.checked} citation(s) re-checked against the source text.` +
      `${ctx.extractionFindings.length ? ` Plus ${ctx.extractionFindings.length} read(s) that never answered (see the report).` : ""}` +
      `${revisionBlock ? " Plus this volume's revisions, filed and refused (see the report)." : ""}`
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
  fileGlossaryRevisions,
  revisionReport,
  glossaryTitleBlock,
  renderGlossaryArtifact,
  auditGlossaryArtifact,
  glossaryGradeSample,
  quarantineGlossaryArtifact,
  sealGlossaryRecord,
};
