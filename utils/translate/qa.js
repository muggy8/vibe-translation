/**
 * Deterministic (no-model) QA: the per-language source-script residue check, the
 * per-pair length band, term occurrence counting, and the checks a draft must pass.
 *
 * Every one of these is per PAIR, because the pipeline is not Japanese-to-English
 * only: JA->EN counts kana+Han as residue, JA->ZH counts only kana (Han is shared),
 * KO->EN counts Hangul, ZH->EN counts Han. Term matching is word-boundary for
 * space-separated sources (Korean) and substring for CJK.
 *
 * Part of the translate.js layer (split out of the original single file).
 */

/**
 * The floor below which a chapter's SOURCE counts as having nothing in it
 * (TRANSLATION_EMPTY_SOURCE_CHARS, default 40). This is deliberately far smaller
 * than the extraction's empty-chapter floor (SOURCE_EMPTY_SEGMENT_CHARS, 200):
 * this number decides when NOT to spend a model call, so it must be small enough
 * that a genuinely short interlude is still translated. A section heading alone
 * ("# Chapter 3") is under it; a real chapter is not.
 *
 * @type {number}
 */
const EMPTY_SOURCE_CHARS = (() => {
  const n = parseInt(process.env.TRANSLATION_EMPTY_SOURCE_CHARS, 10);
  return Number.isFinite(n) ? Math.max(0, n) : 40;
})();


/**
 * Fraction of CJK characters (kana + CJK ideographs + halfwidth/katakana
 * forms) among the non-whitespace characters of a text. A faithful
 * Japanese→English translation should be near 0 (stray kanji/kana are
 * mistranslations or untranslated leftovers).
 *
 * @param {string} text
 * @returns {number} 0..1 (0 for empty/whitespace-only input).
 */
function cjkRatio(text) {
  if (!text || typeof text !== "string") return 0;
  const nonWs = text.replace(/\s+/g, "");
  if (nonWs.length === 0) return 0;
  const cjk = nonWs.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/g);
  return cjk ? cjk.length / nonWs.length : 0;
}

// ── Multi-language residue / length / matching helpers ────────────────────────
//
// The pipeline is Japanese-first, but the same code must translate Chinese and
// Korean sources to English. A single "CJK ratio" is wrong for those: Chinese
// shares Han with Japanese (so Han in a JA→ZH draft is legitimate, not
// residue), and Korean uses Hangul, which the CJK class does not even cover.
// Residue is defined per PAIR: characters of the source script that the target
// script does not use.


// Script classes (code-point ranges). Han is shared by Japanese and Chinese.
// Han: the BMP CJK blocks (U+3400–U+4DBF, U+4E00–U+9FFF, U+F900–U+FAFF). The
// CJK Extension B+ blocks sit beyond the BMP and cannot be expressed with 4-hex
// \u escapes in a character class (they would mangle it), and they are vanishingly
// rare in light novels, so they are deliberately not covered.
const SCRIPT_HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;

const SCRIPT_KANA = /[\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9f]/g; // hiragana + katakana (+ halfwidth)

const SCRIPT_HANGUL = /[\uac00-\ud7a3\u1100-\u11ff\u3130-\u318f\ua960-\ua97f]/g;


/**
 * The script classes a language is written in (the source/target scripts).
 *
 * @param {string} language - A language name ("Japanese", "Chinese", "Korean", "English", …).
 * @returns {RegExp[]}
 */
function scriptsOf(language) {
  const lang = (language || "").toLowerCase();
  if (/jap/.test(lang)) return [SCRIPT_KANA, SCRIPT_HAN];
  if (/chines|mandarin|zh/.test(lang)) return [SCRIPT_HAN];
  if (/korea|hangul|ko/.test(lang)) return [SCRIPT_HANGUL];
  return [];
}


/**
 * True when the language is written with spaces between words (Korean, and
 * Latin-script languages). CJK languages (Japanese, Chinese) are not — that
 * is why their terms are matched by substring, not word boundary.
 *
 * @param {string} language
 * @returns {boolean}
 */
function isSpaceSeparated(language) {
  const lang = (language || "").toLowerCase();
  if (/korea|hangul|ko\b/.test(lang)) return true;
  if (/(english|french|german|spanish|italian|portuguese|latin)/.test(lang)) return true;
  if (/jap|chines|mandarin/.test(lang)) return false;
  return false;
}


/**
 * Residue ratio for a translation: the share of non-whitespace characters in
 * `text` that belong to the SOURCE script but not the TARGET script. For
 * JA→EN that is kana + Han (≈ the legacy CJK ratio); for JA→ZH it is only
 * kana (Han is shared); for KO→EN it is Hangul; for ZH→EN it is Han.
 *
 * @param {string} text - The text to check (the draft).
 * @param {string} sourceLanguage - The source language.
 * @param {string} targetLanguage - The target language.
 * @returns {number} 0..1 (0 for empty input or no residue classes).
 */
function residueRatio(text, sourceLanguage, targetLanguage) {
  if (!text || typeof text !== "string") return 0;
  const nonWs = text.replace(/\s+/g, "");
  if (nonWs.length === 0) return 0;
  const target = new Set(scriptsOf(targetLanguage).map((re) => re.source));
  const residue = scriptsOf(sourceLanguage).filter((re) => !target.has(re.source));
  if (residue.length === 0) return 0;
  const re = new RegExp(residue.map((r) => `(?:${r.source})`).join("|"), "g");
  const found = nonWs.match(re);
  return found ? found.length / nonWs.length : 0;
}


// Per-pair length bands. The legacy 0.6–2.5 band is JA→EN-shaped: English is
// usually longer than Japanese by character count. Chinese compresses harder
// (each Han character is roughly a word), so a ZH→EN draft is longer still;
// Korean is in between. These are WARNING bands (a hard truncation fail is
// separate), so they are kept deliberately wide to avoid false positives.
const LENGTH_BANDS = {
  "ja-en": { min: 0.6, max: 2.5, truncation: 0.4 },
  "zh-en": { min: 0.7, max: 3.2, truncation: 0.4 },
  "ko-en": { min: 0.5, max: 2.6, truncation: 0.35 },
  "ja-zh": { min: 0.8, max: 2.2, truncation: 0.5 },
};

const DEFAULT_LENGTH_BAND = { min: 0.6, max: 2.5, truncation: 0.4 };


function langKey(language) {
  const lang = (language || "").toLowerCase();
  if (/jap/.test(lang)) return "ja";
  if (/chines|mandarin|zh/.test(lang)) return "zh";
  if (/korea|hangul|ko\b/.test(lang)) return "ko";
  if (/english|en\b/.test(lang)) return "en";
  return lang.slice(0, 2) || "xx";
}


/**
 * The length-ratio band for a source→target pair. Honours the
 * `TRANSLATION_LENGTH_RATIO` override ("min-max" or "min-max-truncation") for
 * the current run, else the per-pair table, else the wide default.
 *
 * @param {string} sourceLanguage
 * @param {string} targetLanguage
 * @returns {{min: number, max: number, truncation: number}}
 */
function lengthBands(sourceLanguage, targetLanguage) {
  const override = (process.env.TRANSLATION_LENGTH_RATIO || "").trim();
  if (override) {
    const parts = override.split(/[-,]/).map((n) => parseFloat(n));
    if (parts.length >= 2 && parts.every((n) => Number.isFinite(n))) {
      return {
        min: parts[0],
        max: parts[1],
        truncation: Number.isFinite(parts[2]) ? parts[2] : parts[0] * 0.66,
      };
    }
  }
  const key = `${langKey(sourceLanguage)}-${langKey(targetLanguage)}`;
  return LENGTH_BANDS[key] || DEFAULT_LENGTH_BAND;
}


/**
 * Count non-overlapping occurrences of `term` in `text`.
 *
 * Substring matching is the correct semantics for CJK sources (no word
 * boundaries — a term is a run of characters). For space-separated sources
 * (Korean, Latin-script) substring matching over-counts ("he" inside "the"),
 * so `wordBoundary: true` matches only whole words.
 *
 * @param {string} text
 * @param {string} term
 * @param {{wordBoundary?: boolean}} [opts]
 * @returns {number}
 */
function countOccurrences(text, term, { wordBoundary = false } = {}) {
  if (!text || !term || typeof text !== "string" || typeof term !== "string") return 0;
  if (!wordBoundary) {
    let count = 0;
    let idx = text.indexOf(term);
    while (idx !== -1) {
      count++;
      idx = text.indexOf(term, idx + Math.max(1, term.length));
    }
    return count;
  }
  // Whole words only: the term is delimited by non-word characters (or ends).
  // \b is unreliable at CJK boundaries, but this path is only used for
  // space-separated (word-delimited) sources, where it is exact.
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\b${escaped}\\b`, "g");
  const found = text.match(re);
  return found ? found.length : 0;
}


/**
 * Deterministic QA of one translated chapter (no AI).
 *
 * Multi-language: the residue check is per PAIR (source script minus target
 * script — see residueRatio), the length band is per PAIR (lengthBands), and
 * term matching is word-boundary for space-separated sources (Korean) and
 * substring for CJK sources.
 *
 * Hard failures (ok=false — the chapter must be retranslated):
 *   - the draft is empty (runOneShot already guards this, kept as defense)
 *   - source-script residue > 5% (the model echoed the source)
 *   - length ratio under the pair's truncation floor (a truncated response;
 *     the runOneShot finish_reason="length" guard is the primary detector)
 * Warnings (reported, do not fail):
 *   - source-script residue > 0.5% (stray untranslated fragments)
 *   - length ratio outside the pair's band (the draft may be truncated or
 *     padded)
 *   - glossary terms that occur in the source but whose canonical rendering
 *     is absent from the draft (ignored terminology)
 *
 * @param {{sourceText: string, draftText: string, terms?: Array<{term: string, rendering: string}>, sourceLanguage?: string, targetLanguage?: string}} p
 * @returns {{ok: boolean, cjk: number, lengthRatio: number, missingTerms: Array<{term: string, rendering: string}>, warnings: string[], errors: string[]}}
 */
function checkTranslationQa({ sourceText, draftText, terms = [], sourceLanguage = "Japanese", targetLanguage = "English" }) {
  const errors = [];
  const warnings = [];
  const draft = (draftText || "").trim();
  const src = (sourceText || "").trim();
  const residue = residueRatio(draft, sourceLanguage, targetLanguage);
  const band = lengthBands(sourceLanguage, targetLanguage);
  const wordBoundary = isSpaceSeparated(sourceLanguage);
  const lengthRatio = src.length > 0 ? draft.length / src.length : draft.length > 0 ? Infinity : 0;
  if (!draft) errors.push("draft is empty");
  // An empty (or near-empty) SOURCE is not a translation problem — it is a
  // source problem, and it used to slip through: the length checks are skipped
  // when there is no source, so a chapter that converted to nothing produced a
  // "clean" QA row for a draft translated from nothing at all.
  // An empty SOURCE is not a translation problem — it is a source problem, and it
  // used to slip through: the length checks are skipped when there is no source,
  // so a chapter that converted to nothing produced a "clean" QA row for a draft
  // translated from nothing at all. Only a truly empty source is a hard failure
  // here — judging whether a SHORT chapter is too short is the extraction's job
  // (SOURCE_EMPTY_SEGMENT_CHARS), not this gate's.
  if (!src) {
    errors.push(
      "source is empty — there is nothing here to translate; check the [source] extraction lines " +
        "in the run log for why this section has no text"
    );
  }
  if (residue > 0.05) errors.push(`source-script residue ${(residue * 100).toFixed(1)}% — the draft still looks like source text`);
  else if (residue > 0.005) warnings.push(`residual source-script ratio ${(residue * 100).toFixed(2)}% — check for untranslated fragments`);
  // Truncation backstop: a draft under the pair's truncation floor is almost
  // certainly cut off. The runOneShot finish_reason="length" guard is the
  // primary detector; this catches the case where the finish reason is
  // unavailable but the draft is still grossly short.
  if (src.length > 0 && Number.isFinite(lengthRatio) && lengthRatio < band.truncation) {
    errors.push(`draft is only ${(lengthRatio * 100).toFixed(0)}% of the source length — it looks truncated`);
  } else if (Number.isFinite(lengthRatio) && (lengthRatio < band.min || lengthRatio > band.max)) {
    warnings.push(`length ratio ${lengthRatio.toFixed(2)} outside the ${band.min}–${band.max} band`);
  }
  const missingTerms = [];
  for (const t of terms) {
    if (!t || !t.term || !t.rendering) continue;
    if (countOccurrences(sourceText || "", t.term, { wordBoundary }) === 0) continue; // not used in this chapter
    if (!draft.includes(t.rendering)) missingTerms.push({ term: t.term, rendering: t.rendering });
  }
  if (missingTerms.length > 0) {
    warnings.push(
      `${missingTerms.length} glossary rendering(s) missing from the draft: ` +
        missingTerms.map((t) => `"${t.term}"→"${t.rendering}"`).join(", ")
    );
  }
  return { ok: errors.length === 0, cjk: residue, lengthRatio, missingTerms, warnings, errors };
}


/**
 * Synthesize a numbered "fix these" findings list from a deterministic QA
 * result — the polish loop's feedback when the regression guard rejects a
 * polished text (the guard's errors/warnings become correction tasks for
 * the next polish attempt, mirroring the way retranslate injects the
 * verifier's findings).
 *
 * @param {{errors?: string[], warnings?: string[], missingTerms?: Array<{term: string, rendering: string}>}} qa
 *   A checkTranslationQa() result for the POLISHED text.
 * @returns {string} The findings text ("(no deterministic findings)" when the
 *   result is clean — callers only use this for failed checks).
 */
function buildPolishGuardFindings(qa) {
  const lines = [];
  for (const e of qa.errors || []) lines.push(`- [HIGH] ${e}`);
  for (const t of qa.missingTerms || []) {
    lines.push(`- [HIGH] glossary rendering missing from the polished text: "${t.term}" → "${t.rendering}"`);
  }
  for (const w of qa.warnings || []) lines.push(`- [MEDIUM] ${w}`);
  if (lines.length === 0) return "(no deterministic findings)";
  return lines.join("\n");
}

// ─── Merging ────────────────────────────────────────────────────────────────


module.exports = {
  EMPTY_SOURCE_CHARS,
  cjkRatio,
  SCRIPT_HAN,
  SCRIPT_KANA,
  SCRIPT_HANGUL,
  scriptsOf,
  isSpaceSeparated,
  residueRatio,
  LENGTH_BANDS,
  DEFAULT_LENGTH_BAND,
  langKey,
  lengthBands,
  countOccurrences,
  checkTranslationQa,
  buildPolishGuardFindings,
};
