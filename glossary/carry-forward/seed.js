/**
 * glossary/carry-forward/seed.js — start this volume's glossary from the previous volume's, without a model.
 *
 * Copying the baseline is deterministic, free, and exactly what the amend prompt was asking for.
 * The agent's job becomes the part a model is actually good at: insert a few rows.
 */

const fs = require("fs").promises;
const path = require("path");

const { parseGlossaryTableTerms, buildGlossaryIndex } = require("./table");

/** @typedef {import("../../../types").GlossaryVolumeCtx} GlossaryVolumeCtx */

/**
 * Seed this volume's glossary with the previous volume's, verbatim, before any
 * agent touches it.
 *
 * The amend pass has always been "the previous glossary, plus this volume's
 * new terms". Asking a model to reproduce that by hand is what broke: the
 * cumulative glossary passes the size of a single reply around volume 03 (the
 * output cap is a quarter of the context window — `harness.js` `envMaxTokens`
 * — and volume 05's glossary needs ~154k tokens against a 65,536-token cap),
 * so the agent could not obey "writeFile, complete contents". It fell back to
 * paging the file in 8–17 reads and patching it with 16–39 edits, ran out of
 * its step budget, and rebuilt the document from memory — which is how 457
 * terms disappeared between volumes 05 and 06.
 *
 * Copying the baseline is deterministic, free, and exactly what the prompt was
 * asking for. The agent's job becomes the part a model is actually good at:
 * insert a few rows.
 *
 * @param {GlossaryVolumeCtx} ctx - The volume context.
 * @returns {Promise<boolean>} True when the volume's glossary now starts from
 *   the previous volume's copy (so the amend prompt can say "edit it in place").
 */
async function seedGlossaryFromPrevious(ctx) {
  const { values, isFirst, previousGlossaryFile, glossaryOutputFile } = ctx;
  if (isFirst || !previousGlossaryFile) return false;

  let previousText;
  try {
    previousText = await fs.readFile(previousGlossaryFile, "utf8");
  } catch (err) {
    console.warn(
      `Volume ${values.INSTALLMENT_NUMBER}: could not read the previous glossary ` +
        `(${previousGlossaryFile}: ${err.message}) — the author agent will write ` +
        `this volume's glossary from scratch.`
    );
    return false;
  }
  if (!previousText || previousText.trim().length === 0) {
    console.warn(
      `Volume ${values.INSTALLMENT_NUMBER}: the previous glossary is empty — ` +
        `the author agent will write this volume's glossary from scratch.`
    );
    return false;
  }

  let replaced = false;
  try {
    const existing = await fs.readFile(glossaryOutputFile, "utf8");
    replaced = existing.trim() !== previousText.trim();
  } catch {
    replaced = true; // No file yet — the copy creates it.
  }

  await fs.writeFile(glossaryOutputFile, previousText, "utf8");
  ctx.glossarySeeded = true;
  // The map the amend pass needs in order to place a row without paging the
  // whole document (see buildGlossaryIndex).
  ctx.glossaryIndex = buildGlossaryIndex(previousText);
  if (replaced) {
    console.log(
      `Volume ${values.INSTALLMENT_NUMBER}: seeded glossary.md from ` +
        `../${path.basename(path.dirname(previousGlossaryFile))}/glossary.md ` +
        `(${parseGlossaryTableTerms(previousText).length} term(s) carried forward ` +
        `verbatim; the author agent amends it in place).`
    );
  }
  return true;
}

module.exports = { seedGlossaryFromPrevious };
