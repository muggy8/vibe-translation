/**
 * utils/reference-store/validation/report.js — the audit report the feedback stage and the grader read.
 *
 * One job: turn the findings and the answers the rest of this folder produced into the Markdown file the
 * acceptance loop has always read, under the same name. The sections are printed in the order they have
 * always been printed in, and the `**Recommendation:**` line is the rule the loop and `test/prompt-audit.js`
 * read — any HIGH finding means revise, else any MEDIUM means revise (minor), else accept — which the
 * acceptance grade maps onto a score band.
 *
 * The header, the severity-grouped findings and the "What was checked" table are printed here, in order,
 * because the table's rows read almost every value the caller passed: lifting them into another file
 * would mean handing that file the whole call signature to produce one table row. The narrative sections
 * are printers — `report-record.js` (how the record came to be, whether it is sealed, what it refused,
 * its reopen history), `report-gaps.js` (who is not in the volume, who the reference does not cover, what
 * the extraction found that the document never took), `report-axes.js` (which declared register questions
 * this record can answer and how many of its claims answer none) and `report-attribution.js` (who is
 * speaking the words the claims quote) — and each one prints exactly the lines it printed before this file
 * was split.
 *
 * @module utils/reference-store/validation/report
 */

const { numberOr } = require("./report-lines");
const { provenanceSection, refusedRowsSection, reopenSections, screenedSection, sealingSections } = require("./report-record");
const { coverageSection, presenceSection, unadoptedClaimsSection, unadoptedTermsSection } = require("./report-gaps");
const { attributionSection } = require("./report-attribution");
const { axisAnswerTableRows, axisAnswerSection } = require("./report-axes");
require("../../../types"); // JSDoc type definitions

/**
 * Render the audit report the feedback stage reads.
 *
 * The file keeps the name and the reader it has always had; what changed is that it is written from
 * rows. Findings are grouped by severity because the feedback stage works in that order, and the
 * two "no damage here" sections are printed even when empty — a report that is silent about what it
 * checked is indistinguishable from a report that checked nothing.
 *
 * @param {Object} report
 * @param {string} report.title - Report heading, e.g. "Character-voice reference".
 * @param {string} report.file - The artifact the audit describes.
 * @param {number|string} report.volume - Volume label.
 * @param {PostMortemFinding[]} report.findings - Store and artifact findings together.
 * @param {Object<string, number>} [report.counts] - The store's table counts.
 * @param {number} [report.checked] - How many evidence items were re-checked against the source.
 * @param {boolean} [report.coverageAsked] - False when the roster-coverage question was not asked
 *   because this volume's character-voice document has not been mirrored into the record yet.
 * @param {Array<{key: string, aspect: string, label: string|null, body: string, id: string}>} [report.unadopted]
 * @param {Array<{key: string, display: string}>} [report.absent]
 * @param {Array<{term: string, label: string|null}>} [report.unadoptedTerms]
 * @param {{measured: number, present: number, absent: number}|null} [report.presence]
 * @param {Array<{character: string|null, label: string|null, because: string}>} [report.refused]
 * @param {{at: string, filed: number, carried: number, refused: number, characters: number, candidatesFiled?: number|null, candidatesRefused?: number|null}|null} [report.rebuilt]
 *   Set when this volume's character-voice reference was rebuilt by code from its extraction output.
 * @param {{asked: boolean, chapters: number|null, measured: boolean, significanceChapters: number|null, rows: Array<Object>}} [report.coverage]
 *   The coverage question's whole answer, one row per uncovered character with both signals measured.
 *   This is what a softened guard has to pay for visibility: every character the audit downgraded is
 *   named here, with the signal that was missing.
 * @param {{state: "sealed"|"not-sealed", at?: string, rows?: number, snapshot?: number, alreadySealed?: boolean, because: string}} [report.sealed]
 *   Set when this audit is the one that decides whether the volume's record becomes immutable. The
 *   rebuild publishes a reference and seals the record that describes it in the same act, so its report
 *   has to say which happened; the pipeline's own audits leave this out because they run before the
 *   stage seals, and "not yet" is not a finding there.
 * @param {{rows: number, backfill: {at: string, imported: number, carried: number, refused: number, artifact: string}|null}} [report.glossary]
 *   How many glossary rows this volume's own record holds, and whether they arrived through the
 *   completeness rule instead of the glossary stage. Printed even when the answer is zero: the hole this
 *   rule exists to close was silent, and a report that does not print the number is the same silence.
 * @param {{conflicts: number, merged: Array<{merged: string, survivor: string, heading: string, movedFacts: number}>, ambiguous: Array<{merged: string, heading: string, names: string[]}>, refused: Array<{merged: string, survivor: string, because: string}>} | null} [report.roster]
 * @param {Array<{kind: string, character: string|null, label?: string|null, dropped: Array<{example: string, because: string}>}>} [report.screened] - Claims that were adopted with one or more of their offered quotations dropped, because the span carried the writer's own note inside it.
 * @param {Array<{reopened_at: string, reason: string, was_sealed: boolean, sealed_at: string|null, copies_affected: number[]}>} [report.reopens] - This record's reopen history, read out of `record_reopens`.
 *   What the roster rule found when this volume's record was opened: entries whose own heading names
 *   another entry on the roster. Printed even when the answer is "none", because a merge that moves a
 *   character's claims is exactly the kind of change a reader of the record should be able to see.
 * @param {{volume: number, asked: boolean, because: string|null, establishedClaims: number, skeletonMinChars: number, dialogueClaims: number, narrationClaims: number, speechAspectClaims: number, narratorClaims: number, groups: Array<Object>, answered: Array<Object>}|null} [report.attribution]
 *   The attribution account for this volume: how many of its claims cite speech rather than narration,
 *   how many the record attributes to the narrator, and every roster entry holding claims this volume's
 *   own text does not measure it in — with the reading-aid probe's answer beside each one. Printed
 *   because "the reference says nothing about this character" and "the reference puts this person's words
 *   in the wrong mouth" are different defects, and only one of them was ever reportable.
 * @param {Object|null} [report.axes] - `registerAxisInventory`'s answer for this record: which declared
 *   register questions it can answer, claim by claim, and how many of its character-voice claims answer no
 *   declared question at all (plan 06 slice 5). Printed whenever it was computed, including when the
 *   answer is zero — the silence this slice exists to close was a silence about the majority of a record.
 * @returns {string} Markdown, ending in a newline.
 */
function renderAuditReport({
  title,
  file,
  volume,
  findings,
  counts = null,
  checked,
  coverageAsked,
  unadopted = [],
  absent = [],
  unadoptedTerms: unadoptedTermRows = [],
  presence = null,
  refused = [],
  rebuilt = null,
  coverage = null,
  sealed = null,
  glossary = null,
  roster = null,
  screened = [],
  reopens = [],
  attribution = null,
  axes = null,
}) {
  const out = [
    `# ${title} — deterministic audit (volume ${volume})`,
    "",
    "Written by code from this volume's reference store (`series.db`). No model read the artifact to",
    "produce this report, and every number in it is a query result.",
    "",
  ];

  out.push(...provenanceSection(rebuilt));

  const order = ["HIGH", "MEDIUM", "LOW"];
  const high = findings.filter((f) => f.severity === "HIGH").length;
  const medium = findings.filter((f) => f.severity === "MEDIUM").length;
  out.push(
    `**Recommendation:** ${
      high
        ? `revise — ${high} HIGH finding(s) must be fixed before this volume is accepted.`
        : medium
          ? `revise (minor) — ${medium} finding(s) to correct; none of them blocks acceptance.`
          : "accept — no finding at any severity."
    }`
  );
  out.push("");
  for (const severity of order) {
    const group = findings.filter((f) => f.severity === severity);
    if (group.length === 0) continue;
    out.push(`## ${severity} findings`);
    out.push("");
    for (const item of group) {
      out.push(`- \`${item.kind}\` — ${item.message}`);
    }
    out.push("");
  }
  if (findings.length === 0) {
    out.push("## Findings");
    out.push("");
    out.push("None. Every question the store can ask about this volume was asked, and none of them");
    out.push("had an answer that indicates damage.");
    out.push("");
  }

  out.push("## What was checked");
  out.push("");
  out.push("| question | answer |");
  out.push("|---|---|");
  out.push(`| facts in the store | ${numberOr(counts, "facts")} |`);
  out.push(`| characters in the cast | ${numberOr(counts, "cast")} |`);
  out.push(`| chapters of this volume's text | ${numberOr(counts, "chapters")} |`);
  if (glossary) {
    let glossaryAnswer;
    if (glossary.backfill) {
      glossaryAnswer =
        `**${glossary.rows}** — read from this volume's own \`${glossary.backfill.artifact}\` when its record was opened ` +
        `(${glossary.backfill.imported} new row(s), ${glossary.backfill.carried} already in the record from earlier volumes, ` +
        `${glossary.backfill.refused} refused at the evidence rule)`;
    } else if (glossary.rows === 0) {
      glossaryAnswer = "**0** — this volume's record holds no glossary rows, and it has no published glossary to import";
    } else {
      glossaryAnswer = `**${glossary.rows}** — this volume's glossary stage read them in`;
    }
    out.push(`| glossary rows this volume's record holds | ${glossaryAnswer} |`);
  }
  if (roster) {
    let rosterAnswer;
    if (roster.merged.length) {
      rosterAnswer =
        `**${roster.merged.length} folded** — ` +
        roster.merged
          .map((m) => `${m.merged} → ${m.survivor} (${m.movedFacts} claim(s) moved; its heading is "${m.heading}")`)
          .join("; ");
    } else if (roster.ambiguous.length || roster.refused.length) {
      const parts = [];
      if (roster.ambiguous.length) {
        parts.push(
          roster.ambiguous.map((a) => `${a.merged} names ${a.names.join(" and ")} — reported, not merged`).join("; ")
        );
      }
      if (roster.refused.length) parts.push(roster.refused.map((r) => `${r.merged} → ${r.survivor}: ${r.because}`).join("; "));
      rosterAnswer = `**${roster.conflicts} conflict(s), none merged** — ${parts.join("; ")}`;
    } else {
      rosterAnswer = "none — no entry's own heading names another entry on the roster";
    }
    // The fold's answer is only half the question. On the read-then-assemble route every heading is the
    // key verbatim, so the signal the fold reads is never there, and a roster can hold a character under a
    // bare pronoun beside the same character under their name while this row still says "none".
    if (Array.isArray(roster.pronounEntries) && roster.pronounEntries.length) {
      rosterAnswer +=
        `; **but ${roster.pronounEntries.length} entr(ies) keyed by a bare first-person pronoun** — ` +
        roster.pronounEntries
          .map(
            (p) =>
              `${p.key} (${p.claims} claim(s)${p.candidates.length ? `; the roster also carries ${p.candidates.join(", ")}` : ""})`
          )
          .join("; ") +
        ". See the finding of the same name.";
    }
    out.push(`| roster entries that are the same person | ${rosterAnswer} |`);
  }
  if (roster && Array.isArray(roster.unattached)) {
    out.push(
      `| claims filed with no roster entry | ${
        roster.unattached.length
          ? `**${roster.unattached.reduce((n, item) => n + item.claims, 0)} claim(s)** — ` +
            roster.unattached.map((item) => `「${item.extractedAs}」 (${item.claims})`).join(", ") +
            ". The store refused to invent a character for them; they are in the record and in the findings, not in the published reference."
          : "none"
      } |`
    );
  }
  out.push(`| evidence re-checked against the source text | ${checked === undefined ? "—" : checked} |`);
  out.push(
    `| does the reference cover every character in the volume | ${
      coverageAsked === false
        ? "not asked yet — this volume's character-voice document has not been read into the record"
        : "asked"
    } |`
  );
  out.push(
    `| how a coverage gap is judged | ${
      coverage && coverage.significanceChapters
        ? `${coverage.significanceChapters}+ chapters of this volume's text, or a claim the extraction filed about them`
        : "—"
    } |`
  );
  if (attribution) {
    out.push(
      `| is any claim filed under a name this volume's text does not contain | ${
        !attribution.asked
          ? "not asked — " + attribution.because
          : attribution.groups.length
            ? `**${attribution.groups.length} entr(ies), ${attribution.groups.reduce((n, g) => n + g.claimCount, 0)} claim(s)** — see the section below`
            : "no — every entry this volume filed claims under is measured present in its text"
      } |`
    );
    out.push(
      `| claims the record attributes to the narrator | ${
        attribution.narratorClaims
          ? `**${attribution.narratorClaims}** — filed with no roster entry, so the coverage rule cannot count them as a character`
          : "none"
      } |`
    );
  }
  out.push(...axisAnswerTableRows(axes));
  if (sealed) {
    out.push(
      `| is this volume's record sealed (published, immutable) | ${
        sealed.state === "sealed"
          ? `**yes** — ${sealed.rows} row(s) owned by volume ${volume} stopped being editable at ${sealed.at}`
          : `**no** — ${sealed.because}`
      } |`
    );
  }
  out.push("");

  out.push(...sealingSections(sealed, volume));

  out.push(...presenceSection(presence, absent, volume));

  out.push(...attributionSection(attribution));

  out.push(...coverageSection(coverage));

  out.push(...axisAnswerSection(axes));

  out.push(...unadoptedClaimsSection(unadopted));

  out.push(...unadoptedTermsSection(unadoptedTermRows));

  out.push(...refusedRowsSection(refused));

  out.push(...screenedSection(screened));

  out.push(...reopenSections(reopens, volume));

  return out.join("\n").replace(/\n+$/, "") + "\n";
}

module.exports = {
  renderAuditReport,
};
