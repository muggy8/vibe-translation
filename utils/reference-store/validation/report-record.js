/**
 * utils/reference-store/validation/report-record.js — the report sections about the record itself.
 *
 * Five sections, all of them about what happened to this volume's record rather than about what it
 * contains: how the reference came to exist (rebuilt by code from the volume's own extraction, or not),
 * whether the record is sealed and what sealing does and does not claim, the rows the store refused to
 * record and the quotations it refused to publish, and the reopen history the record carries — this
 * volume's own reopens and the ones that travelled in with the copy-forward. Each is lifted out of
 * `report.js` verbatim and prints exactly the lines it printed before.
 *
 * @module utils/reference-store/validation/report-record
 */

const { rebuildProvenanceCounts } = require("../document-prose");
const { listLines } = require("./report-lines");
require("../../../types"); // JSDoc type definitions

/**
 * The "How this reference was written" section: what a code-only rebuild adopted, and how many of those
 * claims are also kept as extraction candidates beside them.
 *
 * @param {{at: string, filed: number, carried: number, refused: number, characters: number, candidatesFiled?: number|null, candidatesRefused?: number|null}|null} rebuilt
 * @returns {string[]} The report lines, in order; empty when nothing rebuilt this reference.
 */
function provenanceSection(rebuilt) {
  const out = [];
  if (rebuilt) {
    const counts = rebuildProvenanceCounts(rebuilt);
    out.push("## How this reference was written");
    out.push("");
    out.push(
      `**This volume's character-voice reference was rebuilt by code from its own extraction output** ` +
        `on ${rebuilt.at}: ${counts.claims} claim(s) adopted about ${counts.characters} character(s), ` +
        `${counts.refused} refused` +
        (counts.unkeyed ? `, ${counts.unkeyed} claim(s) with no character to file them under` : "") +
        "."
    );
    out.push("");
    if (counts.candidates !== null) {
      out.push(
        `${counts.candidates} of those claims are also filed a second time as extraction ` +
          `candidates${counts.candidatesRefused ? ` (${counts.candidatesRefused} candidate copy could not be filed)` : ""}. ` +
          "That is the record's second reading of the same book: what the extractor found, kept beside " +
          "what this reference says, so \"the reference lost something the extraction found\" stays a question " +
          "the store can answer about a rebuilt volume instead of one it has to take on trust."
      );
      out.push("");
    }
    out.push("No author agent wrote it and no reader has reviewed it. Every bullet in it cites a line of");
    out.push("this volume's text, which is more than an unreviewed artifact usually has; what it does not");
    out.push("have is a reader. An author pass over this file is what turns it into a reviewed reference.");
    out.push("");
  }
  return out;
}

/**
 * The sealed / not-sealed sections, printed only when this audit is the one that decided the question.
 *
 * @param {{state: "sealed"|"not-sealed", at?: string, rows?: number, snapshot?: number, alreadySealed?: boolean, because: string}} [sealed]
 * @param {number|string} volume
 * @returns {string[]} The report lines, in order; empty when the caller passed no sealing answer.
 */
function sealingSections(sealed, volume) {
  const out = [];
  if (sealed && sealed.state === "sealed") {
    out.push("## This volume's record is sealed");
    out.push("");
    out.push(
      `Sealed at ${sealed.at}${sealed.alreadySealed ? " (it was already sealed; sealing again changed nothing)" : ""}: ` +
        `every row volume ${volume} owns in this store is now published — it can be contested or superseded, ` +
        `never edited or deleted, and ${sealed.snapshot} fact(s) were frozen into the snapshot of what this ` +
        "volume actually published. The next volume's copy-forward is now allowed to build on this record; " +
        "before this, it refused."
    );
    out.push("");
    out.push(
      "Sealing is not a claim that anybody read this reference. It is the claim that this is what the volume " +
        "published, and the record keeps the two apart: the provenance finding above says nobody reviewed it, " +
        "and an author pass is what would change that."
    );
    out.push("");
  }
  if (sealed && sealed.state !== "sealed") {
    out.push("## This volume's record is not sealed");
    out.push("");
    out.push(sealed.because);
    out.push("");
    out.push(
      "A record that is not sealed is a draft: the next volume's copy-forward refuses it with " +
        "`reference-volume-unsealed`, which is the check that keeps \"published\" meaning published."
    );
    out.push("");
  }
  return out;
}

/**
 * The "Rows the store refused to record" section.
 *
 * @param {Array<{character: string|null, label: string|null, because: string}>} refused
 * @returns {string[]} The report lines, in order; empty when the store refused nothing.
 */
function refusedRowsSection(refused) {
  const out = [];
  if (refused.length) {
    out.push("## Rows the store refused to record");
    out.push("");
    out.push(`${refused.length} claim(s) the store would not record. Two things get a claim refused here:` +
      " a quote that does not verify against the book, and an answer to a register question this series");
    out.push("did not declare or did not declare that answer for. Neither is quietly dropped, and neither");
    out.push("is filed as something else — these are the claims the store turned down, with the reason.");
    out.push("");
    out.push(...listLines(refused, (item) => `- ${item.character ? `**${item.character}**` : ""}${item.label ? ` (${item.label})` : ""} — ${item.because}`));
    out.push("");
  }
  return out;
}

/**
 * The "Citations the store refused to publish" section: the quotations dropped from a published bullet
 * because they carried the writer's own note inside them.
 *
 * @param {Array<{kind: string, character: string|null, label?: string|null, dropped: Array<{example: string, because: string}>}>} screened
 * @returns {string[]} The report lines, in order; empty when nothing was screened.
 */
function screenedSection(screened) {
  const out = [];
  if (screened.length) {
    const dropped = screened.reduce((sum, item) => sum + item.dropped.length, 0);
    out.push("## Citations the store refused to publish");
    out.push("");
    out.push(`${dropped} span(s) across ${screened.length} claim(s) were offered as quotations but carry the`);
    out.push("writer's own note inside them — a citation with `(wait, … — need to recheck)` glued to it is");
    out.push("not a citation. The claim stands on the quote that did verify; these spans were dropped from");
    out.push("the published bullet and are named here. The extraction's own copy of the claim keeps them,");
    out.push("so the record still shows what the extractor wrote.");
    out.push("");
    out.push(...listLines(screened, (item) =>
      `- ${item.character ? `**${item.character}**` : "unattached"}${item.label ? ` (${item.label})` : ""} — ${item.dropped.map((d) => `dropped: ${d.example.replace(/\s+/g, " ").slice(0, 120)} (${d.because})`).join("; ")}`));
    out.push("");
  }
  return out;
}

/**
 * The reopen sections: this volume's own reopens, and the reopen rows that came in with the copy-forward.
 *
 * @param {Array<{reopened_at: string, reason: string, was_sealed: boolean, sealed_at: string|null, copies_affected: number[]}>} reopens
 * @param {number|string} volume
 * @returns {string[]} The report lines, in order; empty when the record carries no reopen history.
 */
function reopenSections(reopens, volume) {
  const out = [];
  // Two different facts, and the record holds both. `record_reopens` is a counted table, so a copy-forward
  // carries its source's reopen history into the copy — which is what makes the staleness guard answerable
  // (see `reopen.js`). It also means a volume that was never reopened itself can be sitting on a record
  // that was thrown away and rebuilt because the volume it was copied from was. Saying only "this volume
  // was redone" would leave volume 2 silent about the fact that its entire record is a redo.
  const ownReopens = reopens.filter((item) => Number(item.volume) === Number(volume));
  const inheritedReopens = reopens.filter((item) => Number(item.volume) !== Number(volume));

  if (ownReopens.length) {
    out.push("## This volume's record was reopened");
    out.push("");
    out.push("A sealed record is a record later volumes were built on. Reopening one is a deliberate act,");
    out.push("recorded in the record itself (`record_reopens`) rather than only in a log, so whoever reads");
    out.push("this file months from now can see that this volume was redone, when, and why.");
    out.push("");
    out.push(...listLines(ownReopens, (item) =>
      `- volume ${item.volume}: reopened ${item.reopened_at}${item.was_sealed ? ` (it was sealed since ${item.sealed_at || "unknown"})` : ""} — reason given: ${item.reason}` +
      (item.copies_affected && item.copies_affected.length
        ? `; the record(s) copied from it that this act marked: ${item.copies_affected.map((c) => `volume ${c}`).join(", ")}`
        : "")));
    out.push("");
  }

  if (inheritedReopens.length) {
    out.push("## This record was rebuilt from a volume that was reopened");
    out.push("");
    out.push("These reopen rows are not this volume's — they travelled in with the copy-forward, because a");
    out.push("copy copies the record whole and `record_reopens` is one of the counted tables. They are the");
    out.push("evidence the staleness guard reads: a record copied **before** a redo holds fewer of its");
    out.push("source's reopen rows than the source holds now. Read them as a warning about the foundation,");
    out.push("not as damage to this volume.");
    out.push("");
    out.push(...listLines(inheritedReopens, (item) =>
      `- volume ${item.volume} (this record was copied from it): reopened ${item.reopened_at}${item.was_sealed ? " (it had been sealed)" : ""} — reason given: ${item.reason}`));
    out.push("");
  }
  return out;
}

module.exports = {
  provenanceSection,
  sealingSections,
  refusedRowsSection,
  screenedSection,
  reopenSections,
};
