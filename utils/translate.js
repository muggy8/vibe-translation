/**
 * utils/translate.js — Pure helpers for the translation stage
 * (the translate / verify-translate / retranslate / polish tasks).
 *
 * The translation stage is deliberately NOT agent-based: every stage is a
 * one-shot model call over a single chapter, plus deterministic QA and
 * state-file idempotency. This module holds the pure logic (chapter
 * splitting, prompt construction, deterministic QA, state load/save,
 * merging) so the task modules stay thin and the logic stays unit-testable
 * without the filesystem or the AI (test/test-translate.js).
 *
 * Model roles (see the TRANSLATE_* / VERIFY_* / EDIT_* env vars):
 *   - translate / retranslate: Hy-MT2-30B-A3B (translation-specialized,
 *     fast "no_think" mode, official single-user-message contract — NO
 *     system prompt).
 *   - verify-translate / polish: Qwen3.8-27B (source-anchored proofreading
 *     and final polish; reads the Japanese source).
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
 * a glossary Markdown file.
 *
 * Walks the table rows (first column = source term, second column = target
 * rendering), tracking the `## ` section each row belongs to. For each
 * maximal run of consecutive table rows, the header row and separator row
 * are skipped. Emphasis-wrapped cells are normalized.
 *
 * @param {string} markdown - The glossary file content.
 * @returns {Array<{term: string, rendering: string, section: string}>}
 *   One entry per term row, in file order (rows without a rendering are
 *   dropped — they cannot drive the terminology constraint).
 */
function parseGlossaryTerms(markdown) {
  if (!markdown || typeof markdown !== "string") return [];
  const entries = [];
  let section = "";
  let tableRows = [];
  const cleanCell = (c) =>
    c
      .trim()
      .replace(/^`+|`+$/g, "")
      .trim()
      .replace(/^\*+|\*+$/g, "")
      .trim()
      .replace(/^_+|_+$/g, "")
      .trim();
  const flushTable = () => {
    // Row 0 = header, row 1 = separator — data starts at row 2.
    for (let ri = 2; ri < tableRows.length; ri++) {
      const cells = tableRows[ri].split("|").map(cleanCell).filter((c) => c !== "");
      if (cells.length < 2) continue;
      const term = cells[0];
      const rendering = cells[1];
      if (!term) continue;
      if (/^:?-{3,}:?$/.test(term)) continue; // stray separator
      if (/^\[.*\]$/.test(term)) continue; // unrendered template placeholder
      if (!rendering || /^:?-{3,}:?$/.test(rendering) || rendering === "—") continue;
      entries.push({ term, rendering, section });
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
  return entries;
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
  if (Number.isFinite(lengthRatio) && (lengthRatio < 0.6 || lengthRatio > 2.5)) {
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

// ─── Merging ────────────────────────────────────────────────────────────────

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

module.exports = {
  sha256,
  splitChapter,
  parseGlossaryTerms,
  extractStyleRules,
  buildTranslationTaskLines,
  buildTranslationPrompt,
  cjkRatio,
  countOccurrences,
  checkTranslationQa,
  mergeVolumeTranslation,
  stripMarkdownFence,
  tailOf,
  loadTranslationState,
  saveTranslationState,
  roleEndpoint,
  loadVolumeReferences,
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
  return {
    baseUrl: process.env[`${prefix}_BASE_URL`] || process.env.AI_BASE_URL || "https://api.openai.com/v1",
    apiKey: process.env[`${prefix}_API_KEY`] || process.env.AI_API_KEY,
    model: process.env[`${prefix}_MODEL`] || process.env.AI_MODEL || "local",
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
 *   `contextHash` is the sha256 of (glossary + styleRules + background) —
 *   the idempotency key: regenerating any of these invalidates the drafts.
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
  const terms = parseGlossaryTerms(glossaryText);
  const terminologyLines = terms.map((t) => `"${t.term}" translates to "${t.rendering}"`);
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
  const contextHash = sha256(`${glossaryText}\n---\n${styleRules}\n---\n${background}`);
  return {
    glossaryText,
    terms,
    terminologyLines,
    styleRules,
    background,
    voiceNotes,
    contextHash,
  };
}