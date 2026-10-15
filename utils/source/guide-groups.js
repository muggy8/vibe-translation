/**
 * The candidate name-groups hiding in a volume's pronunciation-guide harvest.
 *
 * WHY THIS FILE EXISTS. `utils/source/ruby-guides.js` writes, beside every volume, one row per
 * (word, reading) pair the converter set aside — 10,005 rows and 45,429 occurrences across the 17
 * books of the live series — and **nothing has ever read that file back**. `character-voice/plan/07`
 * §2 is the measurement of what is in it. The interesting shape is one reading the author printed
 * over two or more different written forms: 虹彩寺菫, 三色院菫子, 好きな女 and 主人公 all guided
 * パンジー. That is the author writing a description and naming it in the reading, and no
 * name-matching rule over the extracted text can find it (plan 07 §2.3).
 *
 * IT GENERATES CANDIDATES AND NOTHING MORE. A group is "one reading, two or more written forms",
 * which is true both of a real identity link (翌桧 / 羽立桧菜 → あすなろ) and of an ordinary homophone
 * pair (美味 / 上手 → うま, 呆然 / 茫然 → ぼうぜん). **Deciding which groups are identity links is not
 * this module's job and this module does not do it**: plan 07 slice 2 decides that against the record,
 * and the measurement that shows the decision is possible lives in `test/measure-guide-groups.js`.
 * A module that filtered the noise here would be a module that decided the question with a rule nobody
 * reviewed, which is the mistake plan 06 §2.3 made.
 *
 * THE LOAD-BEARING RULE NAMES NO SCRIPT. Three guards, all of them mechanical facts about two
 * strings: the reading is at least `GUIDE_GROUP_MIN_READING_CHARS` characters long; the reading shares
 * **no character** with the written form; and two or more distinct written forms carry that reading,
 * with at least one of them at least `GUIDE_GROUP_MIN_FORM_CHARS` characters long. Nothing in that
 * path asks which writing system either side is written in. The "kanji word given a katakana reading"
 * subset plan 07 §2.2 was written against is kept only as `isGuideGroupKatakanaOverHanForm`, a
 * **display** filter: it selects what is worth showing a model, and it is not how a group is
 * identified. Measured over the 17 real volumes the two answers are different sets — the display rule
 * finds 192 rows / 99 readings, the script-neutral rule finds 97 groups / 222 forms / 634 rows /
 * 8,734 occurrences — and the script-neutral one is the wider and the honest one.
 * → `character-voice/plan/07-written-forms-and-relations.md` §2.
 *
 * NO MODEL, NO PROMPT, NO AGENT, NO DATABASE. It reads a harvest (or the file holding one) and folds
 * rows into groups.
 *
 * Part of the source.js layer.
 */

require("../../types"); // JSDoc type definitions

const { normalizeSpaces } = require("./html");
const { readRubyGuideFile, readingScriptOf } = require("./ruby-guides");

/**
 * @typedef {Object} GuideGroupFormOccurrence
 * One written form as one volume printed it, under one guided reading.
 * @property {string} volume   — The volume label this volume was folded in under ("01", 1, …).
 * @property {number} count    — How many times this volume guided this form with this reading.
 * @property {string[]} chapters — The segment ids it occurred in, in the order the harvest recorded them.
 */

/**
 * @typedef {Object} GuideGroupForm
 * One written form inside one candidate group.
 * @property {string} form        — The word as the book prints it, guides already removed.
 * @property {number} count       — Occurrences summed over every volume this form appears in.
 * @property {number} characterCount — Characters in the form (whitespace removed).
 * @property {string[]} volumes   — Every volume that printed this form, sorted.
 * @property {GuideGroupFormOccurrence[]} occurrences — Per volume, so a later slice can date the form.
 */

/**
 * @typedef {Object} GuideGroup
 * One reading the author printed over two or more distinct written forms.
 * @property {string} reading        — The reading the author wrote.
 * @property {string[]} readingScripts — Which writing systems this harvest's own classifier reported for it.
 * @property {GuideGroupForm[]} forms — The written forms under it, most-used first.
 * @property {number} formCount      — Distinct written forms in the group.
 * @property {number} rowCount       — Harvest rows folded into the group.
 * @property {number} occurrences    — Occurrences summed over those rows.
 * @property {string[]} volumes      — Every volume the group appears in, sorted.
 * @property {boolean} displayKatakanaOverHanForm — **Display only**: the reading is written in katakana
 *   and at least one form is written in Han. Not part of the grouping rule; see the file header.
 */

/**
 * @typedef {Object} GuideGroupTotals
 * What the fold saw, including what each guard threw away, so a measurement can be re-read rather
 * than re-remembered.
 * @property {number} volumes — Volumes folded in.
 * @property {number} harvestRows — (word, reading) rows read.
 * @property {number} harvestOccurrences — Occurrences in those rows.
 * @property {number} rowsDroppedByReadingLength — Rows whose reading is shorter than `GUIDE_GROUP_MIN_READING_CHARS`.
 * @property {number} rowsDroppedBySharedCharacter — Rows whose reading shares a character with the form.
 * @property {number} rowsSkippedWithoutWordOrReading — Rows that name no word or no reading: counted, never grouped.
 * @property {number} rowsEligible — Rows that passed both row guards.
 * @property {number} groupsSeen — Distinct readings among the eligible rows.
 * @property {number} groupsDroppedBelowFormFloor — Readings carried by fewer than `GUIDE_GROUP_MIN_FORMS` forms.
 * @property {number} groupsDroppedWithEveryFormSingleCharacter — Readings whose forms are all one character long.
 * @property {number} candidateGroups — Groups the rule kept.
 * @property {number} candidateRows — Harvest rows inside those groups.
 * @property {number} candidateOccurrences — Occurrences inside those groups.
 * @property {number} candidateForms — Distinct written forms across those groups.
 * @property {number} candidateVolumes — Distinct volumes those groups touch.
 * @property {number} candidateGroupsForDisplay — Of the candidates, how many the display filter selects.
 */

/**
 * A reading shorter than this is a phonetic complement, not a name: 替 guided か, 取 guided と,
 * 突 guided つ. Measured: the shortest reading that ever lands over two or more written forms in the
 * live series is 2 characters, and every 1-character reading in the 10,005 rows is a single-kanji
 * guide. Pinned by `test/test-guide-groups.js`.
 *
 * @type {number}
 */
const GUIDE_GROUP_MIN_READING_CHARS = 2;

/**
 * How many distinct written forms one reading must be printed over to be a candidate at all.
 * One form guided one way is just a word with its pronunciation.
 *
 * @type {number}
 */
const GUIDE_GROUP_MIN_FORMS = 2;

/**
 * At least one form in a group must be this long.
 *
 * This is the guard that separates "the author guided one kanji several ways" from "the author called
 * several different things by the same name". A group whose every form is a single character is the
 * shape of a phonetic complement or a pair of homophone kanji — 恐 / 遅 / 襲 guided おそ, 叶 / 敵 / 奏
 * guided かな — and it is 120 of the 217 groups the first two guards produce on the live series.
 *
 * **It is not free.** Measured over the 17 real volumes it also drops しば (← 芝 x416 / 縛 x10), and
 * 芝 is a name the published record already holds. That is one known false negative, and it is
 * written in plan 07 §2 rather than smoothed over.
 *
 * @type {number}
 */
const GUIDE_GROUP_MIN_FORM_CHARS = 2;

/**
 * Whether a reading and a written form have no character in common.
 *
 * Script-neutral by construction: it compares code points and asks nothing about which script either
 * side is written in. It is the load-bearing half of the rule, because a reading that reuses a
 * character of the word it sits on is the word's ordinary pronunciation (蒲 guided かま), while a
 * reading built entirely out of different characters is the author **renaming** it (三色院菫 guided
 * パンジー).
 *
 * @param {string} reading - The guide the author wrote.
 * @param {string} form - The word as the book prints it.
 * @returns {boolean} True when the two share no character.
 */
function readingSharesNoCharacterWithForm(reading, form) {
  const readingChars = new Set(String(reading || "").replace(/\s+/g, ""));
  if (readingChars.size === 0) return false;
  for (const ch of String(form || "").replace(/\s+/g, "")) {
    if (readingChars.has(ch)) return false;
  }
  return true;
}

/**
 * Whether a group is the subset worth **showing a model**: a reading written in katakana sitting on a
 * form that contains Han.
 *
 * DISPLAY ONLY, and deliberately not part of `collectGuideGroups`'s decision. It names two writing
 * systems, which makes it a rule about this series' orthography rather than a rule about guided forms;
 * the identity rule is the script-neutral one. It is kept because plan 07 §4.5 wants exactly this
 * subset in the annotated view (192 rows series-wide), and because dropping it would lose the
 * measurement the plan was written from.
 *
 * @param {GuideGroup} group - A group produced by `collectGuideGroups`.
 * @returns {boolean}
 */
function isGuideGroupKatakanaOverHanForm(group) {
  const reading = String((group && group.reading) || "");
  if (readingScriptOf(reading) !== "katakana") return false;
  return ((group && group.forms) || []).some((form) => /[\u4e00-\u9fff]/u.test(String(form.form || "")));
}

/**
 * Sort helper: volume labels are "01" in some callers and 1 in others, and a group's volume list has
 * to read in book order either way.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareVolumeLabels(a, b) {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

/**
 * Fold one volume's harvest rows into the shared group map.
 *
 * Rows are keyed on (reading, form) inside the volume first, so a harvest that lists the same pair
 * twice cannot double a count, and the chapters a pair occurred in are merged rather than replaced.
 * Row guards are applied here, so the totals can say **which** guard dropped each row.
 *
 * @param {Map<string, {reading: string, scripts: Set<string>, rows: number, occurrences: number, forms: Map<string, {form: string, count: number, characterCount: number, byVolume: Map<string, GuideGroupFormOccurrence>}>}>} groups
 *   The group map being built, keyed by reading.
 * @param {{volume: string|number, guides: RubyGuideRow[]}} volumeHarvest - One volume's harvest.
 * @param {{droppedByReadingLength: number, droppedBySharedCharacter: number, skippedWithoutWordOrReading: number, rows: number, occurrences: number}} tally
 *   Mutated: what the guards threw away, counted.
 * @returns {void}
 */
function foldVolumeHarvest(groups, volumeHarvest, tally) {
  const volumeLabel = String(volumeHarvest && volumeHarvest.volume != null ? volumeHarvest.volume : "");
  const rows = (volumeHarvest && volumeHarvest.guides) || [];
  for (const row of rows) {
    const form = normalizeSpaces(row && row.word);
    const reading = normalizeSpaces(row && row.reading);
    const count = Number.isFinite(row && row.count) ? row.count : 0;
    tally.rows += 1;
    tally.occurrences += count;
    if (!form || !reading) {
      tally.skippedWithoutWordOrReading += 1;
      continue;
    }
    if (reading.length < GUIDE_GROUP_MIN_READING_CHARS) {
      tally.droppedByReadingLength += 1;
      continue;
    }
    if (!readingSharesNoCharacterWithForm(reading, form)) {
      tally.droppedBySharedCharacter += 1;
      continue;
    }

    let group = groups.get(reading);
    if (!group) {
      group = { reading, scripts: new Set(), rows: 0, occurrences: 0, forms: new Map() };
      groups.set(reading, group);
    }
    group.rows += 1;
    group.occurrences += count;
    if (row && row.readingScript) group.scripts.add(row.readingScript);

    let formEntry = group.forms.get(form);
    if (!formEntry) {
      formEntry = { form, count: 0, characterCount: form.replace(/\s+/g, "").length, byVolume: new Map() };
      group.forms.set(form, formEntry);
    }
    formEntry.count += count;
    let perVolume = formEntry.byVolume.get(volumeLabel);
    if (!perVolume) {
      perVolume = { volume: volumeLabel, count: 0, chapters: [] };
      formEntry.byVolume.set(volumeLabel, perVolume);
    }
    perVolume.count += count;
    for (const chapter of (row && Array.isArray(row.chapters)) ? row.chapters : []) {
      if (chapter && !perVolume.chapters.includes(chapter)) perVolume.chapters.push(chapter);
    }
  }
}

/**
 * Read the candidate groups out of one or more volumes' guide harvests.
 *
 * **Candidates, not conclusions.** A returned group is "this reading was printed over these written
 * forms", which is true of a name link and of a homophone pair alike. Nothing here decides which is
 * which; plan 07 slice 2 does that against the record.
 *
 * @param {Array<{volume: string|number, guides: RubyGuideRow[]}>} volumeHarvests - One entry per volume.
 *   An entry with no `guides` (a plain-text source, or a volume extracted before the harvest existed)
 *   contributes nothing and is still counted in `totals.volumes`.
 * @param {{displaySubset?: boolean}} [options] - `displaySubset` (default true) fills each group's
 *   `displayKatakanaOverHanForm` flag and `totals.candidateGroupsForDisplay`. It never changes which
 *   groups are returned: the grouping rule is script-neutral and the display filter is a view over it.
 * @returns {{groups: GuideGroup[], totals: GuideGroupTotals}}
 */
function collectGuideGroups(volumeHarvests, options = {}) {
  const includeDisplay = options.displaySubset !== false;
  /** @type {Map<string, {reading: string, scripts: Set<string>, rows: number, occurrences: number, forms: Map<string, {form: string, count: number, characterCount: number, byVolume: Map<string, GuideGroupFormOccurrence>}>}>} */
  const groups = new Map();
  const tally = { droppedByReadingLength: 0, droppedBySharedCharacter: 0, skippedWithoutWordOrReading: 0, rows: 0, occurrences: 0 };
  const harvests = Array.isArray(volumeHarvests) ? volumeHarvests : [];

  for (const harvest of harvests) foldVolumeHarvest(groups, harvest, tally);

  /** @type {GuideGroup[]} */
  const kept = [];
  let groupsDroppedBelowFormFloor = 0;
  let groupsDroppedAllSingleCharacter = 0;

  for (const group of groups.values()) {
    if (group.forms.size < GUIDE_GROUP_MIN_FORMS) {
      groupsDroppedBelowFormFloor += 1;
      continue;
    }
    if (![...group.forms.values()].some((form) => form.characterCount >= GUIDE_GROUP_MIN_FORM_CHARS)) {
      groupsDroppedAllSingleCharacter += 1;
      continue;
    }
    const forms = [...group.forms.values()]
      .map((form) => ({
        form: form.form,
        count: form.count,
        characterCount: form.characterCount,
        volumes: [...form.byVolume.keys()].sort(compareVolumeLabels),
        occurrences: [...form.byVolume.values()].sort(compareVolumeLabels),
      }))
      .sort((a, b) => b.count - a.count || (a.form < b.form ? -1 : a.form > b.form ? 1 : 0));
    const volumes = [...new Set(forms.flatMap((form) => form.volumes))].sort(compareVolumeLabels);
    const built = {
      reading: group.reading,
      readingScripts: [...group.scripts].sort(),
      forms,
      formCount: forms.length,
      rowCount: group.rows,
      occurrences: group.occurrences,
      volumes,
    };
    if (includeDisplay) built.displayKatakanaOverHanForm = isGuideGroupKatakanaOverHanForm(built);
    kept.push(built);
  }

  kept.sort(
    (a, b) => b.occurrences - a.occurrences || (a.reading < b.reading ? -1 : a.reading > b.reading ? 1 : 0)
  );

  const candidateVolumes = new Set(kept.flatMap((group) => group.volumes));
  return {
    groups: kept,
    totals: {
      volumes: harvests.length,
      harvestRows: tally.rows,
      harvestOccurrences: tally.occurrences,
      rowsDroppedByReadingLength: tally.droppedByReadingLength,
      rowsDroppedBySharedCharacter: tally.droppedBySharedCharacter,
      rowsSkippedWithoutWordOrReading: tally.skippedWithoutWordOrReading,
      rowsEligible:
        tally.rows - tally.droppedByReadingLength - tally.droppedBySharedCharacter - tally.skippedWithoutWordOrReading,
      groupsSeen: groups.size,
      groupsDroppedBelowFormFloor,
      groupsDroppedWithEveryFormSingleCharacter: groupsDroppedAllSingleCharacter,
      candidateGroups: kept.length,
      candidateRows: kept.reduce((sum, group) => sum + group.rowCount, 0),
      candidateOccurrences: kept.reduce((sum, group) => sum + group.occurrences, 0),
      candidateForms: new Set(kept.flatMap((group) => group.forms.map((form) => form.form))).size,
      candidateVolumes: candidateVolumes.size,
      candidateGroupsForDisplay: includeDisplay ? kept.filter((group) => group.displayKatakanaOverHanForm).length : 0,
    },
  };
}

/**
 * The same fold, reading each volume's harvest file from its own folder.
 *
 * A volume whose harvest is missing (a plain-text source, or an extraction cached before the harvest
 * file existed) contributes no rows and is named in the result rather than guessed at, because
 * `readRubyGuideFile` answers "there is no file here" with null and a reader that treats that as an
 * empty harvest reports a zero it did not measure.
 *
 * @param {Array<{volume: string|number, volumeDir: string, base: string}>} volumes - One entry per volume.
 * @param {{displaySubset?: boolean}} [options] - Passed through to `collectGuideGroups`.
 * @returns {Promise<{groups: GuideGroup[], totals: GuideGroupTotals, missing: string[]}>}
 *   `missing` names the volumes with no harvest file, by their volume label.
 */
async function collectGuideGroupsFromVolumeFolders(volumes, options = {}) {
  const harvests = [];
  /** @type {string[]} */
  const missing = [];
  for (const entry of Array.isArray(volumes) ? volumes : []) {
    const harvest = await readRubyGuideFile(entry.volumeDir, entry.base);
    if (!harvest) {
      missing.push(String(entry.volume));
      continue;
    }
    harvests.push({ volume: entry.volume, guides: harvest.guides });
  }
  const built = collectGuideGroups(harvests, options);
  return { ...built, missing };
}

/**
 * The display subset of a candidate list — the groups plan 07 §4.5 wants in the annotated view.
 *
 * A **view over** `collectGuideGroups`, never a filter applied inside it: the candidate list a later
 * slice files into the record is the script-neutral one.
 *
 * @param {GuideGroup[]} groups - Groups produced by `collectGuideGroups`.
 * @returns {GuideGroup[]} The same group objects the display rule selects.
 */
function guideGroupDisplaySubset(groups) {
  return (Array.isArray(groups) ? groups : []).filter((group) => isGuideGroupKatakanaOverHanForm(group));
}

module.exports = {
  GUIDE_GROUP_MIN_READING_CHARS,
  GUIDE_GROUP_MIN_FORMS,
  GUIDE_GROUP_MIN_FORM_CHARS,
  readingSharesNoCharacterWithForm,
  isGuideGroupKatakanaOverHanForm,
  collectGuideGroups,
  collectGuideGroupsFromVolumeFolders,
  guideGroupDisplaySubset,
};
