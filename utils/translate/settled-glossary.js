/**
 * utils/translate/settled-glossary.js — the terminology law the translation stage translates under.
 *
 * The account owner's decision (2026-10-13, `translate/plan/01-translation-route.md` §9 question 1):
 * the translator is constrained by **the settled terminology set** — the rendering the whole
 * pre-production pass ended on — and not by the volume's own `glossary.md`. A term a later volume
 * revised must reach **every** volume's chapters, volume 1's included. The superseded rendering is
 * deprecated: it is not offered to the model as an alternative anywhere, and it stays captured where
 * it already is — in the record's supersede chain and in the published file's `Earlier rendering:`
 * line.
 *
 * ## Why a file was the wrong source
 *
 * `utils/translate/references.js` used to read `glossary.md` out of the volume's own folder. That file
 * is a **snapshot of the terminology as of that volume** — `renderGlossary` prints the row in force at
 * the volume it renders for, and `publishedGlossaryRowsInRecord` bounds every chain at that volume on
 * purpose (it is what makes a re-run reproduce the past). A snapshot is the right artifact for the
 * question "what guidance did this volume actually get?", and the wrong one for "what rendering is this
 * series settled on?". Measured across the previous run's 17 glossary files: 555 distinct terms, 504
 * re-listed in two or more volumes, and exactly 2 whose English rendering ever changed — both of which
 * reached every later glossary file and **no already-written chapter**, because `chapterContextHash`
 * only fires forward.
 *
 * ## What "the settled record" means, and why it is not a constant
 *
 * Copy-forward carries every earlier volume's published rows into the next volume's record, so the
 * **highest-numbered volume record on disk** is the cumulative one, and asking it for the rows in force
 * at its own volume returns the newest row of every supersede chain. Which volume that is gets read off
 * the filesystem each call — the plan of record is not consulted for the number, because a run that
 * stopped at volume 11 has a settled set as of volume 11, and a run that has not built volume 17's
 * record must not be told it has one. Nothing here hardcodes 17, and nothing here falls back to the
 * volume's markdown: a missing record is a refusal (gotcha 119 — a stage silently reading the wrong
 * file as the book is exactly the failure this module exists to prevent).
 *
 * ## Reading only
 *
 * The translation stage must not write to a reference record. This module opens the record through
 * `openDatabase(file, { readOnly: true })` and hands the handle to the store's own read queries, which
 * need nothing but `db`. It never runs `applySchema`, never registers a volume row, and never opens the
 * write path — which also keeps it clear of gotcha 124 (opening a corpus record with a write-capable
 * client folds its write-ahead log in and deletes the sidecars in the folder it was read from).
 *
 * ## The published file and the machine-facing rule are compared, not assumed equal
 *
 * `glossary.md` stays exactly what the glossary stage renders. What this module adds is a deterministic,
 * zero-model-call comparison between what each published glossary file states for a term and what the
 * record states, run at translation time, naming every term where they disagree — including the one that
 * matters most: a published file still printing a rendering the record has superseded.
 *
 * CommonJS, no new dependency, JSDoc on every function.
 *
 * @module utils/translate/settled-glossary
 */

const fs = require("fs");
const path = require("path");

const { structuralError } = require("../../configs/shared");
const { seriesArtifactFile } = require("../../configs/shared");
const {
  openDatabase,
  referenceStoreSeriesDir,
  publishedGlossaryRowsInRecord,
  renderGlossary,
  REFERENCE_STORE_FILE_NAME,
} = require("../reference-store");
const { parseGlossaryTerms } = require("./terminology");
require("../../types"); // JSDoc type definitions

/** The artifact every published glossary file is called, in a folder and in a message. */
const GLOSSARY_FILE_NAME = "glossary.md";

/** The env key `publishLatestToSeriesRoot` was handed for it, so the comparison looks where the publish wrote. */
const GLOSSARY_SERIES_ENV_KEY = "GLOSSARY_OUTPUT_FILE";

/**
 * The error every refusal in this module uses.
 *
 * Structural on purpose: `ON_TASK_ERROR=continue` and `ON_VOLUME_ERROR=skip` must not walk past a stage
 * translating under no terminology law, for the same reason the prerequisite gate is structural
 * (gotcha 140).
 *
 * @param {string} message - The whole refusal, already naming what was looked for and where.
 * @returns {Error}
 */
function terminologyRefusal(message) {
  return structuralError(`[translation] ${message}`);
}

/**
 * One rendering compared with another.
 *
 * Trimmed only. A glossary rendering is a proper name the translator must reproduce, and folding case or
 * collapsing whitespace here would hide a real disagreement — the fixture's own "Forbidden Book" against
 * "the Forbidden Book" is the exact pair this comparison exists to name.
 *
 * @param {string} value
 * @returns {string}
 */
function renderingKey(value) {
  return String(value === null || value === undefined ? "" : value).trim();
}

/**
 * One term compared with another.
 *
 * Trimmed, because the record stores the term the render prints and the reader strips the cell wrappers a
 * markdown-writing model likes to add. Two doors that spell "the same term" differently is how a
 * comparison reports a disagreement that is only a space.
 *
 * @param {string} value
 * @returns {string}
 */
function termKey(value) {
  return String(value === null || value === undefined ? "" : value).trim();
}

/**
 * The volume folders under a series that hold a reference record, read from the disk.
 *
 * Immediate subfolders only, and only the file named `series.db` — a retired record is
 * `series.db.retired-<stamp>` and is retired, so it is not a candidate and is not mentioned.
 *
 * Each candidate is opened **read-only** and asked which volume it is out of its own `volumes` row: the
 * folder name is never parsed for a number, because the intake chooses folder names and a folder called
 * `(1)` beside an archive called `(1).epub` is exactly the case that has already fooled a folder-name
 * reading once (gotcha 119). The record's own row is the answer.
 *
 * @param {string} seriesDir - Absolute series folder.
 * @returns {{candidates: Array<{folder: string, file: string, volume: number|null, error: string|null}>, unreadable: Array<{folder: string, file: string, error: string}>}}
 */
function findReferenceRecords(seriesDir) {
  const candidates = [];
  const unreadable = [];
  let entries = [];
  try {
    entries = fs.readdirSync(seriesDir, { withFileTypes: true });
  } catch (err) {
    return { candidates, unreadable: [{ folder: "", file: seriesDir, error: String(err && err.message ? err.message : err) }] };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(seriesDir, entry.name, REFERENCE_STORE_FILE_NAME);
    if (!fs.existsSync(file)) continue;
    let db = null;
    try {
      db = openDatabase(file, { readOnly: true });
      const rows = db.prepare("SELECT volume, folder FROM volumes").all();
      const own = rows.find((row) => String(row.folder || "") === entry.name);
      const chosen = own || rows.reduce((best, row) => (best && Number(best.volume) >= Number(row.volume) ? best : row), null);
      if (!chosen) {
        unreadable.push({ folder: entry.name, file, error: "the record registers no volume, so which volume it is cannot be read from it" });
        continue;
      }
      candidates.push({ folder: entry.name, file, volume: Number(chosen.volume), error: null });
    } catch (err) {
      unreadable.push({ folder: entry.name, file, error: String(err && err.message ? err.message : err) });
    } finally {
      if (db) {
        try {
          db.close();
        } catch {
          /* a handle that will not close after a read is not a read problem */
        }
      }
    }
  }
  return { candidates, unreadable };
}

/**
 * The record that holds this series' settled terminology set.
 *
 * The highest-numbered volume record on disk. Copy-forward carries every earlier volume's published rows
 * into it, so its own volume is the furthest the terminology decision has reached, and asking it for the
 * rows in force at that volume returns the newest row of every supersede chain.
 *
 * Refuses — structurally, naming every folder it looked in — when no volume folder holds a readable
 * record. It does not fall back to a markdown file, and no setting reaches this decision.
 *
 * @param {Object} [opts]
 * @param {string} [opts.seriesDir] - Absolute series folder. Defaults to SERIES_LOCATION (read at call time).
 * @returns {{file: string, folder: string, volume: number, candidates: Array<{folder: string, file: string, volume: number}>, unreadable: Array<{folder: string, file: string, error: string}>}}
 * @throws {Error} structural, when no readable record exists
 */
function settledGlossaryRecord({ seriesDir } = {}) {
  const series = referenceStoreSeriesDir(seriesDir);
  const { candidates, unreadable } = findReferenceRecords(series);
  if (unreadable.length > 0) {
    throw terminologyRefusal(
      `a volume reference record under ${series} could not be read, and the settled terminology set is a chain: ` +
        `a record this stage cannot read is a record whose rows may be missing from the set it is about to translate under. ` +
        `Refused rather than continuing on the newest record that did open:\n  ${unreadable
          .map((c) => `${c.folder}/${REFERENCE_STORE_FILE_NAME} — ${c.error}`)
          .join("\n  ")}\n` +
        `  Fix: reopen that volume's record through the store's own door (npm run reopen -- --volume=NN --reason="…") ` +
        `or re-run npx gulp glossary for it. The stage will not read a terminology set it cannot vouch for.`
    );
  }
  if (candidates.length === 0) {
    const looked = `no volume folder under ${series} holds a ${REFERENCE_STORE_FILE_NAME}. The folders present: ${
      fs.readdirSync(series, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).join(", ") || "(none)"
    }`;
    throw terminologyRefusal(
      `the translation stage takes its terminology law from the settled reference record, and this series has none. ` +
        `Looked for it the way the store writes it — <volume folder>/${REFERENCE_STORE_FILE_NAME} — and ${looked}.\n` +
        `  Fix: run the pre-production steps first (npx gulp glossary builds and seals each volume's record), ` +
        `or point SERIES_LOCATION at the series you mean. The stage will not fall back to a volume's glossary.md: ` +
        `a run under a terminology law nothing reports is the failure this rule exists to prevent.`
    );
  }
  const settled = candidates.reduce((best, c) => (Number(c.volume) > Number(best.volume) ? c : best), candidates[0]);
  return {
    file: settled.file,
    folder: settled.folder,
    volume: Number(settled.volume),
    seriesDir: series,
    candidates: candidates.map((c) => ({ folder: c.folder, file: c.file, volume: Number(c.volume) })),
    unreadable,
  };
}

/**
 * The settled terminology set, read from the record that holds it.
 *
 * One row per term: the newest row of each supersede chain, whatever volume filed it. This is the one
 * place the translation stage asks the supersede question, and it is deliberately **not**
 * `publishedGlossaryRowsInRecord(store, { volume: <the chapter's volume> })` — that query bounds every
 * chain at the volume you name, which is the correct answer to "what did this volume's glossary say?"
 * and the wrong answer here: asked for volume 3 it hides a revision volume 11 filed. Asking the settled
 * record for the rows in force at **its own** volume is the same query with the bound placed where the
 * decision actually ended, so the chain collapses to its settled end and nothing new has to be trusted.
 *
 * The markdown returned is `renderGlossary` of those same rows, so the text the consistency audit is
 * shown has the shape of the published file rather than a second rendering invented here.
 *
 * @param {Object} [opts]
 * @param {string} [opts.seriesDir] - Absolute series folder. Defaults to SERIES_LOCATION (read at call time).
 * @param {Object} [opts.record] - A record already resolved by {@link settledGlossaryRecord}, so a caller that resolved it does not resolve it twice.
 * @param {string} [opts.title] - The title block to render with, for a caller that publishes the render
 *   as a document rather than reading it for its rows. `renderGlossary`'s own default is a bare heading;
 *   the glossary stage's published files carry its title block, and a series-root render meant to sit
 *   beside them has to carry the same one or the two files disagree about what they are.
 * @returns {{record: Object, rows: Array<Object>, glossaryText: string, termCount: number}}
 * @throws {Error} structural, when no readable record exists or the record cannot be read
 */
function readSettledGlossary({ seriesDir, record, title } = {}) {
  const settled = record || settledGlossaryRecord({ seriesDir });
  return withSettledRecord({ seriesDir, record: settled }, (handle) => {
    const rows = publishedGlossaryRowsInRecord(handle, { volume: settled.volume });
    const glossaryText = renderGlossary(handle, {
      volume: settled.volume,
      ...(title ? { title } : {}),
    });
    return { record: { ...settled, termCount: rows.length }, rows, glossaryText, termCount: rows.length };
  });
}

/**
 * Ask the settled record something, through a handle that cannot write.
 *
 * The read-only discipline lives here rather than in every caller: one `openDatabase(…, {readOnly: true})`,
 * one handle shaped the way the store's read queries want it (`{db, volume}` — no scope, no write door),
 * one close. A caller that opened the database itself would be one `readOnly` flag away from gotcha 124
 * (opening a corpus record with a write-capable client folds its write-ahead log in and deletes the
 * sidecars in the folder it was read from), and the glossary settlement pass needs the same rows the
 * translation stage reads plus the queries beside them.
 *
 * @param {Object} [opts]
 * @param {string} [opts.seriesDir] - Absolute series folder. Defaults to SERIES_LOCATION (read at call time).
 * @param {Object} [opts.record] - A record already resolved by {@link settledGlossaryRecord}.
 * @param {(handle: {db: Object, volume: number}) => any} use - Called once with the open handle; its return value is this function's.
 * @returns {any} Whatever `use` returned.
 * @throws {Error} structural, when no readable record exists or the record cannot be read
 */
function withSettledRecord({ seriesDir, record } = {}, use) {
  const settled = record || settledGlossaryRecord({ seriesDir });
  let db = null;
  try {
    db = openDatabase(settled.file, { readOnly: true });
    return use({ db, volume: settled.volume });
  } catch (err) {
    if (err && err.structural === true) throw err;
    throw terminologyRefusal(
      `the settled reference record at ${settled.file} could not be read: ` +
        `${String(err && err.message ? err.message : err)}.\n` +
        `  Fix: the record the glossary stage sealed is the source of the terminology law; re-run ` +
        `npx gulp glossary, or point SERIES_LOCATION at the series you mean.`
    );
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        /* nothing was written, so a handle that will not close cannot leave the record half-changed */
      }
    }
  }
}

/**
 * One published glossary file, read as terminology law.
 *
 * Read through `parseGlossaryTerms` — the same reader the stage uses — so the comparison cannot disagree
 * with the stage about what a row says, and so a file that pasted a superseded rendering into the
 * rendering column is refused by that reader rather than compared as if it were a rendering.
 *
 * @param {string} file - Absolute path to a `glossary.md`.
 * @returns {{present: boolean, file: string, terms: Map<string, {term: string, rendering: string}>, order: string[]}}
 */
function readPublishedGlossaryFile(file) {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { present: false, file, terms: new Map(), order: [] };
  }
  const terms = new Map();
  const order = [];
  for (const entry of parseGlossaryTerms(text)) {
    const key = termKey(entry.term);
    if (!key || terms.has(key)) continue;
    terms.set(key, { term: entry.term, rendering: renderingKey(entry.rendering) });
    order.push(key);
  }
  return { present: true, file, terms, order };
}

/**
 * Compare one published glossary file against the settled record, term by term.
 *
 * Three disagreements, because a file can be wrong three different ways:
 *   - **differences** — the file states a rendering and the record settles a different one. This is the
 *     one that matters most when the file is the series' final one: the human-facing glossary and the
 *     rule the chapters are translated under have drifted apart.
 *   - **missingFromFile** — the record settles a term the file does not list at all.
 *   - **missingFromRecord** — the file lists a term the record holds no row for.
 *
 * @param {{present: boolean, file: string, terms: Map<string, {term: string, rendering: string}>, order: string[]}} published
 * @param {Array<{term: string, rendering: string, superseded: Array<Object>}>} rows - The settled rows.
 * @param {{label: string, volume?: number|null}} context - Named in every finding, because a disagreement
 *   nobody can locate is a disagreement nobody can fix. `volume` is the volume that settled the rendering.
 * @returns {{label: string, file: string, present: boolean, differences: Array<Object>, missingFromFile: Array<Object>, missingFromRecord: Array<Object>}}
 */
function compareOnePublishedFile(published, rows, { label, volume = null } = {}) {
  // An absent file is not 137 disagreements: it is nothing published yet. The caller reports the absence
  // itself, and a count of "drifts" invented by a file that does not exist would be a number nothing can
  // act on.
  if (!published.present) {
    return { label, file: published.file, present: false, differences: [], missingFromFile: [], missingFromRecord: [] };
  }
  const settled = new Map();
  for (const row of rows) {
    const key = termKey(row.term);
    if (!key || settled.has(key)) continue;
    settled.set(key, { term: row.term, rendering: renderingKey(row.rendering), superseded: row.superseded || [] });
  }
  const differences = [];
  const missingFromRecord = [];
  for (const key of published.order) {
    const fileEntry = published.terms.get(key);
    const recordEntry = settled.get(key);
    if (!recordEntry) {
      missingFromRecord.push({ term: fileEntry.term, fileRendering: fileEntry.rendering });
      continue;
    }
    if (fileEntry.rendering === recordEntry.rendering) continue;
    const replaced = recordEntry.superseded.find((row) => renderingKey(row.rendering) === fileEntry.rendering) || null;
    differences.push({
      term: fileEntry.term,
      fileRendering: fileEntry.rendering,
      recordRendering: recordEntry.rendering,
      settledByVolume: volume,
      // True when the file is not merely different but is still printing the rendering the record
      // replaced — the shape a stale or hand-edited published file produces.
      fileStatesSupersededRendering: Boolean(replaced),
      supersededFromVolume: replaced ? Number(replaced.appliesFromVolume) : null,
    });
  }
  const missingFromFile = [];
  for (const [key, recordEntry] of settled) {
    if (published.terms.has(key)) continue;
    missingFromFile.push({ term: recordEntry.term, recordRendering: recordEntry.rendering });
  }
  return {
    label,
    file: published.file,
    present: published.present,
    differences,
    missingFromFile,
    missingFromRecord,
  };
}

/**
 * The deterministic, zero-model-call check that the published glossary files and the settled record say
 * the same thing.
 *
 * Two files are compared, because two files are in play and they answer different questions:
 *
 *   - **the series-root cumulative `glossary.md`** — the file `publishLatestToSeriesRoot` copies up as
 *     the series' final glossary, and which nothing in the codebase read before this slice. A
 *     disagreement here is real drift: the human-facing final glossary contradicts the rule every chapter
 *     is translated under.
 *   - **the volume's own `glossary.md`** — a snapshot of the terminology **as of that volume**, which is
 *     what it was built to be. A disagreement here is expected and is reported as such: it is the
 *     difference between what volume 1's file says and what volume 1's chapters are now translated with,
 *     and a reader of that folder is entitled to be told out loud.
 *
 * @param {Object} opts
 * @param {string} [opts.seriesDir] - Absolute series folder. Defaults to SERIES_LOCATION (read at call time).
 * @param {string} [opts.volumeDir] - The volume folder whose own snapshot is compared.
 * @param {Object} [opts.record] - A record already resolved by {@link settledGlossaryRecord}.
 * @param {Array<Object>} [opts.rows] - Settled rows already read, so a caller that read them does not read them twice.
 * @returns {{record: Object, series: Object, volume: Object, driftCount: number}}
 */
function compareSettledGlossary({ seriesDir, volumeDir, record, rows } = {}) {
  const settled = rows && record ? { record, rows } : readSettledGlossary({ seriesDir, record });
  const seriesFile = seriesArtifactFile(GLOSSARY_FILE_NAME, GLOSSARY_SERIES_ENV_KEY, settled.record.seriesDir || seriesDir);
  const series = compareOnePublishedFile(readPublishedGlossaryFile(seriesFile), settled.rows, {
    label: `the series-root ${GLOSSARY_FILE_NAME}`,
    volume: settled.record.volume,
  });
  const volume = volumeDir
    ? compareOnePublishedFile(readPublishedGlossaryFile(path.join(volumeDir, GLOSSARY_FILE_NAME)), settled.rows, {
        label: `this volume's own ${GLOSSARY_FILE_NAME}`,
        volume: settled.record.volume,
      })
    : null;
  const driftCount =
    series.differences.length + series.missingFromFile.length + series.missingFromRecord.length;
  return { record: settled.record, series, volume, driftCount };
}

/**
 * The lines a run prints about the terminology law it is translating under, and about every published
 * file that disagrees with it.
 *
 * Printed, not filed. A disagreement between a stage's own finding list and the post-mortem never reaches
 * the delivery layer today (gotcha 138), so declaring a finding kind for it would be a promise the layer
 * cannot keep; the question of whether it should become one is written down rather than decided here.
 *
 * @param {Object} comparison - A {@link compareSettledGlossary} result.
 * @param {{volumeLabel?: string}} [opts] - How the volume is called in the lines.
 * @returns {string[]} The lines, empty when everything agrees and there is nothing to say beyond the law itself.
 */
function describeSettledGlossary(comparison, { volumeLabel = "" } = {}) {
  const rec = comparison.record;
  const lines = [
    `terminology law: the settled reference record at ${rec.folder}/${REFERENCE_STORE_FILE_NAME} ` +
      `(volume ${rec.volume}) — ${rec.termCount === undefined ? "its" : `${rec.termCount} term(s)`}. ` +
      `A rendering a later volume replaced is used everywhere, and the replaced one is not offered as an alternative.`,
  ];
  const named = (list) =>
    list
      .map(
        (d) =>
          `"${d.term}" — file says "${d.fileRendering}", the record settles "${d.recordRendering}"` +
          (d.fileStatesSupersededRendering
            ? ` (the file is still printing the rendering the record replaced, in force from volume ${d.supersededFromVolume})`
            : "")
      )
      .join("; ");

  const series = comparison.series;
  if (series.present) {
    if (series.differences.length) {
      lines.push(
        `DRIFT — ${series.label} (${series.file}) disagrees with the record on ${series.differences.length} term(s): ${named(series.differences)}`
      );
    }
    if (series.missingFromFile.length) {
      lines.push(
        `DRIFT — ${series.label} (${series.file}) does not list ${series.missingFromFile.length} term(s) the record settles: ` +
          series.missingFromFile.map((d) => `"${d.term}"→"${d.recordRendering}"`).join(", ")
      );
    }
    if (series.missingFromRecord.length) {
      lines.push(
        `DRIFT — ${series.label} (${series.file}) lists ${series.missingFromRecord.length} term(s) the record holds no row for: ` +
          series.missingFromRecord.map((d) => `"${d.term}"→"${d.fileRendering}"`).join(", ")
      );
    }
  } else {
    lines.push(
      `no series-root ${GLOSSARY_FILE_NAME} at ${series.file} — the record is the only published statement of the terminology law.`
    );
  }

  const volume = comparison.volume;
  if (volume && volume.present && volume.differences.length) {
    // One line per superseded term, with the volume its rendering was in force from. This is the block
    // a reader can act on — the file in this folder says X and this volume's chapters are translated
    // with Y — and a semicolon-joined run of them is the block nobody reads.
    lines.push(
      `${volumeLabel || "this volume"}'s own ${GLOSSARY_FILE_NAME} states ${volume.differences.length} rendering(s) the record has since ` +
        `replaced; its chapters are translated with the record's:`
    );
    for (const d of volume.differences) lines.push(`  - ${named([d])}`);
  }
  if (volume && volume.present && volume.missingFromFile.length) {
    // A count, not a list. A volume's own snapshot not listing the terms the series introduces later is
    // the expected shape of a snapshot — volume 1's file cannot contain volume 9's coinages — and naming
    // 417 of them on a 17-volume series buries the two lines a reader can actually do something about.
    const shown = volume.missingFromFile.slice(0, 10).map((d) => `"${d.term}"→"${d.recordRendering}"`).join(", ");
    lines.push(
      `${volumeLabel || "this volume"}'s own ${GLOSSARY_FILE_NAME} does not list ${volume.missingFromFile.length} term(s) the settled record ` +
        `introduces later in the series${volume.missingFromFile.length > 10 ? ` (${volume.missingFromFile.length - 10} more not named)` : ""}: ${shown}`
    );
  }
  return lines;
}

module.exports = {
  GLOSSARY_FILE_NAME,
  findReferenceRecords,
  settledGlossaryRecord,
  withSettledRecord,
  readSettledGlossary,
  compareSettledGlossary,
  describeSettledGlossary,
};
