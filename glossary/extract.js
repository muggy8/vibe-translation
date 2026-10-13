/**
 * The new-terms extraction call and the window of the previous glossary it is
 * shown.
 *
 * The truncation window is RELEVANCE-ranked against the text being processed, never
 * by document position (gotcha 41) — the glossary is cumulative, so "the first N
 * entries" shows the earliest volumes' terms and throws away exactly what a later
 * volume needs. Truncating here means "some existing terms may be re-proposed as
 * new", which is harmless: the amend pass reconciles duplicates to one canonical
 * rendering. It no longer means "the agent cannot see entries it must preserve",
 * which is what it used to mean and what the 457-term loss came out of.
 *
 * Part of the glossary.js layer (split out of the original single file).
 */

require("dotenv").config();
require("../types"); // JSDoc type definitions

const { isStructuredOutputError, isTooBigForOnePassError } = require("../configs/shared");

const { GLOSSARY_TRUNCATION_MAX_ENTRIES, GLOSSARY_TRUNCATION_THRESHOLD } = require("./config");
// The same reading of a glossary row the cumulative gate uses: `glossaryTermSpans` is how this layer
// spells "the spellings one row names", and a second definition of it is how the extractor and the
// gate end up disagreeing about the same row. `buildGlossaryIndex` is the same layer's compact
// name-and-rendering view of a whole glossary, which is what lets the window hide Notes without
// hiding entries.
const {
  glossaryTermSpans,
  glossaryTermSkeleton,
  GLOSSARY_SKELETON_MIN_CHARS,
  buildGlossaryIndex,
} = require("./carry-forward/table");

/**
 * Parse the AI's term-list output into the rows the record files.
 * Tolerates markdown fences and surrounding prose.
 *
 * The answer carries the target‑language rendering and the one‑line note, because on this route the
 * read pass is the ONLY place a rendering is chosen — the file is rendered from the record afterwards
 * and nothing else can supply one (glossary/plan/01-glossary-route.md §3 step 2). `type` and `query`
 * are still read: `section` is the preferred bucket and `type` is the fallback the older answers and
 * the offline fixture still use.
 *
 * @param {string} output - The raw AI output.
 * @returns {Array<{term: string, rendering: string, note: string, section: string, type: string, query: string}>}
 */
function parseTerms(output) {
  if (!output || typeof output !== "string") {
    return [];
  }
  let text = output.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }
  const firstBracket = text.indexOf("[");
  const lastBracket = text.lastIndexOf("]");
  if (firstBracket === -1 || lastBracket === -1 || lastBracket < firstBracket) {
    throw new Error("No JSON array found in the term-list output.");
  }
  const parsed = JSON.parse(text.slice(firstBracket, lastBracket + 1));
  if (!Array.isArray(parsed)) {
    throw new Error("The term-list output was not a JSON array.");
  }
  return parsed
    .filter((entry) => entry && typeof entry.term === "string" && entry.term.trim() !== "")
    .map((entry) => ({
      term: entry.term.trim(),
      rendering: typeof entry.rendering === "string" ? entry.rendering.trim() : "",
      note: typeof entry.note === "string" ? entry.note.trim() : "",
      section: typeof entry.section === "string" && entry.section.trim() ? entry.section.trim() : "",
      type: typeof entry.type === "string" && entry.type.trim() !== "" ? entry.type.trim() : "concept",
      query: typeof entry.query === "string" && entry.query.trim() !== "" ? entry.query.trim() : entry.term.trim(),
    }));
}

// ─── Why this read pass asks for no answer shape ─────────────────────────────
//
// It used to declare one, beside `parseTerms`, for the reason every shape in this repository is
// declared: the schema is what the endpoint is asked for and the parser is what the stage accepts, and
// two copies in two places drift. Measured 2026-10-13 against the endpoint this pipeline is configured
// against, replaying the exact request that lost volume 01 chapter 5 (`glossary-terms-01-ch5`, run log
// `2026-10-13T12-45-22-158Z`):
//
//   HTTP 400 in 161 ms, 0 tokens — the server refused the REQUEST before the model was asked:
//   "response_format schema must accept only JSON objects at its root (type object, or anyOf/oneOf of
//   object schemas)" — code `structured_output_failed`.
//
// The schema that produced it was `{ type: "array", items: { type: "object", … } }`, which is the shape
// this call answers in. So the term list cannot be shaped as itself, and `ai/one-shot.js` now refuses an
// array-rooted schema before it is ever sent. Left in place it would fail every extraction call in a real
// run: the harness re-asks a refused shape `AI_RETRY` times and `readTermList` re-asks once more on top
// of that, so one chapter would spend six doomed requests and then file nothing.
//
// The same item schema wrapped in an object root IS accepted, and on that same chapter it produced a
// closed, parseable answer — `{"terms":[…]}`, `finish_reason=stop`, 27,886 prompt + 8,652 completion
// tokens, against the original call's 27,588 + 45,742. Adopting that envelope means changing what
// `system-prompts/glossary-terms.md` tells the model to write (from "Respond with **only** a JSON array")
// and what {@link parseTerms} accepts, which is a change to the contract of a stage that publishes an
// artifact. It is written down as a decision rather than taken here: `/tmp/opencode/json-schema-questions.md`.
//
// What this read pass DOES have, and what actually fixed the defect the shape was meant to fix:
// `readTermList` re-asks a failed read once, and a read that never produced a list comes back as
// `failed: true` and named, instead of arriving as `[]`.

/**
 * How many paid reads one term list gets in one pass.
 *
 * Two, mirroring `character-voice/reading.js`'s `MAX_ATTEMPTS_PER_CHAPTER`: the run's own reasoning
 * level, then the retry level. After that the failure is reported rather than paid for again. The
 * number is a constant with no environment knob (AGENTS.md rule 3): a budget an operator can raise
 * is a budget that quietly stops being a bound.
 *
 * @type {number}
 */
const EXTRACTION_MAX_ATTEMPTS = 2;

/**
 * The reasoning level the SECOND read runs at.
 *
 * `character-voice/reading.js` chose "medium" by measurement (volume 02: two chapters cut off at
 * `xhigh` came back whole at `medium`). Measured 2026-10-13 from the offline loop's own wire log: the
 * glossary, character-voice and style-guide **extraction** calls all run at `reasoning_effort: xhigh`
 * there (2 + 2 + 2 of them, against `medium` for every grading call) — they are not judging calls, so they
 * inherit `AI_THINKING_LEVEL` and never see `STAGE_THINKING_LEVEL`. On this machine's `.env`
 * `AI_THINKING_LEVEL=medium`, and the extraction calls pass no per-call level, so the real volume 01 run
 * that lost chapter 5 asked at `medium` too — which makes this retry a **same-level re-sample** for that
 * run, and that is exactly what gotcha 122 measured fixed the voice stage's cut-off chapters ("what fixed
 * them was a second roll rather than the lower level"). The real run's own summary log does not print
 * `reasoning_effort`, so that last half is the code path plus `.env`, not a line read off the log.
 *
 * @type {string}
 */
const EXTRACTION_RETRY_THINKING_LEVEL = "medium";

/**
 * Which of the three ways a term-list read can fail actually happened.
 *
 * The endpoint's two refusals are different problems with different fixes, and the log line has to
 * say which one it saw (AGENTS.md gotcha 55: a task must not string-match a server's error text —
 * these are the tags `configs/shared/failures.js` puts on them):
 *
 *   - `shape-refused` — the endpoint could not produce an answer in the shape it was asked for
 *     (`structured_output_failed`). The request was well-formed; the model answered in prose, or in
 *     an object where an array was asked for.
 *   - `ran-out-mid-shape` — the answer hit the output cap before it closed (`finish_reason=length`).
 *     That is a size problem: the fix is a smaller request or a bigger cap, not a re-ask.
 *   - `unparseable-answer` — an answer arrived and {@link parseTerms} could not read it. On a server
 *     that honours `response_format` this should be rare; it is the shape a server that ignores the
 *     field still produces.
 *
 * @param {Error} err - What the call or the parse threw.
 * @returns {"shape-refused"|"ran-out-mid-shape"|"unparseable-answer"}
 */
function classifyExtractionFailure(err) {
  if (isStructuredOutputError(err)) return "shape-refused";
  if (isTooBigForOnePassError(err)) return "ran-out-mid-shape";
  return "unparseable-answer";
}

/**
 * Ask for one term list, retry it once when the answer fails its shape, and report what happened.
 *
 * The rule, in the order it bites — the same shape `character-voice/reading.js` uses, so the two
 * reading passes do not drift into two different sets of rules:
 *
 *   1. the first read runs at the run's own reasoning level (no `thinkingLevel` is passed);
 *   2. a read that throws, or whose answer {@link parseTerms} cannot parse, is re-asked once at
 *      {@link EXTRACTION_RETRY_THINKING_LEVEL};
 *   3. **a size failure is not re-asked** — `finish_reason=length` is deterministic, the same request
 *      at the same cap is cut off the same way, and the harness already throws on it (its own message
 *      says raise `AI_MAX_TOKENS` or shrink the input). Re-asking would pay for a doomed call and turn
 *      a loud failure into a quiet one, so it is re-thrown unchanged;
 *   4. every paid read is recorded in `attempts` — its level, its term count, and what it failed with;
 *   5. a list that never arrived is returned as `failed: true` with a named `failure`, and the caller
 *      reports it. It is never returned as `[]`, because `[]` is also the honest answer for a volume
 *      with nothing new, and the two must not look alike.
 *
 * There is no "keep the better of two half answers" rule here, and that is a real difference from
 * `character-voice/reading.js`: that file reads a chapter's array object by object and can rescue the
 * claims a malformed one lost, so two partial answers can be compared. {@link parseTerms} is
 * all-or-nothing — it either returns the list or throws — so a failed read has no partial to keep, and
 * the first read that parses IS the answer. Adding the tolerant reader here would be a second filing
 * rule, and the glossary's evidence rule is what a rescued term would have to pass.
 *
 * @param {Object} params
 * @param {(attempt: {attempt: number, thinkingLevel: string|null}) => Promise<string>} params.ask - Runs the one-shot for one paid read.
 * @param {string} params.label - What the log lines call this read.
 * @param {(line: string) => void} [params.warn] - Where the retry is announced.
 * @returns {Promise<{terms: Array<Object>, attempts: Array<Object>, failed: boolean, failure: {kind: string, because: string}|null}>}
 * @throws {Error} Re-throws a size failure (`ran-out-mid-shape`) unchanged, which is what the stage did before this file existed.
 */
async function readTermList({ ask, label, warn = console.warn }) {
  /** @type {Array<Object>} */
  const attempts = [];
  /** @type {{terms: Array<Object>, failure: {kind: string, because: string}}|null} */
  let lastFailure = null;

  for (let attempt = 1; attempt <= EXTRACTION_MAX_ATTEMPTS; attempt++) {
    const thinkingLevel = attempt === 1 ? null : EXTRACTION_RETRY_THINKING_LEVEL;
    /** @type {Array<Object>} */
    let terms = [];
    /** @type {{kind: string, because: string}|null} */
    let failure = null;
    try {
      terms = parseTerms(await ask({ attempt, thinkingLevel }));
    } catch (err) {
      const kind = classifyExtractionFailure(err);
      if (kind === "ran-out-mid-shape") {
        warn(`${label}: the answer hit the output cap before it closed. Not re-asked — the same request at the same cap is cut off the same way.`);
        throw err;
      }
      failure = { kind, because: err.message };
    }
    attempts.push({
      attempt,
      thinkingLevel: thinkingLevel || "run default",
      terms: terms.length,
      failure,
    });
    if (!failure) return { terms, attempts, failed: false, failure: null };
    lastFailure = failure;
    if (attempt < EXTRACTION_MAX_ATTEMPTS) {
      warn(
        `${label}: the term list ${failure.kind === "shape-refused" ? "was refused by the endpoint (it could not answer in the shape it was asked for)" : "arrived in a shape this stage cannot parse"} — re-asking once at ${EXTRACTION_RETRY_THINKING_LEVEL}.`
      );
    }
  }

  warn(
    `${label}: NO term list after ${EXTRACTION_MAX_ATTEMPTS} paid read(s) (${attempts.map((a) => `${a.thinkingLevel}: ${a.failure.kind}`).join("; ")}). ` +
      `Whatever this read was supposed to find is missing, and that is not the same as finding nothing.`
  );
  return { terms: [], attempts, failed: true, failure: lastFailure };
}

/**
 * The block the volume's validation report carries about **how its term lists were read**.
 *
 * The mirror of `character-voice/reading.js`'s `readingReport`, for the same reason: a glossary built
 * from ten reads of which one never answered is a different artifact from one built from ten that
 * answered, and the difference has to be visible to whoever reads the report — including the
 * acceptance grader, whose message list already contains this file (`prompt-audit.js`'s
 * `acceptance-context` rule is what proves it does).
 *
 * @param {Array<{id: string, title?: string, terms?: number, attempts?: Array<Object>, failed?: boolean}>} reads - One entry per paid read pass, in reading order.
 * @param {{volume: string|number}} opts
 * @returns {string} A markdown block, or "" when every read answered.
 */
function extractionReadReport(reads, { volume }) {
  const rows = (reads || []).map((read) => {
    const attempts = read.attempts && read.attempts.length ? read.attempts : [];
    const levels = attempts
      .map((a) => `${a.thinkingLevel}: ${a.terms}${a.failure ? ` (${a.failure.kind})` : ""}`)
      .join(", ");
    return {
      id: read.id,
      title: read.title || "",
      terms: read.terms === undefined ? attempts.reduce((n, a) => Math.max(n, a.terms), 0) : read.terms,
      reads: attempts.length,
      failed: Boolean(read.failed),
      because: read.failed && attempts.length ? (attempts[attempts.length - 1].failure || {}).because || "" : "",
      levels: levels || "—",
    };
  });
  const failed = rows.filter((r) => r.failed);
  const retried = rows.filter((r) => r.reads > 1);
  if (!failed.length && !retried.length) return "";

  const out = [
    "## How this volume's terms were read",
    "",
    `_Every term list this volume was built from is paid for at most twice, and a list that failed was ` +
      "re-asked once. **None of them is asked for in a declared answer shape**: a term list answers as a " +
      "JSON array, and this endpoint refuses a `response_format` schema whose root is an array before it " +
      "generates (measured 2026-10-13 — HTTP 400, 0 tokens; gotcha 138). " +
      `${failed.length ? `${failed.length} read(s) never produced a list at all.` : "Every read produced a list."}`,
    "",
    "| read | terms filed | paid reads | how it was read |",
    "| --- | --- | --- | --- |",
  ];
  for (const row of rows) {
    out.push(
      `| ${row.id}${row.title ? ` (${row.title})` : ""} | ${row.terms} | ${row.reads} | ${row.levels}${row.failed ? " — **NOTHING READ**" : ""} |`
    );
  }
  out.push("");
  if (failed.length) {
    out.push(
      `**${failed.length} of ${rows.length} read(s) produced no term list.** ${failed.map((r) => r.id).join(", ")}. ` +
        "Every term those reads were supposed to find is missing from this glossary, and from every later " +
        "volume's, because the glossary is copied forward. Nothing here can say which terms they were."
    );
    for (const row of failed) {
      if (row.because) out.push(`- ${row.id}: ${String(row.because).slice(0, 400)}`);
    }
  } else {
    out.push(`All ${rows.length} read(s) answered.`);
  }
  out.push("");
  return out.join("\n");
}

// ─── Context truncation helpers ──────────────────────────────────────────────


/**
 * Truncate a glossary file to the entries that MATTER for the volume being
 * processed, when it exceeds the configured threshold. Returns the full content
 * when under the threshold, or the truncated content (with a header note) when
 * over it.
 *
 * The old rule was "drop the oldest rows in document order". A glossary is
 * organised by SECTION (Characters, Places, Items…), not by when entries were
 * added — so the head of the Characters table is the volume-1 main cast, and
 * dropping "the oldest rows" threw away exactly the entries a later volume is
 * most likely to contain. The extractor was then shown 200 rows that excluded
 * the protagonists and duly rediscovered them as brand-new terms, volume after
 * volume.
 *
 * The selection is deterministic and relevance-ordered: rows whose source term actually occurs in THIS
 * volume's text are kept first (in document order), then the remaining rows up to
 * `GLOSSARY_TRUNCATION_MAX_ENTRIES`. And every term the file holds is handed over as a name in the
 * complete index appended below the tables, so the window hides a row's Notes, never the existence of
 * an entry. That guarantee is the point of the function: a row the text mentions that the extractor
 * cannot see is re-proposed as a new term, the amend pass reconciles it into the row that already held
 * it, and the cumulative gate then has to tell that rename from a deletion. That is the chain that
 * ended the 12-hour run on volume 15 (gotcha 68), and the relevance test below is where it starts.
 *
 * Section structure and table headers are preserved; a section whose rows are all
 * omitted loses its heading, so the model is never told about a section it cannot
 * see.
 *
 * @param {string} content - The full glossary file content.
 * @param {string} [sourceText] - The volume/chapter source text, used to rank rows by whether the term occurs in it.
 * @returns {string} The (possibly truncated) content.
 */
function truncateGlossary(content, sourceText) {
  if (!content || content.length <= GLOSSARY_TRUNCATION_THRESHOLD) return content;

  const runs = splitIntoRuns(content.split("\n"));
  const src = (sourceText || "").trim();
  const rows = collectDataRows(runs, src);
  if (rows.length <= GLOSSARY_TRUNCATION_MAX_ENTRIES) return content;

  const keep = chooseRowsToKeep(rows, src);
  const { lines, droppedSections } = renderKeptRuns(runs, keep);
  const relevantTotal = rows.filter((r) => r.occurs === true).length;
  const relevantShown = rows.filter((r) => r.occurs === true && keep.has(`${r.runIdx}:${r.lineIdx}`)).length;

  lines.splice(
    1,
    0,
    "",
    truncationNote({
      total: rows.length,
      kept: keep.size,
      relevantTotal,
      relevantShown,
      dropped: rows.length - keep.size,
      droppedSections: droppedSections.size,
      hasSource: Boolean(src),
    })
  );

  // The part a window cannot fit as a full row is still handed over as a NAME. Rows carry Notes, and
  // Notes are what makes a glossary big; a term plus its rendering is a line, and every term in the
  // file fits in it. This is what makes the note above a rule instead of a wish: the extractor cannot
  // open the glossary file (it is a one-shot call with no tools), so "do not re-propose what you cannot
  // see" only means something when it can see all of them. On the live series: 445 terms, 14.7 KB.
  const index = buildGlossaryIndex(content);
  if (index) {
    lines.push(
      "",
      `[EVERY TERM THIS GLOSSARY ALREADY HOLDS — all ${rows.length} of them, name and rendering only, ` +
        `no definitions. A term named here is NOT new, whatever spelling the text above uses for it. ` +
        `The tables above are the full rows (with Notes) for the terms that text actually mentions.]`,
      index
    );
  }
  return lines.join("\n");
}

/**
 * Group the file into runs: a table (consecutive "|…" lines) or a single other line. Inside a table,
 * line 0 is the column header and line 1 the |---| separator; everything after that is one term entry.
 *
 * (Rewritten: this helper used to split on "- Term:" list items, but the glossary the workflow prompts
 * for is a set of Markdown TABLES (`| source | rendering | notes |`), so the split found zero entries
 * and the helper returned the file unchanged no matter how big it got — the truncation AGENTS.md
 * describes had never actually happened.)
 *
 * @param {string[]} lines - The glossary file, split on newlines.
 * @returns {Array<{kind: "table"|"line", block: string[], dataFrom?: number, section: number|null}>}
 *   The runs, in document order. `section` on a table is the run index of the heading it sits under.
 */
function splitIntoRuns(lines) {
  const runs = [];
  let currentSection = null;
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,6}\s+/.test(lines[i].trim())) {
      currentSection = runs.length;
      runs.push({ kind: "line", block: [lines[i]] });
      continue;
    }
    if (lines[i].trim().startsWith("|")) {
      const start = i;
      while (i + 1 < lines.length && lines[i + 1].trim().startsWith("|")) i++;
      const block = lines.slice(start, i + 1);
      runs.push({
        kind: "table",
        block,
        dataFrom: block.length > 1 ? 2 : block.length,
        section: currentSection,
      });
      continue;
    }
    runs.push({ kind: "line", block: [lines[i]] });
  }
  return runs;
}

/**
 * Does this row's term occur in the text being processed — under ANY spelling the row names?
 *
 * The rule this replaces was `sourceText.includes(wholeFirstCell)`: the row counted as relevant only
 * when the glossary's term column appeared in the chapter **verbatim, whole**. A glossary writes a
 * term the way the glossary writes it and the book prints it the way the book prints it, and those are
 * not the same string when furigana is involved. Volume 14's row is `双ふた花ばの恋物語`; volume 15
 * chapter 6 prints `双ふた花ばの恋こい物もの語がたり` — furigana inserted INSIDE the word — so neither
 * contains the other, the row was invisible to the extractor, and the term was re-proposed as brand
 * new. The amend pass then reconciled the two spellings into one row exactly as its prompt instructs,
 * and the carry-forward gate — which at the time read only the term column — called the result a
 * deletion, quarantined a glossary that had GROWN from 445 rows to 460, and a 12-hour run died there
 * (gotcha 68). Measured on those two volumes: the whole-cell rule found 45 of the 445 carried rows
 * relevant to volume 15; reading the spellings inside each row finds 70.
 *
 * Two tests, both deterministic and both cheap:
 *   1. any spelling the cell names (the `/`-separated list `glossaryTermSpans` reads) occurs verbatim;
 *   2. …or the row's Han characters in order — every kana dropped, which is what a term looks like
 *      once you stop writing its furigana — occurs in the same projection of the source. A skeleton
 *      shorter than `GLOSSARY_SKELETON_MIN_CHARS` is not trusted, because two common kanji sitting
 *      next to each other happen all over a real page.
 *
 * Deliberately loose on the false-positive side, and the asymmetry is the reason: a row shown to the
 * extractor that the chapter happens not to mention costs a few hundred characters of prompt, while a
 * row hidden from it costs a re-proposed term, an amend reconcile, and a gate that has to tell a
 * rename from a loss.
 *
 * @param {string} term - One row's term column.
 * @param {string} src - The trimmed source text ("" when there is none).
 * @param {string} srcSkeleton - {@link glossaryTermSkeleton} of `src`, computed once per call.
 * @returns {boolean}
 */
function rowTermOccursIn(term, src, srcSkeleton) {
  for (const span of glossaryTermSpans(term)) {
    if (src.includes(span)) return true;
    if (srcSkeleton) {
      const skeleton = glossaryTermSkeleton(span);
      if (skeleton.length >= GLOSSARY_SKELETON_MIN_CHARS && srcSkeleton.includes(skeleton)) return true;
    }
  }
  return false;
}


/**
 * Every data row in the file, tagged with the run it belongs to and whether its source term actually
 * occurs in the text being processed.
 *
 * That last tag is the whole relevance rule: a row is worth showing the extractor when the volume in
 * front of it contains the term, whatever position the row holds in the glossary and whatever spelling
 * either side uses.
 *
 * @param {Array<{kind: string, block: string[], dataFrom?: number}>} runs
 * @param {string} src - The trimmed source text, or "" when none was given.
 * @returns {Array<{runIdx: number, lineIdx: number, term: string, occurs: boolean|null}>}
 */
function collectDataRows(runs, src) {
  const srcSkeleton = src ? glossaryTermSkeleton(src) : "";
  const rows = [];
  runs.forEach((run, runIdx) => {
    if (run.kind !== "table") return;
    for (let k = run.dataFrom; k < run.block.length; k++) {
      const cells = run.block[k].split("|").map((c) => c.trim()).filter((c) => c !== "");
      const term = cells[0] || "";
      // A line with nothing in its first column is not an entry (a stray "|" survives in real
      // glossaries). Counting it would put a phantom in the row count the note prints and give a junk
      // line one of the window's slots.
      if (!term) continue;
      rows.push({
        runIdx,
        lineIdx: k,
        term,
        occurs: src ? rowTermOccursIn(term, src, srcSkeleton) : null,
      });
    }
  });
  return rows;
}

/**
 * Which rows survive the window.
 *
 * Relevance first, document order within each group, capped at `GLOSSARY_TRUNCATION_MAX_ENTRIES`. The
 * cap bounds how many rows are shown WITH their Notes; it does not hide anything, because
 * {@link truncateGlossary} appends the complete name-and-rendering index of the file underneath, so a
 * row the cap cut is still named. Without a source text the old behavior is kept (the newest window,
 * and the note says so).
 *
 * @param {Array<{runIdx: number, lineIdx: number, occurs: boolean|null}>} rows
 * @param {string} src - The trimmed source text, or "".
 * @returns {Set<string>} The `runIdx:lineIdx` keys of the rows to keep.
 */
function chooseRowsToKeep(rows, src) {
  const key = (r) => `${r.runIdx}:${r.lineIdx}`;
  const hasSource = Boolean(src);
  if (!hasSource) {
    return new Set([...rows].reverse().slice(0, GLOSSARY_TRUNCATION_MAX_ENTRIES).map(key));
  }
  const ordered = [...rows].sort((a, b) => {
    const d = (a.occurs === true ? 0 : 1) - (b.occurs === true ? 0 : 1);
    if (d !== 0) return d;
    if (a.runIdx !== b.runIdx) return a.runIdx - b.runIdx;
    return a.lineIdx - b.lineIdx;
  });
  return new Set(ordered.slice(0, GLOSSARY_TRUNCATION_MAX_ENTRIES).map(key));
}

/**
 * Re-render the runs keeping only the rows that survived, and dropping a heading whose tables lost
 * every row — so the model is never told about a section it cannot see.
 *
 * @param {Array<{kind: string, block: string[], dataFrom?: number, section: number|null}>} runs
 * @param {Set<string>} keep - The `runIdx:lineIdx` keys chosen by {@link chooseRowsToKeep}.
 * @returns {{lines: string[], droppedSections: Set<number|null>}} The rendered file body, and the
 *   headings that were dropped with it.
 */
function renderKeptRuns(runs, keep) {
  const rendered = new Map();
  const droppedSections = new Set();
  for (const [runIdx, run] of runs.entries()) {
    if (run.kind !== "table") continue;
    const kept = [];
    for (let k = run.dataFrom; k < run.block.length; k++) {
      if (keep.has(`${runIdx}:${k}`)) kept.push(run.block[k]);
    }
    if (kept.length === 0) {
      droppedSections.add(run.section);
      continue;
    }
    rendered.set(runIdx, [...run.block.slice(0, run.dataFrom), ...kept]);
  }

  const lines = [];
  for (const [runIdx, run] of runs.entries()) {
    if (run.kind === "table") {
      const block = rendered.get(runIdx);
      if (block) lines.push(...block);
      continue;
    }
    if (/^#{1,6}\s+/.test(run.block[0].trim()) && droppedSections.has(runIdx)) continue;
    lines.push(...run.block);
  }
  return { lines, droppedSections };
}

/**
 * The line the truncated copy announces itself with.
 *
 * It has to say what is missing AND that nothing is missing at the level of names: without the second
 * half, an extractor seeing 200 of 445 rows reports the other 245 as brand-new terms, which is how
 * volume after volume re-rediscovered its own protagonists. It also has to count the rows the text
 * actually mentions, because that is the half the window puts first — a note that counts only what it
 * kept cannot be checked against anything.
 *
 * @param {{total: number, kept: number, relevantTotal: number, relevantShown: number, dropped: number, droppedSections: number, hasSource: boolean}} stats
 * @returns {string} The note.
 */
function truncationNote({ total, kept, relevantTotal, relevantShown, dropped, droppedSections, hasSource }) {
  const omitted = `${dropped} row(s)${droppedSections ? ` and ${droppedSections} fully omitted section(s)` : ""}`;
  if (!hasSource) {
    return `[TRUNCATED: this glossary has ${total} term rows. Showing the ${kept} in document order; ` +
      `${omitted} are omitted. ` +
      `Earlier entries are carried forward unchanged in the file itself — reconcile NEW terms against ` +
      `the complete term list at the end of this excerpt.]`;
  }
  return `[TRUNCATED: this glossary has ${total} term rows, and ${kept} of them are shown here as full ` +
    `rows. ${relevantTotal} row(s) name a term that occurs in the text being translated — matched under ` +
    `any spelling the row names, including the furiganed spelling the text itself prints — and the ` +
    `${relevantShown} most relevant of them are among the rows shown, with ${Math.max(0, kept - relevantShown)} ` +
    `background rows in document order. ${omitted} are not shown as rows, but every term they hold IS ` +
    `named in the complete list at the end of this excerpt. A term named there is NOT new: check that ` +
    `list before calling anything new.]`;
}


module.exports = {
  parseTerms,
  EXTRACTION_MAX_ATTEMPTS,
  EXTRACTION_RETRY_THINKING_LEVEL,
  classifyExtractionFailure,
  readTermList,
  extractionReadReport,
  truncateGlossary,
};
