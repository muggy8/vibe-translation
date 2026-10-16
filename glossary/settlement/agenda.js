/**
 * glossary/settlement/agenda.js — which terms the settlement pass is allowed to ask about, and how
 * many of them one run may pay for.
 *
 * The settlement pass is the one place the pipeline asks, AFTER the whole series has been read,
 * whether the rendering the series settled on is still the right one. The question is worth paying
 * for in exactly two situations, and both are facts the record already holds:
 *
 *   1. **The record has already changed this term's rendering once.** A term whose supersede chain
 *      has more than one row is a term somebody has already decided twice. It is the cheapest
 *      possible signal, and it needs no judgement at all: `row.superseded.length > 0`.
 *   2. **The row's own note points at something the book has not said yet.** "revealed later",
 *      "will be explained", "in later chapters", "turns out to be". A note like that is the record
 *      admitting its own rendering was chosen before the reveal, and the reveal has now happened —
 *      the whole series has been read, and this pass runs after it.
 *
 * ## Why the agenda is a query and never a model's shortlist
 *
 * The alternative is "give the model the glossary and ask which terms look suspicious". That is a
 * model deciding what the pipeline is allowed to spend money on, and it is not reproducible: two
 * runs would ask about different terms and no audit could tell whether the difference was a real
 * difference in the books or a different roll of the dice. Every input to this module is a row of
 * the settled record, so the same record always produces the same agenda — which is also what makes
 * the bound provable offline and what makes "a second pass over the same agenda costs 0 calls"
 * testable rather than aspirational.
 *
 * ## What the shape list was measured against, and what it gets wrong
 *
 * The 15 shipped shapes were first run over the **5,392 data rows** of the previous run's 17 published
 * glossary files (read-only copies from the tag `pre-extraction-fix-2026-10-12`). They fired on
 * **59 rows / 8 distinct terms**; the chain half added 2, and the two halves did not overlap, so the
 * agenda for that whole series was **10 terms** — the number gotcha 144 records.
 *
 * **Re-measured 2026-10-15 against the settled reference record the corpus actually holds** (a copy of
 * volume 17's, 1,028 published rows, through `test/measure-settlement-agenda.js`, 0 model calls). The
 * agenda for the same series is **18 terms**: **9** from the chain half and **10** from the forward half,
 * 0 overlap. The forward half is the same **10 terms** the original measurement found, which is the point
 * — the row count moved 5,392 → 1,028 and the forward agenda did not. What moved is **which shapes fire:
 * 5 of the 15**, and the other 10 fire on 0 rows.** The 15 are not wrong; most of them describe notes
 * this particular series never wrote. They stay, because the half that does fire is load-bearing and
 * removing the idle ten would cut the agenda from 18 terms to 9.
 *
 * The re-measurement also found the thing the original one could not see, and it is the reason the text
 * half is now reported as a **coverage** rather than a count: the shipped vocabulary is written in
 * **one script** (`vocabularyScripts()` returns exactly one name), and a notes cell written in any other
 * script is invisible to every one of the fifteen patterns. Across all 17 records' **11,219** published
 * rows today, **100%** of the notes the agenda reads are in that one script — so the shipped half and
 * this corpus's notes agree, and the hazard is the state **after** the prompt change that asks the
 * extraction to write its notes in the book's own language. See {@link forwardRuleCoverage}.
 *
 * Two shapes were measured and **dropped**, because they fired on legitimate rows:
 *   - `true-or-hidden-nature` — 僕／俺（一人称）, 如月茉莉花, 純情可憐ＧＩＲＬ. Those notes state the
 *     hidden thing; they do not point at a later reveal.
 *   - `deliberately-withheld` — スタバ, 超有名遊園地, 一人目の図書委員, 後輩マネージャー. A note that
 *     says the book keeps a detail vague is a fact about the book, not a promise about volume 9.
 * Together they fired on 46 rows / 7 distinct terms, none of them a term a later reveal re-renders.
 * They are kept here as a named list rather than deleted, because a shape list nobody can see is a
 * shape list somebody adds the dropped one back to.
 *
 * The known **false negatives** are named too, because they are the honest half of the measurement:
 * a note that says a reveal happened without using any of these words ("its name is given in the
 * third volume's final chapter" would match, "the third volume names her" would not). The list is
 * deliberately narrow for the same reason `researchable.js`'s is: the loose version of every one of
 * these patterns fires on ordinary rows, and a rule that cries on correct behaviour gets switched
 * off.
 *
 * The narrowness has a second half now. A narrow vocabulary in **one script** is narrow twice: it misses
 * the phrasings it does not hold, and it misses every note not written in the script its own phrases are
 * written in. The answer is not a wider pattern list — that is the loose version again — it is the
 * series' **own declared markers** (`glossary/settlement/declaration.js`), literal phrases the plan of
 * record says mean "more comes later" here. They are matched as text, never compiled, and this module
 * holds none of them.
 *
 * @module glossary/settlement/agenda
 */

require("../../types"); // JSDoc type definitions
const { structuralError } = require("../../configs/shared");
const {
  publishedGlossaryRowsInRecord,
  researchNotesInRecord,
  mergeResearchNotes,
} = require("../../utils/reference-store");

// ─── The bound ────────────────────────────────────────────────────────────────

/**
 * How many terms one settlement pass may pay a reading call for, at most.
 *
 * A constant with no environment knob, for the reason AGENTS.md rule 3 gives for every guard in this
 * repository: a number a run can raise is a number a run will raise.
 *
 * Chosen from the measurement in this module's header: the previous run's 17-volume series produced an
 * agenda of **10** terms, and the same series re-measured against the settled record it holds today
 * produces **18** (9 chain + 10 forward). 24 sits above the largest agenda this series has produced by
 * either measurement, and at the 3,962 mean prompt tokens a bounded tool-less call measured at, the whole
 * bound is ≈ 95,000 prompt tokens for a series — against one volume's 1,141,844-token reading pass.
 * Pinned by `test/test-glossary-settlement.js`, which also pins that a run cut by the bound NAMES what it
 * cut. The number is **not** raised to 18: a bound set at the largest agenda measured so far is a bound
 * that moves every time a series writes more notes, which is the shape of a knob.
 *
 * @type {number}
 */
const SETTLEMENT_MAX_TERMS_PER_RUN = 24;

// ─── The shapes ───────────────────────────────────────────────────────────────

/**
 * The closed set of note shapes that say "this row's meaning is not settled yet — a later part of
 * the series says more".
 *
 * Each one is named so the decision log can say WHICH shape fired. Narrow on purpose: the loose
 * versions were measured against the real corpus and rejected (see this module's header).
 *
 * @type {Array<{name: string, re: RegExp, why: string}>}
 */
const FORWARD_REVEAL_SHAPES = [
  {
    name: "reveal-then-later",
    re: /\b(?:revealed|reveals|explained|clarified|identified|settled|named|given)\b[^.;]{0,40}\b(?:later|eventually|finally|afterwards)\b/i,
    why: 'a note that says the thing is revealed later ("its identity is revealed in a later volume")',
  },
  {
    name: "later-then-reveal",
    re: /\b(?:later|eventually|finally|afterwards|subsequently)\b[^.;]{0,40}\b(?:revealed|reveals|explained|named|identified|given|declared|introduced)\b/i,
    why: 'the same promise with the two halves swapped ("later revealed to be")',
  },
  {
    name: "will-be-explained",
    re: /\bwill be (?:explained|revealed|clarified|made clear|answered)\b/i,
    why: "a note that puts the explanation in the future tense",
  },
  {
    name: "to-be-revealed",
    re: /\b(?:to be|yet to be) (?:revealed|explained|named|identified|settled)\b/i,
    why: 'the infinitive form of the same promise ("yet to be named")',
  },
  {
    name: "in-later-chapters",
    re: /\bin later (?:chapters?|volumes?|instalments?|arc)/i,
    why: "the note names a later part of the series as where the answer is",
  },
  {
    name: "future-volume",
    re: /\bfuture (?:volume|chapters?|instalment)/i,
    why: 'the same pointer in the other direction ("a future volume clarifies")',
  },
  {
    name: "unless-a-later-volume",
    re: /\bunless a later volume\b/i,
    why: "the note makes its own rendering conditional on a volume that has now been read",
  },
  {
    name: "track-for-consistency",
    re: /\btrack(?:s|ing|ed)?[^.;]{0,30}for consistency/i,
    why: "the note is watching for a later statement, which is the shape a pre-reveal rendering takes",
  },
  {
    name: "foreshadow",
    re: /\bforeshadow/i,
    why: "the note calls the row foreshadowing, which means the payoff is elsewhere",
  },
  {
    name: "real-name-given",
    re: /\breal name is (?:finally |now |at last )?(?:given|revealed|supplied|provided)\b/i,
    why: "the note says a real name is now supplied, which is exactly when a rendering changes",
  },
  {
    name: "turns-out-to-be",
    re: /\bturn(?:s|ed)? out to be\b/i,
    why: 'the reveal idiom itself ("turns out to be the same person")',
  },
  {
    name: "until-that-reveal",
    re: /\buntil (?:that|the|its) reveal\b/i,
    why: "the note marks its own row as standing only until the reveal",
  },
  {
    name: "confirm-later",
    re: /\bconfirm(?:s|ed|ing)?[^.;]{0,45}\blater\b/i,
    why: "the note is waiting for a later confirmation",
  },
  {
    name: "not-named-later",
    re: /\bnot (?:yet )?(?:named|stated|explained|revealed|identified|settled|confirmed)\b[^.;]{0,45}\b(?:later|yet|to be|until|finally|confirm)\b/i,
    why: 'the negative form ("not yet named; later volumes may supply it")',
  },
  {
    name: "recontextualise",
    re: /\brecontextual/i,
    why: "the note says the row's meaning is recontextualised, which is what a reveal does to a rendering",
  },
];

/**
 * The shapes that were measured against the real corpus and **rejected**, kept with the note that
 * made each one wrong so nobody re-adds them.
 *
 * @type {Array<{name: string, re: RegExp, firedOn: string[], because: string}>}
 */
const DROPPED_SHAPES = [
  {
    name: "true-or-hidden-nature",
    re: /\b(?:true|hidden) (?:nature|identity|self|meaning|name)\b/i,
    firedOn: ["僕／俺（一人称）", "如月茉莉花", "純情可憐ＧＩＲＬ"],
    because:
      "these notes STATE the hidden thing. \"Her true name is 如月茉莉花\" is a settled fact in the row, " +
      "not a pointer at a volume that has not been read yet, and the rendering is already correct.",
  },
  {
    name: "deliberately-withheld",
    re: /\bdeliberately (?:withheld|unexplained|unnamed|ambiguous|vague)\b/i,
    firedOn: ["スタバ", "超有名遊園地", "一人目の図書委員", "後輩マネージャー"],
    because:
      "a note saying the book keeps a detail vague is a description of the book. None of these four is " +
      "a term a later volume names, and three of them are joke renderings the series never resolves.",
  },
];

// ─── The scripts, and what the shipped vocabulary can actually read ────────────

/**
 * The scripts the coverage check can tell apart, by Unicode range.
 *
 * These are **script** names, not language names: the check answers "which writing system are these
 * letters from", which is the only question the coverage line asks. It never claims that a script belongs
 * to a language, and it never decides what a note means.
 *
 * @type {Array<{name: string, from: number, to: number}>}
 */
const SCRIPT_RANGES = [
  { name: "Han", from: 0x3400, to: 0x4dbf },
  { name: "Han", from: 0x4e00, to: 0x9fff },
  { name: "Han", from: 0xf900, to: 0xfaff },
  { name: "Hiragana", from: 0x3040, to: 0x309f },
  { name: "Katakana", from: 0x30a0, to: 0x30ff },
  { name: "HalfwidthKana", from: 0xff66, to: 0xff9f },
  { name: "Hangul", from: 0x1100, to: 0x11ff },
  { name: "Hangul", from: 0x3130, to: 0x318f },
  { name: "Hangul", from: 0xac00, to: 0xd7af },
  { name: "Cyrillic", from: 0x0400, to: 0x04ff },
  { name: "Greek", from: 0x0370, to: 0x03ff },
  { name: "Arabic", from: 0x0600, to: 0x06ff },
  { name: "Hebrew", from: 0x0590, to: 0x05ff },
  { name: "Devanagari", from: 0x0900, to: 0x097f },
  { name: "Thai", from: 0x0e00, to: 0x0e7f },
  { name: "Latin", from: 0x0041, to: 0x005a },
  { name: "Latin", from: 0x0061, to: 0x007a },
  { name: "Latin", from: 0x00c0, to: 0x024f },
];

/**
 * The script of one character, or null when it is a digit, a space or a piece of punctuation.
 *
 * @param {string} character - One code point.
 * @returns {string|null}
 */
function scriptOfCharacter(character) {
  const code = character.codePointAt(0);
  for (const range of SCRIPT_RANGES) {
    if (code >= range.from && code <= range.to) return range.name;
  }
  return null;
}

/**
 * How many letters of each script one string holds.
 *
 * @param {string} text
 * @returns {Map<string, number>} script → letter count
 */
function scriptCountsOf(text) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const character of String(text || "")) {
    const script = scriptOfCharacter(character);
    if (!script) continue;
    counts.set(script, (counts.get(script) || 0) + 1);
  }
  return counts;
}

/**
 * The script a string is **written in**: the one its letters mostly come from.
 *
 * `none` when the string holds no letters at all. A notes cell that mixes scripts — a remark written in
 * one language that quotes a word from another — is answered by the majority, which is what "written in"
 * means for a sentence.
 *
 * @param {string} text
 * @returns {string}
 */
function dominantScriptOf(text) {
  let best = "none";
  let bestCount = 0;
  for (const [script, count] of scriptCountsOf(text)) {
    if (count > bestCount) {
      best = script;
      bestCount = count;
    }
  }
  return best;
}

/**
 * The scripts the shipped vocabulary is itself written in, derived from the shapes rather than declared.
 *
 * Derived, not stated, because a stated list is a claim somebody could edit into covering more than it
 * covers. The literal letters inside the fifteen patterns are the vocabulary; whatever scripts those
 * letters are in is what the patterns can match. Today that is one script, and the point of the number
 * is not which one — it is that the number is **one**, while the notes a series writes are not.
 *
 * @returns {string[]} Sorted script names.
 */
function vocabularyScripts() {
  /** @type {Set<string>} */
  const scripts = new Set();
  for (const shape of FORWARD_REVEAL_SHAPES) {
    for (const character of shape.re.source) {
      const script = scriptOfCharacter(character);
      if (script) scripts.add(script);
    }
  }
  return [...scripts].sort();
}

// ─── The coverage of the text half ────────────────────────────────────────────

/**
 * The four states the text half of the agenda can be in.
 *
 * `covered` and `blind` are the two that matter, and the whole point of naming them is that **an empty
 * agenda in the `blind` state is not a finding that the series has nothing to settle**. Plan 07 §4.8.
 *
 * @type {string[]}
 */
const FORWARD_RULE_STATES = ["covered", "partially-blind", "blind", "no-notes"];

/**
 * What the text half of the agenda could actually read, and what it therefore cannot claim.
 *
 * The chain half of the agenda (`row.supersedes`) is a fact about the record and needs no words from any
 * language. The forward half is a vocabulary, and a vocabulary covers the scripts its own phrases are
 * written in and nothing else. This is the number that separates "no note points forward" from "the
 * phrases we can match are not written in the language these notes are written in" — which is the
 * distinction plan 07 §4.8 says this pass must not lose, because the second one looks exactly like the
 * first in a log that prints only a count.
 *
 * It reports. It does not refuse, and it does not become a finding: a series whose plan of record predates
 * the declared-marker block is a series with a documentation gap, and failing its glossary step for that
 * would turn a gap into a broken run.
 *
 * @param {Object} measured
 * @param {number} measured.notesRead - Published rows with a non-empty notes cell.
 * @param {number} measured.notesOutsideVocabulary - Notes whose dominant script the shipped vocabulary is not written in.
 * @param {number} measured.notesWithNoLetters - Notes that hold no letters at all (a citation, a bare term).
 * @param {Array<{term: string, script: string}>} measured.outsideExamples - Up to five of them, named.
 * @param {number} measured.rowsFiredByShapes - Rows the shipped shapes fired on.
 * @param {number} measured.rowsFiredByMarkers - Rows a declared marker fired on.
 * @param {Map<string, number>} measured.markerFirings - Declared marker → rows it fired on.
 * @param {Array<{phrase: string}>} measured.markers - The declared markers in force.
 * @param {string[]} measured.vocabulary - The scripts the shipped vocabulary is written in.
 * @param {number} measured.forwardCount - Agenda items the forward half produced.
 * @returns {{state: string, askable: boolean, vocabularyScripts: string[], notesRead: number, notesOutsideVocabulary: number, notesWithNoLetters: number, outsideExamples: Array<{term: string, script: string}>, markerCount: number, markersThatFiredOnNothing: string[], rowsFiredByShapes: number, rowsFiredByMarkers: number, because: string}}
 */
function forwardRuleCoverage({
  notesRead,
  notesOutsideVocabulary,
  notesWithNoLetters,
  outsideExamples,
  rowsFiredByShapes,
  rowsFiredByMarkers,
  markerFirings,
  markers,
  vocabulary,
  forwardCount,
}) {
  const markersThatFiredOnNothing = [...markerFirings.entries()].filter(([, rows]) => rows === 0).map(([phrase]) => phrase);
  let state = "covered";
  if (notesRead === 0) state = "no-notes";
  else if (notesOutsideVocabulary === 0) state = "covered";
  else if (notesOutsideVocabulary >= notesRead - notesWithNoLetters) state = "blind";
  else state = "partially-blind";

  const askable = state === "covered" || state === "no-notes" || markers.length > 0;

  let because;
  if (state === "no-notes") {
    because =
      "the settled record publishes no notes at all, so the forward half of the agenda had nothing to read. " +
      "That is a fact about this record, not a vocabulary problem.";
  } else if (state === "covered") {
    because =
      `every one of the ${notesRead} note(s) the agenda read is written in a script the shipped vocabulary is ` +
      `written in (${vocabulary.join(", ")}), so "${forwardCount} term(s) point forward" is an answer and not a blind spot.`;
  } else if (state === "blind") {
    because =
      `every one of the ${notesRead} note(s) the agenda read is written in a script the shipped vocabulary is ` +
      `NOT written in — the vocabulary is ${vocabulary.join(", ")}, the notes are not — so the forward half of ` +
      `this agenda could not be asked. ${forwardCount === 0 ? "It found nothing, and that is NOT a finding that this series has nothing to settle." : `It found ${forwardCount}, and that is a floor, not a count.`}` +
      (markers.length
        ? ` ${markers.length} declared marker(s) were matched as literal text over all ${notesRead} note(s), and ${rowsFiredByMarkers} row(s) came from that half.`
        : " No markers are declared for this series, so nothing else was matched.");
  } else {
    because =
      `${notesOutsideVocabulary} of the ${notesRead} note(s) the agenda read are written in a script the shipped ` +
      `vocabulary is not written in (${vocabulary.join(", ")}), so the forward half is a floor rather than a count: ` +
      `it read ${notesRead - notesOutsideVocabulary - notesWithNoLetters} and could not read ${notesOutsideVocabulary}.` +
      (markers.length ? ` ${markers.length} declared marker(s) were matched over all of them.` : " No markers are declared for this series.");
  }
  if (markers.length && markersThatFiredOnNothing.length === markers.length && state !== "no-notes") {
    because += ` Every declared marker fired on 0 rows — the declared vocabulary does not match what this record's notes actually say.`;
  }

  return {
    state,
    askable,
    vocabularyScripts: vocabulary,
    notesRead,
    notesOutsideVocabulary,
    notesWithNoLetters,
    outsideExamples,
    markerCount: markers.length,
    markersThatFiredOnNothing,
    rowsFiredByShapes,
    rowsFiredByMarkers,
    because,
  };
}

// ─── The declared markers ─────────────────────────────────────────────────────
/**
 * The declared markers whose literal text appears in one notes cell.
 *
 * Matched as a **substring**, case-insensitively, never as a pattern: a marker is a phrase a series wrote
 * into its plan of record, and a phrase that can execute is a defect waiting to happen.
 *
 * @param {string} notes - A glossary row's notes cell, as the published file prints it.
 * @param {Array<{phrase: string}>} [markers] - The series' declared markers. Empty or absent means none.
 * @returns {string[]} The declared phrases that fired, in declaration order, no duplicates.
 */
function firedForwardMarkers(notes, markers = []) {
  const text = String(notes || "").toLowerCase();
  /** @type {string[]} */
  const hits = [];
  for (const marker of Array.isArray(markers) ? markers : []) {
    const phrase = String((marker && marker.phrase) || "").trim();
    if (!phrase) continue;
    if (text.includes(phrase.toLowerCase()) && !hits.includes(phrase)) hits.push(phrase);
  }
  return hits;
}

// ─── The classifier ───────────────────────────────────────────────────────────

/**
 * The names of the forward shapes that fire on one notes cell.
 *
 * @param {string} notes - A glossary row's notes cell, as the published file prints it.
 * @returns {string[]} The shape names that matched, in list order.
 */
function firedForwardShapes(notes) {
  const text = String(notes || "");
  const hits = [];
  for (const shape of FORWARD_REVEAL_SHAPES) {
    if (shape.re.test(text)) hits.push(shape.name);
  }
  return hits;
}

/**
 * The notes cell the published file actually prints for a row.
 *
 * The agenda has to be asked of the same text a reader sees. `publishedGlossaryRowsInRecord` returns
 * the row's own `body`, and the render adds the research notes filed against the term on top of it —
 * so a forward pointer that arrived through a research note would be invisible to an agenda that read
 * only the body. This is the render's own merge, reused rather than a second version of it.
 *
 * @param {{notes?: string, term: string}} row
 * @param {Map<string, Array<Object>>} notesByTerm - Research notes in the record, keyed by term.
 * @returns {string}
 */
function printedNotesCell(row, notesByTerm) {
  const key = String(row.term || "").trim();
  return mergeResearchNotes(String(row.notes || ""), notesByTerm.get(key) || []);
}

/**
 * The research notes of a record, keyed by term — the same join `renderGlossary` makes.
 *
 * @param {{db: Object, volume: number}} store - The settled record, opened read-only.
 * @returns {Map<string, Array<Object>>}
 */
function researchNotesByTerm(store) {
  /** @type {Map<string, Array<Object>>} */
  const byTerm = new Map();
  for (const note of researchNotesInRecord(store)) {
    const key = String(note.term || "").trim();
    if (!key) continue;
    if (!byTerm.has(key)) byTerm.set(key, []);
    byTerm.get(key).push(note);
  }
  return byTerm;
}

/**
 * One settled row, read as a settlement candidate.
 *
 * `flaggingVolume` is the volume the decision has to be filed into, and it is not a free choice: the
 * revision door only accepts a quote from the record of the volume whose scope the handle carries, so
 * the flagging volume is the volume that OWNS the row in force — the one whose book the rendering was
 * last chosen from.
 *
 * The forward half of the decision has **two** vocabularies and this is where they are both asked: the
 * shipped English shapes, and the phrases this series declared in its own plan of record. The declared
 * ones are matched as literal text and the shipped ones as patterns, and neither is allowed to stand for
 * the other — a row that only a declared marker fired on is a row the shipped vocabulary could not read,
 * which is the fact the coverage line is built to keep visible.
 *
 * @param {Object} row - One {@link publishedGlossaryRowsInRecord} entry.
 * @param {Map<string, Array<Object>>} notesByTerm
 * @param {Array<{phrase: string, because?: string|null}>} [markers] - The series' declared markers.
 * @returns {{term: string, rendering: string, notes: string, noteScript: string, section: string|null, flaggingVolume: number, chain: boolean, supersededFromVolumes: number[], shapes: string[], markers: string[], because: string, ord: number}}
 *   `noteScript` is the script the notes cell is **written in** — the number the coverage check counts.
 */
function classifyRow(row, notesByTerm, markers = []) {
  const notes = printedNotesCell(row, notesByTerm);
  const shapes = firedForwardShapes(notes);
  const markerHits = firedForwardMarkers(notes, markers);
  const chain = Array.isArray(row.superseded) && row.superseded.length > 0;
  const pointed = [...shapes, ...markerHits.map((phrase) => `declared:${phrase}`)];
  const because =
    chain && pointed.length
      ? `its rendering has already been replaced ${row.superseded.length} time(s), and its own note points forward (${pointed.join(", ")})`
      : chain
        ? `its rendering has already been replaced ${row.superseded.length} time(s) — the series has already decided this term more than once`
        : pointed.length
          ? `its own note points at something the book had not said yet (${pointed.join(", ")})`
          : "neither its chain nor its note points past the volume that wrote it";
  return {
    term: String(row.term || "").trim(),
    rendering: String(row.rendering || "").trim(),
    notes,
    noteScript: dominantScriptOf(notes),
    section: row.section || null,
    flaggingVolume: Number(row.ownerVolume),
    chain,
    supersededFromVolumes: (Array.isArray(row.superseded) ? row.superseded : []).map((r) => Number(r.appliesFromVolume)),
    shapes,
    markers: markerHits,
    because,
    ord: Number(row.ord),
  };
}

// ─── The agenda ───────────────────────────────────────────────────────────────

/**
 * The settlement agenda for one series: the terms the settled record itself says are worth asking
 * about, cut to the bound.
 *
 * Deterministic by construction. The rows come from one query over the settled record, the order is
 * that query's own render order (`ord`, then `id`), a term appears once, and the cut is a prefix — so
 * the same record always produces the same agenda and always names the same terms it threw away.
 *
 * @param {{db: Object, volume: number}} settled - The settled record, opened read-only.
 * @param {{limit?: number, forwardMarkers?: Array<{phrase: string, because?: string|null}>}} [opts]
 *   `limit` overrides the bound for a measurement; a run never passes it. `forwardMarkers` is the
 *   series' own declared vocabulary — the phrases that mean "more comes later" in the language this
 *   series writes its notes in. It is **data the caller supplies**, never a list this module holds.
 * @returns {{agenda: Array<Object>, skipped: Array<Object>, candidateCount: number, chainCount: number, forwardCount: number, markerCount: number, limit: number, capped: boolean, textRule: Object}}
 *   `agenda` is what the pass may pay for; `skipped` is what the bound cut, named, with the reason it
 *   was a candidate in the first place. `textRule` is the coverage of the text half — see
 *   {@link forwardRuleCoverage}.
 * @throws {Error} A structural refusal (`settlement-agenda-has-no-record`) when the caller hands this
 *   query no record to query. An agenda that cannot be read is NOT an empty agenda: an empty agenda means
 *   "this series has nothing to settle", and that is the one answer that lets the pass publish a settled
 *   glossary it never settled and let the freeze gate report `settlement-no-change` for an act that read
 *   nothing. The refusal is structural so `ON_TASK_ERROR=continue` cannot walk past it.
 */
function settlementAgenda(settled, { limit = SETTLEMENT_MAX_TERMS_PER_RUN, forwardMarkers = [] } = {}) {
  if (!settled || !settled.db || typeof settled.db.prepare !== "function") {
    throw structuralError(
      "[glossary-settlement] settlement-agenda-has-no-record: the settlement agenda is a query over the " +
        "settled reference record, and it was handed no record to query. An agenda that cannot be read is " +
        "not an empty agenda — reporting \"nothing to settle\" for a record nobody opened is how this pass " +
        "would publish a settled glossary it never settled."
    );
  }
  const volume = Number(settled.volume);
  const rows = publishedGlossaryRowsInRecord(settled, { volume });
  const notesByTerm = researchNotesByTerm(settled);
  const markers = (Array.isArray(forwardMarkers) ? forwardMarkers : []).filter(
    (marker) => marker && typeof marker.phrase === "string" && marker.phrase.trim() !== ""
  );

  /** @type {Map<string, Object>} */
  const candidates = new Map();
  /** @type {Map<string, number>} */
  const markerFirings = new Map();
  for (const marker of markers) markerFirings.set(String(marker.phrase).trim(), 0);
  let notesRead = 0;
  let notesOutsideVocabulary = 0;
  let notesWithNoLetters = 0;
  /** @type {Array<{term: string, script: string}>} */
  const outsideExamples = [];
  let rowsFiredByShapes = 0;
  let rowsFiredByMarkers = 0;
  const vocabulary = vocabularyScripts();

  for (const row of rows) {
    const item = classifyRow(row, notesByTerm, markers);
    if (!item.term) continue;
    if (item.notes.trim() !== "") {
      notesRead += 1;
      if (item.noteScript === "none") notesWithNoLetters += 1;
      else if (!vocabulary.includes(item.noteScript)) {
        notesOutsideVocabulary += 1;
        if (outsideExamples.length < 5) outsideExamples.push({ term: item.term, script: item.noteScript });
      }
    }
    if (item.shapes.length > 0) rowsFiredByShapes += 1;
    if (item.markers.length > 0) rowsFiredByMarkers += 1;
    for (const phrase of item.markers) markerFirings.set(phrase, (markerFirings.get(phrase) || 0) + 1);
    if (!item.chain && item.shapes.length === 0 && item.markers.length === 0) continue;
    if (!Number.isInteger(item.flaggingVolume)) continue;
    if (!candidates.has(item.term)) candidates.set(item.term, item);
  }

  const ordered = [...candidates.values()];
  const chainCount = ordered.filter((item) => item.chain).length;
  const forwardCount = ordered.filter((item) => item.shapes.length > 0 || item.markers.length > 0).length;
  return {
    agenda: ordered.slice(0, limit),
    skipped: ordered.slice(limit),
    candidateCount: ordered.length,
    chainCount,
    forwardCount,
    markerCount: markers.length,
    limit,
    capped: ordered.length > limit,
    textRule: forwardRuleCoverage({
      notesRead,
      notesOutsideVocabulary,
      notesWithNoLetters,
      outsideExamples,
      rowsFiredByShapes,
      rowsFiredByMarkers,
      markerFirings,
      markers,
      vocabulary,
      forwardCount,
    }),
  };
}

module.exports = {
  SETTLEMENT_MAX_TERMS_PER_RUN,
  FORWARD_REVEAL_SHAPES,
  DROPPED_SHAPES,
  SCRIPT_RANGES,
  FORWARD_RULE_STATES,
  scriptOfCharacter,
  scriptCountsOf,
  dominantScriptOf,
  vocabularyScripts,
  forwardRuleCoverage,
  firedForwardMarkers,
  firedForwardShapes,
  printedNotesCell,
  researchNotesByTerm,
  classifyRow,
  settlementAgenda,
};
