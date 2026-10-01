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
 * @param {{terminologyLines?: string[], background?: string, styleRules?: string, continuityText?: string, findingsText?: string, targetLanguage?: string}} p
 * @returns {string[]} The task lines, WITHOUT numbering (the caller numbers
 *   them — the numbering must be contiguous).
 */
function buildTranslationTaskLines({
  terminologyLines = [],
  background = "",
  styleRules = "",
  continuityText = "",
  findingsText = "",
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
  if (continuityText && continuityText.trim()) {
    tasks.push(
      `This chapter continues immediately after the previous chapter, which ended with: "${continuityText}" ` +
        "Keep names, tense, register, and voice consistent with it."
    );
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

// ─── Deterministic translation QA ──────────────────────────────────────────

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

/**
 * Count (non-overlapping) substring occurrences of `term` in `text`
 * (substring matching — the correct semantics for Japanese).
 *
 * @param {string} text
 * @param {string} term
 * @returns {number}
 */
function countOccurrences(text, term) {
  if (!text || !term || typeof text !== "string" || typeof term !== "string") return 0;
  let count = 0;
  let idx = text.indexOf(term);
  while (idx !== -1) {
    count++;
    idx = text.indexOf(term, idx + Math.max(1, term.length));
  }
  return count;
}

/**
 * Deterministic QA of one translated chapter (no AI).
 *
 * Hard failures (ok=false — the chapter must be retranslated):
 *   - the draft is empty (runOneShot already guards this, kept as defense)
 *   - CJK ratio > 5% (the model echoed the source instead of translating)
 *   - length ratio < 0.4 (the draft is grossly short — a truncated response;
 *     the runOneShot finish_reason="length" guard is the primary detector)
 * Warnings (reported, do not fail):
 *   - CJK ratio > 0.5% (stray untranslated fragments)
 *   - length ratio outside 0.6–2.5 (English is usually longer than
 *     Japanese by character count; outside the band the draft may be
 *     truncated or padded)
 *   - glossary terms that occur in the source but whose canonical rendering
 *     is absent from the draft (ignored terminology)
 *
 * @param {{sourceText: string, draftText: string, terms?: Array<{term: string, rendering: string}>}} p
 * @returns {{ok: boolean, cjk: number, lengthRatio: number, missingTerms: Array<{term: string, rendering: string}>, warnings: string[], errors: string[]}}
 */
function checkTranslationQa({ sourceText, draftText, terms = [] }) {
  const errors = [];
  const warnings = [];
  const draft = (draftText || "").trim();
  const src = (sourceText || "").trim();
  const cjk = cjkRatio(draft);
  const lengthRatio = src.length > 0 ? draft.length / src.length : draft.length > 0 ? Infinity : 0;
  if (!draft) errors.push("draft is empty");
  if (cjk > 0.05) errors.push(`CJK ratio ${(cjk * 100).toFixed(1)}% — the draft still looks like source text`);
  else if (cjk > 0.005) warnings.push(`residual CJK ratio ${(cjk * 100).toFixed(2)}% — check for untranslated fragments`);
  // Truncation backstop: a draft under 40% of the source length is almost
  // certainly cut off (a JP→EN translation is normally the same length or
  // longer by character count). The runOneShot finish_reason="length" guard
  // is the primary truncation detector; this catches the case where the finish
  // reason is unavailable but the draft is still grossly short.
  if (src.length > 0 && Number.isFinite(lengthRatio) && lengthRatio < 0.4) {
    errors.push(`draft is only ${(lengthRatio * 100).toFixed(0)}% of the source length — it looks truncated`);
  } else if (Number.isFinite(lengthRatio) && (lengthRatio < 0.6 || lengthRatio > 2.5)) {
    warnings.push(`length ratio ${lengthRatio.toFixed(2)} outside the 0.6–2.5 band`);
  }
  const missingTerms = [];
  for (const t of terms) {
    if (!t || !t.term || !t.rendering) continue;
    if (countOccurrences(sourceText || "", t.term) === 0) continue; // not used in this chapter
    if (!draft.includes(t.rendering)) missingTerms.push({ term: t.term, rendering: t.rendering });
  }
  if (missingTerms.length > 0) {
    warnings.push(
      `${missingTerms.length} glossary rendering(s) missing from the draft: ` +
        missingTerms.map((t) => `"${t.term}"→"${t.rendering}"`).join(", ")
    );
  }
  return { ok: errors.length === 0, cjk, lengthRatio, missingTerms, warnings, errors };
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
function mergeVolumeTranslation({ segments, getText }) {
  const parts = [];
  for (const seg of segments) {
    const text = (getText(seg) || "").trim();
    if (!text) continue;
    const hasHeading = seg.title && seg.title.trim() && seg.title !== seg.id;
    parts.push(hasHeading ? `# ${seg.title.trim()}\n\n${text}` : text);
  }
  return parts.length > 0 ? parts.join("\n\n") + "\n" : "";
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

// ─── QA loop (translate-qa) ─────────────────────────────────────────────────

/**
 * Pure stop-decision for the translate-qa loop (the batched
 * "verify → retranslate … until the validator is happy" loop).
 *
 * Rules (checked in this order):
 *   - phase "after-verify": stop with "all-pass" when zero chapters FAIL
 *     (the validator is satisfied — every chapter scores at or above the
 *     passing score); else stop with "round-limit" when this was the last
 *     allowed round; else continue to the retranslate batch.
 *   - phase "after-retranslate": stop with "stalled" when nothing was
 *     retranslated (every FAIL chapter already carries exactly those
 *     findings — the retranslate task's findingsHash skip-check fired, so
 *     nothing new can be applied); else continue to the next verify batch.
 *
 * @param {{
 *   phase: "after-verify"|"after-retranslate",
 *   round: number,
 *   maxRounds: number,
 *   failed?: number,
 *   retranslated?: number,
 * }} p
 * @returns {{stop: boolean, reason: "all-pass"|"round-limit"|"stalled"|null}}
 */
function qaLoopDecision({ phase, round, maxRounds, failed = 0, retranslated = 0, noDraft = 0 }) {
  if (phase === "after-verify") {
    // A chapter with no draft was never verified at all — counting it as a pass
    // is how the loop could report "all-pass" over an untranslated chapter.
    if (failed + noDraft === 0) return { stop: true, reason: "all-pass" };
    if (round >= maxRounds) return { stop: true, reason: "round-limit" };
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
const judgeTemperature = require("../configs/shared").judgeTemperature;

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
  const legacyOn = process.env[`${prefix}_THINKING`];
  const thinking =
    legacyOn !== undefined
      ? String(legacyOn).trim().toLowerCase() !== "false"
      : String(process.env.AI_THINKING ?? "true").trim().toLowerCase() !== "false";
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
  checkTranslationQa,
  buildPolishGuardFindings,
  mergeVolumeTranslation,
  findMissingSegments,
  stripMarkdownFence,
  tailOf,
  loadTranslationState,
  saveTranslationState,
  roleEndpoint,
  loadVolumeReferences,
  qaLoopDecision,
  qaMaxRounds,
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
 * @returns {Promise<{glossaryText: string, terms: Array<{term: string, rendering: string, section: string}>, terminologyLines: string[], styleRules: string, background: string, voiceNotes: string, contextHash: string}>}
 *   `contextHash` is the sha256 of (glossary + styleRules + background +
 *   voiceNotes) — the idempotency key: regenerating any of these
 *   invalidates the drafts.
 */
async function loadVolumeReferences(volumeDir) {
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
  // what) — all truncated (they are context, not law; the glossary/style
  // rules are law).
  const sharedPart = sharedWikiText.trim()
    ? `## Shared Wiki (series state through this volume)\n${sharedWikiText.trim().slice(0, 8000)}`
    : "";
  const wikiPart = wikiText.trim()
    ? `## Volume Wiki\n${wikiText.trim().slice(0, 6000)}`
    : "";
  const povPart = povMapText.trim()
    ? `## POV Map\n${povMapText.trim().slice(0, 2000)}`
    : "";
  const background = [sharedPart, wikiPart, povPart].filter(Boolean).join("\n\n");
  const voiceNotes = voiceText.trim().slice(0, 4000);
  const contextHash = sha256(`${glossaryText}\n---\n${styleRules}\n---\n${background}\n---\n${voiceNotes}`);
  return {
    glossaryText,
    terms,
    styleRules,
    background,
    voiceNotes,
    contextHash,
  };
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
  return {
    lines: sel.terms.map((t) => `"${t.term}" translates to "${t.rendering}"`),
    terms: sel.terms,
    present: sel.present,
    dropped: sel.dropped,
  };
}