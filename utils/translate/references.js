/**
 * The reference material a chapter is translated with: the volume's cumulative
 * references (shared wiki, volume wiki, POV map, voice notes, glossary terms,
 * disputed renderings), the per-chapter invalidation key, and the cross-volume
 * continuity tail.
 *
 * References are injected BY RELEVANCE to the text being processed, never by
 * document position (gotcha 41) — the artifacts are cumulative, so "the first N
 * characters" shows the state as of the earliest volumes and the volume-1 cast.
 *
 * Part of the translate.js layer (split out of the original single file).
 */

const fs = require("fs").promises;
const path = require("path");
const { loadGlossaryDisputes, disputedTermSet } = require("../disputes");
const { selectSectionsByRelevance } = require("../prompt");

const { tailOf } = require("./merge");
const { MERGED_FILE } = require("./state");
const { readFileOrEmpty, sha256 } = require("./internal");
const { extractStyleRules, parseGlossaryTerms, selectTermsForChapter } = require("./terminology");

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

module.exports = {
  REFERENCE_SELECTION_VERSION,
  previousVolumeTail,
  loadVolumeReferences,
  chapterContextHash,
  chapterTerminology,
};
