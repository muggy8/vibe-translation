/**
 * character-voice/findings.js — what this stage learned about **how it read the volume**, in the
 * delivery layer's own vocabulary.
 *
 * The reading pass (`character-voice/reading.js`) already knows which chapters came back whole, which
 * needed a second paid read, and which never answered at all. Until this file existed that knowledge
 * stopped at the volume: `readingReport` prints it into `character-voice-validation.md` for the grader,
 * the log prints it for the operator, and nothing put it on the disk where the run's assessment reads.
 * That is gotcha 138 — the same hole the glossary's read pass had, and the reason a declared MAJOR could
 * behave like a sentence. The glossary got its carrier first (`glossary/store.js` builds
 * `chapter-extraction-never-answered` and `glossary/task.js` hands it to the channel); this is the voice
 * stage's half of the same pipe.
 *
 * **The two things this stage can honestly say about a chapter, and why they are different sizes.**
 *
 *   - **It never answered.** Both paid reads came back with nothing a parser could read as a claim, so
 *     this volume's record holds nothing for that chapter. `voice-chapter-never-answered`, MAJOR — the
 *     sibling of the glossary's `chapter-extraction-never-answered`, and the same reason: the voice
 *     reference is copied forward, so a hole here is inside every later volume's record too. It is a
 *     separate kind because the routing keys on kind, and the glossary row's `why` names the glossary.
 *   - **It answered half.** The array never reached its closing bracket, some claims were filed and some
 *     were not, and the chapter is kept. `voice-chapter-kept-cut-off`, MINOR: real damage that must be
 *     investigated, but the one real volume this repository read needed a second paid read on 2 of its 7
 *     chapters, so rating it MAJOR would pause a 17-volume run over something routine. That reasoning is
 *     written into the level row too, because the level is the decision and it lives in the table.
 *
 * **What this file does NOT do.** It does not decide the level — `utils/postmortem/levels.js` does, and
 * the channel re-looks it up when it reads the record back, so a stage cannot grade its own finding
 * (AGENTS.md rule 3). It does not re-measure anything: every fact it speaks comes from the chapter record
 * the reading pass already built. It does not report a chapter that had nothing new to say — an empty
 * answer for a chapter with nothing in it is not damage, and `[]` is also the honest answer. And it adds
 * no model call and no environment variable.
 *
 * Part of the character-voice.js layer.
 */

const { finding } = require("../utils/postmortem");

require("../types"); // JSDoc type definitions

/** The stage's own name, exactly as `utils/artifacts.js` and `gulpfile.js` spell it. */
const STEP = "character-voice";

/** The artifact a missing chapter is missing from. */
const VOICE_ARTIFACT = "character-voice.md";

/** A chapter whose paid reads produced nothing at all. Declared MAJOR. */
const NEVER_ANSWERED_KIND = "voice-chapter-never-answered";

/** A chapter kept although its answer stopped before its closing bracket. Declared MINOR. */
const KEPT_CUT_OFF_KIND = "voice-chapter-kept-cut-off";

/**
 * The refusal rules that mean "this chapter never answered", as opposed to "this volume was asked for a
 * chapter it does not have".
 *
 * `unknown-chapter` is deliberately absent: a mistyped `--chapter=` is an operator's mistake, not a hole
 * in what this volume read.
 *
 * @type {Set<string>}
 */
const NEVER_ANSWERED_REFUSALS = new Set(["chapter-extraction-failed", "chapter-extraction-unparseable"]);

/**
 * One chapter's paid reads, printed the way the reading pass printed them: the level it was read at, how
 * many claims came back, and what went wrong.
 *
 * @param {Array<{thinkingLevel: string|null, claims: number, cutOff: boolean, failure: string|null}>} attempts
 * @returns {string} e.g. `xhigh: 0 (cut off); medium: 0 (cut off)`
 */
function attemptsLine(attempts) {
  const list = Array.isArray(attempts) ? attempts : [];
  if (!list.length) return "no paid read recorded";
  return list
    .map((a) => `${a.thinkingLevel || "run default"}: ${a.claims || 0}${a.cutOff ? " (cut off)" : ""}${a.failure ? ` (${a.failure})` : ""}`)
    .join("; ");
}

/**
 * The findings this volume's reading pass earned.
 *
 * Built from what the pass already recorded, in reading order: one MINOR per chapter that was kept
 * although its answer came back half, and one MAJOR for the chapter that made the pass refuse because
 * neither paid read produced anything.
 *
 * @param {Object} opts
 * @param {Array<{id: string, entries?: Array<Object>, incomplete?: boolean, cutOff?: boolean, attempts?: Array<Object>}>} opts.chapters
 *   The chapters the pass kept, in reading order. A chapter that never answered is NOT among them — the
 *   pass refuses before it gets there — which is why `refusal` is a separate input.
 * @param {{rule: string, because: string}|null} [opts.refusal] - Why the pass stopped, when it stopped.
 * @param {string|number} opts.volume - The installment number, as the plan of record spells it.
 * @returns {import("../utils/postmortem").PostMortemFinding[]} In the order found; empty when every
 *   chapter came back whole.
 */
function readingFindings({ chapters, refusal, volume }) {
  /** @type {import("../utils/postmortem").PostMortemFinding[]} */
  const findings = [];

  for (const chapter of chapters || []) {
    if (!chapter || !(chapter.incomplete || chapter.cutOff)) continue;
    const claims = Array.isArray(chapter.entries) ? chapter.entries.length : 0;
    findings.push(
      finding(
        "MEDIUM",
        "voice-chapter-kept-cut-off",
        STEP,
        volume,
        VOICE_ARTIFACT,
        `chapter ${chapter.id}: kept with ${claims} claim(s), and its answer never reached its closing bracket ` +
          `(paid reads: ${attemptsLine(chapter.attempts)}). Whatever that answer never got to writing is missing ` +
          `from this volume's character-voice reference, and this volume's record is what every later volume's ` +
          `reference is copied from.`
      )
    );
  }

  if (refusal && NEVER_ANSWERED_REFUSALS.has(String(refusal.rule))) {
    findings.push(
      finding(
        "HIGH",
        "voice-chapter-never-answered",
        STEP,
        volume,
        VOICE_ARTIFACT,
        `${refusal.because} — this volume's character-voice reference holds nothing for that chapter, and this ` +
          `volume's record is what every later volume's reference is copied from.`
      )
    );
  }

  return findings;
}

module.exports = {
  STEP,
  VOICE_ARTIFACT,
  NEVER_ANSWERED_KIND,
  KEPT_CUT_OFF_KIND,
  NEVER_ANSWERED_REFUSALS,
  attemptsLine,
  readingFindings,
};
