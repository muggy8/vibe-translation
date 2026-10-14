/**
 * utils/reference-store/attribution/report.js — what the audit says about attribution.
 *
 * Two outputs from the one measurement. The findings, on the severity ladder the module header argues
 * for: MEDIUM for a doubt nobody has answered, HIGH for an answer that disagrees while its challenges are
 * still open, HIGH if the roster ever holds the narration as a person. And the numbers
 * `validation/report-attribution.js` prints — the dialogue/narration split over this volume's cited lines,
 * how many claims are the kind that attributes words to a person, and how many the record attributes to
 * the narrator. An answered doubt with nothing contradicting it is **not a finding** while still being
 * printed in the report: "the name is printed in a spelling this record cannot see" closes the question
 * without closing the blind spot.
 *
 * @module utils/reference-store/attribution/report
 */

const { NARRATOR, narratorRosterKeyRefusal } = require("../narrator");
const { SKELETON_MIN_CHARS } = require("../evidence");
const { finding } = require("../../postmortem");
const { lineIndex, lineSpeechKind } = require("./lines");
const { SPEECH_ASPECTS, attributionDoubts } = require("./doubts");
const { attributionAnswers } = require("./answers");
require("../../../types"); // JSDoc type definitions

/** The step name the findings are filed under. */
const ATTRIBUTION_STEP = "reference-attribution";

/**
 * The doubts, as findings.
 *
 * The severity ladder, stated because it is the part a reader will want to argue with:
 *
 *   - **MEDIUM — a doubt nobody has answered.** The record contradicts itself: this volume filed claims
 *     under a name its own text does not measure present. That is worth naming in the report a human
 *     reads, and it is not damage on its own — 蒲田's six claims are the case where the contradiction
 *     is the measurement being blind, not the attribution being wrong, and a HIGH finding here would
 *     stop the next volume from being built over a two-kanji name the store cannot see.
 *   - **HIGH — a doubt somebody answered and said the wrong thing.** An answer that reassigns the
 *     claims, or says the narration is speaking, is a claim that the published reference attributes the
 *     words to the wrong party. It is filed as a challenge, and while that challenge is open the
 *     reference is being copied forward carrying an attribution its own record disputes. That is damage,
 *     and it blocks the copy until somebody closes the dispute.
 *   - **HIGH — the narration counted as a character.** See `narratorRosterKeyRefusal`.
 *
 * @param {{db: Object, volume: number, resolveVolume: Function}} ctx
 * @param {{volume?: number, step?: string}} [opts]
 * @returns {PostMortemFinding[]}
 */
function attributionFindings(ctx, { volume, step = ATTRIBUTION_STEP } = {}) {
  const vol = Number(volume === undefined ? ctx.volume : volume);
  /** @type {PostMortemFinding[]} */
  const out = [];

  for (const row of ctx.db.prepare("SELECT key, display FROM cast ORDER BY key").all()) {
    const ref = narratorRosterKeyRefusal(row.key, "reference-audit");
    if (!ref) continue;
    out.push(
      finding(
        "HIGH",
        "reference-narrator-counted-as-a-character",
        step,
        String(vol),
        "series.db",
        `the roster holds an entry keyed "${row.key}", which is the word for the narration rather than a ` +
          `name this book gives anybody. The coverage rule counts cast entries as characters, so it is ` +
          `currently asking this reference to cover the narration. ${ref.fix}`
      )
    );
  }

  const doubts = attributionDoubts(ctx, { volume: vol });
  if (!doubts.asked) return out;

  for (const group of doubts.groups) {
    const aids = group.readingAids || {};
    const answer = group.answer;

    if (answer) {
      // Somebody asked, and the record holds what they said. The only thing that is still damage is an
      // answer that disagreed and has not been decided: the published reference attributes these words one
      // way while this record's own reading says another. An answer that agreed, or one that lost and was
      // closed, is not re-reported every volume — the question was asked, and the record says what the
      // answer was, in the section below.
      const open = ctx.db
        .prepare(
          "SELECT c.id AS id, c.fact_id AS fact_id FROM challenges c WHERE c.outcome IS NULL AND c.fact_id IN " +
            `(SELECT id FROM facts WHERE established_volume = ? AND key = ?)`
        )
        .all(group.volume, group.key);
      if (open.length === 0) continue;
      out.push(
        finding(
          "HIGH",
          "reference-attribution-contested-unresolved",
          step,
          String(vol),
          "series.db",
          `${group.claimCount} claim(s) volume ${group.volume} filed under "${group.key}" were read again and ` +
            `attributed to ${answer.answer === "narrator" ? "the narration" : `"${answer.speaker}"`} — ` +
            `${answer.reason} ${open.length} of the challenges that says so are still open, so the published ` +
            `reference is attributing these words to ${group.key} while this record's own reading disputes it. ` +
            `resolve_challenge(id, "uphold" | "accept") is the door that decides it; nothing in this layer decides ` +
            `it for you, and a sealed row is never edited either way.`
        )
      );
      continue;
    }

    const presenceLine = group.presence
      ? `its presence row says present=${group.presence.present} across ${group.presence.chapters} chapter(s)`
      : "this record has no presence row for it at all";
    const aidsLine = aids.found
      ? `but the name IS printed there: ${aids.hits.slice(0, 3).map((h) => `「${h.span}」 at ${h.chapter}:${h.line}`).join(", ")}. ` +
        `The store's one matching rule needs a Han-character skeleton of at least 3 characters, so a two-kanji ` +
        `name written with its reading aids between the kanji is invisible to it — this is a blind spot in the ` +
        `measurement, and the measurement is deliberately not widened for it`
      : aids.skipped && aids.skipped.length
        ? `and nothing here can look for it as a name written with reading aids either (${aids.skipped.join(", ")} ` +
          `has fewer than two kanji to order)`
        : `and it is not printed there with reading aids between its kanji either, so on the evidence this ` +
          `record holds this volume's text really does not contain the name`;

    out.push(
      finding(
        "MEDIUM",
        "reference-claim-attribution-in-doubt",
        step,
        String(vol),
        "series.db",
        `${group.claimCount} claim(s) were established in volume ${group.volume} under the roster entry ` +
          `"${group.key}" (${group.display}), and volume ${group.volume}'s own text does not measure that name ` +
          `as present: ${presenceLine}, ${aidsLine}. ${group.speechClaims} of the ${group.claimCount} ` +
          `claim(s) quote words, so the question is who is speaking them, not whether the character matters. ` +
          `Nothing has answered it. npm run attribute-voice -- --volume=${String(group.volume).padStart(2, "0")} ` +
          `reads the scene once and files the answer; if the name is simply printed in a spelling this ` +
          `record cannot see, cast_alias(key, <that spelling>, <reason>) is the door that closes it.`
      )
    );
  }
  return out;
}

/**
 * The attribution numbers the audit report prints.
 *
 * @param {{db: Object, volume: number, resolveVolume: Function}} ctx
 * @param {{volume?: number}} [opts]
 * @returns {{volume: number, asked: boolean, because: string|null, dialogueClaims: number, narrationClaims: number, speechAspectClaims: number, narratorClaims: number, groups: Array<Object>, answered: Array<Object>}}
 */
function attributionSummary(ctx, { volume } = {}) {
  const vol = Number(volume === undefined ? ctx.volume : volume);
  const index = lineIndex(ctx, vol);
  const rows = ctx.db
    .prepare("SELECT id, aspect, key, evidence FROM facts WHERE established_volume = ? AND status <> 'retracted'")
    .all(vol);
  let dialogue = 0;
  let narration = 0;
  let speechAspect = 0;
  for (const row of rows) {
    let evidence = [];
    try {
      evidence = JSON.parse(row.evidence || "[]");
    } catch {
      evidence = [];
    }
    const cited = evidence.find((item) => item && item.chapter && Number.isInteger(item.line));
    if (!cited || !index.has(cited.chapter)) continue;
    const sourceLine = index.get(cited.chapter)[cited.line - 1];
    if (sourceLine === undefined) continue;
    if (lineSpeechKind(sourceLine) === "dialogue") dialogue += 1;
    else narration += 1;
    if (SPEECH_ASPECTS.includes(row.aspect)) speechAspect += 1;
  }
  const narratorClaims = ctx.db
    .prepare("SELECT COUNT(*) AS n FROM facts WHERE key IS NULL AND extracted_as = ? AND status <> 'retracted'")
    .get(NARRATOR).n;
  const doubts = attributionDoubts(ctx, { volume: vol });
  return {
    volume: vol,
    asked: doubts.asked,
    because: doubts.because,
    establishedClaims: rows.length,
    skeletonMinChars: SKELETON_MIN_CHARS,
    dialogueClaims: dialogue,
    narrationClaims: narration,
    speechAspectClaims: speechAspect,
    narratorClaims: Number(narratorClaims),
    groups: doubts.groups,
    answered: attributionAnswers(ctx, vol),
  };
}

module.exports = {
  ATTRIBUTION_STEP,
  attributionFindings,
  attributionSummary,
};
