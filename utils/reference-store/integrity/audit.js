/**
 * utils/reference-store/integrity/audit.js — the whole integrity account for one store.
 *
 * Runs every question in this folder in one fixed order and turns each answer into a finding
 * with a severity, then returns the counts, the coverage answer and the rebuild markers the
 * report prints. The order is part of the contract: the evidence check runs against the rows
 * the earlier queries read, the coverage question runs before the attribution question because
 * the two read the same presence measurement, and the sealing question is asked only up to the
 * volume the caller calls finished.
 *
 * @module utils/reference-store/integrity/audit
 */

const { finding } = require("../../postmortem");
const { verifyStoredEvidence } = require("../evidence");
const { COUNTED_TABLES } = require("../schema");
const { tableCounts } = require("../queries");
const { presenceMeasured } = require("../presence");
const { documentMirrored, DOCUMENT_VOICE, rebuildProvenanceCounts } = require("../document-prose");
const { attributionFindings } = require("../attribution");
const { factsWithoutEvidence, impossibleProvenance, unclassifiedFacts } = require("./rows");
const { splitCharacters, pronounKeyedRosterEntries, claimsFiledWithoutARosterEntry } = require("./roster");
const { brokenSupersession } = require("./supersession");
const { unsealedVolumes } = require("./sealing");
const { COVERAGE_SIGNIFICANCE_CHAPTERS, coverageChapterTotal, uncoveredCharacters } = require("./coverage");
const { coverageFindings } = require("./coverage-report");
const { rebuiltDocuments } = require("./rebuilt");

require("../../../types"); // JSDoc type definitions

/** The step name the findings are filed under. */
const INTEGRITY_STEP = "reference-store";

/**
 * The whole integrity account for one store.
 *
 * @param {Object} ctx - The store context (needs `db`, `resolveVolume`, `volume`).
 * @param {{volume?: number|string, step?: string, upTo?: number, publishedVolume?: number|null}} [opts]
 *   - `volume` is the label findings are filed under; `upTo` is the volume the roster questions are
 *   asked about, and defaults to the volume this store is open for. `publishedVolume` is the volume
 *   the caller is treating as **finished**: the sealing question is asked up to that volume, and not
 *   beyond it. A stage auditing the volume it is still writing leaves it unset, because "is this
 *   published yet?" has one honest answer mid-build — no — and reporting the ordinary state of being
 *   built as HIGH damage is how a check gets ignored. Copy-forward sets it to the volume it is about
 *   to copy, which is where the question has teeth. It is not a switch: no value turns the sealing
 *   check off for a volume the caller calls finished.
 * @returns {{ok: boolean, findings: PostMortemFinding[], counts: Object<string, number>, checked: number}}
 */
function integrityFindings(ctx, { volume = null, step = INTEGRITY_STEP, upTo, publishedVolume = null } = {}) {
  const findings = [];
  const counts = tableCounts(ctx, COUNTED_TABLES);
  const limit = Number(upTo === undefined ? ctx.volume : upTo);

  const noEvidence = factsWithoutEvidence(ctx);
  for (const item of noEvidence) {
    findings.push(
      finding("HIGH", "reference-fact-without-evidence", step, volume, "series.db", `${item.id}: ${item.problem}`)
    );
  }

  const evidenceCheck = verifyStoredEvidence(
    ctx.db.prepare("SELECT id, evidence FROM facts ORDER BY ord").all(),
    ctx.resolveVolume
  );
  for (const failure of evidenceCheck.failures) {
    findings.push(
      finding("HIGH", "reference-evidence-does-not-verify", step, volume, "series.db", `${failure.id}: ${failure.problem}`)
    );
  }

  for (const item of impossibleProvenance(ctx)) {
    findings.push(
      finding(
        "HIGH",
        "reference-impossible-provenance",
        step,
        volume,
        "series.db",
        `${item.id}: established at volume ${item.establishedVolume} but its evidence cites volume ${item.ceilingVolume}`
      )
    );
  }

  for (const item of splitCharacters(ctx)) {
    findings.push(
      finding("MEDIUM", "reference-character-split-in-two", step, volume, "series.db", `${item.keys.join(" / ")}: ${item.problem}`)
    );
  }

  // A roster entry keyed by a bare first-person pronoun, reported rather than merged. MEDIUM, and
  // deliberately not HIGH: the claims in it are real and cited, and what is wrong is the name over them.
  // It is also deliberately not a fold — see `pronounKeyedRosterEntries` for why the fold's own signal is
  // gone on the assembled route, and why closing the split by guessing is worse than naming it.
  for (const item of pronounKeyedRosterEntries(ctx)) {
    findings.push(
      finding(
        "MEDIUM",
        "reference-character-keyed-by-a-pronoun",
        step,
        volume,
        "series.db",
        `"${item.key}" is a roster entry with ${item.claims} character-voice claim(s) of its own, established in volume(s) ${item.establishedVolumes.join(", ")}. ` +
          `A pronoun is not a name: the reference's section for this character is headed 「${item.key}」, which tells a translator who is speaking only if they already know. ` +
          (item.candidates.length
            ? `The roster does carry ${item.candidates.join(", ")} — the entry that names the same pronoun in its own label — and the fold that closes a split like this refused to merge them because neither entry's heading names the other as a whole token. `
            : "No other roster entry names this pronoun, so nothing here can say who this is. ") +
          `The door that decides it is cast_alias (or a merge recorded by somebody who read the book), not a rule that picks a person for you.`
      )
    );
  }

  for (const item of brokenSupersession(ctx)) {
    findings.push(
      finding("MEDIUM", "reference-broken-supersession", step, volume, "series.db", `${item.id}: ${item.problem}`)
    );
  }

  // Claims the store filed with no roster entry. MEDIUM, not HIGH: this is the record saying out loud
  // that it does not know whose claim this is, which is the honest state of a record that was never told,
  // and a run must not be stopped for a thing the pipeline is correct to admit. It is not silent either —
  // the name the extraction used is printed, and for a first-person novel that name is the answer to a
  // question a human can settle in one `cast_alias` call.
  for (const item of claimsFiledWithoutARosterEntry(ctx)) {
    findings.push(
      finding(
        "MEDIUM",
        "reference-claim-filed-without-a-roster-entry",
        step,
        volume,
        "series.db",
        `${item.claims} claim(s) were extracted under 「${item.extractedAs}」 and filed with no roster entry (aspect(s): ${item.aspects.join(", ")}). ` +
          (item.pronoun
            ? "The name is the word for \"I\", and nothing in this record declares whose \"I\" it is; the store refused to make a character out of it. " +
              `The door that closes this is cast_alias(<character>, "${item.extractedAs}", <reason>) — the glossary's own Characters row is usually where the answer already is. `
            : "Nothing in the roster carries this name, so the claim is kept rather than thrown away and reported rather than guessed at. ") +
          "It is in the record and in this report; it is not in the published reference, which renders a section per roster entry."
      )
    );
  }

  // §3.2 — an unsealed volume is a draft, and a draft is not something the next volume may
  // start from. HIGH, because copy-forward refuses on HIGH and this is the check that keeps
  // "published" meaning published. Asked up to `publishedVolume` only: a store open for volume N
  // is in the middle of writing volume N, and calling that HIGH damage every time a stage audits
  // its own work is a false positive that teaches everyone to ignore the finding.
  const published = publishedVolume === null || publishedVolume === undefined ? null : Number(publishedVolume);
  const sealedLimit = published === null ? Math.min(limit, ctx.volume - 1) : Math.min(limit, published);
  for (const unsealed of unsealedVolumes(ctx, sealedLimit)) {
    findings.push(
      finding(
        "HIGH",
        "reference-volume-unsealed",
        step,
        volume,
        "series.db",
        `volume ${unsealed} is represented in this store but has not been sealed: seal_volume(${unsealed}) ` +
          "publishes a volume's record, and a copy may not carry a record that is still editable."
      )
    );
  }

  // §2.3 — the catch-all is counted, not hidden. MEDIUM: a store where everything lands in
  // `unclassified` is not corrupt, it is unqueryable, which is a slower and quieter failure.
  for (const item of unclassifiedFacts(ctx)) {
    findings.push(
      finding(
        "MEDIUM",
        "reference-facts-unclassified",
        step,
        volume,
        "series.db",
        `${item.n} fact(s) from volume ${item.volume} are aspect "unclassified" — the fallback is where ` +
          "they all landed, which is doc 03 risk 5. Give them an aspect, or say why they have none."
      )
    );
  }

  // §4 item D — the artifact that killed the last run, caught by a query instead of by someone
  // noticing. HIGH for a character the volume's own text and the extraction both say is there:
  // this is the check that turns "the voice reference got smaller" from an observation into a
  // refusal. A character the volume's own text does not contain is not on this list at all: a
  // character with no lines in the volume is supposed to be left alone. A character who IS in the
  // text but only barely, and about whom the extraction says nothing either, is reported by name at
  // MEDIUM — see `COVERAGE_SIGNIFICANCE_CHAPTERS` for how that line was drawn and what it cannot
  // see.
  const uncovered = uncoveredCharacters(ctx, limit);
  findings.push(...coverageFindings(ctx, uncovered, limit, step, volume));

  // Slice 10 — who is speaking the words a claim quotes. Asked after the coverage question, because the
  // two read the same measurement and this one is about a claim's *subject* rather than its existence:
  // coverage asks whether the reference says anything about a person the volume contains, attribution
  // asks whether the person this volume filed a claim under is the one whose words the claim quotes.
  // A doubt is MEDIUM and an unresolved contest is HIGH — see `attributionFindings` for why the ladder
  // is drawn there, and for the measurement that decided it.
  findings.push(...attributionFindings(ctx, { volume: limit, step }));

  const rebuiltDocs = rebuiltDocuments(ctx, limit);
  // How the reference got here. MEDIUM, deliberately: a reference rebuilt from a volume's extraction
  // output is not damage — every bullet in it cites a line of the volume's text, which is more than
  // volume 01's destroyed file could say — and a HIGH finding would stop the next volume's copy-forward
  // over a provenance fact rather than a defect. It is also not silence: it fires on every audit of a
  // record that carries rebuild rows, it names the counts, and it says what would replace it (an author
  // pass over the rebuilt file). The damage check above still runs against a rebuilt reference, at HIGH,
  // unchanged: rebuilding does not buy a reference out of covering the cast.
  for (const rebuilt of rebuiltDocs) {
    const counts = rebuildProvenanceCounts(rebuilt);
    findings.push(
      finding(
        "MEDIUM",
        "reference-document-rebuilt-from-extraction",
        step,
        volume,
        `${rebuilt.document}.md`,
        `volume ${rebuilt.volume}'s ${rebuilt.document} reference was rebuilt by code from that volume's ` +
          `extraction output on ${rebuilt.at}: ${counts.claims} claim(s) adopted about ${counts.characters} ` +
          `character(s), ${counts.refused} refused` +
          (counts.unkeyed ? `, ${counts.unkeyed} claim(s) with no character to file them under` : "") +
          ". No author agent wrote it and nobody has " +
          "reviewed it. Every bullet cites a line of that volume's text, and the coverage question is asked of " +
          "it like any other reference — but a reference nobody read is a reference nobody checked." +
          (counts.candidates !== null
            ? ` The record also keeps ${counts.candidates} candidate copy(ies) of those claims — the ` +
              "extraction's own reading beside the document's — so \"what did the extraction find that this " +
              "reference does not say\" is a query here, not an assumption."
            : "")
      )
    );
  }

  return {
    ok: !findings.some((f) => f.severity === "HIGH"),
    findings,
    counts,
    checked: evidenceCheck.checked,
    coverageAsked: documentMirrored(ctx, DOCUMENT_VOICE, limit),
    coverage: {
      asked: documentMirrored(ctx, DOCUMENT_VOICE, limit),
      chapters: coverageChapterTotal(ctx, limit),
      measured: presenceMeasured(ctx, limit),
      significanceChapters: COVERAGE_SIGNIFICANCE_CHAPTERS,
      rows: uncovered,
    },
    rebuilt: rebuiltDocs,
  };
}

module.exports = {
  INTEGRITY_STEP,
  integrityFindings,
};
