/**
 * utils/reference-store/glossary-adapter/labels.js — the names the glossary document is written with.
 *
 * The heading the renderer falls back to, the column headers every section's table gets, the one
 * section that IS the volume's roster, and the table that translates the extraction prompt's five
 * term types into those section names. They live in one file because the same four names are asked
 * by the importer, the pronoun rule, the extraction door and the renderer, and a section spelled
 * differently at two of those doors is a cast entry the coverage query cannot find.
 *
 * @module utils/reference-store/glossary-adapter/labels
 */

require("../../../types"); // JSDoc type definitions

/** The heading the renderer writes when a store holds no title of its own. */
const GLOSSARY_TITLE = "# Glossary";

/**
 * The column header every section's table gets — the one the real artifact and the pipeline use.
 *
 * `Original` / `Translated`, the account owner's wording (plan 07 §2b, 2026-10-15). The old pair named
 * two languages, which is a claim about this series that the artifact has no business making: the same
 * renderer publishes a glossary for a series written in any script, and a heading that says
 * `Japanese | English` is wrong the moment the series is not. These two name what a column HOLDS — the
 * word as the book writes it, and the rendering the pipeline chose for it — and nothing else.
 *
 * One door writes it ({@link renderGlossary}); the three readers of a published glossary drop the header
 * row by POSITION, not by matching these words, which is why renaming it moves no row.
 */
const GLOSSARY_HEADER = ["Original", "Translated", "Notes"];

/**
 * The section whose rows are the volume's roster.
 *
 * Named rather than inlined because it is the join between the two artifacts: the glossary's
 * Characters section is where the cast comes from, and the cast is what the voice reference is
 * supposed to cover. `integrity.js` compares the two (review 05 §4 item D).
 */
const GLOSSARY_CHARACTER_SECTION = "Characters";

/**
 * The section a term-extraction entry renders under, keyed on the extraction prompt's `type`.
 *
 * The extraction prompt already classifies every term it reports (`character`, `place`, `item`,
 * `faction`, `concept`), and the glossary already has a section for each of those five. This table is
 * the translation between the two vocabularies — the same kind of mapping as
 * `extraction-adapter.js`'s `QUIRK_TYPE_TO_ASPECT`, and for the same reason: the prompt and the store
 * were written independently and the names do not match. An unknown type lands in
 * `EXTRACTION_FALLBACK_SECTION` rather than in no section at all, because a row under no heading
 * renders as `(no section)` — a heading the authored artifact never has.
 */
const EXTRACTION_TYPE_TO_SECTION = {
  character: GLOSSARY_CHARACTER_SECTION,
  place: "Places",
  item: "Items & Artifacts",
  faction: "Factions & Organizations",
  concept: "Terms & Concepts",
};

/** Where a term whose `type` the prompt did not list is filed. */
const EXTRACTION_FALLBACK_SECTION = "Terms & Concepts";

module.exports = {
  GLOSSARY_TITLE,
  GLOSSARY_HEADER,
  GLOSSARY_CHARACTER_SECTION,
  EXTRACTION_TYPE_TO_SECTION,
  EXTRACTION_FALLBACK_SECTION,
};
