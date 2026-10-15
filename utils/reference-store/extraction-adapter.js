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
 *   - **They land on the roster entry the record already uses for that character.** The extraction
 *     writes 三色院菫子（パンジー） and the glossary writes 三色院菫子. Filing under the extraction's own
 *     spelling builds a second roster, and then the coverage rule's "did the extraction find voice
 *     material for them?" question answers "no" for a character the extraction wrote thirty claims
 *     about. `name-resolution.js` is the one answer, shared with `rebuild.js`.
 *   - **A refused claim does not register a name.** The roster entry is written after the evidence
 *     gate, not before it: a claim the store would not record must not leave its character on the
 *     cast list, where the coverage question would then report somebody nobody ever wrote anything
 *     about.
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
const { resolveExtractionName } = require("./name-resolution");
const { registerFilingRefusal } = require("./register/filing");
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

/** What an extraction entry with no quirk type is labelled. */
const EXTRACTION_VOICE_LABEL = "Quirk";

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
 * The row an extraction claim has: the shape `importVoiceExtraction` files, in one place.
 *
 * There are two doors that file extraction candidates into a volume's record — this one, and
 * `rebuild.js`, which files a candidate beside every claim it adopts so a rebuilt record holds both
 * readings of the book. Two doors writing the same kind of row is how one ends up with two shapes of
 * it, and a candidate the extraction door cannot recognise as already filed is a duplicate claim in
 * the record. So the shape lives here and both doors call it; the evidence and the volume stamps are
 * the caller's, because only the caller has searched the source.
 *
 * @param {Object} entry - One `character-voice-new.json` voice record.
 * @param {string|null} key - The roster entry the claim resolves to.
 * @returns {{key: string|null, aspect: string, label: string, section: null, body: string, examples: string[], formality: string|null, axis: string|undefined, axisValue: string|undefined}}
 */
function voiceCandidateRow(entry, key) {
  const quirk = typeof entry.quirkType === "string" ? entry.quirkType.trim() : "";
  const label = quirk || EXTRACTION_VOICE_LABEL;
  const description = typeof entry.description === "string" ? entry.description.trim() : "";
  /**
   * The register pair, when the extraction named one (plan 06 §4.2, slice 3).
   *
   * The entry's own field names are the plan's — `axis` and `value` — and they are carried here as the
   * store's — `axis` and `axisValue` — because the fact contract is strict and `value` is not one of its
   * keys. **`undefined`, not `null`**, on a claim that names no axis: the contract says "a non-empty
   * string, or absent", and a null in an optional string field is a contract violation, not an answer.
   *
   * Nothing checks them here. The check is `register/filing.js`, reached from `facts/validate.js` on the
   * way into the row, against the declaration frozen into the store handle — so this shape function
   * cannot file a value the series did not declare, and cannot decide which axis a claim belongs to
   * either. Since plan 06 slice 4 the extraction **is** asked for the pair, and is asked for it by the
   * series' own declared questions (`character-voice/prompts.js`), not by anything in this file; a claim
   * that answers none of them still arrives with the pair absent, which is what `rebuild.js` files.
   */
  const axis = typeof entry.axis === "string" ? entry.axis.trim() : "";
  const axisValue = typeof entry.value === "string" ? entry.value.trim() : "";
  return {
    key,
    aspect: QUIRK_TYPE_TO_ASPECT[quirk.toLowerCase()] || UNMAPPED_ASPECT,
    label,
    section: null,
    body: description || label,
    examples: (Array.isArray(entry.examples) ? entry.examples : []).filter((s) => typeof s === "string").slice(0, QUOTE_CANDIDATES_PER_ENTRY),
    formality: typeof entry.formalityLevel === "string" && entry.formalityLevel.trim() ? entry.formalityLevel.trim() : null,
    axis: axis || undefined,
    axisValue: axisValue || undefined,
  };
}

/**
 * The row a POV claim has, in the same shape for the same reason.
 *
 * @param {Object} entry - One `character-voice-new.json` POV record.
 * @param {string|null} key - The roster entry the assigned character resolves to, or null.
 * @returns {{key: string|null, aspect: "pov", label: string, section: null, body: string, examples: string[], formality: null}|null}
 *   Null when the entry carries neither a description nor a marker, which is not a claim.
 */
function povCandidateRow(entry, key) {
  /**
   * The prompt asks for `sectionDescription`. The model does not always write that word: volume 01's
   * prologue answered with `description` instead, and under the single-field read every one of its five
   * POV observations lost its prose — the four that carried a marker were filed as the degenerate body
   * "POV marker ※" and the one without a marker was refused outright, so the published map has nine
   * chapter sections for a ten-chapter volume and the prologue is not one of them.
   *
   * This is not a wider rule, it is the same rule reading the field the entry actually has. The voice
   * builder two functions above already reads `description`; a POV builder that reads only the other
   * spelling is a typo with a data loss attached to it. The order is the prompt's field first, so a model
   * that writes both is read the way the prompt asked.
   */
  const described = ["sectionDescription", "description"]
    .map((field) => (typeof entry[field] === "string" ? entry[field].trim() : ""))
    .find((text) => text.length > 0);
  const marker = typeof entry.marker === "string" && entry.marker.trim() ? entry.marker.trim() : null;
  const body = described || (marker ? `POV marker ${marker}` : "");
  if (!body) return null;
  return {
    key,
    aspect: "pov",
    label: marker ? `POV ${marker}` : "POV",
    section: null,
    body,
    examples: (Array.isArray(entry.examples) ? entry.examples : []).filter((s) => typeof s === "string").slice(0, QUOTE_CANDIDATES_PER_ENTRY),
    formality: null,
  };
}

/**
 * File the volume's extracted voice and POV claims into its store.
 *
 * @param {ReferenceStore} store
 * @param {Array<Object>} entries - The parsed `character-voice-new.json` array.
 * @param {{volume?: number}} [opts]
 * @returns {{ok: boolean, imported: Array<Object>, importedCount: number, carried: Array<Object>, refused: Array<Object>, unresolved: Array<{name: string, key: string, because: string}>, characters: number, povCount: number}}
 */
function importVoiceExtraction(store, entries, { volume } = {}) {
  const vol = Number(volume === undefined ? store.volume : volume);
  const listed = store.listChapters();
  const chapters = listed.chapters;

  const imported = [];
  const refused = [];
  const carried = [];
  const unresolved = [];
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
        if (result.unresolved) unresolved.push(result.unresolved);
      } else {
        refused.push({ kind: "pov", rule: result.rule, because: result.because });
      }
      continue;
    }

    const name = typeof entry.character === "string" ? entry.character.trim() : "";
    if (!name) {
      refused.push({ kind: "voice", character: null, because: "a voice claim names no character, so it belongs to nobody." });
      continue;
    }

    // The extraction's spelling is resolved onto the roster before anything is written, through the
    // same leaf `rebuild.js` uses. Filing 三色院菫子（パンジー）'s claims under 三色院菫子（パンジー） builds a
    // second roster, and then every question about coverage and adoption is asked about a name no
    // volume ever published — including this adapter's own contribution to the coverage rule.
    const resolved = resolveExtractionName(store, name);
    const key = resolved.key;
    // The name the extraction wrote, kept whenever it is not the name the claim is filed under — which is
    // how an unattached claim stays attributable to something a human can read, and how a claim folded
    // onto a roster entry shows where it came from.
    const extractedAs = key && key !== name ? name : key === null ? name : null;

    const row = voiceCandidateRow(entry, key);
    if (extractionClaimAlreadyStored(store, { key, aspect: row.aspect, body: row.body })) {
      carried.push({ kind: "voice", character: name, key, label: row.label });
      continue;
    }
    const { evidence, tried } = findEntryEvidence(store.volumeDir, chapters, vol, entry.examples, row.body, key);
    if (!evidence) {
      refused.push({
        kind: "voice",
        character: name,
        key,
        label: row.label,
        because:
          `none of this claim's quotes (${tried.join(", ") || "no quoted span"}) occurs in volume ${vol}'s source ` +
          "text, so the extraction result is not evidence for anything.",
      });
      continue;
    }

    // The register gate is asked here, before the roster entry is written, for the same reason the
    // evidence rule is: `insertFact` runs it too and no door can skip it, but by then this door has
    // already registered the character — and a claim refused for answering a question the series never
    // asked would leave its name on the roster, where the coverage rule then demands a voice profile
    // for it. Asking here keeps the rule this file states in its header: a refused claim registers
    // nothing.
    const gate = registerFilingRefusal(store, row, "insert_fact");
    if (gate) {
      refused.push({ kind: "voice", character: name, key, label: row.label, rule: gate.rule, because: gate.because });
      continue;
    }

    // The roster entry is written only for a claim that passed the evidence gate. A claim the store
    // refused must not leave a name on the roster, because the coverage question then reports a
    // character nobody ever wrote anything about.
    //
    // No `display` on purpose: when the character is already in the cast, the name the published
    // document uses for them (如月雨露（ジョーロ）【俺人格】) is the one the renderer puts back in the
    // file, and an extraction entry naming them 如月雨露 must not overwrite it. When they are new,
    // the store falls back to the key, which is the name the extraction gave them.
    //
    // And no entry at all when the name resolved to nobody: `key === null` is the store refusing to make
    // a character out of the word for "I", and the claim is filed with no subject rather than with a
    // false one. It is reported by `auditVolumeRecord` under "claims the store could not attach".
    if (key) {
      const castResult = store.upsertCast({ key, firstSeenVolume: vol });
      if (!castResult.ok) {
        refused.push({ kind: "voice", character: name, key, rule: castResult.refusal.rule, because: castResult.refusal.because });
        continue;
      }
    }

    const result = store.insertFact({
      ...row,
      extractedAs,
      evidence,
      establishedVolume: vol,
      appliesFromVolume: vol,
    });
    if (!result.ok) {
      refused.push({ kind: "voice", character: name, key, label: row.label, rule: result.refusal.rule, because: result.refusal.because });
      continue;
    }
    imported.push(result.fact);
    if (key) characters.add(key);
    if (!resolved.resolved) unresolved.push({ name, key, because: resolved.how, unattached: resolved.unattached });
  }

  return {
    ok: refused.length === 0,
    imported,
    importedCount: imported.length,
    carried,
    refused,
    unresolved,
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
 * @returns {{ok: boolean, fact: Object|null, because: string|null, rule: string|null, unresolved: {name: string, key: string, because: string}|null}}
 */
function importPovEntry(store, entry, vol, chapters) {
  const assigned = typeof entry.assignedCharacter === "string" ? entry.assignedCharacter.trim() : "";

  // Same roster resolution as a voice claim: "this section is her free indirect discourse" is a claim
  // about her, and it has to land on the roster entry the rest of the record uses for her.
  const resolved = assigned ? resolveExtractionName(store, assigned) : null;
  const key = resolved ? resolved.key : null;

  const row = povCandidateRow(entry, key);
  if (!row) return { ok: false, fact: null, because: "the POV entry carries no description and no marker.", rule: null, unresolved: null };

  const { evidence, tried } = findEntryEvidence(store.volumeDir, chapters, vol, entry.examples, row.body, key);
  if (!evidence) {
    return {
      ok: false,
      fact: null,
      because: `none of this POV claim's quotes (${tried.join(", ") || "no quoted span"}) occurs in volume ${vol}'s source text.`,
      rule: null,
      unresolved: null,
    };
  }

  if (key) {
    const castResult = store.upsertCast({ key, firstSeenVolume: vol });
    if (!castResult.ok) return { ok: false, fact: null, because: castResult.refusal.because, rule: castResult.refusal.rule, unresolved: null };
  }

  const result = store.insertFact({
    ...row,
    extractedAs: assigned && (!key || key !== assigned) ? assigned : null,
    evidence,
    establishedVolume: vol,
    appliesFromVolume: vol,
  });
  if (!result.ok) return { ok: false, fact: null, because: result.refusal.because, rule: result.refusal.rule, unresolved: null };
  return {
    ok: true,
    fact: result.fact,
    because: null,
    unresolved: resolved && !resolved.resolved ? { name: assigned, key, because: resolved.how, unattached: resolved.unattached } : null,
  };
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
  EXTRACTION_VOICE_LABEL,
  findEntryEvidence,
  extractionClaimAlreadyStored,
  voiceCandidateRow,
  povCandidateRow,
  importVoiceExtraction,
  importNewTerms,
};
