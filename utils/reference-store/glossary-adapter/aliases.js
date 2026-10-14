/**
 * utils/reference-store/glossary-adapter/aliases.js — the first-person pronouns the glossary
 * declares, and who they belong to.
 *
 * The glossary's Characters rows are the only place in the pipeline where the answer to *whose "I"
 * is this book narrated by?* is written down, and this is the code that reads that sentence and
 * files it as an alias declaration. The rule is the narrowest thing that fires on that row and
 * nothing else, and a pronoun two different Characters rows both declare is reported as ambiguous
 * rather than settled by whichever row the table reaches first. See gotcha 117.
 *
 * @module utils/reference-store/glossary-adapter/aliases
 */

const { isBareFirstPersonPronoun } = require("../name-resolution");
const { GLOSSARY_CHARACTER_SECTION } = require("./labels");
const { glossaryTermSpans } = require("./parse");
require("../../../types"); // JSDoc type definitions

/**
 * The first-person forms a glossary's Characters rows declare as belonging to a character.
 *
 * The glossary already answers the question the reference record cannot answer by itself — *whose "I" is
 * this book narrated by?* Volume 1's Characters row for 如月雨露 says so in as many words:
 *
 * > Protagonist; … Narrator: switches between 僕 and 俺 (see 僕／俺)
 *
 * That sentence is the only place in the pipeline where the answer is written, and until now nothing read
 * it. The consequence was measured on the real volumes: the extraction wrote `俺（ジョーロ）` for the
 * protagonist, the store had no declaration linking 俺 to anybody, and it made a roster entry out of the
 * pronoun — 282 claims under `俺` in volume 2 against 190 under 如月雨露 (gotcha 115).
 *
 * The rule is deliberately the narrowest thing that fires on this row and nothing else: **a row under the
 * Characters section whose notes contain a bare first-person pronoun as a whole token declares that
 * pronoun as an alias of the character the row is about.** Not a nickname section, not a substring, not a
 * prose pattern about narrators.
 *
 * Measured against all 17 real glossaries before it was pinned: **17 hits, one per volume, all of them the
 * same row** (如月雨露, the same sentence, pronouns 僕 and 俺). Zero hits on any other character row, zero
 * rows naming more than one character, zero false positives. The 671 rows under the glossary's "Character
 * Nicknames" heading were measured as a candidate too and **rejected**: 330 of them name exactly one
 * Characters row, 73 name two, and 268 name none — and the ones that name one are mostly joke aliases
 * ("Joro's mock-heroic epithets for Pansy"), where the notes name the person by *their* nickname rather
 * than by their roster name. A declaration rule that guesses the owner is a rule that files claims under
 * the wrong person, which is the one mistake this layer cannot undo.
 *
 * A pronoun two different Characters rows both declare is refused rather than split: that is the glossary
 * saying two people narrate in the first person, and the record has to say so out loud instead of picking
 * whichever row the table reaches first.
 *
 * @param {{rows: Array<{term: string, rendering: string, notes: string, section: string}>}} parsed - A parsed glossary.
 * @returns {{declarations: Array<{key: string, alias: string, reason: string}>, ambiguous: Array<{alias: string, keys: string[]}>}}
 *   `declarations` is what to hand `castAlias`; `ambiguous` is what to report and not apply.
 */
function firstPersonAliasDeclarations(parsed) {
  const characterRows = (parsed.rows || []).filter(
    (row) => (row.section || "").trim().toLowerCase() === GLOSSARY_CHARACTER_SECTION.toLowerCase()
  );

  /** @type {Map<string, string[]>} alias -> the Characters rows that declared it */
  const declaredBy = new Map();
  const declarations = [];

  for (const row of characterRows) {
    const spans = glossaryTermSpans(row.term);
    const key = spans[0] || String(row.term || "").trim();
    if (!key) continue;
    for (const pronoun of barePronounTokensIn(row.notes)) {
      if (pronoun === key) continue;
      if (!declaredBy.has(pronoun)) declaredBy.set(pronoun, []);
      declaredBy.get(pronoun).push(key);
      declarations.push({
        key,
        alias: pronoun,
        reason: `the glossary's ${GLOSSARY_CHARACTER_SECTION} row for ${key} names ${pronoun}: ${String(row.notes || "").trim()}`,
      });
    }
  }

  const ambiguous = [];
  for (const [alias, keys] of declaredBy) {
    const distinct = [...new Set(keys)];
    if (distinct.length > 1) ambiguous.push({ alias, keys: distinct });
  }
  const ambiguousAliases = new Set(ambiguous.map((item) => item.alias));
  return {
    declarations: declarations.filter((entry) => !ambiguousAliases.has(entry.alias)),
    ambiguous,
  };
}

/**
 * The words for "I" that appear in a notes cell as whole tokens.
 *
 * Token boundaries matter here: 俺様 and うちの子 are not the word for "I" on its own, and the closed list
 * in `name-resolution.js` is only ever about that word. Splitting the cell on whitespace and on the
 * brackets and separators the glossary uses is what keeps `僕／俺` reading as two pronouns and `俺様`
 * reading as neither.
 *
 * @param {string} notes - One glossary row's notes cell.
 * @returns {string[]} the bare pronouns, in the order they appear, without repeats
 */
function barePronounTokensIn(notes) {
  const tokens = String(notes || "")
    .split(/[\s,;、・／/|「」『』（）()【】→\-–—]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const token of tokens) {
    if (!isBareFirstPersonPronoun(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

module.exports = {
  barePronounTokensIn,
  firstPersonAliasDeclarations,
};
