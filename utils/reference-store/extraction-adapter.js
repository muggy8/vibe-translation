/**
 * utils/reference-store/extraction-adapter.js — the pipeline's own findings, put in the store.
 *
 * Every pre-production stage already pays for a structured extraction pass and then throws the
 * result away: `character-voice-new.json` holds 223 claims for volume 01 (quirk type, character,
 * description, and the direct quotes it came from) and is read by exactly one thing afterwards —
 * the handoff summary's bullet list. `glossary-new-terms.json` is the same story for terms. That
 * is the cheapest data the pipeline has, because it was already paid for, and it is the data the
 * store needs before any query can say anything useful about a volume.
 *
 * So this adapter files those claims. Three rules decide its shape:
 *
 *   - **The same evidence rule, no exemption.** An extraction entry is a claim, and a claim needs
 *     a citation that verifies at a line. The entries carry `examples` — direct quotes out of the
 *     source — so they are searched in the volume's chapter files with the store's one matching
 *     rule, and an entry whose quotes are not in the book is **refused and reported**, exactly
 *     like a glossary row whose term is not in the book. A model's output is not a fact because a
 *     model wrote it.
 *   - **These rows are not the document's content.** They are stamped `source_stage: "extract"`,
 *     which is what keeps them out of `renderGlossary` / `renderVoice` and out of the coverage
 *     query (see `schema.js`'s `EXTRACTION_SOURCE_STAGE`). Without that line between them, a voice
 *     reference that lost a character would look covered as long as the extractor had noticed the
 *     character — the false pass the whole layer exists to prevent.
 *   - **The comparison between the two is the check.** Once the store holds both what the
 *     extractor found and what the published document says, "the author agent dropped N claims the
 *     extractor produced" is a query with a number in it, not something a validator agent might
 *     happen to notice.
 *
 * @module utils/reference-store/extraction-adapter
 */

const { normalizeQuote, matchQuoteOnLine } = require("./evidence");
const { EXTRACTION_SOURCE_STAGE } = require("./schema");
const { readChapterLines } = require("./source-chapters");
const { quoteCandidates } = require("./voice-adapter");
require("../../types"); // JSDoc type definitions

/**
 * The extraction prompt's `quirkType` values, mapped onto the store's aspect vocabulary.
 *
 * The extraction prompt and the store were written independently, so the names do not match; the
 * mapping is the translation. Anything the prompt did not list lands in `unclassified`, which is
 * the aspect the integrity audit counts and reports — an unmapped quirk type is unclassified by
 * definition, and saying so is the honest outcome (review 05 §2.3).
 *
 * @type {Object<string, string>}
 */
const QUIRK_TYPE_TO_ASPECT = {
  sentenceending: "register",
  pronoun: "pronoun",
  formality: "register",
  vocabulary: "register",
  catchphrase: "catchphrase",
  dialect: "register",
  internalvoice: "internal_voice",
};

/** What an unmapped quirk type is filed as. */
const UNMAPPED_ASPECT = "unclassified";

/** How many of an entry's own quotes the importer will try before it gives up. */
const QUOTE_CANDIDATES_PER_ENTRY = 4;

/**
 * Whether this exact claim is already in the record as an extraction claim.
 *
 * A volume can be built twice — the whole-installment attempt fails and the chapter-by-chapter
 * retry runs over the same source — and the extraction file is written by both. Without this, the
 * second pass files the same 223 claims a second time and the audit counts a volume's findings twice.
 * Matched on the claim's own words, normalized, because two different descriptions of the same
 * character are two claims and should both be here.
 *
 * @param {ReferenceStore} store
 * @param {{key: string|null, aspect: string, body: string}} claim
 * @returns {boolean}
 */
function extractionClaimAlreadyStored(store, { key, aspect, body }) {
  const needle = normalizeQuote(body);
  if (!needle) return false;
  const rows = store.db
    .prepare("SELECT body FROM facts WHERE aspect = ? AND source_stage = ? AND key IS ?")
    .all(aspect, EXTRACTION_SOURCE_STAGE, key);
  return rows.some((row) => normalizeQuote(row.body) === needle);
}

/**
 * Find a citation for one extraction entry, preferring the quotes the entry itself carried.
 *
 * The entry's `examples` are direct quotes from the source, so they are tried first and in the
 * order the model wrote them; only if none of them is in the book does the importer fall back to
 * the spans quoted inside the description, which is what the voice adapter does with a bullet.
 *
 * @param {string} volumeDir
 * @param {Array<{id: string, file: string}>} chapters
 * @param {number} volume
 * @param {string[]} examples
 * @param {string} description
 * @param {string} key
 * @returns {{evidence: Array<Object>|null, tried: string[]}}
 */
function findEntryEvidence(volumeDir, chapters, volume, examples, description, key) {
  const own = [];
  for (const example of Array.isArray(examples) ? examples : []) {
    if (typeof example !== "string") continue;
    const span = example.trim();
    if (normalizeQuote(span).length >= 2) own.push(span);
  }
  const spans = [...own.slice(0, QUOTE_CANDIDATES_PER_ENTRY), ...quoteCandidates(description, key).slice(0, QUOTE_CANDIDATES_PER_ENTRY)];

  const tried = [];
  for (const candidate of spans) {
    if (!normalizeQuote(candidate)) continue;
    tried.push(candidate);
    for (const chapter of chapters) {
      if (!chapter.file) continue;
      const lines = readChapterLines(volumeDir, chapter.file);
      if (!lines) continue;
      for (let i = 0; i < lines.length; i += 1) {
        const matched = matchQuoteOnLine(lines[i], candidate);
        if (!matched) continue;
        return {
          evidence: [{ volume, chapter: chapter.id, line: i + 1, quote: candidate, kind: "quote", matched }],
          tried,
        };
      }
    }
  }
  return { evidence: null, tried };
}

/**
 * File the volume's extracted voice and POV claims into its store.
 *
 * @param {ReferenceStore} store
 * @param {Array<Object>} entries - The parsed `character-voice-new.json` array.
 * @param {{volume?: number}} [opts]
 * @returns {{ok: boolean, imported: Array<Object>, importedCount: number, refused: Array<Object>, characters: number, povCount: number}}
 */
function importVoiceExtraction(store, entries, { volume } = {}) {
  const vol = Number(volume === undefined ? store.volume : volume);
  const listed = store.listChapters();
  const chapters = listed.chapters;

  const imported = [];
  const refused = [];
  const carried = [];
  const characters = new Set();
  let povCount = 0;

  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== "object") {
      refused.push({ kind: "entry", because: "the extraction file contained something that is not an object." });
      continue;
    }

    if (entry.type === "pov") {
      const result = importPovEntry(store, entry, vol, chapters);
      if (result.ok) {
        imported.push(result.fact);
        povCount += 1;
      } else {
        refused.push({ kind: "pov", because: result.because });
      }
      continue;
    }

    const name = typeof entry.character === "string" ? entry.character.trim() : "";
    if (!name) {
      refused.push({ kind: "voice", character: null, because: "a voice claim names no character, so it belongs to nobody." });
      continue;
    }

    // No `display` on purpose: when the character is already in the cast, the name the published
    // document uses for them (如月雨露（ジョーロ）【俺人格】) is the one the renderer puts back in the
    // file, and an extraction entry naming them 如月雨露 must not overwrite it. When they are new,
    // the store falls back to the key, which is the name the extraction gave them.
    const castResult = store.upsertCast({ key: name, firstSeenVolume: vol });
    if (!castResult.ok) {
      refused.push({ kind: "voice", character: name, because: castResult.refusal.because });
      continue;
    }

    const description = typeof entry.description === "string" ? entry.description.trim() : "";
    const label = typeof entry.quirkType === "string" && entry.quirkType.trim() ? entry.quirkType.trim() : "Quirk";
    const aspect = QUIRK_TYPE_TO_ASPECT[label.toLowerCase()] || UNMAPPED_ASPECT;
    if (extractionClaimAlreadyStored(store, { key: name, aspect, body: description || label })) {
      carried.push({ kind: "voice", character: name, label });
      continue;
    }
    const { evidence, tried } = findEntryEvidence(store.volumeDir, chapters, vol, entry.examples, description, name);
    if (!evidence) {
      refused.push({
        kind: "voice",
        character: name,
        label,
        because:
          `none of this claim's quotes (${tried.join(", ") || "no quoted span"}) occurs in volume ${vol}'s source ` +
          "text, so the extraction result is not evidence for anything.",
      });
      continue;
    }

    const result = store.insertFact({
      key: name,
      aspect,
      label,
      section: null,
      body: description || label,
      examples: (Array.isArray(entry.examples) ? entry.examples : []).filter((s) => typeof s === "string").slice(0, 4),
      formality: typeof entry.formalityLevel === "string" && entry.formalityLevel.trim() ? entry.formalityLevel.trim() : null,
      evidence,
      establishedVolume: vol,
      appliesFromVolume: vol,
    });
    if (!result.ok) {
      refused.push({ kind: "voice", character: name, label, because: result.refusal.because });
      continue;
    }
    imported.push(result.fact);
    characters.add(name);
  }

  return {
    ok: refused.length === 0,
    imported,
    importedCount: imported.length,
    carried,
    refused,
    characters: characters.size,
    povCount,
  };
}

/**
 * One POV-map claim: whose eyes a section is seen through, cited to the line that shows it.
 *
 * A POV claim is attached to a character when the extraction names one, because "this section is
 * her free indirect discourse" is a claim about her voice. When it names nobody it is still a
 * claim about the volume, so it is stored unattached rather than thrown away.
 *
 * @param {ReferenceStore} store
 * @param {Object} entry
 * @param {number} vol
 * @param {Array<{id: string, file: string}>} chapters
 * @returns {{ok: boolean, fact: Object|null, because: string|null}}
 */
function importPovEntry(store, entry, vol, chapters) {
  const assigned = typeof entry.assignedCharacter === "string" ? entry.assignedCharacter.trim() : "";
  const description = typeof entry.sectionDescription === "string" ? entry.sectionDescription.trim() : "";
  const marker = typeof entry.marker === "string" && entry.marker.trim() ? entry.marker.trim() : null;
  const body = description || (marker ? `POV marker ${marker}` : "");
  if (!body) return { ok: false, fact: null, because: "the POV entry carries no description and no marker." };

  if (assigned) {
    const castResult = store.upsertCast({ key: assigned, firstSeenVolume: vol });
    if (!castResult.ok) return { ok: false, fact: null, because: castResult.refusal.because };
  }

  const { evidence, tried } = findEntryEvidence(store.volumeDir, chapters, vol, entry.examples, body, assigned);
  if (!evidence) {
    return {
      ok: false,
      fact: null,
      because: `none of this POV claim's quotes (${tried.join(", ") || "no quoted span"}) occurs in volume ${vol}'s source text.`,
    };
  }

  const result = store.insertFact({
    key: assigned || null,
    aspect: "pov",
    label: marker ? `POV ${marker}` : "POV",
    section: null,
    body,
    examples: (Array.isArray(entry.examples) ? entry.examples : []).filter((s) => typeof s === "string").slice(0, 4),
    evidence,
    establishedVolume: vol,
    appliesFromVolume: vol,
  });
  if (!result.ok) return { ok: false, fact: null, because: result.refusal.because };
  return { ok: true, fact: result.fact, because: null };
}

/**
 * File the volume's extracted new terms into its store.
 *
 * A new-terms entry is `{term, type, query}`: the term is searchable in the book, the query is a
 * research question about it. Only the term is filed, and only when the book prints it — a term the
 * volume never contains is the extractor inventing something, which is the same refusal a glossary
 * row gets. These rows are the record of **what this volume contributed**; they are not glossary
 * rows, and they are not rendered into the glossary (see `EXTRACTION_SOURCE_STAGE`).
 *
 * @param {ReferenceStore} store
 * @param {Array<Object>} entries - The parsed `glossary-new-terms.json` array.
 * @param {{volume?: number}} [opts]
 * @returns {{ok: boolean, imported: Array<Object>, importedCount: number, refused: Array<Object>}}
 */
function importNewTerms(store, entries, { volume } = {}) {
  const vol = Number(volume === undefined ? store.volume : volume);
  const listed = store.listChapters();
  const chapters = listed.chapters;

  const imported = [];
  const refused = [];
  const carried = [];

  for (const entry of Array.isArray(entries) ? entries : []) {
    const term = entry && typeof entry.term === "string" ? entry.term.trim() : "";
    if (!term) {
      refused.push({ term: null, because: "the new-terms file contained an entry with no term." });
      continue;
    }
    const type = entry && typeof entry.type === "string" && entry.type.trim() ? entry.type.trim() : "concept";
    if (extractionClaimAlreadyStored(store, { key: null, aspect: "term_usage", body: `New term in volume ${vol}: ${term}` })) {
      carried.push({ term });
      continue;
    }

    const { evidence, tried } = findEntryEvidence(store.volumeDir, chapters, vol, [term], term, null);
    if (!evidence) {
      refused.push({
        term,
        because: `"${term}" does not occur in volume ${vol}'s source text (${tried.join(", ") || "nothing to search"}), ` +
          "so the extraction result is not a claim about this volume.",
      });
      continue;
    }

    const result = store.insertFact({
      key: null,
      aspect: "term_usage",
      label: type,
      section: null,
      body: `New term in volume ${vol}: ${term}`,
      examples: [term],
      evidence,
      establishedVolume: vol,
      appliesFromVolume: vol,
    });
    if (!result.ok) {
      refused.push({ term, because: result.refusal.because });
      continue;
    }
    imported.push(result.fact);
  }

  return { ok: refused.length === 0, imported, importedCount: imported.length, carried, refused };
}

module.exports = {
  QUIRK_TYPE_TO_ASPECT,
  UNMAPPED_ASPECT,
  findEntryEvidence,
  extractionClaimAlreadyStored,
  importVoiceExtraction,
  importNewTerms,
};
