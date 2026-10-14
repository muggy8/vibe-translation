/**
 * utils/reference-store/attribution/record-answer.js — filing an answer, and the dispute it opens.
 *
 * The whole door is one transaction, and that is the point: an answer that disagrees files a
 * `challenge_fact` per claim, and a challenge that cannot be filed leaves **no answer row either** — an
 * answer nobody can act on is not an answer. The challenged row is never edited or moved: it is marked
 * `disputed` and stays in the guidance until somebody closes the dispute. A challenger written into an
 * already-sealed volume is sealed the moment it is written, because an editable row inside a published
 * record is the one shape this layer exists to make impossible. A `narrator` answer files its challenger
 * with no roster entry at all, which is what keeps "the narrator said it" out of the cast.
 *
 * The function is kept whole. Every guard returns through the one local `refused` shape, and the
 * challenge loop, the answer insert and the rollback share `ctx.db`, the open transaction, the covered
 * claim ids and the verified citation; lifting those blocks out would mean rewriting the order of the
 * writes rather than moving it — the same call `rebuild/filing.js` makes about its own local helpers.
 *
 * @module utils/reference-store/attribution/record-answer
 */

const { refusal } = require("../refusals");
const { ATTRIBUTION_ANSWERS, isInVocabulary } = require("../schema");
const { NARRATOR, isNarratorAnswer } = require("../narrator");
const { verifyEvidence } = require("../evidence");
// `facts.js` does not require this folder, so this edge does not close a cycle (gotcha 85).
const { challengeFact, isVolumeSealed } = require("../facts");
const { claimsFiledUnderAtVolume } = require("./doubts");
const { attributionAnswer } = require("./answers");
require("../../../types"); // JSDoc type definitions

/**
 * File an answer to an attribution question, and the consequence if the answer disagrees.
 *
 * The answer always lands in `attribution_answers`. When it says the claim belongs somewhere else it
 * also opens a `challenge_fact` row per claim, owned by the volume asking, each with its own citation
 * checked against the book — because that is the only door this layer has for contradicting a row it
 * does not own, and a finding that never reaches it is a finding nobody can act on. The challenged row
 * is **not** edited: it is marked disputed and stays in the guidance until somebody closes the dispute.
 *
 * @param {{db: Object, scope: {volume: number, stage: string}, resolveVolume: Function}} ctx
 * @param {Object} proposal
 * @param {number} [proposal.volume] - The volume whose claims are being answered. Defaults to this store's volume.
 * @param {string} proposal.key - The roster entry that was doubted.
 * @param {"confirmed"|"reassign"|"narrator"|"unknown"} proposal.answer
 * @param {string|null} [proposal.speaker] - Who the answer names; required for `reassign`.
 * @param {string} proposal.reason - What the scene says, in the answerer's own words.
 * @param {Array<{volume: number, chapter: string, line: number, quote: string}>} proposal.evidence - The passage the answer is built on.
 * @param {string[]} [proposal.claimIds] - Defaults to every claim this volume filed under `key`.
 * @returns {{ok: boolean, answer: Object|null, challenges: Array<Object>, refused: Array<Object>, refusal: ReferenceRefusal|null}}
 */
function recordAttributionAnswer(ctx, proposal) {
  const vol = Number(proposal.volume === undefined ? ctx.volume : proposal.volume);
  const key = String(proposal.key || "").trim();
  const answerValue = String(proposal.answer || "").trim();
  const reason = String(proposal.reason || "").trim();

  /**
   * The one shape every failure returns.
   * @param {ReferenceRefusal} ref
   * @param {Array<Object>} challenges
   */
  const refused = (ref, challenges = []) => ({ ok: false, answer: null, challenges, refused: [], refusal: ref });

  if (!key) {
    return refused(
      refusal({
        verb: "record_attribution_answer",
        rule: "attribution-needs-a-key",
        because: "an attribution answer answers a doubt about one roster entry, and no entry was named.",
        fix: "record_attribution_answer({volume, key, answer, reason, evidence}).",
      })
    );
  }
  if (!isInVocabulary(ATTRIBUTION_ANSWERS, answerValue)) {
    return refused(
      refusal({
        verb: "record_attribution_answer",
        rule: "attribution-answer-unknown",
        because: `answer must be one of ${ATTRIBUTION_ANSWERS.join(", ")}; "${proposal.answer}" is not in that list.`,
        fix: `use one of: ${ATTRIBUTION_ANSWERS.join(", ")}.`,
        detail: { allowed: ATTRIBUTION_ANSWERS },
      })
    );
  }
  if (reason.length < 20) {
    return refused(
      refusal({
        verb: "record_attribution_answer",
        rule: "attribution-answer-needs-a-reason",
        because:
          `an attribution answer has to say what the scene actually shows (${reason.length} character(s) given). ` +
          "An answer with no reason is indistinguishable from a guess, and the record keeps both.",
        fix: "quote the line that settles it, in the reason as well as in the evidence.",
      })
    );
  }

  const entry = ctx.db.prepare("SELECT key, display FROM cast WHERE key = ?").get(key);
  if (!entry) {
    return refused(
      refusal({
        verb: "record_attribution_answer",
        rule: "attribution-unknown-cast-key",
        because: `there is no roster entry "${key}" in this record, so there is no doubt here to answer.`,
        fix: "name the entry the claims are filed under, or run the deterministic pass to see what is in doubt.",
      })
    );
  }

  const claims = claimsFiledUnderAtVolume(ctx, vol, key);
  if (claims.length === 0) {
    return refused(
      refusal({
        verb: "record_attribution_answer",
        rule: "attribution-no-claims",
        because: `volume ${vol} filed no claims under "${key}", so there is nothing to attribute.`,
        fix: "check the volume number: the claims you are answering may have been established earlier.",
      })
    );
  }

  // Which claims this answer covers. A caller that names ids answers those; a caller that does not
  // answers all of them, which is the ordinary case — the doubt is about the entry, not about one row.
  const wanted = Array.isArray(proposal.claimIds) && proposal.claimIds.length
    ? proposal.claimIds.map((id) => String(id))
    : claims.map((row) => row.id);
  const unknown = wanted.filter((id) => !claims.some((row) => row.id === id));
  if (unknown.length) {
    return refused(
      refusal({
        verb: "record_attribution_answer",
        rule: "attribution-claim-not-in-this-group",
        because:
          `${unknown.join(", ")} is/are not claim(s) volume ${vol} filed under "${key}", so this answer ` +
          "would cover a claim it has not read.",
        fix: "answer the claims the deterministic pass named, or answer this group in full.",
      })
    );
  }

  // Where the answer says the words belong. `confirmed` keeps the entry; `reassign` names another one;
  // `narrator` names nobody.
  let speaker = proposal.speaker === undefined || proposal.speaker === null ? null : String(proposal.speaker).trim();
  if (answerValue === "confirmed") speaker = key;
  if (answerValue === "narrator") speaker = NARRATOR;
  if (answerValue === "unknown") speaker = null;
  if (answerValue === "reassign") {
    if (!speaker) {
      return refused(
        refusal({
          verb: "record_attribution_answer",
          rule: "attribution-reassign-needs-a-speaker",
          because: "a reassign answer has to name who is speaking, or it is an `unknown` answer wearing a stronger name.",
          fix: `pass speaker: <cast key>, or answer "unknown".`,
        })
      );
    }
    if (isNarratorAnswer(speaker)) {
      return refused(
        refusal({
          verb: "record_attribution_answer",
          rule: "attribution-narrator-is-not-a-reassignment",
          because:
            `"${speaker}" is not a character. Saying the narration is speaking is its own answer, and it ` +
            "files the claim with no roster entry rather than under a person.",
          fix: `answer "narrator" instead of "reassign".`,
        })
      );
    }
    if (speaker === key) {
      return refused(
        refusal({
          verb: "record_attribution_answer",
          rule: "attribution-reassigns-to-itself",
          because: `the answer reassigns the claims to "${key}", which is where they already are.`,
          fix: `answer "confirmed".`,
        })
      );
    }
    if (!ctx.db.prepare("SELECT key FROM cast WHERE key = ?").get(speaker)) {
      return refused(
        refusal({
          verb: "record_attribution_answer",
          rule: "attribution-speaker-not-on-the-roster",
          because:
            `the answer names "${speaker}", which is not a roster entry in this record. Naming a speaker ` +
            "who the record has never heard of is the extraction's act, not an attribution answer's.",
          fix: "answer `unknown`, or let the reading pass file that character first.",
        })
      );
    }
  }

  // The answer cites the book. An answer with no citation is an opinion, and this layer does not store
  // opinions about published rows.
  const evidence = Array.isArray(proposal.evidence) ? proposal.evidence : [];
  if (evidence.length === 0) {
    return refused(
      refusal({
        verb: "record_attribution_answer",
        rule: "attribution-answer-needs-evidence",
        because:
          "an attribution answer cites the passage it is built on: {volume, chapter, line, quote}, copied " +
          "from that line. An answer nobody can check against the book is not filed.",
        fix: "cite the line where the speaker is named or the scene says who is talking.",
      })
    );
  }
  const checked = verifyEvidence(evidence, ctx.resolveVolume);
  if (!checked.ok) {
    return refused(
      refusal({
        verb: "record_attribution_answer",
        rule: "attribution-evidence-does-not-verify",
        because:
          `the passage this answer is built on is not at the line(s) it cites:\n` +
          checked.problems.map((p) => `  - ${p.problem}`).join("\n"),
        fix: "cite the chapter and line the quote is really at.",
        detail: { problems: checked.problems.map((p) => ({ index: p.index, problem: p.problem, found: p.found })) },
      })
    );
  }

  // A narrator answer files the challenger with no roster entry at all. That is the record's existing
  // shape for a claim whose subject it refuses to invent, and it is what keeps "the narrator said it"
  // out of the cast — the coverage rule counts rows in `cast`, and this creates none.
  const challengerKey = answerValue === "narrator" ? null : answerValue === "reassign" ? speaker : key;
  const challengerExtractedAs = answerValue === "narrator" ? NARRATOR : null;

  /** @type {Array<Object>} */
  const challenges = [];
  /** @type {Array<Object>} */
  const refusedChallenges = [];

  ctx.db.exec("BEGIN");
  try {
    if (answerValue === "reassign" || answerValue === "narrator") {
      for (const id of wanted) {
        const opened = challengeFact(ctx, id, {
          reason,
          evidence: checked.items,
          key: challengerKey,
          extractedAs: challengerExtractedAs,
          body: `Attribution: these words belong to ${answerValue === "narrator" ? "the narration" : speaker}, not to ${key}.`,
        });
        if (!opened.ok) {
          refusedChallenges.push({ id, because: opened.refusal ? opened.refusal.because : "challenge refused" });
          throw new Error("attribution-challenge-refused");
        }
        // **A challenger written into a published record is published the moment it is written.**
        // `insert_fact` stamps `sealed = 0` because a row is normally written while its volume is still
        // being built and sealed at the end. Here the volume is already sealed, so a challenger left
        // unsealed would be an editable row sitting inside a published record — the one shape this layer
        // exists to make impossible. Sealing it immediately is the same rule, applied at the right time:
        // you may open a dispute with a published record, and you may not then quietly rewrite your own
        // side of it.
        if (isVolumeSealed(ctx, vol)) {
          ctx.db.prepare("UPDATE facts SET sealed = 1, updated_at = ? WHERE id = ?").run(new Date().toISOString(), opened.fact.id);
        }
        challenges.push({ id, challengeId: opened.challengeId, challengerId: opened.fact.id });
      }
    }

    ctx.db
      .prepare(
        "INSERT INTO attribution_answers (volume, key, claim_ids, answer, speaker, reason, evidence, asked_by_volume, asked_by_stage, asked_at) " +
          "VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(volume, key) DO UPDATE SET claim_ids = excluded.claim_ids, " +
          "answer = excluded.answer, speaker = excluded.speaker, reason = excluded.reason, evidence = excluded.evidence, " +
          "asked_by_volume = excluded.asked_by_volume, asked_by_stage = excluded.asked_by_stage, asked_at = excluded.asked_at"
      )
      .run(
        vol,
        key,
        JSON.stringify(wanted),
        answerValue,
        speaker,
        reason,
        JSON.stringify(checked.items),
        ctx.scope.volume,
        ctx.scope.stage,
        new Date().toISOString()
      );
    ctx.db.exec("COMMIT");
  } catch (err) {
    ctx.db.exec("ROLLBACK");
    if (String(err && err.message) === "attribution-challenge-refused") {
      return {
        ok: false,
        answer: null,
        challenges: [],
        refused: refusedChallenges,
        refusal: refusal({
          verb: "record_attribution_answer",
          rule: "attribution-challenge-refused",
          because:
            `the answer could not file its challenge: ${refusedChallenges.map((r) => `${r.id}: ${r.because}`).join("; ")}. ` +
            "Nothing was recorded — an answer that disagrees and cannot say so in the record is not an answer.",
          fix: "the challenge's evidence must be a quote that verifies at the line it cites.",
        }),
      };
    }
    throw err;
  }

  const stored = attributionAnswer(ctx, vol, key);
  return { ok: true, answer: stored, challenges, refused: [], refusal: null };
}

module.exports = {
  recordAttributionAnswer,
};
