/**
 * character-voice/reading/read-report.js — the one job: format the block the volume's validation report
 * carries about **how this volume was read**, for whoever reads the report including the acceptance grader.
 *
 * The mirror of `glossary/extract/read-report.js` (which reports the term lists that never answered), for
 * the same reason: a reference assembled from chapters that had to be re-read is a different artifact from
 * one where every chapter came back whole, and the difference has to be visible in the grader's own
 * materials rather than only in the run log.
 *
 * Part of the character-voice/reading.js layer.
 *
 * @module character-voice/reading/read-report
 */

require("../../types"); // JSDoc type definitions

/**
 * The block the validation report carries about **how this volume was read**.
 *
 * A reference assembled from chapters that had to be re-read is a different artifact from one where
 * every chapter came back whole, and the difference has to be visible to whoever reads the report —
 * including the grader, whose message list includes it. This is where "volume 02's chapters 4 and 5
 * were thin" stops being something only the run log knows.
 *
 * **It reports the chapter's whole reading history, not just this pass.** A partial carries every paid
 * read it took, and a re-run reuses the partial and pays for nothing — so a report triggered only by what
 * *this* pass paid for goes quiet exactly when the volume is re-run after the damage was already paid for.
 * Measured on the real volume 02 on 2026-10-12: after its two cut-off chapters were re-read and the stage
 * ran again, every chapter was reused, `paidReads` was 0 for all seven, and the block vanished from
 * `character-voice-validation.md` — the grader was shown a reference whose most expensive chapters had
 * each taken two reads, with nothing in its materials saying so. The trigger is therefore the number of
 * paid reads **recorded on the chapter**, whoever paid for them.
 *
 * @param {Array<{id: string, entries?: Array<Object>, claims?: number, reused?: boolean, paidReads?: number, incomplete?: boolean, cutOff?: boolean, attempts?: Array<Object>}>} chapters
 * @param {{volume: string|number}} opts
 * @returns {string} A markdown block, or "" when every chapter came back whole on its first paid read.
 */
function readingReport(chapters, { volume }) {
  const rows = chapters.map((chapter) => {
    const claims = chapter.entries ? chapter.entries.length : chapter.claims;
    const attempts = chapter.attempts && chapter.attempts.length ? chapter.attempts : [];
    const levels = attempts.map((a) => `${a.thinkingLevel || "run default"}: ${a.claims}${a.cutOff ? " (cut off)" : ""}`).join(", ");
    return {
      id: chapter.id,
      claims,
      reused: Boolean(chapter.reused),
      paidReads: chapter.paidReads === undefined ? attempts.length : chapter.paidReads,
      // What the chapter cost in total, across every pass that touched it. A reused partial carries the
      // attempts of the pass that paid for them, and that is the number the report has to answer with.
      reads: attempts.length,
      incomplete: Boolean(chapter.incomplete || chapter.cutOff),
      levels: levels || (chapter.reused ? "reused from a complete partial" : "—"),
      // Carried through so the "shown nothing" count below can see it. `undefined` (a chapter from a pass
      // that predates this field, or one whose partial was reused) is normalised to `null`: not measured.
      knownCharacters: chapter.knownCharacters === undefined ? null : chapter.knownCharacters,
    };
  });
  const incomplete = rows.filter((r) => r.incomplete);
  const retried = rows.filter((r) => r.reads > 1);
  // `null` means the chapter was never asked (its partial was reused), so it is not a chapter that was
  // read with nothing known. Only a measured zero counts.
  const nothingKnown = rows.filter((r) => r.knownCharacters === 0);
  if (!incomplete.length && !retried.length && !nothingKnown.length) return "";

  const out = [
    "## How this volume was read",
    "",
    `_Every chapter of this volume was read on its own. A chapter whose answer never reached its closing bracket was cut off — half an answer, with the rest unwritten — and was re-read once at the retry level named in its row below. ${incomplete.length ? "The chapters still cut off after both paid reads are named below." : "No chapter was still cut off after its re-read."}_`,
    "",
    "| chapter | claims kept | paid reads | shown as already known | how it was read |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const row of rows) {
    const shown = row.knownCharacters === null ? "not measured (reused)" : `${row.knownCharacters} character(s)`;
    out.push(`| ${row.id} | ${row.claims} | ${row.reads}${row.reused ? " (reused — paid for in an earlier pass)" : ""} | ${shown} | ${row.levels}${row.incomplete ? " — **INCOMPLETE**" : ""} |`);
  }
  out.push("");
  if (incomplete.length) {
    out.push(
      `**${incomplete.length} of ${rows.length} chapter(s) are incomplete**: ${incomplete.map((r) => r.id).join(", ")}. ` +
        "Their claims are in the reference; whatever their answers never got to writing is not, and nothing here can tell you what that was."
    );
  } else {
    out.push(`All ${rows.length} chapter(s) came back whole.`);
  }
  out.push("");
  if (nothingKnown.length) {
    out.push(
      `**${nothingKnown.length} of ${rows.length} chapter(s) were read with nothing known about anybody in them**: ` +
        `${nothingKnown.map((r) => r.id).join(", ")}. This volume's reference record carries a roster, and none of it is named in those ` +
        `chapters' own text by the same rule the record's audit matches names with. Those chapters were asked what is new with no ` +
        `"here is what we already know" beside the question. That is a fact about the chapter and the roster's spellings, not about the record being empty.`
    );
    out.push("");
  }
  return out.join("\n");
}

module.exports = {
  readingReport,
};
