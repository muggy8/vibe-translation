/**
 * utils/reference-store/written-forms/shapes.js — the pure half of the written-forms layer: which
 * candidate groups the record's own roster calls identity-bearing, and which of the ones it does not
 * are one word spelled two ways.
 *
 * Plan 07 slice 1. A **written form** is one way the series prints a name or a description
 * (`虹彩寺菫`, `三色院菫子`, `好きな女`, `主人公`) together with the reading the author guided it with.
 * It is not a person, and nothing in this file pretends otherwise: plan 07 §5's slice-1 row is the
 * account owner's rule that a written-forms row **transcribes the book's own markup and asserts no
 * person**, and the identity claim belongs to the identity table, which this layer does not touch.
 *
 * ## The two questions this file answers, and the one it refuses
 *
 *   1. **Which candidate groups does this record's roster select?** (`identityBearingGroups`) — plan
 *      07 §2.9's rule, measured over the 17 real volumes and a copy of volume 17's record at **18 of
 *      the 97 groups, 134 harvest rows, 1,402 occurrences**, with **zero false positives** on the
 *      homophone noise. The rule is: *one of the group's written forms is a roster entry, **or the
 *      guided reading itself is***. The half that used to be attached to it — "…and at least one other
 *      form is NOT" — is **not in this function and must not be added**: §2.9 measured that it throws
 *      away さんしよくいんすみれこ (三色院菫子 x289 / 三色院董子 x1) and つきみ (月見 / 草見月), which are links
 *      between two roster names, i.e. exactly the shape plan 06 §2.11 was built to look for and found
 *      almost none of. Dropping those two is the mistake that measurement made, reappearing in a new
 *      rule, and `test/test-written-forms.js` pins both cases.
 *
 *   2. **Which of the groups the roster cannot see are one word spelled two ways?**
 *      (`classifyUnselectedGroups`) — the account owner's answer to "what happens to the 79 groups no
 *      rule selects?" was *"note the same-word-different-spelling ones the way English notes color /
 *      colour"*, and plan 07 §2.10 turned that into one deterministic, script-neutral computation:
 *      **how much of the shorter written form survives inside the longer one**, taken over the closest
 *      pair in the group. Measured over the 79 real groups with 0 model calls, the ratio floor
 *      `SPELLING_VARIANT_MIN_RATIO` splits them **25 / 54** — 25 that are one word spelled two ways
 *      (偽物 / 偽者, 我侭 / 我儘, 太股 / 太腿, 貴方 / 貴女, 振動 / 震動, 凛々 / 凜々) and 54 that are different
 *      words that happen to sound alike (美味 / 上手 / 旨, 披露 / 疲労, 串 / 駆使, 傾 / 菓子). Both numbers
 *      are reproduced by `test/measure-written-forms.js` and the split is pinned on planted fixtures by
 *      `test/test-written-forms.js`.
 *
 *   3. **What this file refuses to decide.** It classifies **spelling shape only**. It has no category
 *      for a pronoun, a description, or a name, and no list of what counts as one — the owner's answer
 *      on the pronoun groups (おれ, あなた, あなたたち, あなたさま, わたし, モブ) is *"record the words, no
 *      character"*, and that answer is honoured by the **filing** (the words are filed, no person is
 *      claimed), not by a label here. A classifier that could name a first-person pronoun would need a
 *      pronoun list, and this repository carries no such list in any language by the owner's own rule.
 *
 * ## Why the ratio is a subsequence and not a distance
 *
 * "How much of one written form is still there in the other" is a **subsequence** question: 貴方達 and
 * 貴女達 share 貴_達 in order with one character swapped, and 美味 and 上手 share nothing in order even
 * though they mean the same thing. An edit distance would call 美味 / 上手 two edits apart and file a
 * homophone as a typo; a longest common subsequence over the **shorter** form's length says 0 of 2 and
 * leaves it alone. The floor is 0.5 — at least half of the shorter form survives — which is the number
 * plan 07 §4.9 states and §2.10 measures.
 *
 * @module utils/reference-store/written-forms/shapes
 */

require("../../../types"); // JSDoc type definitions
/** @typedef {import("../../source/guide-groups").GuideGroup} GuideGroup */
/** @typedef {import("../../source/guide-groups").GuideGroupForm} GuideGroupForm */

/**
 * How much of the shorter written form has to survive inside the longer one, as a longest-common-
 * subsequence ratio, for a pair to be called **one word spelled two ways**.
 *
 * A constant with no environment knob (AGENTS.md rule 3): a threshold somebody can raise from the
 * shell is a threshold that can be raised until the report says nothing. 0.5 is the value plan 07
 * §4.9 states and §2.10 measures against the 79 real groups, and `test/measure-written-forms.js`
 * re-measures the 25 / 54 split it produces.
 *
 * @type {number}
 */
const SPELLING_VARIANT_MIN_RATIO = 0.5;

/**
 * Length of the longest common subsequence of two strings (characters in order, not necessarily
 * adjacent).
 *
 * Rolling one-row dynamic programming, which is the whole algorithm and is deliberately written here
 * rather than pulled from a package: the strings are written forms of two to six characters, and a
 * dependency for that is a worse answer than eleven lines.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} Shared characters in order. 0 when either side is empty.
 */
function longestCommonSubsequenceLength(a, b) {
  const x = String(a || "");
  const y = String(b || "");
  if (!x.length || !y.length) return 0;
  /** @type {number[]} */
  let previous = new Array(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    /** @type {number[]} */
    const current = new Array(y.length + 1).fill(0);
    for (let j = 1; j <= y.length; j++) {
      current[j] = x[i - 1] === y[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1]);
    }
    previous = current;
  }
  return previous[y.length];
}

/**
 * The pair of written forms in one group that looks most like the same word spelled two ways, and how
 * much of the shorter one survives inside the longer.
 *
 * "The closest pair in the group" is the plan's wording, and it matters: a group of four forms can
 * contain one genuine spelling pair beside three unrelated homophones, and asking the question of the
 * whole group at once would answer it for the wrong pair. Every unordered pair is tried and the
 * highest ratio wins; ties keep the first pair in the order the group lists its forms (most-used
 * first), so the answer is deterministic rather than dependent on a sort.
 *
 * @param {GuideGroup} group - A group produced by `utils/source/guide-groups.js`.
 * @returns {{a: string, b: string, shared: number, shorter: number, ratio: number, pairs: number}}
 *   `ratio` is 0 when the group has fewer than two forms, which a candidate group never does.
 */
function closestFormPairOf(group) {
  const forms = ((group && group.forms) || [])
    .map((form) => String(form.form || "").replace(/\s+/g, ""))
    .filter(Boolean);
  let best = { a: "", b: "", shared: 0, shorter: 0, ratio: 0, pairs: 0 };
  for (let i = 0; i < forms.length; i++) {
    for (let j = i + 1; j < forms.length; j++) {
      const shared = longestCommonSubsequenceLength(forms[i], forms[j]);
      const shorter = Math.min(forms[i].length, forms[j].length);
      const ratio = shorter === 0 ? 0 : shared / shorter;
      best.pairs += 1;
      if (ratio > best.ratio) best = { a: forms[i], b: forms[j], shared, shorter, ratio, pairs: best.pairs };
    }
  }
  return best;
}

/**
 * Whether one group is **one word spelled two ways** rather than two words that sound alike.
 *
 * @param {GuideGroup} group
 * @returns {boolean} True when at least `SPELLING_VARIANT_MIN_RATIO` of the shorter form of the
 *   closest pair survives inside the longer one.
 */
function isSpellingVariantGroup(group) {
  return closestFormPairOf(group).ratio >= SPELLING_VARIANT_MIN_RATIO;
}

/**
 * One group, reported: the reading, its forms with their counts, and the pair that decided its class.
 *
 * The report shape is the one plan 07 §4.9 asks a dictionary to print — both spellings, both counts,
 * no verdict beyond the class — so a later slice can print it without re-deriving anything.
 *
 * @param {GuideGroup} group
 * @returns {{reading: string, readingScripts: string[], forms: Array<{form: string, count: number, characterCount: number, volumes: string[]}>, formCount: number, rowCount: number, occurrences: number, volumes: string[], closestPair: {a: string, b: string, shared: number, shorter: number, ratio: number}, ratio: number}}
 */
function describeGroupForReport(group) {
  const closest = closestFormPairOf(group);
  return {
    reading: group.reading,
    readingScripts: (group.readingScripts || []).slice(),
    forms: (group.forms || []).map((form) => ({
      form: form.form,
      count: Number(form.count),
      characterCount: Number(form.characterCount),
      volumes: (form.volumes || []).slice(),
    })),
    formCount: Number(group.formCount),
    rowCount: Number(group.rowCount),
    occurrences: Number(group.occurrences),
    volumes: (group.volumes || []).slice(),
    closestPair: { a: closest.a, b: closest.b, shared: closest.shared, shorter: closest.shorter, ratio: closest.ratio },
    ratio: closest.ratio,
  };
}

/**
 * The 25 / 54 report: split a list of groups into the ones that read as one word spelled two ways and
 * the ones that read as different words that sound alike.
 *
 * **A report, not a filing.** Nothing here writes, and nothing here is a finding: plan 07 §2.10's
 * finding is that the 54 are ordinary homophones the author chose to gloss and **not** errors, so a
 * rule that called them defects would be a rule that cries wolf 54 times over 17 legitimate books. The
 * caller hands this function the groups the roster rule did not select; it does not decide which those
 * are.
 *
 * @param {GuideGroup[]} groups - Groups produced by `utils/source/guide-groups.js`.
 * @returns {{spellingVariants: Array<ReturnType<typeof describeGroupForReport>>, soundAlikes: Array<ReturnType<typeof describeGroupForReport>>, totals: {groups: number, spellingVariants: number, soundAlikes: number, variantRows: number, variantOccurrences: number, soundAlikeRows: number, soundAlikeOccurrences: number}}}
 */
function classifyUnselectedGroups(groups) {
  const list = Array.isArray(groups) ? groups : [];
  /** @type {Array<ReturnType<typeof describeGroupForReport>>} */
  const variants = [];
  /** @type {Array<ReturnType<typeof describeGroupForReport>>} */
  const alike = [];
  for (const group of list) {
    if (isSpellingVariantGroup(group)) variants.push(describeGroupForReport(group));
    else alike.push(describeGroupForReport(group));
  }
  const sum = (rows, entries) => entries.reduce((n, entry) => n + entry[rows], 0);
  return {
    spellingVariants: variants,
    soundAlikes: alike,
    totals: {
      groups: list.length,
      spellingVariants: variants.length,
      soundAlikes: alike.length,
      variantRows: sum("rowCount", variants),
      variantOccurrences: sum("occurrences", variants),
      soundAlikeRows: sum("rowCount", alike),
      soundAlikeOccurrences: sum("occurrences", alike),
    },
  };
}

/**
 * The roster, as a set of names.
 *
 * Accepts a `Set`, an array, or a plain object of keys, because the caller is either the store's own
 * `cast` query or a test holding a literal list. A name is matched **exactly**: plan 07 §2.9's three
 * near misses (チエリー / チェリー, サンちやん / サンちゃん, ジヨーロ / ジョーロ) are **not** selected by
 * this rule, and that is the measurement, not an oversight — widening the match is a decision the
 * account owner has already made the other way (gotcha 121 kept the store's name rule narrow on
 * purpose, and plan 07 §6 records the answer as "not widened at all").
 *
 * @param {Set<string>|string[]|Object} rosterKeys
 * @returns {Set<string>}
 */
function asRosterKeySet(rosterKeys) {
  if (rosterKeys instanceof Set) return new Set([...rosterKeys].map((key) => String(key)));
  if (Array.isArray(rosterKeys)) return new Set(rosterKeys.map((key) => String(key)));
  if (rosterKeys && typeof rosterKeys === "object") return new Set(Object.keys(rosterKeys).map((key) => String(key)));
  return new Set();
}

/**
 * Which candidate groups this roster calls **identity-bearing** — plan 07 §2.9's rule, as a pure
 * function so slice 2 can ask the same question against a different roster without re-filing anything.
 *
 * A group is selected when **one of its written forms is a roster entry, or the guided reading itself
 * is**. The second half is not decoration: the glossary recorded the author's nickname as the
 * character's own entry, so the roster already carries ツバキ, パンジー, ビオラ, アイリス and eight more,
 * and ツバキ ← 椿 / 特別な存在 — the group the form test alone misses — is selected only by it. Measured
 * over the 17 real volumes: the form half selects 17 groups, the reading half adds 11, and together
 * they select **18 of 97**.
 *
 * **It never requires a form to be unknown.** A group whose every form is a roster entry is selected —
 * that is さんしよくいんすみれこ and つきみ, and §2.9 measured that dropping them is the mistake plan 06
 * §2.11 made.
 *
 * @param {GuideGroup[]} groups - Candidate groups, as produced by `utils/source/guide-groups.js`.
 * @param {Set<string>|string[]|Object} rosterKeys - The roster to ask. The door passes the `cast` keys
 *   of the record it is filing into, which is the only roster a volume is allowed to ask.
 * @returns {GuideGroup[]} The selected groups, in the order they were given.
 */
function identityBearingGroups(groups, rosterKeys) {
  const roster = asRosterKeySet(rosterKeys);
  const list = Array.isArray(groups) ? groups : [];
  return list.filter(
    (group) => roster.has(group.reading) || (group.forms || []).some((form) => roster.has(form.form))
  );
}

/**
 * The same question, answered both ways: the groups the roster selects, and the ones it does not.
 *
 * The door reports both halves, because plan 07 §2.9's number is only useful next to the number it
 * leaves out (18 selected, 79 left), and the 79 are what `classifyUnselectedGroups` is for.
 *
 * @param {GuideGroup[]} groups
 * @param {Set<string>|string[]|Object} rosterKeys
 * @returns {{identityBearing: GuideGroup[], unselected: GuideGroup[], totals: {groups: number, identityBearing: number, unselected: number, identityBearingRows: number, identityBearingOccurrences: number, unselectedRows: number, unselectedOccurrences: number}}}
 */
function splitGroupsByRoster(groups, rosterKeys) {
  const list = Array.isArray(groups) ? groups : [];
  const identityBearing = identityBearingGroups(list, rosterKeys);
  const chosen = new Set(identityBearing);
  const unselected = list.filter((group) => !chosen.has(group));
  const rowsOf = (gs) => gs.reduce((n, g) => n + Number(g.rowCount || 0), 0);
  const occurrencesOf = (gs) => gs.reduce((n, g) => n + Number(g.occurrences || 0), 0);
  return {
    identityBearing,
    unselected,
    totals: {
      groups: list.length,
      identityBearing: identityBearing.length,
      unselected: unselected.length,
      identityBearingRows: rowsOf(identityBearing),
      identityBearingOccurrences: occurrencesOf(identityBearing),
      unselectedRows: rowsOf(unselected),
      unselectedOccurrences: occurrencesOf(unselected),
    },
  };
}

module.exports = {
  SPELLING_VARIANT_MIN_RATIO,
  longestCommonSubsequenceLength,
  closestFormPairOf,
  isSpellingVariantGroup,
  describeGroupForReport,
  classifyUnselectedGroups,
  asRosterKeySet,
  identityBearingGroups,
  splitGroupsByRoster,
};
