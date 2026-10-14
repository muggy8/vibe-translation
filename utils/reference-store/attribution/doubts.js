/**
 * utils/reference-store/attribution/doubts.js — naming the doubt, and never naming a speaker.
 *
 * A doubt is one fact: this volume filed claims under a roster entry this volume's own text does not
 * measure as present. The obvious next step — "the cited line names a cast member, so that is the
 * speaker" — was measured against both real records and is wrong on every example it produced (0 hits on
 * volume 01's character claims, 10 on volume 02's, all ten of them the *addressee*), so this file stops at
 * the contradiction and never names who speaks. `SPEECH_ASPECTS` is the part of the record the question
 * applies to at all: asking "who speaks this" about a `pov` row or a `term_usage` row is asking a question
 * the claim is not answering.
 *
 * @module utils/reference-store/attribution/doubts
 */

const { presenceMeasured } = require("../presence");
const { lineIndex, lineSpeechKind } = require("./lines");
const { namePrintedWithReadingAids } = require("./reading-aids");
const { attributionAnswer } = require("./answers");
require("../../../types"); // JSDoc type definitions

/**
 * The aspects whose claim body attributes **words** to a person.
 *
 * The attribution question only makes sense about a claim that quotes somebody. `pov` says who is
 * narrating, `term_usage` is a glossary row wearing a character key, `appearance` says whether the
 * character is in the volume, and `trajectory` / `relationship` describe what happens to a person
 * rather than what they sound like. Asking "who speaks this" about those is asking a question the
 * claim is not answering.
 *
 * @type {string[]}
 */
const SPEECH_ASPECTS = ["pronoun", "catchphrase", "register", "address_term", "internal_voice", "quirk"];

/**
 * The claims filed under one roster entry by one volume, with the line each one cites.
 *
 * Both kinds are read: the rows the published reference is rendered from, and the extraction's
 * candidate copies. The attribution question is about what this volume's reading of the book filed,
 * and the two copies came from the same reading — reporting only one would report half the claims and
 * hide that they arrived twice.
 *
 * @param {{db: Object, resolveVolume: Function}} ctx
 * @param {number} volume
 * @param {string} key
 * @param {Map<string, string[]>} [index] - A line index already built for this volume.
 * @returns {Array<{id: string, aspect: string, label: string|null, body: string, sourceStage: string, sealed: number, chapter: string|null, line: number|null, quote: string|null, speechKind: string|null}>}
 */
function claimsFiledUnderAtVolume(ctx, volume, key, index) {
  const rows = ctx.db
    .prepare(
      "SELECT id, aspect, label, body, evidence, source_stage AS sourceStage, sealed, established_chapter AS chapter " +
        "FROM facts WHERE established_volume = ? AND key = ? AND status <> 'retracted' ORDER BY ord"
    )
    .all(Number(volume), key);
  const lines = index || lineIndex(ctx, volume);
  return rows.map((row) => {
    let evidence = [];
    try {
      evidence = JSON.parse(row.evidence || "[]");
    } catch {
      evidence = [];
    }
    const cited = evidence.find((item) => item && item.chapter && Number.isInteger(item.line)) || null;
    const sourceLine = cited && lines.has(cited.chapter) ? lines.get(cited.chapter)[cited.line - 1] : undefined;
    return {
      id: row.id,
      aspect: row.aspect,
      label: row.label,
      body: row.body,
      sourceStage: row.sourceStage,
      sealed: row.sealed,
      chapter: cited ? cited.chapter : row.chapter,
      line: cited ? cited.line : null,
      quote: cited ? cited.quote : null,
      speechKind: sourceLine === undefined ? null : lineSpeechKind(sourceLine),
    };
  });
}

/**
 * The attribution account for one volume: every entry this volume filed claims under that its own text
 * does not contain, with the reason the measurement says so and the answer, if anybody gave one.
 *
 * Fail-closed in the same shape `integrity.js` uses: when presence has not been measured for this
 * volume the question is reported as **not asked**, never as "nothing is in doubt". An unmeasured
 * volume and a clean volume must not read the same.
 *
 * @param {{db: Object, volume: number, resolveVolume: Function}} ctx
 * @param {{volume?: number}} [opts]
 * @returns {{asked: boolean, because: string|null, volume: number, groups: Array<Object>}}
 */
function attributionDoubts(ctx, { volume } = {}) {
  const vol = Number(volume === undefined ? ctx.volume : volume);
  if (!presenceMeasured(ctx, vol)) {
    return {
      asked: false,
      because:
        `presence has not been measured for volume ${vol}, so nothing here can say whether this ` +
        "volume's text contains the names its claims are filed under.",
      volume: vol,
      groups: [],
    };
  }

  const entries = ctx.db
    .prepare(
      "SELECT f.key AS key, COUNT(*) AS claims FROM facts f WHERE f.established_volume = ? AND f.key IS NOT NULL " +
        "AND f.status <> 'retracted' GROUP BY f.key ORDER BY f.key"
    )
    .all(vol);

  /** @type {Array<Object>} */
  const groups = [];
  const index = lineIndex(ctx, vol);
  for (const entry of entries) {
    const presence = ctx.db.prepare("SELECT present, chapters, matches FROM cast_presence WHERE volume = ? AND key = ?").get(vol, entry.key);
    if (presence && presence.present === 1) continue;
    const claims = claimsFiledUnderAtVolume(ctx, vol, entry.key, index);
    if (claims.length === 0) continue;
    const cast = ctx.db.prepare("SELECT key, display, merged_into AS mergedInto FROM cast WHERE key = ?").get(entry.key);
    const probe = namePrintedWithReadingAids(ctx, { volume: vol, key: entry.key });
    groups.push({
      key: entry.key,
      display: (cast && cast.display) || entry.key,
      volume: vol,
      claims,
      claimCount: claims.length,
      publishedClaims: claims.filter((row) => row.sourceStage !== "extract").length,
      candidateClaims: claims.filter((row) => row.sourceStage === "extract").length,
      speechClaims: claims.filter((row) => SPEECH_ASPECTS.includes(row.aspect)).length,
      presence: presence
        ? { present: presence.present, chapters: presence.chapters, matches: presence.matches }
        : null,
      readingAids: probe,
      answer: attributionAnswer(ctx, vol, entry.key),
    });
  }
  return { asked: true, because: null, volume: vol, groups };
}

module.exports = {
  SPEECH_ASPECTS,
  claimsFiledUnderAtVolume,
  attributionDoubts,
};
