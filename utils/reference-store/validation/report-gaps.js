/**
 * utils/reference-store/validation/report-gaps.js — the report sections about what the record is missing.
 *
 * Four sections: who is in this volume's text and who is not, every character the reference does not
 * cover with both signals measured, the claims the extraction found that the published document says
 * nothing about, and the terms the extraction found that the glossary has no row for. This is the half of
 * the old validator agent's job that a model might have noticed and a query does not miss — and each
 * section prints its own count in its own sentence before it names any rows, so the list bound cannot
 * hide the size of the problem.
 *
 * @module utils/reference-store/validation/report-gaps
 */

const { chapterList, clip, listLines } = require("./report-lines");
require("../../../types"); // JSDoc type definitions

/**
 * The "Who is in this volume's text" section, and the cast entries the volume's text does not print.
 *
 * @param {{measured: number, present: number, absent: number}|null} presence
 * @param {Array<{key: string, display: string}>} absent
 * @param {number|string} volume
 * @returns {string[]} The report lines, in order; empty when presence was never measured.
 */
function presenceSection(presence, absent, volume) {
  const out = [];
  if (presence) {
    out.push(`## Who is in this volume's text`);
    out.push("");
    out.push(
      `Measured from the volume's own chapter files: ${presence.measured} cast entries searched, ` +
        `${presence.present} found, ${presence.absent} not present` +
        (presence.matchRows ? ` — ${presence.matchRows} place(s) where a name occurs, recorded one per line with the rule that proved it.` : ".")
    );
    out.push("");
    if (absent.length) {
      out.push("These are the cast entries whose name this record holds does not occur in this volume's");
      out.push("text. An absence is not damage, and nothing here is allowed to rewrite a claim because");
      out.push("the character happened to stay off the page — but a character who is in the book under a");
      out.push("name the record does not carry looks exactly like this, so this list is worth reading.");
      out.push("");
      out.push(...listLines(absent, (entry) => `- ${entry.display} (\`${entry.key}\`) — not printed in volume ${volume}'s text; no entry is required for them`));
      out.push("");
    }
  }
  return out;
}

/**
 * The "Characters the reference does not cover" section, one row per uncovered character with both
 * signals measured and the verdict that follows from them.
 *
 * @param {{asked: boolean, chapters: number|null, measured: boolean, significanceChapters: number|null, rows: Array<Object>}} [coverage]
 * @returns {string[]} The report lines, in order; empty when the question was not asked or nothing was uncovered.
 */
function coverageSection(coverage) {
  const out = [];
  if (coverage && coverage.asked && coverage.rows && coverage.rows.length) {
    const k = coverage.significanceChapters;
    const chapters = coverage.chapters === null || coverage.chapters === undefined ? "?" : coverage.chapters;
    const high = coverage.rows.filter((row) => row.severity === "HIGH");
    const mentions = coverage.rows.filter((row) => row.severity === "MEDIUM");
    out.push("## Characters the reference does not cover");
    out.push("");
    out.push(
      `Every one of them, with both signals measured. A gap is a **loss** when the extraction found ` +
        `voice material for them or their name occurs in ${k} or more of this volume's ${chapters} ` +
        "chapters; it is a **mention** when neither is true. The line is a constant in " +
        "`utils/reference-store/integrity.js`, pinned by a test, and it has no environment knob."
    );
    out.push("");
    out.push("| character | in this volume's text | the extraction found | verdict |");
    out.push("|---|---|---|---|");
    for (const row of coverage.rows) {
      const inText = row.measured
        ? `${row.chapters} of ${chapters} chapters (${row.lines} line(s)${row.rules.length ? `; ${row.rules.join(", ")}` : ""})${chapterList(row.chapterIds)}`
        : "not measured";
      const found = row.extractionClaims > 0 ? `${row.extractionClaims} claim(s)` : "nothing";
      const verdict =
        row.severity === "HIGH"
          ? "**HIGH — a real loss**"
          : `MEDIUM — a mention (${row.why.replace(/^both signals are missing: /, "")})`;
      out.push(`| ${row.display} (\`${row.key}\`) | ${inText} | ${found} | ${verdict} |`);
    }
    out.push("");
    if (mentions.length) {
      out.push(
        `${mentions.length} of these are downgraded to MEDIUM, and each one is named above with the signal ` +
          "that was missing. That list is the price of softening the guard: a main character the book only " +
          "names once looks exactly like a throwaway here, and the only defence is that a human can see it."
      );
      out.push("");
    }
    if (high.length) {
      out.push(`${high.length} of them is why this volume's record will not be copied forward.`);
      out.push("");
    }
  }
  return out;
}

/**
 * The "Claims the extraction found that the reference says nothing about" section.
 *
 * @param {Array<{key: string, aspect: string, label: string|null, body: string, id: string}>} unadopted
 * @returns {string[]} The report lines, in order; empty when the reference adopted everything.
 */
function unadoptedClaimsSection(unadopted) {
  const out = [];
  if (unadopted.length) {
    out.push("## Claims the extraction found that the reference says nothing about");
    out.push("");
    out.push(`${unadopted.length} claim(s) the extraction pass produced with no claim of that kind about`);
    out.push("that character anywhere in the published document. This is the half of the old validator's");
    out.push("job that a model might have noticed and a query does not miss.");
    out.push("");
    out.push(...listLines(unadopted, (item) => `- **${item.key}** (${item.aspect}${item.label ? `, ${item.label}` : ""}) — ${clip(item.body)}`));
    out.push("");
  }
  return out;
}

/**
 * The "Terms the extraction found that the glossary has no row for" section.
 *
 * @param {Array<{term: string, label: string|null}>} unadoptedTermRows
 * @returns {string[]} The report lines, in order; empty when the glossary carries every term.
 */
function unadoptedTermsSection(unadoptedTermRows) {
  const out = [];
  if (unadoptedTermRows.length) {
    out.push("## Terms the extraction found that the glossary has no row for");
    out.push("");
    out.push(`${unadoptedTermRows.length} term(s) the extraction found that no glossary row carries.`);
    out.push("");
    out.push(...listLines(unadoptedTermRows, (item) => `- **${item.term}**${item.label ? ` (${item.label})` : ""}`));
    out.push("");
  }
  return out;
}

module.exports = {
  presenceSection,
  coverageSection,
  unadoptedClaimsSection,
  unadoptedTermsSection,
};
