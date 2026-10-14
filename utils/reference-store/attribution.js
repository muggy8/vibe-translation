/**
 * utils/reference-store/attribution.js — who is speaking the words a claim quotes.
 *
 * A character-voice claim does two different jobs at once, and the record has always been able to
 * answer only one of them. It says **who the claim is about** — the roster entry its bullet is filed
 * under — and it quotes **words somebody said**. Those are not the same fact. A bullet about 三色院菫子
 * that quotes a line of narration is a correct bullet about the right person quoting the wrong
 * speaker, and a bullet under a name this volume's text never prints is a bullet whose subject may
 * not be in the book at all.
 *
 * Three rules decide this module's shape, and all three come from measuring the two real records
 * before writing any of it.
 *
 *   - **The store cannot tell you who is speaking, and the obvious rule is a machine for making
 *     false positives.** The tempting check — "the cited line names a cast member, so that is the
 *     speaker" — was run against both records: it fires on **0** of volume 01's character claims and
 *     **10** of volume 02's, and every one of those 10 is the *addressee*, not the speaker
 *     (`「あすなろさん。君の気持ちは…」` is 秋野桜 talking **to** あすなろ). A check that names a
 *     speaker from the inside of a quote is wrong on every example this corpus gives it, so this
 *     module does not name speakers. It decides **when the record's own answer is in doubt**, which
 *     is a question the record can answer.
 *   - **Doubt is measured against the volume that established the claim, not the volume being
 *     audited.** A claim established in volume 1 was read out of volume 1. Auditing it in volume 3
 *     against volume 3's text reports every character who stayed off that page — measured that way,
 *     the naive rule catches **8** claims in volume 2's record; measured against the establishing
 *     volume it catches **6**, all of them 蒲田's, and 0 in volume 1. The second number is the one
 *     that describes a real contradiction in the record: this volume filed six claims under a name
 *     this volume's text says nobody wears.
 *   - **An absence can be a blind spot, and saying which is the difference between a finding and a
 *     false alarm.** 蒲田 is in volume 2. The book prints the name as 蒲かま田た — the reading aids
 *     written *between* the two kanji — and the store's one matching rule needs a Han-character
 *     skeleton of `GLOSSARY_SKELETON_MIN_CHARS` (3) or more, so a two-kanji name is invisible to it.
 *     The narrow probe in `namePrintedWithReadingAids` searches for a name's kanji in order with
 *     only kana between them. Swept over every cast entry both records hold: it fires on **1** of the
 *     4 entries measured absent (蒲田, at ch3:1243) and on **0** of the other 3, so it explains this
 *     absence without becoming a second matching rule. It is **not** wired into `presence.js` or
 *     `evidence.js`: widening the store's one matching rule to rescue one character is how a guard
 *     stops meaning what it says, and the coverage rule and the copy-forward guard are built on that
 *     rule answering the same question everywhere.
 *
 * What happens to a doubt. The deterministic pass reports it (MEDIUM) and never edits a row. Answering
 * it properly means reading the scene, which is the one part of this that costs a model call, so the
 * call is bounded (`character-voice/detective.js`) and its answer is kept in `attribution_answers` —
 * otherwise the next run pays for the same reading again and cannot tell "nobody asked" from "somebody
 * asked and agreed". An answer that **disagrees** goes through `challenge_fact`, which is the door that
 * already exists for contradicting a row you do not own: the sealed row is untouched, the challenger is
 * filed by the asking volume with its own verified citation, and the dispute stays open until somebody
 * closes it. An answer that lands on **narrator** files the challenger with no roster entry at all,
 * because "the narrator said it" is not a character and must never be counted as one.
 *
 * ## Where the code lives
 *
 * The code is in `utils/reference-store/attribution/`, one job per file: `lines.js` (reading the volume's
 * own chapter lines, and the dialogue/narration verdict for one line), `reading-aids.js` (the narrow probe
 * that explains a name the store's one matching rule cannot see — a probe, never a second matching rule),
 * `doubts.js` (the roster entries this volume filed claims under that its own text does not contain, and
 * the aspects the question applies to at all), `answers.js` (reading the answers this record already holds),
 * `record-answer.js` (filing an answer and the challenge an answer that disagrees opens, in one transaction)
 * and `report.js` (the findings and the numbers the audit prints). This file is the public surface of the
 * attribution layer and the only thing another module should require; the doubt rule, the reading-aid bound
 * and the answer vocabulary stay inside this folder, which is a banned patch path for the dev team
 * (AGENTS.md §3).
 *
 * @module utils/reference-store/attribution
 */

const { SKELETON_MIN_CHARS } = require("./evidence");

const lines = require("./attribution/lines");
const readingAids = require("./attribution/reading-aids");
const doubts = require("./attribution/doubts");
const answers = require("./attribution/answers");
const recordAnswer = require("./attribution/record-answer");
const report = require("./attribution/report");

// The public surface, unchanged from the single file.
module.exports = {
  ATTRIBUTION_STEP: report.ATTRIBUTION_STEP,
  SPEECH_ASPECTS: doubts.SPEECH_ASPECTS,
  READING_AID_MAX_GAP: readingAids.READING_AID_MAX_GAP,
  SKELETON_MIN_CHARS,
  lineSpeechKind: lines.lineSpeechKind,
  readingAidSpan: readingAids.readingAidSpan,
  namePrintedWithReadingAids: readingAids.namePrintedWithReadingAids,
  claimsFiledUnderAtVolume: doubts.claimsFiledUnderAtVolume,
  speakerPassage: lines.speakerPassage,
  attributionDoubts: doubts.attributionDoubts,
  attributionAnswer: answers.attributionAnswer,
  attributionAnswers: answers.attributionAnswers,
  recordAttributionAnswer: recordAnswer.recordAttributionAnswer,
  attributionFindings: report.attributionFindings,
  attributionSummary: report.attributionSummary,
  attributionVolumeDir: lines.attributionVolumeDir,
};
