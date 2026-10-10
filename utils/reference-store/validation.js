/**
 * utils/reference-store/validation.js — the checks a validator agent used to do, done by code.
 *
 * The pre-production QA loop has always had a validator agent: a fresh agent per iteration that
 * reads the whole artifact and writes a report saying whether it is complete, consistent, correct
 * and well-formed. That is the most expensive kind of model call this pipeline makes — it re-reads
 * a document the pipeline already has in structured form — and its answer is a paragraph, so
 * nothing downstream can act on it except another model.
 *
 * This module is the replacement slice 6 installs. Three groups, because the old validator was
 * doing three different jobs:
 *
 *   - **The store's own questions** (`integrity.js`): evidence that does not verify, provenance
 *     that cannot be true, a character split across two entries, a reference that covers fewer
 *     characters than the roster. Deterministic, and each one has a severity.
 *   - **The artifact's shape** (`artifactShapeFindings`): the file an agent wrote, measured. A line
 *     longer than an agent can read is the exact damage that destroyed volume 01's reference, and it
 *     is measurable in one pass over the file.
 *   - **What the pipeline threw away** (`unadoptedVoiceClaims`, `unadoptedTerms`): the extraction
 *     pass already paid for structured claims; this compares them against what the published
 *     document actually says, and names the ones the document never took.
 *
 * The output is the same file the validator agent used to write, with the same name, so the
 * feedback stage and every existing reader of it keep working. What changed is who wrote it: code,
 * from rows, with numbers.
 *
 * @module utils/reference-store/validation
 */

const { finding } = require("../postmortem");
const { envMaxLineLength } = require("../../ai/env");
const { EXTRACTION_SOURCE_STAGE } = require("./schema");
const { DOCUMENT_VOICE, documentRebuilt } = require("./document-prose");
const { normalizeQuote } = require("./evidence");
require("../../types"); // JSDoc type definitions

/** The step name findings from this audit are filed under. */
const VALIDATION_STEP = "reference-audit";

/**
 * The heading level the document's sections actually use.
 *
 * The voice reference's canonical shape puts each character under `### ` and the glossary puts its
 * rows under `## `, but the shape an agent left behind is not always the shape the prompt asked for,
 * and both a sampler and a shape check that silently found no sections would be measuring a document
 * consisting of its own first paragraph.
 *
 * @param {string[]} lines
 * @param {string} preferred
 * @returns {string}
 */
function sectionHeading(lines, preferred) {
  if (lines.some((line) => line.startsWith(preferred))) return preferred;
  return ["## ", "### ", "#### "].find((h) => lines.some((line) => line.startsWith(h))) || preferred;
}

/**
 * Measure the shape of a published artifact.
 *
 * Two measurements, both of which the store already knows the true answer to:
 *
 *   - **A line no agent can read.** `AGENT_MAX_LINE_LENGTH` is the longest line the file tools will
 *     answer with; past it, every read comes back with a truncation marker. Volume 01's character-voice
 *     reference has a line of 54,341 characters, which is how its repair agent lost track of the
 *     document it was editing. A reference an agent cannot read is not a reference.
 *   - **Sections fewer than the roster.** The artifact's own `### ` headings, counted, against the
 *     cast the store holds. This is the deferred check from review 05 §4 — the one whose absence made
 *     volume 01's voice numbers look small instead of alarming.
 *
 * @param {string} markdown - The artifact as it is on disk.
 * @param {{file: string, volume: number|string, step?: string}} opts
 * @returns {PostMortemFinding[]}
 */
function artifactShapeFindings(markdown, { file, volume, step = VALIDATION_STEP }) {
  const findings = [];
  const text = String(markdown === undefined || markdown === null ? "" : markdown);
  const lines = text.split("\n");
  const limit = envMaxLineLength();

  let longest = 0;
  let longestAt = 0;
  lines.forEach((line, index) => {
    if (line.length > longest) {
      longest = line.length;
      longestAt = index + 1;
    }
  });
  if (longest > limit) {
    findings.push(
      finding(
        "HIGH",
        "reference-artifact-line-unreadable",
        step,
        volume,
        file,
        `line ${longestAt} of ${file} is ${longest} characters, and an agent's file tools answer with at ` +
          `${limit} of a line. An agent asked to preserve this document cannot read it: every read comes ` +
          "back truncated, which is how volume 01's reference was welded into one line and never repaired. " +
          "Split the line into one claim per line."
      )
    );
  }

  const sections = lines.filter((line) => line.startsWith(sectionHeading(lines, "### "))).length;
  if (sections === 0 && text.trim().length > 0) {
    findings.push(
      finding(
        "MEDIUM",
        "reference-artifact-has-no-sections",
        step,
        volume,
        file,
        `${file} has no sections at any heading level, so nothing in it is addressable as one entry.`
      )
    );
  }

  return findings;
}

/**
 * Claims this volume's extraction filed that the published document says nothing about.
 *
 * The comparison is by character and kind of claim, not by wording: the extractor's sentence and
 * the author agent's sentence are not the same sentence, and matching them literally would report
 * every rewording as a loss. What is asked is the question that matters — **does the reference say
 * anything of this kind about this character at all** — and only rows that came from the document
 * count as an answer (see `schema.js`'s `EXTRACTION_SOURCE_STAGE`).
 *
 * @param {ReferenceStore} store
 * @param {{volume?: number}} [opts]
 * @returns {Array<{key: string, aspect: string, label: string|null, body: string, id: string}>}
 */
function unadoptedVoiceClaims(store, { volume } = {}) {
  const vol = Number(volume === undefined ? store.volume : volume);
  return store.db
    .prepare(
      "SELECT e.id AS id, e.key AS key, e.aspect AS aspect, e.label AS label, e.body AS body FROM facts e " +
        "WHERE e.owner_volume = ? AND e.source_stage = ? AND e.key IS NOT NULL " +
        "AND NOT EXISTS (SELECT 1 FROM facts d WHERE d.source_stage != ? AND d.key = e.key AND d.aspect = e.aspect) " +
        "ORDER BY e.key, e.aspect, e.ord"
    )
    .all(vol, EXTRACTION_SOURCE_STAGE, EXTRACTION_SOURCE_STAGE);
}

/**
 * Terms this volume's extraction found that the glossary has no row for.
 *
 * Matched on the term itself, normalized the way the store matches quotes. A term the glossary
 * already carries under a different section is not a loss.
 *
 * @param {ReferenceStore} store
 * @param {{volume?: number}} [opts]
 * @returns {Array<{id: string, term: string, label: string|null}>}
 */
function unadoptedTerms(store, { volume } = {}) {
  const vol = Number(volume === undefined ? store.volume : volume);
  const extracted = store.db
    .prepare(
      "SELECT id, examples, label FROM facts WHERE owner_volume = ? AND source_stage = ? AND aspect = 'term_usage' ORDER BY ord"
    )
    .all(vol, EXTRACTION_SOURCE_STAGE);
  const carried = new Set();
  for (const row of store.db
    .prepare("SELECT examples FROM facts WHERE source_stage != ? AND aspect = 'term_usage'")
    .all(EXTRACTION_SOURCE_STAGE)) {
    const term = firstSpan(row.examples);
    if (term) carried.add(normalizeQuote(term));
  }
  const out = [];
  for (const row of extracted) {
    const term = firstSpan(row.examples);
    if (!term) continue;
    if (carried.has(normalizeQuote(term))) continue;
    out.push({ id: row.id, term, label: row.label });
  }
  return out;
}

/**
 * The first quoted span of a row's `examples` column, which is where both adapters put the term.
 * @param {string} examples
 * @returns {string|null}
 */
function firstSpan(examples) {
  try {
    const parsed = JSON.parse(examples || "[]");
    const first = Array.isArray(parsed) ? parsed[0] : null;
    return typeof first === "string" && first.trim() ? first.trim() : null;
  } catch {
    return null;
  }
}

/**
 * The cast entries this volume's own text does not contain.
 *
 * Not damage — the account owner's rule is that a character with no lines in a volume is left
 * alone, and their existing claims are not touched. The report says so out loud, because the
 * difference between "the reference lost this character" and "this character is not in the book"
 * is the whole content of the coverage question, and a reader of the report should not have to
 * work it out.
 *
 * @param {ReferenceStore} store
 * @param {{volume?: number}} [opts]
 * @returns {Array<{key: string, display: string}>}
 */
function absentCharacters(store, { volume } = {}) {
  const vol = Number(volume === undefined ? store.volume : volume);
  if (!store.presenceMeasured(vol)) return [];
  const displayFor = store.db.prepare("SELECT display FROM cast WHERE key = ?");
  return store
    .castPresence(vol)
    .filter((row) => row.present === 0)
    .map((row) => {
      const found = displayFor.get(row.key);
      return { key: row.key, display: (found && found.display) || row.key };
    });
}

/**
 * How this volume's character-voice reference came to exist.
 *
 * Returns null when nothing rebuilt it — which is the normal case, and the case the report should not
 * mention. When it returns something, the reference in this record was adopted from the volume's
 * extraction output by code, and nobody reviewed it. The finding that says so lives in `integrity.js`,
 * with the other questions about how a row got into the record; this is the read half, for the report.
 *
 * @param {ReferenceStore} store
 * @param {{volume?: number, document?: string}} [opts]
 * @returns {{at: string, filed: number, carried: number, refused: number, characters: number}|null}
 */
function rebuildProvenance(store, { volume, document = DOCUMENT_VOICE } = {}) {
  const vol = Number(volume === undefined ? store.volume : volume);
  return documentRebuilt(store, document, vol);
}

/**
 * Render the audit report the feedback stage reads.
 *
 * The file keeps the name and the reader it has always had; what changed is that it is written from
 * rows. Findings are grouped by severity because the feedback stage works in that order, and the
 * two "no damage here" sections are printed even when empty — a report that is silent about what it
 * checked is indistinguishable from a report that checked nothing.
 *
 * @param {Object} report
 * @param {string} report.title - Report heading, e.g. "Character-voice reference".
 * @param {string} report.file - The artifact the audit describes.
 * @param {number|string} report.volume - Volume label.
 * @param {PostMortemFinding[]} report.findings - Store and artifact findings together.
 * @param {Object<string, number>} [report.counts] - The store's table counts.
 * @param {number} [report.checked] - How many evidence items were re-checked against the source.
 * @param {boolean} [report.coverageAsked] - False when the roster-coverage question was not asked
 *   because this volume's character-voice document has not been mirrored into the record yet.
 * @param {Array<{key: string, aspect: string, label: string|null, body: string, id: string}>} [report.unadopted]
 * @param {Array<{key: string, display: string}>} [report.absent]
 * @param {Array<{term: string, label: string|null}>} [report.unadoptedTerms]
 * @param {{measured: number, present: number, absent: number}|null} [report.presence]
 * @param {Array<{character: string|null, label: string|null, because: string}>} [report.refused]
 * @param {{at: string, filed: number, carried: number, refused: number, characters: number, candidatesFiled?: number|null, candidatesRefused?: number|null}|null} [report.rebuilt]
 *   Set when this volume's character-voice reference was rebuilt by code from its extraction output.
 * @param {{asked: boolean, chapters: number|null, measured: boolean, significanceChapters: number|null, rows: Array<Object>}} [report.coverage]
 *   The coverage question's whole answer, one row per uncovered character with both signals measured.
 *   This is what a softened guard has to pay for visibility: every character the audit downgraded is
 *   named here, with the signal that was missing.
 * @returns {string} Markdown, ending in a newline.
 */
function renderAuditReport({
  title,
  file,
  volume,
  findings,
  counts = null,
  checked,
  coverageAsked,
  unadopted = [],
  absent = [],
  unadoptedTerms: unadoptedTermRows = [],
  presence = null,
  refused = [],
  rebuilt = null,
  coverage = null,
}) {
  const out = [
    `# ${title} — deterministic audit (volume ${volume})`,
    "",
    "Written by code from this volume's reference store (`series.db`). No model read the artifact to",
    "produce this report, and every number in it is a query result.",
    "",
  ];

  if (rebuilt) {
    out.push("## How this reference was written");
    out.push("");
    out.push(
      `**This volume's character-voice reference was rebuilt by code from its own extraction output** ` +
        `on ${rebuilt.at}: ${rebuilt.filed} claim(s) adopted, ${rebuilt.refused} refused, ` +
        `${rebuilt.characters} character(s) with at least one claim.`
    );
    out.push("");
    if (Number.isFinite(rebuilt.candidatesFiled)) {
      out.push(
        `${rebuilt.candidatesFiled} of those claims are also filed a second time as extraction ` +
          `candidates${rebuilt.candidatesRefused ? ` (${rebuilt.candidatesRefused} candidate copy could not be filed)` : ""}. ` +
          "That is the record's second reading of the same book: what the extractor found, kept beside " +
          "what this reference says, so \"the reference lost something the extraction found\" stays a question " +
          "the store can answer about a rebuilt volume instead of one it has to take on trust."
      );
      out.push("");
    }
    out.push("No author agent wrote it and no reader has reviewed it. Every bullet in it cites a line of");
    out.push("this volume's text, which is more than an unreviewed artifact usually has; what it does not");
    out.push("have is a reader. An author pass over this file is what turns it into a reviewed reference.");
    out.push("");
  }

  const order = ["HIGH", "MEDIUM", "LOW"];
  const high = findings.filter((f) => f.severity === "HIGH").length;
  const medium = findings.filter((f) => f.severity === "MEDIUM").length;
  out.push(
    `**Recommendation:** ${
      high
        ? `revise — ${high} HIGH finding(s) must be fixed before this volume is accepted.`
        : medium
          ? `revise (minor) — ${medium} finding(s) to correct; none of them blocks acceptance.`
          : "accept — no finding at any severity."
    }`
  );
  out.push("");
  for (const severity of order) {
    const group = findings.filter((f) => f.severity === severity);
    if (group.length === 0) continue;
    out.push(`## ${severity} findings`);
    out.push("");
    for (const item of group) {
      out.push(`- \`${item.kind}\` — ${item.message}`);
    }
    out.push("");
  }
  if (findings.length === 0) {
    out.push("## Findings");
    out.push("");
    out.push("None. Every question the store can ask about this volume was asked, and none of them");
    out.push("had an answer that indicates damage.");
    out.push("");
  }

  out.push("## What was checked");
  out.push("");
  out.push("| question | answer |");
  out.push("|---|---|");
  out.push(`| facts in the store | ${numberOr(counts, "facts")} |`);
  out.push(`| characters in the cast | ${numberOr(counts, "cast")} |`);
  out.push(`| chapters of this volume's text | ${numberOr(counts, "chapters")} |`);
  out.push(`| evidence re-checked against the source text | ${checked === undefined ? "—" : checked} |`);
  out.push(
    `| does the reference cover every character in the volume | ${
      coverageAsked === false
        ? "not asked yet — this volume's character-voice document has not been read into the record"
        : "asked"
    } |`
  );
  out.push(
    `| how a coverage gap is judged | ${
      coverage && coverage.significanceChapters
        ? `${coverage.significanceChapters}+ chapters of this volume's text, or a claim the extraction filed about them`
        : "—"
    } |`
  );
  out.push("");

  if (presence) {
    out.push(`## Who is in this volume's text`);
    out.push("");
    out.push(
      `Measured from the volume's own chapter files: ${presence.measured} cast entries searched, ` +
        `${presence.present} found, ${presence.absent} not present` +
        (presence.matchRows ? ` — ${presence.matchRows} place(s) where a name occurs, recorded one per line with the rule that proved it.` : ".")
    );
    out.push("");
    if (absent.length) {
      out.push("These are the cast entries whose name this record holds does not occur in this volume's");
      out.push("text. An absence is not damage, and nothing here is allowed to rewrite a claim because");
      out.push("the character happened to stay off the page — but a character who is in the book under a");
      out.push("name the record does not carry looks exactly like this, so this list is worth reading.");
      out.push("");
      out.push(...listLines(absent, (entry) => `- ${entry.display} (\`${entry.key}\`) — not printed in volume ${volume}'s text; no entry is required for them`));
      out.push("");
    }
  }

  if (coverage && coverage.asked && coverage.rows && coverage.rows.length) {
    const k = coverage.significanceChapters;
    const chapters = coverage.chapters === null || coverage.chapters === undefined ? "?" : coverage.chapters;
    const high = coverage.rows.filter((row) => row.severity === "HIGH");
    const mentions = coverage.rows.filter((row) => row.severity === "MEDIUM");
    out.push("## Characters the reference does not cover");
    out.push("");
    out.push(
      `Every one of them, with both signals measured. A gap is a **loss** when the extraction found ` +
        `voice material for them or their name occurs in ${k} or more of this volume's ${chapters} ` +
        "chapters; it is a **mention** when neither is true. The line is a constant in " +
        "`utils/reference-store/integrity.js`, pinned by a test, and it has no environment knob."
    );
    out.push("");
    out.push("| character | in this volume's text | the extraction found | verdict |");
    out.push("|---|---|---|---|");
    for (const row of coverage.rows) {
      const inText = row.measured
        ? `${row.chapters} of ${chapters} chapters (${row.lines} line(s)${row.rules.length ? `; ${row.rules.join(", ")}` : ""})${chapterList(row.chapterIds)}`
        : "not measured";
      const found = row.extractionClaims > 0 ? `${row.extractionClaims} claim(s)` : "nothing";
      const verdict =
        row.severity === "HIGH"
          ? "**HIGH — a real loss**"
          : `MEDIUM — a mention (${row.why.replace(/^both signals are missing: /, "")})`;
      out.push(`| ${row.display} (\`${row.key}\`) | ${inText} | ${found} | ${verdict} |`);
    }
    out.push("");
    if (mentions.length) {
      out.push(
        `${mentions.length} of these are downgraded to MEDIUM, and each one is named above with the signal ` +
          "that was missing. That list is the price of softening the guard: a main character the book only " +
          "names once looks exactly like a throwaway here, and the only defence is that a human can see it."
      );
      out.push("");
    }
    if (high.length) {
      out.push(`${high.length} of them is why this volume's record will not be copied forward.`);
      out.push("");
    }
  }

  if (unadopted.length) {
    out.push("## Claims the extraction found that the reference says nothing about");
    out.push("");
    out.push(`${unadopted.length} claim(s) the extraction pass produced with no claim of that kind about`);
    out.push("that character anywhere in the published document. This is the half of the old validator's");
    out.push("job that a model might have noticed and a query does not miss.");
    out.push("");
    out.push(...listLines(unadopted, (item) => `- **${item.key}** (${item.aspect}${item.label ? `, ${item.label}` : ""}) — ${clip(item.body)}`));
    out.push("");
  }

  if (unadoptedTermRows.length) {
    out.push("## Terms the extraction found that the glossary has no row for");
    out.push("");
    out.push(`${unadoptedTermRows.length} term(s) the extraction found that no glossary row carries.`);
    out.push("");
    out.push(...listLines(unadoptedTermRows, (item) => `- **${item.term}**${item.label ? ` (${item.label})` : ""}`));
    out.push("");
  }

  if (refused.length) {
    out.push("## Rows the store refused to record");
    out.push("");
    out.push(`${refused.length} claim(s) the store would not record. A claim with no citation that verifies`);
    out.push("against the book is not stored, and it is not quietly dropped either. These are the claims");
    out.push("that could not be checked.");
    out.push("");
    out.push(...listLines(refused, (item) => `- ${item.character ? `**${item.character}**` : ""}${item.label ? ` (${item.label})` : ""} — ${item.because}`));
    out.push("");
  }

  return out.join("\n").replace(/\n+$/, "") + "\n";
}

/**
 * How much of the artifact the acceptance grader is shown, in characters.
 *
 * The whole-document grade is what made the voice stage cost what it cost: the grader is handed the
 * cumulative reference, which grows every volume, and the grading call is repeated for the
 * exceptional-score confirmation. The sampled grade keeps the rubric and the answer contract exactly
 * as they are and changes only how much of the document is in the message. 20,000 characters is
 * roughly the size of the largest *chapter* the pipeline already sends in one call, so it is a size
 * the endpoint is known to take.
 */
const GRADE_SAMPLE_MAX_CHARS = 20000;

/**
 * Build the sample the acceptance grader is shown instead of the whole artifact.
 *
 * Selection is deterministic and stated in the sample's own header, because a grade whose sample was
 * chosen by a model would be a grade you cannot compare from volume to volume:
 *
 *   - the document's opening (everything before the first section) is always shown — the rubric
 *     judges the document's shape, and a sample without its shape cannot grade that;
 *   - sections this volume's record added come first — the work this volume did is what is being
 *     accepted;
 *   - the rest fill the remaining space in document order.
 *
 * The deterministic audit report is sent alongside the sample, so a defect in a section that did not
 * make the cut is still in front of the grader — as a finding with a severity, which is more than the
 * old whole-document read produced.
 *
 * @param {string} markdown - The artifact as it is on disk.
 * @param {Object} opts
 * @param {string} opts.file - Artifact name, for the header.
 * @param {number|string} opts.volume
 * @param {string} [opts.heading] - The heading that starts a section: `### ` for the voice reference,
 *   `## ` for the glossary.
 * @param {string[]} [opts.newestSections] - Section headings this volume's record added.
 * @param {number} [opts.maxChars]
 * @returns {{text: string, sectionsShown: number, sectionsTotal: number, chars: number, omitted: string[], truncated: string[]}}
 */
function buildGradeSample(markdown, { file, volume, heading = "### ", newestSections = [], maxChars = GRADE_SAMPLE_MAX_CHARS }) {
  const lines = String(markdown === undefined || markdown === null ? "" : markdown).split("\n");

  // The heading the sections actually use. The voice reference's canonical shape puts each character
  // under `### `, and the glossary puts its rows under `## ` — but the shape an agent left behind is
  // not always the shape the prompt asked for, and a sampler that silently finds no sections would
  // grade a document consisting of its own first paragraph.
  const used = sectionHeading(lines, heading);

  /** @type {Array<{heading: string|null, lines: string[]}>} */
  const blocks = [];
  let current = { heading: null, lines: [] };
  for (const line of lines) {
    if (line.startsWith(used)) {
      blocks.push(current);
      current = { heading: line.slice(heading.length).trim(), lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  blocks.push(current);

  const opening = blocks[0];
  const sections = blocks.slice(1).filter((block) => block.heading !== null);
  const newest = new Set(newestSections);

  const ranked = [
    ...sections.filter((block) => newest.has(block.heading)),
    ...sections.filter((block) => !newest.has(block.heading)),
  ];

  // The opening is always shown — the rubric judges the document's shape, and a grader that never saw
  // the title and the preamble cannot judge it — but it is clipped to the budget like everything else.
  const openingCut = takeWithinBudget(opening.lines, maxChars);
  /** @type {Array<{block: Object, lines: string[]}>} */
  const chosen = [];
  /** @type {string[]} */
  const truncated = [];
  let taken = openingCut.lines.join("\n").length;
  for (const block of ranked) {
    const size = block.lines.join("\n").length;
    if (chosen.length > 0 && taken + size > maxChars) continue;
    const room = maxChars - taken;
    if (size <= room) {
      chosen.push({ block, lines: block.lines });
      taken += size;
      continue;
    }
    // Over budget on its own. Giving up here would grade a document consisting of its own first
    // paragraph; taking it whole would not be a sample at all, and that is what happened to volume 01's
    // character-voice reference, whose single 54,341-character line made a 20,000-character budget
    // meaningless. Take as much of it as fits and say out loud that you did.
    const cut = takeWithinBudget(block.lines, Math.max(room, 0));
    chosen.push({ block, lines: cut.lines });
    truncated.push(block.heading);
    taken += cut.lines.join("\n").length;
    break;
  }

  const chosenBlocks = new Set(chosen.map((entry) => entry.block));
  const omitted = ranked.filter((block) => !chosenBlocks.has(block)).map((block) => block.heading);

  const header = [
    `### What you are being shown`,
    "",
    `This is a **sample** of ${file} (volume ${volume}), not the whole document: ${chosen.length} of ` +
      `${sections.length} sections, ${taken} characters. The sections this volume added were selected ` +
      `first${omitted.length ? `; ${omitted.length} section(s) are not shown (${omitted.join(", ")})` : ""}` +
      `${truncated.length ? `; ${truncated.length} section(s) are shown cut short (${truncated.join(", ")}) because they are larger than this sample's budget` : ""}. ` +
      "The deterministic audit below was produced by querying the whole document's record, not a part " +
      "of it, so what it says about the parts you are not shown is measured, not sampled.",
    "",
  ];

  const body = [...openingCut.lines, ...chosen.flatMap((entry) => entry.lines)];
  return {
    text: header.join("\n") + "\n" + body.join("\n").replace(/\n+$/, "") + "\n",
    sectionsShown: chosen.length,
    sectionsTotal: sections.length,
    chars: taken,
    omitted,
    truncated,
  };
}

/**
 * Take whole lines from a block until the budget runs out, and report whether anything was left out.
 *
 * A line longer than the remaining budget is cut mid-line rather than taken whole. That is deliberate:
 * the budget exists to keep a grading prompt inside a context window, and one 54,341-character line —
 * the exact damage volume 01's reference took — would otherwise make the budget a number that is
 * printed and not obeyed.
 *
 * @param {string[]} lines
 * @param {number} budget
 * @returns {{lines: string[], truncated: boolean}}
 */
function takeWithinBudget(lines, budget) {
  /** @type {string[]} */
  const kept = [];
  let used = 0;
  for (const line of lines) {
    const size = line.length + (kept.length ? 1 : 0);
    if (used + size <= budget) {
      kept.push(line);
      used += size;
      continue;
    }
    // The newline that joins this line to the ones already kept has to be paid for as well, or the
    // joined block lands one character over the budget every time.
    const room = budget - used - (kept.length ? 1 : 0);
    if (room > 1) kept.push(`${line.slice(0, room - 1)}…`);
    return { lines: kept, truncated: true };
  }
  return { lines: kept, truncated: false };
}

/**
 * The section headings this volume's own record added, for the voice reference.
 *
 * `owner_volume` is the volume that wrote the row, and copy-forward leaves it on the earlier
 * volume, so this is "what this volume added" rather than "what this volume's file contains".
 *
 * @param {ReferenceStore} store
 * @returns {string[]}
 */
function voiceNewestSections(store) {
  return store.db
    .prepare(
      "SELECT DISTINCT c.display AS display FROM facts f JOIN cast c ON c.key = f.key " +
        "WHERE f.owner_volume = ? AND f.source_stage != ? AND c.merged_into IS NULL"
    )
    .all(store.volume, EXTRACTION_SOURCE_STAGE)
    .map((row) => row.display);
}

/**
 * The section headings this volume's own record added, for the glossary.
 * @param {ReferenceStore} store
 * @returns {string[]}
 */
function glossaryNewestSections(store) {
  return store.db
    .prepare(
      "SELECT DISTINCT section FROM facts WHERE aspect = 'term_usage' AND owner_volume = ? AND source_stage != ? AND section IS NOT NULL"
    )
    .all(store.volume, EXTRACTION_SOURCE_STAGE)
    .map((row) => row.section);
}

/**
 * A count from the store's table counts, or a dash when the caller passed no counts.
 * @param {Object<string, number>|null} counts
 * @param {string} table
 * @returns {string}
 */
function numberOr(counts, table) {
  if (!counts || counts[table] === undefined) return "—";
  return String(counts[table]);
}

/**
 * One line of the report per claim: a body is a sentence, and a report is not the place for a
 * paragraph the artifact already holds.
 * @param {string} body
 * @returns {string}
 */
function clip(body) {
  const text = String(body || "").replace(/\s+/g, " ").trim();
  return text.length <= 160 ? text : `${text.slice(0, 157)}…`;
}

/**
 * Which chapters a name was found in, spelled out — the part of a coverage verdict a reader can
 * check by opening the book.
 *
 * Bounded, because 俺 is in all ten of volume 01's chapters and a list of every chapter id is not
 * more useful than the count; the count is what the rule acts on and the ids are what makes it
 * checkable. Beyond the bound the list says so rather than stopping silently.
 *
 * @param {string[]} chapterIds
 * @returns {string} ` — ch1, ch4, ch6, ch7.1`, or "" when there is nothing to name.
 */
function chapterList(chapterIds) {
  const ids = Array.isArray(chapterIds) ? chapterIds.filter(Boolean) : [];
  if (ids.length === 0) return "";
  const shown = ids.slice(0, 6);
  const rest = ids.length - shown.length;
  return ` — ${shown.join(", ")}${rest > 0 ? `, +${rest} more` : ""}`;
}

/**
 * How many named rows one section of the audit report lists before it switches to a count.
 *
 * The report is handed to the acceptance grader and to the feedback stage, so its size is a cost the
 * run pays on every volume. A section that names every row is worth having — a name is what makes a
 * finding actionable — but a volume whose extraction produced 60 unadopted claims does not need 60
 * lines to tell the reader the number is 60. The count is printed in the section's own sentence, so
 * the truncation never hides the size of the problem.
 */
const REPORT_LIST_LIMIT = 20;

/**
 * Turn a section's rows into report lines, naming up to the limit and then saying how many are not
 * shown.
 *
 * @param {Array<Object>} items
 * @param {(item: Object) => string} lineFor
 * @returns {string[]}
 */
function listLines(items, lineFor) {
  const lines = items.slice(0, REPORT_LIST_LIMIT).map(lineFor);
  const rest = items.length - REPORT_LIST_LIMIT;
  if (rest > 0) lines.push(`- …and ${rest} more, not listed here (${items.length} in total).`);
  return lines;
}

module.exports = {
  VALIDATION_STEP,
  GRADE_SAMPLE_MAX_CHARS,
  REPORT_LIST_LIMIT,
  artifactShapeFindings,
  unadoptedVoiceClaims,
  unadoptedTerms,
  absentCharacters,
  rebuildProvenance,
  renderAuditReport,
  buildGradeSample,
  voiceNewestSections,
  glossaryNewestSections,
};
