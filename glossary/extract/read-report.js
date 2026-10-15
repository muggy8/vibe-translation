/**
 * glossary/extract/read-report.js — the one job: format the block the volume's validation report carries
 * about **how its term lists were read**.
 *
 * The mirror of `character-voice/reading.js`'s `readingReport`, for the same reason: a glossary built from
 * ten reads of which one never answered is a different artifact from one built from ten that answered, and
 * the difference has to be visible to whoever reads the report — including the acceptance grader, whose
 * message list already contains this file (`prompt-audit.js`'s `acceptance-context` rule is what proves it
 * does).
 */

require("dotenv").config();
require("../../types"); // JSDoc type definitions

/**
 * The block the volume's validation report carries about **how its term lists were read**.
 *
 * The mirror of `character-voice/reading.js`'s `readingReport`, for the same reason: a glossary built
 * from ten reads of which one never answered is a different artifact from one built from ten that
 * answered, and the difference has to be visible to whoever reads the report — including the
 * acceptance grader, whose message list already contains this file (`prompt-audit.js`'s
 * `acceptance-context` rule is what proves it does).
 *
 * @param {Array<{id: string, title?: string, terms?: number, attempts?: Array<Object>, failed?: boolean}>} reads - One entry per paid read pass, in reading order.
 * @param {{volume: string|number}} opts
 * @returns {string} A markdown block, or "" when every read answered.
 */
function extractionReadReport(reads, { volume }) {
  const rows = (reads || []).map((read) => {
    const attempts = read.attempts && read.attempts.length ? read.attempts : [];
    const levels = attempts
      .map((a) => `${a.thinkingLevel}: ${a.terms}${a.failure ? ` (${a.failure.kind})` : ""}`)
      .join(", ");
    return {
      id: read.id,
      title: read.title || "",
      terms: read.terms === undefined ? attempts.reduce((n, a) => Math.max(n, a.terms), 0) : read.terms,
      reads: attempts.length,
      failed: Boolean(read.failed),
      because: read.failed && attempts.length ? (attempts[attempts.length - 1].failure || {}).because || "" : "",
      levels: levels || "—",
    };
  });
  const failed = rows.filter((r) => r.failed);
  const retried = rows.filter((r) => r.reads > 1);
  if (!failed.length && !retried.length) return "";

  const out = [
    "## How this volume's terms were read",
    "",
    `_Every term list this volume was built from is paid for at most twice, and a list that failed was ` +
      "re-asked once. **Every one of them is asked for in a declared answer shape** — the term list wrapped " +
      "in an object (`{\"terms\": […]}`), because this endpoint refuses a `response_format` schema whose root " +
      "is an array before it generates (measured 2026-10-13 — HTTP 400, 0 tokens; gotcha 138). The shape is " +
      "what makes the answer close and parse; it is not what makes it thorough. " +
      `${failed.length ? `${failed.length} read(s) never produced a list at all.` : "Every read produced a list."}`,
    "",
    "| read | terms filed | paid reads | how it was read |",
    "| --- | --- | --- | --- |",
  ];
  for (const row of rows) {
    out.push(
      `| ${row.id}${row.title ? ` (${row.title})` : ""} | ${row.terms} | ${row.reads} | ${row.levels}${row.failed ? " — **NOTHING READ**" : ""} |`
    );
  }
  out.push("");
  if (failed.length) {
    out.push(
      `**${failed.length} of ${rows.length} read(s) produced no term list.** ${failed.map((r) => r.id).join(", ")}. ` +
        "Every term those reads were supposed to find is missing from this glossary, and from every later " +
        "volume's, because the glossary is copied forward. Nothing here can say which terms they were."
    );
    for (const row of failed) {
      if (row.because) out.push(`- ${row.id}: ${String(row.because).slice(0, 400)}`);
    }
  } else {
    out.push(`All ${rows.length} read(s) answered.`);
  }
  out.push("");
  return out.join("\n");
}

module.exports = { extractionReadReport };
