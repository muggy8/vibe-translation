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
 * **`Readings` is the fourth column** (plan 09 decision 4, 2026-10-16): every pronunciation guide the book
 * itself printed over that word, taken from the volume records' `written_forms` rows. The name was chosen
 * over `Pronunciation` for a reason the corpus supplies: some of those guides are not pronunciations at all
 * — 蒲田公英 is guided たんぽぽ (dandelion) in two volumes and 日向葵 is guided ひまわり (sunflower), which
 * are meanings the author wrote over names. A heading that says "Pronunciation" would call those a
 * pronunciation and invite a reader to throw away the ones that matter. `Readings` says only that these are
 * the ways this book reads this word, which is exactly what the cell holds, and it names no language; the
 * guard that scans the pipeline's code for a heading that does is the same guard that caught the old pair.
 * It sits **third**, before Notes, because it is a short fact about the word and Notes is the long free-text
 * column that already carries the `Earlier rendering:` history line; a reader scanning the table sees the
 * word, its rendering and how it is spoken together.
 *
 * One door writes it ({@link renderGlossary}); the readers of a published glossary take the columns by
 * POSITION and read the header row to learn how many there are, which is why renaming it moves no row and
 * why a glossary published under three columns still imports unchanged.
 */
const GLOSSARY_HEADER = ["Original", "Translated", "Readings", "Notes"];

/**
 * Where the reading cell sits in the row — the position {@link renderGlossary} writes it at and every
 * reader of a four-column table reads it from.
 *
 * Named because the readers must not hard-code it: they learn the column count from the table's own header
 * row, and this constant is only what the renderer and the comparison agree on.
 */
const GLOSSARY_READING_COLUMN = 2;

/**
 * What the reading cell says for a term this record holds no guide for.
 *
 * Plan 09 §5's slice-3b line: "a term the book never guided records nothing and says so". A silent blank
 * is the shape that reads as "there is nothing here" and cannot be told apart from a renderer that forgot
 * the column, so the cell names its own emptiness.
 *
 * **What the sentence is, and what it is not.** It says this record holds no written-form row for this
 * word. It does NOT say the author never guided it: a guide the filing door's two row guards refused (a
 * one-character reading, or a reading that reuses a character of its own word — 1,095 such rows across the
 * 17 books, which are 333 distinct word-and-reading pairs) leaves the same cell, and the record cannot
 * tell the two apart without re-opening the harvest, which exactly one door in this store may do.
 * Measured on 2026-10-16 over the rows the renderer actually publishes: **0** of them sit in that state —
 * no published row prints this cell while a refused guide would have matched its word — so today the two
 * guards cost the artifact nothing, and the ambiguity is a limit to name rather than a hole to fill.
 */
const GLOSSARY_NO_READING_CELL = "no reading recorded";

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
  GLOSSARY_READING_COLUMN,
  GLOSSARY_NO_READING_CELL,
  GLOSSARY_CHARACTER_SECTION,
  EXTRACTION_TYPE_TO_SECTION,
  EXTRACTION_FALLBACK_SECTION,
};
