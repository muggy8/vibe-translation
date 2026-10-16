/**
 * glossary/re-render/publish.js — replacing a published glossary with the render of its own record.
 *
 * The comparison in `compare.js` is the gate, not a report. This file refuses to write a render that
 * would take anything away from a published document, and it names every row it would take away:
 *
 *   - a render with no rows is refused, the same guard the glossary stage's own render carries (a title
 *     and an empty table is not a glossary, and it must not stand where one was);
 *   - a render that drops a row the published file holds is refused, with the rule that refused that row
 *     already named by {@link compareGlossaryRender};
 *   - a render that changes a row's rendering, notes or section, or adds a row the file does not hold, is
 *     refused for the same reason from the other side;
 *   - a render that is not byte-identical to the file it replaces is written only when the caller says the
 *     file may be moved aside, and the file it replaces survives as `glossary.md.rejected` — the shape
 *     `classifyVolumeQuarantine` reads as the copy a re-render replaced (LOW), not as a gate refusal.
 *
 * There is no flag past the first three. A door that would publish a loss when `--force` is typed is a
 * door whose comparison is decoration.
 *
 * @module glossary/re-render/publish
 */

const fs = require("fs");
const path = require("path");

const { moveArtifactAside } = require("../../utils/reference-store/quarantine");
const { refusal } = require("../../utils/reference-store/refusals");
require("../../types"); // JSDoc type definitions

/** The artifact this door re-renders. */
const GLOSSARY_ARTIFACT = "glossary.md";

/**
 * Count the rows and sections a rendered glossary holds, the way the glossary stage counts them.
 *
 * @param {string} markdown
 * @returns {{rows: number, sections: number, bytes: number}}
 */
function measureGlossaryRender(markdown) {
  const sections = (String(markdown || "").match(/^## /gm) || []).length;
  // Every section's table costs one header line that matches the shape of a data row; the separator
  // line does not. Same arithmetic `glossary/store.js`'s render uses, so the two cannot disagree about
  // how many rows a file holds.
  const tableLines = (String(markdown || "").match(/^\| (?!-)/gm) || []).length;
  return {
    rows: Math.max(0, tableLines - sections),
    sections,
    bytes: Buffer.byteLength(String(markdown || ""), "utf8"),
  };
}

/**
 * Write the render into the volume folder, or refuse and say why.
 *
 * @param {Object} opts
 * @param {string} opts.volumeDir - The volume folder.
 * @param {string} opts.markdown - The rendered document.
 * @param {Object} opts.comparison - The {@link compareGlossaryRender} result, or null when the volume has
 *   no published glossary yet (filling a hole is not a rewrite).
 * @param {boolean} opts.artifactPresent - Whether `glossary.md` is in the folder.
 * @param {boolean} [opts.moveAside] - Permission to move the file this render replaces to `.rejected`.
 * @returns {Promise<{ok: boolean, written: string|null, moved: string|null, unchanged: boolean, asideSlot: number, keptAside: string[], measured: {rows: number, sections: number, bytes: number}, refusal: Object|null}>}
 */
async function publishGlossaryRender({ volumeDir, markdown, comparison, artifactPresent, moveAside = false }) {
  const target = path.join(volumeDir, GLOSSARY_ARTIFACT);
  const measured = measureGlossaryRender(markdown);

  if (measured.rows <= 0) {
    return {
      ok: false,
      written: null,
      moved: null,
      unchanged: false,
      asideSlot: 0,
      keptAside: [],
      measured,
      refusal: refusal({
        verb: "re_render_glossary",
        rule: "glossary-render-has-no-rows",
        because:
          `rendering this volume's record produced a ${measured.bytes}-byte glossary with ${measured.sections} ` +
          "section(s) and no rows. A render with no rows is not allowed to replace a published glossary.",
        fix: "the volume's record has to hold glossary rows before it can be re-rendered.",
      }),
    };
  }

  if (comparison) {
    if (comparison.lostRows.length > 0) {
      return {
        ok: false,
        written: null,
        moved: null,
        unchanged: false,
        asideSlot: 0,
        keptAside: [],
        measured,
        refusal: refusal({
          verb: "re_render_glossary",
          rule: "glossary-render-would-lose-rows",
          because:
            `this render holds ${comparison.rowsRendered} row(s) where the published file holds ` +
            `${comparison.rowsOnDisk}, so publishing it would remove ${comparison.lostRows.length} row(s). ` +
            comparison.lostRows
              .slice(0, 5)
              .map((row) => `${JSON.stringify(row.term)} — ${row.rule}: ${row.because}`)
              .join("; "),
          fix: "re-derive the volume, or teach the evidence rule what the row cites, before re-rendering it.",
        }),
      };
    }
    if (comparison.gainedRows.length > 0 || comparison.changedRows.length > 0) {
      return {
        ok: false,
        written: null,
        moved: null,
        unchanged: false,
        asideSlot: 0,
        keptAside: [],
        measured,
        refusal: refusal({
          verb: "re_render_glossary",
          rule: "glossary-render-would-change-rows",
          because:
            `this render adds ${comparison.gainedRows.length} row(s) and rewrites ${comparison.changedRows.length} ` +
            "cell(s) of the published file. A render-only door republishes what the record already says; it is " +
            "not a door for changing what a volume's glossary claims.",
          fix: "file the change through the door that owns it (the revision door), then re-render.",
        }),
      };
    }
  }

  const existing = artifactPresent ? fs.readFileSync(target, "utf8") : null;
  const unchanged = existing !== null && existing === markdown;
  if (unchanged) {
    return { ok: true, written: null, moved: null, unchanged: true, asideSlot: 0, keptAside: [], measured, refusal: null };
  }
  if (artifactPresent && !moveAside) {
    return {
      ok: false,
      written: null,
      moved: null,
      unchanged: false,
      asideSlot: 0,
      keptAside: [],
      measured,
      refusal: refusal({
        verb: "re_render_glossary",
        rule: "glossary-render-will-not-overwrite-an-artifact",
        because:
          `${target} already exists and is not byte-identical to this render. A published glossary is replaced ` +
          `only when the file it replaces is kept as \`${GLOSSARY_ARTIFACT}.rejected\`, never silently.`,
        useInstead: ["moveArtifactAside(volumeDir, 'glossary.md') — keep the published file, then write", "keep the published file and do not re-render"],
        fix: "say what happens to the existing glossary before publishing a render over it.",
      }),
    };
  }

  let moved = null;
  let asideSlot = 0;
  /** @type {string[]} */
  let keptAside = [];
  if (moveAside && artifactPresent) {
    const aside = moveArtifactAside(volumeDir, GLOSSARY_ARTIFACT);
    if (!aside.ok) {
      return { ok: false, written: null, moved: null, unchanged: false, asideSlot: 0, keptAside: [], measured, refusal: aside.refusal };
    }
    moved = aside.moved;
    asideSlot = aside.slot;
    keptAside = aside.keptAside.map((p) => path.basename(p));
  }

  const temp = `${target}.writing`;
  await fs.promises.writeFile(temp, markdown, "utf8");
  await fs.promises.rename(temp, target);
  return { ok: true, written: target, moved, unchanged: false, asideSlot, keptAside, measured, refusal: null };
}

module.exports = {
  GLOSSARY_ARTIFACT,
  measureGlossaryRender,
  publishGlossaryRender,
};
