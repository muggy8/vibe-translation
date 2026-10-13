/**
 * The cumulative invariant, enforced without a model call.
 *
 * An entry counts as carried when every spelling its term column named is still
 * present somewhere — as its own row, inside a longer (widened) one, across several
 * (split), or as a RENAME: the row now names a different source-language spelling of
 * the same thing, which is what the amend prompt tells the agent to do when this
 * volume writes an old name a new way (gotcha 68). A real loss fails the volume and
 * moves the damaged file to glossary.md.rejected so the next volume cannot read it —
 * which is what makes the ON_MISSING_PREVIOUS cascade fire, because a present-but-
 * short artifact is the case that policy cannot otherwise see.
 *
 * The code lives in glossary/carry-forward/: gates.js (the moment a loss is found and what happens
 * next), table.js (the glossary read as a table — rows, spellings, renderings, and the index an
 * agent is handed), diff.js (what the newer glossary lost, and what it merely changed).
 * This file is the public surface of the cumulative invariant.
 *
 * There is no seeding step. The old one copied the previous volume's `glossary.md` into this volume's
 * folder so an author agent could edit it in place; the file is rendered from the volume's reference
 * record now, which already holds every earlier volume's entries, so copying a document in would only
 * give the render something to overwrite (glossary route slice 2).
 *
 * Part of the glossary.js layer (split out of the original single file).
 */

require("dotenv").config(); // before anything that turns a knob into a value at require time

const gates = require("./carry-forward/gates");
const table = require("./carry-forward/table");
const diff = require("./carry-forward/diff");

// The public surface, unchanged from the single file.
module.exports = {
  assertGlossaryCarryForward: gates.assertGlossaryCarryForward,
  guardCarryForwardAgainst: gates.guardCarryForwardAgainst,
  quarantineDamagedGlossary: gates.quarantineDamagedGlossary,
  logRenamedTerms: gates.logRenamedTerms,
  reportCarryForwardLoss: gates.reportCarryForwardLoss,
  parseGlossaryTableTerms: table.parseGlossaryTableTerms,
  glossaryTermSpans: table.glossaryTermSpans,
  glossaryTermSkeleton: table.glossaryTermSkeleton,
  GLOSSARY_SKELETON_MIN_CHARS: table.GLOSSARY_SKELETON_MIN_CHARS,
  glossaryRowText: table.glossaryRowText,
  normalizeGlossaryRendering: table.normalizeGlossaryRendering,
  CARRY_FORWARD_MIN_ALIAS_SPAN_CHARS: table.CARRY_FORWARD_MIN_ALIAS_SPAN_CHARS,
  compareGlossaryCarryForward: diff.compareGlossaryCarryForward,
  buildGlossaryIndex: table.buildGlossaryIndex,
};
