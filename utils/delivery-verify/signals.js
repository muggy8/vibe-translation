/**
 * utils/delivery-verify/signals.js — what is measured, as data.
 *
 * The list of signals IS the acceptance test: adding a signal means adding an
 * entry here, and the comparison in compare.js needs no change. Two rules
 * are encoded in the entries rather than in code — `veto: true` (one damage
 * signal outranks any number of improvements) and `veto: false` (reported,
 * never decisive). Nothing here reads a file or compares anything.
 */

/** @typedef {import("../delivery-verify").DeliverableSnapshot} DeliverableSnapshot */

// ─── What is measured ─────────────────────────────────────────────────────────

/**
 * The cumulative artifacts, and what counts as their content.
 *
 * `protect` is the half a drop in which counts as damage, and it is deliberately the SAME half
 * each stage's own carry-forward gate protects — a measurement that guarded a different quantity
 * than the gate does would report a different series of failures than the one the pipeline can
 * actually see:
 *   - glossary: the term rows (`GLOSSARY_CARRY_FORWARD_GUARD`, gotcha 64);
 *   - character-voice: the `### Character` sections (`VOICE_CARRY_FORWARD_GUARD`, gotcha 65);
 *   - style-guide: the `## ` category set (`STYLE_CARRY_FORWARD_GUARD`, gotcha 65 — and its rule
 *     COUNT is deliberately NOT protected: "a guide that says the same thing in fewer words is
 *     not damaged", so the count is reported and never vetoes);
 *   - jump-in-wiki: the chapter handoff. `chapters.json` is what the translation stage names its
 *     outputs by, so a chapter that vanishes from it is a chapter the book never gets.
 *
 * @type {Object<string, {primary: string, extra: string, protect: string, unit: string}>}
 */
const REFERENCE_ARTIFACTS = {
  glossary: { primary: "glossary.md", extra: null, protect: "terms", unit: "glossary terms carried" },
  "character-voice": {
    primary: "character-voice.md",
    extra: null,
    protect: "sections",
    unit: "character sections",
  },
  "style-guide": {
    primary: "style-guide.md",
    extra: null,
    protect: "categories",
    unit: "style categories",
  },
  "jump-in-wiki": {
    primary: "shared-wiki.md",
    extra: "chapters.json",
    protect: "chapters",
    unit: "chapters handed to the translator",
  },
};

/**
 * The book signals share one precondition, and therefore one honest reason when it fails.
 *
 * Without this, a series whose translation stage has not run yet produces one "not compared" line
 * per book signal on every action — eight lines of noise that say the same thing, which is how a
 * report stops being read.
 *
 * @param {DeliverableSnapshot} b
 * @param {DeliverableSnapshot} a
 * @returns {true|string}
 */
function bookPresentOnBothSides(b, a) {
  return (
    (b.book && a.book ? true : false) ||
    "there is no publish report on either side — the translation stage has not produced one"
  );
}

/**
 * The signals, as data (the same shape `utils/artifacts.js` declares expectations in).
 *
 * `veto: true` means a `worse` movement decides the outcome no matter how much improved.
 * `veto: false` means the movement is reported and cannot decide anything — the style guide's
 * rule count is the example, because the pipeline's own gate reports a drop there rather than
 * failing on it (gotcha 65).
 *
 * @type {Array<{
 *   name: string,
 *   label: string,
 *   betterWhen: ("up"|"down"),
 *   veto: boolean,
 *   get: function(DeliverableSnapshot): (number|null),
 *   comparable?: function(DeliverableSnapshot, DeliverableSnapshot): (boolean|string),
 *   why: string,
 * }>}
 */
const DELIVERABLE_SIGNALS = [
  // ── The book ────────────────────────────────────────────────────────────────
  {
    name: "publishReport",
    label: "the publish report exists",
    betterWhen: "up",
    veto: true,
    get: (s) => (s.book ? 1 : 0),
    why: "the report IS the sign-off on the deliverable; an intervention that leaves no report left no answer",
  },
  {
    name: "published",
    label: "chapters PUBLISHED (verified)",
    betterWhen: "up",
    veto: true,
    get: (s) => (s.book ? s.book.published : null),
    comparable: bookPresentOnBothSides,
    why: "the book is what the run is for: a chapter that stops being verified is a chapter the reader is warned about",
  },
  {
    name: "unverified",
    label: "chapters UNVERIFIED",
    betterWhen: "down",
    veto: true,
    get: (s) => (s.book ? s.book.unverified : null),
    comparable: bookPresentOnBothSides,
    why: "published with a visible warning is still a hole in the book",
  },
  {
    name: "missing",
    label: "chapters MISSING",
    betterWhen: "down",
    veto: true,
    get: (s) => (s.book ? s.book.missing : null),
    comparable: bookPresentOnBothSides,
    why: "a chapter the pipeline never produced (as opposed to a hole in the source, which is not the pipeline's failure)",
  },
  {
    name: "verifyScoreMedian",
    label: "median verification score",
    betterWhen: "up",
    veto: true,
    get: (s) => (s.book ? s.book.scoreMedian : null),
    comparable: (b, a) => {
      const present = bookPresentOnBothSides(b, a);
      if (present !== true) return present;
      if (b.book.scoreCount === 0 || a.book.scoreCount === 0) return "no verification scores on both sides";
      return (
        b.book.total === a.book.total ||
        "the chapter list changed size, so the two medians describe different books"
      );
    },
    why: "the same chapters graded worse is a real regression; a different SET of chapters is not a measurement",
  },
  {
    name: "crossChapterHigh",
    label: "HIGH cross-chapter findings",
    betterWhen: "down",
    veto: true,
    get: (s) => (s.book ? s.book.crossChapterHigh : null),
    comparable: bookPresentOnBothSides,
    why: "the drift a per-chapter check cannot see: a name rendered two ways, a fact chapter 3 denies in chapter 9",
  },
  {
    name: "variantConflicts",
    label: "rendering-variant conflicts",
    betterWhen: "down",
    veto: true,
    get: (s) => (s.book ? s.book.variantConflicts : null),
    comparable: bookPresentOnBothSides,
    why: "the published text using a second rendering of a term the glossary already fixed",
  },
  {
    name: "disputes",
    label: "open glossary disputes",
    betterWhen: "down",
    veto: true,
    get: (s) => (s.book ? s.book.disputes : null),
    comparable: bookPresentOnBothSides,
    why: "the terminology the translation stage found the reference layer got wrong",
  },

  // ── The reference layer ─────────────────────────────────────────────────────
  {
    name: "glossaryTerms",
    label: "glossary terms carried",
    betterWhen: "up",
    veto: true,
    get: (s) => s.reference.glossary.termsTotal,
    why: "the glossary is cumulative: 457 terms once vanished between two volumes with no error at all (gotcha 64)",
  },
  {
    name: "glossaryHeadTerms",
    label: "glossary terms in the newest snapshot",
    betterWhen: "up",
    veto: true,
    get: (s) => s.reference.glossary.headTerms,
    why: "the newest snapshot is the one every later volume reads, so a loss here cascades",
  },
  {
    name: "voiceSections",
    label: "character sections in the voice reference",
    betterWhen: "up",
    veto: true,
    get: (s) => s.reference["character-voice"].headCharacterSections,
    why: "the same unit the voice carry-forward gate protects — a reworded heading is not a lost character, a dropped section is (gotcha 65)",
  },
  {
    name: "styleCategories",
    label: "style-guide categories",
    betterWhen: "up",
    veto: true,
    get: (s) => s.reference["style-guide"].headSections,
    why: "a guide missing \"Address & Honorifics\" has lost everything inside it",
  },
  {
    name: "wikiChapters",
    label: "chapters handed to the translator",
    betterWhen: "up",
    veto: true,
    get: (s) => s.reference["jump-in-wiki"].chaptersHandedOff,
    why: "chapters.json is what the translation stage names its outputs by — a chapter missing from it is a chapter the book never gets",
  },

  // ── Every volume's own copy ─────────────────────────────────────────────────
  {
    name: "referenceVolumes",
    label: "volumes holding a reference artifact",
    betterWhen: "up",
    veto: true,
    get: (s) => Object.values(s.reference).reduce((n, r) => n + r.volumesWith, 0),
    why: "a volume that had its glossary / voice reference / style guide / wiki and no longer has one lost work",
  },
  {
    name: "stepsBuilt",
    label: "volumes holding each step's declared output",
    betterWhen: "up",
    veto: true,
    get: (s) => {
      if (!s.steps) return null;
      const counted = Object.values(s.steps).filter((p) => typeof p.built === "number");
      return counted.length ? counted.reduce((n, p) => n + p.built, 0) : null;
    },
    why: "the coarse half: the files a step always leaves",
  },

  // ── Reported, never decisive ────────────────────────────────────────────────
  {
    name: "styleRules",
    label: "style-guide rules",
    betterWhen: "up",
    veto: false,
    get: (s) => s.reference["style-guide"].headRules,
    why: "reported, not judged: a guide that says the same thing in fewer words is not damaged (gotcha 65), so this cannot decide anything",
  },
  {
    name: "glossarySections",
    label: "glossary sections",
    betterWhen: "up",
    veto: false,
    get: (s) => s.reference.glossary.headSections,
    why: "the glossary's invariant is its terminology, not how its rows are grouped",
  },
  {
    name: "bookChapters",
    label: "chapters in the publish report",
    betterWhen: "up",
    veto: false,
    get: (s) => (s.book ? s.book.total : null),
    comparable: bookPresentOnBothSides,
    why: "a chapter list that grew is not yet a better book — the new chapters land in MISSING until they are translated",
  },
];

module.exports = { REFERENCE_ARTIFACTS, DELIVERABLE_SIGNALS };
