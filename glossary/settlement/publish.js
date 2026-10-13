/**
 * glossary/settlement/publish.js — the series-root `glossary.md`, rendered out of the settled record.
 *
 * **What used to happen.** `publishLatestToSeriesRoot` copied the last volume's `glossary.md` up to the
 * series root. That file is a *snapshot of the terminology as of that volume*: `renderGlossary` prints
 * the row in force at the volume it renders for, and `publishedGlossaryRowsInRecord` bounds every
 * supersede chain at that volume on purpose, because a per-volume file has to answer "what guidance did
 * this volume actually get?". For the last volume of a finished series the two answers usually agree —
 * which is exactly why the difference was invisible until it was measured: across the previous run's 17
 * published files, 2 terms had their rendering changed by a later volume, and the series' own final
 * glossary was the last place a human would look for a rendering the translation stage no longer uses.
 *
 * **What happens now.** The root file is `renderGlossary` of the settled record's rows — the newest row
 * of every chain — with the same title block the per-volume renders carry. It is not a copy of any
 * volume's file, and it is not a second rendering invented here: it is the same renderer, the same row
 * query and the same order the volume files are built from, asked at the volume the decision ended at.
 *
 * Two things this keeps. **Every per-volume `glossary.md` is untouched** — a volume's own file is the
 * record of what that volume was told, and this pass does not rewrite history. And the render is
 * deterministic: no model call, no timestamp in the body, so a run that changes nothing writes a
 * byte-identical file.
 *
 * @module glossary/settlement/publish
 */

const fs = require("fs").promises;

const { seriesArtifactFile } = require("../../configs/shared");
const { writeProvenanceSidecar } = require("../../utils/fs");
const { REFERENCE_STORE_FILE_NAME } = require("../../utils/reference-store");
const { readSettledGlossary, settledGlossaryRecord } = require("../../utils/translate");
require("../../types"); // JSDoc type definitions

/** The artifact name, in a folder, in a message and in the declaration. */
const GLOSSARY_FILE_NAME = "glossary.md";

/** The env key `publishLatestToSeriesRoot` used to be handed for it, kept so the destination is the same file. */
const GLOSSARY_SERIES_ENV_KEY = "GLOSSARY_OUTPUT_FILE";

/**
 * The lines of a rendered glossary that are data rows.
 *
 * The same count `glossary/store.js` makes: every section's table costs one header line shaped like a
 * data row, and the separator line is not shaped like one.
 *
 * @param {string} markdown
 * @returns {{rows: number, sections: number, bytes: number}}
 */
function renderedGlossaryShape(markdown) {
  const sections = (markdown.match(/^## /gm) || []).length;
  const tableLines = (markdown.match(/^\| (?!-)/gm) || []).length;
  return { rows: Math.max(0, tableLines - sections), sections, bytes: Buffer.byteLength(markdown, "utf8") };
}

/**
 * The series-root glossary file this pass publishes to.
 *
 * @param {string} seriesDir - Absolute series folder.
 * @returns {string} Absolute path.
 */
function seriesRootGlossaryFile(seriesDir) {
  return seriesArtifactFile(GLOSSARY_FILE_NAME, GLOSSARY_SERIES_ENV_KEY, seriesDir);
}

/**
 * The series glossary, rendered out of the settled record, WITHOUT writing it.
 *
 * The render has to be computable before the act, because the freeze gate asks "would this rewrite
 * something?" and the only honest answer is the file the act would produce compared with the file that
 * is already there. A door that answered "yes, it rewrites" on the strength of having been asked would
 * refuse a run that changes nothing.
 *
 * @param {Object} opts
 * @param {string} opts.seriesDir - Absolute series folder.
 * @param {{SOURCE_NAME: string, SOURCE_LANGUAGE: string, TARGET_LANGUAGE: string}} opts.values - The run settings the title block is built from.
 * @param {Object} [opts.settled] - A settled record already resolved by `settledGlossaryRecord`.
 * @returns {{markdown: string, rows: number, sections: number, bytes: number, record: Object, destination: string}}
 */
function renderSettledGlossaryForSeriesRoot({ seriesDir, values, settled }) {
  const settledRecord = settled || settledGlossaryRecord({ seriesDir });
  const read = readSettledGlossary({
    seriesDir,
    record: settledRecord,
    title: settledGlossaryTitleBlock(values, settledRecord),
  });
  const shape = renderedGlossaryShape(read.glossaryText);
  return {
    markdown: read.glossaryText,
    rows: shape.rows,
    sections: shape.sections,
    bytes: shape.bytes,
    record: read.record,
    destination: seriesRootGlossaryFile(seriesDir),
  };
}

/**
 * The title block the series-root render carries.
 *
 * The per-volume renders say "this volume's reference record" because that is what they are rendered
 * from. The series render is not one volume's snapshot — it is the settled record, the newest row of
 * every supersede chain — and a reader of the file at the series root has to be able to tell which
 * they are holding. Reusing the volume stage's block verbatim would print "this volume's" on a file
 * that is not a volume's, which is the kind of sentence that makes a reader trust the wrong thing.
 *
 * @param {{SOURCE_NAME: string, SOURCE_LANGUAGE: string, TARGET_LANGUAGE: string}} values
 * @param {{volume: number, folder: string}} settled - The settled record the render was made from.
 * @returns {string} The title block, without a trailing newline.
 */
function settledGlossaryTitleBlock(values, settled) {
  const installment = String(settled.volume).padStart(2, "0");
  return [
    `# Glossary — ${values.SOURCE_NAME}`,
    "",
    `_Canonical ${values.TARGET_LANGUAGE} renderings for translating ${values.SOURCE_NAME} ` +
      `(${values.SOURCE_LANGUAGE} → ${values.TARGET_LANGUAGE}). Current through volume ${installment}._`,
    "",
    `_Rendered from the series' settled reference record (${settled.folder}): every row below is a row that ` +
      "record holds, every row was checked against a line the book prints, and where a later volume replaced " +
      "a rendering this file prints the replacement — not the rendering the volume that first introduced the " +
      "term published._",
  ].join("\n");
}

/**
 * Publish the series' glossary by rendering the settled record.
 *
 * Refuses rather than publishing an empty table, for the reason gotcha 58 gives: a run that produced
 * nothing must not replace the series' living glossary with a title and no rows. The existing root file
 * is left exactly where it is.
 *
 * @param {Object} opts
 * @param {string} opts.seriesDir - Absolute series folder.
 * @param {{SOURCE_NAME: string, SOURCE_LANGUAGE: string, TARGET_LANGUAGE: string}} opts.values - The run settings the title block is built from.
 * @param {Object} [opts.settled] - A settled record already resolved by `settledGlossaryRecord`, so a caller that resolved it does not resolve it twice.
 * @returns {Promise<{ok: boolean, destination: string, rows: number, sections: number, bytes: number, record: Object|null, refusal: {rule: string, because: string, fix: string}|null}>}
 */
async function publishSettledGlossaryToSeriesRoot({ seriesDir, values, settled }) {
  const rendered = renderSettledGlossaryForSeriesRoot({ seriesDir, values, settled });
  const destination = rendered.destination;
  const record = rendered.record;
  const shape = { rows: rendered.rows, sections: rendered.sections, bytes: rendered.bytes };

  if (shape.rows <= 0) {
    return {
      ok: false,
      destination,
      rows: 0,
      sections: shape.sections,
      bytes: shape.bytes,
      record,
      refusal: {
        rule: "settled-glossary-render-has-no-rows",
        because:
          `the settled record at ${record.folder}/${REFERENCE_STORE_FILE_NAME} ` +
          `rendered to a ${shape.bytes}-byte file with a title and no rows. The series-root ${GLOSSARY_FILE_NAME} was left where it is: ` +
          "a render with no rows is not allowed to replace the series' glossary.",
        fix: "the volume records hold the rows; re-run npx gulp glossary, or check that the settled record is the volume you mean.",
      },
    };
  }

  await fs.writeFile(destination, rendered.markdown, "utf8");
  // The sidecar names the RECORD this render came from, not a volume folder's markdown file, because
  // that is the honest answer to "where did the series glossary come from" now.
  await writeProvenanceSidecar(destination, record.file);

  console.log(
    `\nRendered the series ${GLOSSARY_FILE_NAME} out of the settled record ` +
      `(${record.folder}, volume ${record.volume}) — ${shape.rows} row(s) across ` +
      `${shape.sections} section(s), ${shape.bytes} bytes, no model call.\n  ${destination}`
  );
  return { ok: true, destination, rows: shape.rows, sections: shape.sections, bytes: shape.bytes, record, refusal: null };
}

module.exports = {
  GLOSSARY_FILE_NAME,
  GLOSSARY_SERIES_ENV_KEY,
  renderedGlossaryShape,
  settledGlossaryTitleBlock,
  seriesRootGlossaryFile,
  renderSettledGlossaryForSeriesRoot,
  publishSettledGlossaryToSeriesRoot,
};
