/**
 * glossary/extract/reading-block.js — the readings the BOOK printed, put in front of the pass that
 * chooses how a term is written.
 *
 * WHY THIS FILE EXISTS (plan 08 §1). The converter extracts 蒲田, not 蒲かま田た (gotcha 123), which is
 * correct, and nothing since then has put the guides back in front of the model. So the pass that decides
 * a term's target-language wording sees bare spelling. In the one case in this corpus where the book
 * answers the question outright — 亜茶花 is guided **あさか 32 times across volumes 3, 7, 9, 13, 14 and 16,
 * and volume 3 published "Atsuka" with the note "the reading was inferred"** — the pipeline threw the
 * answer away, guessed from the spelling, guessed wrong, and later paid a revision call to rediscover
 * what was printed over the word since volume 3.
 *
 * The block is a table, not markup. Measured on the 17 real books (0 model calls, 0 database opens,
 * `/tmp/opencode/measure-reading-block-cap.js`): inline ruby over every guide would add 999,444 characters
 * (40.8 % of the extracted text); this table adds 207,016 (8.45 %) at 18,568 lines, median 92 lines and
 * 1,061 characters per chapter, p90 342 lines, max 503 lines / 5,552 characters.
 *
 * THE RULES THIS FILE IS BUILT ON
 *
 *   - **Every guide is eligible** (plan 08 §0 decision 1). Nothing here filters by rarity, by script, by
 *     "looks meaningful", or by how often the author used it. A guide may be *displayed* selectively; it
 *     is never *unknown* to the pipeline. The older rule that decided which guides mattered — plan 07
 *     slice 5's "the renames plus a guide applied every single time and used at most twice" — is a display
 *     choice, and it is not the gate on what this pass is shown.
 *   - **Multiplicity is printed, not filtered.** A word guided several ways prints every reading it was
 *     given on one line: `虹彩寺菫 → こうさいじすみれ | パンジー`. The fact that a word has four readings is
 *     itself the signal, and a filter that picked one would be the pipeline deciding what the annotation
 *     means — which is plan 07 §7's forbidden shape.
 *   - **The bound is on what is SHOWN, and the lines it drops are named.** `READING_BLOCK_MAX_LINES` is a
 *     constant with no environment knob (AGENTS.md rule 3). A cap that silently truncates is a cap that
 *     hides the case it truncated, so the block ends with the count it dropped and some of their names,
 *     in the shape `character-voice/known-facts.js` uses (plan 06 slice 2). The announcement is itself
 *     bounded (`READING_BLOCK_NOTE_MAX_CHARS`) so a bound cannot be walked past by the line that reports
 *     it.
 *   - **The volume's own harvest, read once, through the one reader.** `utils/source/ruby-guides.js`'s
 *     `readRubyGuideFile` is the only reader of `<base>-ruby-guides.json` this file uses, and it is called
 *     once per volume and reused across that volume's chapters. A volume never reads a later volume's
 *     harvest — the block is built from the harvest of the volume whose folder is open, which is the same
 *     direction `written-forms-cannot-look-forward` enforces on the store's filing door.
 *   - **"Nothing to show" and "nothing was read" are two facts, and both are said.** A chapter whose book
 *     prints no guides gets a floor line saying so. A volume whose harvest is absent — a plain-text book,
 *     or one extracted before the harvest existed — gets a different sentence, naming the file. Neither is
 *     an empty string, and neither is a crash.
 *   - **No language is named, and no character of any one script appears in this file's own prose**
 *     (AGENTS.md rule 6, plan 06 §0 decision 1, `test/test-no-language-axis-list.js`). Every rule here is a
 *     fact about a guide the book printed, which is computable in any writing system.
 *
 * It costs 0 model calls and is not a new prompt kind: the block is appended to the term-list call that
 * already runs.
 *
 * Part of the glossary.js layer, inside the glossary read pass's own answer layer.
 *
 * @module glossary/extract/reading-block
 */

require("dotenv").config();
require("../../types"); // JSDoc type definitions

const { readRubyGuideFile } = require("../../utils/source/ruby-guides");

/**
 * How many lines one chapter's block may print. Constant, with no environment knob and no flag
 * (AGENTS.md rule 3).
 *
 * Measured against the 133 real chapters (`/tmp/opencode/measure-reading-block-cap.js`), the number of
 * written forms one chapter guides runs min 2, median 92, p90 342, max 503. At 400 the block truncates
 * **5 of 133 chapters** and drops **288 of 18,568 lines (1.6 %)**; at 250 it truncates 27 chapters and
 * drops 2,830; at 100 it truncates 54 chapters and drops 8,436; at 600 it truncates none. So 400 is the
 * smallest bound in that ladder that leaves 98 % of the book's own annotations in front of the pass, and
 * the 5 chapters it does bite on are named in the block they were cut from. The number is still the
 * account owner's to change (plan 08 §6 item 5) — this constant is where the decision lives, not a
 * guess about what the model should spend attention on.
 *
 * @type {number}
 */
const READING_BLOCK_MAX_LINES = 400;

/**
 * How many dropped lines the announcement names by name before it falls back to a count.
 *
 * "Names some of them" is the requirement; an unbounded name list is how an announcement becomes a second,
 * larger block than the one it truncated. The rest are counted.
 *
 * @type {number}
 */
const READING_BLOCK_NAMED_OMITTED = 12;

/**
 * The ceiling on the announcement line itself.
 *
 * The mirror of `KNOWN_FACTS_NOTE_RESERVE`: the line that names what was left out is the part of a bounded
 * block most likely to grow past its bound, so it gets its own ceiling and drops names rather than
 * characters.
 *
 * @type {number}
 */
const READING_BLOCK_NOTE_MAX_CHARS = 900;

/** The heading a single-chapter block carries. */
const READING_BLOCK_HEADING = "## Readings the book itself prints in this chapter";

/** The heading a whole-installment block carries, when the call is being shown the whole volume. */
const READING_BLOCK_HEADING_VOLUME = "## Readings the book itself prints in this volume";

/** How the readings of one written form are separated on its line, so multiplicity is visible. */
const READING_SEPARATOR = " | ";

/**
 * The volume's pronunciation-guide harvest, read once, in the shape the block needs.
 *
 * @typedef {Object} ReadingAids
 * @property {"read"|"no-harvest-in-source"|"harvest-file-missing"|"no-source-base"} state — WHICH fact this
 *   volume's guides are, because the four are different sentences and the block has to pick the right one.
 * @property {string|null} file — The harvest file name, when the volume has one.
 * @property {Array<import("../../types").RubyGuideRow>} guides — The rows it holds (empty when there is no harvest).
 * @property {import("../../types").RubyGuideTotals|null} totals — The harvest's own totals, for the log.
 * @property {string} because — One line saying what was found, for the log and for the block.
 */

/**
 * Read this volume's own harvest, once.
 *
 * The four answers are four different facts, and the difference is the point:
 *
 *   - **read** — the harvest is on disk and was opened. `guides` may still be empty, which means the book
 *     printed no guides.
 *   - **no-harvest-in-source** — the source is plain text (`bundle.format === "text"`), so the extraction
 *     had no markup to harvest. This is what every offline-loop fixture is.
 *   - **harvest-file-missing** — the bundle names a harvest and the file is not there: a volume extracted
 *     before the harvest existed, or one whose harvest was deleted. `utils/source/audit/checks.js` reports
 *     the same mismatch at the `extract` step; this door names it again where the model would otherwise
 *     silently be shown nothing.
 *   - **no-source-base** — the bundle carries no base name, so the harvest cannot be named at all.
 *
 * It never throws and never returns `null`: a volume with no harvest still gets a block.
 *
 * @param {{ volumeDir: string, bundle: import("../../types").SourceBundle|null }} opts
 * @returns {Promise<ReadingAids>}
 */
async function readVolumeReadingAids({ volumeDir, bundle }) {
  const base = bundle && bundle.base ? String(bundle.base) : "";
  if (!base) {
    return {
      state: "no-source-base",
      file: null,
      guides: [],
      totals: null,
      because: "this volume's source bundle names no source base, so no pronunciation-guide harvest can be looked for",
    };
  }
  const harvest = await readRubyGuideFile(volumeDir, base);
  if (harvest) {
    const guides = Array.isArray(harvest.guides) ? harvest.guides : [];
    const file = `${base}-ruby-guides.json`;
    return {
      state: "read",
      file,
      guides,
      totals: harvest.totals || null,
      because: guides.length
        ? `read ${file}: ${guides.length} word-and-reading row(s), the guides this volume's own book prints`
        : `read ${file}: it holds no rows, so this volume's book prints no pronunciation guides`,
    };
  }
  if (bundle && bundle.format === "text") {
    return {
      state: "no-harvest-in-source",
      file: null,
      guides: [],
      totals: null,
      because: "this volume's source is plain text, so the extraction had no markup to harvest and no harvest file exists",
    };
  }
  return {
    state: "harvest-file-missing",
    file: `${base}-ruby-guides.json`,
    guides: [],
    totals: null,
    because:
      `this volume's bundle names ${base}-ruby-guides.json and that file is not in the volume folder, ` +
      "so the guides the extraction recorded cannot be read",
  };
}

/**
 * Read the volume's harvest once and keep it on the volume context, so a chapter-by-chapter pass pays one
 * file read for the whole volume rather than one per chapter.
 *
 * Memoised on `ctx.readingAids`. A caller that already put a harvest there (a test, or a door that read it
 * for another reason) is not overwritten, because the point of the memo is "once per volume", not "always
 * from here".
 *
 * @param {{ volumeDir: string, bundle: import("../../types").SourceBundle|null, readingAids?: ReadingAids|null }} ctx
 * @returns {Promise<ReadingAids>}
 */
async function loadReadingAids(ctx) {
  if (ctx.readingAids) return ctx.readingAids;
  ctx.readingAids = await readVolumeReadingAids({ volumeDir: ctx.volumeDir, bundle: ctx.bundle });
  return ctx.readingAids;
}

/**
 * The lines one chapter's block prints: one per written form, every reading that form was given **in that
 * chapter** on its own line.
 *
 * The order is the harvest's own row order, which is the book's: most-guided reading first, then the word,
 * then the reading (`aggregateRubyGuides`). That is deliberate — the tail a cap cuts off is then the
 * single-occurrence tail, and the pipeline is not deciding which annotations matter, it is keeping the ones
 * the author used most.
 *
 * @param {Array<import("../../types").RubyGuideRow>} guides - The volume's harvest rows.
 * @param {string} chapterId - The chapter being read, as the extraction named it (`SourceSegment.id`).
 * @returns {Array<{form: string, readings: string[], line: string}>}
 */
function chapterReadingLines(guides, chapterId) {
  /** @type {Map<string, string[]>} */
  const byForm = new Map();
  for (const row of Array.isArray(guides) ? guides : []) {
    if (!row || typeof row.word !== "string" || !row.word) continue;
    if (!Array.isArray(row.chapters) || !row.chapters.includes(chapterId)) continue;
    const reading = typeof row.reading === "string" ? row.reading : "";
    const readings = byForm.get(row.word) || [];
    if (reading && !readings.includes(reading)) readings.push(reading);
    if (!byForm.has(row.word)) byForm.set(row.word, readings);
  }
  /** @type {Array<{form: string, readings: string[], line: string}>} */
  const out = [];
  for (const [form, readings] of byForm.entries()) {
    out.push({ form, readings, line: `  ${form} → ${readings.join(READING_SEPARATOR)}` });
  }
  return out;
}

/**
 * The line a truncated chapter ends with: how many lines were dropped, some of their names, and the fact
 * that they still exist.
 *
 * Bounded by `READING_BLOCK_NOTE_MAX_CHARS`: names are added while the line fits, and the remainder is a
 * count. An announcement that can grow without limit is how a bounded block walks past its bound.
 *
 * @param {number} total - Lines this chapter's book actually guides.
 * @param {number} shown - Lines the block printed.
 * @param {Array<string>} omittedForms - The written forms it dropped, in the order the book listed them.
 * @returns {string}
 */
function readingBlockTruncationNote(total, shown, omittedForms) {
  const dropped = total - shown;
  if (dropped <= 0) return "";
  const head = `_Shown: ${shown} of ${total} lines. ${dropped} written form(s) this chapter guides are left out to keep this block inside its ${READING_BLOCK_MAX_LINES}-line limit:_ `;
  let line = head;
  let named = 0;
  for (const form of omittedForms) {
    if (named >= READING_BLOCK_NAMED_OMITTED) break;
    const next = `${line}${named ? ", " : ""}${form}`;
    if (next.length > READING_BLOCK_NOTE_MAX_CHARS) break;
    line = next;
    named += 1;
  }
  const rest = dropped - named;
  if (rest > 0) line += `${named ? "," : ""} and ${rest} more`;
  return `${line}. Every one of them is still in this volume's harvest and still in the book; absence from this block is not permission to invent a reading.`;
}

/**
 * The sentence a chapter with nothing to show gets.
 *
 * Two different empties, in two different words. A chapter of a harvested volume that guides nothing is not
 * a volume nobody harvested, and a model shown a blank space cannot tell those apart — which is the same
 * mistake `readTermList` refuses to make with `[]` versus `failed: true` (gotcha 138).
 *
 * @param {ReadingAids} aids - What the volume's harvest answered.
 * @param {string} chapterId - The chapter being shown.
 * @returns {string}
 */
function readingBlockFloorLine(aids, chapterId) {
  if (aids.state === "no-harvest-in-source") {
    return (
      "_This volume's source is plain text, so the extraction had no pronunciation guides to take out and there is no harvest file to read. " +
      "That is NOT the same as this book printing none: a plain-text source carries no guides to harvest, so every rendering you choose " +
      "here is chosen from spelling alone and nothing here can be checked against a reading the author gave._"
    );
  }
  if (aids.state === "harvest-file-missing") {
    return (
      `_This volume's extraction recorded pronunciation guides in \`${aids.file}\` and that file is not in the volume folder, so the readings ` +
      `this book printed are NOT available to this pass. That is NOT the same as the book printing none — the guides exist and this pass cannot ` +
      "read them. Fix: `npx gulp extract` re-extracts the volume and writes the harvest beside it._"
    );
  }
  if (aids.state === "no-source-base") {
    return (
      "_This volume's source bundle names no source base, so no pronunciation-guide harvest could be looked for. Nothing about this book's " +
      "readings is known to this pass, and that is NOT the same as the book printing none._"
    );
  }
  if (!aids.guides.length) {
    return (
      "_The harvest was read and it holds no rows: this volume's book prints no pronunciation guides over any word. Every rendering you choose " +
      "here is chosen from spelling alone._"
    );
  }
  return (
    `_This chapter's book prints no pronunciation guides over any word. The harvest read for this volume holds ${aids.guides.length} guided ` +
    `word(s)${chapterId ? ` and none of them occurs in chapter ${chapterId}` : ""}, so this chapter's words are read from spelling alone._`
  );
}

/**
 * The block one term-list call is shown.
 *
 * One chapter, or every chapter of the volume the call is being shown — the shape follows the call, because
 * the block is a table of the text in front of the pass, not a document of its own.
 *
 * Never empty. A chapter with nothing to show gets the floor line, and a volume with no harvest gets the
 * sentence that says why, so "nothing to show" and "nothing was read" stay two different facts on the wire.
 *
 * @param {Object} opts
 * @param {ReadingAids} opts.aids - The volume's harvest, read once.
 * @param {Array<{id: string, title?: string}>} opts.chapters - The chapters this call is being shown.
 * @returns {{text: string, chaptersShown: number, chaptersEmpty: number, linesShown: number, linesOmitted: number, omittedForms: Array<string>, chars: number}}
 */
function buildReadingBlock({ aids, chapters }) {
  const list = Array.isArray(chapters) && chapters.length ? chapters : [{ id: "", title: "" }];
  const single = list.length === 1;

  /** @type {Array<{chapter: {id:string,title?:string}, lines: Array<{form:string,readings:string[],line:string}>, total: number, shown: number, omitted: Array<string>}>} */
  const sections = list.map((chapter) => {
    const lines = chapterReadingLines(aids.guides, chapter.id);
    const shown = lines.slice(0, READING_BLOCK_MAX_LINES);
    return {
      chapter,
      lines: shown,
      total: lines.length,
      shown: shown.length,
      omitted: lines.slice(READING_BLOCK_MAX_LINES).map((line) => line.form),
    };
  });

  const linesShown = sections.reduce((sum, section) => sum + section.shown, 0);
  const linesOmitted = sections.reduce((sum, section) => sum + (section.total - section.shown), 0);
  const omittedForms = sections.flatMap((section) => section.omitted);
  const emptyChapters = sections.filter((section) => section.total === 0).map((section) => section.chapter.id);

  /** @type {string[]} */
  const out = [single ? READING_BLOCK_HEADING : READING_BLOCK_HEADING_VOLUME, ""];

  if (linesShown === 0) {
    // Nothing to show. The heading and the sentence that says WHY there is nothing are the whole block —
    // the shape explanation below is for a table that is not here, and paying ~700 characters of preamble
    // to announce an empty table is how a floor becomes a cost.
    out.push(readingBlockFloorLine(aids, single ? list[0].id : ""));
    out.push("");
  } else {
    out.push(
      `Every pronunciation guide ${single ? "this chapter's" : "this volume's"} book puts over a word, read from ` +
        `this volume's own extraction harvest${aids.file ? ` (\`${aids.file}\`)` : ""}. A word guided more than one way ` +
        `prints every reading it was given, separated by \`${READING_SEPARATOR.trim()}\` — that a word has several readings ` +
        "is information, not noise, and nothing here has been filtered out to decide which one matters."
    );
    out.push(
      "A guide is not part of the word. Write `term` as the word alone, exactly as the book prints it, and use the reading when it " +
        "answers something the spelling does not: a name the spelling withholds, a second name for the same person, or a joke the reading " +
        "makes. Where the readings disagree, every one of them is something the book printed — say which one this chapter's prose uses " +
        "rather than picking one silently."
    );
    out.push("");
    for (const section of sections) {
      if (!section.shown) continue;
      if (!single) {
        out.push(`### ${section.chapter.id}${section.chapter.title ? ` — ${section.chapter.title}` : ""}`);
      }
      out.push(...section.lines.map((line) => line.line));
      out.push("");
      const note = readingBlockTruncationNote(section.total, section.shown, section.omitted);
      if (note) {
        out.push(note);
        out.push("");
      }
    }
    if (!single && emptyChapters.length) {
      out.push(
        `${emptyChapters.length} of this volume's ${list.length} chapters print no pronunciation guides at all` +
          ` (${emptyChapters.slice(0, READING_BLOCK_NAMED_OMITTED).join(", ")}` +
          `${emptyChapters.length > READING_BLOCK_NAMED_OMITTED ? `, and ${emptyChapters.length - READING_BLOCK_NAMED_OMITTED} more` : ""}).`
      );
      out.push("");
    }
  }

  const text = out.join("\n").trimEnd();
  return {
    text,
    chaptersShown: sections.filter((section) => section.shown > 0).length,
    chaptersEmpty: emptyChapters.length,
    linesShown,
    linesOmitted,
    omittedForms,
    chars: text.length,
  };
}

/**
 * Load the volume's harvest (once), build the block for the chapters this call is being shown, and say on
 * the log what the block cost and whether the cap bit.
 *
 * The one door both reading routes walk through, so the "read the harvest once per volume" rule and the
 * "the cap names what it dropped" rule live in one place rather than being re-implemented per route.
 *
 * @param {Object} opts
 * @param {{ volumeDir: string, bundle: import("../../types").SourceBundle|null, readingAids?: ReadingAids|null, values: Object }} opts.ctx
 * @param {Array<{id: string, title?: string}>} opts.chapters - The chapters this call is being shown.
 * @param {string} opts.label - What the log line calls this call.
 * @returns {Promise<{text: string, linesShown: number, linesOmitted: number, chaptersShown: number, chaptersEmpty: number, chars: number, state: string}>}
 */
async function showReadingAidsForCall({ ctx, chapters, label }) {
  const aids = await loadReadingAids(ctx);
  const built = buildReadingBlock({ aids, chapters });
  console.log(
    `${label}: the book's own readings — ${built.linesShown} line(s) shown` +
      `${built.linesOmitted ? `, ${built.linesOmitted} left out and named (${READING_BLOCK_MAX_LINES}-line cap)` : ""}` +
      `${built.chaptersEmpty ? `, ${built.chaptersEmpty} chapter(s) print no guides` : ""}` +
      ` [harvest: ${aids.state}] ${built.chars} characters.`
  );
  return { ...built, state: aids.state };
}

module.exports = {
  READING_BLOCK_MAX_LINES,
  READING_BLOCK_NAMED_OMITTED,
  READING_BLOCK_NOTE_MAX_CHARS,
  READING_BLOCK_HEADING,
  READING_BLOCK_HEADING_VOLUME,
  READING_SEPARATOR,
  readVolumeReadingAids,
  loadReadingAids,
  chapterReadingLines,
  readingBlockTruncationNote,
  readingBlockFloorLine,
  buildReadingBlock,
  showReadingAidsForCall,
};
