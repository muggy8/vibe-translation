/**
 * utils/reference-store/identity/shapes.js — the pinned grammar for "this prose STATES a link".
 *
 * The glossary's Characters rows are model-written prose, and they are the source that states most of
 * the links in this corpus (56 pairs, 88 of the 196 roster entries). Prose is where a rule can look
 * exactly as narrow as the rules that work and be wrong every time, so this table is not a heuristic
 * list — it is the eight shapes that were **measured against all 2,017 real character rows** before any
 * of them was trusted, with the one that failed kept in the same table, marked excluded, so the failure
 * stays re-measurable instead of being deleted out of history.
 *
 * The measurement (plan 06 §2.11, `/tmp/opencode/roster-shape-audit.js`, 0 model calls):
 *
 * | shape | row-hits | distinct pairs |
 * |---|---|---|
 * | `nickname for <K>` | 325 | 32 |
 * | `nicknamed <K>` | 31 | 4 |
 * | `nickname <K>` | 232 | 20 |
 * | `full name of <K>` | 45 | 7 |
 * | `previously listed as <K>` | 59 | 7 |
 * | `name used to address <K>` | 3 | 1 |
 * | `reveals themself as <K>` | 4 | 1 |
 * | `<K>'s nickname` | **49** | **5 — and all 5 wrong** |
 *
 * The eighth is excluded because the possessive names the character who **coined** the nickname, not the
 * character it describes: "アネモネ's nickname for 芝" produced しばにゃん ↔ アネモネ. That is gotcha 117's
 * rule from the other side — a rule that reads a naming sentence can be 100% wrong while looking exactly
 * as tight as the ones that work.
 *
 * **Order is part of the table.** For one (row, other-name) pair the shapes are tried in list order and
 * the first match decides, exactly as the measurement ran them; a row that matches both `nickname for
 * <K>` and `<K>'s nickname` is accepted by the first and never reaches the excluded one. Changing the
 * order changes which pairs come out, so the order is pinned in `test/test-identity-table.js`. The
 * shipped order moves the excluded shape to the end (the measurement script had it sixth), and the
 * shipped order was then **re-measured against the real corpus** — `/tmp/opencode/identity-shape-audit.js`,
 * 0 model calls — and gives the same eight numbers the plan's table reports (325/32, 31/4, 232/20, 45/7,
 * 59/7, 3/1, 4/1, 49/5) and the same 56 accepted pairs over the same 88 roster entries. So the reorder
 * is provably inert on this corpus, and it is the order the test pins.
 *
 * **What no shape here decides: which name is the person.** Every accepted shape says *these two names
 * are one character*. None says which entry survives, and this module does not invent an answer — the
 * link goes into an identity, which is a group, not a survivor. That is why the shape that would have
 * needed the answer (`<K>'s nickname`) is the one that failed: it was the only shape whose wording
 * implied a direction, and the direction it implied was wrong every time it fired.
 *
 * @module utils/reference-store/identity/shapes
 */

require("../../../types"); // JSDoc type definitions

/**
 * The separators a notes cell is split on to find whole **name tokens**.
 *
 * Token boundaries are the guard: 女 must not match 一人の女子生徒, and 俺様 must not read as the bare
 * pronoun. Splitting on whitespace plus the brackets and punctuation the glossary actually uses is what
 * makes "names another roster key" mean *as a whole token*, which is the same rule
 * `glossary-adapter/aliases.js` uses for the pronoun declarations.
 *
 * @type {RegExp}
 */
const PROSE_TOKEN_SPLIT = /[\s,;、・／/|「」『』（）()【】→\-–—:.!?¡¿«»"']+/;

/**
 * Escape a roster key for use inside a regular expression.
 *
 * Roster keys are Japanese names, and one of them (ミスターＴ) carries a character a pattern would
 * otherwise read as a quantifier.
 *
 * @param {string} key
 * @returns {string}
 */
function escapeKeyForPattern(key) {
  return String(key).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The eight measured shapes, in the order the measurement tried them.
 *
 * `accepted: false` is not "not implemented" — the shape is matched, it just files nothing, and the
 * count of its hits is reported so the exclusion stays a fact a reader can re-check rather than a claim.
 *
 * @type {Array<{name: string, accepted: boolean, build: (escapedKey: string) => RegExp, because: string}>}
 */
const IDENTITY_PROSE_SHAPES = Object.freeze([
  {
    name: "nickname for <K>",
    accepted: true,
    build: (esc) => new RegExp(`nickname(?: used by [^.]{0,80}?)? for ${esc}`, "i"),
    because: "the row says this term is a nickname FOR the other name",
  },
  {
    name: "nicknamed <K>",
    accepted: true,
    build: (esc) => new RegExp(`nicknamed ${esc}`, "i"),
    because: "the row says the character this row is about is nicknamed the other name",
  },
  {
    name: "nickname <K>",
    accepted: true,
    build: (esc) => new RegExp(`nickname ${esc}`, "i"),
    because: "the row names the other name as a nickname of the character it is about",
  },
  {
    name: "full name of <K>",
    accepted: true,
    build: (esc) => new RegExp(`full[- ]name(?: form)?(?: of the [^.]{0,60}?)? of ${esc}`, "i"),
    because: "the row says this term is the full name of the other name",
  },
  {
    name: "previously listed as <K>",
    accepted: true,
    build: (esc) => new RegExp(`previously (?:listed|referenced|named)(?: only)? as ${esc}`, "i"),
    because: "the row says this character was already in the reference under the other name",
  },
  {
    name: "name used to address <K>",
    accepted: true,
    build: (esc) => new RegExp(`name (?:or alias )?used (?:by [^.]{0,40} )?to address ${esc}`, "i"),
    because: "the row says this term is what other characters call the other name",
  },
  {
    name: "reveals themself as <K>",
    accepted: true,
    build: (esc) => new RegExp(`reveals (?:her|him|them)self as ${esc}`, "i"),
    because: "the row says the character this row is about turns out to be the other name",
  },
  {
    name: "<K>'s nickname",
    accepted: false,
    build: (esc) => new RegExp(`${esc}'s (?:primary |alternate |other )?nickname`, "i"),
    because:
      "EXCLUDED — measured at 49 row-hits and 5 distinct pairs, and all 5 pairs are wrong: the possessive " +
      "names the character who COINED the nickname, not the character it describes (\"アネモネ's nickname " +
      "for 芝\" produced しばにゃん ↔ アネモネ). Kept in this table so the rejection is visible and " +
      "re-measurable, and pinned as excluded by test/test-identity-table.js.",
  },
]);

/**
 * The names in a notes cell that are whole tokens of the roster.
 *
 * @param {string} notes - One row's notes cell.
 * @param {Set<string>} castKeys - The roster this record holds.
 * @param {string} ownTerm - The row's own term, which is never "another name".
 * @returns {string[]} the other roster keys the cell names, in the order they appear
 */
function proseRosterTokens(notes, castKeys, ownTerm) {
  const out = [];
  for (const token of String(notes || "").split(PROSE_TOKEN_SPLIT)) {
    const name = token.trim();
    if (!name || name === ownTerm) continue;
    if (!castKeys.has(name)) continue;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * Which links one prose row STATES, and which excluded shape it would have matched.
 *
 * One answer per (row, other-name) pair, decided by the first shape that matches in table order. A pair
 * whose first match is an excluded shape is returned in `excluded`, with the shape's own reason, so the
 * caller can report "this row looks like a link and this is why it is not one" instead of quietly
 * dropping it.
 *
 * @param {Object} row - `{term, notes}` — one glossary Characters row.
 * @param {Set<string>} castKeys - The roster this record holds.
 * @returns {{stated: Array<{otherKey: string, shape: string, because: string}>, excluded: Array<{otherKey: string, shape: string, because: string}>}}
 */
function statedLinksInProse(row, castKeys) {
  const term = String((row && row.term) || "").trim();
  const notes = String((row && row.notes) || "");
  const stated = [];
  const excluded = [];
  for (const otherKey of proseRosterTokens(notes, castKeys, term)) {
    const esc = escapeKeyForPattern(otherKey);
    for (const shape of IDENTITY_PROSE_SHAPES) {
      if (!shape.build(esc).test(notes)) continue;
      const entry = { otherKey, shape: shape.name, because: shape.because };
      if (shape.accepted) stated.push(entry);
      else excluded.push(entry);
      break;
    }
  }
  return { stated, excluded };
}

module.exports = {
  PROSE_TOKEN_SPLIT,
  IDENTITY_PROSE_SHAPES,
  escapeKeyForPattern,
  proseRosterTokens,
  statedLinksInProse,
};
