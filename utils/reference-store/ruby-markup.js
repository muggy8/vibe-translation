/**
 * utils/reference-store/ruby-markup.js — the one rule about HTML ruby in the store.
 *
 * WHY THIS EXISTS. The converter strips pronunciation guides out of the text it writes
 * (gotcha 123: `<ruby>蒲<rt>かま</rt>田<rt>た</rt></ruby>` extracts as 蒲田, not 蒲かま田た), and plan 07
 * §3 keeps that guide-free text as the thing every quote, every name match and every evidence check
 * compares against. Plan 07 slice 5 adds the other side: a **model-facing view** of a chapter that puts
 * some of those guides back, marked up in HTML `<ruby>`, because a translator who never sees 三色院菫子
 * guided as パンジー has to invent it.
 *
 * Those two sides only coexist if one module owns the markup:
 *
 *   - **strip** — a quote copied out of an annotated chapter comes back to the guide-free string the
 *     book actually prints, so the evidence rule still verifies it (plan 07 §4.6, first bullet);
 *   - **build** — the view emits one shape, `<ruby>蒲田<rt>かまた</rt></ruby>`, so the cost of a view is
 *     computable before anyone pays for a bigger prompt;
 *   - **recognise** — a parser that is being taught to survive markup needs to know what it is looking
 *     at, and a parser that guesses produces a corrupted claim body with no finding and no count that
 *     moves (plan 07 §4.6, second bullet).
 *
 * THE TAG VOCABULARY IS THE CONVERTER'S, AND IT IS PINNED AGAINST IT. `RUBY_GUIDE_TAGS` in
 * `utils/source/html.js` is the list the two converters use to decide what inside a `<ruby>` is not part of
 * the word, and `test/test-source-ruby.js` pins that both converters agree. The list is restated here
 * rather than imported because `utils/source/html.js` loads `cheerio` at require time, and pulling it behind
 * every evidence query is the same mistake `utils/reference-store/source-chapters.js` names as its reason for
 * not calling `resolveSourceBundle`. The drift risk is closed the other way: `test/test-annotated-view.js`
 * asserts the two sets are equal, so a converter that learns a new guide tag fails a test rather than
 * quietly disagreeing with the store about what a guide is.
 *
 * IT IS A LEAF. It requires nothing but the types, so `utils/reference-store/evidence.js`, the glossary
 * parser and the view door can all reach it without closing a cycle (gotcha 85).
 *
 * @module utils/reference-store/ruby-markup
 */

require("../../types"); // JSDoc type definitions

/**
 * The tags that hold a pronunciation guide inside a `<ruby>` — the guide is not part of the word.
 *
 * **This is `utils/source/html.js`'s `RUBY_GUIDE_TAGS`, restated rather than imported.** The converter
 * module loads `cheerio` at require time, and pulling it behind every evidence query is the mistake
 * `utils/reference-store/source-chapters.js` names as its reason for not calling `resolveSourceBundle`.
 * The drift the restatement risks is closed by a test instead: `test/test-annotated-view.js` asserts the
 * two sets are equal, so a converter that learns a new guide tag fails a test rather than quietly
 * disagreeing with the store about what a guide is.
 *
 * @type {Set<string>}
 */
const RUBY_GUIDE_TAGS = new Set(["rt", "rtc", "rp"]);

/**
 * The `<ruby>` container and its base-side tags.
 *
 * `rb` / `rbc` are the ruby base (the word, in the HTML spec's own markup) and the ruby's own text nodes
 * are the word too; only the guide tags in `RUBY_GUIDE_TAGS` are not. The converter meets these on the way
 * in; the store meets them again on the way out to a model.
 *
 * @type {Set<string>}
 */
const RUBY_BASE_TAGS = new Set(["rb", "rbc"]);

/**
 * One pattern source, used fresh each time: a global regex kept as a module constant carries `lastIndex`
 * between calls, and a `test()` that sometimes misses is the kind of bug this file exists to prevent.
 *
 * **Exported so the converter's copy of it can be pinned against this one.** `utils/source/html.js` restates
 * the same string (neither module may require the other), and `test/test-source-ruby-markup.js` asserts the
 * two are the same string and that the two strips agree on every shape either one can produce.
 *
 * @type {string}
 */
const RUBY_TAG_PATTERN_SOURCE = "<(\\/?)\\s*(ruby|rt|rtc|rp|rb|rbc)\\b[^>]*>";

/**
 * The fixed markup a one-piece annotation costs, ignoring the reading itself:
 * `<ruby>` + `</ruby>` + `<rt>` + `</rt>` = 6 + 7 + 4 + 5.
 *
 * @type {number}
 */
const RUBY_MARKUP_OVERHEAD_CHARS = "<ruby></ruby>".length + "<rt></rt>".length;

/**
 * A fresh matcher for the ruby tags.
 *
 * @returns {RegExp}
 */
function rubyTagMatcher() {
  return new RegExp(RUBY_TAG_PATTERN_SOURCE, "gi");
}

/**
 * Whether a string carries any ruby markup at all.
 *
 * The cheap question a parser asks before it does anything else with a line.
 *
 * @param {string|null|undefined} text
 * @returns {boolean}
 */
function hasRubyMarkup(text) {
  const raw = String(text === undefined || text === null ? "" : text);
  if (!raw.includes("<")) return false;
  return rubyTagMatcher().test(raw);
}

/**
 * How many `<ruby>` units a string carries.
 *
 * Reported beside a view's character cost so a reader can tell "one guide over a long word" from
 * "hundreds of guides over short ones" — the two cost the same per occurrence and mean different things
 * to a translator.
 *
 * @param {string|null|undefined} text
 * @returns {number}
 */
function rubyMarkupUnitCount(text) {
  const raw = String(text === undefined || text === null ? "" : text);
  if (!raw.includes("<")) return 0;
  let count = 0;
  for (const match of raw.matchAll(rubyTagMatcher())) {
    if (String(match[2]).toLowerCase() === "ruby" && match[1] !== "/") count += 1;
  }
  return count;
}

/**
 * The guide-free form of a string: the word, without the reading the author wrote over it.
 *
 * This is the same rule the converter applies on the way in, seen from the other side. Text inside a guide
 * tag (`rt` / `rtc` / `rp`) is the reading and is dropped; text inside the ruby and inside a base tag
 * (`rb` / `rbc`) is the word and is kept; the tags themselves are dropped. Nested ruby is handled by
 * counting depth rather than by matching a whole unit, and an unbalanced tag drops its own markup and
 * keeps whatever text it held — a parser that survives markup is a parser that does not lose a word
 * because a bracket was mismatched.
 *
 * @param {string|null|undefined} text - Text that may carry ruby markup.
 * @returns {string} The same text with every guide and every ruby tag removed.
 */
function stripRubyMarkup(text) {
  const raw = String(text === undefined || text === null ? "" : text);
  if (!raw.includes("<")) return raw;
  let out = "";
  let guideDepth = 0;
  let cursor = 0;
  for (const match of raw.matchAll(rubyTagMatcher())) {
    // Everything between two tags is the word, unless a guide tag is open.
    if (guideDepth === 0) out += raw.slice(cursor, match.index);
    const tag = String(match[2]).toLowerCase();
    const closing = match[1] === "/";
    if (RUBY_GUIDE_TAGS.has(tag)) guideDepth = Math.max(0, guideDepth + (closing ? -1 : 1));
    // `ruby`, `rb` and `rbc` are containers and base text: their tags go, their text stays.
    cursor = match.index + match[0].length;
  }
  if (guideDepth === 0) out += raw.slice(cursor);
  return out;
}

/**
 * The one markup shape this repository emits.
 *
 * One `<ruby>`, one `<rt>`, the whole written form inside: `<ruby>蒲田<rt>かまた</rt></ruby>`. Deliberately
 * one piece, because the store's written-form rows are one row per (form, reading) and carry no
 * per-character sequence — a multi-piece shape would be this module inventing which character of the word
 * carried which reading, which is the question plan 07 §2.7 measured and found the stored rows cannot
 * answer.
 *
 * @param {{form: string, reading: string}} unit - The written form, and the reading the author guided it with.
 * @returns {string} The markup.
 * @throws {Error} When either half is missing: `<ruby><rt>…</rt></ruby>` is markup with no word in it.
 */
function rubyMarkupFor({ form, reading } = {}) {
  const word = String(form === undefined || form === null ? "" : form);
  const guide = String(reading === undefined || reading === null ? "" : reading);
  if (!word || !guide) {
    throw new Error(
      `[reference-store] rubyMarkupFor: an annotation needs both the written form and the reading over it ` +
        `(got form=${JSON.stringify(word)} reading=${JSON.stringify(guide)}).`
    );
  }
  return `<ruby>${word}<rt>${guide}</rt></ruby>`;
}

/**
 * How many characters one annotation adds to a chapter.
 *
 * @param {{form: string, reading: string}} unit
 * @returns {number} `RUBY_MARKUP_OVERHEAD_CHARS` plus the length of the reading.
 */
function rubyMarkupAddedChars({ form, reading } = {}) {
  return RUBY_MARKUP_OVERHEAD_CHARS + String(reading === undefined || reading === null ? "" : reading).length;
}

module.exports = {
  RUBY_BASE_TAGS,
  RUBY_GUIDE_TAGS,
  RUBY_TAG_PATTERN_SOURCE,
  RUBY_MARKUP_OVERHEAD_CHARS,
  hasRubyMarkup,
  rubyMarkupUnitCount,
  stripRubyMarkup,
  rubyMarkupFor,
  rubyMarkupAddedChars,
};
