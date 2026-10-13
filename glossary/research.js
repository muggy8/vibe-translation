/**
 * glossary/research.js — look the researchable terms up, read what came back, file it.
 *
 * Slice 5 of `glossary/plan/01-glossary-route.md` replaced this file's whole shape, so the old one is
 * worth naming before what replaced it is read:
 *
 *   **Before.** One agent per term, `maxSteps: 15`, handed `wiki_search` / `wiki_extract` and `editFile`,
 *   told to replace the `- (pending: <term>)` line the workflow had pre-written in `glossary-research.md`.
 *   The notes landed in a Markdown file that nothing in the stage read back, and the terms it looked up
 *   were every term the extraction returned — researchable or not. That is where the 494 research
 *   conversations the last 17-volume run paid for came from, and it is why the cost was never measurable:
 *   an agent turn is not a call, it is a conversation, and the answer lived in a file the record never
 *   saw.
 *
 *   **Now.** Three steps, and only the middle one asks the model anything:
 *     1. **code** looks the term up (`research.js`'s `researchTerms`, the Wikipedia Action API) — no model;
 *     2. **one tool-less one-shot** reads the extracts it got and says what the term refers to;
 *     3. **code** files the answer onto the volume's record (`fileResearchNote`), where the render can
 *        reach it.
 *
 * The result is the point of the rewrite: a research answer that arrives as a **row the store owns**
 * reaches the published `glossary.md` (slice 5's other half), and a research answer that arrives as prose
 * in a notes file reaches only whoever opens the file. It is also what makes the bound enforceable — a
 * one-shot is countable, an agent turn is not — and what makes the whole pass testable offline, because
 * no agent and no sandbox stands in the middle of it any more.
 *
 * Two things this pass does NOT do:
 *   - it does not edit a glossary row. The note is its own record, owned by the asking volume
 *     (`utils/reference-store/research-notes.js`), and the render is where it meets the row;
 *   - it does not run anything in parallel. The model endpoint on this machine answers one request at a
 *     time (AGENTS.md §7), and the old `Promise.allSettled` over per-term agents bought nothing there
 *     while lengthening every wait.
 *
 * Part of the glossary.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs").promises;
require("../types"); // JSDoc type definitions
const harness = require("../harness");
const { RESEARCH_NOTE_MAX_CHARS, fileResearchNote } = require("../utils/reference-store");
const { researchEnabled } = require("./config");
const { RESEARCH_MAX_TERMS_PER_VOLUME, selectResearchTargets } = require("./researchable");

/**
 * The default lookup: the Wikipedia Action API through `research.js`.
 *
 * Kept behind a parameter in `researchVolumeTerms` rather than called inline, so the offline suite can
 * stand a fixture in front of it without this module knowing the difference — and so `research.js` itself
 * (which is not part of this slice's folder) stays untouched.
 *
 * @param {Array<{term: string, query?: string}>} terms - The terms to look up.
 * @returns {Promise<Array<{term: string, query: string, results: Array<Object>, found: boolean}>>}
 */
async function defaultWikiLookup(terms) {
  const { researchTerms } = require("../research");
  return researchTerms(terms);
}

/** The research reading call's system prompt (static, tool-less). */
const RESEARCH_SYSTEM_PROMPT =
  "You are a reference researcher supporting the translation of a light-novel series. You are given ONE " +
  "glossary term and the plain-text introductions that a reference search returned for it. Say what the " +
  "term refers to in the real world, and name the established target-language name if the search results " +
  "print one. Report only what the supplied extracts actually say: no speculation, no invented page, no " +
  "reference that was not given to you. If none of the extracts is about this term, say so — an honest " +
  "\"nothing matched\" is the correct answer and a plausible one is a defect. Answer with a single JSON " +
  "object and nothing else.";

/**
 * The research reading prompt for one term: the term, what the glossary already says about it, and what
 * the lookup returned.
 *
 * The glossary's own note is included because the question a translator has is not "what is this word"
 * but "is the thing this row describes a real one, and what is it called in English" — and the row's note
 * is the only place the book's own use of the term is written down.
 *
 * @param {{term: string, rendering?: string, notes?: string, section?: string, targetLanguage: string}} row
 * @param {Array<{lang?: string, provider?: string, title: string|null, extract?: string, error?: string}>} results
 * @returns {string}
 */
function buildResearchReadingPrompt(row, results) {
  const lines = [];
  lines.push(`Term: ${row.term}`);
  if (row.rendering) lines.push(`Current rendering in the glossary: ${row.rendering}`);
  if (row.section) lines.push(`Filed under: ${row.section}`);
  if (row.notes) lines.push(`What the glossary already says: ${row.notes}`);
  lines.push("");
  lines.push("Reference search results supplied to you (this is everything you have — do not add another):");
  for (const result of results) {
    const source = result.lang || result.provider || "source";
    if (result.error) {
      lines.push(`- [${source}] lookup error: ${result.error}`);
      continue;
    }
    if (!result.title) {
      lines.push(`- [${source}] no page matched`);
      continue;
    }
    lines.push(`- [${source}] ${result.title}${result.url ? ` — ${result.url}` : ""}`);
    const extract = String(result.extract || "").replace(/\s*\n\s*/g, " ").trim();
    if (extract) lines.push(`    ${extract}`);
  }
  lines.push("");
  lines.push(
    "Answer with ONE JSON object, no prose around it and no code fence:\n" +
      "{\n" +
      '  "found": true or false,\n' +
      '  "page": the title of the result this answer is about, or "" when none is,\n' +
      '  "lang": the language code of that result ("ja", "en", …), or "",\n' +
      '  "url": that result\'s URL, or "",\n' +
      `  "note": 1-3 sentences a translator can use — what the term refers to, and any established ${row.targetLanguage} name the results print\n` +
      "}\n" +
      `Keep "note" under ${RESEARCH_NOTE_MAX_CHARS} characters: it is printed inside a table cell of the glossary.\n` +
      "If none of the results is about this term, set \"found\" to false and make \"note\" say that nothing matched."
  );
  return lines.join("\n");
}

/**
 * The `response_format` payload for the research reading call.
 *
 * Declared beside {@link parseResearchAnswer}. The prompt already spells the object out key by key
 * (`buildResearchReadingPrompt`'s "Answer with ONE JSON object" block: `found`, `page`, `lang`, `url`,
 * `note`), so the schema is that block, and nothing wider: all five required, all strings except the
 * boolean, no extra keys. `note` is required as a **string that may be empty** rather than a non-empty
 * one, because the parser is what enforces the non-empty rule (`parseResearchAnswer` throws on a blank
 * note) and the filing door refuses the row — a schema that forced a non-empty note would push the model
 * to write a plausible one for a term nothing matched, which is the exact defect the prompt warns about.
 *
 * This is the **only** read pass in the pipeline that can carry a shape at all, and the reason is the root:
 * this answer is already a JSON object, and this endpoint refuses a `response_format` JSON Schema whose root
 * is anything but an object (measured 2026-10-13 — HTTP 400 in 161 ms, 0 tokens, "response_format schema
 * must accept only JSON objects at its root"; `ai/one-shot.js` refuses such a schema before it is sent). The
 * term list, the voice extraction and the style extraction answer as JSON **arrays**, so they could not be
 * declared as themselves; they now declare the list **inside an object** — `{"terms": […]}`,
 * `{"entries": […]}`, `{"constructs": […]}` — beside their own parsers (`AGENTS.md` gotcha 138). This one
 * needed no such change, because its answer was already an object.
 *
 * Not measured against the real endpoint on its own. It is the same class of schema the four acceptance
 * graders have been sending to it successfully (`{score, band, note}`, `strict: true`,
 * `additionalProperties: false`), which is why it was kept; the acceptance shape is proven on this machine,
 * this one is inferred from it. What HAS been proven on this machine since is the class itself, on three
 * sibling shapes: the term list, the voice extraction and the style extraction each sent a closed or open
 * object-rooted schema to this endpoint and each answered as one object holding its list (5,356 / 8,210 /
 * 5,944 tokens, all `finish_reason=stop`, all parsed).
 *
 * @returns {Object} The `response_format` request field.
 */
function researchResponseFormat() {
  return {
    type: "json_schema",
    json_schema: {
      name: "glossary_research_answer",
      strict: true,
      schema: {
        type: "object",
        properties: {
          found: { type: "boolean" },
          page: { type: "string" },
          lang: { type: "string" },
          url: { type: "string" },
          note: { type: "string" },
        },
        required: ["found", "page", "lang", "url", "note"],
        additionalProperties: false,
      },
    },
  };
}

/**
 * Read the research call's answer.
 *
 * Tolerant of a code fence and of a model that wraps the object in a sentence, and strict about the one
 * thing that matters: a non-empty `note`. An answer with no note is not an answer, and the filing door
 * refuses it rather than storing a row that says nothing.
 *
 * @param {string} output - The model's reply.
 * @returns {{found: boolean, page: string, lang: string, url: string, note: string}}
 * @throws {Error} When the reply carries no JSON object, or no note.
 */
function parseResearchAnswer(output) {
  const text = String(output || "").trim();
  if (!text) throw new Error("the research call returned an empty reply");
  let body = text;
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) body = fence[1].trim();
  const first = body.indexOf("{");
  const last = body.lastIndexOf("}");
  if (first === -1 || last === -1 || last < first) {
    throw new Error("the research call returned no JSON object");
  }
  const parsed = JSON.parse(body.slice(first, last + 1));
  const note = typeof parsed.note === "string" ? parsed.note.trim() : "";
  if (!note) throw new Error("the research call returned no note");
  return {
    found: parsed.found === true,
    page: typeof parsed.page === "string" ? parsed.page.trim() : "",
    lang: typeof parsed.lang === "string" ? parsed.lang.trim() : "",
    url: typeof parsed.url === "string" ? parsed.url.trim() : "",
    note,
  };
}

/**
 * The lines the lookup produced for one term, for the log.
 *
 * @param {Array<{lang?: string, provider?: string, title: string|null, url: string|null, error?: string}>} results
 * @returns {string[]} One line per result the search returned.
 */
function lookupLogLines(results) {
  const lines = [];
  for (const result of Array.isArray(results) ? results : []) {
    const source = result.lang || result.provider || "source";
    if (result.error) lines.push(`- lookup [${source}]: error — ${result.error}`);
    else if (!result.title) lines.push(`- lookup [${source}]: no page matched`);
    else lines.push(`- lookup [${source}]: ${result.title}${result.url ? ` — ${result.url}` : ""}`);
  }
  if (!lines.length) lines.push("- lookup: nothing was searched");
  return lines;
}

/**
 * The research log this volume's pass produced.
 *
 * `glossary-research.md` is no longer a file an agent writes into. It is a record of **what this volume
 * asked, what came back, and what the bound refused to pay for** — written by code, from the same
 * selection the pass ran on, so the file and the behaviour cannot drift apart.
 *
 * Every skipped term is named. A bound that hides what it cut is a bound nobody can argue with, and the
 * account owner is the one who decides whether 12 is the right number.
 *
 * @param {{volume: string, limit: number}} header
 * @param {{targets: Array<Object>, skipped: Array<Object>, notResearchable: Array<Object>, entries: Array<Object>}} body
 *   The volume's accumulated lists. On the chapter-by-chapter route each item carries a `chapter`, and the
 *   file names it, because a reader of the log needs to know which chapter's reading produced an answer.
 * @returns {string} The file content, ending in a newline.
 */
function renderResearchLog(header, body) {
  const where = (item) => (item.chapter ? ` _(chapter ${item.chapter})_` : "");
  const out = [
    `# Research Notes — Volume ${header.volume}`,
    "",
    `_Written by the research pass itself: what it looked up, what the lookup returned, what the reading call said about it, and what the bound refused to pay for. No agent writes this file._`,
    "",
    `_Asked: ${body.targets.length} research turn(s). Skipped by the bound: ${body.skipped.length}. ` +
      `Not researchable: ${body.notResearchable.length}. The bound is ${header.limit} research turns per ` +
      `volume, and it is a constant in \`glossary/researchable.js\`, not a setting._`,
    "",
    `## Asked (${body.targets.length})`,
    "",
  ];
  for (const entry of body.entries) {
    out.push(`### ${entry.term}${entry.section ? ` — ${entry.section}` : ""}${where(entry)}`);
    out.push(`- why asked: ${entry.because}`);
    out.push(...entry.lookup);
    if (entry.filed) {
      out.push(`- filed: ${entry.found ? "yes" : "nothing matched"} — ${entry.note}`);
      if (entry.page) out.push(`- source: ${[entry.lang, entry.url].filter(Boolean).join(", ")}`);
    } else {
      out.push(`- filed: NO — ${entry.because}`);
    }
    out.push("");
  }

  out.push(`## Skipped by the bound (${body.skipped.length})`, "");
  if (body.skipped.length) {
    out.push(
      `_Researchable, but this volume had already spent its ${header.limit} turns. These got no lookup and_ ` +
        `_no reading call, and they are named here rather than left out._`,
      ""
    );
    for (const row of body.skipped) out.push(`- ${row.term}${row.section ? ` (${row.section})` : ""}${where(row)} — ${row.because}`);
    out.push("");
  } else {
    out.push("_None: this volume's researchable rows fit inside the bound._", "");
  }

  out.push(`## Not researchable (${body.notResearchable.length})`, "");
  if (body.notResearchable.length) {
    for (const row of body.notResearchable) out.push(`- ${row.term}${row.section ? ` (${row.section})` : ""}${where(row)} — ${row.because}`);
    out.push("");
  } else {
    out.push("_Every row this volume filed is researchable._", "");
  }

  return out.join("\n").replace(/\n+$/, "") + "\n";
}

/**
 * Run this volume's research pass.
 *
 * The terms come from the volume's own record, through `selectResearchTargets` — so a term the record
 * refused to file costs nothing, a term carried from an earlier volume costs nothing, and the number of
 * reading calls is bounded by `RESEARCH_MAX_TERMS_PER_VOLUME` with no way to raise it.
 *
 * The budget lives on `ctx.researchTurnsLeft` rather than in this call's arguments, because the
 * chapter-by-chapter route calls this once per chapter and the bound is **per volume**: a seven-chapter
 * volume is allowed twelve research turns, not twelve per chapter. The whole-installment route calls it
 * once and spends from the same number.
 *
 * @param {{values: Object, researchNotesFile: string, refStore: Object|null, researchTurnsLeft?: number, researchLog?: Object}} ctx
 * @param {{lookup?: Function, only?: Array<string>, chapter?: string|null}} [opts]
 *   `lookup` stands where Wikipedia stands (the offline suite passes a fixture); the stage never passes
 *   it. `only` narrows the candidates to the rows one chapter just filed, so a chapter does not pay a
 *   second time for a term an earlier chapter of the same volume already looked up. `chapter` is a label
 *   for the log.
 * @returns {Promise<{ran: boolean, asked: number, filed: number, refused: number, notFound: number, skipped: Array<Object>, notResearchable: number, limit: number, capped: boolean, turnsLeft: number, entries: Array<Object>}>}
 * @throws {Error} Only when the record is not open — a volume with no record has no rows to classify, and
 *   silently skipping that is how a stage reports research it never did.
 */
async function researchVolumeTerms(ctx, { lookup = defaultWikiLookup, only = null, chapter = null } = {}) {
  const { values } = ctx;
  const volume = values.INSTALLMENT_NUMBER;
  if (!researchEnabled) {
    console.log(`Volume ${volume}: research is off (RESEARCH_ENABLED=false) — no lookup, no reading call, no notes file.`);
    return { ran: false, asked: 0, filed: 0, refused: 0, notFound: 0, skipped: [], notResearchable: 0, limit: RESEARCH_MAX_TERMS_PER_VOLUME, capped: false, turnsLeft: RESEARCH_MAX_TERMS_PER_VOLUME, entries: [] };
  }
  if (!ctx.refStore) {
    throw new Error(
      `Volume ${volume}: the research pass has no reference record to ask, and the glossary is ` +
        "rendered out of that record. Open the volume's record (openGlossaryRecord) before researching."
    );
  }

  const limit = ctx.researchTurnsLeft === undefined ? RESEARCH_MAX_TERMS_PER_VOLUME : ctx.researchTurnsLeft;
  const selection = selectResearchTargets(ctx.refStore, volume, { limit });
  // `only` is a filter, and an empty filter means "nothing this time" — not "everything". Getting that
  // backwards would let a chapter that found no terms research the whole volume.
  const wanted = Array.isArray(only) ? new Set(only.map((term) => String(term))) : null;
  const targets = wanted ? selection.targets.filter((row) => wanted.has(row.term)) : selection.targets;
  const skipped = wanted ? selection.skipped.filter((row) => wanted.has(row.term)) : selection.skipped;
  const notResearchable = wanted ? selection.notResearchable.filter((row) => wanted.has(row.term)) : selection.notResearchable;

  ctx.researchLog = ctx.researchLog || { targets: [], skipped: [], notResearchable: [], entries: [] };
  for (const row of targets) ctx.researchLog.targets.push({ ...row, chapter });
  for (const row of skipped) ctx.researchLog.skipped.push({ ...row, chapter });
  for (const row of notResearchable) ctx.researchLog.notResearchable.push({ ...row, chapter });

  console.log(
    `Volume ${volume}${chapter ? ` chapter ${chapter}` : ""}: ${targets.length} researchable row(s) to ask ` +
      `(the bound is ${RESEARCH_MAX_TERMS_PER_VOLUME} research turns per volume, ${limit} left)` +
      `${skipped.length ? ` — ${skipped.length} of this volume's researchable row(s) are over the bound` : ""}.`
  );
  if (skipped.length) {
    console.warn(
      `Volume ${volume}: the research bound (${RESEARCH_MAX_TERMS_PER_VOLUME} per volume) will not pay for ` +
        `${skipped.length} researchable row(s): ${skipped.map((row) => row.term).join(", ")}. ` +
        "They are named in glossary-research.md."
    );
  }

  // One lookup call over the whole target list: `researchTerms` walks its terms (and its languages) one
  // at a time with a politeness delay, which is the shape a public API asks for.
  const looked = targets.length ? await lookup(targets.map((row) => ({ term: row.term, query: row.term }))) : [];
  const byTerm = new Map((Array.isArray(looked) ? looked : []).map((entry) => [String(entry.term), entry]));

  const entries = [];
  let filed = 0;
  let refused = 0;
  let notFound = 0;
  let turnsLeft = limit;

  for (const row of targets) {
    const hit = byTerm.get(row.term) || { term: row.term, results: [], found: false };
    const usable = (hit.results || []).filter((result) => result.title || result.extract);
    const entry = {
      term: row.term,
      section: row.section,
      chapter,
      because: row.because,
      lookup: lookupLogLines(hit.results),
      found: false,
      note: "",
      page: "",
      lang: "",
      url: "",
      filed: false,
    };

    if (usable.length === 0) {
      // No page matched, and no model call is spent pretending otherwise. The answer is still filed,
      // because "somebody looked and found nothing" is a fact the next volume is allowed to know.
      const answer = {
        term: row.term,
        found: false,
        note: `No reference page matched "${row.term}" in the languages searched. The lookup returned nothing to read.`,
      };
      const result = fileResearchNote(ctx.refStore, answer, { volume: Number(volume) });
      entry.filed = result.ok;
      entry.note = answer.note;
      entry.because = result.ok ? entry.because : result.refusal.because;
      if (result.ok) filed += 1;
      else refused += 1;
      notFound += 1;
      entries.push(entry);
      continue;
    }

    // The one model call this term costs, and the one the bound counts.
    const prompt = buildResearchReadingPrompt(
      { term: row.term, rendering: row.rendering, notes: row.notes, section: row.section, targetLanguage: values.TARGET_LANGUAGE },
      usable
    );
    const output = await harness.runOneShot({
      systemPrompt: RESEARCH_SYSTEM_PROMPT,
      messages: [{ text: prompt }],
      // The answer shape, declared beside the parser that reads it. This call has no tools and no agent
      // turn behind it, and its reply is filed as a row of the record — so a reply that is not that
      // object is a research turn paid for and thrown away, which is what the shape makes loud instead.
      responseFormat: researchResponseFormat(),
      label: `glossary-research-${volume}-${row.term.slice(0, 20)}`,
    });
    turnsLeft -= 1;

    let answer;
    try {
      answer = parseResearchAnswer(output);
    } catch (err) {
      refused += 1;
      entry.filed = false;
      entry.because = `the reading call's answer could not be used (${err.message})`;
      entries.push(entry);
      continue;
    }

    const result = fileResearchNote(ctx.refStore, { term: row.term, ...answer }, { volume: Number(volume) });
    if (!result.ok) {
      refused += 1;
      entry.filed = false;
      entry.because = result.refusal.because;
      entries.push(entry);
      continue;
    }
    filed += 1;
    entry.filed = true;
    entry.found = answer.found;
    entry.note = answer.note;
    entry.page = answer.page;
    entry.lang = answer.lang;
    entry.url = answer.url;
    if (!answer.found) notFound += 1;
    entries.push(entry);
  }

  ctx.researchTurnsLeft = Math.max(0, turnsLeft);
  for (const entry of entries) ctx.researchLog.entries.push(entry);
  const log = renderResearchLog(
    { volume, limit: RESEARCH_MAX_TERMS_PER_VOLUME },
    {
      targets: ctx.researchLog.targets,
      skipped: ctx.researchLog.skipped,
      notResearchable: ctx.researchLog.notResearchable,
      entries: ctx.researchLog.entries,
    }
  );
  await fs.writeFile(ctx.researchNotesFile, log, "utf8");

  console.log(
    `Volume ${volume}: research filed ${filed} note(s) onto the volume's record ` +
      `(${notFound} of them "nothing matched"), ${refused} refused, no agent turn.`
  );
  return {
    ran: true,
    asked: targets.length,
    filed,
    refused,
    notFound,
    skipped,
    notResearchable: notResearchable.length,
    limit: RESEARCH_MAX_TERMS_PER_VOLUME,
    capped: selection.capped,
    turnsLeft: ctx.researchTurnsLeft,
    entries,
  };
}

module.exports = {
  RESEARCH_SYSTEM_PROMPT,
  buildResearchReadingPrompt,
  researchResponseFormat,
  parseResearchAnswer,
  lookupLogLines,
  renderResearchLog,
  researchVolumeTerms,
  defaultWikiLookup,
};
