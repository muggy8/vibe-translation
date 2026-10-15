/**
 * character-voice/reading/volume.js — the one job: walk one volume chapter by chapter, decide for each
 * chapter whether to reuse what is already on disk or pay for it, and refuse the pass when a chapter cannot
 * be answered at all.
 *
 * This is the orchestrating half of the reading pass, and the only half that reaches the other modules:
 * `./partials` for what a chapter already costs, `./reads` for a paid read and its budget, `./answer`'s
 * verdict through `readOneChapter`, and `../known-facts` for what each chapter is shown as already known.
 * Two outcomes are decided here and they are NOT the same outcome, and nothing downstream may merge them:
 * a chapter **kept although its array never closed** (it has claims, it is named INCOMPLETE, the pass
 * carries on — `voice-chapter-kept-cut-off`, MINOR) and a chapter that **never answered** (the pass refuses,
 * the chapter is not in the list at all — `voice-chapter-never-answered`, MAJOR). `character-voice/findings.js`
 * reads that difference straight off this function's return value.
 *
 * Part of the character-voice/reading.js layer.
 *
 * @module character-voice/reading/volume
 */

const path = require("path");
require("../../types"); // JSDoc type definitions

const { buildAlreadyExtractedNote } = require("../prompts");
const { knownFactsForChapter } = require("../known-facts");

const { segmentFingerprint, readPartial, writePartial } = require("./partials");
const { MAX_ATTEMPTS_PER_CHAPTER, EXTRACTION_RETRY_THINKING_LEVEL, readOneChapter, attemptLog } = require("./reads");

/**
 * Read one volume chapter by chapter and return its chapters, in reading order.
 *
 * The rules, in the order they bite:
 *
 *   1. a chapter with a usable, complete partial is reused and costs nothing;
 *   2. a chapter whose partial is usable but **cut off** is re-read, unless it has already used its
 *      `MAX_ATTEMPTS_PER_CHAPTER` budget — in which case it is kept and named as incomplete;
 *   3. `--force` and `onlyChapters` both pay for a chapter that would otherwise be reused;
 *   4. an answer that did not close its array is retried once at `EXTRACTION_RETRY_THINKING_LEVEL`,
 *      and the better of the two answers is the one the notebook gets;
 *   5. a chapter that yields nothing at all after its paid reads refuses the pass — a notebook with a
 *      hole in it is not a notebook.
 *
 * @param {Object} params
 * @param {Object} params.ctx - The extraction ctx. `refStore` is the volume's open reference record, and
 *   it is what every chapter's "what is already known" is read out of. `previousVoiceRefFile` is no
 *   longer shown to a chapter (plan 06 slice 2); it is still what the carry-forward guard compares this
 *   volume's render against.
 * @param {Array<{id: string, file: string}>} params.segments - The volume's chapters, in reading order.
 * @param {string} params.volumeDir
 * @param {string|number} params.installmentNumber
 * @param {boolean} [params.force] - Re-read every chapter, even a complete one.
 * @param {string[]|null} [params.onlyChapters] - Re-read exactly these chapter ids and reuse the rest.
 * @param {(line: string) => void} [params.log]
 * @returns {Promise<{ok: boolean, chapters: Array<Object>, refusal: Object|null}>}
 */
async function readVolumeChapters({ ctx, segments, volumeDir, installmentNumber, force = false, onlyChapters = null, log = console.log }) {
  // **The record is not optional** (plan 06 slice 2). The reference every chapter used to be shown was a
  // file, and a missing file meant a silent nothing: no refusal, no log line, no finding, and a chapter
  // read with no accumulated knowledge looked exactly like a chapter read with an empty one. The record
  // is where the earlier volumes' claims are carried forward, so a pass without one is refused here, at
  // the one door both the stage and `extract-voice.js` read through, and there is no fallback to a
  // markdown file behind it.
  if (!ctx || !ctx.refStore) {
    return {
      ok: false,
      chapters: [],
      refusal: {
        rule: "no-reference-record",
        because:
          `volume ${installmentNumber} has no reference record open, and this route reads a volume against what that record already knows. ` +
          "Without it every chapter would be asked \"what is new here?\" with nothing beside the question to answer \"compared to what?\".",
        fix: "open the volume's record first — `openVoiceRecord` (the stage and extract-voice.js both do). There is no fallback to the previous volume's character-voice.md.",
      },
    };
  }

  const wanted = Array.isArray(onlyChapters) && onlyChapters.length ? new Set(onlyChapters) : null;
  if (wanted) {
    const known = new Set(segments.map((s) => s.id));
    const unknown = [...wanted].filter((id) => !known.has(id));
    if (unknown.length) {
      return {
        ok: false,
        chapters: [],
        refusal: {
          rule: "unknown-chapter",
          because: `this volume has no chapter named ${unknown.map((u) => `"${u}"`).join(", ")}.`,
          fix: `chapters here are: ${segments.map((s) => s.id).join(", ")}.`,
        },
      };
    }
  }

  /** @type {Array<Object>} */
  const chapters = [];
  for (let si = 0; si < segments.length; si++) {
    const segment = segments[si];
    const segPath = path.join(volumeDir, segment.file);
    const fingerprint = segmentFingerprint(segPath);
    const reReadWanted = force || (wanted ? wanted.has(segment.id) : false);

    if (!reReadWanted) {
      const partial = readPartial(volumeDir, segment, fingerprint);
      if (partial.usable && partial.complete) {
        log(`  chapter ${segment.id}: reused (${partial.entries.length} claim(s)) — ${partial.because}`);
        chapters.push({
          id: segment.id,
          segment,
          entries: partial.entries,
          reused: true,
          paidReads: 0,
          cutOff: false,
          incomplete: false,
          attempts: partial.attemptsLog || [],
          lostClaims: 0,
          // Never asked, so never shown anything: `null` is "not measured", not "measured and empty".
          knownCharacters: null,
          knownClaims: null,
        });
        continue;
      }
      if (partial.usable && !partial.complete && partial.attempts >= MAX_ATTEMPTS_PER_CHAPTER) {
        log(`  chapter ${segment.id}: INCOMPLETE and kept — ${partial.because}, and its ${MAX_ATTEMPTS_PER_CHAPTER} paid read(s) are used up.`);
        log(`    this volume's reference is missing whatever that chapter's answer never got to writing. The chapter is named in the validation report.`);
        chapters.push({
          id: segment.id,
          segment,
          entries: partial.entries,
          reused: true,
          paidReads: 0,
          cutOff: true,
          incomplete: true,
          attempts: partial.attemptsLog || [],
          lostClaims: 0,
          knownCharacters: null,
          knownClaims: null,
        });
        continue;
      }
      if (partial.because !== "no partial for this chapter yet") log(`  chapter ${segment.id}: re-reading — ${partial.because}`);
    }

    /** The cumulative note: what this pass has already extracted, chapter by chapter. */
    const buildNote = (done) =>
      buildAlreadyExtractedNote({
        installmentNumber,
        segmentsTotal: segments.length,
        doneSegments: done.map((c) => c.id),
        entries: done.flatMap((c) => c.entries),
      });

    // **What this chapter is shown as already known**: the record's current claims for the characters
    // this chapter's own text names. Built once per chapter and handed to both paid reads, because the
    // record does not change during a reading pass (the claims this volume produces are filed after it).
    // A chapter the record names nobody in is named out loud here rather than shown a silent nothing —
    // that silence is the defect plan 06 §7 names.
    const known = knownFactsForChapter(ctx, segment);
    if (!known.ok) {
      return {
        ok: false,
        chapters,
        refusal: {
          rule: known.refusal.rule,
          because: `chapter ${segment.id}: ${known.refusal.because}`,
          fix: known.refusal.fix,
        },
      };
    }
    if (known.namedCount === 0) {
      log(`  chapter ${segment.id}: the record names NOBODY in this chapter's text (${known.rosterTotal} roster entr(ies) carried) — it is read with no prior knowledge of any character.`);
    } else {
      log(`  chapter ${segment.id}: shown ${known.claimsShown} current claim(s) about ${known.namedCount} of ${known.rosterTotal} roster entr(ies) this chapter names (${known.bytes} characters).`);
    }

    /** @type {Array<Object>} */
    const attempts = [];
    const first = await readOneChapter({ ctx, segment, si, extraNote: buildNote(chapters), knownBlock: known.block, log });
    attempts.push(attemptLog(first));
    // A read that failed for a reason a re-ask cannot fix — the answer hit the output cap, or the call
    // itself failed — stops the pass, exactly as it did before this file learned about answer shapes.
    // A refused shape does not: that one is given the chapter's second paid read below.
    if (!first.ok && first.failure.kind !== "shape-refused") {
      return {
        ok: false,
        chapters,
        refusal: {
          rule: "chapter-extraction-failed",
          because: `chapter ${segment.id} (${first.failure.kind}): ${first.error}`,
          fix: "run this command again — the chapters already read are kept and are not paid for twice.",
        },
      };
    }
    if (first.ok) {
      log(`  chapter ${segment.id}: ${first.entries.length} claim(s) read${first.thinkingLevel ? ` at ${first.thinkingLevel}` : ""}${first.cutOff ? " — CUT OFF: the answer never reached its closing bracket" : ""}`);
      if (first.recovered) {
        log(`    the answer was not valid JSON as a whole (${first.error}).`);
        log(`    recovered ${first.entries.length} claim(s) individually; ${first.lost.length} could not be read.`);
        for (const item of first.lost.slice(0, 10)) log(`    lost: ${item.because} — ${item.raw.replace(/\s+/g, " ").slice(0, 160)}`);
      }
    }

    let best = first;
    let retried = false;
    /**
     * A chapter is re-read when its answer did not arrive whole, and there are three ways that happens.
     * The array never closed (cut off). The answer yielded nothing. Or — the one this door used to miss —
     * the array closed but one element inside it was malformed, so the tolerant reader recovered the rest
     * and named the claim it could not read.
     *
     * Measured on the real volume 01 on 2026-10-12: chapter ch2 closed its array cleanly and still lost
     * one claim to `Expected ',' or ']' after array element in JSON at position 13345`. Under the old
     * condition that chapter had its one paid read and the lost claim was only ever visible in the partial.
     * A named loss is better than a swallowed one, which is the whole reason this file exists — but a named
     * loss that could have been paid for and wasn't is still a loss.
     *
     * The budget is unchanged: `MAX_ATTEMPTS_PER_CHAPTER` is two paid reads per chapter per pass, and the
     * better answer still wins, so a re-read that comes back worse does not replace the first one.
     */
    const answerIncomplete = !first.ok || first.cutOff || first.entries.length === 0 || first.lost.length > 0;
    if (answerIncomplete) {
      if (!first.ok) log(`  chapter ${segment.id}: the endpoint refused the answer shape (${first.failure.because}). Re-reading it at ${EXTRACTION_RETRY_THINKING_LEVEL}.`);
      else if (first.entries.length === 0) log(`  chapter ${segment.id}: the answer yielded no claims at all — re-reading it at ${EXTRACTION_RETRY_THINKING_LEVEL}.`);
      else if (first.cutOff) log(`  chapter ${segment.id}: a cut-off answer is half an answer. Re-reading it at ${EXTRACTION_RETRY_THINKING_LEVEL}.`);
      else log(`  chapter ${segment.id}: ${first.lost.length} claim(s) could not be read out of a closed array. Re-reading it at ${EXTRACTION_RETRY_THINKING_LEVEL}.`);
      const second = await readOneChapter({ ctx, segment, si, extraNote: buildNote(chapters), knownBlock: known.block, thinkingLevel: EXTRACTION_RETRY_THINKING_LEVEL, log });
      retried = true;
      attempts.push(attemptLog(second));
      if (second.ok) {
        log(`  chapter ${segment.id}: re-read at ${EXTRACTION_RETRY_THINKING_LEVEL} → ${second.entries.length} claim(s), ${second.cutOff ? "still cut off" : "the array closed"}${second.lost.length ? `, ${second.lost.length} unreadable` : ""}.`);
        if (second.entries.length > best.entries.length || (!second.cutOff && best.cutOff)) best = second;
      } else {
        log(`  chapter ${segment.id}: the re-read ${second.failure.kind === "shape-refused" ? "was refused by the endpoint too" : `failed (${second.failure.kind})`}.`);
      }
    }

    if (best.entries.length === 0) {
      const kinds = attempts.map((a) => `${a.thinkingLevel || "run default"}: ${a.failure || (a.cutOff ? "cut off" : "no claims")}`).join("; ");
      return {
        ok: false,
        chapters,
        refusal: {
          rule: "chapter-extraction-unparseable",
          because:
            `chapter ${segment.id}: ${best.error}${best.cutOff ? " — and the answer never reached its closing bracket, so it was cut off, not merely malformed" : ""} ` +
            `(paid reads: ${kinds})`,
          fix: "run this command again; the chapters already read are kept and are not paid for twice.",
        },
      };
    }

    const file = await writePartial(volumeDir, segment, fingerprint, best.entries, installmentNumber, {
      attempts,
      cutOff: best.cutOff,
      parseError: best.recovered ? best.error : null,
      lost: best.lost,
      rawAnswer: best.recovered ? best.raw : undefined,
    });
    const paidReads = attempts.length;
    const incomplete = best.cutOff;
    log(`  chapter ${segment.id}: ${best.entries.length} claim(s) kept → ${path.basename(file)} (${paidReads} paid read(s)${incomplete ? ", still cut off — named in the report" : ""})`);
    chapters.push({
      id: segment.id,
      segment,
      entries: best.entries,
      reused: false,
      paidReads,
      cutOff: incomplete,
      incomplete,
      retried,
      attempts,
      lostClaims: best.lost.length,
      knownCharacters: known.namedCount,
      knownClaims: known.claimsShown,
      knownBytes: known.bytes,
    });
  }

  return { ok: true, chapters, refusal: null };
}

module.exports = {
  readVolumeChapters,
};
