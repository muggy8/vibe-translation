/**
 * utils/reference-store/written-forms/view/render.js — puts the author's own guide back over a chapter.
 *
 * Plan 07 slice 5, the last step of "normalise, teach, then show". It takes guide-free chapter text and the
 * forms `select.js` approved, and wraps each printed occurrence of each approved form in the one markup shape
 * `utils/reference-store/ruby-markup.js` owns: `<ruby>蒲田<rt>かまた</rt></ruby>`.
 *
 * ## The scan, and why it is a longest-match scan
 *
 * One left-to-right pass over the **input**, never over the output it is building. At each position it asks
 * "does an approved written form start here?" trying the longest form first, and when one matches it emits the
 * markup and steps past the whole form. Three things fall out of that shape:
 *
 *   - **A form inside an annotated form is never annotated twice.** 三色院菫子 is one approved form and 菫子 is
 *     another; a naive per-form replace pass would wrap 菫子 inside the markup it just wrote for 三色院菫子 and
 *     produce `<ruby>三色院<ruby>菫子<rt>…</rt></ruby><rt>…</rt></ruby>` — markup whose readings are no longer
 *     inside their own guide tag, which `stripRubyMarkup` would then read as one long reading and throw away.
 *     Stepping past the whole match makes that shape unreachable, and the test plants exactly that pair.
 *   - **The emitted markup is never re-read.** The scan only ever looks at the caller's text, so a reading
 *     that happens to spell an approved form cannot be annotated again.
 *   - **The longest form wins at a position**, which is what a reader expects: the guide goes over the whole
 *     name the book printed, not over the shortest approved spelling that happens to sit inside it.
 *
 * ## The invariant this file exists to hold
 *
 * `stripRubyMarkup(annotateChapterText(text, forms).text) === text`, for guide-free input. That single line is
 * what lets plan 07 §4.6 work: a quote a model copies out of an annotated chapter comes back to the string the
 * book actually prints, so every evidence rule in `utils/reference-store/evidence.js` still verifies it. The
 * invariant is why the door **refuses text that already carries ruby markup** rather than annotating it — a
 * second layer of markup over a first is the one input for which the invariant is false, and a door that
 * produced it would hand the evidence layer a quote it could not check.
 *
 * ## What it refuses
 *
 * Text that is not text, text already carrying ruby markup, and a form list that is not a list. A **single
 * bad form** is skipped and named rather than refused whole: one malformed row in a record must not make a
 * chapter unannotatable, and the skip is reported with its reason.
 *
 * It writes nothing, files nothing, reaches no model, and adds no finding kind, level, table, column, setting
 * or command. **No stage calls it** — `test/test-annotated-view.js` walks the tree and pins the count at zero.
 *
 * @module utils/reference-store/written-forms/view/render
 */

const { refusal } = require("../../refusals");
const {
  hasRubyMarkup,
  rubyMarkupFor,
  rubyMarkupAddedChars,
  rubyMarkupUnitCount,
} = require("../../ruby-markup");
require("../../../../types"); // JSDoc type definitions

/**
 * Annotate one piece of guide-free text with the written forms a selection approved.
 *
 * @param {string} text - The chapter's own extracted text, guide-free (what `utils/source/extract.js` writes).
 * @param {Object} [opts]
 * @param {Array<{form: string, reading: string}>} [opts.forms] - The approved pairs, from
 *   `annotatedFormsForVolume`. Order does not matter: the scan tries the longest form at each position.
 * @param {string} [opts.label] - A name for the piece, used only in the report it returns.
 * @returns {{ok: boolean, label: string, text: string, annotated: Array<{form: string, reading: string, count: number, addedChars: number}>, skipped: Array<{form: string, reading: string, rule: string, because: string}>, notInThisText: string[], totals: Object, refusal: ReferenceRefusal|null}}
 */
function annotateChapterText(text, { forms = [], label = "chapter" } = {}) {
  const raw = typeof text === "string" ? text : null;
  if (raw === null) {
    return {
      ok: false,
      label: String(label),
      text: typeof text === "string" ? text : "",
      annotated: [],
      skipped: [],
      notInThisText: [],
      totals: null,
      refusal: refusal({
        verb: "annotated_view",
        rule: "annotated-view-needs-the-text",
        because:
          "an annotated view is a view of a chapter, and there is no chapter here to annotate " +
          `(got ${typeof text}).`,
        fix: 'annotateChapterText(chapterText, { forms }) — pass the text, not a path or a record.',
      }),
    };
  }
  if (hasRubyMarkup(raw)) {
    return {
      ok: false,
      label: String(label),
      text: raw,
      annotated: [],
      skipped: [],
      notInThisText: [],
      totals: null,
      refusal: refusal({
        verb: "annotated_view",
        rule: "annotated-view-text-already-annotated",
        because:
          `this text already carries ruby markup (${rubyMarkupUnitCount(raw)} ruby unit(s)), and annotating an ` +
          "already-annotated text is the one input where stripping the markup no longer returns the text it was " +
          "given. That invariant is what lets a quote copied out of a view still verify against the book.",
        fix: "annotate the guide-free text the converter writes; strip any markup it already carries first.",
        detail: { rubyUnits: rubyMarkupUnitCount(raw) },
      }),
    };
  }
  if (!Array.isArray(forms)) {
    return {
      ok: false,
      label: String(label),
      text: raw,
      annotated: [],
      skipped: [],
      notInThisText: [],
      totals: null,
      refusal: refusal({
        verb: "annotated_view",
        rule: "annotated-view-needs-the-form-list",
        because: `the approved written forms came in as ${typeof forms}, not a list of {form, reading} pairs.`,
        fix: "annotateChapterText(text, { forms: annotatedFormsForVolume(store).forms })",
      }),
    };
  }

  /** @type {Map<string, string>} The approved form → its guided reading. */
  const lookup = new Map();
  /** @type {Array<{form: string, reading: string, rule: string, because: string}>} */
  const skipped = [];
  for (const entry of forms) {
    const form = String(entry && entry.form !== undefined && entry.form !== null ? entry.form : "");
    const reading = String(entry && entry.reading !== undefined && entry.reading !== null ? entry.reading : "");
    if (!form || !reading) {
      skipped.push({
        form,
        reading,
        rule: "annotated-view-form-is-incomplete",
        because: `an annotation needs both the word and the reading over it (got form=${JSON.stringify(form)} reading=${JSON.stringify(reading)}).`,
      });
      continue;
    }
    // Markup characters inside either half would build markup whose text is no longer where the tags say it
    // is, and `stripRubyMarkup` would drop whatever ended up inside a guide tag.
    if (form.includes("<") || form.includes(">") || reading.includes("<") || reading.includes(">")) {
      skipped.push({
        form,
        reading,
        rule: "annotated-view-form-carries-markup",
        because: `the pair ${JSON.stringify(form)} → ${JSON.stringify(reading)} carries a markup character in the word or the reading, so wrapping it would produce markup the strip rule cannot undo.`,
      });
      continue;
    }
    lookup.set(form, reading);
  }

  /** @type {Array<number>} Distinct form lengths, longest first: the only widths worth trying. */
  const widths = [...new Set([...lookup.keys()].map((form) => form.length))].sort((a, b) => b - a);
  /** @type {Map<string, {form: string, reading: string, count: number, addedChars: number}>} */
  const hits = new Map();

  let out = "";
  let cursor = 0;
  while (cursor < raw.length) {
    let matchedForm = null;
    for (const width of widths) {
      if (cursor + width > raw.length) continue;
      const slice = raw.slice(cursor, cursor + width);
      if (lookup.has(slice)) {
        matchedForm = slice;
        break;
      }
    }
    if (matchedForm === null) {
      // One character at a time: nothing to match here, so copy it and move on.
      out += raw[cursor];
      cursor += 1;
      continue;
    }
    const reading = lookup.get(matchedForm);
    out += rubyMarkupFor({ form: matchedForm, reading });
    if (!hits.has(matchedForm)) {
      hits.set(matchedForm, { form: matchedForm, reading, count: 0, addedChars: 0 });
    }
    const hit = hits.get(matchedForm);
    hit.count += 1;
    hit.addedChars += rubyMarkupAddedChars({ form: matchedForm, reading });
    // Step past the WHOLE form: a shorter approved form inside it is inside the markup now, and a second
    // pass over the output is the shape that produces nested ruby with its readings outside their tags.
    cursor += matchedForm.length;
  }

  const annotated = [...hits.values()].sort((a, b) => (a.form < b.form ? -1 : a.form > b.form ? 1 : 0));
  const notInThisText = [...lookup.keys()]
    .filter((form) => !hits.has(form))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const addedChars = annotated.reduce((sum, hit) => sum + hit.addedChars, 0);
  const annotatedOccurrences = annotated.reduce((sum, hit) => sum + hit.count, 0);

  return {
    ok: true,
    label: String(label),
    text: out,
    annotated,
    skipped,
    notInThisText,
    totals: {
      sourceChars: raw.length,
      annotatedChars: out.length,
      addedChars,
      addedPercent: raw.length === 0 ? 0 : Number(((addedChars / raw.length) * 100).toFixed(2)),
      annotatedForms: annotated.length,
      annotatedOccurrences,
      markupUnits: rubyMarkupUnitCount(out),
      formsApproved: lookup.size,
      formsSkipped: skipped.length,
      formsNotInThisText: notInThisText.length,
    },
    refusal: null,
  };
}

module.exports = { annotateChapterText };
