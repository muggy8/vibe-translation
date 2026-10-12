/**
 * The size floors and the bundle cache version.
 *
 * BUNDLE_SCHEMA_VERSION is part of the extraction cache key: renaming the id scheme
 * or changing the shape bumps it and forces a clean re-extraction, so a stale cache
 * cannot keep handing out a chapter list the book does not have. EMPTY_SEGMENT_CHARS
 * is the extraction's "this section converted to nothing" flag — deliberately far
 * above TRANSLATION_EMPTY_SOURCE_CHARS, the translation stage's "do not spend a call
 * on this" floor (gotcha 40).
 *
 * Part of the source.js layer (split out of the original single file).
 */

require("../../types"); // JSDoc type definitions

/**
 * LEGACY whole-installment size (chars) above which the chapter-by-chapter
 * fallback kicked in. Still read (SOURCE_CHUNK_THRESHOLD_CHARS) and still used
 * as the fallback when a bundle has no measured script mix, but it is no longer
 * the primary rule: a character count is language-blind, and the same number
 * means wildly different things for different books. Measured on the live
 * 17-volume series, every volume is 128,744–176,201 characters and 75,757–
 * 109,628 tokens, so this threshold sent ALL 17 down the expensive fallback path
 * while every one of them fitted the model's window comfortably.
 *
 * Set SOURCE_CHUNK_THRESHOLD_CHARS=0 to always fall back for multi-chapter
 * epubs (it then acts as a hard override, whatever the token check says).
 *
 * @type {number}
 */
const DEFAULT_CHUNK_THRESHOLD_CHARS = 120000;


/**
 * Bundle-meta schema version. Bump this whenever the extraction's OUTPUT changes, so caches written
 * under an older rule are re-extracted rather than served forever: the cache key is the archive's
 * fingerprint plus this number, and the converter's behaviour is NOT in the key. Changing how a book
 * is converted and leaving this alone means every volume keeps serving the text already on disk and
 * nothing changes — which is why a converter change is not finished until the version moves with it.
 *
 * (v1: interludes were globally numbered "int.K" and the epilogue "chN.5"; v2: interludes are
 * "chN.K" anchored to the preceding chapter and the epilogue is "chN.epilogue"; v3: epilogues are
 * named like interludes, continuing the chN.K counter after their anchor chapter; v4: segments carry
 * `bodyChars` and an `empty` flag, so a section that converted to nothing is recorded as an empty
 * chapter instead of a silent zero-length one; v5: the spine is grouped by the book's own table of
 * contents, so an inserted illustration page or a chapter the packager split across two files is ONE
 * chapter, and cover / contents / notice / colophon pages are recorded as packaging instead of being
 * handed downstream as chapters; v6: every bundle records its SCRIPT MIX (CJK characters vs
 * everything else, whole volume and per chapter), because a token count belongs to a (text, model)
 * pair and the pipeline may re-estimate the same book against a different model without re-reading
 * it; v7: a pronunciation guide is no longer pasted into the word it annotates — <ruby>蒲<rt>かま
 * </rt>田<rt>た</rt></ruby> extracts as 蒲田, not 蒲かま田た — and every guide the conversion sets
 * aside is harvested beside the bundle (`<base>-ruby-guides.json`, utils/source/ruby-guides.js).
 * Measured on the 17 archives of the live series: 45,497 guides (45,429 of them landing in a chapter
 * and 68 on pages the books declare as packaging), 146,352 characters, 5.6% of the series' text and
 * 11.25% of volume 8.; v8: the harvest records each annotation AS IT WAS ANNOTATED (蒲 carrying かま,
 * then 田 carrying た — harvest schema 2), which is what lets the extraction rebuild the string the old
 * converter produced and search its own chapters for it, so every segment now carries that
 * measurement (`guideSplitForms`, 0 on a correct extraction) and the audit can report a guide-split
 * string at HIGH; and every segment carries `declaresPackaging`, the book's own declaration read back
 * per segment, so an empty cover plate on the contents-list fallback path is a fact rather than a title
 * match (gotcha 126). Measured on the same 17 archives: 21,647 of the 45,429 harvested annotations carry
 * two or more annotated pieces, and 0 guide-split strings are present in the extracted text.)
 *
 * @type {number}
 */
const BUNDLE_SCHEMA_VERSION = 8;

/**
 * What the CURRENT schema changed, in the sentence an operator sees when a cached bundle is thrown
 * away because of it.
 *
 * It used to be hard-coded to schema 5's change ("chapters now come from the book's own contents
 * list"), so a cache written under schema 6 was re-extracted with a message describing a rule that
 * had been in place for two versions — an operator reading it would go looking for a chapter-count
 * bug. One constant, named at the version that introduced it.
 *
 * @type {string}
 */
const SCHEMA_CHANGE_NOTE =
  "pronunciation guides are now harvested as they were annotated (which base character carried which " +
  "reading), every chapter is searched for a guide-split string the converter failed to set aside, and " +
  "every segment records whether the book declared it packaging";


/**
 * A converted section with fewer than this many characters of text is recorded
 * as an EMPTY chapter (SOURCE_EMPTY_SEGMENT_CHARS). This is not a story-length
 * rule — a real chapter is longer than this — it is the "the conversion produced
 * nothing" floor: an image-only page, a page whose text lives in a structure the
 * converter does not map, or a stub. Flagging it is what makes a missing chapter
 * visible in the reports instead of becoming a chapter nobody translated.
 *
 * @type {number}
 */
const EMPTY_SEGMENT_CHARS = (() => {
  const n = parseInt(process.env.SOURCE_EMPTY_SEGMENT_CHARS, 10);
  return Number.isFinite(n) ? Math.max(0, n) : 200;
})();


/**
 * How much STORY text an unnamed page group must hold before it is treated as a
 * section of the book rather than as packaging.
 *
 * This is the same question EMPTY_SEGMENT_CHARS asks ("did this convert to
 * nothing?"), asked of a group instead of a page — and it is measured only on
 * pages that did NOT declare themselves packaging, so a legal notice or a
 * colophon never has to be out-sized. A genuine opening scene the contents list
 * forgot can be under 600 characters (volumes 11 and 12 of the observed series
 * both have one); publisher boilerplate is excluded by its own declaration
 * rather than by length. SOURCE_UNDECLARED_SECTION_MIN_CHARS overrides it.
 *
 * @type {number}
 */
const UNDECLARED_SECTION_MIN_CHARS = (() => {
  const n = parseInt(process.env.SOURCE_UNDECLARED_SECTION_MIN_CHARS, 10);
  return Number.isFinite(n) ? Math.max(0, n) : EMPTY_SEGMENT_CHARS;
})();


/**
 * Resolve a volume's source into a SourceBundle.
 *
 * For `.md`/`.txt` sources the bundle is a single "whole" segment pointing at
 * the original file — nothing is written and nothing changes for existing
 * series. For `.epub` sources the bundle is materialized in the volume
 * folder (cached in `<base>-bundle.meta.json`, keyed on the epub's
 * mtime+size+sha256; re-extracted when the file changes or { force } is set).
 *
 * @param {{seriesDir: string, volume: TranslationTargetVolume, volumeDir: string, force?: boolean}} p
 * @returns {Promise<SourceBundle>}
 * @throws {Error} When the source file is missing or the epub is unreadable.
 */
// Target size for a plain-text part (a "synthetic chapter"). A little above
// TRANSLATE_CHUNK_CHARS so the translation stage rarely re-splits a part, while
// keeping each cumulative-task segment comfortably inside the context window.
//
// `SOURCE_TEXT_PART_TARGET_CHARS` overrides it. This is the packing rule, not a guard: it decides
// how a plain-text book is cut into synthetic chapters, and a plain-text volume with one part has no
// chapter-by-chapter path to fall back to at all (`shouldProcessChunked` refuses it). The offline
// pipeline loop sets it small so the fixture reaches the chunked branch — the fallback every real
// volume of this series takes — without anybody having to write a 30,000-character fake book.
// The production default is unchanged.
const TEXT_PART_TARGET_CHARS = (() => {
  const n = parseInt(process.env.SOURCE_TEXT_PART_TARGET_CHARS, 10);
  return Number.isFinite(n) ? Math.max(EMPTY_SEGMENT_CHARS, n) : 30000;
})();


module.exports = {
  DEFAULT_CHUNK_THRESHOLD_CHARS,
  BUNDLE_SCHEMA_VERSION,
  SCHEMA_CHANGE_NOTE,
  EMPTY_SEGMENT_CHARS,
  UNDECLARED_SECTION_MIN_CHARS,
  TEXT_PART_TARGET_CHARS,
};
