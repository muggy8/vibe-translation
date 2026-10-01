/**
 * utils/translate.js — Pure helpers for the translation stage
 * (the translate / verify-translate / retranslate / polish tasks).
 *
 * The translation stage is deliberately NOT agent-based: every stage is a
 * one-shot model call over a single chapter, plus deterministic QA and
 * state-file idempotency. This module holds the pure logic (chapter
 * splitting, prompt construction, deterministic QA, state load/save,
 * merging, QA-loop stop-decision) so the task modules stay thin and the
 * logic stays unit-testable
 * without the filesystem or the AI (test/test-translate.js).
 *
 * Endpoint roles (see the TRANSLATE_* / VERIFY_* / EDIT_* / AUDIT_* env vars —
 * each names an ENDPOINT, never a model: the stage logic is identical whatever
 * answers, and on local setups the per-machine hooks decide which container
 * serves the port):
 *   - translate / retranslate: the TRANSLATE_* endpoint. The prompt below is
 *     the one genuinely model-specific contract in this stage (the official
 *     translation-model single-user-message shape + its sampling recipe), so
 *     swapping this endpoint means swapping that prompt too.
 *   - verify-translate / polish: the VERIFY_* / EDIT_* endpoints
 *     (source-anchored checking and final polish — they read the source).
 *   - the cross-checks (verify tiebreak + polish final audit): the AUDIT_*
 *     endpoint, deliberately a DIFFERENT endpoint from the one that produced
 *     the text being graded.
 */

const crypto = require("crypto");
const fs = require("fs").promises;
const path = require("path");
const { loadGlossaryDisputes, disputedTermSet } = require("./disputes");
const { selectSectionsByRelevance } = require("./prompt");

// ─── Hashing ────────────────────────────────────────────────────────────────

/**
 * sha256 of a string (content hash for the idempotency skip-checks).
 *
 * @param {string} text - The content to hash.
 * @returns {string} The hex digest.
 */
function sha256(text) {
  return crypto.createHash("sha256").update(text ?? "", "utf8").digest("hex");
}

// ─── Chapter splitting ──────────────────────────────────────────────────────

/**
 * Split a chapter into translation-sized parts, at paragraph boundaries
 * (blank lines) wherever possible.
 *
 * Contract: the parts cover the whole input without loss — concatenating
 * them in order (ignoring whitespace) reproduces the input's content. Each
 * part is at most `maxChars` long EXCEPT single paragraphs longer than
 * `maxChars`, which are hard-split at the character level (Japanese text
 * has no word boundaries to break at).
 *
 * @param {string} text - The chapter source text.
 * @param {number} [maxChars] - Target maximum part length (default: 24000,
 *   from TRANSLATE_CHUNK_CHARS).
 * @returns {string[]} The parts, in reading order (one part for short text).
 */
function splitChapter(text, maxChars = 24000) {
  if (typeof text !== "string") return [];
  const limit = Math.max(1000, parseInt(maxChars, 10) || 24000);
  const t = text.trim();
  if (!t) return [];
  if (t.length <= limit) return [t];

  const paragraphs = t.split(/\n\s*\n/);
  const parts = [];
  let current = "";
  const flush = () => {
    if (current) {
      parts.push(current);
      current = "";
    }
  };
  for (const para of paragraphs) {
    if (!para.trim()) continue;
    if (para.length > limit) {
      // A single paragraph longer than the limit: hard-split it.
      flush();
      for (let i = 0; i < para.length; i += limit) {
        parts.push(para.slice(i, i + limit));
      }
      continue;
    }
    if (!current) {
      current = para;
    } else if (current.length + 2 + para.length <= limit) {
      current = current + "\n\n" + para;
    } else {
      flush();
      current = para;
    }
  }
  flush();
  return parts;
}

// ─── Reference extraction (glossary / style guide) ─────────────────────────

/**
 * Parse source-language terms AND their canonical target renderings out of
 * a glossary Markdown file (column 1 = the source term, column 2 = the
 * canonical rendering; see {@link parseGlossaryRows} for the row handling).
 *
 * Rows whose term is an unrendered template placeholder, or whose rendering
 * column is empty or a "—", are NOT returned — they cannot drive a terminology
 * constraint — but they are reported through `onMalformed`, so a caller can warn
 * that the glossary is incomplete instead of quietly translating without the
 * term.
 *
 * @param {string} markdown - The glossary file content.
 * @param {{onMalformed?: (entry: {term: string, section: string, reason: string}) => void}} [opts]
 * @returns {Array<{term: string, rendering: string, section: string}>}
 *   One entry per usable term row, in file order.
 */
function parseGlossaryTerms(markdown, { onMalformed } = {}) {
  const entries = [];
  for (const { cells, section } of parseGlossaryRows(markdown)) {
    const term = cells[0] || "";
    const rendering = cells.length > 1 ? cells[1] : "";
    if (!term) continue;
    if (/^\[.*\]$/.test(term)) continue; // unrendered template placeholder
    if (!rendering || /^:?-{3,}:?$/.test(rendering) || rendering === "—") {
      if (typeof onMalformed === "function") {
        onMalformed({
          term,
          section,
          reason: rendering
            ? "rendering column is a placeholder"
            : "rendering column is empty",
        });
      }
      continue;
    }
    entries.push({ term, rendering, section });
  }
  return entries;
}

/**
 * Normalize one glossary table cell: strip the backtick/emphasis wrappers a
 * Markdown-writing model likes to add.
 *
 * @param {string} cell
 * @returns {string}
 */
function cleanTableCell(cell) {
  return String(cell ?? "")
    .trim()
    .replace(/^`+|`+$/g, "")
    .trim()
    .replace(/^\*+|\*+$/g, "")
    .trim()
    .replace(/^_+|_+$/g, "")
    .trim();
}

/**
 * Split one Markdown table row into its cells, POSITIONALLY.
 *
 * A table row is wrapped in pipes ("| a | b | c |"), so the first and last
 * pieces produced by split("|") are the shells outside the table and are
 * dropped. EMPTY CELLS IN THE MIDDLE ARE KEPT.
 *
 * (Observed: the previous version filtered out every empty cell, so a row with
 * an empty Target column shifted the remaining columns one place left —
 * `| ソラ |  | AI agent of the institute |` came back with the canonical
 * rendering "AI agent of the institute". That string then went into every
 * translate / retranslate / verify / polish prompt as a terminology law, and
 * into the deterministic "missing glossary rendering" check.)
 *
 * @param {string} row - A line starting with "|".
 * @returns {string[]} The cells in column order (empty cells preserved).
 */
function splitTableRow(row) {
  const cells = String(row ?? "").split("|");
  if (cells.length > 0 && cells[0].trim() === "") cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === "") cells.pop();
  return cells.map(cleanTableCell);
}

/**
 * Walk a glossary-style Markdown file and return every DATA row of every
 * table, positionally, tracking the `## ` section each row belongs to.
 *
 * For each maximal run of consecutive table rows, row 0 (the header) and row 1
 * (the `|---|---|` separator) are skipped. This is the single table reader for
 * the project: the glossary coverage audit and the translation stage's
 * terminology constraint both read through it so they cannot drift apart.
 *
 * @param {string} markdown - The glossary file content.
 * @returns {Array<{cells: string[], section: string}>} One entry per data row.
 */
function parseGlossaryRows(markdown) {
  if (!markdown || typeof markdown !== "string") return [];
  const rows = [];
  let section = "";
  let tableRows = [];
  const flushTable = () => {
    // Row 0 = header, row 1 = separator — data starts at row 2.
    for (let ri = 2; ri < tableRows.length; ri++) {
      const cells = splitTableRow(tableRows[ri]);
      if (cells.length === 0) continue;
      if (/^:?-{3,}:?$/.test(cells[0])) continue; // stray separator row
      rows.push({ cells, section });
    }
    tableRows = [];
  };
  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim();
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      flushTable();
      section = heading[1].replace(/\*/g, "").trim();
      continue;
    }
    if (line.startsWith("|")) {
      tableRows.push(line);
      continue;
    }
    flushTable();
  }
  flushTable();
  return rows;
}

/**
 * The character budget for the glossary block injected into one chapter's
 * prompts (TRANSLATION_GLOSSARY_MAX_CHARS, default 12000).
 *
 * @returns {number}
 */
function glossaryBlockMaxChars() {
  const n = parseInt(process.env.TRANSLATION_GLOSSARY_MAX_CHARS, 10);
  return Number.isFinite(n) && n >= 0 ? n : 12000;
}

/**
 * Pick the glossary terms this chapter can actually use, bounded by a
 * character budget.
 *
 * The glossary is cumulative: by the last volume of a long series it holds
 * every term the series has ever introduced. Injecting ALL of them into every
 * chapter prompt (what the translation stage used to do) makes the prompt grow
 * with the size of the SERIES rather than of the chapter, until it crowds out
 * the source text. A term whose source form does not appear in this chapter
 * cannot be rendered in this chapter, so it is dead weight.
 *
 * Substring matching is the right test for Japanese / Chinese / Korean (no
 * word boundaries): "黒鋼さん" contains the glossary term "黒鋼".
 *
 * @param {Array<{term: string, rendering: string, section: string}>} terms - The cumulative glossary terms.
 * @param {string} sourceText - The chapter's source text.
 * @param {{maxChars?: number}} [opts] - Character budget for the block (default: glossaryBlockMaxChars()).
 * @returns {{terms: Array<{term: string, rendering: string, section: string}>, usedChars: number, present: number, dropped: number}}
 *   `terms` in glossary order, capped by the budget. `present` counts the terms
 *   that occur in this chapter; `dropped` counts everything in the glossary
 *   that is not in the returned block (absent terms + over-budget terms).
 */
function selectTermsForChapter(terms, sourceText, { maxChars } = {}) {
  const all = Array.isArray(terms) ? terms : [];
  const budget = Math.max(0, maxChars ?? glossaryBlockMaxChars());
  const present = all.filter(
    (t) => t && t.term && countOccurrences(sourceText || "", t.term) > 0
  );
  const kept = [];
  let usedChars = 0;
  for (const t of present) {
    const lineChars = `"${t.term}" → "${t.rendering}"`.length + 1;
    if (usedChars + lineChars > budget) break;
    kept.push(t);
    usedChars += lineChars;
  }
  return { terms: kept, usedChars, present: present.length, dropped: all.length - kept.length };
}

/**
 * Extract the compact style constraints from a style-guide Markdown file.
 *
 * Prefers the `## Policy Summary` section (the distilled house rules the
 * style-guide task writes first); falls back to the whole guide truncated
 * to `fallbackMaxChars` when the section is absent (older formats).
 *
 * @param {string} markdown - The style-guide file content.
 * @param {{fallbackMaxChars?: number}} [opts]
 * @returns {string} The style rule text ("" when the guide is empty/missing).
 */
function extractStyleRules(markdown, { fallbackMaxChars = 8000 } = {}) {
  if (!markdown || typeof markdown !== "string" || !markdown.trim()) return "";
  // Capture from the Policy Summary heading to the end of the string, then
  // cut at the next "## " section (a lookahead for "end of line" would match
  // at the end of ANY line in the section, so cut manually).
  const m = markdown.match(/^##\s+Policy Summary[ \t]*\r?\n([\s\S]*)/m);
  if (m) {
    let body = m[1];
    const cut = body.search(/\r?\n##\s/);
    if (cut !== -1) body = body.slice(0, cut);
    if (body.trim()) return body.trim();
  }
  const t = markdown.trim();
  return t.length > fallbackMaxChars ? t.slice(0, fallbackMaxChars) + "\n…(truncated)" : t;
}

// ─── Hy-MT2 prompt construction ─────────────────────────────────────────────

/**
 * Build the numbered [Translation Tasks] lines for the Hy-MT2 translate
 * prompt, following the official "Personalization" format: terminology
 * references, background context, style constraints, optional continuity
 * and findings, then the no-commentary constraint and the translate
 * command (always last).
 *
 * @param {{terminologyLines?: string[], background?: string, styleRules?: string, voiceNotes?: string, continuityText?: string, continuitySource?: string, findingsText?: string, scopeText?: string, targetLanguage?: string}} p
 * @returns {string[]} The task lines, WITHOUT numbering (the caller numbers
 *   them — the numbering must be contiguous).
 */
function buildTranslationTaskLines({
  terminologyLines = [],
  background = "",
  styleRules = "",
  voiceNotes = "",
  continuityText = "",
  continuitySource = "the previous chapter",
  findingsText = "",
  scopeText = "",
  targetLanguage = "English",
}) {
  const indent = (text) =>
    text
      .split("\n")
      .map((l) => (l ? "   " + l : l))
      .join("\n");
  const tasks = [];
  if (terminologyLines.length > 0) {
    tasks.push(
      "Reference the following translations — render every occurrence of the source form exactly as given:\n" +
        terminologyLines.map((l) => "   " + l).join("\n")
    );
  }
  if (background && background.trim()) {
    tasks.push("Use this background context for names, places, and the plot:\n" + indent(background));
  }
  if (styleRules && styleRules.trim()) {
    tasks.push("The translation style must strictly conform to these house rules:\n" + indent(styleRules));
  }
  if (voiceNotes && voiceNotes.trim()) {
    tasks.push(
      "These characters' established speech patterns must be preserved:\n" + indent(voiceNotes)
    );
  }
  if (continuityText && continuityText.trim()) {
    tasks.push(
      `This text continues after ${continuitySource}, which ended with: "${continuityText}" ` +
        "Keep names, tense, register, and voice consistent with it."
    );
  }
  if (scopeText && scopeText.trim()) {
    tasks.push(scopeText.trim());
  }
  if (findingsText && findingsText.trim()) {
    tasks.push(
      "A previous translation of this text had the following problems — your translation MUST fix all of them:\n" +
        indent(findingsText)
    );
  }
  tasks.push(
    "ONLY output the translated result, without any additional explanation, commentary, or code fences."
  );
  tasks.push(`Translate the [Source Text] into ${targetLanguage}.`);
  return tasks;
}

/**
 * Fill the translate/retranslate user-prompt template (the official
 * Hy-MT2 single-user-message shape: [Source Text] block, then the numbered
 * [Translation Tasks] list).
 *
 * @param {{template: string, sourceText: string, tasks: string[]}} p
 * @returns {string} The final single user message.
 */
function buildTranslationPrompt({ template, sourceText, tasks }) {
  const numbered = tasks.map((t, i) => `${i + 1}. **${t}**`).join("\n");
  return template
    .replaceAll("{{SOURCE_TEXT}}", sourceText)
    .replaceAll("{{TASKS}}", numbered);
}

/**
 * Which parts of the cumulative reference files get injected into a translation
 * prompt. Baked into `contextHash` / `sharedContextHash` so a change to this rule
 * invalidates the drafts built under the old one (v1: the first N characters of
 * each file — which showed the earliest volumes' state and the volume-1 cast;
 * v2: the sections relevant to the volume being translated).
 *
 * @type {number}
 */
const REFERENCE_SELECTION_VERSION = 2;



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

/**
 * Which segments have no text to merge — the completeness check behind the
 * merged volume.
 *
 * mergeVolumeTranslation skips a chapter with no text (it cannot invent one),
 * which is exactly how a volume used to end up published as `translation.md`
 * with chapters silently missing from the middle: the file looked complete,
 * the merge reported success, and nothing said that chapter 7 never got
 * translated.
 *
 * @param {Array<{id: string, title?: string}>} segments - The volume's chapters in reading order.
 * @param {(seg: {id: string}) => string|null} getText
 * @returns {Array<{id: string, title: string}>} The segments with no text.
 */
function findMissingSegments(segments, getText) {
  const missing = [];
  for (const seg of segments || []) {
    const text = (getText(seg) || "").trim();
    if (!text) missing.push({ id: seg.id, title: seg.title || seg.id });
  }
  return missing;
}

/**
 * Merge a volume's per-chapter texts into the single `translation.md` file
 * (chapter heading + text, in segment reading order).
 *
 * @param {{segments: Array<{id: string, title: string}>, getText: (seg: {id: string}) => string|null}} p
 *   `getText(seg)` returns the chapter text to merge (the polished text when
 *   present, otherwise the draft) or null to skip the segment.
 * @returns {string} The merged volume text ("" when nothing to merge).
 */
function mergeVolumeTranslation({ segments, getText, getNote, sourceLanguage, targetLanguage, languages }) {
  const parts = [];
  for (const seg of segments) {
    const text = (getText(seg) || "").trim();
    if (!text) continue;
    const heading = headingForSegment(seg, text, {
      sourceLanguage: sourceLanguage || (languages && languages.sourceLanguage),
      targetLanguage: targetLanguage || (languages && languages.targetLanguage),
    });
    const note = ((getNote && getNote(seg)) || "").trim();
    parts.push([heading, note || null, text].filter(Boolean).join("\n\n"));
  }
  return parts.length > 0 ? parts.join("\n\n") + "\n" : "";
}

/**
 * The heading the merged book puts above one chapter — or none.
 *
 * Three cases the old rule got wrong:
 *   - The chapter text already begins with a heading (the translator rendered the
 *     title that was in the source). Prepending the source-language title on top
 *     produced TWO headings, one of them untranslated.
 *   - The segment's "title" is only a file name (a plain-text volume) or a
 *     pipeline label ("Part 3 of 12"). Printing it makes the published book open
 *     with `# test_story(1).md`.
 *   - A real declared title with no heading in the text: print it. That is the
 *     one case a heading is correct.
 *
 *   - A title written in the SOURCE language. When the translator rendered the
 *     title in its own way (a bold line, or nothing at all), printing the source
 *     title above it puts an untranslated Japanese line at the top of an English
 *     book. With the pair supplied, a title that still carries source-script
 *     characters is not printed.
 *
 * @param {{title?: string, syntheticTitle?: boolean}} seg
 * @param {string} text - The chapter's published text.
 * @param {{sourceLanguage?: string, targetLanguage?: string}} [languages] - The pair, used to reject a source-language title.
 * @returns {string|null} The heading line, or null when the chapter gets none.
 */
function headingForSegment(seg, text, languages = {}) {
  const firstLine = (text || "").trim().split("\n", 1)[0] || "";
  if (/^#{1,6}\s+\S/.test(firstLine)) return null;
  if (!seg || !seg.title || !seg.title.trim() || seg.syntheticTitle) return null;
  const title = seg.title.trim();
  if (languages.sourceLanguage && languages.targetLanguage) {
    const residue = residueRatio(title, languages.sourceLanguage, languages.targetLanguage);
    if (residue > 0) return null;
  }
  return `# ${title}`;
}

// ─── Output cleanup ─────────────────────────────────────────────────────────

/**
 * Defensively strip a full-text markdown code fence some models add around
 * their output (Hy-MT2 is prompted not to, but a stray fence would corrupt
 * the merged volume). Only strips when the WHOLE output is fenced.
 *
 * @param {string} text
 * @returns {string} The cleaned text.
 */
function stripMarkdownFence(text) {
  if (typeof text !== "string") return "";
  const t = text.trim();
  const m = t.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
  return (m ? m[1] : t).trim();
}

/**
 * The tail of a text for the continuity context passed to the next chapter
 * (the previous chapter's ending, quoted in the translate prompt).
 *
 * @param {string} text
 * @param {number} [maxChars] - Maximum tail length (default: 400; 0 = off,
 *   returns "" — TRANSLATE_CONTINUITY_CHARS=0 disables the continuity tail).
 * @returns {string} The trimmed tail ("" for empty input or maxChars = 0).
 */
function tailOf(text, maxChars = 400) {
  const t = (text || "").trim();
  if (!t) return "";
  const parsed = parseInt(maxChars, 10);
  const max = Number.isFinite(parsed) ? Math.max(0, parsed) : 400;
  if (max === 0) return ""; // explicit "off"
  return t.length > max ? "…" + t.slice(-max) : t;
}

// ─── Translation state (per-volume idempotency) ────────────────────────────

/**
 * Load the per-volume translation state file (translation-state.json).
 *
 * Shape (per segment id):
 *   sourceHash        sha256 of the chapter source content
 *   contextHash       sha256 of the injected references (glossary + style
 *                     rules + background) the draft was built from
 *   draftHash         sha256 of the current draft file content
 *   retranslated      whether a retranslate pass has run for the findings
 *   findingsHash      sha256 of the verification findings the last
 *                     retranslate was based on (or null)
 *   polishedDraftHash sha256 of the draft the last polish pass polished
 *                     (or null when not polished)
 *
 * Fail-open: a missing/corrupt file loads as an empty state (the volume is
 * reprocessed once — the idempotency skip-checks simply find nothing).
 *
 * @param {string} filePath - Absolute path to the state file.
 * @returns {Promise<{schema: number, chapters: Object}>}
 */
async function loadTranslationState(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    if (!raw.trim()) return { schema: 1, chapters: {} };
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || typeof data.chapters !== "object" || data.chapters === null) {
      return { schema: 1, chapters: {} };
    }
    return { schema: 1, chapters: data.chapters };
  } catch {
    return { schema: 1, chapters: {} };
  }
}

/**
 * Persist the per-volume translation state (a plain overwrite — the file is
 * small and a torn write just costs one reprocessed volume on the next run).
 *
 * @param {string} filePath - Absolute path to the state file.
 * @param {{chapters: Object}} state
 */
async function saveTranslationState(filePath, state) {
  await fs.writeFile(
    filePath,
    JSON.stringify({ schema: 1, chapters: state.chapters || {} }, null, 2) + "\n",
    "utf8"
  );
}

/**
 * Is re-translating a whole chapter worth the tokens for this FAIL?
 *
 * A retranslate throws away a whole chapter's draft and re-derives it from
 * scratch to fix what may be one awkward sentence. That is the right trade for
 * a fidelity or terminology problem, and a bad one for a cosmetic problem: the
 * fresh pass can introduce new errors while fixing a nit, and it costs a full
 * chapter of generation. Chapters that are skipped by this filter are reported
 * (never silently dropped), so the human reader sees the remaining nits.
 *
 * @param {{score: number|null, findings?: string, deterministic?: boolean}} verdict - The chapter's verification entry.
 * @param {number} passingScore - The shared PASSING_SCORE.
 * @param {number} [margin] - How far below the passing line a cosmetic-only miss must be to justify a rewrite.
 * @returns {boolean} True when the chapter should be retranslated.
 */
function worthRetranslating(verdict, passingScore, margin = 5) {
  // A deterministic-QA failure (residue / truncation / empty) is never cosmetic.
  if (verdict.deterministic) return true;
  // An unparseable score is a FAIL with no information in it — retry it.
  if (typeof verdict.score !== "number") return true;
  // A HIGH finding is a meaning, fidelity or terminology problem: rewrite it.
  if (/\[HIGH\]/i.test(verdict.findings || "")) return true;
  // Otherwise: a chapter that missed the line by a hair on MEDIUM/LOW findings
  // only is a copy-edit, not a re-translation.
  return verdict.score < passingScore - margin;
}

// ─── QA loop (translate-qa) ─────────────────────────────────────────────────

/**
 * Pure stop-decision for the translate-qa loop (the batched
 * "verify → retranslate … until the validator is happy" loop).
 *
 * Rules (checked in this order):
 *   - phase "after-verify": when zero chapters FAIL — stop with "all-pass", or
 *     with "missing-drafts" when some chapter has no draft at all (nothing was
 *     verified for it and the loop cannot fix an absent chapter); when FAILs
 *     remain — stop with "no-improvement" when the draft ratchet had to roll
 *     back EVERY failing chapter to a better earlier draft (the loop is moving
 *     chapters backwards), or with "round-limit" when this was the last allowed
 *     round; otherwise continue to the retranslate batch (a fixable FAIL is
 *     worth a round even when some other chapter is missing).
 *   - phase "after-retranslate": stop with "stalled" when nothing was
 *     retranslated (every FAIL chapter already carries exactly those findings
 *     — the retranslate task's findingsHash skip-check fired, so nothing new
 *     can be applied); else continue to the next verify batch.
 *
 * @param {{
 *   phase: "after-verify"|"after-retranslate",
 *   round: number,
 *   maxRounds: number,
 *   failed?: number,
 *   retranslated?: number,
 *   noDraft?: number,
 *   noImprovement?: number,
 * }} p
 * @returns {{stop: boolean, reason: "all-pass"|"round-limit"|"stalled"|"missing-drafts"|"no-improvement"|null}}
 */
function qaLoopDecision({ phase, round, maxRounds, failed = 0, retranslated = 0, noDraft = 0, noImprovement = 0 }) {
  if (phase === "after-verify") {
    if (failed === 0) {
      // A chapter with no draft was never verified at all — counting it as a
      // pass is how the loop could report "all-pass" over an untranslated
      // volume. And the loop cannot fix it: there is nothing to retranslate.
      if (noDraft > 0) return { stop: true, reason: "missing-drafts" };
      return { stop: true, reason: "all-pass" };
    }
    // Every FAIL this round is a regression the ratchet just rolled back: the
    // last round's rewrites made the book worse, so stop before paying for
    // another round of the same.
    if (noImprovement > 0 && noImprovement >= failed) return { stop: true, reason: "no-improvement" };
    if (round >= maxRounds) return { stop: true, reason: "round-limit" };
    // FAILs that CAN be fixed are still worth a round even when some other
    // chapter is missing entirely (that one is reported, not silently passed).
    return { stop: false, reason: null };
  }
  if (phase === "after-retranslate") {
    if (retranslated === 0) return { stop: true, reason: "stalled" };
    return { stop: false, reason: null };
  }
  throw new Error(
    `qaLoopDecision: unknown phase "${phase}" (expected "after-verify" or "after-retranslate").`
  );
}

/**
 * The max number of translate-qa rounds (TRANSLATE_QA_MAX_ROUNDS, default
 * 3, minimum 1). One round = one verify batch + one retranslate batch; the
 * loop also stops early when all chapters pass or a round retranslates
 * nothing (see qaLoopDecision).
 *
 * @returns {number}
 */
function qaMaxRounds() {
  const parsed = parseInt(process.env.TRANSLATE_QA_MAX_ROUNDS, 10);
  return Number.isFinite(parsed) ? Math.max(1, parsed) : 3;
}

// ─── Part-continuity & concurrency helpers ──────────────────────────────────

/**
 * Strip the prefix of `nextPart` that duplicates the tail of `prevPart`.
 *
 * When a chapter part is translated with the previous part's ending as
 * continuity context, the model sometimes REPEATS that ending at the start
 * of its reply (continuation behaviour), which would leave a duplicated
 * passage in the merged draft. This is the deterministic backstop: if the
 * new part starts with at least minOverlap characters that exactly match
 * the end of the previous part, that overlap is cut from the new part.
 * Only exact matches are stripped (never fuzzy) — anything else is left to
 * the QA checks, so a legitimate re-phrase can never be mangled.
 *
 * @param {string} prevPart - The previous part's (cleaned) text.
 * @param {string} nextPart - The new part's (cleaned) text.
 * @param {number} [minOverlap=50] - Minimum duplicated characters for a
 *   strip to happen (shorter coincidental matches are kept).
 * @returns {string} The new part with the duplicated prefix removed.
 */
function stripContinuityOverlap(prevPart, nextPart, minOverlap = 50) {
  if (!prevPart || !nextPart) return nextPart || "";
  const prev = prevPart.replace(/\s+$/, "");
  const next = nextPart;
  const maxLen = Math.min(prev.length, next.length, 4000);
  for (let len = maxLen; len >= minOverlap; len--) {
    if (next.startsWith(prev.slice(-len))) {
      return next.slice(len).replace(/^\s+/, "");
    }
  }
  return next;
}

/**
 * Run `fn` over `items` with at most `limit` in flight (a bounded worker
 * pool). `fn(item, index)` receives the item's index, so callers can store
 * results in input order regardless of completion order.
 *
 * Used by the per-chapter loops of the translation stage's INDEPENDENT
 * tasks (verify / retranslate / polish). `limit` 1 is the default — the
 * local hardware runs one inference at a time, so concurrency is opt-in —
 * and with limit 1 the behaviour is exactly the old serial loop. When fn
 * rejects, no further items are started (already-running ones finish), and
 * the first error is rethrown.
 *
 * @param {Array<*>} items - The items to process.
 * @param {number} limit - Max concurrent fn calls (minimum 1).
 * @param {(item: *, index: number) => Promise<*>} fn - The per-item work.
 * @returns {Promise<Array<*>} The fn results in input order.
 */
async function runWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  let firstError = null;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length || 1)) },
    async () => {
      for (;;) {
        if (firstError) return;
        const i = next;
        next += 1;
        if (i >= items.length) return;
        try {
          results[i] = await fn(items[i], i);
        } catch (err) {
          if (!firstError) firstError = err;
          return;
        }
      }
    }
  );
  await Promise.all(workers);
  if (firstError) throw firstError;
  return results;
}

/**
 * Per-stage chapter concurrency knob: STAGE_CONCURRENCY — the number of
 * independent units a stage runs at once (chapters per verify / retranslate /
 * polish pass, chapters per audit batch, research agents per glossary term).
 * Defaults to 1 (serial) because the local hardware runs one inference at
 * a time; raise it when the endpoint can serve parallel requests.
 *
 * The old per-stage names (`<PREFIX>_CONCURRENCY`) still work as per-stage
 * overrides for an existing .env.
 *
 * The `translate` task deliberately stays serial: each chapter's prompt
 * carries the previous chapter's ending as continuity context, so its
 * chapters are chained and cannot run in parallel.
 *
 * @param {"VERIFY"|"RETRANSLATE"|"POLISH"|"AUDIT"} prefix - The legacy per-stage prefix.
 * @returns {number} The concurrency limit (minimum 1).
 */
function stageConcurrency(prefix) {
  const perStage = parseInt(process.env[`${prefix}_CONCURRENCY`], 10);
  if (Number.isInteger(perStage) && perStage >= 1) return perStage;
  const shared = parseInt(process.env.STAGE_CONCURRENCY, 10);
  return Number.isInteger(shared) && shared >= 1 ? shared : 1;
}

/**
 * Sampling temperature for every call that GRADES text rather than writes it.
 * Re-exported from configs/shared.js (its home) so the translation-stage tasks
 * keep importing it from here — see configs/shared.js for the knob and its
 * legacy names.
 *
 * @returns {number}
 */
const { judgeTemperature, readBoolEnv } = require("../configs/shared");

/**
 * Thinking dialect for a translation-stage call: the global AI_THINKING switch
 * plus STAGE_THINKING_LEVEL (default "medium").
 *
 * The stage calls deliberate LESS than the authoring agents (AI_THINKING_LEVEL,
 * default "xhigh"): an author writes a long artifact, these judge or proofread a
 * single chapter. Merging the six per-stage knobs into this pair keeps that
 * separation while dropping the bookkeeping; the legacy names
 * (`<PREFIX>_THINKING` / `<PREFIX>_THINKING_LEVEL`) are still honored.
 *
 * @param {"VERIFY"|"AUDIT"|"EDIT"} prefix - The legacy per-stage prefix.
 * @returns {{thinking: boolean, thinkingLevel: string}}
 */
function stageThinking(prefix) {
  // The legacy per-stage prefix wins when set; otherwise the global AI_THINKING
  // decides. Both go through the shared readBoolEnv so the semantics match the
  // harness (previously the two readers disagreed on values like "0").
  const thinking = readBoolEnv(`${prefix}_THINKING`, readBoolEnv("AI_THINKING", true));
  const level =
    process.env[`${prefix}_THINKING_LEVEL`] ?? process.env.STAGE_THINKING_LEVEL;
  return {
    thinking,
    thinkingLevel:
      typeof level === "string" && level.trim() !== "" ? level.trim() : "medium",
  };
}

/**
 * Sampling temperature for a stage that WRITES text: the stage's own knob
 * (`<PREFIX>_TEMPERATURE`) when set, otherwise the global AI_TEMPERATURE.
 *
 * Used by polish (a rewrite pass — it follows the run's house temperature).
 * `translate` does NOT use this: Hy-MT2's 0.7 is part of the model's official
 * sampling recipe, not a house preference, so TRANSLATE_TEMPERATURE keeps its
 * own default.
 *
 * @param {"EDIT"} prefix - The stage prefix.
 * @param {number} fallback - Used when neither the stage knob nor AI_TEMPERATURE is set.
 * @returns {number}
 */
function writerTemperature(prefix, fallback) {
  const own = parseFloat(process.env[`${prefix}_TEMPERATURE`]);
  if (Number.isFinite(own)) return own;
  const global = parseFloat(process.env.AI_TEMPERATURE);
  return Number.isFinite(global) ? global : fallback;
}

/**
 * The ending of the volume that comes BEFORE this one in the manifest's reading
 * order, read from its published `translation.md` (the polished text wins there,
 * so the cue is the text a reader actually has).
 *
 * Chapters are not the only seams in a series: a new volume starts mid-scene
 * relative to the last one more often than a chapter does, and a translator told
 * nothing about how the previous book ended writes a new opening from scratch.
 * Reading order comes from the manifest, never from folder arithmetic — the
 * intake agent chooses the folder names.
 *
 * @param {string} seriesDir
 * @param {{volumes: Array<{folder: string, installmentNumber: string}>}} manifest
 * @param {string} folderName - The volume being translated.
 * @param {number} chars - How many chars of the ending to keep (TRANSLATE_CONTINUITY_CHARS).
 * @returns {Promise<{text: string, fromLabel: string}>} "" when this is the first volume or the previous one has no published text.
 */
async function previousVolumeTail(seriesDir, manifest, folderName, chars) {
  const idx = manifest.volumes.findIndex((v) => v.folder === folderName);
  if (idx <= 0) return { text: "", fromLabel: "" };
  const prev = manifest.volumes[idx - 1];
  const text = await readFileOrEmpty(path.join(seriesDir, prev.folder, MERGED_FILE));
  if (!text.trim()) return { text: "", fromLabel: "" };
  return { text: tailOf(text, chars), fromLabel: `Volume ${prev.installmentNumber}` };
}

// ─── Prompt budget (honest trimming) ────────────────────────────────────────

/**
 * A conservative token estimate for a piece of text.
 *
 * The pipeline has no tokenizer (the model server owns one), so this is a
 * deliberate OVER-estimate: over-estimating trims a little more than strictly
 * needed, which is the safe direction — under-estimating is how a request gets
 * rejected mid-run by the server.
 *
 * Per character:
 *   - Han / kana / Hangul ≈ 1 token each (a kanji is often more than one token,
 *     a kana usually less; 1 is the middle and errs high overall)
 *   - everything else (Latin, punctuation, whitespace) ≈ 0.35 tokens
 *
 * @param {string} text
 * @returns {number} Estimated token count (rounded up).
 */
function estimateTokens(text) {
  const t = text || "";
  let cjk = 0;
  for (const ch of t) {
    const cp = ch.codePointAt(0);
    const isCjk =
      (cp >= 0x3040 && cp <= 0x30ff) || // hiragana + katakana
      (cp >= 0x3400 && cp <= 0x4dbf) || // CJK ext A
      (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified
      (cp >= 0xac00 && cp <= 0xd7af) || // Hangul syllables
      (cp >= 0x1100 && cp <= 0x11ff) || // Hangul jamo
      (cp >= 0xf900 && cp <= 0xfaff); // CJK compatibility
    if (isCjk) cjk++;
  }
  return Math.ceil(cjk + (t.length - cjk) * 0.35);
}

/**
 * Fit the injected reference blocks into the model's context window, and SAY
 * what was dropped.
 *
 * Every stage injects terminology, story background, style rules and voice
 * notes on top of the chapter text. As the series grows those blocks grow, and
 * the request eventually exceeds the server's window — which the server reports
 * as a rejected call, and which the pipeline used to discover only by failing.
 * Trimming is unavoidable; trimming in SILENCE is not acceptable, because "the
 * model never saw the style rules" is exactly the kind of fact a reader of the
 * run must be able to see.
 *
 * Trim order (least useful first): voice notes → background → style rules →
 * terminology tail → continuity. The chapter text, the findings and the
 * instructions are never trimmed — if the source alone does not fit, the caller
 * must split the chapter (TRANSLATE_CHUNK_CHARS), not drop the text.
 *
 * @param {{
 *   blocks: Array<{name: string, text: string, priority: number}>,
 *   fixedTokens: number,
 *   roleWindow: number,
 *   outputReserve: number,
 * }} p - blocks to fit, plus the tokens already committed (source + instructions), the role's context window and the output cap to leave room for.
 * @returns {{blocks: Array<{name: string, text: string}>, dropped: Array<{name: string, chars: number}>, estimatedTokens: number, fits: boolean}}
 */
function fitPromptBudget({ blocks, fixedTokens, roleWindow, outputReserve }) {
  const budget = Math.max(0, roleWindow - outputReserve - fixedTokens);
  const kept = [];
  const dropped = [];
  // Highest priority first: keep the most useful blocks whole, and cut the
  // least useful ones down or out.
  const ordered = [...(blocks || [])].sort((a, b) => b.priority - a.priority);
  let used = 0;
  for (const block of ordered) {
    const text = block.text || "";
    if (!text.trim()) continue;
    const tokens = estimateTokens(text);
    if (used + tokens <= budget) {
      kept.push({ name: block.name, text });
      used += tokens;
      continue;
    }
    // Partially keep what fits (cut whole lines from the end, so a glossary
    // keeps its head rather than being sliced mid-entry).
    const lines = text.split("\n");
    const partial = [];
    let partialTokens = 0;
    for (const line of lines) {
      const lineTokens = estimateTokens(line + "\n");
      if (used + partialTokens + lineTokens > budget) break;
      partial.push(line);
      partialTokens += lineTokens;
    }
    if (partial.length > 0) {
      const omitted = lines.length - partial.length;
      kept.push({
        name: block.name,
        text:
          partial.join("\n") +
          `\n(… ${omitted} further line(s) of the ${block.name} were dropped to fit the ${roleWindow}-token context window)`,
      });
      used += partialTokens;
      dropped.push({ name: block.name, chars: text.length - partial.join("\n").length });
    } else {
      dropped.push({ name: block.name, chars: text.length });
    }
  }
  return {
    blocks: kept,
    dropped,
    estimatedTokens: fixedTokens + used,
    // "fits" means "everything was kept whole". A partial keep is still a loss
    // the caller must act on, so it is not reported as fitting.
    fits: dropped.length === 0,
  };
}

/**
 * Log a budget decision in one greppable line (and return the text the QA row
 * records), so a trimmed chapter is visible in both the run log and the report.
 *
 * @param {Array<{name: string, chars: number}>} dropped
 * @param {string} label - The chapter label (e.g. "Volume 03 ch5").
 * @returns {string} "" when nothing was dropped, else the sentence for the QA row.
 */
function describeDroppedBlocks(dropped, label) {
  if (!dropped || dropped.length === 0) return "";
  const text = `prompt trimmed for the context window — dropped ${dropped.map((d) => `${d.name} (${d.chars} chars)`).join(", ")}`;
  console.warn(`  ${label}: ${text}`);
  return text;
}

/**
 * Build the translation task lines under the model's context budget.
 *
 * The thin wrapper the four translation stages call: it fits the reference
 * blocks into the role's window (fitPromptBudget), rebuilds the task lines from
 * what survived, and returns the drop list so the caller can log it and record
 * it in the chapter's QA row.
 *
 * @param {{
 *   background?: string,
 *   styleRules?: string,
 *   voiceNotes?: string,
 *   terminologyLines?: string[],
 *   continuityText?: string,
 *   continuitySource?: string,
 *   findingsText?: string,
 *   sourceText: string,
 *   template: string,
 *   roleWindow: number,
 *   outputReserve: number,
 *   targetLanguage?: string,
 *   label?: string,
 * }} p
 * @returns {{tasks: string[], dropped: Array<{name: string, chars: number}>, estimatedTokens: number}}
 */
function buildBudgetedTaskLines({
  background = "",
  styleRules = "",
  voiceNotes = "",
  terminologyLines = [],
  continuityText = "",
  continuitySource = "the previous chapter",
  findingsText = "",
  scopeText = "",
  sourceText,
  template,
  roleWindow,
  outputReserve,
  targetLanguage = "English",
  label = "",
}) {
  // What the request carries no matter what: the chapter text, the prompt
  // template, and the fixed instruction lines. These are never trimmed — a
  // chapter that does not fit with them must be split (TRANSLATE_CHUNK_CHARS),
  // not squeezed by dropping the book.
  // The scope line is an instruction (it is what stops a passage pass from
  // re-translating the whole chapter), so it is fixed like the findings.
  const fixedTokens =
    estimateTokens(sourceText) +
    estimateTokens(template) +
    estimateTokens(findingsText) +
    estimateTokens(scopeText) +
    120;
  const terminologyText = terminologyLines.join("\n");
  const fitted = fitPromptBudget({
    blocks: [
      // Highest priority first (kept whole longest). Terminology is the one
      // block a later stage cannot repair, so it out-ranks atmosphere.
      { name: "glossary", text: terminologyText, priority: 5 },
      { name: "continuity", text: continuityText, priority: 4 },
      { name: "style rules", text: styleRules, priority: 3 },
      { name: "story background", text: background, priority: 2 },
      { name: "voice notes", text: voiceNotes, priority: 1 },
    ],
    fixedTokens,
    roleWindow,
    outputReserve,
  });
  const pick = (name) => {
    const b = fitted.blocks.find((x) => x.name === name);
    return b ? b.text : "";
  };
  if (fitted.dropped.length > 0 && label) describeDroppedBlocks(fitted.dropped, label);
  return {
    tasks: buildTranslationTaskLines({
      terminologyLines: pick("glossary") ? pick("glossary").split("\n") : [],
      background: pick("story background"),
      styleRules: pick("style rules"),
      voiceNotes: pick("voice notes"),
      continuityText: pick("continuity"),
      continuitySource,
      findingsText,
      scopeText,
      targetLanguage,
    }),
    dropped: fitted.dropped,
    estimatedTokens: fitted.estimatedTokens,
  };
}

// ─── Chapter-list consistency (the handoff vs the extraction) ────────────────

/**
 * Check the published `chapters.json` against the chapter list this run actually
 * extracted, and say loudly when they disagree.
 *
 * `bundle.segments` stays the source of truth for reading order (AGENTS.md
 * gotcha 20 — a filename sort misorders `chN` vs `chN.1`). But `chapters.json` is
 * what the per-volume handoff published, what `translation-brief.md` table is
 * built from, and what the series-level translation report reads to decide which
 * chapters exist. If the two disagree, the documents describing the book are
 * describing a DIFFERENT book than the one being translated — usually because the
 * source changed and the wiki task (which writes chapters.json) has not re-run.
 *
 * A warning, not an error: the pipeline can still translate the book it opened.
 * It just must not let the paperwork silently disagree about it.
 *
 * @param {string} volumeDir
 * @param {{segments: Array<{id: string, file: string, title?: string}>}} bundle
 * @returns {Promise<{ok: boolean, missing: string[], extra: string[], reason: string}>}
 */
async function checkChapterListConsistency(volumeDir, bundle) {
  let chaptersJson;
  try {
    chaptersJson = JSON.parse(await fs.readFile(path.join(volumeDir, "chapters.json"), "utf8"));
  } catch {
    return { ok: true, missing: [], extra: [], reason: "no chapters.json yet (the wiki task writes it)" };
  }
  const listed = Array.isArray(chaptersJson.chapters) ? chaptersJson.chapters : [];
  if (listed.length === 0) return { ok: true, missing: [], extra: [], reason: "chapters.json lists no chapters" };
  const listedIds = new Set(listed.map((c) => c && c.id));
  const bundleIds = new Set((bundle.segments || []).map((seg) => seg.id));
  const missing = [...bundleIds].filter((id) => !listedIds.has(id));
  const extra = [...listedIds].filter((id) => !bundleIds.has(id));
  if (missing.length === 0 && extra.length === 0) return { ok: true, missing: [], extra: [], reason: "" };
  const detail = [
    missing.length > 0 ? `this run has chapters the handoff does not list: ${missing.join(", ")}` : "",
    extra.length > 0 ? `the handoff lists chapters this run cannot find: ${extra.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("; ");
  console.warn(
    `[chapters] ${volumeDir}: chapters.json DISAGREES with the extracted chapter list — ${detail}. ` +
      `The extracted list is used. Re-run the jump-in-wiki task to refresh chapters.json and ` +
      `translation-brief.md (a changed source is the usual cause).`
  );
  return { ok: false, missing, extra, reason: detail };
}

// ─── Run estimate & progress ────────────────────────────────────────────────

/**
 * What the previous run of this pipeline actually achieved, measured from its
 * log: the average generation speed and how many calls it made.
 *
 * An overnight run needs to answer "is this healthy or stuck?" from the log
 * alone. The honest way to estimate how long a stage will take is the speed this
 * machine and this model already demonstrated — not a guessed constant. Returns
 * null when there is no previous run to measure (the first run of a series).
 *
 * @returns {Promise<{genTokPerSec: number, calls: number, logFile: string}|null>}
 */
async function previousRunThroughput() {
  const logsRoot = path.join(__dirname, "..", ".logs");
  let entries;
  try {
    entries = await fs.readdir(logsRoot);
  } catch {
    return null;
  }
  const dirs = entries.filter((e) => !e.startsWith(".")).sort().reverse();
  for (const dir of dirs) {
    const file = path.join(logsRoot, dir, "summary.log");
    let text;
    try {
      text = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    const speeds = [...text.matchAll(/\bgen=([0-9.]+) tok\/s/g)].map((m) => parseFloat(m[1]));
    const usable = speeds.filter((n) => Number.isFinite(n) && n > 0);
    if (usable.length === 0) continue;
    return {
      genTokPerSec: usable.reduce((a, b) => a + b, 0) / usable.length,
      calls: usable.length,
      logFile: file,
    };
  }
  return null;
}

/**
 * Print what a translation stage is about to do, before it starts doing it.
 *
 * The point is the number of model calls: a stage that will make 1,900 calls on
 * a local model is a decision the operator should be able to see at the start of
 * a run, not discover at 4am. When a previous run exists the estimate is
 * measured from it; otherwise the log says plainly that nothing is known yet.
 *
 * @param {{
 *   stage: string,
 *   volumes: number,
 *   chapters: number,
 *   callsPerChapter?: number,
 *   endpoint: {model: string, baseUrl: string},
 *   extra?: string,
 * }} p
 * @returns {Promise<string>} The estimate line that was printed.
 */
async function logRunEstimate({ stage, volumes, chapters, callsPerChapter = 1, endpoint, extra = "" }) {
  const calls = chapters * callsPerChapter;
  const measured = await previousRunThroughput();
  let line =
    `[${stage}] estimate: ${volumes} volume(s), ${chapters} chapter(s), ~${calls} model call(s) on ` +
    `${endpoint.model} @ ${endpoint.baseUrl}`;
  if (measured) {
    const outTokens = calls * 1200; // a chapter-length answer, roughly
    const minutes = outTokens / measured.genTokPerSec / 60;
    line +=
      `; measured ${measured.genTokPerSec.toFixed(1)} tok/s from ${measured.calls} call(s) of a previous ` +
      `run (${measured.logFile}) → roughly ${minutes < 1 ? "<1" : Math.round(minutes)} min of generation`;
  } else {
    line += "; no previous run log to measure against yet";
  }
  if (extra) line += `; ${extra}`;
  console.log(line);
  harnessLogLine(line);
  return line;
}

/** A log line that survives into .logs/ (the harness's own summary log). */
let harnessLogLine = (line) => console.error(line);
try {
  const h = require("../harness");
  if (typeof h.logLine === "function") harnessLogLine = h.logLine;
} catch {
  // utils/ must not hard-depend on the AI layer; the console line is enough.
}

/**
 * A running counter for a batch, so a long stage can be read from the log:
 * "chapter 14/380" answers "is it moving?" without waiting for the volume to end.
 *
 * @param {number} total
 * @param {string} [unit] - What is being counted ("chapter", "volume", "candidate").
 * @returns {(label: string) => void} Call it once per completed unit.
 */
function progressCounter(total, unit = "chapter") {
  let done = 0;
  return function progress(label) {
    done += 1;
    const line = `[progress] ${unit} ${done}/${total}${label ? ` — ${label}` : ""}`;
    console.log(line);
    harnessLogLine(line);
  };
}

/**
 * How many chapters a stage is about to walk, without doing the stage's work.
 *
 * Read from `chapters.json` (the handoff the wiki task writes for exactly this
 * purpose) when it exists; otherwise the source bundle is resolved, which is the
 * same cached extraction the stage itself will use. The number is printed before
 * the stage starts, because "1,900 model calls" is a decision the operator should
 * see at the start of a run, not discover halfway through one.
 *
 * @param {{seriesDir: string, volumes: Array<{folder: string, sourceFile: string, installmentNumber: string}>, force?: boolean}} p
 * @returns {Promise<{chapters: number, perVolume: Array<{folder: string, chapters: number}>, unresolved: string[]}>}
 */
async function countStageChapters({ seriesDir, volumes, force = false }) {
  const perVolume = [];
  const unresolved = [];
  let chapters = 0;
  for (const volume of volumes) {
    const volumeDir = path.join(seriesDir, volume.folder);
    let count = null;
    try {
      const chaptersJson = JSON.parse(await fs.readFile(path.join(volumeDir, "chapters.json"), "utf8"));
      if (Array.isArray(chaptersJson.chapters)) count = chaptersJson.chapters.length;
    } catch {
      count = null;
    }
    if (count === null) {
      try {
        const { resolveSourceBundle } = require("./source");
        const bundle = await resolveSourceBundle({ seriesDir, volume, volumeDir, force: false });
        count = bundle.segments.length;
      } catch {
        unresolved.push(volume.folder);
        continue;
      }
    }
    perVolume.push({ folder: volume.folder, chapters: count });
    chapters += count;
  }
  return { chapters, perVolume, unresolved };
}

// ─── Rendering variant scan (deterministic, no model) ────────────────────────

/**
 * Find near-variants of the canonical renderings in a published volume.
 *
 * The most common drift class in a long translation is not a wrong word — it is
 * the SAME thing being written two ways: "Sora" and "sora", "Blacksteel" and
 * "Black steel", 鏡 rendered as "Mirror" in chapter 2 and "the Mirror system" in
 * chapter 7. A model-based verifier is a poor detector for this (it reads the
 * chapter, not the volume) and it is completely free to check deterministically,
 * so it runs on every volume with no token spent.
 *
 * What it reports:
 *   HIGH  — the glossary gives this source term two different renderings and the
 *           volume uses more than one of them (a real terminology conflict).
 *   MEDIUM — the canonical rendering appears in the volume in a differently
 *           hyphenated/spaced form ("Blacksteel" vs "Black steel").
 *   LOW   — the canonical rendering appears in a different case, or as a plural
 *           alongside the singular (often legitimate, so it is only reported).
 *
 * @param {{text: string, terms: Array<{term: string, rendering: string, section?: string}>, targetLanguage?: string}} p
 * @returns {Array<{term: string, canonical: string, variant: string, count: number, kind: string, severity: "HIGH"|"MEDIUM"|"LOW"}>}
 */
function findRenderingVariants({ text, terms = [], targetLanguage = "English" }) {
  const body = text || "";
  if (!body.trim() || terms.length === 0) return [];
  const wordBoundary = isSpaceSeparated(targetLanguage);
  const findings = [];

  // Escape a rendering for regex use, then allow the separators a human types
  // around a name ("Blacksteel" also appears as "Black steel" / "Black-steel").
  const escape = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const loosePattern = (rendering) => {
    // Separators are optional BETWEEN THE WORDS and also INSIDE a single word of
    // the canonical form: the drift this looks for is exactly a name written with
    // an extra space or hyphen ("Blacksteel" in the glossary, "Black steel" in
    // chapter 7). Only whitespace / hyphen / dash / underscore may appear, so a
    // match is still the same word. Each character is escaped on its own (an
    // escaped pair like `\.` must not be split in half).
    const SEP = "[\\s\\-_\\u2013\\u2014]*";
    const SEP1 = "[\\s\\-_\\u2013\\u2014]+";
    const words = rendering.trim().split(/\s+/).filter(Boolean);
    const core = words
      .map((word) => [...word].map(escape).join(SEP))
      .join(SEP1);
    return new RegExp(`(^|[^\\p{L}\\p{N}])(${core})(s)?(?=[^\\p{L}\\p{N}]|$)`, "giu");
  };

  // Two glossary rows for the same source term is a conflict the volume inherits.
  const bySource = new Map();
  for (const t of terms) {
    if (!t || !t.term || !t.rendering) continue;
    const key = t.term.trim();
    if (!bySource.has(key)) bySource.set(key, new Set());
    bySource.get(key).add(t.rendering.trim());
  }

  for (const [sourceTerm, renderings] of bySource) {
    if (renderings.size < 2) continue;
    const present = [];
    for (const rendering of renderings) {
      const re = new RegExp(escape(rendering), wordBoundary ? "giu" : "gi");
      const n = (body.match(re) || []).length;
      if (n > 0) present.push({ rendering, count: n });
    }
    if (present.length < 2) continue;
    findings.push({
      term: sourceTerm,
      canonical: [...renderings].join(" / "),
      variant: present.map((p) => `"${p.rendering}" ×${p.count}`).join(", "),
      count: present.reduce((n, p) => n + p.count, 0),
      kind: "the glossary gives this term two renderings and the volume uses both",
      severity: "HIGH",
    });
  }

  for (const t of terms) {
    const canonical = (t.rendering || "").trim();
    if (!canonical || canonical.length < 2) continue;
    const re = loosePattern(canonical);
    const forms = new Map();
    let m;
    while ((m = re.exec(body)) !== null) {
      // The captured form INCLUDES the trailing "s" when there was one — recording
      // "Mirrors" as "Mirror" (plural flag only) made it land in the same bucket
      // as the canonical form and vanish.
      const plural = m[3] === "s";
      const surface = m[2] + (plural ? "s" : "");
      forms.set(surface, { surface, plural, count: (forms.get(surface)?.count || 0) + 1 });
      if (re.lastIndex === m.index) re.lastIndex++;
    }
    if (forms.size === 0) continue;

    const canonicalLower = canonical.toLowerCase();
    // Keyed by the EXACT surface form (not a lowercased one) — collapsing case
    // first is what made a capitalisation drift invisible: "Sora" and "sora"
    // would land in the same bucket and look like the canonical form.
    const hasCanonicalSingular = forms.has(canonical);
    for (const [surface, entry] of forms) {
      const lower = surface.toLowerCase();
      if (surface === canonical) continue; // the canonical form itself
      // Spacing / hyphenation difference.
      const squash = (x) => x.toLowerCase().replace(/[\s\-_\u2013\u2014]+/g, "");
      if (!entry.plural && squash(surface) === squash(canonical) && lower !== canonicalLower) {
        findings.push({
          term: t.term,
          canonical,
          variant: surface,
          count: entry.count,
          kind: "the canonical rendering appears with different spacing or hyphenation",
          severity: "MEDIUM",
        });
        continue;
      }
      // Case difference (the same letters, a different capitalisation).
      if (!entry.plural && lower === canonicalLower) {
        findings.push({
          term: t.term,
          canonical,
          variant: surface,
          count: entry.count,
          kind: "the canonical rendering appears with different capitalisation",
          severity: "LOW",
        });
        continue;
      }
      // A plural alongside the singular form.
      if (entry.plural && hasCanonicalSingular) {
        findings.push({
          term: t.term,
          canonical,
          variant: surface,
          count: entry.count,
          kind: "the canonical rendering also appears as a plural (check it is the same referent)",
          severity: "LOW",
        });
      }
    }
  }

  // One finding per (term, variant) — the same drift seen in ten chapters is one
  // finding about the volume.
  const deduped = new Map();
  for (const f of findings) {
    const key = `${f.term}\u0000${f.variant.toLowerCase()}\u0000${f.kind}`;
    const prev = deduped.get(key);
    if (!prev) deduped.set(key, { ...f });
    else prev.count += f.count;
  }
  const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  return [...deduped.values()].sort((a, b) => order[a.severity] - order[b.severity] || b.count - a.count);
}

/**
 * Render the variant scan as a Markdown section (the verification report's
 * deterministic half — no model call produced it).
 *
 * @param {Array<Object>} findings
 * @returns {string}
 */
function renderVariantFindings(findings) {
  if (!findings || findings.length === 0) return "";
  const lines = [];
  lines.push("## Rendering variants (deterministic scan — no model call)");
  lines.push("");
  lines.push(
    "_Every glossary term used in this volume was scanned in the published text for near-variants of " +
      "its canonical rendering: a second rendering of the same source term, different spacing or " +
      "hyphenation, different capitalisation, or a plural alongside the singular._"
  );
  lines.push("");
  lines.push("| Severity | Source term | Canonical | Seen as | Count |");
  lines.push("|---|---|---|---|---|");
  for (const f of findings) {
    lines.push(`| ${f.severity} | ${f.term} | ${f.canonical} | ${f.variant} — ${f.kind} | ${f.count} |`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Resolve the text each chapter of a volume ACTUALLY publishes — the same rule
 * `mergeVolumeTranslation` uses (accepted polish wins when it was produced from
 * the current draft, otherwise the draft), exposed as a list so the volume-level
 * checks read exactly what the reader reads.
 *
 * Without this, the cross-chapter audit and the variant scan would judge one
 * text while `translation.md` published another.
 *
 * @param {string} volumeDir
 * @param {{segments: Array<Object>}} bundle
 * @param {{chapters?: Object}} state - The translation state (may be empty).
 * @returns {Promise<Array<{id: string, title: string, syntheticTitle?: boolean, file: string, text: string, from: "draft"|"polished"|"none"}>>}
 */
async function resolvePublishedChapterTexts(volumeDir, bundle, state) {
  const chapters = (state && state.chapters) || {};
  const out = [];
  for (const seg of bundle.segments) {
    const { draftFile, polishedFile } = chapterArtifactNames(seg.id);
    const entry = chapters[seg.id] || {};
    let text = "";
    let from = "none";
    if (entry.draftHash && entry.polishedDraftHash === entry.draftHash) {
      const polished = await readFileOrEmpty(path.join(volumeDir, polishedFile));
      if (polished.trim()) {
        text = polished.trim();
        from = "polished";
      }
    }
    if (!text) {
      const draft = await readFileOrEmpty(path.join(volumeDir, draftFile));
      if (draft.trim()) {
        text = draft.trim();
        from = "draft";
      }
    }
    out.push({
      id: seg.id,
      title: seg.title,
      syntheticTitle: seg.syntheticTitle === true,
      file: seg.file,
      text,
      from,
    });
  }
  return out;
}

// ─── Targeted correction (fix the passage, not the chapter) ─────────────────

/**
 * Split a text into paragraph blocks, losslessly (blocks joined by "\n\n"
 * reproduce the original apart from blank-line normalization).
 *
 * @param {string} text
 * @returns {string[]}
 */
function paragraphBlocks(text) {
  return (text || "")
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
}

/**
 * Split a findings block into its individual finding items.
 *
 * The graders write a numbered list (or FINDING blocks); each item carries its
 * own `Source: "…"` quote. Splitting them is what makes a targeted repair
 * possible: a finding about paragraph 7 must not be injected into the pass that
 * is rewriting paragraph 2.
 *
 * @param {string} findingsText - The findings text stored in the sidecar.
 * @returns {Array<{text: string, quote: string}>}
 */
function parseFindingItems(findingsText) {
  const text = (findingsText || "").trim();
  if (!text) return [];
  const items = [];
  let current = null;
  for (const line of text.split("\n")) {
    if (/^\s*(?:\d+\.\s|\[(?:HIGH|MEDIUM|LOW)\]|FINDING\b)/i.test(line)) {
      if (current) items.push(current);
      current = [line];
      continue;
    }
    if (current) current.push(line);
  }
  if (current) items.push(current);
  return items
    .map((lines) => {
      const itemText = lines.join("\n").trim();
      const m = itemText.match(/Source:\s*"([^"]+)"/i);
      return { text: itemText, quote: m ? m[1] : "" };
    })
    .filter((item) => item.text && !/^##\s*Findings$/i.test(item.text));
}

/**
 * Locate a verbatim quote inside a list of source paragraphs.
 *
 * All whitespace is removed on both sides (a quote copied out of a findings list
 * rarely keeps the source's line breaks, and source-language text has no word
 * spaces), and the search runs over the joined paragraphs so a quote that spans
 * two of them still resolves — to BOTH of them.
 *
 * @param {string[]} sourceBlocks - Source paragraphs in order.
 * @param {string} quote - The verbatim quote to find.
 * @returns {{start: number, end: number}|null} The paragraph range, or null when the quote is not in the source.
 */
function locateQuoteRange(sourceBlocks, quote) {
  // Whitespace is removed on BOTH sides. A quote copied out of a findings list
  // rarely keeps the source's line breaks, and source-language text (Japanese,
  // Chinese) has no word spaces at all — joining paragraphs with a space would
  // make a quote that crosses a paragraph boundary impossible to find.
  const squash = (t) => (t || "").replace(/\s+/g, "");
  const q = squash(quote);
  if (!q) return null;
  let joined = "";
  const ranges = [];
  for (const b of sourceBlocks) {
    const start = joined.length;
    joined += squash(b);
    ranges.push({ start, end: joined.length });
  }
  const at = joined.indexOf(q);
  if (at < 0) return null;
  const stop = at + q.length;
  const hit = ranges.findIndex((r) => r.end > at && r.start < stop);
  if (hit < 0) return null;
  let last = hit;
  while (last + 1 < ranges.length && ranges[last + 1].start < stop) last++;
  return { start: hit, end: last };
}

/**
 * Decide whether a chapter can be repaired by re-translating only the passages
 * its verification findings point at — and which passages those are.
 *
 * Today a chapter with ONE bad sentence is translated again from scratch: a
 * whole chapter of generation to fix a paragraph, with a fresh chance to break
 * something that was already right. The findings quote short source spans, so
 * the spans can be located, and the corrected text stitched back into the draft.
 *
 * The plan is refused (and the caller runs the whole-chapter pass) whenever the
 * mapping is not trustworthy:
 *   - the source and the draft do not have the same number of paragraphs
 *     (the paragraph-preserving translation contract is broken, so there is no
 *     honest way to say which draft paragraph a source quote belongs to);
 *   - a finding quotes source text that cannot be found;
 *   - the affected span covers the chapter (then a fresh pass is both cheaper
 *     and safer);
 *   - an affected draft paragraph is not a plausible rendering of its source
 *     paragraph (the strongest sign that the alignment is wrong).
 *
 * @param {{sourceText: string, draftText: string, findingsText: string, maxCoverage?: number}} p
 * @returns {{usable: boolean, reason: string, blocks: Array<{start: number, end: number, quotes: string[], findings: string[]}>}}
 */
function planTargetedRepair({ sourceText, draftText, findingsText, maxCoverage = 0.5 }) {
  const none = { usable: false, reason: "", blocks: [] };
  const sourceBlocks = paragraphBlocks(sourceText);
  const draftBlocks = paragraphBlocks(draftText);
  if (sourceBlocks.length < 2 || draftBlocks.length < 2) {
    return { ...none, reason: "the chapter has too few paragraphs for a passage-level repair" };
  }
  if (sourceBlocks.length !== draftBlocks.length) {
    return {
      ...none,
      reason:
        `the source has ${sourceBlocks.length} paragraphs and the draft has ${draftBlocks.length} — ` +
        `they cannot be aligned, so a passage-level repair would guess which paragraph to replace`,
    };
  }
  const items = parseFindingItems(findingsText);
  if (items.length === 0) return { ...none, reason: "the findings name no individual problem to fix" };

  const located = [];
  const chapterWide = [];
  for (const item of items) {
    const range = item.quote ? locateQuoteRange(sourceBlocks, item.quote) : null;
    if (range) located.push({ ...range, quote: item.quote, finding: item.text });
    else chapterWide.push(item);
  }
  if (located.length === 0) {
    return {
      ...none,
      reason: "no finding quotes a span that can be located in the source (a structural finding needs the whole chapter)",
    };
  }

  // Merge nearby spans so one call repairs one passage instead of one sentence.
  const merged = [];
  for (const l of [...located].sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1];
    if (last && l.start - last.end <= 2) {
      last.end = Math.max(last.end, l.end);
      last.quotes.push(l.quote);
      last.findings.push(l.finding);
    } else {
      merged.push({ start: l.start, end: l.end, quotes: [l.quote], findings: [l.finding] });
    }
  }
  const affected = merged.reduce((n, b) => n + (b.end - b.start + 1), 0);
  if (affected >= sourceBlocks.length) {
    return { ...none, reason: "every paragraph is affected — a whole-chapter pass is the cheaper and safer rewrite" };
  }
  if (affected / sourceBlocks.length > maxCoverage) {
    return {
      ...none,
      reason:
        `${affected} of ${sourceBlocks.length} paragraphs are affected ` +
        `(over ${Math.round(maxCoverage * 100)}% of the chapter) — not worth stitching`,
    };
  }
  for (const b of merged) {
    const srcLen = sourceBlocks.slice(b.start, b.end + 1).join(" ").length;
    const draftLen = draftBlocks.slice(b.start, b.end + 1).join(" ").length;
    const ratio = draftLen / Math.max(1, srcLen);
    if (ratio < 0.25 || ratio > 5) {
      return {
        ...none,
        reason:
          `draft paragraphs ${b.start + 1}–${b.end + 1} do not look like a translation of the source span ` +
          `they would be swapped for (length ratio ${ratio.toFixed(2)})`,
      };
    }
  }
  // A finding with no locatable span is chapter-wide: it goes to every passage
  // pass, because dropping it would silently drop a real problem.
  for (const b of merged) {
    b.findings.push(...chapterWide.map((i) => i.text));
  }
  return {
    usable: true,
    reason: `${merged.length} passage(s), ${affected}/${sourceBlocks.length} paragraphs`,
    blocks: merged,
  };
}

/**
 * Stitch corrected passages back into the draft: untouched paragraphs are kept
 * byte-for-byte, so a repair cannot quietly rewrite the rest of the chapter.
 *
 * @param {string[]} draftBlocks
 * @param {Array<{start: number, end: number}>} blocks - In ascending order, non-overlapping.
 * @param {string[]} replacements - One corrected text per block.
 * @returns {string} The stitched draft.
 */
function stitchParagraphs(draftBlocks, blocks, replacements) {
  const out = [];
  let cursor = 0;
  for (const [i, b] of blocks.entries()) {
    for (; cursor < b.start; cursor++) out.push(draftBlocks[cursor]);
    const text = (replacements[i] || "").trim();
    if (!text) throw new Error(`stitchParagraphs: no corrected text for passage ${b.start + 1}–${b.end + 1}`);
    out.push(text);
    cursor = b.end + 1;
  }
  for (; cursor < draftBlocks.length; cursor++) out.push(draftBlocks[cursor]);
  return out.join("\n\n");
}

/**
 * The "you are correcting a passage, not translating a chapter" task line.
 *
 * The surrounding translated text is given so names, tense, register and voice
 * stay identical at the seams — without it the model writes a fresh opening and
 * the stitched chapter reads as two different translations welded together.
 *
 * @param {{before?: string, after?: string, blockNumber: number, blockCount: number}} p
 * @returns {string}
 */
function buildPassageScopeLine({ before = "", after = "", blockNumber, blockCount }) {
  const parts = [
    `You are correcting ONE passage (${blockNumber} of ${blockCount}) of a longer chapter that is ` +
      `already translated. Translate ONLY the [Source Text] below.`,
  ];
  if (before.trim()) {
    parts.push(
      `Your text FOLLOWS this already-translated ending — keep names, tense, register and voice identical ` +
        `and do not repeat it:\n   …${before.trim()}`
    );
  }
  if (after.trim()) {
    parts.push(
      `Your text is FOLLOWED by this already-translated opening — keep names, tense, register and voice ` +
        `identical and do not translate it:\n   ${after.trim()}…`
    );
  }
  return parts.join("\n");
}

// ─── Volume-level consistency pass (the cross-chapter blind spot) ───────────

/**
 * Pack a volume's chapters into consecutive windows that each fit the audit
 * model's prompt budget.
 *
 * The cross-chapter audit is the one check that must see several chapters at
 * once, so it cannot be split the way the per-chapter checks are. When a volume
 * is bigger than the role's context window, splitting it into consecutive
 * windows keeps every chapter audited against its neighbours (each window
 * carries the previous window's tail), which is what the check is FOR — and the
 * report says plainly which windows were audited together and which were not.
 *
 * A single chapter larger than the whole budget gets its own window and is
 * flagged `oversized`: the caller reports it rather than pretending it was
 * audited against its neighbours.
 *
 * @param {Array<{id: string, title?: string, text: string}>} chapters - Chapters in reading order.
 * @param {{maxTokens: number, reserve?: number}} budget - The role's window and the room kept for the reply.
 * @returns {Array<{chapters: Array<{id: string, title?: string, text: string}>, tokens: number, oversized: boolean}>}
 */
function planConsistencyWindows(chapters, { maxTokens, reserve = 0 }) {
  const budget = Math.max(1000, (maxTokens || 0) - reserve);
  const windows = [];
  let current = [];
  let tokens = 0;
  for (const ch of chapters) {
    const cost = estimateTokens(ch.text) + 40;
    if (current.length > 0 && tokens + cost > budget) {
      windows.push({
        chapters: current,
        tokens,
        oversized: estimateTokens(current[0].text) > budget,
      });
      current = [];
      tokens = 0;
    }
    current.push(ch);
    tokens += cost;
  }
  if (current.length > 0) {
    windows.push({
      chapters: current,
      tokens,
      oversized: current.length === 1 && estimateTokens(current[0].text) > budget,
    });
  }
  return windows;
}

/**
 * Escape a string for safe use inside a RegExp.
 *
 * @param {string} text
 * @returns {string}
 */
function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Parse the cross-chapter auditor's reply into structured findings.
 *
 * The contract (system-prompts/volume-consistency.md) is
 * `FINDING [HIGH] chapters=ch3,ch9 — statement` plus Where/Contradicts/Fix
 * lines. Chapter ids are matched against the ids the pass actually sent, so a
 * chapter is never invented and a finding that names no real chapter is
 * reported as unfixable rather than silently attached to the wrong one.
 *
 * @param {string} raw - The auditor's reply.
 * @param {string[]} chapterIds - The chapter ids that were in the prompt.
 * @returns {Array<{severity: string, chapters: string[], statement: string, quote: string, contradicts: string, fix: string, untagged: boolean}>}
 */
function parseVolumeFindings(raw, chapterIds) {
  const text = (raw || "").trim();
  if (!text || /^\(no findings\)/i.test(text)) return [];
  const lines = text.split("\n");
  const findings = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    const known = [];
    for (const id of chapterIds || []) {
      // Match the id as a whole token so "ch1" does not claim "ch1.1".
      const pattern = new RegExp(`(^|[^0-9A-Za-z.])${escapeRegExp(id)}([^0-9A-Za-z.]|$)`);
      if (pattern.test(current.searchText)) known.push(id);
    }
    findings.push({
      severity: current.severity,
      chapters: known,
      statement: current.statement,
      quote: current.quote,
      contradicts: current.contradicts,
      fix: current.fix,
      untagged: known.length === 0,
    });
    current = null;
  };
  for (const line of lines) {
    const head = line.match(
      /^\s*(?:\d+\.\s*)?FINDING\s*\[(HIGH|MEDIUM|LOW)\]\s*(?:chapters=([^\s—–\-]+))?\s*(?:[—–\-]+\s*)?(.*)$/i
    );
    if (head) {
      flush();
      const named = (head[2] || "").split(",").map((x) => x.trim()).filter(Boolean);
      current = {
        severity: String(head[1] || "MEDIUM").toUpperCase(),
        statement: (head[3] || "").trim(),
        quote: "",
        contradicts: "",
        fix: "",
        // The ids named on the heading line are part of the search text too.
        searchText: [head[2] || "", head[3] || ""].join(" "),
      };
      void named;
      continue;
    }
    if (!current) continue;
    const where = line.match(/^\s*Where:\s*"?(.*?)"?\s*$/i);
    if (where) {
      current.quote = where[1];
      current.searchText += " " + where[1];
      continue;
    }
    const against = line.match(/^\s*Contradicts:\s*"?(.*?)"?\s*$/i);
    if (against) {
      current.contradicts = against[1];
      current.searchText += " " + against[1];
      continue;
    }
    const fix = line.match(/^\s*Fix:\s*(.*)$/i);
    if (fix) {
      current.fix = fix[1].trim();
      continue;
    }
  }
  flush();
  return findings;
}

/**
 * What the retranslate pass should do with one chapter, given its per-chapter
 * verdict AND the volume-level findings that name it.
 *
 * The two inputs are different kinds of problem: the per-chapter verdict says
 * "this chapter does not match its source"; the volume findings say "this
 * chapter contradicts its neighbours". A chapter can be fine by the first and
 * broken by the second, and only the second kind is invisible to the chapter's
 * own check — so a HIGH cross-chapter finding makes a PASSING chapter a repair
 * target whatever its score.
 *
 * @param {{pass?: boolean, score?: number|null}|undefined} vEntry - The chapter's verification entry.
 * @param {Array<{severity: string}>} [volumeFindings] - Volume findings that name this chapter.
 * @returns {{action: "none"|"skip"|"fail"|"cross-chapter", reason: string}}
 */
function retranslateTarget(vEntry, volumeFindings = []) {
  const high = (volumeFindings || []).filter((f) => f && f.severity === "HIGH");
  if (!vEntry || typeof vEntry.pass !== "boolean") {
    return { action: "none", reason: "no verification verdict covers this draft" };
  }
  if (vEntry.pass) {
    if (high.length > 0) {
      return { action: "cross-chapter", reason: `${high.length} HIGH cross-chapter finding(s)` };
    }
    return { action: "skip", reason: "verification passed" };
  }
  return { action: "fail", reason: "verification failed" };
}

/**
 * Render volume findings back into the numbered "fix these" task the
 * retranslate pass takes (the same shape the per-chapter findings take).
 *
 * @param {Array<Object>} findings - Already narrowed to one chapter.
 * @returns {string} "" when there is nothing to fix.
 */
function volumeFindingsText(findings) {
  if (!Array.isArray(findings) || findings.length === 0) return "";
  const lines = findings.map((f, i) => {
    const parts = [`${i + 1}. [${f.severity}] ${f.statement}`];
    if (f.quote) parts.push(`   Volume says: "${f.quote}"`);
    if (f.contradicts) parts.push(`   But elsewhere: "${f.contradicts}"`);
    if (f.fix) parts.push(`   Fix: ${f.fix}`);
    const others = (f.chapters || []).filter((c) => c !== f.homeChapter);
    if (others.length > 0) {
      parts.push(`   (this contradiction also involves: ${others.join(", ")} — change ONLY the text you are given here)`);
    }
    return parts.join("\n");
  });
  return (
    `## Cross-chapter problems found in this volume\n` +
    `A volume-level audit compared these chapters with each other and with the ` +
    `previous volume. Fix these in the text you are translating. Do not introduce ` +
    `the other chapters' wording into this one beyond what the contradiction requires.\n\n` +
    lines.join("\n")
  );
}

/**
 * The volume findings that name one chapter (the retranslate pass's input).
 *
 * @param {Array<Object>} findings - The sidecar's findings.
 * @param {string} segmentId - The chapter being retranslated.
 * @returns {Array<Object>} The findings that name it, each with `homeChapter` set.
 */
function findingsForChapter(findings, segmentId) {
  return (Array.isArray(findings) ? findings : [])
    .filter((f) => Array.isArray(f.chapters) && f.chapters.includes(segmentId))
    .map((f) => ({ ...f, homeChapter: segmentId }));
}

/**
 * The volume-consistency report (human-readable, deterministic).
 *
 * @param {{installmentNumber: string, folder: string}} volume
 * @param {Array<{chapters: Array<{id: string}>, tokens: number, oversized: boolean}>} windows
 * @param {Array<Object>} findings
 * @param {{model?: string, notes?: string[], dropped?: string[]}} meta
 * @returns {string}
 */
function buildVolumeConsistencyMarkdown(volume, windows, findings, meta = {}) {
  const lines = [];
  lines.push(`# Volume ${volume.installmentNumber} — Cross-Chapter Consistency Report`);
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Auditor endpoint: ${meta.model || "AUDIT_* role"}`);
  lines.push(`Audit windows: ${windows.length} (each window is audited as one document)`)
  lines.push("");
  lines.push(`**Why this pass exists:** every other translation check reads ONE chapter ` +
    `at a time. A chapter can score 92/100 and still contradict the chapter before it — ` +
    `a second rendering of the same name, a fact one chapter states and another denies, ` +
    `a tense or point-of-view shift nothing else can see. This is the only pass that reads ` +
    `the chapters together.`);
  lines.push("");
  if (windows.length > 1) {
    lines.push(`## Audit windows`);
    lines.push("");
    lines.push("| Window | Chapters | Approx. tokens |");
    lines.push("|---|---|---|");
    for (const [i, w] of windows.entries()) {
      lines.push(`| ${i + 1} | ${w.chapters.map((c) => c.id).join(", ")} | ${w.tokens} |`);
    }
    lines.push("");
    lines.push(`Chapters in different windows were NOT compared with each other (the volume ` +
      `is larger than the auditor's context window).`);
    lines.push("");
  }
  const oversized = windows.filter((w) => w.oversized);
  if (oversized.length > 0) {
    lines.push(`> **Not audited against its neighbours:** ${oversized.map((w) => w.chapters.map((c) => c.id).join(", ")).join("; ")} ` +
      `— each is larger than the auditor's whole context window.`);
    lines.push("");
  }
  if (meta.dropped && meta.dropped.length > 0) {
    lines.push(`> **Reference material the auditor did NOT see:** ${meta.dropped.join("; ")}`);
    lines.push("");
  }
  lines.push(`## Findings (${findings.length})`);
  lines.push("");
  if (findings.length === 0) {
    lines.push(`No cross-chapter contradictions found.`);
  } else {
    const counts = { HIGH: 0, MEDIUM: 0, LOW: 0 };
    for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;
    lines.push(`HIGH: ${counts.HIGH || 0} · MEDIUM: ${counts.MEDIUM || 0} · LOW: ${counts.LOW || 0}`);
    lines.push("");
    for (const [i, f] of findings.entries()) {
      lines.push(`${i + 1}. **[${f.severity}]** ${f.statement}`);
      lines.push(`   - Chapters: ${f.chapters.length > 0 ? f.chapters.join(", ") : "**none named** (not actionable)"}`);
      if (f.quote) lines.push(`   - Volume says: "${f.quote}"`);
      if (f.contradicts) lines.push(`   - But elsewhere: "${f.contradicts}"`);
      if (f.fix) lines.push(`   - Fix: ${f.fix}`);
      lines.push("");
    }
    lines.push(`HIGH findings name chapters that the \`retranslate\` pass repairs with these`);
    lines.push(`findings injected as correction tasks. The draft ratchet guarantees a repair`);
    lines.push(`that scores worse than the chapter it replaced is rolled back.`);
    lines.push("");
  }
  if (meta.notes && meta.notes.length > 0) {
    lines.push(`## Notes`);
    lines.push("");
    for (const n of meta.notes) lines.push(`- ${n}`);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Read the volume-consistency sidecar (fail-open: a missing or corrupt file is
 * "no findings", never a crash — the pass is an extra pair of eyes, not a gate).
 *
 * @param {string} volumeDir
 * @returns {Promise<Object>}
 */
async function loadVolumeConsistency(volumeDir) {
  const raw = await readFileOrEmpty(path.join(volumeDir, VOLUME_CONSISTENCY_FILE));
  if (!raw) return { schema: 1, findings: [], windows: [] };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { schema: 1, findings: [], windows: [] };
    if (!Array.isArray(parsed.findings)) parsed.findings = [];
    if (!Array.isArray(parsed.windows)) parsed.windows = [];
    return parsed;
  } catch {
    return { schema: 1, findings: [], windows: [] };
  }
}

/**
 * Write the volume-consistency sidecar.
 *
 * @param {string} volumeDir
 * @param {Object} data
 * @returns {Promise<void>}
 */
async function saveVolumeConsistency(volumeDir, data) {
  await fs.writeFile(
    path.join(volumeDir, VOLUME_CONSISTENCY_FILE),
    JSON.stringify(data, null, 2) + "\n",
    "utf8"
  );
}

// ─── Verification verdicts & the draft ratchet ──────────────────────────────

/**
 * The median of a list of scores (the middle value of the sorted list; the
 * mean of the two middle values when the count is even).
 *
 * The median is what makes a repeated grade useful: one outlier sample cannot
 * move the verdict, and a third sample at temperature 0 settles a disagreement.
 *
 * @param {number[]} scores
 * @returns {number|null} The median, or null when there is no numeric score.
 */
function medianScore(scores) {
  const nums = (scores || []).filter((s) => typeof s === "number" && Number.isFinite(s));
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

/**
 * Does a verification sidecar entry still describe the chapter's CURRENT draft?
 *
 * A verdict is only meaningful for the exact text it graded: a retranslate
 * (new draftHash) or a changed source (new sourceHash) invalidates it. The
 * comparison is made against the translation-state entry, so a polished chapter
 * keeps the verdict its draft earned.
 *
 * @param {Object} verdictEntry - The sidecar entry for the chapter.
 * @param {Object} stateEntry - The chapter's translation-state entry.
 * @returns {boolean} True when the verdict covers the current draft.
 */
function verdictCoversCurrentDraft(verdictEntry, stateEntry) {
  if (!verdictEntry || !stateEntry) return false;
  return (
    typeof verdictEntry.sourceHash === "string" &&
    verdictEntry.sourceHash === stateEntry.sourceHash &&
    typeof verdictEntry.draftHash === "string" &&
    verdictEntry.draftHash === stateEntry.draftHash
  );
}

/**
 * The line the merged translation.md puts under a chapter that did not pass
 * verification.
 *
 * The published book must carry its own verdict (the merge used to publish a
 * polished chapter that had FAILED verification at 57/100 with nothing on the
 * page saying so). The marker is deliberately visible in the rendered Markdown
 * rather than hidden in a comment: a reader must not have to know the pipeline
 * exists to learn that a chapter is unverified.
 *
 * @param {{score: number|null, pass: boolean|null, reason: string}} verdict
 * @returns {string} The Markdown marker line.
 */
function unverifiedMarker(verdict) {
  const score =
    typeof verdict.score === "number" ? `verification score ${verdict.score}/100` : "no verification score";
  return (
    `> **⚠ UNVERIFIED** — this chapter did not pass translation verification (${score}). ` +
    `Reason: ${verdict.reason}. See this volume's \`translation-verification.md\`.`
  );
}

/**
 * Restore the best-scoring draft for every chapter whose newest draft scored
 * WORSE than the best one already recorded (the ratchet).
 *
 * Without this, a retranslate that makes a chapter worse becomes the published
 * translation: the QA loop rewrote a 75-scoring draft, the new draft scored 50,
 * the round cap ran out, and the worse text shipped. A QA loop may only move a
 * chapter forward.
 *
 * The restore also re-points the verification sidecar at the restored draft
 * (that draft already earned its verdict), so the next verify batch skips it
 * instead of paying to re-grade identical text.
 *
 * @param {string} volumeDir
 * @param {{segments: Array<{id: string, title: string}>}} bundle
 * @returns {Promise<{restored: number, noImprovement: string[]}>} How many drafts were rolled back, and which chapters.
 */
async function applyDraftRatchet(volumeDir, bundle) {
  const statePath = path.join(volumeDir, STATE_FILE);
  const state = await loadTranslationState(statePath);
  const sidecarPath = path.join(volumeDir, VERIFICATION_FILE);
  const sidecar = await loadVerificationSidecar(sidecarPath);
  const restoredIds = [];

  for (const seg of bundle.segments) {
    const entry = state.chapters[seg.id];
    if (!entry) continue;
    const verdict = sidecar.chapters[seg.id];
    // Only judge a verdict that describes the draft we actually have.
    if (!verdictCoversCurrentDraft(verdict, entry)) continue;
    if (typeof entry.bestScore !== "number" || typeof verdict.score !== "number") continue;
    if (entry.bestDraftHash === entry.draftHash) continue; // already the best draft
    if (verdict.score >= entry.bestScore) continue; // not a regression

    const { draftFile, bestFile } = chapterArtifactNames(seg.id);
    const bestPath = path.join(volumeDir, bestFile);
    let bestText;
    try {
      bestText = await fs.readFile(bestPath, "utf8");
    } catch {
      console.warn(
        `  ${seg.id}: the better draft (score ${entry.bestScore}) is not on disk (${bestFile}) — ` +
          `keeping the current draft (score ${verdict.score}).`
      );
      continue;
    }
    if (sha256(bestText) !== entry.bestDraftHash) {
      console.warn(
        `  ${seg.id}: ${bestFile} no longer matches its recorded hash — keeping the current draft.`
      );
      continue;
    }

    await fs.writeFile(path.join(volumeDir, draftFile), bestText, "utf8");
    entry.draftHash = entry.bestDraftHash;
    entry.qaFailed = false;
    entry.noImprovement = true;
    // A restored draft invalidates any polish built on the rejected one.
    entry.polishedDraftHash = null;
    entry.polishScore = null;
    entry.polishFindings = null;
    entry.polishFindingsHash = null;
    // Re-point the sidecar at the restored draft's own verdict, so the next
    // verify batch treats it as covered (a cheap skip, not a re-grade).
    if (entry.bestVerdict) {
      sidecar.chapters[seg.id] = {
        ...entry.bestVerdict,
        sourceHash: entry.sourceHash,
        draftHash: entry.bestDraftHash,
        attempts: verdict.attempts || 1,
      };
    }
    restoredIds.push(seg.id);
    console.log(
      `  ${seg.id}: ratchet — the new draft scored ${verdict.score}/100 against the best draft's ` +
        `${entry.bestScore}/100, so the better draft was restored (${bestFile}).`
    );
  }

  if (restoredIds.length > 0) {
    await saveTranslationState(statePath, state);
    await saveVerificationSidecar(sidecarPath, sidecar);
  }
  return { restored: restoredIds.length, noImprovement: restoredIds };
}

/**
 * Record a fresh verification verdict as the chapter's best draft when it beats
 * what we already had (the ratchet's other half, run by the verify task).
 *
 * @param {string} volumeDir
 * @param {string} segmentId
 * @param {{score: number|null, pass: boolean, findings: string, sourceHash: string, draftHash: string}} verdict
 * @returns {Promise<boolean>} True when this became the new best draft.
 */
async function recordBestDraft(volumeDir, segmentId, verdict) {
  const statePath = path.join(volumeDir, STATE_FILE);
  const state = await loadTranslationState(statePath);
  const entry = state.chapters[segmentId];
  if (!entry) return false;
  const current = typeof verdict.score === "number" ? verdict.score : -1;
  if (typeof entry.bestScore === "number" && entry.bestScore >= current) return false;

  const { draftFile, bestFile } = chapterArtifactNames(segmentId);
  let draftText;
  try {
    draftText = await fs.readFile(path.join(volumeDir, draftFile), "utf8");
  } catch {
    return false;
  }
  await fs.copyFile(path.join(volumeDir, draftFile), path.join(volumeDir, bestFile));
  entry.bestScore = current;
  entry.bestDraftHash = sha256(draftText);
  entry.bestVerdict = {
    score: verdict.score,
    pass: verdict.pass,
    findings: verdict.findings,
    verifiedAt: new Date().toISOString(),
  };
  await saveTranslationState(statePath, state);
  return true;
}

/**
 * One-line description of a resolved role endpoint, for the stage-start log:
 * which env vars each part came from, and what output cap the role will ask
 * for. A stage that silently uses the global model's output cap (because it
 * runs on a different, smaller server) is otherwise invisible in the log.
 *
 * @param {{model: string, baseUrl: string, modelSource: string, baseUrlSource: string, maxTokens: number|null, maxTokensSource: string, contextWindow: number|null, contextWindowSource: string}} endpoint
 * @returns {string}
 */
function describeEndpoint(endpoint) {
  return (
    `${endpoint.model} @ ${endpoint.baseUrl} ` +
    `(model from ${endpoint.modelSource}, base from ${endpoint.baseUrlSource}, ` +
    `output cap ${endpoint.maxTokens ?? "derived"} from ${endpoint.maxTokensSource}, ` +
    `context ${endpoint.contextWindow ?? "AI_CONTEXT_WINDOW (fallback)"} from ${endpoint.contextWindowSource})`
  );
}

// ─── Shared artifact names & the verification sidecar ───────────────────────
//
// These live here rather than in a task module because all four translation
// tasks need them. (Observed: verify-translate.js imports from translate.js;
// the fixes that need the reverse import would have made Node resolve a
// half-initialised module — a cycle whose exports depend on which file was
// required first. Shared names and sidecar I/O belong in the pure layer.)

/** Per-volume translation state file (per-chapter idempotency). */
const STATE_FILE = "translation-state.json";
/** Deterministic QA report written by the translate task. */
const QA_REPORT_FILE = "translation-qa.md";
/** The merged volume translation (the deliverable). */
const MERGED_FILE = "translation.md";
/** Verification sidecar written by verify-translate (machine-readable). */
const VERIFICATION_FILE = "translation-verification.json";
/** Verification report written by verify-translate (human-readable). */
const VERIFICATION_REPORT = "translation-verification.md";
/** Polish QA report. */
const POLISH_QA_REPORT = "polish-qa.md";
/** Polish drift-audit sidecar. */
const POLISH_VERIFICATION_FILE = "polish-verification.json";
const VOLUME_CONSISTENCY_FILE = "volume-consistency.json";
const VOLUME_CONSISTENCY_REPORT = "volume-consistency.md";

/**
 * Per-chapter draft / polished / state / report file names (inside the volume
 * folder). The segment id is unique per volume, so the files are unambiguous
 * without a bundle-base prefix.
 *
 * @param {string} segmentId - The bundle segment id (whole / ch0 / chN / chN.K / part-NN).
 * @returns {{draftFile: string, polishedFile: string, rejectedFile: string, bestFile: string}}
 */
function chapterArtifactNames(segmentId) {
  return {
    draftFile: `translation-${segmentId}.md`,
    polishedFile: `polished-${segmentId}.md`,
    // A draft that failed the deterministic QA is kept (not thrown away) so the
    // QA loop has something to correct; the reason is recorded in the state.
    rejectedFile: `translation-${segmentId}.rejected.md`,
    // The best-scoring draft seen so far — the ratchet's restore point.
    bestFile: `translation-${segmentId}.best.md`,
  };
}

/**
 * Read a file's content or "" when it does not exist.
 *
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function readFileOrEmpty(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

/**
 * Load a verification sidecar (fail-open: missing/corrupt → `{ chapters: {} }`).
 *
 * @param {string} filePath
 * @returns {Promise<{chapters: Object}>}
 */
async function loadVerificationSidecar(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || typeof data.chapters !== "object" || data.chapters === null) {
      return { chapters: {} };
    }
    return data;
  } catch {
    return { chapters: {} };
  }
}

/**
 * Persist a verification sidecar.
 *
 * @param {string} filePath
 * @param {Object} sidecar
 */
async function saveVerificationSidecar(filePath, sidecar) {
  await fs.writeFile(filePath, JSON.stringify(sidecar, null, 2) + "\n", "utf8");
}

/**
 * Extract the findings from a grader's reply for the sidecar's `findings` field
 * (the retranslate / re-polish prompt's "fix these problems" task). The
 * score-line prefix is dropped — it is meaningless to a corrector — keeping the
 * reply from the "## Findings" marker on. When the marker is absent (off-format
 * reply) the whole trimmed reply is kept.
 *
 * Truncation drops WHOLE findings and never cuts one in half, and says how many
 * were dropped: the prompt tells the model "you MUST fix all of them", so a
 * silently shortened list is a lie.
 *
 * @param {string} raw - The grader's full reply.
 * @param {number} [maxChars] - Character budget (default 6000).
 * @returns {string} The findings text.
 */
function findingsOf(raw, maxChars = 6000) {
  const text = (raw || "").trim();
  const idx = text.indexOf("## Findings");
  const findings = idx >= 0 ? text.slice(idx) : text;
  if (findings.length <= maxChars) return findings;
  // Cut at finding boundaries (numbered list items) so no finding is truncated
  // mid-sentence.
  const kept = findings.slice(0, maxChars);
  const lastBoundary = Math.max(
    kept.lastIndexOf("\n1."),
    kept.lastIndexOf("\n2."),
    kept.lastIndexOf("\n3."),
    kept.lastIndexOf("\n4."),
    kept.lastIndexOf("\n5."),
    kept.lastIndexOf("\n6."),
    kept.lastIndexOf("\n7."),
    kept.lastIndexOf("\n8."),
    kept.lastIndexOf("\n9.")
  );
  const cut = lastBoundary > 0 ? kept.slice(0, lastBoundary) : kept;
  const totalNumbered = (findings.match(/^\s*\d+\.\s/gm) || []).length;
  const keptNumbered = (cut.match(/^\s*\d+\.\s/gm) || []).length;
  const omitted = totalNumbered - keptNumbered;
  return (
    cut +
    (omitted > 0
      ? `\n\n(showing ${keptNumbered} of ${totalNumbered} findings — ${omitted} omitted by the ${maxChars}-character budget)`
      : `\n\n(truncated at the ${maxChars}-character budget)`)
  );
}

/**
 * Build the glossary block for the verify/polish prompts.
 *
 * The block is capped (TRANSLATION_GLOSSARY_MAX_CHARS): a cumulative glossary
 * handed whole to every chapter's grader eventually out-shouts the text being
 * graded. Callers should pass the chapter-scoped selection (chapterTerminology)
 * — this cap is the backstop for anything that doesn't.
 *
 * @param {Array<{term: string, rendering: string}>} terms
 * @returns {string} One line per term, or the "none provided" marker.
 */
function glossaryBlock(terms) {
  if (!terms || terms.length === 0) return "(none provided — run the glossary task)";
  const budget = glossaryBlockMaxChars();
  const lines = [];
  let used = 0;
  for (const t of terms) {
    const line = `"${t.term}" → "${t.rendering}"`;
    if (used + line.length + 1 > budget) {
      lines.push(`… (${terms.length - lines.length} further glossary term(s) omitted by the ${budget}-char budget)`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}

module.exports = {
  sha256,
  splitChapter,
  parseGlossaryTerms,
  parseGlossaryRows,
  splitTableRow,
  selectTermsForChapter,
  chapterTerminology,
  glossaryBlockMaxChars,
  extractStyleRules,
  buildTranslationTaskLines,
  buildTranslationPrompt,
  cjkRatio,
  countOccurrences,
  residueRatio,
  isSpaceSeparated,
  lengthBands,
  scriptsOf,
  checkTranslationQa,
  EMPTY_SOURCE_CHARS,
  buildPolishGuardFindings,
  mergeVolumeTranslation,
  headingForSegment,
  findRenderingVariants,
  renderVariantFindings,
  findMissingSegments,
  stripMarkdownFence,
  tailOf,
  loadTranslationState,
  saveTranslationState,
  STATE_FILE,
  QA_REPORT_FILE,
  MERGED_FILE,
  VERIFICATION_FILE,
  VERIFICATION_REPORT,
  POLISH_QA_REPORT,
  POLISH_VERIFICATION_FILE,
  chapterArtifactNames,
  readFileOrEmpty,
  loadVerificationSidecar,
  saveVerificationSidecar,
  findingsOf,
  glossaryBlock,
  medianScore,
  verdictCoversCurrentDraft,
  unverifiedMarker,
  applyDraftRatchet,
  recordBestDraft,
  previousVolumeTail,
  estimateTokens,
  fitPromptBudget,
  describeDroppedBlocks,
  buildBudgetedTaskLines,
  previousRunThroughput,
  logRunEstimate,
  progressCounter,
  countStageChapters,
  checkChapterListConsistency,
  resolvePublishedChapterTexts,
  planConsistencyWindows,
  parseVolumeFindings,
  volumeFindingsText,
  findingsForChapter,
  paragraphBlocks,
  parseFindingItems,
  locateQuoteRange,
  planTargetedRepair,
  stitchParagraphs,
  buildPassageScopeLine,
  retranslateTarget,
  buildVolumeConsistencyMarkdown,
  loadVolumeConsistency,
  saveVolumeConsistency,
  VOLUME_CONSISTENCY_FILE,
  VOLUME_CONSISTENCY_REPORT,
  roleEndpoint,
  describeEndpoint,
  loadVolumeReferences,
  chapterContextHash,
  REFERENCE_SELECTION_VERSION,
  qaLoopDecision,
  qaMaxRounds,
  worthRetranslating,
  stripContinuityOverlap,
  runWithConcurrency,
  stageConcurrency,
  judgeTemperature,
  stageThinking,
  writerTemperature,
};

// ─── Role endpoint & volume references (shared by the four tasks) ───────────

/**
 * Resolve a model role's endpoint from env: `<PREFIX>_BASE_URL` /
 * `<PREFIX>_API_KEY` / `<PREFIX>_MODEL`, each falling back to the global
 * `AI_*` settings (so a single-model setup works with no extra config).
 *
 * @param {"TRANSLATE"|"VERIFY"|"EDIT"} prefix - The env prefix.
 * @returns {{baseUrl: string, apiKey: string|undefined, model: string}}
 */
function roleEndpoint(prefix) {
  const baseUrl =
    process.env[`${prefix}_BASE_URL`] || process.env.AI_BASE_URL || "https://api.openai.com/v1";
  const model = process.env[`${prefix}_MODEL`] || process.env.AI_MODEL || "local";
  // The role's own context window and output cap, when configured. A stage that
  // runs on a server with a SMALLER context than the global AI_* model cannot
  // use the global cap (it is derived from a different machine's window), and a
  // stage that only ever writes a short answer should not ask for the global one.
  const contextWindowRaw = parseInt(process.env[`${prefix}_CONTEXT_WINDOW`], 10);
  const maxTokensRaw = parseInt(process.env[`${prefix}_MAX_TOKENS`], 10);
  return {
    baseUrl,
    // Which env var the value came from — logged at stage start so a run's
    // log shows whether a role used its own endpoint or fell back to AI_*.
    baseUrlSource: process.env[`${prefix}_BASE_URL`]
      ? `${prefix}_BASE_URL`
      : process.env.AI_BASE_URL
        ? "AI_BASE_URL (fallback)"
        : "(built-in default)",
    apiKey: process.env[`${prefix}_API_KEY`] || process.env.AI_API_KEY,
    model,
    modelSource: process.env[`${prefix}_MODEL`]
      ? `${prefix}_MODEL`
      : process.env.AI_MODEL
        ? "AI_MODEL (fallback)"
        : "(built-in default)",
    /** The role's own context window (null = use the global AI_CONTEXT_WINDOW). */
    contextWindow: Number.isFinite(contextWindowRaw) && contextWindowRaw > 0 ? contextWindowRaw : null,
    contextWindowSource:
      Number.isFinite(contextWindowRaw) && contextWindowRaw > 0 ? `${prefix}_CONTEXT_WINDOW` : "AI_CONTEXT_WINDOW (fallback)",
    /** The role's own output cap (null = derive from the context window). */
    maxTokens: Number.isFinite(maxTokensRaw) && maxTokensRaw > 0 ? maxTokensRaw : null,
    maxTokensSource:
      Number.isFinite(maxTokensRaw) && maxTokensRaw > 0
      ? `${prefix}_MAX_TOKENS`
      : Number.isFinite(contextWindowRaw) && contextWindowRaw > 0
        ? `derived from ${prefix}_CONTEXT_WINDOW`
        : "AI_MAX_TOKENS / AI_CONTEXT_WINDOW (fallback)",
  };
}

/**
 * Load the reference artifacts the translation stage injects into its
 * prompts, from a volume folder (all optional — missing artifacts degrade
 * to empty references with a warning, except the glossary which is the
 * canonical terminology source).
 *
 * `background` is the story-context layer (shared wiki → volume wiki →
 * POV map, in that order): the "what is happening up to this installment"
 * context. It feeds translate/retranslate (the [Translation Tasks]
 * background line) and verify-translate (the [Story Background] section).
 *
 * The shared wiki is read from the VOLUME FOLDER's own `shared-wiki.md`
 * copy — the living state "through this volume". The series-root copy holds
 * the LATEST volume's state and would leak later-volume spoilers into
 * earlier volumes' prompts (observed design constraint of the two-file
 * wiki architecture: per-volume `wiki.md` is frozen to its own volume;
 * `shared-wiki.md` is the cumulative state).
 *
 * @param {string} volumeDir - Absolute path to the volume folder.
 * @returns {Promise<{glossaryText: string, terms: Array<{term: string, rendering: string, section: string}>, styleRules: string, background: string, voiceNotes: string, contextHash: string, sharedContextHash: string, disputes: Array<Object>, disputedTerms: Set<string>}>
 *   `contextHash` is the sha256 of (glossary + styleRules + background +
 *   voiceNotes) — the idempotency key: regenerating any of these
 *   invalidates the drafts.
 */
/**
 * @param {string} volumeDir
 * @param {string} [sourceText] - The volume's own text, used to decide WHICH sections of the cumulative references to inject (see the `pick` block below). Omit it and the references fall back to their document order.
 */
async function loadVolumeReferences(volumeDir, sourceText = "") {
  const read = async (name) => {
    try {
      return await fs.readFile(path.join(volumeDir, name), "utf8");
    } catch {
      return "";
    }
  };
  const [glossaryText, styleGuideText, sharedWikiText, wikiText, povMapText, voiceText] =
    await Promise.all([
      read("glossary.md"),
      read("style-guide.md"),
      read("shared-wiki.md"),
      read("wiki.md"),
      read("pov-map.md"),
      read("character-voice.md"),
    ]);
  if (!glossaryText.trim()) {
    console.warn(
      `[translation] ${volumeDir}: no glossary.md — the translation will run WITHOUT terminology constraints. ` +
        `Run the glossary task first for best results.`
    );
  }
  const malformed = [];
  const terms = parseGlossaryTerms(glossaryText, {
    onMalformed: ({ term, section, reason }) => {
      malformed.push(`"${term}" (${section || "unsectioned"}) — ${reason}`);
    },
  });
  if (malformed.length > 0) {
    console.warn(
      `[translation] ${volumeDir}: ${malformed.length} glossary row(s) have no usable target rendering ` +
        `(showing up to 5):\n  ${malformed.slice(0, 5).join("\n  ")}\n` +
        `  Those terms are NOT enforced as terminology law for this volume — re-run the glossary task if this is unexpected.`
    );
  }
  const styleRules = extractStyleRules(styleGuideText);
  // Background for the translation/verification prompts: the shared wiki
  // (the cumulative "series state through this volume" — prior context),
  // the volume wiki (this volume's own plot beats — a condensed checklist
  // of what the chapter contains), and the POV map (who is narrating
  // what) — all bounded (they are context, not law; the glossary/style
  // rules are law).
  //
  // Bounded BY RELEVANCE, not by position. These artifacts are cumulative and
  // section-organised, so "the first N characters" showed the state as of the
  // EARLIEST volumes and the voice notes of the volume-1 cast — the further the
  // series got, the less of its current state the translator actually saw. The
  // sections whose heading or quoted source-language pattern occurs in the volume
  // being translated are the ones that matter to it, whatever position they hold
  // (see selectSectionsByRelevance in utils/prompt.js).
  const pick = (text, headingRe, maxChars, unitLabel) => {
    if (!text.trim()) return "";
    return selectSectionsByRelevance({ content: text.trim(), headingRe, sourceText, maxChars, unitLabel }).content;
  };
  const sharedPart = sharedWikiText.trim()
    ? `## Shared Wiki (series state through this volume)\n${pick(sharedWikiText.trim(), /^## /m, 8000, "wiki section(s)")}`
    : "";
  const wikiPart = wikiText.trim()
    ? `## Volume Wiki\n${pick(wikiText.trim(), /^## /m, 6000, "wiki section(s)")}`
    : "";
  const povPart = povMapText.trim()
    ? `## POV Map\n${pick(povMapText.trim(), /^#{2,3} /m, 2000, "POV section(s)")}`
    : "";
  const background = [sharedPart, wikiPart, povPart].filter(Boolean).join("\n\n");
  const voiceNotes = voiceText.trim()
    ? pick(voiceText.trim(), /^### /m, 4000, "character section(s)")
    : "";
  // The idempotency key fingerprints the FULL reference artifacts (the raw
  // files), not the truncated/derived slices that are actually injected. A
  // hash of a slice would miss a change that landed outside the window (the
  // draft would not invalidate even though a reference changed); a hash of the
  // whole artifact is a stable fingerprint — regenerate any reference and every
  // dependent draft is invalidated on the next run (safe direction: it may
  // invalidate more than strictly necessary, never less).
  // REFERENCE_SELECTION_VERSION is part of the fingerprint: when the rule for
  // WHICH parts of these files get injected changes, the drafts built under the
  // old rule are invalidated (the safe direction — see AGENTS.md gotcha 27).
  const contextHash = sha256(
    [
      `selection=${REFERENCE_SELECTION_VERSION}`,
      glossaryText,
      styleGuideText,
      sharedWikiText,
      wikiText,
      povMapText,
      voiceText,
    ].join("\n\u0000--\u0000\n")
  );
  // The same fingerprint WITHOUT the glossary (see chapterContextHash): every
  // reference except the one whose rows are selected per chapter.
  const sharedContextHash = sha256(
    [
      `selection=${REFERENCE_SELECTION_VERSION}`,
      styleGuideText,
      sharedWikiText,
      wikiText,
      povMapText,
      voiceText,
    ].join("\n\u0000--\u0000\n")
  );
  // The glossary disputes queue (series root): renderings the translation stage
  // itself challenged. A disputed term is STILL the law for the translator — the
  // fix happens in the glossary, not by a translator improvising a third
  // rendering — but the prompt must SAY it is provisional, or the next verifier
  // flags the same thing again and the QA loop oscillates against a term nobody
  // is allowed to change.
  const seriesDir = process.env.SERIES_LOCATION
    ? path.resolve(process.env.SERIES_LOCATION)
    : path.resolve(volumeDir, "..");
  const disputes = await loadGlossaryDisputes(seriesDir);
  const disputedTerms = disputedTermSet(disputes);
  return {
    glossaryText,
    terms,
    styleRules,
    background,
    voiceNotes,
    contextHash,
    sharedContextHash,
    disputes,
    disputedTerms,
  };
}

/**
 * The idempotency key for ONE chapter.
 *
 * The volume-level `contextHash` hashes six whole files, so editing one glossary
 * term invalidates every chapter of every volume — on a 17-volume series that is
 * thousands of model calls spent re-translating chapters that never contained the
 * edited word. A chapter's own key is the non-glossary references (whole, exactly
 * as above) plus the glossary rows THIS chapter actually uses:
 *
 *   - edit a term this chapter contains  → the chapter invalidates (correct)
 *   - add a term this chapter contains   → the chapter invalidates (correct)
 *   - edit a term this chapter never says → the chapter keeps its draft (correct)
 *   - regenerate the style guide / wiki / voice reference → every chapter
 *     invalidates, exactly as before (correct: those are injected whole)
 *
 * @param {{sharedContextHash?: string, terms: Array<{term: string, rendering: string}>}} refs
 * @param {string} sourceText - The chapter's source text (selects the terms).
 * @returns {string} sha256 of the chapter's own reference set.
 */
function chapterContextHash(refs, sourceText) {
  const { terms } = chapterTerminology(refs, sourceText);
  return sha256(
    [
      refs.sharedContextHash || "",
      // A term becoming disputed changes the INSTRUCTION for the chapters that
      // use it, so it belongs in their key (and only theirs).
      ...terms.map(
        (t) =>
          `${t.term}\u0000${t.rendering}\u0000${refs.disputedTerms instanceof Set && refs.disputedTerms.has(t.term) ? "disputed" : ""}`
      ),
    ].join("\u0001")
  );
}

/**
 * The terminology block for ONE chapter: the glossary terms that actually occur
 * in this chapter's source, capped by the prompt budget.
 *
 * @param {{terms: Array<{term: string, rendering: string, section: string}>}} refs - The volume references (loadVolumeReferences).
 * @param {string} sourceText - The chapter's source text.
 * @param {{maxChars?: number}} [opts]
 * @returns {{lines: string[], terms: Array<{term: string, rendering: string, section: string}>, present: number, dropped: number}}
 *   `lines` feeds the translate/retranslate prompt; `terms` feeds the
 *   verification / polish glossary block; `dropped` is what the caller logs.
 */
function chapterTerminology(refs, sourceText, { maxChars } = {}) {
  const sel = selectTermsForChapter(refs && refs.terms, sourceText, { maxChars });
  const disputed = refs && refs.disputedTerms instanceof Set ? refs.disputedTerms : null;
  return {
    lines: sel.terms.map((t) =>
      disputed && disputed.has(t.term)
        ? // The rendering is challenged, but it is still the rendering every
          // chapter must use — a term the translator is told is wrong AND must be
          // obeyed is a term the QA loop argues about forever.
          `"${t.term}" translates to "${t.rendering}" (this rendering is DISPUTED and under review: ` +
          `use it exactly as given — do NOT improvise another one; the correction happens in the glossary)`
        : `"${t.term}" translates to "${t.rendering}"`
    ),
    terms: sel.terms,
    present: sel.present,
    dropped: sel.dropped,
  };
}