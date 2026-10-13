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

// ─── The answer shape this read pass asks for ────────────────────────────────
//
// Declared beside {@link parseTerms}, in the module that owns the parser, so the request the endpoint is
// given and the answer the stage accepts cannot drift apart (`test/prompt-audit.js`'s `data-answer-shape`
// rule compares the wire against this function, imported, not copied).
//
// The root is an OBJECT holding the list, not the list itself. That is a measurement, not a style choice:
// the array-rooted version of this same schema was replayed against the endpoint this pipeline is
// configured against on 2026-10-13 (`glossary-terms-01-ch5`, run log `2026-10-13T12-45-22-158Z`) and the
// request was refused before the model was asked — HTTP 400 in 161 ms, 0 tokens, `code:
// structured_output_failed`, "response_format schema must accept only JSON objects at its root (type
// object, or anyOf/oneOf of object schemas)". `ai/one-shot.js`'s `assertShapeIsExpressible` refuses such a
// schema before it is ever sent. OpenAI's structured outputs require the same root, so this is not a quirk
// of one server (AGENTS.md gotcha 138).
//
// The envelope is what makes the answer CLOSE. Measured on the very chapter that lost its terms: the same
// item list under an object root came back `finish_reason=stop` with the whole reply parseable, 36,538
// tokens in 42.9 s, against the unshaped call's 73,330 tokens in 170.8 s of prose. It is not a promise of
// a *richer* answer — that probe found 2 terms where the rambling answer had listed 5, and extraction
// yield is model variance (gotcha 122).
//
// `strict: true` + `additionalProperties: false` is the combination the four acceptance graders already
// send to this endpoint successfully, and this prompt names exactly five keys per term and five per
// revision and its own examples produce exactly those — so the closed shape is describing the contract
// rather than guessing at one. Strict mode is also why BOTH lists sit in the root `required` array: a
// property declared outside `required` is a schema a strict server may refuse, so the request asks for
// both lists and {@link parseTermAnswer} is what tolerates an answer that carries only one. The voice
// stage's shape is deliberately NOT closed, for the reason recorded in `character-voice/stages.js`.
//
// What this read pass ALSO has, and what actually fixed the defect before the envelope existed:
// {@link readTermList} re-asks a failed read once, and a read that never produced a list comes back as
// `failed: true` and named, instead of arriving as `[]`.

/**
 * The `response_format` the term-list call asks this endpoint for.
 *
 * An object root holding TWO arrays: `terms` (the new rows) and `revisions` (this volume's answer to a
 * row an earlier volume already published). An object root because this endpoint refuses a JSON Schema
 * whose root is an array before it generates. Every property of every item is in its `required` list
 * because `strict: true` is a promise the schema is closed — a property declared outside `required`
 * under strict mode is a schema the server may refuse, and this endpoint already refuses one bad root
 * with HTTP 400 and 0 tokens (gotcha 138). That is why `revisions` is required on the WIRE while
 * {@link parseTermAnswer} still reads an answer that omits it: asking for both lists and tolerating one
 * is the reader's job, not the request's.
 *
 * The five `terms` properties are the five keys `system-prompts/glossary-terms.md` names, and the
 * prompt's own example produces exactly those five — which is what makes `additionalProperties: false`
 * a description of the contract rather than a guess at one. `rendering` is required because the read
 * pass is the only place on this route that can supply one, and the filing door refuses a row without
 * it. The five `revisions` properties are the five the prompt's revision block names, and `quote` is
 * among them because a revision without a line this volume's own text prints is refused at the filing
 * door (`utils/reference-store/glossary-adapter.js`), so asking for it is what makes the refusal rare
 * rather than automatic.
 *
 * @returns {{type: "json_schema", json_schema: {name: string, strict: boolean, schema: Object}}}
 */
function termsResponseFormat() {
  return {
    type: "json_schema",
    json_schema: {
      name: "glossary_new_terms",
      strict: true,
      schema: {
        type: "object",
        properties: {
          terms: {
            type: "array",
            items: {
              type: "object",
              properties: {
                term: { type: "string" },
                rendering: { type: "string" },
                note: { type: "string" },
                type: { type: "string", enum: ["character", "place", "item", "faction", "concept"] },
                query: { type: "string" },
              },
              required: ["term", "rendering", "note", "type", "query"],
              additionalProperties: false,
            },
          },
          revisions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                term: { type: "string" },
                rendering: { type: "string" },
                note: { type: "string" },
                quote: { type: "string" },
                reason: { type: "string" },
              },
              required: ["term", "rendering", "note", "quote", "reason"],
              additionalProperties: false,
            },
          },
        },
        required: ["terms", "revisions"],
        additionalProperties: false,
      },
    },
  };
}

/**
 * Pull the answer value out of the reply, in whichever of the forms it arrived.
 *
 * The envelope (`{"terms": […], "revisions": […]}`) is what the request asks for and what the prompt now
 * asks the model to write. The bare array is still read, because a server that ignores `response_format`
 * answers in the form its prompt used to ask for, and a stage that can read both is a stage that does not
 * break when the endpoint changes. Tolerance is the reader's job; the request always asks for the envelope.
 *
 * @param {string} text - The answer, already fence-stripped.
 * @returns {Array<Object>|Object|null} The parsed value — the envelope object or the bare array — or null
 *   when this answer holds no term list in either form.
 */
function answerValueFromText(text) {
  /**
   * Parse one candidate span, or return undefined when it is not JSON.
   * @param {string} span
   * @returns {Object|undefined}
   */
  const tryJson = (span) => {
    try {
      return JSON.parse(span);
    } catch {
      return undefined;
    }
  };
  /**
   * Is this value an answer — a bare array, or an object holding a `terms` array?
   * @param {Object} value
   * @returns {Array<Object>|Object|null}
   */
  const asAnswer = (value) => {
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object" && Array.isArray(value.terms)) return value;
    return null;
  };

  const whole = tryJson(text);
  if (whole !== undefined) {
    const answer = asAnswer(whole);
    if (answer) return answer;
  }
  const objStart = text.indexOf("{");
  const objEnd = text.lastIndexOf("}");
  if (objStart !== -1 && objEnd > objStart) {
    const answer = asAnswer(tryJson(text.slice(objStart, objEnd + 1)));
    if (answer) return answer;
  }
  const arrStart = text.indexOf("[");
  const arrEnd = text.lastIndexOf("]");
  if (arrStart !== -1 && arrEnd > arrStart) {
    const answer = asAnswer(tryJson(text.slice(arrStart, arrEnd + 1)));
    if (answer) return answer;
  }
  return null;
}

/**
 * Pull the term array out of the answer, in whichever of the two forms it arrived.
 *
 * Kept as its own name because it is what {@link parseTerms} and the prompt audit both reach for, and
 * because "the terms this volume found" is a question a caller asks without wanting the revisions.
 *
 * @param {string} text - The answer, already fence-stripped.
 * @returns {Array<Object>|null} The entries, or null when this answer holds no term array at all.
 */
function termArrayFromAnswer(text) {
  const answer = answerValueFromText(text);
  if (!answer) return null;
  return Array.isArray(answer) ? answer : answer.terms;
}

/**
 * One `revisions` element, in the shape the filing door takes.
 *
 * `quote` and `reason` are kept as separate fields rather than folded into `note`, because they answer
 * two different questions the record asks separately: **where in this volume's text** the revision comes
 * from (the evidence rule checks that against the book), and **why** the earlier rendering is being
 * replaced (the note is what the published glossary prints). A door that read the reason as the quote
 * would file a justification as evidence, which is the shape of claim this store refuses.
 *
 * @param {Object} entry - One element of the answer's `revisions` array.
 * @returns {{term: string, rendering: string, note: string, quote: string, reason: string}|null}
 *   Null when the entry names no term at all.
 */
function revisionFromAnswer(entry) {
  if (!entry || typeof entry !== "object") return null;
  const term = typeof entry.term === "string" ? entry.term.trim() : "";
  if (!term) return null;
  const text = (value) => (typeof value === "string" ? value.trim() : "");
  return {
    term,
    rendering: text(entry.rendering),
    note: text(entry.note),
    quote: text(entry.quote),
    reason: text(entry.reason),
  };
}

/**
 * Parse the AI's term-list output into the two lists it carries.
 *
 * Tolerates markdown fences, surrounding prose, the `{"terms": […], "revisions": […]}` envelope the
 * request asks for, and the bare JSON array a server that ignores `response_format` still answers in.
 * A bare array carries no revisions, and an envelope missing the `revisions` key carries none — both are
 * read, because the request asking for a list and the answer omitting it are different facts and the
 * stage must not lose the terms over the difference.
 *
 * The answer carries the target‑language rendering and the one‑line note, because on this route the
 * read pass is the ONLY place a rendering is chosen — the file is rendered from the record afterwards
 * and nothing else can supply one (glossary/plan/01-glossary-route.md §3 step 2). `type` and `query`
 * are still read: `section` is the preferred bucket and `type` is the fallback the older answers and
 * the offline fixture still use.
 *
 * `revisions` is this volume's answer about a row an EARLIER volume published. It is parsed here and
 * filed by a different door (`importGlossaryRevisions`), because it is a different act: it replaces a
 * published row rather than adding one, and the guard that makes that legal — a quote this volume's own
 * text prints — is not the guard that admits a new term.
 *
 * @param {string} output - The raw AI output.
 * @returns {{terms: Array<{term: string, rendering: string, note: string, section: string, type: string, query: string}>, revisions: Array<{term: string, rendering: string, note: string, quote: string, reason: string}>}}
 * @throws {Error} When the answer holds no array of terms in either form.
 */
function parseTermAnswer(output) {
  if (!output || typeof output !== "string") {
    return { terms: [], revisions: [] };
  }
  let text = output.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }
  const answer = answerValueFromText(text);
  if (answer === null) {
    throw new Error(
      "No JSON array found in the term-list output: the answer is neither a JSON array nor an object " +
        'holding a "terms" array.'
    );
  }
  const rawTerms = Array.isArray(answer) ? answer : answer.terms;
  // An envelope that omits `revisions` is an answer with no revisions, not a malformed answer. The
  // request asks for both lists; a server that answers one is answered.
  const rawRevisions = Array.isArray(answer) ? [] : answer.revisions;
  const terms = rawTerms
    .filter((entry) => entry && typeof entry.term === "string" && entry.term.trim() !== "")
    .map((entry) => ({
      term: entry.term.trim(),
      rendering: typeof entry.rendering === "string" ? entry.rendering.trim() : "",
      note: typeof entry.note === "string" ? entry.note.trim() : "",
      section: typeof entry.section === "string" && entry.section.trim() ? entry.section.trim() : "",
      type: typeof entry.type === "string" && entry.type.trim() !== "" ? entry.type.trim() : "concept",
      query: typeof entry.query === "string" && entry.query.trim() !== "" ? entry.query.trim() : entry.term.trim(),
    }));
  const revisions = [];
  for (const entry of Array.isArray(rawRevisions) ? rawRevisions : []) {
    const revision = revisionFromAnswer(entry);
    if (revision) revisions.push(revision);
  }
  return { terms, revisions };
}

/**
 * Parse the AI's term-list output into the rows the record files.
 *
 * The terms half of {@link parseTermAnswer}, kept as its own name because it is what every existing
 * caller and the offline tests reach for, and because "what terms did this volume find" is a question
 * that does not want the revisions with it.
 *
 * @param {string} output - The raw AI output.
 * @returns {Array<{term: string, rendering: string, note: string, section: string, type: string, query: string}>}
 * @throws {Error} When the answer holds no array of terms in either form.
 */
function parseTerms(output) {
  return parseTermAnswer(output).terms;
}


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
 *     (`structured_output_failed`). The request was well-formed; the model answered in prose, or in a
 *     bare array where the envelope was asked for on a server that constrains its output loosely.
 *   - `ran-out-mid-shape` — the answer hit the output cap before it closed (`finish_reason=length`).
 *     That is a size problem: the fix is a smaller request or a bigger cap, not a re-ask.
 *   - `unparseable-answer` — an answer arrived and {@link parseTerms} could not read it. On a server that
 *     honours `response_format` this should be rare; it is the shape a server that ignores the field
 *     still produces, and {@link parseTerms} reads both the envelope and the bare array.
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
 * @returns {Promise<{terms: Array<Object>, revisions: Array<Object>, attempts: Array<Object>, failed: boolean, failure: {kind: string, because: string}|null}>}
 * @throws {Error} Re-throws a size failure (`ran-out-mid-shape`) unchanged, which is what the stage did before this file existed.
 */
async function readTermList({ ask, label, warn = console.warn }) {
  /** @type {Array<Object>} */
  const attempts = [];
  /** @type {{terms: Array<Object>, revisions: Array<Object>, failure: {kind: string, because: string}}|null} */
  let lastFailure = null;

  for (let attempt = 1; attempt <= EXTRACTION_MAX_ATTEMPTS; attempt++) {
    const thinkingLevel = attempt === 1 ? null : EXTRACTION_RETRY_THINKING_LEVEL;
    /** @type {Array<Object>} */
    let terms = [];
    /** @type {Array<Object>} */
    let revisions = [];
    /** @type {{kind: string, because: string}|null} */
    let failure = null;
    try {
      const answer = parseTermAnswer(await ask({ attempt, thinkingLevel }));
      terms = answer.terms;
      revisions = answer.revisions;
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
      revisions: revisions.length,
      failure,
    });
    if (!failure) return { terms, revisions, attempts, failed: false, failure: null };
    lastFailure = { terms, revisions, failure };
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
  return {
    terms: [],
    revisions: lastFailure ? lastFailure.revisions : [],
    attempts,
    failed: true,
    failure: lastFailure ? lastFailure.failure : null,
  };
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
      "re-asked once. **Every one of them is asked for in a declared answer shape** — the term list wrapped " +
      "in an object (`{\"terms\": […]}`), because this endpoint refuses a `response_format` schema whose root " +
      "is an array before it generates (measured 2026-10-13 — HTTP 400, 0 tokens; gotcha 138). The shape is " +
      "what makes the answer close and parse; it is not what makes it thorough. " +
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
  parseTermAnswer,
  revisionFromAnswer,
  termsResponseFormat,
  EXTRACTION_MAX_ATTEMPTS,
  EXTRACTION_RETRY_THINKING_LEVEL,
  classifyExtractionFailure,
  readTermList,
  extractionReadReport,
  truncateGlossary,
};
