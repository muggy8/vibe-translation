/**
 * utils/reference-store/voice-adapter.js — the character-voice reference, in and out of
 * the store.
 *
 * The voice reference is the artifact that killed the last run: 171,843,556 tokens to
 * re-type one volume's copy of it, and a repair agent's cleanup edits welded its lines
 * together until one "line" was 54,341 characters — 157,566 bytes (doc 04 §2, re-measured
 * 2026-10-10; the 157,566 figure the plan carried was the byte length). It is also the
 * artifact whose shape is easiest to express as rows: one section per character (one per
 * persona), and one bullet per kind of claim about that character.
 *
 * `importVoice` reads the file into `cast` rows and `facts` rows; `renderVoice` writes it
 * back. The canonical shape the renderer emits — and the shape the importer round-trips
 * byte-for-byte — is:
 *
 *     # Character Voice Reference
 *
 *     ## Characters
 *
 *     ### <display heading>
 *
 *     - **<Label>**: <body>
 *
 * Like the glossary adapter, this parser is deliberately NOT `character-voice/reference-index.js`'s:
 * slice 4's claim is that the STORE can reproduce the artifact, and a round trip through the
 * same parser that already reads it would prove the parser is consistent with itself.
 *
 * What does not round-trip, and is reported rather than hidden: a bullet whose body spans
 * several physical lines (the store holds one body string, the renderer emits one line), and
 * any prose the file carries outside a character section.
 *
 * @module utils/reference-store/voice-adapter
 */

const { normalizeQuote, matchQuoteOnLine } = require("./evidence");
const { stripRubyMarkup, hasRubyMarkup } = require("./ruby-markup");
const { EXTRACTION_SOURCE_STAGE } = require("./schema");
const { currentClaimSql } = require("./facts");
const { readChapterLines } = require("./source-chapters");
const { DOCUMENT_VOICE, storeDocumentProse, readDocumentProse, markDocumentMirrored } = require("./document-prose");
require("../../types"); // JSDoc type definitions

/** The heading the renderer writes at the top of the file. */
const VOICE_TITLE = "# Character Voice Reference";

/** The section every character lives under — the one every published reference on disk uses. */
const VOICE_SECTION = "Characters";

/**
 * The artifact's bullet labels, and the closed-vocabulary aspect each one is a spelling of.
 *
 * The label is what the renderer prints; the aspect is what a query runs on. Keeping them
 * separate is what lets the store hold `register` while the file keeps saying
 * "Sentence endings", "Dialect" and "Vocabulary register" — three facets of one queryable
 * kind, and the reason the artifact's own wording is stored rather than inferred.
 *
 * Four of these labels land on the one `register` aspect (plan 06 §2.3). For a claim that names a
 * register axis the label is presentation only and the question is asked on `facts.axis`
 * (`register/answers.js`); for a claim that names none the label is the **only** place the
 * extractor's distinction still exists, which is why it is stored rather than derived from the aspect.
 *
 * @type {Object<string, string>}
 */
const VOICE_LABEL_TO_ASPECT = {
  "pronouns": "pronoun",
  "catchphrases": "catchphrase",
  "vocabulary register": "register",
  "sentence endings": "register",
  "formality level": "register",
  "dialect": "register",
  "internal voice": "internal_voice",
  "notes": "unclassified",
  "appears in": "appearance",
  // The label a reference rebuilt from the extraction output gives a POV claim (`rebuild.js`). It is
  // here because the round trip has to close: a label the importer does not know lands in
  // `unclassified`, and a rebuilt reference would then be reported for a fallback the file never used.
  "point of view": "pov",
};

/**
 * The aspect a label this table does not know falls into.
 *
 * It is the same value as the "Notes" label above, and it is called `unclassified` rather than
 * `notes` on purpose: doc 03 risk 5 is a catch-all quietly becoming where everything lands, so
 * the fallback is named as a fallback and `integrity.js` counts it per volume (review 05 §2.3).
 */
const UNKNOWN_VOICE_LABEL_ASPECT = "unclassified";

/**
 * The part of a heading that identifies WHO the section is about.
 *
 * `如月雨露（ジョーロ）【俺人格】` → `如月雨露`. Same rule `voicePrimaryName` uses, for the
 * same reason: the bracketed aliases and persona tags are the part a later pass rewords, and
 * the identity must survive the rewording.
 *
 * @param {string} heading - One `### ` heading's text.
 * @returns {string}
 */
function voicePrimaryName(heading) {
  const primary = String(heading || "")
    .split(/[（(【\[\/]/)[0]
    .trim();
  return primary || String(heading || "").trim();
}

/**
 * The persona tag of a heading, if it has one: `【俺人格】` → `俺人格`.
 * @param {string} heading
 * @returns {string|null}
 */
function voicePersonaTag(heading) {
  const match = String(heading || "").match(/【([^】]+)】/);
  return match ? match[1].trim() : null;
}

/**
 * Read a voice reference into characters and their bullets.
 *
 * ## It is taught to survive ruby markup (plan 07 §4.6, taught before any published file may carry it)
 *
 * Plan 07 slice 5 puts the author's pronunciation guides back in front of a model as an annotated view of a
 * chapter. That view is never published, but a claim, a heading or a note can still reach this parser with
 * markup on it — a model echoing what it was shown, or a later slice deciding to print a guide in the
 * reference itself. Three rules, all of them **naming** what they saw, because the failure this parser is
 * taught to avoid is the one with no finding and no count that moves:
 *
 *   1. **a heading is the word, not the guide.** `### <ruby>蒲<rt>かま</rt></ruby>田` names the character
 *      蒲田, so the section keys onto the roster entry the guide-free book measures.
 *   2. **a markup-bearing line after the first bullet is not glued onto that bullet's body.** The
 *      continuation rule exists because a wrapped claim body comes back on one line, and a guide is not a
 *      continuation of a claim: gluing one produced `"Addresses the man … <ruby>…<rt>…</rt></ruby>"` as a
 *      published claim body. Such a line is recorded in `annotatedLines` instead, the way
 *      `parseGlossaryMarkdown` reports prose it has nowhere to put.
 *   3. **a bullet whose body carries markup is kept verbatim and named.** Rewriting a published claim's body
 *      is the damage this slice is told not to do; the evidence rule already strips markup before it compares
 *      (see `utils/reference-store/evidence.js`), so the claim still verifies while the markup stays visible
 *      in the import result.
 *
 * @param {string} markdown
 * @returns {{characters: Array<{display: string, key: string, persona: string|null, lead: string[], entries: Array<{label: string, body: string}>}>, title: string|null, preamble: string[], annotatedLines: Array<{section: string|null, kind: string, line: string, label?: string}>}}
 *   `title` and `preamble` are the document's own opening, kept verbatim (blank lines included)
 *   so `renderVoice` can put them back (review 05 §3.4). A character section that has prose
 *   before its first bullet keeps it in `lead`, for the same reason: nothing in the file is
 *   dropped on the way in. `annotatedLines` is every line that carried pronunciation markup and
 *   what this parser did with it — empty for every document this repository has ever published.
 */
function parseVoiceMarkdown(markdown) {
  const characters = [];
  const proseBlocks = [];
  /** @type {Array<{section: string|null, kind: string, line: string, label?: string}>} */
  const annotatedLines = [];
  let currentBlock = { section: null, kind: "title", lines: [] };
  let title = null;
  let current = null;

  const closeBlock = (section) => {
    if (currentBlock.lines.length && !currentBlock.lines.every((line) => line.trim() === "")) {
      proseBlocks.push(currentBlock);
    }
    currentBlock = { section, lines: [] };
  };

  for (const rawLine of String(markdown || "").split("\n")) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    const heading = trimmed.match(/^###\s+(.+)$/);
    if (heading) {
      // The guide is not part of the name: an annotated heading keys onto the same roster entry the
      // guide-free book would measure, and the markup it carried is named rather than swallowed.
      const headingCarriesMarkup = hasRubyMarkup(heading[1]);
      const display = stripRubyMarkup(heading[1]).replace(/\*\*?/g, "").replace(/`/g, "").trim();
      if (!display || /^:?-{3,}:?$/.test(display)) continue;
      if (headingCarriesMarkup) annotatedLines.push({ section: display, kind: "heading", line: trimmed });
      closeBlock(display);
      current = {
        display,
        key: voicePrimaryName(display),
        persona: voicePersonaTag(display),
        lead: [],
        entries: [],
      };
      characters.push(current);
      continue;
    }

    if (!current) {
      if (title === null && /^#\s/.test(trimmed)) title = line;
      if (hasRubyMarkup(trimmed)) annotatedLines.push({ section: null, kind: "preamble", line: trimmed });
      currentBlock.lines.push(line);
      continue;
    }

    const bullet = trimmed.match(/^-\s+\*\*([^*]+)\*\*:?\s*(.*)$/);
    if (bullet) {
      // Whatever the heading carried before its first bullet is the character's own prose, and
      // it closes here so the renderer can put it back where it was.
      if (current.lead.length) {
        proseBlocks.push({ section: current.display, lines: current.lead });
      }
      if (hasRubyMarkup(trimmed)) {
        annotatedLines.push({ section: current.display, kind: "bullet", line: trimmed, label: bullet[1].trim() });
      }
      current.entries.push({ label: bullet[1].trim(), body: bullet[2].trim() });
      continue;
    }
    // A markup-bearing line is NOT a continuation of the bullet above it. This is the shape plan 07 §4.6
    // names: the continuation rule is for a claim body that wrapped, and a guide sitting on its own line is
    // not part of anybody's claim. Glued, it became a published claim body with markup welded onto the end
    // of it, with no finding and no count that moved. Named instead, the way the glossary parser reports
    // prose it has nowhere to put.
    if (trimmed && hasRubyMarkup(trimmed)) {
      annotatedLines.push({ section: current.display, kind: "line-not-glued", line: trimmed });
      continue;
    }
    // A continuation line belongs to the bullet above it. The store holds one body string,
    // so the join is lossy in one direction: a body that was wrapped comes back on one line.
    if (trimmed && current.entries.length) {
      const last = current.entries[current.entries.length - 1];
      last.body = `${last.body} ${trimmed}`.trim();
      continue;
    }
    // Prose under a heading and before any bullet: it belongs to that character, not to the
    // document, so it is kept where it was rather than folded into the preamble.
    if (trimmed) {
      if (hasRubyMarkup(trimmed)) annotatedLines.push({ section: current.display, kind: "lead", line: trimmed });
      current.lead.push(line);
    }
  }

  closeBlock(null);
  const opening = proseBlocks.find((block) => block.section === null) || { section: null, lines: [] };
  const preamble = title === null ? opening.lines : opening.lines.slice(1);

  return { characters, title, preamble, proseBlocks, annotatedLines };
}

/**
 * The quoted spans in a bullet, longest first — the candidates for evidence.
 *
 * The voice reference quotes the book constantly (「さぁ、今日も俺の熱き血潮を迸らせるぜ！」),
 * and those quotes are exactly what the evidence rule wants. Where a bullet quotes nothing,
 * the character's own name is the fallback: a character section for someone whose name does
 * not appear in the volume is a section that should not be there.
 *
 * @param {string} body
 * @param {string} key
 * @returns {string[]}
 */
function quoteCandidates(body, key) {
  const spans = [];
  const patterns = [/「([^」]+)」/g, /『([^』]+)』/g, /"([^"]{8,})"/g];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(String(body || ""))) !== null) {
      const span = match[1].trim();
      if (normalizeQuote(span).length >= 4) spans.push(span);
    }
  }
  spans.sort((a, b) => normalizeQuote(b).length - normalizeQuote(a).length);
  if (key) spans.push(key);
  return spans;
}

/**
 * Find the first place one of a bullet's quotes occurs in the volume's source.
 *
 * Uses the same matching rule as every other citation in this store — verbatim, then the
 * Han-character skeleton when the quote is long enough for that to mean something — because a
 * furiganed name is the common case in this corpus, not an edge case.
 *
 * @param {string} volumeDir
 * @param {Array<{id: string, file: string}>} chapters
 * @param {number} volume
 * @param {string} body
 * @param {string} key
 * @returns {{evidence: Array<Object>|null, matched: string|null, tried: string[]}}
 */
function findBulletEvidence(volumeDir, chapters, volume, body, key) {
  const candidates = quoteCandidates(body, key).slice(0, 4);
  const tried = [];
  for (const candidate of candidates) {
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
          matched,
          tried,
        };
      }
    }
  }
  return { evidence: null, matched: null, tried };
}

/**
 * Import a character-voice reference into a volume's store.
 *
 * Each `### ` heading is asked of `name-resolution.js` — the same question the extraction door asks — so
 * the two doors cannot give two answers to the same name. A heading whose primary name is a roster entry
 * that has since been merged lands on the entry that survived the merge, and the move is reported in
 * `rekeyed` rather than happening quietly.
 *
 * @param {ReferenceStore} store
 * @param {string} markdown - The reference file's content.
 * @param {{volume?: number}} [opts]
 * @returns {{ok: boolean, characters: number, imported: Array<Object>, importedCount: number, carried: Array<{character: string, label: string}>, refused: Array<{character: string, label: string, because: string}>, rekeyed: Array<{heading: string, key: string, how: string}>, facts: Array<Object>, proseStored: Object}}
 */
function importVoice(store, markdown, { volume } = {}) {
  const vol = Number(volume === undefined ? store.volume : volume);
  const parsed = parseVoiceMarkdown(markdown);
  const listed = store.listChapters();
  const chapters = listed.chapters;

  const proseStored = storeDocumentProse(store, DOCUMENT_VOICE, parsed.proseBlocks).stored;
  // This store now holds a mirror of this volume's character-voice document, and the record says so.
  // The coverage question depends on that fact: asking "does the reference cover the roster?" of a
  // volume whose reference has not been mirrored yet is asking a question whose only honest answer is
  // "not yet", and a HIGH finding that fires on every volume before its voice stage runs is a finding
  // people learn to ignore. What a volume that never finished is caught by is the sealing check.
  markDocumentMirrored(store, DOCUMENT_VOICE, vol);
  let characters = 0;
  // The rows that went in, not just how many: the caller has to be able to see which facts an
  // import created, because an imported row is owned by the import and the volume may still
  // correct it (slice 5). `importGlossary` returns the same shape.
  const imported = [];
  const refused = [];
  const carried = [];
  /** @type {Array<{heading: string, key: string, how: string}>} Sections whose heading resolved onto a different roster entry than its own primary name. */
  const rekeyed = [];
  /** @type {Array<{heading: string, bullets: number, because: string}>} Sections the store refused to key by a name it cannot answer for. */
  const unattachedSections = [];

  for (const character of parsed.characters) {
    // The heading is a name, and this store has one module that answers "which roster entry is this
    // name?" — the same one the extraction door uses. Without it the two doors give two different
    // answers to the same heading, and that is how a folded character splits in two again: volume 01's
    // published reference has a section headed `俺（如月雨露・第二章終盤）`, and volume 02's record has
    // that entry marked as merged into 如月雨露. Filing the section's bullets under 俺 would put them on
    // a roster entry the record has already said is the same person as another one — and `renderVoice`
    // does not render merged entries, so those bullets would vanish from the next volume's file.
    // Required here rather than at the top of the file: `name-resolution.js` requires this module for the
    // primary-name rule, so a top-level require the other way round would close a cycle and hand one of
    // the two a half-built module (gotcha 85). By the time an import runs, both are complete.
    const { resolveExtractionName } = require("./name-resolution");
    const resolved = resolveExtractionName(store, character.display);
    const key = resolved.key;
    // A heading the roster cannot answer for — a section headed with the word for "I", which is what a
    // published reference looks like when the extraction never resolved the narrator (gotcha 115) — does
    // not get a roster entry made out of it either. Its bullets are filed unattached, carrying the
    // heading they were published under, and the audit prints them.
    const unattached = key === null;
    if (unattached) unattachedSections.push({ heading: character.display, bullets: character.entries.length, because: resolved.how });
    // A heading that resolves onto an existing entry does not get to rename it.
    const display = key === character.key ? character.display : resolved.display || character.display;
    if (!unattached && key !== character.key) rekeyed.push({ heading: character.display, key, how: resolved.how });

    if (!unattached) {
      const castResult = store.upsertCast({
        key,
        display,
        persona: character.persona,
        aliases: [],
        firstSeenVolume: vol,
      });
      if (!castResult.ok) {
        for (const entry of character.entries) {
          refused.push({ character: character.display, label: entry.label, because: castResult.refusal.because });
        }
        continue;
      }
    }

    let importedForThisCharacter = 0;
    for (const entry of character.entries) {
      const body = entry.body || entry.label;
      // The reference is cumulative and this store already carries the earlier volumes' rows from
      // copy-forward, so a bullet the record already has is counted as carried rather than
      // re-stamped as this volume's claim.
      if (documentBulletAlreadyStored(store, key, body)) {
        carried.push({ character: character.display, label: entry.label });
        continue;
      }
      const { evidence, tried } = findBulletEvidence(store.volumeDir, chapters, vol, body, key);
      if (!evidence) {
        refused.push({
          character: character.display,
          label: entry.label,
          because:
            `nothing in this bullet (${tried.join(", ") || "no quoted span"}) occurs in volume ${vol}'s source ` +
            "text, so the claim has no evidence that can be verified.",
        });
        continue;
      }
      const result = store.insertFact({
        key,
        aspect: VOICE_LABEL_TO_ASPECT[entry.label.trim().toLowerCase()] || UNKNOWN_VOICE_LABEL_ASPECT,
        label: entry.label,
        section: VOICE_SECTION,
        body,
        examples: quoteCandidates(body, "").slice(0, 4),
        extractedAs: key !== character.display ? character.display : null,
        evidence,
        establishedVolume: vol,
        appliesFromVolume: vol,
      });
      if (!result.ok) {
        refused.push({ character: character.display, label: entry.label, because: result.refusal.because });
        continue;
      }
      imported.push(result.fact);
      importedForThisCharacter += 1;
    }

    // A character whose every bullet was refused KEEPS its cast entry (review 05 §4 item D).
    // Removing it is how a damaged reference imports as a small, clean-looking store: the cast
    // shrinks to match what survived, so the store agrees with the damaged file and the damage
    // disappears from the record. The roster is the thing the integrity check compares against,
    // so the roster has to survive the import that failed to describe it.
    if (importedForThisCharacter > 0) characters += 1;
  }

  return {
    ok: refused.length === 0,
    characters,
    imported,
    importedCount: imported.length,
    carried,
    refused,
    rekeyed,
    unattachedSections,
    facts: imported,
    proseStored,
  };
}

/**
 * Whether the store already holds this bullet as a row of the document.
 *
 * Matched on the body, normalized: the cumulative reference is supposed to carry an earlier
 * volume's bullet unchanged, and that is exactly the case to skip. A reworded bullet is a different
 * row and is imported as this volume's claim.
 *
 * @param {ReferenceStore} store
 * @param {string} key
 * @param {string} body
 * @returns {boolean}
 */
function documentBulletAlreadyStored(store, key, body) {
  const needle = normalizeQuote(body);
  if (!needle) return false;
  const rows = store.db
    .prepare(`SELECT body FROM facts WHERE key IS ? AND source_stage != ? AND ${currentClaimSql("facts")}`)
    .all(key, EXTRACTION_SOURCE_STAGE);
  return rows.some((row) => normalizeQuote(row.body) === needle);
}

/**
 * Render the store's character rows back into the reference file.
 *
 * Characters are ordered by the insertion order of their first bullet, which is the order
 * they appeared in the file that was imported; bullets keep their insertion order. Two runs
 * over the same rows are byte-identical.
 *
 * @param {ReferenceStore} store
 * @param {{title?: string}} [opts]
 * @returns {string}
 */
function renderVoice(store, { title = VOICE_TITLE } = {}) {
  const castRows = store.db
    .prepare(
      "SELECT c.key, c.display, MIN(f.ord) AS first_ord FROM cast c JOIN facts f ON " +
        "(f.key = c.key OR f.key IN (SELECT m.key FROM cast m WHERE m.merged_into = c.key)) " +
        `WHERE c.merged_into IS NULL AND f.source_stage != ? AND ${currentClaimSql("f")} GROUP BY c.key ORDER BY first_ord, c.key`
    )
    .all(EXTRACTION_SOURCE_STAGE);

  const proseRows = readDocumentProse(store, DOCUMENT_VOICE);
  const opening = proseRows.filter((row) => row.section === null).map((row) => row.text);
  const sectionProse = new Map();
  for (const row of proseRows) {
    if (row.section === null) continue;
    if (!sectionProse.has(row.section)) sectionProse.set(row.section, []);
    sectionProse.get(row.section).push(row.text);
  }

  // The document's own opening, verbatim. A store that imported a file renders that file's
  // title and preamble; a store built by hand gets the canonical shape the system prompt asks
  // for. `merged_into` entries are not rendered: their facts were re-pointed to the entry they
  // joined, so the character appears once (review 05 §3.3).
  const out = opening.length ? [...opening] : [title, "", `## ${VOICE_SECTION}`, ""];
  // A character is rendered with every claim filed under any name that person is filed under. The fold
  // re-points the rows it moves, so this is a safety net rather than the normal path — but the alternative
  // is a bullet that stops rendering because somebody filed it under a name the roster has already
  // retired, and "published facts quietly disappear" is the failure this layer is built to prevent.
  const bulletStmt = store.db.prepare(
    "SELECT key, label, body FROM facts WHERE key IS NOT NULL AND " +
      `(key = ? OR key IN (SELECT m.key FROM cast m WHERE m.merged_into = ?)) AND source_stage != ? AND ${currentClaimSql("facts")} ORDER BY ord, id`
  );

  for (const character of castRows) {
    const rows = bulletStmt.all(character.key, character.key, EXTRACTION_SOURCE_STAGE);
    if (rows.length === 0) continue;
    out.push(`### ${character.display}`);
    const lead = sectionProse.get(character.display);
    if (lead && lead.length) out.push(...lead);
    else out.push("");
    for (const row of rows) {
      out.push(`- **${row.label || row.body}**: ${renderInline(row.body)}`);
    }
    out.push("");
  }

  return out.join("\n").replace(/\n+$/, "") + "\n";
}

/**
 * A body on one line: no line breaks, no leading dash that would read as a new bullet.
 * @param {string} value
 * @returns {string}
 */
function renderInline(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/\s*\n\s*/g, " ")
    .trim();
}

module.exports = {
  VOICE_TITLE,
  VOICE_SECTION,
  VOICE_LABEL_TO_ASPECT,
  UNKNOWN_VOICE_LABEL_ASPECT,
  voicePrimaryName,
  voicePersonaTag,
  parseVoiceMarkdown,
  quoteCandidates,
  findBulletEvidence,
  importVoice,
  renderVoice,
};
