/**
 * glossary/settlement/declaration.js — the series' own declaration of what "more comes later" sounds
 * like in the language its glossary notes are written in.
 *
 * Plan 07 slice 7 (2026-10-15). The settlement agenda has two halves. The first is structural — a term
 * whose rendering a later volume already replaced (`row.supersedes`), which needs no words from any
 * language. The second reads the term's own note for a promise that the book has not finished making,
 * and that half is unavoidably a **vocabulary**: the 15 shapes in `agenda.js` are phrases in one language,
 * measured against notes written in that language.
 *
 * The owner's decision 2 (plan 07 §0) moves the notes into the language of the book. A Latin-script
 * vocabulary run over notes written in another script fires on nothing, and "fires on nothing" is the
 * exact shape of "this series has nothing to settle" — which is the failure §4.8 exists to prevent. A
 * vocabulary that cannot be asked must not be reported as a vocabulary that found nothing.
 *
 * So the second half gets a **declared** vocabulary, in the shape plan 06 slice 3 established for the
 * register questions (`utils/reference-store/register/declaration.js`), and for the same reason: the
 * pipeline carries no language list, in any language, and a per-series decision is written by the intake
 * from the book rather than compiled into a stage.
 *
 * ## The block
 *
 * ```json
 * "settlement": {
 *   "forwardMarkers": [ { "phrase": "…", "because": "…" } ],
 *   "note": "…"
 * }
 * ```
 *
 * - `phrase` is a **literal string**, matched as a substring. It is never compiled into a pattern: a
 *   declaration a model wrote is data, and data that can execute is a defect waiting to happen.
 * - `because` is optional, and it is what the settlement log prints beside a term so a person can see
 *   *which* declared phrase put that term on the agenda and what the intake thought it meant.
 * - `note` is required when `forwardMarkers` is empty, for the plan-06 reason: an empty list has to be a
 *   decision somebody wrote down, not a field that got left out.
 *
 * ## Absent and empty are different facts, and both are legal
 *
 * - **absent** — no `settlement` block. The agenda uses the shipped shapes and says, in its own report,
 *   that the text half covers only the script those shapes are written in. A plan of record written
 *   before this block exists stays valid for every stage, which is why `MANIFEST_SCHEMA` did not move.
 * - **present and empty** (`forwardMarkers: []` **with** a `note`) — the series says it declares none.
 *   Accepted, announced, and the `note` is printed.
 * - **present and malformed** — refused by `intake/validate.js` before any volume is processed, because
 *   the intake writes this decision and nobody else reviews it. `readSettlementDeclaration` reports it
 *   as `malformed` rather than re-refusing it: the door that writes a plan is the door that refuses a
 *   bad one, and a second refusal inside a late pass would turn a plan defect into a failed glossary
 *   step. What it does do is make sure the unusable half is **named** in the agenda's own coverage line.
 *
 * **What this file does NOT do:** it does not ask the intake to write the block. `system-prompts/
 * translation-target.md` is unchanged, so a paid intake run today produces the plan it produced
 * yesterday. Asking the intake to author a vocabulary for the glossary stage's own prose is a decision
 * about what the intake produces and what the glossary stage is told to write, and it is written up in
 * `/tmp/opencode/plan07-slice7-questions.md` rather than made here.
 *
 * @module glossary/settlement/declaration
 */

const fs = require("fs");
const path = require("path");
require("../../types"); // JSDoc type definitions

/** The plan-of-record file name. The same file `utils/reference-store/paths.js` reads its volume list out of. */
const PLAN_OF_RECORD_FILE_NAME = "translation-target.json";

/** The manifest key the declaration lives under, beside `seriesName` / `sourceLanguage` / `volumes` / `register`. */
const SETTLEMENT_MANIFEST_KEY = "settlement";

/** The fields the block itself may name. Anything else is a malformed block, named as such. */
const DECLARATION_FIELDS = ["forwardMarkers", "note"];

/** The fields one marker may name. */
const MARKER_FIELDS = ["phrase", "because"];

/** The fields one marker must name. */
const MARKER_REQUIRED_FIELDS = ["phrase"];

/**
 * A marker is a phrase, not a letter. One character matches a page, and a vocabulary whose shortest entry
 * matches a page is a vocabulary that puts every term on the agenda — which is gotcha 144's failure mode
 * arrived from the other side.
 */
const MARKER_MIN_CHARS = 2;
const MARKER_MAX_CHARS = 60;

/**
 * How many markers one series may declare. A bound, not a dial: a declaration long enough to match every
 * note is the agenda replaced by "ask about everything", and the bound is what makes that visible at the
 * door that writes the plan rather than at the pass that pays for it.
 */
const MARKER_MAX_PER_SERIES = 40;

/**
 * The four states a declaration can be in. `absent` and `empty` are the pair plan 06 §4.3 insists on;
 * `malformed` is a block that is present and cannot be trusted; `declared` is the normal one.
 *
 * @type {string[]}
 */
const DECLARATION_STATES = ["declared", "empty", "absent", "malformed"];

/**
 * One trimmed string, or null when the value is not a usable string.
 *
 * @param {*} value
 * @returns {string|null}
 */
function trimmedString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * The guards over one declared marker.
 *
 * @param {Object} marker - The marker as written.
 * @param {string} where - Where it came from, for the message (`settlement.forwardMarkers[2]`).
 * @param {string[]} seen - The phrases earlier markers in the same block already declare.
 * @returns {string[]} One problem per thing that is wrong, each naming `where`.
 */
function forwardMarkerProblems(marker, where, seen) {
  const problems = [];
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) {
    problems.push(`${where} is not an object — a marker is {phrase, because}.`);
    return problems;
  }

  const unknown = Object.keys(marker).filter((key) => !MARKER_FIELDS.includes(key));
  if (unknown.length > 0) {
    problems.push(
      `${where} names ${unknown.map((k) => `"${k}"`).join(", ")}, which this shape does not have. ` +
        `A marker is: ${MARKER_FIELDS.join(", ")} (only ${MARKER_REQUIRED_FIELDS.join(", ")} are required).`
    );
  }

  const phrase = trimmedString(marker.phrase);
  if (phrase === null) {
    problems.push(
      `${where} is missing a non-empty string "phrase" — the words a note has to contain for this series ` +
        `to count as pointing past the volume that wrote it.`
    );
  } else {
    if (phrase.length < MARKER_MIN_CHARS || phrase.length > MARKER_MAX_CHARS) {
      problems.push(
        `${where} "phrase" ${JSON.stringify(phrase)} is ${phrase.length} character(s); a marker is ` +
          `${MARKER_MIN_CHARS}-${MARKER_MAX_CHARS}. One character matches every note, and a marker that ` +
          `matches every note is not a marker.`
      );
    }
    if (seen.includes(phrase)) {
      problems.push(`${where} declares ${JSON.stringify(phrase)} again — a marker set is a set.`);
    }
  }

  if (marker.because !== undefined && trimmedString(marker.because) === null) {
    problems.push(`${where} "because" must be a non-empty string when it is present.`);
  }

  return problems;
}

/**
 * The guards over a whole declaration block.
 *
 * @param {*} block - The value of `manifest.settlement`, as written.
 * @param {string} [where] - The prefix every problem names.
 * @returns {string[]} One problem per thing that is wrong; empty when the block is well formed.
 */
function settlementDeclarationProblems(block, where = SETTLEMENT_MANIFEST_KEY) {
  if (block === undefined || block === null) return [];
  if (typeof block !== "object" || Array.isArray(block)) {
    return [`${where} is ${Array.isArray(block) ? "an array" : typeof block} — it is an object with ${DECLARATION_FIELDS.join(", ")}.`];
  }

  const problems = [];
  const unknown = Object.keys(block).filter((key) => !DECLARATION_FIELDS.includes(key));
  if (unknown.length > 0) {
    problems.push(
      `${where} names ${unknown.map((k) => `"${k}"`).join(", ")}, which this shape does not have. ` +
        `The block is: ${DECLARATION_FIELDS.join(", ")}.`
    );
  }

  /** @type {string[]} */
  const seen = [];
  if (block.forwardMarkers === undefined) {
    problems.push(
      `${where} is missing "forwardMarkers". A declared block that declares nothing is a malformed block: ` +
        `say the series declares none by writing "forwardMarkers": [] beside a "note".`
    );
  } else if (!Array.isArray(block.forwardMarkers)) {
    problems.push(`${where} "forwardMarkers" must be an array of {phrase, because} markers.`);
  } else {
    if (block.forwardMarkers.length > MARKER_MAX_PER_SERIES) {
      problems.push(
        `${where} "forwardMarkers" declares ${block.forwardMarkers.length} markers, and one series may declare ` +
          `${MARKER_MAX_PER_SERIES}. A list long enough to match every note is not an agenda rule, it is ` +
          `"ask about everything".`
      );
    }
    block.forwardMarkers.forEach((marker, i) => {
      const markerProblems = forwardMarkerProblems(marker, `${where}.forwardMarkers[${i}]`, seen);
      problems.push(...markerProblems);
      const phrase = marker && typeof marker === "object" ? trimmedString(marker.phrase) : null;
      if (phrase !== null) seen.push(phrase);
    });
  }

  if (Array.isArray(block.forwardMarkers) && block.forwardMarkers.length === 0 && trimmedString(block.note) === null) {
    problems.push(
      `${where} declares no markers and no "note". An empty list has to be a decision somebody wrote down — ` +
        `say why this series needs no markers of its own.`
    );
  }
  // An explicit `null` is the same statement as leaving the key out: JSON writes null for "no value", and a
  // plan that declares markers is not required to explain itself. A key that is present and holds an empty
  // string or a number is a different statement, and it is refused.
  if (block.note !== undefined && block.note !== null && trimmedString(block.note) === null) {
    problems.push(`${where} "note" must be a non-empty string when it is present.`);
  }

  return problems;
}

/**
 * Refuse a malformed declaration, the way the intake refuses one.
 *
 * @param {*} block - The value of `manifest.settlement`.
 * @param {string} [where]
 * @returns {void}
 * @throws {Error} On the first problem, naming it and the file it came from.
 */
function validateSettlementDeclaration(block, where = SETTLEMENT_MANIFEST_KEY) {
  const problems = settlementDeclarationProblems(block, where);
  if (problems.length > 0) {
    throw new Error(
      `${SETTLEMENT_MANIFEST_KEY} in the plan of record is malformed:\n  - ${problems.join("\n  - ")}\n` +
        `A declared marker list decides what the terminology settlement is allowed to spend a reading ` +
        `call on, so it is checked before any volume is processed.`
    );
  }
}

/**
 * Read this series' declaration out of its plan of record.
 *
 * Never throws. A missing plan, a missing block, an empty block and a malformed block are four answers,
 * and the caller has to be able to tell them apart — that distinction is the whole reason this file
 * exists. A malformed block is reported rather than re-refused here: `intake/validate.js` is the door
 * that refuses a bad plan, and it runs before any stage.
 *
 * @param {string} seriesDir - Absolute series folder.
 * @returns {{state: string, markers: Array<{phrase: string, because: string|null}>, note: string|null, file: string, problems: string[]}}
 *   `state` is one of {@link DECLARATION_STATES}. `markers` is empty unless the state is `declared`.
 */
function readSettlementDeclaration(seriesDir) {
  const file = path.join(String(seriesDir), PLAN_OF_RECORD_FILE_NAME);
  /** @type {{state: string, markers: Array<{phrase: string, because: string|null}>, note: string|null, file: string, problems: string[]}} */
  const out = { state: "absent", markers: [], note: null, file, problems: [] };

  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    // No plan of record at all. The settlement pass reads a record, not a plan, so this is `absent` and
    // the agenda's own coverage line says what that means.
    return out;
  }

  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    out.state = "malformed";
    out.problems = [`${file} is not readable JSON, so its ${SETTLEMENT_MANIFEST_KEY} block cannot be read.`];
    return out;
  }

  const block = manifest && typeof manifest === "object" ? manifest[SETTLEMENT_MANIFEST_KEY] : undefined;
  if (block === undefined || block === null) return out;

  const problems = settlementDeclarationProblems(block);
  if (problems.length > 0) {
    out.state = "malformed";
    out.problems = problems;
    return out;
  }

  const markers = block.forwardMarkers.map((marker) => ({
    phrase: String(marker.phrase).trim(),
    because: trimmedString(marker.because),
  }));
  if (markers.length === 0) {
    out.state = "empty";
    out.note = trimmedString(block.note);
    return out;
  }
  out.state = "declared";
  out.markers = markers;
  out.note = trimmedString(block.note);
  return out;
}

module.exports = {
  PLAN_OF_RECORD_FILE_NAME,
  SETTLEMENT_MANIFEST_KEY,
  DECLARATION_FIELDS,
  MARKER_FIELDS,
  MARKER_REQUIRED_FIELDS,
  MARKER_MIN_CHARS,
  MARKER_MAX_CHARS,
  MARKER_MAX_PER_SERIES,
  DECLARATION_STATES,
  settlementDeclarationProblems,
  validateSettlementDeclaration,
  readSettlementDeclaration,
};
