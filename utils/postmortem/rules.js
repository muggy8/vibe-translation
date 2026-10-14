/**
 * utils/postmortem/rules.js — what a finding is, and what a shape means.
 *
 * The one constructor for a finding (severity, kind, level, levelDeclared, step, volume, file, message)
 * and the shape vocabulary the checks compare artifacts against. Nothing here reads a file: it is the
 * vocabulary the file checks speak in. The level comes from ./levels.js, which is data in a closed path
 * so the role being investigated cannot re-grade the finding it is investigated for.
 *
 * `levelDeclared` is the fail-closed marker the triage reads (`utils/resume/state.js`): the default
 * level for an unknown kind is `MINOR`, and `MINOR` is the one level the triage is allowed to batch
 * without opening the run. A default that the reader cannot see is therefore a kind that disappears,
 * which is the exact failure `utils/postmortem/plan/01-finding-levels.md` §1 was written about. So the
 * finding carries the fact that its level was defaulted, beside the message that says so.
 */

const path = require("path");

const { hasDocumentShape } = require("../fs");
const { seriesArtifactFile } = require("../../configs/shared");
const { FINDING_LEVELS, levelFor } = require("./levels");

/** @typedef {import("../postmortem").PostMortemFinding} PostMortemFinding */
/** @typedef {import("./levels").FindingLevel} FindingLevel */

// ─── Shape rules ──────────────────────────────────────────────────────────────

/**
 * Whether text holds a Markdown table — a pipe row followed by a `|---|` separator.
 *
 * Kept separate from {@link hasDocumentShape} (heading OR table) because the
 * glossary is the one artifact whose whole contract IS a table: a glossary written
 * as prose has lost the structure every downstream reader parses.
 *
 * @param {string} content
 * @returns {boolean}
 */
function hasTableShape(content) {
  const lines = String(content || "").split("\n");
  for (let i = 0; i < lines.length - 1; i++) {
    const row = lines[i].trim();
    const sep = lines[i + 1].trim();
    if (row.startsWith("|") && /^\|[\s|:-]+\|/.test(sep) && /-/.test(sep)) return true;
  }
  return false;
}

/**
 * How many paragraphs of ordinary text a `prose` artifact must hold.
 *
 * Two, not one: the defect this shape exists to catch is a file that holds the
 * volume's warning banner, or one line of model chatter, or a heading with nothing
 * under it. One paragraph cannot tell those apart from a real book; two can, and no
 * size threshold is needed. Measured against the material the pipeline actually
 * writes: the offline loop's translated volume holds 11 body paragraphs (12 blocks,
 * one of them the UNVERIFIED banner) and the real 17 volumes' chapters run from 547
 * to 19,174 source characters each, so a merged volume is never one paragraph.
 *
 * @type {number}
 */
const PROSE_MIN_PARAGRAPHS = 2;

/**
 * The ordinary-text paragraphs of a file: blank-line-separated blocks with the
 * structure stripped out of them.
 *
 * Headings, table rows, blockquote banners (the UNVERIFIED warning the merge puts
 * above a chapter that did not pass verification) and horizontal rules are removed
 * line by line, so what is left is the text a reader actually reads. A block with
 * nothing left is not a paragraph of prose.
 *
 * @param {string} content
 * @returns {string[]} The paragraphs, in order.
 */
function proseParagraphs(content) {
  const paragraphs = [];
  for (const block of String(content || "").split(/\n\s*\n/)) {
    const text = block
      .split("\n")
      .filter((line) => {
        const t = line.trim();
        if (!t) return false;
        if (/^#{1,6}\s/.test(t)) return false;
        if (/^>/.test(t)) return false;
        if (/^\|.*\|$/.test(t)) return false;
        if (/^[-*_]{3,}$/.test(t)) return false;
        return true;
      })
      .join(" ")
      .trim();
    if (text) paragraphs.push(text);
  }
  return paragraphs;
}

/**
 * Whether text is a translated book rather than a scaffold, a banner or a remark.
 *
 * This is the shape `translation.md` needs and `document` cannot give it. The merge
 * deliberately prints no heading for a chapter whose title is a file name, a pipeline
 * label, or a title still written in the source language
 * (`utils/translate/merge.js: headingForSegment`), and the translate prompt says
 * "output only the translation". Measured against the real corpus: 17 volumes, 133
 * chapters, **0 headings the merge would print** — so `shape: "document"` reports
 * `wrong-shape` on every legitimate translated volume, and at MAJOR that halts the
 * run at volume 1 on a false positive. `prose` keeps the check honest in both
 * directions: it refuses a file that is only structure (`document` accepts `# Title`
 * with nothing under it) and it accepts the prose the stage actually publishes.
 *
 * @param {string} content
 * @returns {boolean}
 */
function hasProseShape(content) {
  return proseParagraphs(content).length >= PROSE_MIN_PARAGRAPHS;
}

/**
 * Whether text satisfies one expectation's declared shape.
 *
 * @param {string} content - The file's contents.
 * @param {"document"|"table"|"json"|"prose"|"any"} [shape]
 * @returns {boolean}
 */
function matchesShape(content, shape) {
  if (!shape || shape === "any") return true;
  if (shape === "table") return hasTableShape(content);
  if (shape === "document") return hasDocumentShape(content);
  if (shape === "prose") return hasProseShape(content);
  if (shape === "json") {
    try {
      JSON.parse(content);
      return true;
    } catch {
      return false;
    }
  }
  return true;
}

// ─── Finding helpers ──────────────────────────────────────────────────────────

/**
 * The sentence a finding carries when its kind has no row in the level table.
 *
 * Its own function because `utils/postmortem/channel.js` rebuilds a stored finding through `finding()` and
 * has to recognise this exact text to avoid appending it twice — a finding that travelled through the
 * channel would otherwise print the same disclaimer twice, and a message that reads wrong is a message
 * people stop reading.
 *
 * @param {string} kind
 * @returns {string} The note, with its leading space, or "" when the kind IS declared.
 */
function undeclaredLevelNote(kind) {
  if (FINDING_LEVELS[kind]) return "";
  return ` [level undeclared for kind "${kind}" — reported at MINOR, which is the safe default and not a judgement about this finding]`;
}

/**
 * Build one finding.
 *
 * The level is looked up here, at the moment the finding is built, so it travels with the finding into
 * the report, the JSON sidecar and the triage instead of being re-derived by whoever reads them
 * (`utils/postmortem/plan/01-finding-levels.md` §6). A kind with no row in the table gets `"MINOR"` —
 * investigated, never a halt — **and its message says so**, because a default that is invisible is how
 * an unclassified kind ends up reported as a small one.
 *
 * `levelDeclared` is the same fact as data. Under level routing (`utils/resume/state.js`) `MINOR` is
 * the level the triage may batch without opening the run, so an unclassified kind that only *said*
 * MINOR in prose would land in the channel this plan exists to close. The triage reads the flag and
 * routes an undeclared kind as damage instead.
 *
 * @param {"HIGH"|"MEDIUM"|"LOW"} severity
 * @param {string} kind
 * @param {string} step
 * @param {string|null} volume
 * @param {string} file
 * @param {string} message
 * @returns {PostMortemFinding}
 */
function finding(severity, kind, step, volume, file, message) {
  const declared = Boolean(FINDING_LEVELS[kind]);
  const level = levelFor(kind);
  return {
    severity,
    kind,
    level,
    levelDeclared: declared,
    step,
    volume,
    file,
    message: `${message}${undeclaredLevelNote(kind)}`,
  };
}

/**
 * Where a series-root artifact actually lives. The four cumulative copies honour
 * `SERIES_ARTIFACTS_DIR` and their legacy per-file overrides, so looking for them
 * at the series root unconditionally would report a false "missing" on a machine
 * that moved them.
 *
 * @param {string} fileName
 * @param {string} seriesDir
 * @returns {string} Absolute path.
 */
function seriesArtifactPath(fileName, seriesDir) {
  const legacyKeys = {
    "glossary.md": "GLOSSARY_OUTPUT_FILE",
    "character-voice.md": "VOICE_OUTPUT_FILE",
    "style-guide.md": "STYLE_OUTPUT_FILE",
    "shared-wiki.md": "SHARED_WIKI_OUTPUT_FILE",
  };
  return seriesArtifactFile(fileName, legacyKeys[fileName] || "", seriesDir);
}

module.exports = { hasTableShape, hasProseShape, proseParagraphs, matchesShape, finding, undeclaredLevelNote, seriesArtifactPath };
