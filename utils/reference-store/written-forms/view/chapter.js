/**
 * utils/reference-store/written-forms/view/chapter.js — the one door a caller would use.
 *
 * Plan 07 slice 5's two halves bolted together: ask this volume's record which written forms may be shown
 * with the author's own guide over them (`select.js`), then put that guide over the chapter (`render.js`).
 *
 * It is a **view**, in the plan's own sense (§4.5): reading aids stay out of the stored text, and the guide
 * reaches the model as markup in a prompt. Nothing it returns is ever filed, published, or written to a
 * volume folder, and the text it returns is not the text any evidence rule compares against — the guide-free
 * chapter is, and `stripRubyMarkup` gets you from one to the other.
 *
 * ## Why the caller supplies the text
 *
 * The selection rule ("guided exactly as often as this volume prints it") and the annotator both need the
 * volume's own extracted text, and this layer does not read a book. `utils/reference-store/source-chapters.js`
 * is the door that reads chapter files, and `written-forms/file.js` is the only door in this store that reads a
 * harvest; a third door that opened volume folders on its own is the shape gotcha 119 and gotcha 124 exist to
 * keep out. So the caller hands the text over, and the door says so when it is missing.
 *
 * ## What it never does
 *
 * No model call, no row, no file, no finding, no level, no table, no column, no setting, no command, no freeze
 * door, no declared artifact. **No stage calls it** — `test/test-annotated-view.js` walks the tree and pins the
 * count at zero, and `test/test-written-forms.js` keeps pinning `written_forms` to have no reader outside its
 * own layer.
 *
 * @module utils/reference-store/written-forms/view/chapter
 */

const { refusal } = require("../../refusals");
const { annotatedFormsForVolume } = require("./select");
const { annotateChapterText } = require("./render");
require("../../../../types"); // JSDoc type definitions

/**
 * Build the annotated view of one chapter, from one volume's record.
 *
 * @param {{db: Object, volume: number}} store - The record whose `written_forms` rows are asked about. It must
 *   be this volume's own record or a later one: a record cannot describe a book it has not read (plan 07 §4.4).
 * @param {Object} opts
 * @param {number} opts.volume - The volume whose forms are used.
 * @param {string} opts.chapterText - **Required.** That chapter's guide-free extracted text.
 * @param {string|Array<string>} [opts.volumeText] - **Required.** The whole volume's guide-free text, or its
 *   chapters as an array. "Guided every single time" is a claim about a whole book, so the selection is always
 *   made against the volume, never against the one chapter being shown.
 * @param {Array<string|{volume: number, form: string}>} [opts.renameForms] - The pairs the **caller**
 *   classifies as renames, which lift the per-volume use bound. This door holds no rule about what a rename is.
 * @param {string} [opts.label] - Name of the piece, for the report.
 * @returns {{ok: boolean, volume: number, label: string, text: string, selection: Object|null, view: Object|null, refusal: ReferenceRefusal|null}}
 */
function annotatedChapterView(store, { volume, chapterText, volumeText, renameForms, label } = {}) {
  const vol = Number(volume === undefined ? store && store.volume : volume);
  if (typeof chapterText !== "string") {
    return {
      ok: false,
      volume: vol,
      label: String(label === undefined ? "chapter" : label),
      text: "",
      selection: null,
      view: null,
      refusal: refusal({
        verb: "annotated_view",
        rule: "annotated-view-needs-the-chapter-text",
        because:
          `the chapter to show came in as ${typeof chapterText}. A view is a view of one chapter's text, and ` +
          "this layer does not open a book to find it.",
        fix: "read the chapter through utils/reference-store/source-chapters.js and pass its text.",
      }),
    };
  }

  // The selection is a claim about the whole volume, so it is always asked against the whole volume — a
  // chapter that happens not to print a form is not evidence that the volume left it bare.
  const textForSelection = volumeText === undefined || volumeText === null ? chapterText : volumeText;
  const selection = annotatedFormsForVolume(store, { volume: vol, volumeText: textForSelection, renameForms });
  if (!selection.ok) {
    return {
      ok: false,
      volume: vol,
      label: String(label === undefined ? "chapter" : label),
      text: chapterText,
      selection,
      view: null,
      refusal: selection.refusal,
    };
  }

  const view = annotateChapterText(chapterText, { forms: selection.forms, label });
  if (!view.ok) {
    return {
      ok: false,
      volume: vol,
      label: String(label === undefined ? "chapter" : label),
      text: chapterText,
      selection,
      view,
      refusal: view.refusal,
    };
  }

  return {
    ok: true,
    volume: vol,
    label: view.label,
    text: view.text,
    selection,
    view,
    refusal: null,
  };
}

module.exports = { annotatedChapterView };
