/**
 * utils/reference-store/glossary-adapter.js — the glossary, in and out of the store.
 *
 * Doc 03 §0's observation is that the glossary is already a table pretending to be a
 * document: term / rendering / section / notes, stored as Markdown and parsed back out of
 * Markdown at every use. This adapter is the two halves of turning that around:
 *
 *   `importGlossary` — read the file, find each row's evidence in the volume's own source
 *   text, and insert the row. A row whose term cannot be found in the book is **refused**,
 *   and reported: the import never quietly drops a row it could not check.
 *
 *   `renderGlossary` — write the file back out of the rows.
 *
 * **The parser here is deliberately NOT `glossary/carry-forward/table.js`'s.** Reusing it
 * would make slice 4's round-trip test a tautology — the same parser reading the file twice
 * proves the parser agrees with itself, not that the store can reproduce the artifact. The
 * carry-forward gate and the delivery signals keep their parser; this one is the store's,
 * and the two disagreeing is information. (Doc 03 §9.4: the database is authoritative and a
 * test asserts the round trip.)
 *
 * The canonical shape this renderer writes — and the shape `importGlossary` round-trips
 * byte-for-byte — is:
 *
 *     # Glossary — <series>
 *
 *     <preamble paragraphs, verbatim>
 *
 *     ## <Section>
 *
 *     | Japanese | English | Notes |
 *     |---|---|---|
 *     | <term> | <rendering> | <notes> |
 *
 * The title line and the preamble are stored in `document_prose` and rendered back verbatim
 * (review 05 §3.4): the real glossary opens with a title and two style-policy paragraphs, and
 * a renderer that drops them cannot diff clean against the file it claims to reproduce. The
 * column headers are the ones the real file uses and the rest of the pipeline already reads —
 * `Japanese | English | Notes`, not `Term | Rendering | Notes` — because `utils/delivery-verify`
 * counts the file's sections and terms and `parseGlossaryTerms` reads it back.
 *
 * @module utils/reference-store/glossary-adapter
 */

const { normalizeQuote, matchQuoteOnLine } = require("./evidence");
const { EXTRACTION_SOURCE_STAGE } = require("./schema");
const { readChapterLines } = require("./source-chapters");
const { DOCUMENT_GLOSSARY, storeDocumentProse, readDocumentProse, markDocumentMirrored } = require("./document-prose");
const { isBareFirstPersonPronoun } = require("./name-resolution");
require("../../types"); // JSDoc type definitions

/** The heading the renderer writes when a store holds no title of its own. */
const GLOSSARY_TITLE = "# Glossary";

/** The column header every section's table gets — the one the real artifact and the pipeline use. */
const GLOSSARY_HEADER = ["Japanese", "English", "Notes"];

/** How many quoted spans the importer will try before it gives up on a row. */
const QUOTE_CANDIDATES_PER_ROW = 4;

/** A span this short is not a passage, it is a word; `governs` cites passages. */
const GOVERNS_MIN_SPAN_CHARS = 4;

/**
 * The section whose rows are the volume's roster.
 *
 * Named rather than inlined because it is the join between the two artifacts: the glossary's
 * Characters section is where the cast comes from, and the cast is what the voice reference is
 * supposed to cover. `integrity.js` compares the two (review 05 §4 item D).
 */
const GLOSSARY_CHARACTER_SECTION = "Characters";

/**
 * Split a term cell into the spellings it names.
 *
 * A glossary row's first column is often several spellings of one entry
 * (`三つ編み魔王 / 三つ編み悪魔 / 呪われし姫君`), which is the shape the carry-forward gate
 * had to learn to compare at this resolution (gotcha 64). The importer keeps the cell as
 * written and searches each spelling for the evidence.
 *
 * @param {string} cell
 * @returns {string[]}
 */
function glossaryTermSpans(cell) {
  return String(cell || "")
    .split("/")
    .map((span) => span.replace(/^`+|`+$/g, "").replace(/^\*+|\*+$/g, "").replace(/^_+|_+$/g, "").trim())
    .filter((span) => span.length > 0);
}

/**
 * One Markdown table row, as cells.
 * @param {string} line
 * @returns {string[]}
 */
function splitTableRow(line) {
  return String(line)
    .split("|")
    .map((cell) => cell.trim())
    .filter((cell) => cell !== "");
}

/**
 * Whether a line is a table separator (`|---|---|`).
 * @param {string[]} cells
 * @returns {boolean}
 */
function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell));
}

/**
 * Read a glossary file into rows, and into the prose that is not rows.
 *
 * Sections are tracked so each row knows which `## ` heading it sits under — that is what the
 * renderer needs to put it back. The prose is tracked the same way: the file's opening (title
 * line and preamble paragraphs) and any paragraph a section carries before its table, both kept
 * verbatim including their blank lines, because a renderer that drops them cannot claim to
 * reproduce the document (review 05 §3.4).
 *
 * @param {string} markdown
 * @returns {{rows: Array<{term: string, rendering: string, notes: string, section: string}>, title: string|null, preamble: string[], proseBlocks: Array<{section: string|null, kind?: "title", lines: string[]}>, unplacedProse: Array<{section: string, text: string}>}}
 *   `unplacedProse` is prose the file carries AFTER a section's table: this renderer has nowhere
 *   to put it, so it is reported instead of quietly dropped.
 */
function parseGlossaryMarkdown(markdown) {
  const rows = [];
  const proseBlocks = [];
  const unplacedProse = [];
  let currentBlock = { section: null, lines: [], closed: false };
  let tablePhase = false;
  let title = null;
  let section = "";
  let tableRows = [];

  const closeBlock = () => {
    // A section's block is recorded once. The placeholder that stands in for the rest of the
    // section (after its table started) is marked closed so the next heading does not record a
    // second, empty paragraph for the section it just left.
    if (currentBlock.closed) return;
    const blankOnly = currentBlock.lines.length === 0 || currentBlock.lines.every((line) => line.trim() === "");
    if (currentBlock.section !== null) {
      // EVERY section gets a block, even one that is only the blank line between its heading and
      // its table. That row is what records where the section sits in the document, which is the
      // only reliable way to put the sections back in the order the file had them.
      if (blankOnly) currentBlock.lines = [""];
      proseBlocks.push(currentBlock);
    } else if (!blankOnly) {
      // The opening block's first line is the file's title; everything else is preamble. The
      // distinction is stored so a reader of the table can tell the two apart.
      currentBlock.kind = "title";
      proseBlocks.push(currentBlock);
    }
    currentBlock = { section, lines: [], closed: false };
  };

  const flush = () => {
    // Row 0 is the column header, row 1 the separator; data starts after them.
    const data = tableRows.filter((cells) => !isSeparatorRow(cells)).slice(1);
    for (const cells of data) {
      const term = cells[0] || "";
      if (!term || isSeparatorRow([term])) continue;
      rows.push({
        term,
        rendering: cells[1] || "",
        notes: cells.slice(2).join(" | ").trim(),
        section,
      });
    }
    tableRows = [];
  };

  for (const rawLine of String(markdown || "").split("\n")) {
    const line = rawLine.trim();
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      flush();
      closeBlock();
      section = heading[1].replace(/\*\*/g, "").trim();
      currentBlock = { section, lines: [], closed: false };
      tablePhase = false;
      continue;
    }
    if (line.startsWith("|")) {
      // The first table line of a section ends the prose that introduced it. Everything after
      // the table is a different thing, and `tablePhase` is what keeps the two apart: without it
      // the blank line that TRAILS one section's table would be stored as a second paragraph of
      // that section and rendered as an extra blank line before it.
      if (tableRows.length === 0 && !tablePhase) {
        closeBlock();
        currentBlock.closed = true;
        tablePhase = true;
      }
      tableRows.push(splitTableRow(line));
      continue;
    }
    flush();
    const kept = rawLine.trimEnd();
    if (tablePhase) {
      // Prose AFTER a section's table. This renderer writes prose before a table and nothing
      // else, so it cannot put such a line back where it was; the honest move is to report it in
      // the import result rather than drop it on the way in.
      if (line) unplacedProse.push({ section, text: kept });
      continue;
    }
    if (title === null && currentBlock.section === null && /^#\s/.test(line)) title = kept;
    currentBlock.lines.push(kept);
  }
  flush();
  closeBlock();

  const opening = proseBlocks.find((block) => block.section === null) || { section: null, lines: [] };
  const preamble = title === null ? opening.lines : opening.lines.slice(1);

  return { rows, title, preamble, proseBlocks, unplacedProse };
}

/**
 * The passages a row's own notes quote — the candidates for `governs` evidence (review 05 §3.6).
 *
 * A glossary row's notes quote the book constantly (`三つ編み魔王のパンジー 3559`,
 * `"もう、『僕』の出番はおしまいだ"`), and those quotations name the passage the row is the
 * decision about. They are not the row's term, so they cannot support a `quote` claim — the
 * book does not print the term — but they do support the weaker, honest one: this row is about
 * a passage that is really there, at this line.
 *
 * Only spans that look like prose survive: something in quotes or brackets, at least
 * `GOVERNS_MIN_SPAN_CHARS` once whitespace is removed, and containing at least one CJK
 * character. A four-letter English fragment in a note is a translation choice, not a passage.
 *
 * @param {string} notes - One row's notes cell.
 * @returns {string[]} Candidate spans, longest first.
 */
function noteQuotedSpans(notes) {
  const text = String(notes || "");
  const spans = new Set();
  const patterns = [/「([^」]+)」/g, /『([^』]+)』/g, /[“"]([^“"]{4,})[”"]/g, /[（(]([^（）()]{4,})[）)]/g];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const span = String(match[1] || "").trim();
      if (normalizeQuote(span).length < GOVERNS_MIN_SPAN_CHARS) continue;
      if (!/[぀-ヿ一-鿿가-힯]/.test(span)) continue;
      spans.add(span);
    }
  }
  return [...spans].sort((a, b) => b.length - a.length);
}

/**
 * Search the volume's chapters for the first of several spans, and cite the line it was found on.
 *
 * @param {string} volumeDir
 * @param {Array<{id: string, file: string}>} chapters
 * @param {number} volume
 * @param {string[]} spans
 * @param {"quote"|"governs"} kind
 * @returns {{evidence: Array<Object>, matched: "verbatim"|"skeleton", span: string}|null}
 */
function searchSpans(volumeDir, chapters, volume, spans, kind) {
  for (const span of spans) {
    if (!normalizeQuote(span)) continue;
    for (const chapter of chapters) {
      if (!chapter.file) continue;
      const lines = readChapterLines(volumeDir, chapter.file);
      if (!lines) continue;
      for (let i = 0; i < lines.length; i += 1) {
        const matched = matchQuoteOnLine(lines[i], span);
        if (!matched) continue;
        return { evidence: [{ volume, chapter: chapter.id, line: i + 1, quote: span, kind, matched }], matched, span };
      }
    }
  }
  return null;
}

/**
 * Find a row's evidence, and say which kind of claim it supports.
 *
 * Two stages, in the order review 05 §3.6 sets:
 *
 *   1. **`quote`** — one of the row's own spellings (or its rendering) occurs in the volume's
 *      source text. The line number is **discovered**, not claimed, which is what makes an
 *      imported row's evidence verify by construction rather than by assertion.
 *   2. **`governs`** — the row's notes quote a passage that IS in the source text. The row's
 *      term is not printed anywhere; the row is the decision made about that passage. This is
 *      a second kind of evidence, not an exemption: it still has to name a real line, and the
 *      line still has to contain what is cited.
 *
 * A row that can support neither is refused and reported. That is the rule working, not a gap
 * in it (review 05 §3.6): the store has no path for a claim nobody can check.
 *
 * @param {string} volumeDir
 * @param {Array<{id: string, file: string}>} chapters
 * @param {number} volume
 * @param {{term: string, rendering: string, notes: string}} row
 * @returns {{evidence: Array<Object>|null, kind: "quote"|"governs"|null, matched: string|null, tried: string[], governsTried: string[]}}
 */
function findRowEvidence(volumeDir, chapters, volume, row) {
  const quoteCandidates = [...glossaryTermSpans(row.term)];
  if (row.rendering) quoteCandidates.push(row.rendering.replace(/^[*_]+|[*_]+$/g, "").trim());
  const tried = quoteCandidates.filter((candidate) => normalizeQuote(candidate)).slice(0, QUOTE_CANDIDATES_PER_ROW);
  const quoteHit = searchSpans(volumeDir, chapters, volume, tried, "quote");
  if (quoteHit) {
    return { evidence: quoteHit.evidence, kind: "quote", matched: quoteHit.matched, tried, governsTried: [] };
  }

  const governsTried = noteQuotedSpans(row.notes).slice(0, QUOTE_CANDIDATES_PER_ROW);
  const governsHit = searchSpans(volumeDir, chapters, volume, governsTried, "governs");
  if (governsHit) {
    return { evidence: governsHit.evidence, kind: "governs", matched: governsHit.matched, tried, governsTried };
  }

  return { evidence: null, kind: null, matched: null, tried, governsTried };
}

/**
 * The first-person forms a glossary's Characters rows declare as belonging to a character.
 *
 * The glossary already answers the question the reference record cannot answer by itself — *whose "I" is
 * this book narrated by?* Volume 1's Characters row for 如月雨露 says so in as many words:
 *
 * > Protagonist; … Narrator: switches between 僕 and 俺 (see 僕／俺)
 *
 * That sentence is the only place in the pipeline where the answer is written, and until now nothing read
 * it. The consequence was measured on the real volumes: the extraction wrote `俺（ジョーロ）` for the
 * protagonist, the store had no declaration linking 俺 to anybody, and it made a roster entry out of the
 * pronoun — 282 claims under `俺` in volume 2 against 190 under 如月雨露 (gotcha 115).
 *
 * The rule is deliberately the narrowest thing that fires on this row and nothing else: **a row under the
 * Characters section whose notes contain a bare first-person pronoun as a whole token declares that
 * pronoun as an alias of the character the row is about.** Not a nickname section, not a substring, not a
 * prose pattern about narrators.
 *
 * Measured against all 17 real glossaries before it was pinned: **17 hits, one per volume, all of them the
 * same row** (如月雨露, the same sentence, pronouns 僕 and 俺). Zero hits on any other character row, zero
 * rows naming more than one character, zero false positives. The 671 rows under the glossary's "Character
 * Nicknames" heading were measured as a candidate too and **rejected**: 330 of them name exactly one
 * Characters row, 73 name two, and 268 name none — and the ones that name one are mostly joke aliases
 * ("Joro's mock-heroic epithets for Pansy"), where the notes name the person by *their* nickname rather
 * than by their roster name. A declaration rule that guesses the owner is a rule that files claims under
 * the wrong person, which is the one mistake this layer cannot undo.
 *
 * A pronoun two different Characters rows both declare is refused rather than split: that is the glossary
 * saying two people narrate in the first person, and the record has to say so out loud instead of picking
 * whichever row the table reaches first.
 *
 * @param {{rows: Array<{term: string, rendering: string, notes: string, section: string}>}} parsed - A parsed glossary.
 * @returns {{declarations: Array<{key: string, alias: string, reason: string}>, ambiguous: Array<{alias: string, keys: string[]}>}}
 *   `declarations` is what to hand `castAlias`; `ambiguous` is what to report and not apply.
 */
function firstPersonAliasDeclarations(parsed) {
  const characterRows = (parsed.rows || []).filter(
    (row) => (row.section || "").trim().toLowerCase() === GLOSSARY_CHARACTER_SECTION.toLowerCase()
  );

  /** @type {Map<string, string[]>} alias -> the Characters rows that declared it */
  const declaredBy = new Map();
  const declarations = [];

  for (const row of characterRows) {
    const spans = glossaryTermSpans(row.term);
    const key = spans[0] || String(row.term || "").trim();
    if (!key) continue;
    for (const pronoun of barePronounTokensIn(row.notes)) {
      if (pronoun === key) continue;
      if (!declaredBy.has(pronoun)) declaredBy.set(pronoun, []);
      declaredBy.get(pronoun).push(key);
      declarations.push({
        key,
        alias: pronoun,
        reason: `the glossary's ${GLOSSARY_CHARACTER_SECTION} row for ${key} names ${pronoun}: ${String(row.notes || "").trim()}`,
      });
    }
  }

  const ambiguous = [];
  for (const [alias, keys] of declaredBy) {
    const distinct = [...new Set(keys)];
    if (distinct.length > 1) ambiguous.push({ alias, keys: distinct });
  }
  const ambiguousAliases = new Set(ambiguous.map((item) => item.alias));
  return {
    declarations: declarations.filter((entry) => !ambiguousAliases.has(entry.alias)),
    ambiguous,
  };
}

/**
 * The words for "I" that appear in a notes cell as whole tokens.
 *
 * Token boundaries matter here: 俺様 and うちの子 are not the word for "I" on its own, and the closed list
 * in `name-resolution.js` is only ever about that word. Splitting the cell on whitespace and on the
 * brackets and separators the glossary uses is what keeps `僕／俺` reading as two pronouns and `俺様`
 * reading as neither.
 *
 * @param {string} notes - One glossary row's notes cell.
 * @returns {string[]} the bare pronouns, in the order they appear, without repeats
 */
function barePronounTokensIn(notes) {
  const tokens = String(notes || "")
    .split(/[\s,;、・／/|「」『』（）()【】→\-–—]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const token of tokens) {
    if (!isBareFirstPersonPronoun(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

/**
 * Import a glossary file into a volume's store.
 *
 * Three things happen, in this order:
 *
 *   1. the document's own prose (title line, preamble paragraphs) is stored so the renderer can
 *      put it back verbatim (review 05 §3.4);
 *   2. a row under the `Characters` section registers its term in the cast. The glossary's
 *      Characters section IS the volume's roster, and the roster is what the integrity check
 *      "the character-voice reference covers fewer characters than the cast holds" compares
 *      against — without it, a voice reference that lost most of the cast would match its own
 *      reduced cast perfectly and look clean (review 05 §4, D).
 *   3. each row is inserted with evidence discovered from the volume's own source text, or
 *      refused and reported.
 *
 * @param {ReferenceStore} store - Opened for the volume the glossary belongs to.
 * @param {string} markdown - The glossary file's content.
 * @param {{volume?: number}} [opts]
 * @returns {{ok: boolean, imported: Array<Object>, importedCount: number, refused: Array<{row: Object, because: string}>, facts: Array<Object>, castRegistered: number, proseStored: number, unplacedProse: Array<{section: string, text: string}>}}
 */
function importGlossary(store, markdown, { volume } = {}) {
  const vol = Number(volume === undefined ? store.volume : volume);
  const parsed = parseGlossaryMarkdown(markdown);
  const listed = store.listChapters();
  const chapters = listed.chapters;

  const proseStored = storeDocumentProse(store, DOCUMENT_GLOSSARY, parsed.proseBlocks).stored;
  markDocumentMirrored(store, DOCUMENT_GLOSSARY, vol);

  const imported = [];
  const refused = [];
  const carried = [];
  let castRegistered = 0;

  for (const row of parsed.rows) {
    const isCharacterRow = (row.section || "").trim().toLowerCase() === GLOSSARY_CHARACTER_SECTION.toLowerCase();
    if (isCharacterRow) {
      const spans = glossaryTermSpans(row.term);
      const registered = store.upsertCast({
        key: spans[0] || row.term,
        aliases: spans.slice(1),
        firstSeenVolume: vol,
      });
      if (registered.ok) castRegistered += 1;
    }

    // The glossary is cumulative: this file contains every row the earlier volumes published, and
    // this store already holds those rows, because copy-forward carried them with their own
    // provenance. Re-importing them would stamp a volume-01 term as established in volume 05 and put
    // the same term in the store twice, so a row the record already has is counted as carried, not
    // imported.
    //
    // Asked BEFORE the evidence rule, on purpose. The evidence rule decides what this store may
    // *adopt*; a row the record already owns was adopted by the volume that owns it, and it cites
    // that volume's text. Asking it to also appear in volume 05's text is not a check — it is the
    // same row refused 40 times over, once per volume it is merely carried through, and it makes the
    // report read as damage. (Measured on the real volume 02: 42 of its 46 refusals were rows the
    // record already held from volume 1.)
    if (documentTermAlreadyStored(store, row.term)) {
      carried.push(row.term);
      continue;
    }

    const { evidence, kind, tried, governsTried } = findRowEvidence(store.volumeDir, chapters, vol, row);
    if (!evidence) {
      refused.push({
        row,
        because:
          `none of this row's spellings (${tried.join(", ") || row.term}) occurs in volume ${vol}'s source text, ` +
          (governsTried.length
            ? `and none of the passages its notes quote (${governsTried.join(", ")}) occurs there either, `
            : "and its notes quote no passage to govern, ") +
          "so the row supports neither kind of evidence this store accepts.",
      });
      continue;
    }
    const result = store.insertFact({
      key: null,
      aspect: "term_usage",
      label: null,
      section: row.section || null,
      body: row.notes || row.rendering || row.term,
      examples: [row.term, row.rendering].filter(Boolean),
      evidence,
      establishedVolume: vol,
      appliesFromVolume: vol,
    });
    if (!result.ok) {
      refused.push({ row, because: result.refusal ? result.refusal.because : "insert refused" });
      continue;
    }
    imported.push(result.fact);
  }

  // The glossary's Characters rows declare which first-person forms belong to which character, and the
  // declaration is applied here — after the Characters rows have become cast entries, and before any
  // extraction name is resolved. Asked in this order, `俺（ジョーロ）` has somebody to land on; asked any
  // other way, the store invents a character out of the word for "I". See
  // `firstPersonAliasDeclarations` for what this rule was measured against before it was pinned.
  const aliasDeclarations = firstPersonAliasDeclarations(parsed);
  const aliasesDeclared = [];
  const aliasRefused = [];
  for (const entry of aliasDeclarations.declarations) {
    const result = store.castAlias(entry.key, entry.alias, entry.reason);
    if (result.ok) aliasesDeclared.push({ key: entry.key, alias: entry.alias });
    else aliasRefused.push({ key: entry.key, alias: entry.alias, because: result.refusal.because });
  }

  return {
    ok: refused.length === 0 && parsed.unplacedProse.length === 0,
    imported,
    importedCount: imported.length,
    carried,
    refused,
    facts: imported,
    castRegistered,
    proseStored,
    unplacedProse: parsed.unplacedProse,
    aliasesDeclared,
    aliasRefused,
    ambiguousAliases: aliasDeclarations.ambiguous,
  };
}

/**
 * Whether the store already holds this term as a row of the document.
 *
 * Matched on the term the way the glossary's own carry-forward gate matches it — the term is the
 * row's identity, and a term that moved sections is still the same term.
 *
 * @param {ReferenceStore} store
 * @param {string} term
 * @returns {boolean}
 */
function documentTermAlreadyStored(store, term) {
  const needle = normalizeQuote(term);
  if (!needle) return false;
  const rows = store.db
    .prepare("SELECT examples FROM facts WHERE aspect = 'term_usage' AND source_stage != ?")
    .all(EXTRACTION_SOURCE_STAGE);
  for (const row of rows) {
    try {
      const spans = JSON.parse(row.examples || "[]");
      if (Array.isArray(spans) && normalizeQuote(String(spans[0] || "")) === needle) return true;
    } catch {
      /* an unparsable examples column is not a match */
    }
  }
  return false;
}

/**
 * Render a volume's glossary rows back into the file shape.
 *
 * Deterministic by construction: the document's own prose first, exactly as it was stored;
 * then sections in the order their first row was inserted, rows in insertion order, cells
 * escaped the same way every time. Two runs over the same rows are byte-identical (slice 4's
 * second criterion).
 *
 * @param {ReferenceStore} store
 * @param {{volume?: number, title?: string}} [opts] - `title` is only used when the store holds
 *   no prose of its own; a store that imported a titled file renders that title.
 * @returns {string} The file content, ending in a newline.
 */
function renderGlossary(store, { volume, title = GLOSSARY_TITLE } = {}) {
  const vol = Number(volume === undefined ? store.volume : volume);
  const rows = store
    .db.prepare(
      "SELECT id, section, examples, body FROM facts WHERE aspect = 'term_usage' AND source_stage != ? ORDER BY ord, id"
    )
    .all(EXTRACTION_SOURCE_STAGE);

  const proseRows = readDocumentProse(store, DOCUMENT_GLOSSARY);
  const opening = proseRows.filter((row) => row.section === null).map((row) => row.text);
  const sectionProse = new Map();
  for (const row of proseRows) {
    if (row.section === null) continue;
    if (!sectionProse.has(row.section)) sectionProse.set(row.section, { ord: row.ord, lines: [] });
    sectionProse.get(row.section).lines.push(row.text);
  }

  const sections = new Map();
  for (const row of rows) {
    const section = row.section === null || row.section === "" ? "(no section)" : row.section;
    if (!sections.has(section)) sections.set(section, { ord: row.ord, items: [] });
    let term = "";
    let rendering = "";
    try {
      const examples = JSON.parse(row.examples || "[]");
      term = String(examples[0] || "");
      rendering = String(examples[1] || "");
    } catch {
      /* an unparsable examples column renders as an empty term cell, which the diff will show */
    }
    sections.get(section).items.push({ term, rendering, notes: row.body });
  }

  // Sections are ordered by where their prose sits in the document, because every section the
  // importer saw has a prose block — even one that is only the blank line before its table — and
  // that is the only record of the document's own order. A section with no prose at all (a store
  // built by insert_fact rather than by import) follows, in the order its first row was inserted.
  const names = new Set([...sections.keys(), ...sectionProse.keys()]);
  const rankOf = (name) => (sectionProse.has(name) ? 0 : 1);
  const ordOf = (name) =>
    sectionProse.has(name)
      ? sectionProse.get(name).ord
      : sections.has(name)
        ? sections.get(name).ord
        : Number.MAX_SAFE_INTEGER;
  const ordered = [...names].sort((a, b) => rankOf(a) - rankOf(b) || ordOf(a) - ordOf(b) || a.localeCompare(b));

  const out = opening.length ? [...opening] : [title, ""];
  for (const name of ordered) {
    out.push(`## ${name}`);
    const prose = sectionProse.get(name);
    if (prose && prose.lines.length) out.push(...prose.lines);
    else out.push("");
    const items = sections.has(name) ? sections.get(name).items : null;
    if (items && items.length) {
      out.push(`| ${GLOSSARY_HEADER.join(" | ")} |`);
      out.push(`|${GLOSSARY_HEADER.map(() => "---").join("|")}|`);
      for (const item of items) {
        out.push(`| ${escapeCell(item.term)} | ${escapeCell(item.rendering)} | ${escapeCell(item.notes)} |`);
      }
    }
    out.push("");
  }
  void vol;
  return out.join("\n").replace(/\n+$/, "") + "\n";
}

/**
 * Make a value safe for one Markdown table cell: no pipes, no line breaks.
 * @param {string} value
 * @returns {string}
 */
function escapeCell(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/\|/g, "\\|")
    .replace(/\s*\n\s*/g, " ")
    .trim();
}

module.exports = {
  GLOSSARY_TITLE,
  GLOSSARY_HEADER,
  GLOSSARY_CHARACTER_SECTION,
  glossaryTermSpans,
  parseGlossaryMarkdown,
  noteQuotedSpans,
  findRowEvidence,
  barePronounTokensIn,
  firstPersonAliasDeclarations,
  importGlossary,
  renderGlossary,
  escapeCell,
};
