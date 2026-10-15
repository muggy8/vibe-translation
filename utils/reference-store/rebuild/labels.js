/**
 * utils/reference-store/rebuild/labels.js — the words and the bounds the rebuilt artifact is
 * written with.
 *
 * One table for the bullet labels the extraction prompt's quirk types become, and the two numbers
 * that keep a bullet readable: the longest line the file may print, and how many of a claim's own
 * quotes go inside it. The labels are the artifact's wording, not the record's: `voice-adapter.js`'s
 * `VOICE_LABEL_TO_ASPECT` reads them back, so a rebuilt file re-imports into the aspects it was filed as.
 *
 * @module utils/reference-store/rebuild/labels
 */


require("../../../types"); // JSDoc type definitions

/** The heading the rebuilt file opens with — the same title the authored artifact uses. */
const REBUILT_VOICE_TITLE = "# Character Voice Reference";

/** The section every character lives under — the one every published reference on disk uses. */
const REBUILT_VOICE_SECTION = "Characters";

/**
 * The extraction prompt's `quirkType` values, spelled the way the artifact spells them.
 *
 * `QUIRK_TYPE_TO_ASPECT` maps a quirk type onto the aspect a query runs on; this maps it onto the
 * bullet label the file prints. They are separate on purpose: the artifact's wording is what
 * `voice-adapter.js`'s `VOICE_LABEL_TO_ASPECT` reads back, and every label here is already in that
 * table, so a rebuilt file re-imports into the same aspects it was filed as. The extractor's own
 * distinction (sentence endings vs vocabulary vs formality vs dialect, all one `register` aspect)
 * survives the round trip because the label carries it.
 *
 * Plan 06 slice 5 is why that matters more than it looks: the four kinds share one aspect, so for a
 * claim that names no register axis the label is the **only** place the distinction is still written
 * anywhere. `register/answers.js` reports those claims by label, and the volume's audit report prints
 * them, so the collapse is a number in a report rather than a fact only a reader of this file knows.
 *
 * @type {Object<string, string>}
 */
const QUIRK_TYPE_TO_VOICE_LABEL = {
  sentenceending: "Sentence endings",
  pronoun: "Pronouns",
  formality: "Formality level",
  vocabulary: "Vocabulary register",
  catchphrase: "Catchphrases",
  dialect: "Dialect",
  internalvoice: "Internal voice",
};

/** The label a POV claim gets when it is attached to a character. */
const POV_VOICE_LABEL = "Point of view";

/** The label a claim whose quirk type the prompt did not list gets. */
const UNLABELED_VOICE_LABEL = "Notes";

/**
 * How long one rendered **line** may be.
 *
 * The artifact-shape check reports a line longer than an agent's file tools can read (`AGENT_MAX_LINE
 * _LENGTH`, default 8000) as HIGH, and volume 01's destroyed reference is exactly that failure. A
 * rebuild that emitted a 9,000-character bullet would produce a file its own audit refuses. The cap is
 * therefore smaller than the read limit, it counts the `- **Label**: ` prefix, and a claim over it is
 * **named as truncated** in the file — the full text stays in the record, where the audit and (slice 8)
 * the translator can reach it.
 */
const MAX_REBUILD_BULLET_CHARS = 2000;

/** How many of a claim's own quotes are printed in its bullet. */
const REBUILT_EXAMPLES_PER_BULLET = 3;

/**
 * How many earlier answers one character's section may print before the rest are named as left out.
 *
 * The arc (plan 06 slice 6) is the record's account of what it used to stand behind, and it exists so a
 * character's development does not read as a contradiction. It is also the one part of the file that
 * grows with the number of revisions rather than with the number of characters, so it gets the same
 * treatment every other cap in this module gets: a constant with no environment knob, and a line that
 * names how many it left out rather than a silent cut.
 */
const MAX_REBUILD_ARC_LINES_PER_CHARACTER = 6;

/** What a capped bullet says about itself, so a reader knows the line is not the whole claim. */
const TRUNCATION_NOTE = " (truncated here; the full claim is in this volume's reference record)";

module.exports = {
  REBUILT_VOICE_TITLE,
  REBUILT_VOICE_SECTION,
  QUIRK_TYPE_TO_VOICE_LABEL,
  POV_VOICE_LABEL,
  UNLABELED_VOICE_LABEL,
  MAX_REBUILD_BULLET_CHARS,
  REBUILT_EXAMPLES_PER_BULLET,
  MAX_REBUILD_ARC_LINES_PER_CHARACTER,
  TRUNCATION_NOTE,
};
