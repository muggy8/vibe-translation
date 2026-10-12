/**
 * character-voice/reading.js — the voice stage's reading pass: read one volume chapter by chapter
 * and produce its extraction notebook, with each chapter's answer kept beside the volume so a
 * chapter is not paid for twice.
 *
 * Why this lives here rather than inside `extract-voice.js`. The reading pass is now the voice
 * stage's normal route, and two doors open it: the standalone command and the stage itself. A
 * second implementation of resume, fingerprints and cut-off detection is a second set of rules, and
 * the two would drift exactly the way the two QA loops used to. So the loop lives here once and both
 * doors call it.
 *
 * ## The failure this file exists for
 *
 * Measured on the real volume 02, at the run's normal reasoning level: **three of seven chapters
 * came back cut off** — the answer never reached its closing bracket. Two of them yielded 6 and 1
 * claims for chapters of 33,541 and 35,553 characters, and the pass accepted them. Re-read at a
 * lower reasoning level the same two chapters yielded 21 and 8. The route this one replaced was worse:
 * its chapter-by-chapter flow swallowed an unparseable chapter in a `catch {}` and carried on, so the
 * hole never surfaced (that flow is gone; it is in git history at commit 75e59a7).
 *
 * A cut-off answer is not a short answer, it is a **half an answer**: the model stopped in the middle
 * of the list, and what it was about to write is not in the file. Nothing about the volume says which
 * claims are missing, so the only honest response is to name the chapter and read it again. That is
 * what this file does, and it is not behind a flag: `scanTopLevelObjects` reports whether the array
 * closed, and an answer that did not close is retried.
 *
 * ## The retry's reasoning level
 *
 * `EXTRACTION_RETRY_THINKING_LEVEL` is a constant, not an environment knob. The first attempt runs at
 * whatever level the run is using; a cut-off answer is retried at this one because that is the level
 * the measurement showed completes the answer on the chapters that failed. It is not a guard being
 * loosened — it is a second attempt at a different setting, recorded in the partial next to the first
 * attempt's, so the volume's own record says which level produced what. **When the run's own level already
 * equals this one the retry is a same-level re-sample, not a lower-reasoning retry** — measured on
 * 2026-10-12 with `AI_THINKING_LEVEL=medium`, and the re-sample still closed both cut-off chapters, so what
 * fixed them was a second roll rather than the lower level (AGENTS.md gotcha 122).
 *
 * ## What is bounded
 *
 * `MAX_ATTEMPTS_PER_CHAPTER` is the whole budget: two paid attempts per chapter, per pass. A chapter
 * that is still cut off after that is kept (the better of its two answers), named as incomplete in
 * the log, in the partial, and in the report the grader reads. A route that refused a volume for one
 * stubborn chapter would make the volume unfinishable; a route that said nothing would be the failure
 * this file exists to fix.
 *
 * @module character-voice/reading
 */

const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const crypto = require("crypto");
require("../types"); // JSDoc type definitions

const { runExtract, parseVoiceQuirks } = require("./stages");
const { buildAlreadyExtractedNote } = require("./prompts");

/** One chapter's answer, kept beside the volume so an interrupted pass does not pay for it twice. */
const PARTIAL_PREFIX = "character-voice-extract-";

/** The notebook the voice stage writes under this name; the reading pass writes the same one. */
const EXTRACTION_FILE = "character-voice-new.json";

/**
 * The partial's format version.
 *
 * Version 2 added `attempts` — one entry per paid read of the chapter, each with the reasoning level
 * it ran at and whether its answer closed. A version-1 partial cannot say whether its answer was
 * complete, and "we do not know" is answered here by re-reading rather than by trusting.
 */
const PARTIAL_SCHEMA = 2;

/**
 * How many paid reads one chapter gets in one pass.
 *
 * Two: the run's normal level, then the retry level. After that the chapter is named as incomplete
 * and the pass carries on with the better of the two answers.
 */
const MAX_ATTEMPTS_PER_CHAPTER = 2;

/**
 * The reasoning level a cut-off chapter is re-read at.
 *
 * Measured on volume 02 at `AI_THINKING_LEVEL=xhigh`: chapter ch4 yielded 6 claims and ch5 yielded 1,
 * both cut off; re-read at `medium` the same chapters yielded 21 and 8, both complete. A constant,
 * on purpose — a level the operator can set is a level that quietly stops being the fix.
 */
const EXTRACTION_RETRY_THINKING_LEVEL = "medium";

/**
 * The partial file one chapter's answer belongs in.
 *
 * @param {string} volumeDir
 * @param {string} segmentId
 * @returns {string}
 */
function partialPath(volumeDir, segmentId) {
  return path.join(volumeDir, `${PARTIAL_PREFIX}${segmentId}.json`);
}

/**
 * A fingerprint of the chapter text a partial was produced from.
 *
 * Resume is only safe if the partial belongs to the text that is there now. Content, not mtime:
 * a re-extracted chapter whose text is identical is the same chapter, and a chapter whose text
 * changed must not keep an answer that describes the old one.
 *
 * @param {string} file - Absolute path to the chapter file.
 * @returns {string} `missing` when it cannot be read — fail loud, not "unchanged".
 */
function segmentFingerprint(file) {
  try {
    return crypto.createHash("sha256").update(fsSync.readFileSync(file)).digest("hex");
  } catch {
    return "missing";
  }
}

/**
 * Read one chapter's partial, and say both whether it may be reused **and whether it is complete**.
 *
 * `complete` is the new half: a partial whose answer never closed its array is a usable record of a
 * failed read, not an answer to build a volume from. Whether it may still be reused turns on how many
 * paid attempts it already carries — see `MAX_ATTEMPTS_PER_CHAPTER`.
 *
 * @param {string} volumeDir
 * @param {{id: string, file: string}} segment
 * @param {string} fingerprint - The current chapter text's fingerprint.
 * @returns {{usable: boolean, complete: boolean, attempts: number, entries?: Array<Object>, attemptsLog?: Array<Object>, file: string, because: string}}
 */
function readPartial(volumeDir, segment, fingerprint) {
  const file = partialPath(volumeDir, segment.id);
  if (!fsSync.existsSync(file)) return { usable: false, complete: false, attempts: 0, file, because: "no partial for this chapter yet" };

  let parsed;
  try {
    parsed = JSON.parse(fsSync.readFileSync(file, "utf8"));
  } catch (err) {
    return { usable: false, complete: false, attempts: 0, file, because: `the partial is not readable JSON: ${err.message}` };
  }
  if (!parsed || parsed.schema !== PARTIAL_SCHEMA) {
    return {
      usable: false,
      complete: false,
      attempts: 0,
      file,
      because: `the partial is not schema ${PARTIAL_SCHEMA}${parsed && parsed.schema ? ` (it is schema ${parsed.schema})` : ""} — it cannot say whether its answer was complete, so the chapter is read again`,
    };
  }
  if (parsed.segmentId !== segment.id) {
    return { usable: false, complete: false, attempts: 0, file, because: `the partial names chapter "${parsed.segmentId}", not "${segment.id}"` };
  }
  if (!Array.isArray(parsed.entries)) {
    return { usable: false, complete: false, attempts: 0, file, because: "the partial holds no entry array" };
  }
  if (parsed.sourceSha !== fingerprint) {
    return {
      usable: false,
      complete: false,
      attempts: 0,
      file,
      because: `this chapter's text has changed since the partial was written (${String(parsed.sourceSha).slice(0, 12)}… → ${fingerprint.slice(0, 12)}…)`,
    };
  }
  const attemptsLog = Array.isArray(parsed.attempts) ? parsed.attempts : [];
  const attempts = attemptsLog.length || 1;
  const complete = parsed.cutOff !== true;
  return {
    usable: true,
    complete,
    attempts,
    entries: parsed.entries,
    attemptsLog,
    file,
    because: complete
      ? "reused: the same chapter text, already read, and the answer closed"
      : `the answer on disk was cut off before its closing bracket (${attempts} paid read(s) already recorded)`,
  };
}

/**
 * Write one chapter's answer. Written to a temporary name and renamed, so a pass that dies mid-write
 * cannot leave a half-written partial that the next pass would read as an answer.
 *
 * @param {string} volumeDir
 * @param {{id: string, file: string}} segment
 * @param {string} fingerprint
 * @param {Array<Object>} entries
 * @param {string|number} installmentNumber
 * @param {{attempts?: Array<Object>, cutOff?: boolean, parseError?: string|null, lost?: Array<Object>, rawAnswer?: string}} [extra]
 *   What the paid reads were — each with its reasoning level, its claim count and whether its answer
 *   closed — plus what the strict parse said, which claims were dropped, and the answer itself, so a
 *   later pass can re-read it without paying for the chapter again.
 * @returns {Promise<string>} The partial's path.
 */
async function writePartial(volumeDir, segment, fingerprint, entries, installmentNumber, extra = {}) {
  const file = partialPath(volumeDir, segment.id);
  const body = JSON.stringify(
    {
      schema: PARTIAL_SCHEMA,
      volume: String(installmentNumber),
      segmentId: segment.id,
      segmentFile: segment.file,
      sourceSha: fingerprint,
      extractedAt: new Date().toISOString(),
      entries,
      cutOff: Boolean(extra.cutOff),
      attempts: extra.attempts || [],
      ...(extra.parseError
        ? { parseError: extra.parseError, lostClaims: extra.lost || [], rawAnswer: extra.rawAnswer || "" }
        : {}),
    },
    null,
    2
  );
  const temp = `${file}.writing`;
  await fs.writeFile(temp, body + "\n", "utf8");
  await fs.rename(temp, file);
  return file;
}

/**
 * Assemble the volume's notebook from its chapter partials, in reading order.
 *
 * @param {Array<{segment: {id: string}, entries: Array<Object>}>} chapters - Already in reading order.
 * @returns {Array<Object>}
 */
function consolidateExtraction(chapters) {
  const all = [];
  for (const chapter of chapters) all.push(...chapter.entries);
  return all;
}

/**
 * Scan a JSON array for its top-level objects, string-aware.
 *
 * Why this exists and not just a second `JSON.parse`: the extraction model's answers are arrays of
 * objects, and a claim with a syntax error — a missing comma between two properties, measured on the
 * real volume 02 chapter ch2 — leaves every **other** object in that array perfectly balanced and
 * perfectly parseable. Dropping the whole chapter because one claim was malformed loses twenty claims
 * to fix one. This finds the objects; it does not repair any of them.
 *
 * It is also how a cut-off answer is detected: `closed` is false when the array never reached its
 * `]`, and that is a different failure from a malformed claim — the answer is missing whatever the
 * model had not written yet.
 *
 * @param {string} text
 * @returns {{objects: string[], closed: boolean}} The balanced top-level objects, and whether the array closed.
 */
function scanTopLevelObjects(text) {
  const body = String(text || "");
  const start = body.indexOf("[");
  if (start === -1) return { objects: [], closed: false };

  const objects = [];
  let depth = 0;
  let begin = -1;
  let inString = false;
  let escaped = false;
  let closed = false;

  for (let i = start + 1; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") {
      if (depth === 0) begin = i;
      depth += 1;
      continue;
    }
    if (ch === "}") {
      if (depth > 0) depth -= 1;
      if (depth === 0 && begin !== -1) {
        objects.push(body.slice(begin, i + 1));
        begin = -1;
      }
      continue;
    }
    if (ch === "]" && depth === 0) { closed = true; break; }
  }

  return { objects, closed };
}

/**
 * Read one chapter's answer as extraction entries.
 *
 * The strict parse is tried first, and a well-formed answer takes it and nothing else. When it
 * fails, the answer is read object by object: each object that parses on its own is kept, each one
 * that does not is dropped **and named with its raw text kept in the partial**, so a lost claim is
 * evidence somebody can read rather than a hole in a file. Nothing is invented and nothing is
 * repaired — the evidence rule still has to find every recovered claim's quote in this volume's text,
 * exactly like a claim that arrived in one piece.
 *
 * @param {string} output - The raw answer.
 * @returns {{entries: Array<Object>, recovered: boolean, lost: Array<{because: string, raw: string}>, cutOff: boolean, error: string|null}}
 */
function parseExtractionAnswer(output) {
  try {
    return { entries: parseVoiceQuirks(output), recovered: false, lost: [], cutOff: false, error: null };
  } catch (err) {
    const { objects, closed } = scanTopLevelObjects(output);
    /** @type {Array<Object>} */
    const entries = [];
    /** @type {Array<{because: string, raw: string}>} */
    const lost = [];
    for (const raw of objects) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && typeof parsed.type === "string") entries.push(parsed);
        else lost.push({ because: "the claim carries no `type`, so it is not a claim", raw: raw.slice(0, 500) });
      } catch (inner) {
        lost.push({ because: inner.message, raw: raw.slice(0, 500) });
      }
    }
    return { entries, recovered: true, lost, cutOff: !closed, error: err.message };
  }
}

/**
 * One chapter's paid read: ask for it, parse what comes back, and say whether the answer closed.
 *
 * @param {Object} params
 * @param {Object} params.ctx - The ctx `character-voice/stages.js`'s extraction pass reads.
 * @param {{id: string, file: string}} params.segment
 * @param {number} params.si - Zero-based position in reading order.
 * @param {string} params.extraNote - What this chapter is told about what has already been extracted.
 * @param {string|null} [params.thinkingLevel] - The reasoning level for this attempt, or null for the run's own.
 * @param {(line: string) => void} params.log
 * @returns {Promise<{ok: boolean, entries: Array<Object>, lost: Array<Object>, cutOff: boolean, recovered: boolean, error: string|null, raw: string, thinkingLevel: string|null}>}
 */
async function readOneChapter({ ctx, segment, si, extraNote, thinkingLevel = null, log }) {
  let output = "";
  try {
    output = await runExtract(ctx, segment, si, {
      stateFile: ctx.previousVoiceRefFile,
      extraNote,
      thinkingLevel,
    });
  } catch (err) {
    log(`  chapter ${segment.id}: extraction FAILED${thinkingLevel ? ` at ${thinkingLevel}` : ""}: ${err.message}`);
    return { ok: false, entries: [], lost: [], cutOff: false, recovered: false, error: err.message, raw: "", thinkingLevel };
  }
  const parsed = parseExtractionAnswer(output);
  return {
    ok: true,
    entries: parsed.entries,
    lost: parsed.lost,
    cutOff: parsed.cutOff,
    recovered: parsed.recovered,
    error: parsed.error,
    raw: output,
    thinkingLevel,
  };
}

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
 * @param {Object} params.ctx - The extraction ctx; `previousVoiceRefFile` is the reference every chapter is shown.
 * @param {Array<{id: string, file: string}>} params.segments - The volume's chapters, in reading order.
 * @param {string} params.volumeDir
 * @param {string|number} params.installmentNumber
 * @param {boolean} [params.force] - Re-read every chapter, even a complete one.
 * @param {string[]|null} [params.onlyChapters] - Re-read exactly these chapter ids and reuse the rest.
 * @param {(line: string) => void} [params.log]
 * @returns {Promise<{ok: boolean, chapters: Array<Object>, refusal: Object|null}>}
 */
async function readVolumeChapters({ ctx, segments, volumeDir, installmentNumber, force = false, onlyChapters = null, log = console.log }) {
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

    /** @type {Array<Object>} */
    const attempts = [];
    const first = await readOneChapter({ ctx, segment, si, extraNote: buildNote(chapters), log });
    if (!first.ok) {
      return {
        ok: false,
        chapters,
        refusal: {
          rule: "chapter-extraction-failed",
          because: `chapter ${segment.id}: ${first.error}`,
          fix: "run this command again — the chapters already read are kept and are not paid for twice.",
        },
      };
    }
    attempts.push({ at: new Date().toISOString(), thinkingLevel: first.thinkingLevel, claims: first.entries.length, cutOff: first.cutOff, lostClaims: first.lost.length, parseError: first.recovered ? first.error : null });
    log(`  chapter ${segment.id}: ${first.entries.length} claim(s) read${first.thinkingLevel ? ` at ${first.thinkingLevel}` : ""}${first.cutOff ? " — CUT OFF: the answer never reached its closing bracket" : ""}`);
    if (first.recovered) {
      log(`    the answer was not valid JSON as a whole (${first.error}).`);
      log(`    recovered ${first.entries.length} claim(s) individually; ${first.lost.length} could not be read.`);
      for (const item of first.lost.slice(0, 10)) log(`    lost: ${item.because} — ${item.raw.replace(/\s+/g, " ").slice(0, 160)}`);
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
    const answerIncomplete = first.cutOff || first.entries.length === 0 || first.lost.length > 0;
    if (answerIncomplete) {
      if (first.entries.length === 0) log(`  chapter ${segment.id}: the answer yielded no claims at all — re-reading it at ${EXTRACTION_RETRY_THINKING_LEVEL}.`);
      else if (first.cutOff) log(`  chapter ${segment.id}: a cut-off answer is half an answer. Re-reading it at ${EXTRACTION_RETRY_THINKING_LEVEL}.`);
      else log(`  chapter ${segment.id}: ${first.lost.length} claim(s) could not be read out of a closed array. Re-reading it at ${EXTRACTION_RETRY_THINKING_LEVEL}.`);
      const second = await readOneChapter({ ctx, segment, si, extraNote: buildNote(chapters), thinkingLevel: EXTRACTION_RETRY_THINKING_LEVEL, log });
      retried = true;
      if (second.ok) {
        attempts.push({ at: new Date().toISOString(), thinkingLevel: second.thinkingLevel, claims: second.entries.length, cutOff: second.cutOff, lostClaims: second.lost.length, parseError: second.recovered ? second.error : null });
        log(`  chapter ${segment.id}: re-read at ${EXTRACTION_RETRY_THINKING_LEVEL} → ${second.entries.length} claim(s), ${second.cutOff ? "still cut off" : "the array closed"}${second.lost.length ? `, ${second.lost.length} unreadable` : ""}.`);
        if (second.entries.length > best.entries.length || (!second.cutOff && best.cutOff)) best = second;
      } else {
        attempts.push({ at: new Date().toISOString(), thinkingLevel: second.thinkingLevel, claims: 0, cutOff: true, lostClaims: 0, parseError: second.error });
      }
    }

    if (best.entries.length === 0) {
      return {
        ok: false,
        chapters,
        refusal: {
          rule: "chapter-extraction-unparseable",
          because: `chapter ${segment.id}: ${best.error}${best.cutOff ? " — and the answer never reached its closing bracket, so it was cut off, not merely malformed" : ""}`,
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
    });
  }

  return { ok: true, chapters, refusal: null };
}

/**
 * The block the validation report carries about **how this volume was read**.
 *
 * A reference assembled from chapters that had to be re-read is a different artifact from one where
 * every chapter came back whole, and the difference has to be visible to whoever reads the report —
 * including the grader, whose message list includes it. This is where "volume 02's chapters 4 and 5
 * were thin" stops being something only the run log knows.
 *
 * **It reports the chapter's whole reading history, not just this pass.** A partial carries every paid
 * read it took, and a re-run reuses the partial and pays for nothing — so a report triggered only by what
 * *this* pass paid for goes quiet exactly when the volume is re-run after the damage was already paid for.
 * Measured on the real volume 02 on 2026-10-12: after its two cut-off chapters were re-read and the stage
 * ran again, every chapter was reused, `paidReads` was 0 for all seven, and the block vanished from
 * `character-voice-validation.md` — the grader was shown a reference whose most expensive chapters had
 * each taken two reads, with nothing in its materials saying so. The trigger is therefore the number of
 * paid reads **recorded on the chapter**, whoever paid for them.
 *
 * @param {Array<{id: string, entries?: Array<Object>, claims?: number, reused?: boolean, paidReads?: number, incomplete?: boolean, cutOff?: boolean, attempts?: Array<Object>}>} chapters
 * @param {{volume: string|number}} opts
 * @returns {string} A markdown block, or "" when every chapter came back whole on its first paid read.
 */
function readingReport(chapters, { volume }) {
  const rows = chapters.map((chapter) => {
    const claims = chapter.entries ? chapter.entries.length : chapter.claims;
    const attempts = chapter.attempts && chapter.attempts.length ? chapter.attempts : [];
    const levels = attempts.map((a) => `${a.thinkingLevel || "run default"}: ${a.claims}${a.cutOff ? " (cut off)" : ""}`).join(", ");
    return {
      id: chapter.id,
      claims,
      reused: Boolean(chapter.reused),
      paidReads: chapter.paidReads === undefined ? attempts.length : chapter.paidReads,
      // What the chapter cost in total, across every pass that touched it. A reused partial carries the
      // attempts of the pass that paid for them, and that is the number the report has to answer with.
      reads: attempts.length,
      incomplete: Boolean(chapter.incomplete || chapter.cutOff),
      levels: levels || (chapter.reused ? "reused from a complete partial" : "—"),
    };
  });
  const incomplete = rows.filter((r) => r.incomplete);
  const retried = rows.filter((r) => r.reads > 1);
  if (!incomplete.length && !retried.length) return "";

  const out = [
    "## How this volume was read",
    "",
    `_Every chapter of this volume was read on its own. A chapter whose answer never reached its closing bracket was cut off — half an answer, with the rest unwritten — and was re-read once at the retry level named in its row below. ${incomplete.length ? "The chapters still cut off after both paid reads are named below." : "No chapter was still cut off after its re-read."}_`,
    "",
    "| chapter | claims kept | paid reads | how it was read |",
    "| --- | --- | --- | --- |",
  ];
  for (const row of rows) {
    out.push(`| ${row.id} | ${row.claims} | ${row.reads}${row.reused ? " (reused — paid for in an earlier pass)" : ""} | ${row.levels}${row.incomplete ? " — **INCOMPLETE**" : ""} |`);
  }
  out.push("");
  if (incomplete.length) {
    out.push(
      `**${incomplete.length} of ${rows.length} chapter(s) are incomplete**: ${incomplete.map((r) => r.id).join(", ")}. ` +
        "Their claims are in the reference; whatever their answers never got to writing is not, and nothing here can tell you what that was."
    );
  } else {
    out.push(`All ${rows.length} chapter(s) came back whole.`);
  }
  out.push("");
  return out.join("\n");
}

module.exports = {
  EXTRACTION_FILE,
  PARTIAL_PREFIX,
  PARTIAL_SCHEMA,
  MAX_ATTEMPTS_PER_CHAPTER,
  EXTRACTION_RETRY_THINKING_LEVEL,
  partialPath,
  segmentFingerprint,
  readPartial,
  writePartial,
  consolidateExtraction,
  scanTopLevelObjects,
  parseExtractionAnswer,
  readOneChapter,
  readVolumeChapters,
  readingReport,
};
