/**
 * utils/reference-store/written-forms/view/select.js — which written forms a chapter view may annotate.
 *
 * Plan 07 slice 5, the third step of "normalise, teach, then show". The door answers one question:
 * **given what this record filed about this volume's book, which written forms can be shown with the
 * author's own guide over them, without the view making up a guide the author did not write there?**
 *
 * ## The rule that decides it, and the measurement that forced it
 *
 * The extracted text records **no positions**. A `written_forms` row says *volume 15 printed 三色院菫子 and
 * guided it パンジー, 16 times, in these chapters* — never *where*. So the view can only annotate a printed
 * occurrence when it can prove that occurrence was one the author guided, and the only proof available from
 * the record is the arithmetic: **the form was guided exactly as often as the volume's own text prints it**.
 * When those two numbers are equal, every printed occurrence carries a guide, and annotating each one is
 * transcribing the author's markup. When guided is fewer, the view would be printing a guide at a place the
 * author left the word bare.
 *
 * Measured on the 17 real books through the shipped doors (`test/measure-annotated-view.js`, 0 model calls):
 * **2,532 written forms are guided fewer times than the book prints them — 21,082 guides against 64,326
 * printed occurrences.** Annotating every printed occurrence of those forms would print **43,244 guides the
 * author never wrote**. The clearest case is the one plan 07 §2.12 itself celebrates: 三色院菫子 is guided
 * パンジー 18 times across the series and printed 646 times, because the rename happens *at a point in the
 * story*; annotating all 646 would tell a translator the name is read パンジー everywhere, which is a
 * different book than the one the author wrote. Plan 07 §2.11's lesson — *a pronunciation guide is an
 * authorial act* — is what the equality guard enforces.
 *
 * ## The three guards, in the order they are asked
 *
 *   1. **one guided reading.** A form guided two ways in one volume (凄 → すさ x15 and すご x3) cannot be
 *      annotated at all: the record cannot say which occurrence took which reading, and guessing by row
 *      order is the failure mode this repository keeps paying to avoid (gotcha 117).
 *   2. **guided as often as printed.** The equality above. Asked against **this volume's own extracted
 *      text**, supplied by the caller, because "every single time" is a claim about a whole book and a door
 *      that guessed it would be a door that over-annotates.
 *   3. **at most `VIEW_MAX_USES_PER_VOLUME` guided occurrences**, unless the caller names the pair a
 *      **rename**. This is plan 07 §2.12's "the series uses that word no more than twice", and it is the
 *      cost guard: the always-guided forms are the ordinary words the author glosses out of habit (貴方 x92,
 *      友達 x51), and showing all of them is the 22% prompt the plan's own table prices and declines.
 *
 * **The rename half is data the caller supplies, never a rule this door holds.** Plan 07 §2.12's renames are
 * "a Han word guided with a reading written in one particular foreign script", and a door that named that
 * script would be a door that only works for one language — the shape `test/test-no-language-axis-list.js`
 * exists to keep out of this repository. The caller hands over the pairs it classifies as renames (the
 * measurement reads them out of the record's own `reading_script` column); this door only asks whether a
 * pair is on that list.
 *
 * ## What it never does
 *
 * It writes nothing, files nothing, marks nothing, and reaches no model. It reads one volume's rows out of
 * the record (`writtenFormsInRecord`) and the text the caller hands it, and it refuses to look at a volume
 * later than the record it was opened on — the same no-forward rule `written-forms/file.js` enforces when
 * it files (plan 07 §4.4). **No stage calls it**, and `test/test-annotated-view.js` greps the tree to prove
 * the count is zero.
 *
 * @module utils/reference-store/written-forms/view/select
 */

const { refusal } = require("../../refusals");
const { writtenFormsInRecord } = require("../rows");
const { rubyMarkupAddedChars } = require("../../ruby-markup");
require("../../../../types"); // JSDoc type definitions

/**
 * How many guided occurrences of one written form a view may annotate in one volume.
 *
 * Plan 07 §2.12's second row, and the reason it is a constant with no environment knob (AGENTS.md rule 3):
 * the number *is* the decision about how much pronunciation help a model sees, and a decision a run can
 * switch off is a decision the run did not make. Measured against the 17 real books, raising it to 3 adds
 * 1,440 more forms and 11,869 more annotated occurrences.
 *
 * @type {number}
 */
const VIEW_MAX_USES_PER_VOLUME = 2;

/**
 * How many times a written form occurs in a text, counted **non-overlapping**, per piece.
 *
 * `pieces` is an array so a form cannot be matched across a chapter boundary: two chapters joined by a
 * newline are not one continuous string, and a form that happens to straddle the join is a form the volume
 * never printed.
 *
 * @param {string|Array<string>} pieces - The volume's own extracted text, whole or chapter by chapter.
 * @param {string} form - The written form to count.
 * @returns {number}
 */
function printedOccurrences(pieces, form) {
  const word = String(form === undefined || form === null ? "" : form);
  if (!word) return 0;
  const list = Array.isArray(pieces) ? pieces : [pieces];
  let total = 0;
  for (const piece of list) {
    const text = String(piece === undefined || piece === null ? "" : piece);
    let at = text.indexOf(word);
    while (at !== -1) {
      total += 1;
      at = text.indexOf(word, at + word.length);
    }
  }
  return total;
}

/**
 * The rename keys a caller supplied, as a set of written forms.
 *
 * Accepts plain form strings (the forms of the volume being asked about) or `{volume, form}` pairs, and
 * keeps only the pairs belonging to the volume the door is asked about — a rename named for volume 9 does
 * not license annotating the same spelling in volume 3.
 *
 * @param {Array<string|{volume?: number, form: string}>|undefined} renameForms
 * @param {number} volume
 * @returns {{forms: Set<string>, named: number, malformed: number}}
 */
function renameKeySet(renameForms, volume) {
  const forms = new Set();
  if (!Array.isArray(renameForms)) return { forms, named: 0, malformed: 0 };
  let malformed = 0;
  for (const entry of renameForms) {
    if (typeof entry === "string") {
      if (entry) forms.add(entry);
      else malformed += 1;
      continue;
    }
    if (entry && typeof entry === "object") {
      const entryVolume = entry.volume === undefined ? volume : Number(entry.volume);
      const form = String(entry.form === undefined || entry.form === null ? "" : entry.form);
      if (!form || !Number.isFinite(entryVolume)) {
        malformed += 1;
        continue;
      }
      if (entryVolume === volume) forms.add(form);
      continue;
    }
    malformed += 1;
  }
  return { forms, named: Array.isArray(renameForms) ? renameForms.length : 0, malformed };
}

/**
 * Which written forms this volume's record may show a model, annotated.
 *
 * @param {{db: Object, volume: number, volumeDir?: string}} store - The record whose rows are asked about.
 * @param {Object} [opts]
 * @param {number} [opts.volume] - The volume whose forms are being selected. Defaults to this record's volume.
 * @param {string|Array<string>} [opts.volumeText] - **Required.** That volume's own extracted, guide-free
 *   text — the same text the view annotates. "Guided every single time" is a claim about a whole book, and
 *   a door that answered it without the book would be a door that prints guides the author did not write.
 * @param {Array<string|{volume: number, form: string}>} [opts.renameForms] - The pairs the **caller**
 *   classifies as renames. This door holds no rule about what a rename is and names no writing system.
 * @returns {{ok: boolean, volume: number, forms: Array<{form: string, reading: string, readingScript: string, guided: number, printed: number, reason: string}>, refused: Array<{form: string, guided: number, printed: number, readings: number, rule: string, because: string}>, totals: Object, note: string|null, refusal: ReferenceRefusal|null}}
 */
function annotatedFormsForVolume(store, { volume, volumeText, renameForms } = {}) {
  const vol = Number(volume === undefined ? store && store.volume : volume);
  if (!store || !store.db || !Number.isInteger(vol) || vol < 1) {
    return {
      ok: false,
      volume: vol,
      forms: [],
      refused: [],
      totals: null,
      note: null,
      refusal: refusal({
        verb: "annotated_view",
        rule: "annotated-view-volume-undecided",
        because:
          `"${volume}" is not a volume number, and "was this form guided every time the book printed it?" ` +
          "is a question about one volume's own record and one volume's own text.",
        fix: "annotatedFormsForVolume(store, { volume: 3, volumeText })",
      }),
    };
  }
  // The same no-forward rule the filing door enforces (plan 07 §4.4): this record is what this volume and
  // the volumes before it measured. A view of a later volume is not a view this record can give.
  if (Number.isInteger(store.volume) && vol > Number(store.volume)) {
    return {
      ok: false,
      volume: vol,
      forms: [],
      refused: [],
      totals: null,
      note: null,
      refusal: refusal({
        verb: "annotated_view",
        rule: "annotated-view-cannot-look-forward",
        because:
          `this record is volume ${store.volume}, and volume ${vol}'s book has not been read by it. ` +
          "An annotated view is built from the written forms this record holds, and a record holds its own " +
          "volume's and the ones before it.",
        fix: `open the record for volume ${vol} and ask it for its own view.`,
        detail: { recordVolume: Number(store.volume), askedVolume: vol },
      }),
    };
  }
  const textGiven =
    volumeText === undefined ||
    volumeText === null ||
    (typeof volumeText === "string" && volumeText.trim() === "") ||
    (Array.isArray(volumeText) && volumeText.length === 0);
  if (textGiven) {
    return {
      ok: false,
      volume: vol,
      forms: [],
      refused: [],
      totals: null,
      note: null,
      refusal: refusal({
        verb: "annotated_view",
        rule: "annotated-view-needs-the-volume-text",
        because:
          "the selection rule is 'guided exactly as often as this volume prints it', and without this volume's " +
          "own extracted text there is no printed count to compare against. A view built without that number " +
          "annotates occurrences it has no evidence were guided.",
        fix: `annotatedFormsForVolume(store, { volume: ${vol}, volumeText }) — pass the volume's chapter text, or the array of its chapter texts.`,
        detail: { askedVolume: vol },
      }),
    };
  }

  const rows = writtenFormsInRecord(store, { volume: vol });
  /** @type {Map<string, {form: string, readings: Map<string, {count: number, script: string}>, guided: number}>} */
  const byForm = new Map();
  for (const row of rows) {
    if (!byForm.has(row.form)) byForm.set(row.form, { form: row.form, readings: new Map(), guided: 0 });
    const entry = byForm.get(row.form);
    if (!entry.readings.has(row.reading)) entry.readings.set(row.reading, { count: 0, script: row.readingScript });
    entry.readings.get(row.reading).count += Number(row.occurrences) || 0;
    entry.guided += Number(row.occurrences) || 0;
  }

  const renames = renameKeySet(renameForms, vol);
  /** @type {Array<{form: string, reading: string, readingScript: string, guided: number, printed: number, reason: string}>} */
  const forms = [];
  /** @type {Array<{form: string, guided: number, printed: number, readings: number, rule: string, because: string}>} */
  const refused = [];
  let renameFormsMatched = 0;

  for (const entry of [...byForm.values()].sort((a, b) => (a.form < b.form ? -1 : a.form > b.form ? 1 : 0))) {
    const guided = entry.guided;
    const readings = entry.readings.size;
    // Guard 1: which occurrence took which reading is not in the record, so no occurrence can be annotated.
    if (readings > 1) {
      refused.push({
        form: entry.form,
        guided,
        printed: printedOccurrences(volumeText, entry.form),
        readings,
        rule: "annotated-view-form-guided-several-ways",
        because: `this volume guided "${entry.form}" ${readings} different ways (${guided} occurrences in all), and the record does not say which printed occurrence carried which reading.`,
      });
      continue;
    }
    const reading = [...entry.readings.keys()][0];
    const readingScript = entry.readings.get(reading).script;
    const printed = printedOccurrences(volumeText, entry.form);
    // Guard 2: the equality that makes an annotation a transcription rather than an invention.
    if (guided !== printed) {
      refused.push({
        form: entry.form,
        guided,
        printed,
        readings,
        rule: "annotated-view-form-not-guided-every-time",
        because: `this volume printed "${entry.form}" ${printed} times and guided it ${guided} times, so ${printed - guided} of those places are the author's own choice to leave the word bare. Annotating them would put a guide there that the book does not carry.`,
      });
      continue;
    }
    // Guard 3: the cost bound, lifted only for a pair the caller named.
    if (guided > VIEW_MAX_USES_PER_VOLUME && !renames.forms.has(entry.form)) {
      refused.push({
        form: entry.form,
        guided,
        printed,
        readings,
        rule: "annotated-view-form-used-more-than-twice",
        because: `this volume guided "${entry.form}" ${guided} times, over the ${VIEW_MAX_USES_PER_VOLUME} uses a view pays for. It is guided every single time, so it is a guide the author applies out of habit rather than one that tells the translator something.`,
      });
      continue;
    }
    const namedRename = renames.forms.has(entry.form);
    if (namedRename) renameFormsMatched += 1;
    forms.push({
      form: entry.form,
      reading,
      readingScript,
      guided,
      printed,
      reason: namedRename ? "named-rename" : "always-guided-within-the-bound",
    });
  }

  const addedChars = forms.reduce((sum, form) => sum + form.guided * rubyMarkupAddedChars(form), 0);
  const guidedOccurrences = forms.reduce((sum, form) => sum + form.guided, 0);
  const printedOccurrencesOfSelected = forms.reduce((sum, form) => sum + form.printed, 0);
  const byRule = {};
  for (const item of refused) byRule[item.rule] = (byRule[item.rule] || 0) + 1;

  return {
    ok: true,
    volume: vol,
    forms,
    refused,
    totals: {
      rowsInRecord: rows.length,
      formsInRecord: byForm.size,
      formsSelected: forms.length,
      formsRefused: refused.length,
      guidedOccurrences,
      printedOccurrences: printedOccurrencesOfSelected,
      addedChars,
      markupUnits: forms.length,
      renameFormsNamed: renames.named,
      renameFormsMatched,
      renameFormsMalformed: renames.malformed,
      refusedByRule: byRule,
      maxUsesPerVolume: VIEW_MAX_USES_PER_VOLUME,
    },
    note:
      rows.length === 0
        ? `volume ${vol}'s record holds no written forms, so there is nothing to annotate. That is a fact about the record, not a volume with nothing to show: run the written-forms door for this volume first.`
        : null,
    refusal: null,
  };
}

module.exports = {
  VIEW_MAX_USES_PER_VOLUME,
  printedOccurrences,
  annotatedFormsForVolume,
};
