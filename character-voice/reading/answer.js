/**
 * character-voice/reading/answer.js — the one job: read one chapter's raw answer into claims, and say
 * whether the claim array ever reached its closing bracket.
 *
 * The mirror of `glossary/extract/answer.js` (which reads one term list), and the place the two reading
 * passes genuinely differ: `parseTerms` is all-or-nothing, while this one reads the array object by object
 * and can rescue the claims a single malformed claim would have taken down with it. That rescue is what
 * makes "kept but cut off" a possible outcome at all, and it is why `scanTopLevelObjects`'s `closed` means
 * **the claim array closed**, not the envelope closed — the two are different questions and the delivery
 * layer routes the two answers differently (MINOR vs MAJOR, AGENTS.md gotcha 149).
 *
 * Part of the character-voice/reading.js layer.
 *
 * @module character-voice/reading/answer
 */

require("../../types"); // JSDoc type definitions

const { parseVoiceQuirks } = require("../stages");

/**
 * Scan an answer for its top-level claim objects, string-aware.
 *
 * Why this exists and not just a second `JSON.parse`: the extraction model's answers are arrays of
 * objects, and a claim with a syntax error — a missing comma between two properties, measured on the
 * real volume 02 chapter ch2 — leaves every **other** object in that array perfectly balanced and
 * perfectly parseable. Dropping the whole chapter because one claim was malformed loses twenty claims
 * to fix one. This finds the objects; it does not repair any of them.
 *
 * It is also how a cut-off answer is detected: `closed` is false when the claim array never reached its
 * `]`, and that is a different failure from a malformed claim — the answer is missing whatever the
 * model had not written yet.
 *
 * **It reads the envelope the same way it reads a bare array, and that is not an accident.** Since
 * 2026-10-13 the request asks for `{"entries": […]}`, so a half answer is now a **half envelope**:
 * `{"entries": [{…},{…}` with no closing bracket anywhere. The scan starts at the first `[`, which in an
 * envelope is the claim array's own bracket — the envelope's opening `{` sits before it and is never
 * counted as a claim — and every `{…}` that balances at depth 0 after that point is one claim. So the
 * rescue does what it was built to do on the new shape: the claims that did arrive are kept, and the
 * chapter is re-read for the ones that did not. `closed` means **the claim array closed**, not the
 * envelope closed, and that is the right question: `{"entries": […]` with the outer brace missing has
 * lost no claim, and calling it cut off would spend a paid read and print an INCOMPLETE row for a
 * chapter that is whole. A truncated envelope is pinned by `test/test-answer-envelopes.js`.
 *
 * @param {string} text
 * @returns {{objects: string[], closed: boolean}} The balanced top-level objects, and whether the claim array closed.
 */
function scanTopLevelObjects(text) {
  const body = String(text || "");
  const start = body.indexOf("[");
  if (start === -1) return { objects: [], closed: false };

  const objects = [];
  let depth = 0;
  let begin = -1;
  let inString = false;
  let escaped = false;
  let closed = false;

  for (let i = start + 1; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") {
      if (depth === 0) begin = i;
      depth += 1;
      continue;
    }
    if (ch === "}") {
      if (depth > 0) depth -= 1;
      if (depth === 0 && begin !== -1) {
        objects.push(body.slice(begin, i + 1));
        begin = -1;
      }
      continue;
    }
    if (ch === "]" && depth === 0) { closed = true; break; }
  }

  return { objects, closed };
}

/**
 * Read one chapter's answer as extraction entries.
 *
 * The strict parse is tried first, and a well-formed answer takes it and nothing else. When it
 * fails, the answer is read object by object: each object that parses on its own is kept, each one
 * that does not is dropped **and named with its raw text kept in the partial**, so a lost claim is
 * evidence somebody can read rather than a hole in a file. Nothing is invented and nothing is
 * repaired — the evidence rule still has to find every recovered claim's quote in this volume's text,
 * exactly like a claim that arrived in one piece.
 *
 * @param {string} output - The raw answer.
 * @returns {{entries: Array<Object>, recovered: boolean, lost: Array<{because: string, raw: string}>, cutOff: boolean, error: string|null}}
 */
function parseExtractionAnswer(output) {
  try {
    return { entries: parseVoiceQuirks(output), recovered: false, lost: [], cutOff: false, error: null };
  } catch (err) {
    const { objects, closed } = scanTopLevelObjects(output);
    /** @type {Array<Object>} */
    const entries = [];
    /** @type {Array<{because: string, raw: string}>} */
    const lost = [];
    for (const raw of objects) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && typeof parsed.type === "string") entries.push(parsed);
        else lost.push({ because: "the claim carries no `type`, so it is not a claim", raw: raw.slice(0, 500) });
      } catch (inner) {
        lost.push({ because: inner.message, raw: raw.slice(0, 500) });
      }
    }
    return { entries, recovered: true, lost, cutOff: !closed, error: err.message };
  }
}

module.exports = {
  scanTopLevelObjects,
  parseExtractionAnswer,
};
