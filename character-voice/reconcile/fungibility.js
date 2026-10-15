/**
 * character-voice/reconcile/fungibility.js — the one judgement the closing pass is allowed to make, and
 * the half of it this repository cannot compute yet.
 *
 * The account owner's decision (plan 06 §10.7, confirmed 2026-10-14): **a fungible miss is recorded and the
 * run continues; a character the story turns on is investigated.** "Fungible" here means *interchangeable*
 * — a name the book drops once and never picks up again is not worth stopping a run for, and was never
 * worth one.
 *
 * ## The rule as shipped
 *
 * **Not fungible when the book's own text puts the name on a page in 2 or more volumes.** One signal, read
 * out of `cast_presence`, which is the store's own measurement of "this name occurs in this volume's text"
 * (measured from the extracted chapter files with the store's matching rule — verbatim, then the Han
 * skeleton). A character who is in two books is in the story; a character in one chapter of one book is in
 * the furniture.
 *
 * ## The second half, which is NOT run, and why that has to be in the output
 *
 * The plan's rule is "present in 2 or more volumes, **or named inside another character's speech**". The
 * second test cannot be computed today, for two measured reasons:
 *
 *   1. `cast_presence_match` matches a name to a line and records **no notion of who is speaking**, so
 *      "mentioned in dialogue" and "on the page" are the same number. Teaching presence who is speaking is
 *      an enabling slice, and it is not in this plan's list.
 *   2. **0 of the 22,469 `facts` rows in this corpus's 17 published records is keyed to a cast entry**, so
 *      there is no body of claims to search for one character naming another.
 *
 * That gap is not a footnote. A reader of the reconciliation must be able to tell that a test named in the
 * rule was not run, so {@link SPEAKER_TEST_NOT_RUN} is printed in the pass's own output and stored in its
 * JSON, not left in a comment.
 *
 * ## The accepted blind spot
 *
 * A character pivotal in exactly one volume and never mentioned again reads as interchangeable here and is
 * recorded rather than investigated. The damage is bounded and {@link BLIND_SPOT} says so in the output:
 * the name is published either way — it is on the roster, it is in the series' glossary, and it is named in
 * this file — so a wrong call costs an investigation not run, not a hole hidden from the translator.
 *
 * ## The number the plan quotes, and the number this rule produces
 *
 * Plan 06 §2.10 quotes **179 recurring / 17 single-mention** out of 196 roster entries. That measurement
 * counted **how many volume records hold the roster entry** — which, on a cumulative roster that never
 * drops an entry, is `18 − first_seen_volume`, i.e. the entry's age, not how often the book prints it. It
 * is reproduced here beside the shipped rule (`rosterVolumesHeld`), because the plan quotes it and a later
 * reader has to be able to compare the two. On this corpus the two splits are **179 / 17** by roster age
 * and **100 / 96** by presence in the text, and the difference is 79 names the roster has carried for
 * fifteen volumes that the book only ever printed once.
 *
 * @module character-voice/reconcile/fungibility
 */

require("../../types"); // JSDoc type definitions

/**
 * How many volumes the book has to put a name on a page in before "the record says nothing about them"
 * stops being a shrug.
 *
 * A constant with no environment knob (AGENTS.md rule 3): a line a run can raise is a line a run will
 * raise, and this one decides which gaps pause nothing and which ones get looked at.
 *
 * @type {number}
 */
const NOT_FUNGIBLE_MIN_VOLUMES = 2;

/**
 * The sentence the pass prints when the speaker half of the rule could not be run.
 *
 * Quoted verbatim in the reconciliation's markdown and stored in its JSON, because "we only ran half the
 * rule" is the kind of fact a report must not bury in a code comment.
 *
 * @type {string}
 */
const SPEAKER_TEST_NOT_RUN =
  "The second half of the fungibility rule — \"named inside another character's speech\" — was NOT run. " +
  "`cast_presence_match` matches a name to a line and records no notion of who is speaking, so \"mentioned " +
  "in dialogue\" and \"on the page\" are the same number here; and no recorded fact in this corpus's " +
  "published reference records is keyed to a cast entry, so there is no body of claims to search for one " +
  "character naming another. Every classification in this file was decided by recurrence across volumes " +
  "alone.";

/**
 * The sentence the pass prints about the miss its own rule cannot catch.
 *
 * @type {string}
 */
const BLIND_SPOT =
  "A character pivotal in exactly one volume and never mentioned again reads as interchangeable to this " +
  "rule and is recorded rather than investigated. The damage is bounded: the name is on the roster, in the " +
  "series' glossary, and named in this file either way, so a wrong call costs an investigation not run, " +
  "not a hole hidden from the translator.";

/**
 * How many volumes of this series the roster has held this entry for.
 *
 * This is plan 06 §2.10's measure — "appears in N volumes" — reproduced so the plan's 179 / 17 can be
 * compared with the shipped rule's answer. On a cumulative roster it is the entry's age, and it is printed
 * beside {@link classifyFungibility}'s `volumesSeen` so a reader can see which names the two measures
 * disagree about.
 *
 * @param {{firstSeenVolume: number|null}} row
 * @param {number[]} volumes - Every volume this record registers.
 * @returns {number}
 */
function rosterVolumesHeld(row, volumes) {
  if (row.firstSeenVolume === null || row.firstSeenVolume === undefined) return volumes.length;
  return volumes.filter((volume) => Number(volume) >= Number(row.firstSeenVolume)).length;
}

/**
 * Decide whether one uncovered character is interchangeable, and say which signal decided it.
 *
 * @param {{key: string, display: string, volumesPresent: number[], volumesMeasured: number[], firstSeenVolume: number|null}} row
 * @param {number[]} volumes - Every volume this record registers.
 * @returns {{
 *   fungible: boolean,
 *   volumesSeen: number,
 *   volumesSeenList: number[],
 *   volumesMeasured: number,
 *   rosterVolumesHeld: number,
 *   because: string,
 *   decidedBy: "presence"|"presence-none-measured",
 * }}
 */
function classifyFungibility(row, volumes) {
  const volumesSeenList = [...row.volumesPresent].sort((a, b) => a - b);
  const volumesSeen = volumesSeenList.length;
  const held = rosterVolumesHeld(row, volumes);
  const fungible = volumesSeen < NOT_FUNGIBLE_MIN_VOLUMES;
  const because = fungible
    ? `the book prints this name in ${volumesSeen} of the ${row.volumesMeasured.length} volume(s) whose text ` +
      `was searched for it, below the ${NOT_FUNGIBLE_MIN_VOLUMES}-volume line` +
      (held >= NOT_FUNGIBLE_MIN_VOLUMES
        ? ` — the roster has held the entry for ${held} volume(s), which is not the same as the book printing them`
        : "")
    : `the book prints this name in ${volumesSeen} volumes (${volumesSeenList.join(", ")}), at or above the ` +
      `${NOT_FUNGIBLE_MIN_VOLUMES}-volume line`;
  return {
    fungible,
    volumesSeen,
    volumesSeenList,
    volumesMeasured: row.volumesMeasured.length,
    rosterVolumesHeld: held,
    because,
    decidedBy: "presence",
  };
}

module.exports = {
  NOT_FUNGIBLE_MIN_VOLUMES,
  SPEAKER_TEST_NOT_RUN,
  BLIND_SPOT,
  classifyFungibility,
  rosterVolumesHeld,
};
