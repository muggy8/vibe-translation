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
 * @module utils/reference-store/attribution
 */

const path = require("path");

const { readChapterLines } = require("./source-chapters");
const { namesForEntry, presenceMeasured } = require("./presence");
const { verifyEvidence, SKELETON_MIN_CHARS } = require("./evidence");
const { refusal } = require("./refusals");
const { ATTRIBUTION_ANSWERS, isInVocabulary } = require("./schema");
const { NARRATOR, isNarratorAnswer, narratorRosterKeyRefusal } = require("./narrator");
const { finding } = require("../postmortem");
// `facts.js` does not require this file, so this edge does not close a cycle (gotcha 85).
const { challengeFact, isVolumeSealed } = require("./facts");
require("../../types"); // JSDoc type definitions

/** The step name the findings are filed under. */
const ATTRIBUTION_STEP = "reference-attribution";

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
 * The opening marks this book uses for a line of dialogue.
 *
 * Kept here rather than inferred from the evidence matcher: the store's quote rules have to match a
 * quote anywhere in a line, while this question is about what the **line itself** is — a line someone
 * is saying, or a line about what is happening.
 *
 * @type {string[]}
 */
const DIALOGUE_OPENERS = ["「", "『", "“", "‘"];

/**
 * Whether a source line is somebody speaking, or narration.
 *
 * The whole rule is the first non-space character. It is coarse on purpose: a line that opens with a
 * bracket is a line the book is presenting as speech, and a line that does not is the narrator's,
 * even when it contains a quoted phrase inside it. Measured against the two real records this
 * classifies 268/574 of volume 01's claims and 488/1030 of volume 02's as quoting a spoken line.
 * That split is printed in the audit report as a fact about the record, and it is **not** a doubt
 * trigger: a claim about how a character speaks routinely cites the narration that describes them,
 * and calling that a misattribution would report half the reference as damaged.
 *
 * @param {string} line
 * @returns {"dialogue"|"narration"}
 */
function lineSpeechKind(line) {
  const text = String(line === undefined || line === null ? "" : line).trimStart();
  return DIALOGUE_OPENERS.some((mark) => text.startsWith(mark)) ? "dialogue" : "narration";
}

/**
 * The Han characters of a name, in order.
 * @param {string} name
 * @returns {string[]}
 */
function hanCharacters(name) {
  return [...String(name || "")].filter((ch) => /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/.test(ch));
}

/**
 * Whether a stretch of text is only reading aids: kana, the long-vowel mark, a repeated-name mark.
 * @param {string} text
 * @returns {boolean}
 */
function onlyReadingAids(text) {
  return /^[\u3041-\u3096\u30A1-\u30FA\u30FC\u3005\u3099-\u309E\u30FD\u30FEー]+$/.test(text);
}

/**
 * The most reading aid this probe is willing to sit between two kanji.
 *
 * 蒲かま田 needs 2. 如月きさらぎ needs 4. Past this the "name" being found is a sentence that happens
 * to contain the right kanji in the right order, which is not a name and not a measurement.
 *
 * @type {number}
 */
const READING_AID_MAX_GAP = 4;

/**
 * Find one name in one line when the book has written its reading aids between its kanji.
 *
 * @param {string} line
 * @param {string[]} kanji - The name's Han characters, in order.
 * @returns {{span: string, gap: number}|null}
 */
function readingAidSpan(line, kanji) {
  if (kanji.length < 2) return null;
  const text = String(line || "").replace(/\s+/g, "");
  let at = 0;
  let start = -1;
  let gap = 0;
  let maxGap = 0;
  for (let h = 0; h < kanji.length; h += 1) {
    const idx = text.indexOf(kanji[h], at);
    if (idx < 0) return null;
    if (h === 0) start = idx;
    else {
      const between = text.slice(at, idx);
      if (between.length > READING_AID_MAX_GAP) return null;
      if (between.length > 0 && !onlyReadingAids(between)) return null;
      if (between.length > maxGap) maxGap = between.length;
    }
    at = idx + 1;
  }
  return { span: text.slice(start, at), gap: maxGap };
}

/**
 * Read one volume's chapters into lines, through the store's own volume resolver.
 *
 * @param {{resolveVolume: Function}} ctx
 * @param {number} volume
 * @returns {{chapters: Array<{id: string, lines: string[]}>, error: string|null}}
 */
function volumeChapterLines(ctx, volume) {
  const resolved = ctx.resolveVolume(Number(volume));
  if (resolved.error) return { chapters: [], error: resolved.error };
  const out = [];
  for (const chapter of resolved.chapters) {
    const dir = resolved.volumeDir;
    const lines = readChapterLines(dir, chapter.file);
    if (!lines) continue;
    out.push({ id: chapter.id, file: chapter.file, lines });
  }
  return { chapters: out, error: out.length ? null : "no chapter file of this volume could be read" };
}

/**
 * The lines around a cited line, in the order they appear in the book.
 *
 * This is what the detective is shown, and it is bounded for the same reason the graded sample is
 * bounded: an agent that is handed a whole chapter reads a whole chapter, and the question "who is
 * speaking this line" is answered by the lines around it. `radius` is in lines, and the cited line is
 * marked so the answer can quote the passage it actually read.
 *
 * @param {{resolveVolume: Function}} ctx
 * @param {{volume: number, chapter: string, line: number, radius?: number}} opts
 * @returns {{chapter: string, line: number, speechKind: string, window: Array<{line: number, text: string, cited: boolean}>, error: string|null}}
 */
function speakerPassage(ctx, { volume, chapter, line, radius = 12 }) {
  const resolved = ctx.resolveVolume(Number(volume));
  if (resolved.error) return { chapter, line, speechKind: "unknown", window: [], error: resolved.error };
  const chapterRow = resolved.chapters.find((c) => c.id === chapter);
  if (!chapterRow) return { chapter, line, speechKind: "unknown", window: [], error: `chapter "${chapter}" is not in volume ${volume}` };
  const lines = readChapterLines(resolved.volumeDir, chapterRow.file) || [];
  const from = Math.max(0, Number(line) - 1 - radius);
  const to = Math.min(lines.length, Number(line) + radius);
  const window = [];
  for (let i = from; i < to; i += 1) {
    const text = lines[i];
    if (String(text || "").trim() === "") continue;
    window.push({ line: i + 1, text, cited: i + 1 === Number(line) });
  }
  const cited = lines[Number(line) - 1];
  return {
    chapter,
    line: Number(line),
    speechKind: lineSpeechKind(cited),
    window,
    error: null,
  };
}

/**
 * Whether this volume's own text contains a name when its reading aids are written between its kanji.
 *
 * The probe exists to explain an absence, not to overrule a measurement. Swept over every cast entry
 * in both real records: 1 hit out of the 4 entries measured absent (蒲田 → 「蒲かま田」 at ch3:1243),
 * 0 hits for the other 3, and it cannot say anything at all about a name with fewer than two kanji
 * (ジョージョエン・スカイウォーカー is katakana, so there is no kanji to order).
 *
 * @param {{resolveVolume: Function, db: Object}} ctx
 * @param {{volume: number, key: string}} opts
 * @returns {{found: boolean, hits: Array<{chapter: string, line: number, span: string, gap: number}>, names: string[], kanjiNames: string[], skipped: string[], error: string|null}}
 */
function namePrintedWithReadingAids(ctx, { volume, key }) {
  const entry = ctx.db.prepare("SELECT key, display, aliases, merged_into AS mergedInto FROM cast WHERE key = ?").get(key);
  if (!entry) return { found: false, hits: [], names: [], kanjiNames: [], skipped: [key], error: `no cast entry "${key}"` };
  // The same name list the presence measurement searches, from the same function: key plus the aliases
  // somebody declared, minus the aliases that are themselves merged entries. Two answers to "which
  // names is this character searched for" is how one of them drifts.
  const mergedKeys = new Set(ctx.db.prepare("SELECT key FROM cast WHERE merged_into IS NOT NULL").all().map((row) => row.key));
  const names = namesForEntry(entry, mergedKeys).map((row) => row.name);

  const read = volumeChapterLines(ctx, volume);
  if (read.error) return { found: false, hits: [], names, kanjiNames: [], skipped: [], error: read.error };

  /** @type {Array<{chapter: string, line: number, span: string, gap: number}>} */
  const hits = [];
  /** @type {string[]} */
  const kanjiNames = [];
  /** @type {string[]} */
  const skipped = [];
  for (const name of names) {
    const kanji = hanCharacters(name);
    if (kanji.length < 2) {
      skipped.push(name);
      continue;
    }
    kanjiNames.push(name);
    for (const chapter of read.chapters) {
      for (let i = 0; i < chapter.lines.length; i += 1) {
        const span = readingAidSpan(chapter.lines[i], kanji);
        if (!span) continue;
        hits.push({ chapter: chapter.id, line: i + 1, span: span.span, gap: span.gap });
      }
    }
  }
  // The shortest kanji run among the names this probe could look at. The report prints it because it is
  // the number the store's own matching rule compares against, and "the measurement cannot see this name"
  // is only checkable if the report says how blind the name is.
  const kanjiCounts = kanjiNames.map((name) => hanCharacters(name).length);
  return {
    found: hits.length > 0,
    hits,
    names,
    kanjiNames,
    kanjiCount: kanjiCounts.length ? Math.min(...kanjiCounts) : 0,
    skipped,
    error: null,
  };
}

/**
 * A chapter id → source lines index for one volume, built once per call.
 *
 * The attribution questions are about the cited **line** — is this a line somebody is saying, or a line
 * about what is happening — and a claim's evidence column only holds the quote, which starts with a
 * bracket whether or not the line it came from does. So the line has to be read, not inferred.
 *
 * @param {{resolveVolume: Function}} ctx
 * @param {number} volume
 * @returns {Map<string, string[]>}
 */
function lineIndex(ctx, volume) {
  const read = volumeChapterLines(ctx, volume);
  /** @type {Map<string, string[]>} */
  const index = new Map();
  for (const chapter of read.chapters) index.set(chapter.id, chapter.lines);
  return index;
}

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
 * The answer this record holds for one doubted entry, if anybody asked.
 *
 * @param {{db: Object}} ctx
 * @param {number} volume
 * @param {string} key
 * @returns {Object|null}
 */
function attributionAnswer(ctx, volume, key) {
  const row = ctx.db.prepare("SELECT * FROM attribution_answers WHERE volume = ? AND key = ?").get(Number(volume), key);
  if (!row) return null;
  let claimIds = [];
  let evidence = [];
  try {
    claimIds = JSON.parse(row.claim_ids || "[]");
  } catch {
    claimIds = [];
  }
  try {
    evidence = JSON.parse(row.evidence || "[]");
  } catch {
    evidence = [];
  }
  return { ...row, claimIds, evidence };
}

/**
 * Every answer in this record, oldest volume first.
 *
 * @param {{db: Object}} ctx
 * @param {number} [upTo] - Ask about this volume and every volume at or below it.
 * @returns {Array<Object>}
 */
function attributionAnswers(ctx, upTo) {
  const limit = Number(upTo === undefined ? ctx.volume : upTo);
  return ctx.db
    .prepare("SELECT * FROM attribution_answers WHERE volume <= ? ORDER BY volume, key")
    .all(limit)
    .map((row) => {
      let claimIds = [];
      let evidence = [];
      try {
        claimIds = JSON.parse(row.claim_ids || "[]");
      } catch {
        claimIds = [];
      }
      try {
        evidence = JSON.parse(row.evidence || "[]");
      } catch {
        evidence = [];
      }
      // The same shape `attributionAnswer` returns: a caller that reads one answer and a caller that
      // reads all of them must not have to parse the JSON columns twice, in two places.
      return { ...row, claimIds, evidence };
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

/**
 * The folder a volume's chapters live in, for the detective's file tools.
 *
 * Kept here so the agent's working folder is decided by the same resolver the evidence rule uses,
 * rather than by a caller guessing at a path.
 *
 * @param {{resolveVolume: Function}} ctx
 * @param {number} volume
 * @returns {string|null}
 */
function attributionVolumeDir(ctx, volume) {
  const resolved = ctx.resolveVolume(Number(volume));
  if (resolved.error || !resolved.volumeDir) return null;
  return path.normalize(resolved.volumeDir);
}

module.exports = {
  ATTRIBUTION_STEP,
  SPEECH_ASPECTS,
  READING_AID_MAX_GAP,
  SKELETON_MIN_CHARS,
  lineSpeechKind,
  readingAidSpan,
  namePrintedWithReadingAids,
  claimsFiledUnderAtVolume,
  speakerPassage,
  attributionDoubts,
  attributionAnswer,
  attributionAnswers,
  recordAttributionAnswer,
  attributionFindings,
  attributionSummary,
  attributionVolumeDir,
};
