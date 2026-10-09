/**
 * utils/prompt.js - Prompt and verdict utility functions.
 *
 * @example
 * const { transformUserPrompt, isPassingVerdict, parseAcceptanceScore } = require("../utils/prompt");
 */

const fs = require("fs");
const path = require("path");
const { extractJsonObject } = require("./manifest");
const { dryRunDir, ensureRunStateGitignore } = require("../configs/run-state");

function transformUserPrompt(template, values) {
  let result = template;
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== "string" || !value)
      throw new Error("Missing value for placeholder: {{" + key + "}}");
    result = result.split("{{" + key + "}}").join(value);
  }
  const leftover = result.match(/\{\{[A-Z0-9_]+\}\}/);
  if (leftover)
    throw new Error("Unfilled placeholder left in user prompt: " + leftover[0]);
  return result;
}

function isPassingVerdict(output) {
  if (typeof output !== "string") return false;
  const text = output.trim().toUpperCase();
  if (text === "PASS") return true;
  if (text === "FAIL") return false;
  const hasPass = /\bPASS\b/.test(text);
  const hasFail = /\bFAIL(?:ED|URES?)?\b/.test(text);
  const negated = /\bNOT\s+PASS\b/.test(text);
  return hasPass && !hasFail && !negated;
}

/**
 * Parse an acceptance score (0–100) from the raw output of the acceptance
 * one-shot check.
 *
 * The acceptance prompts ask the model to respond with exactly one integer
 * from 0 to 100 (100 = perfect, 0 = atrocious). In practice models sometimes
 * wrap the number in text ("Score: 72", "72/100", "72 out of 100"), so this
 * extracts it with two strict patterns:
 *
 *   1. Explicit denominator — "72/100", "72 out of 100", "72 of 100".
 *   2. First standalone integer — "72", "Score: 72", "The score is 72."
 *
 * The first number in the reply wins, so a leading "Score: 72" is found even
 * if the model appends extra prose afterwards.
 *
 * @param {string} output - Raw output of the acceptance one-shot call.
 * @returns {number | null} An integer 0–100, or `null` when no valid score
 *   could be extracted (no number, or a number > 100). Callers treat `null`
 *   as a failed check (fail-closed) — see the acceptance loops in the task
 *   modules.
 */
function parseAcceptanceScore(output) {
  if (typeof output !== "string") return null;
  const text = output.trim();
  // 1. Explicit "/100" or "out of 100" / "of 100" denominator.
  const denom = text.match(/(\d{1,3})\s*(?:\/|out\s+of|of)\s*100\b/i);
  if (denom) {
    const n = parseInt(denom[1], 10);
    return n <= 100 ? n : null;
  }
  // 2. First standalone integer (not immediately preceded by "/" or a digit).
  const bare = text.match(/(^|[^/\d])(\d{1,3})(?!\d)/);
  if (bare) {
    const n = parseInt(bare[2], 10);
    return n <= 100 ? n : null;
  }
  return null;
}

/**
 * Step cap for a validator agent, scaled to the source it must audit.
 *
 * A fixed cap ran out on a 521 KB source before the validator could write its
 * report (gotcha 4), so the cap follows the number of 32 KB pages the agent
 * has to read.
 *
 * @param {number} sourceSizeBytes - Size of the source file being validated.
 * @returns {number} The step cap.
 */
function validatorMaxStepsFor(sourceSizeBytes) {
  const chunks = Math.max(1, Math.ceil((sourceSizeBytes || 0) / 32768));
  return Math.max(40, chunks * 2 + 24);
}

/**
 * Step cap for a cumulative-artifact author / feedback agent (glossary, character
 * voice reference, style guide): it must read the cumulative artifact it is
 * amending, the text it is amending FROM, and (for feedback) the validation
 * report, then patch the file.
 *
 * A flat 40 ran out on the live 17-volume run — 17 of the 25 step-cap warnings
 * were glossary amend turns and 7 were glossary feedback turns, each spending
 * 8–17 paged `readFile` calls because the cumulative artifact no longer fits in
 * one read (`AGENT_MAX_READ_BYTES` is 64 KB). Both halves of the reading grow
 * with the series, so the cap follows them. A flat 30 did the same damage to the
 * character-voice and style-guide stages, which had never been scaled (observed:
 * a 46-tool-call character-voice feedback turn that wrote nothing).
 *
 * @param {number} artifactSizeBytes - Size of the cumulative artifact it amends.
 * @param {number} sourceSizeBytes - Size of the volume (or chapter) source it reads.
 * @returns {number} The step cap.
 */
function authorMaxStepsFor(artifactSizeBytes, sourceSizeBytes) {
  const artifactPages = Math.ceil((artifactSizeBytes || 0) / 32768);
  const sourcePages = Math.ceil((sourceSizeBytes || 0) / 32768);
  return Math.max(40, (artifactPages + sourcePages) * 2 + 24);
}

/**
 * Step cap for the findings-merge agent (chunked mode): it reads one validation
 * partial per chapter PLUS the cumulative artifact those partials describe, then
 * writes one consolidated report.
 *
 * The cap used to be a flat 20, and a 10-chapter volume spent 34 read/grep
 * calls before it reached the write — so the whole validation round's work was
 * thrown away. Both halves of its reading grow: the number of partials with the
 * volume's chapter count, the artifact with the series.
 *
 * @param {number} segmentCount - How many chapter partials to consolidate.
 * @param {number} artifactSizeBytes - Size of the cumulative artifact it audits.
 * @returns {number} The step cap.
 */
function findingsMergeMaxStepsFor(segmentCount, artifactSizeBytes) {
  const partials = Math.max(1, segmentCount || 1);
  const artifactPages = Math.max(1, Math.ceil((artifactSizeBytes || 0) / 32768));
  return Math.max(20, partials * 3 + artifactPages * 2 + 12);
}

/**
 * Parse the acceptance one-shot reply under the JSON contract: the prompts
 * ask for a single JSON object {"score": 0-100, "band": "...", "note": "..."}.
 *
 * Tries the JSON object first (markdown fences and surrounding prose are
 * tolerated by extractJsonObject); when no valid JSON score is present it
 * falls back to the legacy integer extraction (parseAcceptanceScore), so an
 * old-style "85" reply still counts instead of failing the run.
 *
 * @param {string} output - Raw output of the acceptance one-shot call.
 * @returns {{score: number, band: string|null, note: string|null} | null}
 *   The parsed reply, or `null` when no valid score could be extracted at
 *   all (callers treat `null` as a failed check — fail-closed).
 */
function parseAcceptanceReply(output) {
  if (typeof output === "string" && output.trim() !== "") {
    try {
      const obj = extractJsonObject(output);
      if (obj && typeof obj === "object" && Number.isInteger(obj.score) && obj.score >= 0 && obj.score <= 100) {
        return {
          score: obj.score,
          band: typeof obj.band === "string" ? obj.band : null,
          note: typeof obj.note === "string" ? obj.note : null,
        };
      }
    } catch {
      // No parseable JSON object — fall through to the legacy integer parse.
    }
  }
  const score = parseAcceptanceScore(output);
  if (score === null) return null;
  return { score, band: null, note: null };
}

async function writePromptDump(task, installmentNumber, mode, sections) {
  const dir = dryRunDir();
  await fs.promises.mkdir(dir, { recursive: true });
  ensureRunStateGitignore();
  const file = path.join(dir, `${task}-${installmentNumber}.md`);
  const body = `# ${task} - volume ${installmentNumber} prompt dump (--dry-run)\n\nMode: ${mode}\n\n` + sections.map((s) => `## ${s.title}\n\n${s.prompt}\n`).join("");
  await fs.promises.writeFile(file, body, "utf-8");
  return file;
}

/**
 * Keep the sections of a cumulative reference that matter for the volume being
 * processed, instead of "the last N sections".
 *
 * The cumulative artifacts (character voice reference, style guide) are organised
 * by SECTION — one per character, one per construct category — and the sections
 * written for volume 1 stay at the TOP of the document forever. Truncating to the
 * last N sections therefore throws away the main cast and the honorific rules,
 * which is exactly what a later volume still needs most: the extractor is shown a
 * reference with the protagonists missing and duly rediscovers them as new.
 *
 * Selection is deterministic and relevance-ordered. A section is relevant when
 *   - its heading text occurs in this volume's source, or
 *   - a source-language span quoted inside it (a run of 2+ kana / Han / Hangul
 *     characters) occurs in this volume's source.
 * Relevant sections are kept first, then the rest in document order, and the
 * output preserves the original section order. Without a source text the old
 * "last N" behavior is kept, and the note says which rule ran.
 *
 * With `maxChars` instead of `maxUnits` the same ranking packs whole sections
 * into a CHARACTER budget (what the translation stage needs: the reference must
 * fit the prompt, and a section count is not the constraint).
 *
 * @param {{
 *   content: string,
 *   headingRe: RegExp,
 *   sourceText?: string,
 *   maxUnits?: number,
 *   maxChars?: number,
 *   unitLabel?: string,
 * }} p - the document, the heading pattern that starts a section (e.g. /^### /m), the volume's source text, and how much to keep (a section count or a character budget).
 * @returns {{content: string, kept: number, dropped: number, relevant: number, truncated: boolean}}
 */
function selectSectionsByRelevance({ content, headingRe, sourceText, maxUnits, maxChars, unitLabel = "section(s)" }) {
  if (!content) return { content, kept: 0, dropped: 0, relevant: 0, truncated: false };
  // The `g` flag is required for the exec loop (a non-global exec ignores
  // lastIndex and matches the same position forever).
  const flagSet = new Set(headingRe.flags.split(""));
  flagSet.add("g");
  flagSet.add("m");
  const re = new RegExp(headingRe.source, [...flagSet].join(""));
  const starts = [];
  let m;
  while ((m = re.exec(content)) !== null) {
    starts.push(m.index);
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  const byChars = Number.isFinite(maxChars) && maxChars > 0;
  if (starts.length === 0 || (!byChars && starts.length <= maxUnits)) {
    // Under the section cap. With a character budget the document may still be
    // too big, so fall through to the packing step below.
    if (!byChars || content.length <= maxChars) {
      return { content, kept: starts.length, dropped: 0, relevant: 0, truncated: false };
    }
  }
  const header = content.slice(0, starts[0]);
  const sections = starts.map((start, i) => ({
    index: i,
    text: content.slice(start, i + 1 < starts.length ? starts[i + 1] : content.length),
  }));

  const src = (sourceText || "").trim();
  const CJK_SPAN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]{2,}/g;
  const relevanceOf = (section) => {
    if (!src) return null;
    const heading = section.text.split("\n", 1)[0].replace(/^#+\s*/, "").trim();
    if (heading && src.includes(heading)) return true;
    const spans = section.text.match(CJK_SPAN) || [];
    // Only the distinct spans matter, and only a bounded number of them: a long
    // section can quote hundreds of runs, and testing all of them is pointless
    // once one has matched.
    const seen = new Set();
    for (const span of spans) {
      if (seen.size >= 60) break;
      if (seen.has(span)) continue;
      seen.add(span);
      if (src.includes(span)) return true;
    }
    return false;
  };

  const ranked = sections.map((section) => ({ section, relevant: relevanceOf(section) }));
  const ordered = src
    ? [...ranked].sort((a, b) => {
        const d = (a.relevant ? 0 : 1) - (b.relevant ? 0 : 1);
        return d !== 0 ? d : a.section.index - b.section.index;
      })
    : [...ranked].reverse();
  // Pick the survivors: a section count, or whole sections packed into a
  // character budget (in the same relevance order).
  const budget = byChars ? Math.max(0, maxChars) : Infinity;
  const chosen = [];
  let used = 0;
  const limit = byChars ? sections.length : Math.min(maxUnits, sections.length);
  for (const entry of ordered) {
    if (chosen.length >= limit) break;
    const size = entry.section.text.trimEnd().length + 2;
    if (byChars && used + size > budget && chosen.length > 0) continue;
    chosen.push(entry);
    used += size;
  }
  const keepIdx = new Set(chosen.map((r) => r.section.index));
  const relevantKept = chosen.filter((r) => r.relevant === true).length;
  const kept = sections.filter((section) => keepIdx.has(section.index));
  const dropped = sections.length - kept.length;
  const note = src
    ? `[TRUNCATED: this reference has ${sections.length} ${unitLabel}. Showing ${kept.length} of them — every ${unitLabel.replace(/\(s\)/, "")} that occurs in the text being processed (${relevantKept} such section(s)) is included, then the rest in document order. ` +
      `${dropped} ${unitLabel} are not shown; they are carried forward UNCHANGED in the file itself, so do not treat something as new merely because it is absent from what you can see here.]`
    : `[TRUNCATED: this reference has ${sections.length} ${unitLabel}. Showing the last ${kept.length}; ${dropped} older ${unitLabel} are omitted. ` +
      `Earlier entries are carried forward unchanged in the file itself — reconcile new work against what is shown here.]`;
  return {
    content: [header.trimEnd(), note, ...kept.map((section) => section.text.trimEnd())].join("\n\n"),
    kept: kept.length,
    dropped,
    relevant: relevantKept,
    truncated: true,
  };
}

module.exports = {
  transformUserPrompt,
  isPassingVerdict,
  parseAcceptanceScore,
  parseAcceptanceReply,
  validatorMaxStepsFor,
  authorMaxStepsFor,
  findingsMergeMaxStepsFor,
  writePromptDump,
  selectSectionsByRelevance,
};
