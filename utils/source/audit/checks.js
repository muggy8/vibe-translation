/**
 * utils/source/audit/checks.js — the eight questions the extraction layer can answer about itself.
 *
 * The five `utils/source/plan/01-extraction-step.md` §3 measured as computable from what extraction
 * already produces, plus the guide-split tripwire §3 deferred — deferred because the harvest could not
 * answer it (a row was 蒲田 / かまた, and a joined pair cannot say which character carried which reading,
 * so the broken string could not be rebuilt). The harvest now records each annotation's own sequence
 * (`RubyGuide.annotated`, harvest schema 2), which is what made the sixth check writable. The other
 * deferral still stands: "is this a character name?" has no roster to ask at extraction time.
 *
 * Checks 7 and 8 are plan 09 slice 1, and they exist because check 6 changed what it guards. Once the
 * converter writes the guides INTO the chapter (`<ruby>蒲田<rt>かまた</rt></ruby>`) it can no longer
 * assemble the split string, so `guide-split-in-text` can only fire on a file somebody edited or a source
 * that prints the split shape as ordinary text. Two questions become answerable and were not before:
 * **is every ruby element in the file the one shape the converter writes** (7), and **does the file hold as
 * many of them as the conversion harvested** (8). Both are counts over measurements the extraction records
 * on each segment, so neither costs a file read or a model call.
 *
 * Every check is a pure function over `{volume, bundle, names, segments, packagingTitles}` returning
 * `PostMortemFinding[]`. No file reads, no model, no writes, no agent — the plan's §4 is explicit that
 * a model in front of a fact a checksum already proves is a token spent to confirm something free.
 *
 * Part of the source.js layer's audit half.
 */

const path = require("path");

require("../../../types"); // JSDoc type definitions

const { finding } = require("../../postmortem/rules");
const { rubyGuideFileName } = require("../ruby-guides");

const {
  EXTRACTION_STEP,
  FILE_NAME_EXT_RE,
  isArchivePath,
  nameKey,
  archiveNamesOf,
  segmentHasNoBody,
  segmentDeclaresPackaging,
  findingFile,
  sourceNameKeys,
} = require("./rules");
const { EMPTY_SEGMENT_CHARS } = require("../config");

/**
 * Check 1 (HIGH) — the volume's source is not the book the plan of record named.
 *
 * Two shapes, both real, both gotcha 119:
 *   (a) the bundle opened a loose text file while a book archive sits in the same volume folder — the
 *       exact failure that made four stages read an 8,803-byte audit report as a 151,548-character
 *       novel and decide the volume had one segment and no chapter-by-chapter path;
 *   (b) the bundle opened a DIFFERENT file than the one the plan of record names for this volume, which
 *       is what "the plan of record's sourceFile against what the bundle actually opened" means
 *       literally, and which is what happens whenever a bundle is resolved for one folder and audited
 *       against another.
 *
 * A plain-text volume with no archive anywhere is NOT this finding: `.txt` / `.md` books are a supported
 * shape here, and a check that called every one of them a defect is a check somebody switches off.
 *
 * @param {{volume: TranslationTargetVolume, bundle: SourceBundle, names: string[]}} p
 * @returns {PostMortemFinding[]} Zero or one HIGH finding.
 */
function auditSourceIsArchive({ volume, bundle, names }) {
  const openedName = path.basename(bundle.originalPath || "");
  const plannedName = path.basename(volume.sourceFile || "");
  const archives = archiveNamesOf(names);

  if (isArchivePath(bundle.originalPath || "")) {
    if (plannedName && nameKey(openedName) !== nameKey(plannedName)) {
      return [
        finding(
          "HIGH",
          "source-not-archive",
          EXTRACTION_STEP,
          volume.installmentNumber || null,
          findingFile(volume),
          `The plan of record lists this volume's source as "${volume.sourceFile}" but the bundle was ` +
            `resolved from "${openedName}". The extraction read a different file from the one this volume ` +
            `is supposed to be. Check which folder the bundle was resolved for.`
        ),
      ];
    }
    return [];
  }

  if (archives.length === 0) return [];
  return [
    finding(
      "HIGH",
      "source-not-archive",
      EXTRACTION_STEP,
      volume.installmentNumber || null,
      findingFile(volume, openedName),
      `This volume was extracted from "${openedName}", which is not a book archive, while its folder ` +
        `holds ${archives.length} archive(s): ${archives.join(", ")}. Every artifact built from this ` +
        `volume is built from the wrong file — the shape of gotcha 119, where a 102,892-token novel was ` +
        `reported to four stages as a 2,394-token single-segment source.`
    ),
  ];
}

/**
 * Check 2 (HIGH) — the volume has no chapter a downstream stage could work on.
 *
 * Either the bundle has no segments at all, or every one of them converted to nothing. Today this
 * surfaces several stages later as a confusing failure (a glossary that found nothing to research, a
 * translate step reporting the volume INCOMPLETE with no text at all). Saying it here costs nothing and
 * stops the run before a stage spends tokens discovering it.
 *
 * @param {{volume: TranslationTargetVolume, segments: SourceSegment[]}} p
 * @returns {PostMortemFinding[]} Zero or one HIGH finding.
 */
function auditHasUsableChapter({ volume, segments }) {
  if (segments.length === 0) {
    return [
      finding(
        "HIGH",
        "no-usable-chapter",
        EXTRACTION_STEP,
        volume.installmentNumber || null,
        findingFile(volume),
        `The extraction produced 0 chapters for this volume. Nothing downstream can read it: every stage ` +
          `that walks this volume's segments has nothing to walk. The archive either has no readable text ` +
          `in its spine, or its contents list and its pages disagree completely.`
      ),
    ];
  }
  if (!segments.every(segmentHasNoBody)) return [];
  return [
    finding(
      "HIGH",
      "no-usable-chapter",
      EXTRACTION_STEP,
      volume.installmentNumber || null,
      findingFile(volume),
      `All ${segments.length} chapter(s) this volume extracted to are empty — the volume holds no text to ` +
        `translate. ${segments.length} segment(s) were produced and none of them converted to at least ` +
        `${EMPTY_SEGMENT_CHARS} characters of text.`
    ),
  ];
}

/**
 * Check 3 (HIGH) — a chapter that converted to nothing, beyond the pages the book declares as packaging.
 *
 * The worst kind of missing text, because it looks like a short chapter: the segment exists, it has a
 * title, it has a file, and it has no body. The extraction already logs each one (bundle schema 4's
 * `empty` flag) and the translation stage already records it as "EMPTY IN SOURCE" — but a log line
 * nobody reads is not a check, and a hole in the BOOK has to be told apart from a hole the converter
 * made.
 *
 * The exemption is the book's own declaration: a cover plate, an inserted illustration or the colophon
 * the contents list named as packaging never becomes a chapter, and under the fallbacks (where every
 * page stands alone) the title the navigation gave it is still the evidence that it is packaging. Those
 * are reported through the bundle's packaging list, not here. The exemption is the extraction's own
 * vocabulary read back, and it is narrow rather than complete — see AGENTS.md gotcha 126 for what a
 * bundle cannot say about a segment.
 *
 * @param {{volume: TranslationTargetVolume, segments: SourceSegment[], packagingTitles: Set<string>}} p
 * @returns {PostMortemFinding[]} One HIGH finding per chapter that converted to nothing.
 */
function auditEmptyChapters({ volume, segments, packagingTitles }) {
  const findings = [];
  for (const segment of segments) {
    if (!segmentHasNoBody(segment)) continue;
    if (segmentDeclaresPackaging(segment, packagingTitles)) continue;
    const bodyChars = Number.isFinite(segment.bodyChars) ? segment.bodyChars : 0;
    findings.push(
      finding(
        "HIGH",
        "chapter-extracted-empty",
        EXTRACTION_STEP,
        volume.installmentNumber || null,
        findingFile(volume, segment.file),
        `Chapter "${segment.id}" ("${segment.title}") converted to ${bodyChars} character(s) of text ` +
          `(the extraction's floor is ${EMPTY_SEGMENT_CHARS}) and the book does not declare it as ` +
          `packaging. Either the converter failed on this page's structure or a chapter is missing from ` +
          `the archive. A chapter silently missing looks exactly like a short chapter downstream.`
      )
    );
  }
  return findings;
}

/**
 * Check 4 (MEDIUM) — a chapter title that is a file name rather than a name the book prints.
 *
 * Two shapes this repository has actually shipped. A plain-text volume used to be headed with
 * `path.basename(sourceFile)`, so the published book literally began `# test_story(1).md`; and on
 * volumes 8 and 11 of the live series a section with no name of its own was titled `p-001.xhtml`, which
 * reads in every report as a chapter the book has. The extraction now guards both (`plainTextTitle`
 * marks a file-name title synthetic, and an unnamed section gets "Untitled section N"), so this check is
 * the tripwire that says the guard stopped working — and it is MEDIUM because a title that must not be
 * printed is a blemish in the reports, not a lost chapter.
 *
 * A synthetic placeholder ("Untitled section 3", "Part 2 of 5") is NOT this finding: it is the extraction
 * admitting it has no title, which is the honest answer. This check is about a title that pretends to be
 * a real one.
 *
 * @param {{volume: TranslationTargetVolume, bundle: SourceBundle, segments: SourceSegment[]}} p
 * @returns {PostMortemFinding[]} One MEDIUM finding per chapter titled after a file.
 */
function auditTitlesAreTitles({ volume, bundle, segments }) {
  const sourceNames = sourceNameKeys(bundle, volume);
  const findings = [];
  for (const segment of segments) {
    const title = String(segment.title || "").trim();
    if (!title) continue;
    const key = nameKey(title);
    if (!key) continue;
    const isSourceName = sourceNames.has(key);
    const isOwnFileName = key === nameKey(segment.file);
    const endsInFileExtension = FILE_NAME_EXT_RE.test(title);
    if (!isSourceName && !isOwnFileName && !endsInFileExtension) continue;
    findings.push(
      finding(
        "MEDIUM",
        "title-is-filename",
        EXTRACTION_STEP,
        volume.installmentNumber || null,
        findingFile(volume, segment.file),
        `Chapter "${segment.id}" is titled "${title}", which is a file name, not a title the book prints. ` +
          `It lands in chapters.json and in every report as a chapter the book has. The merge prints no ` +
          `heading for a synthetic title, so the published text is safe — the artifact that lists the ` +
          `chapters is not.`
      )
    );
  }
  return findings;
}

/**
 * Check 5 (MEDIUM) — a bundle whose pronunciation-guide harvest file is not beside it.
 *
 * The harvest is part of the extraction, not a note about it: `<base>-ruby-guides.json` is the only
 * record of what the author said each guided word is read as (三色院菫子 → パンジー, 玄武 → ジヨーロ),
 * and 146 distinct words across the live series are guided with a reading that is not the Japanese
 * pronunciation at all. `resolveSourceBundle` already re-extracts a cache that lost the file, so a
 * bundle that reaches this audit without one got past that check somehow — a cache certifying a hole
 * (gotcha 123).
 *
 * A plain-text volume is silent: it has no markup to harvest, and its bundle says so
 * (`rubyGuidesPath: null`).
 *
 * @param {{volume: TranslationTargetVolume, bundle: SourceBundle, names: string[]}} p
 * @returns {PostMortemFinding[]} Zero or one MEDIUM finding.
 */
function auditGuideHarvest({ volume, bundle, names }) {
  if (!isArchivePath(bundle.originalPath || "")) return [];
  const expected = rubyGuideFileName(bundle.base || "");
  const named = bundle.rubyGuides && bundle.rubyGuides.file ? bundle.rubyGuides.file : "";
  const present = new Set(names);
  if (present.has(expected) && (!named || present.has(named))) return [];
  const missing = named && named !== expected ? `${expected} (the bundle meta points at "${named}")` : expected;
  const guides = bundle.rubyGuides && Number.isFinite(bundle.rubyGuides.guides) ? bundle.rubyGuides.guides : null;
  return [
    finding(
      "MEDIUM",
      "ruby-harvest-missing",
      EXTRACTION_STEP,
      volume.installmentNumber || null,
      findingFile(volume, expected),
      `This volume's extraction kept ${guides === null ? "an unknown number of" : guides} ` +
        `pronunciation guide(s) in its text and "${missing}" is not in the volume folder. The readings are ` +
        `printed over the words, but nothing can be ASKED about them — which form was guided which way, how ` +
        `often, and in which chapters — and every later "how is this word read?" question about this volume ` +
        `is answered by a translator guessing.`
    ),
  ];
}

/**
 * Check 6 (HIGH) — a word and its own pronunciation guide are printed as one string.
 *
 * This was the regression tripwire for the 2026-10-12 fix (gotcha 123): `<ruby>蒲<rt>かま</rt>田<rt>た
 * </rt></ruby>` had to stop extracting as 蒲かま田た, and the defect that made it do so sat in all 17
 * volumes of the live series unnoticed, splitting 193 published glossary terms and hiding character names
 * from the rule that looks for them.
 *
 * SINCE PLAN 09 IT IS A DIFFERENT GUARD, and it stays a HIGH. The converter writes the base as one
 * contiguous run (`<ruby>蒲田<rt>かまた</rt></ruby>`), so it cannot assemble 蒲かま田た at all. What this
 * check can still catch is a chapter file somebody edited into the old shape, or a source that prints the
 * split string as ordinary text — and both mean the text the stages are reading is not the text the book
 * prints, which is exactly what the check was ever for.
 *
 * It is EXACT, and only exactness makes it worth having. The string to look for is rebuilt from the
 * annotation's own sequence — the base characters and the reading each one carried, in the order the book
 * annotated them — which is the string the old converter produced, character for character. Pattern
 * matching is deliberately not used: "kanji followed by its own reading" fires 666 times on the 17 real
 * books' ordinary prose (出だ, 言い, 回まわ, 聞き), and a check that cries wolf 666 times is a check
 * somebody switches off. The floor that keeps it silent (`GUIDE_SPLIT_MIN_PIECES`) is documented in
 * `utils/source/ruby-guides.js`.
 *
 * The check READS the extraction's own measurement (`segment.guideSplitForms`, written by
 * `utils/source/extract.js` as it writes each chapter file) rather than re-reading the book: the audit is
 * pure, and a cache hit re-reports the same answer for free. A segment with no recorded measurement — a
 * bundle cached before schema 8, or a hand-built fixture — is not reported as clean; it is not answerable,
 * and `BUNDLE_SCHEMA_VERSION` is what guarantees every bundle the pipeline resolves has the measurement.
 *
 * @param {{volume: TranslationTargetVolume, segments: SourceSegment[]}} p
 * @returns {PostMortemFinding[]} One HIGH finding per chapter whose text still holds a guide-split string.
 */
function auditGuideSplitSurvives({ volume, segments }) {
  const findings = [];
  for (const segment of segments) {
    const occurrences = Number.isFinite(segment.guideSplitForms) ? segment.guideSplitForms : null;
    if (occurrences === null || occurrences === 0) continue;
    const examples = (Array.isArray(segment.guideSplitExamples) ? segment.guideSplitExamples : []).slice(0, 3);
    findings.push(
      finding(
        "HIGH",
        "guide-split-in-text",
        EXTRACTION_STEP,
        volume.installmentNumber || null,
        findingFile(volume, segment.file),
        `Chapter "${segment.id}" ("${segment.title}") holds ${occurrences} guide-split string(s)` +
          `${examples.length ? ` — ${examples.join(", ")}` : ""} — in its text. That is the shape a ` +
          `pronunciation guide used to take: the book writes 蒲田 read かまた and the old converter pasted ` +
          `the reading into the word, producing 蒲かま田た. The converter that writes this file cannot ` +
          `produce that string any more (it writes the base as one contiguous run), so it arrived some other ` +
          `way — a chapter file edited by hand into the old shape, or the source itself printing it. Either ` +
          `way, every word of this shape in the text is a word the glossary will record wrongly and a name ` +
          `the character rules cannot see.`
      )
    );
  }
  return findings;
}

/**
 * Check 7 (HIGH) — a `<ruby>` in a chapter file is not the shape this converter writes.
 *
 * The canonical shape is `<ruby>蒲田<rt>かまた</rt></ruby>`: the word in one contiguous run, exactly one
 * guide over it, both halves present. Plan 09 chose that shape for a specific reason (decision 2): the
 * book's own per-piece markup — `<ruby>蒲<rt>かま</rt>田<rt>た</rt></ruby>` — puts tags *inside* the word,
 * which is how gotcha 123's split string gets back into the text, and 21,445 occurrences of it are in these
 * 17 books. So the shape is not cosmetics: it is the thing that makes "the word is whole" a property of the
 * file rather than a hope.
 *
 * The converter cannot produce a non-canonical element. Every reason this check can name is therefore a
 * different cause, and the message names it:
 *   - `base-not-contiguous` — base text after the guide, which is the old converter's interleaving wearing
 *     the new file's name, or a hand edit into it;
 *   - `multiple-guide-runs` — two guides over one word, which `rubyTextFor` never writes;
 *   - `empty-guide` / `empty-base` — markup with a half missing, which `rubyTextFor` refuses to write;
 *   - `nested-markup` / `unbalanced-markup` — a structure the converter mapped badly, or somebody's edit.
 *
 * It is STRUCTURAL, never a pattern over the reading. `utils/source/plan/01-extraction-step.md` §3 measured
 * 666 strings that look like "a word followed by its own reading" on the 17 real books and are ordinary
 * prose (出だ inside 思い出だ, 言い inside 言い訳); a rule about what a Japanese READING looks like fires on
 * legitimate text the same way, so nothing here asks what a reading is.
 *
 * Like check 6, it READS the extraction's own measurement (`segment.rubyShapeDefects`, written by
 * `utils/source/extract.js` as it writes each chapter file) rather than re-reading the book: the audit is
 * pure, and a cache hit re-reports the same answer for free. A segment with no recorded measurement — a
 * bundle cached before the schema that records it, or a plain-text source the extraction never converts —
 * is not reported as clean; it is not answerable.
 *
 * @param {{volume: TranslationTargetVolume, segments: SourceSegment[]}} p
 * @returns {PostMortemFinding[]} One HIGH finding per chapter whose text carries a non-canonical ruby element.
 */
function auditRubyMarkupIsCanonical({ volume, segments }) {
  const findings = [];
  for (const segment of segments) {
    const defects = Number.isFinite(segment.rubyShapeDefects) ? segment.rubyShapeDefects : null;
    if (defects === null || defects === 0) continue;
    const units = Number.isFinite(segment.rubyUnits) ? segment.rubyUnits : null;
    const reasons = Array.isArray(segment.rubyShapeReasons) ? segment.rubyShapeReasons : [];
    const examples = (Array.isArray(segment.rubyShapeExamples) ? segment.rubyShapeExamples : []).slice(0, 3);
    findings.push(
      finding(
        "HIGH",
        "ruby-markup-not-canonical",
        EXTRACTION_STEP,
        volume.installmentNumber || null,
        findingFile(volume, segment.file),
        `Chapter "${segment.id}" ("${segment.title}") holds ${defects} ruby element(s) that are not the ` +
          `shape this converter writes${units === null ? "" : ` (of ${units} it carries)`}` +
          `${reasons.length ? ` — ${reasons.join(", ")}` : ""}` +
          `${examples.length ? `: ${examples.join(" | ")}` : ""}. The one shape it writes is ` +
          `<ruby>蒲田<rt>かまた</rt></ruby>: the word in one contiguous run, one guide over it, both halves ` +
          `there. It cannot produce anything else, so this arrived as a chapter file edited into the shape ` +
          `the OLD converter left (a word with its own pronunciation guide pasted inside it), or from a page ` +
          `structure the conversion mapped badly. Either way the text this volume's stages are reading is not ` +
          `the text the book prints, and every quote later filed against it is checked against that text.`
      )
    );
  }
  return findings;
}

/**
 * Check 8 (HIGH) — a chapter's ruby markup and its own harvested guides disagree about how many readings it prints.
 *
 * The identity is exact and it is checkable for free: every pronunciation guide the conversion harvested
 * from a chapter's pages either became `<ruby>…<rt>…</rt></ruby>` in that chapter's file, or it was written
 * as plain text for a reason the converter records (`displayed === false`: a guide on a CHAPTER HEADING,
 * which stays guide-free because a name carrying markup matches no name that does not, or a guide with no
 * word under it). So `rubyUnits + rubyUndisplayed === rubyAnnotations`, chapter by chapter.
 *
 * A disagreement names one of two holes, and the message says which:
 *   - **more harvested than written** — a reading the author printed over a word that the translator never
 *     sees. That is the exact defect plan 09 exists to remove: 亜茶花 is guided あさか 32 times across six
 *     volumes, volume 3 published "Atsuka" with the note "the reading was inferred", and volume 14 later
 *     paid a revision call to rediscover what had been printed over the word since volume 3.
 *   - **more written than harvested** — markup in the file with no annotation behind it, which is somebody
 *     typing a reading the book does not print, or a conversion harvesting from a page it did not write.
 *
 * It is a COUNT, not a judgement about any particular guide: nothing here decides whether a guide means
 * anything, which is plan 09 decision 1 ("we cannot tell whether an annotation means anything, therefore we
 * keep"). Deciding that is what the harvest file is for, later.
 *
 * Same purity rule as checks 6 and 7: it reads the measurements the extraction recorded on the segment.
 *
 * @param {{volume: TranslationTargetVolume, segments: SourceSegment[]}} p
 * @returns {PostMortemFinding[]} One HIGH finding per chapter whose markup count and harvest count disagree.
 */
function auditRubyMarkupCount({ volume, segments }) {
  const findings = [];
  for (const segment of segments) {
    const units = Number.isFinite(segment.rubyUnits) ? segment.rubyUnits : null;
    const harvested = Number.isFinite(segment.rubyAnnotations) ? segment.rubyAnnotations : null;
    if (units === null || harvested === null) continue;
    const plain = Number.isFinite(segment.rubyUndisplayed) ? segment.rubyUndisplayed : 0;
    const written = units + plain;
    if (written === harvested) continue;
    const missing = harvested - written;
    findings.push(
      finding(
        "HIGH",
        "ruby-markup-count-mismatch",
        EXTRACTION_STEP,
        volume.installmentNumber || null,
        findingFile(volume, segment.file),
        `Chapter "${segment.id}" ("${segment.title}") was harvested with ${harvested} pronunciation ` +
          `guide(s) but its text carries ${units} ruby element(s) and ${plain} guide(s) written as plain ` +
          `text — ${written} accounted for, ${missing} not. ` +
          (missing > 0
            ? `That many readings the book printed over a word are NOT in the text this volume's stages ` +
              `read, so a translator has to infer them and the harvest file is the only place they exist.`
            : `That many ruby elements in the text have no annotation behind them, so a reading is in the ` +
              `chapter that this volume's own conversion never harvested — a guide somebody typed, or a ` +
              `page the conversion read without writing.`) +
          ` Either way this chapter's text and this volume's pronunciation-guide record disagree.`
      )
    );
  }
  return findings;
}

module.exports = {
  auditSourceIsArchive,
  auditHasUsableChapter,
  auditEmptyChapters,
  auditTitlesAreTitles,
  auditGuideHarvest,
  auditGuideSplitSurvives,
  auditRubyMarkupIsCanonical,
  auditRubyMarkupCount,
};
