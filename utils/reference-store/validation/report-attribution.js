/**
 * utils/reference-store/validation/report-attribution.js — the report section that asks who is speaking.
 *
 * Lifted whole out of `report.js` so the report itself can stay a list of sections. It prints the
 * measurement and never a verdict: the store cannot name a speaker from the inside of a quote, and the
 * obvious rule (a cast name inside the cited quote is the speaker) was measured at 0 hits on volume 1's
 * character claims and 10 on volume 2's, all ten of them the addressee. So what this section reports is
 * the record contradicting itself — a roster entry holding claims this volume's own text does not measure
 * it in — claim by claim, because the two ways it can be wrong need different things from a reader.
 *
 * @module utils/reference-store/validation/report-attribution
 */

const { listLines } = require("./report-lines");
require("../../../types"); // JSDoc type definitions

/**
 * The "Who is speaking the words the claims quote" section, plus the answers this record already holds.
 *
 * @param {{volume: number, asked: boolean, because: string|null, establishedClaims: number, skeletonMinChars: number, dialogueClaims: number, narrationClaims: number, speechAspectClaims: number, narratorClaims: number, groups: Array<Object>, answered: Array<Object>}|null} attribution
 * @returns {string[]} The report lines, in order; empty when the section is not printed at all.
 */
function attributionSection(attribution) {
  const out = [];
  // A claim says who it is **about** and quotes words somebody **said**. This section is about the second
  // fact, and it prints the measurement rather than a verdict: the store cannot name a speaker from the
  // inside of a quote (see `attribution.js` for the 10-for-10 false-positive rate of the obvious rule),
  // so what it reports is where its own answer contradicts itself.
  if (attribution) {
    out.push(`## Who is speaking the words the claims quote`);
    out.push("");
    if (!attribution.asked) {
      out.push(`**Not asked.** ${attribution.because}`);
      out.push("");
    } else {
      out.push(
        `Of the ${attribution.establishedClaims} claim(s) volume ${attribution.volume} established, ` +
          `${attribution.dialogueClaims} cite a line the book presents as speech and ` +
          `${attribution.narrationClaims} cite narration. ${attribution.speechAspectClaims} claim(s) are ` +
          `the kind that attributes words to a person. ` +
          `${attribution.narratorClaims} claim(s) in this record are attributed to the **narrator** — filed ` +
          `with no roster entry, which is why the coverage rule cannot count them as a character.`
      );
      out.push("");
      if (attribution.groups.length === 0) {
        out.push(
          "No claim in this volume is filed under a roster entry this volume's own text does not contain. " +
            "That is the attribution question being asked and answered clean."
        );
        out.push("");
      } else {
        out.push(
          `**${attribution.groups.length} roster entr(ies) hold claims established in this volume that its ` +
            `own text does not measure them in.** This is the record contradicting itself, and it is printed ` +
            `claim by claim because the two ways it can be wrong need different things from a reader: the ` +
            `attribution is wrong, or the measurement cannot see the name.`
        );
        out.push("");
        out.push("| entry | claims | presence measured | is the name printed with reading aids? | answered? |");
        out.push("|---|---|---|---|---|");
        for (const group of attribution.groups) {
          const aids = group.readingAids || {};
          const aidsCell = aids.found
            ? `**yes** — ${aids.hits.slice(0, 2).map((h) => `「${h.span}」 at ${h.chapter}:${h.line}`).join(", ")} (kanji in order, only kana between them)`
            : aids.skipped && aids.skipped.length
              ? `cannot be asked — ${aids.skipped.join(", ")} has fewer than two kanji to order`
              : "no";
          const answerCell = group.answer
            ? `**${group.answer.answer}**${group.answer.speaker ? ` → ${group.answer.speaker}` : ""}`
            : "not asked";
          out.push(
            `| ${group.display} (\`${group.key}\`) | ${group.claimCount} (${group.publishedClaims} published, ${group.candidateClaims} candidate) | present=${group.presence ? group.presence.present : "no row"} in ${group.presence ? group.presence.chapters : 0} chapter(s) | ${aidsCell} | ${answerCell} |`
          );
        }
        out.push("");
        for (const group of attribution.groups) {
          const aids = group.readingAids || {};
          if (aids.found) {
            out.push(
              `\`${group.key}\` **is** printed in this volume's text — as ${aids.hits.slice(0, 2).map((h) => `「${h.span}」 at ${h.chapter}:${h.line}`).join(", ")}. ` +
                `The store's one matching rule needs a Han-character skeleton of ${attribution.skeletonMinChars} characters or more, so a ` +
                `${aids.kanjiCount}-kanji name written with its reading aids between the kanji is invisible to it. ` +
                `That rule is deliberately **not** widened here: the coverage guard and the copy-forward guard are built on it answering the same ` +
                `question on every volume, and widening it for one name is how a guard stops meaning what it says. The door that closes this ` +
                `is \`cast_alias("${group.key}", "<the spelling the book prints>", <reason>)\`, which is a declared identity with a reason, not a matching rule that guesses.`
            );
            out.push("");
          }
          out.push(...listLines(group.claims, (claim) => `- \`${claim.id}\` (${claim.aspect}, ${claim.sourceStage}) cites ${claim.chapter}:${claim.line} — a ${claim.speechKind} line — ${claim.body.replace(/\s+/g, " ").slice(0, 140)}`));
          out.push("");
        }
      }
      if (attribution.answered.length) {
        out.push("## Attribution answers this record holds");
        out.push("");
        out.push(
          "Asked and answered, kept in the record rather than in a log: the answer row says who the " +
            "reading pass named, and an answer that disagrees filed a challenge against the claim it answers."
        );
        out.push("");
        out.push("| volume | entry | answer | speaker | claims covered | asked by |");
        out.push("|---|---|---|---|---|---|");
        for (const row of attribution.answered) {
          out.push(
            `| ${row.volume} | \`${row.key}\` | **${row.answer}** | ${row.speaker || "—"} | ${row.claimIds.length} | volume ${row.asked_by_volume} (${row.asked_by_stage}) at ${row.asked_at} |`
          );
        }
        out.push("");
        for (const row of attribution.answered) {
          out.push(`- \`${row.key}\` (volume ${row.volume}): ${row.reason}`);
        }
        out.push("");
      }
    }
  }
  return out;
}

module.exports = {
  attributionSection,
};
