#!/usr/bin/env node
/**
 * test/test-guide-groups.js — the reader that turns a volume's pronunciation-guide harvest into
 * candidate name-groups: one reading the author printed over two or more written forms
 * (no AI, no network, no corpus).
 *
 * Plan 07 slice 0. `utils/source/ruby-guides.js` has been writing a harvest beside every volume since
 * the guide-split fix, and nothing had ever read one back. `character-voice/plan/07` §2 is what the
 * live corpus holds; this suite is the pin, and it is the only place these numbers are allowed to be
 * asserted, because a test may not read the 17 real volumes (AGENTS.md rule 8).
 *
 * What it pins, in order:
 *
 *   1. **The grouping rule.** One reading, two written forms, one group — with the counts, the volumes
 *      and the chapters each form appeared in.
 *   2. **The reading-length guard.** A one-character reading over several single kanji is a phonetic
 *      complement (替/嚙/換 all guided か) and is excluded, with the guard named in the totals rather
 *      than the rows simply missing.
 *   3. **The module does not decide.** A planted homophone pair (美味 / 上手 → うま) and a planted name
 *      link (翌桧 / 羽立桧菜 → あすなろ) come out as the same kind of thing, because filtering the noise
 *      is slice 2's job against the record, not this module's job against a hunch.
 *   4. **The multi-character-form guard, and the price of it.** A group whose every form is one
 *      character is dropped — and the shape it drops includes 芝 guided しば beside 縛, where 芝 is a
 *      name the published record holds. That false negative is pinned so a later slice cannot discover
 *      it as a surprise.
 *   5. **A group spans volumes.** The same reading in two volumes is one group carrying both, and a
 *      form's own volume list is not the group's.
 *   6. **A form guided two ways is in two groups.** 嬉 is guided うれ and うれし; the reader keeps both
 *      answers rather than averaging them.
 *   7. **An empty harvest is an answer, not a crash.** 0 rows, 0 groups, no throw — and a volume whose
 *      harvest file is absent is named, not silently counted as empty.
 *   8. **The core is script-neutral.** The candidate list is identical whether or not the display
 *      filter is asked for, and the display filter selects a strict subset of the same objects.
 *   9. **Determinism.** The same input twice produces byte-identical output.
 *
 * Plain `assert`, no framework, CommonJS — like the rest of the project. 0 model calls, 0 reads of the
 * real volumes, 0 writes outside `/tmp/opencode`.
 */

require("./test-home"); // the run's records get a throwaway home (gotcha 69)
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const {
  collectGuideGroups,
  collectGuideGroupsFromVolumeFolders,
  guideGroupDisplaySubset,
  isGuideGroupKatakanaOverHanForm,
  readingSharesNoCharacterWithForm,
  GUIDE_GROUP_MIN_READING_CHARS,
  GUIDE_GROUP_MIN_FORMS,
  GUIDE_GROUP_MIN_FORM_CHARS,
} = require("../utils/source/guide-groups");
const { writeRubyGuideFile, RUBY_GUIDE_FILE_SUFFIX } = require("../utils/source/ruby-guides");

const FIXTURES = path.resolve("/tmp/opencode/guide-groups-tests");

let checks = 0;

/**
 * `assert.ok` that counts itself.
 *
 * @param {boolean} cond - The claim.
 * @param {string} message - What is false when this fails.
 * @returns {void}
 */
function ok(cond, message) {
  checks++;
  assert.ok(cond, message);
}

/**
 * `assert.strictEqual` that counts itself.
 *
 * @param {any} actual - What we got.
 * @param {any} expected - What the rule says.
 * @param {string} message - What is false when this fails.
 * @returns {void}
 */
function same(actual, expected, message) {
  checks++;
  assert.strictEqual(actual, expected, message);
}

/**
 * `assert.deepStrictEqual` that counts itself.
 *
 * @param {any} actual
 * @param {any} expected
 * @param {string} message
 * @returns {void}
 */
function deep(actual, expected, message) {
  checks++;
  assert.deepStrictEqual(actual, expected, message);
}

/**
 * One harvest row, written the way the harvest writes it.
 *
 * @param {string} word - The word as the book prints it, guides already removed.
 * @param {string} reading - What the author said it is read as.
 * @param {number} count - Occurrences.
 * @param {string[]} [chapters] - Segment ids.
 * @returns {import("../types").RubyGuideRow}
 */
function row(word, reading, count, chapters = ["ch0"]) {
  return { word, reading, count, chapters, readingScript: /[\u30a1-\u30ff]/u.test(reading) ? "katakana" : "hiragana", annotated: [{ base: word, reading }] };
}

/**
 * A fresh fixture folder.
 *
 * @param {string} name
 * @returns {string} Absolute path to the (empty) fixture folder.
 */
function fixture(name) {
  const dir = path.join(FIXTURES, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Look one group up by its reading.
 *
 * @param {import("../utils/source/guide-groups").GuideGroup[]} groups
 * @param {string} reading
 * @returns {import("../utils/source/guide-groups").GuideGroup|undefined}
 */
function groupOf(groups, reading) {
  return groups.find((group) => group.reading === reading);
}

/**
 * Look one form up inside a group.
 *
 * @param {import("../utils/source/guide-groups").GuideGroup} group
 * @param {string} form
 * @returns {import("../utils/source/guide-groups").GuideGroupForm|undefined}
 */
function formOf(group, form) {
  return group.forms.find((entry) => entry.form === form);
}

// ─── 1. the grouping rule ─────────────────────────────────────────────────────

/**
 * One reading, two written forms: one group, and everything the harvest knew about each form.
 *
 * @returns {void}
 */
function testGroupingRule() {
  const built = collectGuideGroups([
    {
      volume: "01",
      guides: [row("虹彩寺菫", "パンジー", 4, ["ch1", "ch2"]), row("三色院菫子", "パンジー", 2, ["ch3"]), row("玄武", "ジヨーロ", 1)],
    },
  ]);

  same(built.totals.candidateGroups, 1, "one reading over two forms is one group, and the third reading is not a group");
  const group = groupOf(built.groups, "パンジー");
  ok(group, "the group is findable by its reading");
  same(group.forms.length, 2, "it holds both written forms");
  same(group.formCount, 2, "and says how many");
  same(group.occurrences, 6, "occurrences are summed over the forms");
  same(group.rowCount, 2, "and so are the harvest rows it folded");
  deep(group.forms.map((form) => form.form), ["虹彩寺菫", "三色院菫子"], "forms are ordered by how often the author used them");
  deep(formOf(group, "虹彩寺菫").occurrences[0].chapters, ["ch1", "ch2"], "a form keeps the chapters the harvest recorded");
  deep(group.volumes, ["01"], "and the group keeps the volumes it came from");
  same(group.readingScripts.length, 1, "the reading's own script is reported");
  same(group.readingScripts[0], "katakana", "read out of the harvest's own field, not re-derived here");

  const single = groupOf(built.groups, "ジヨーロ");
  ok(!single, "one form guided one way is a word with its pronunciation, not a candidate");
  same(built.totals.groupsDroppedBelowFormFloor, 1, "and the totals name the guard that dropped it");
  console.log("  1. one reading over two written forms is one group, with its counts, volumes and chapters");
}

// ─── 2. the reading-length guard ──────────────────────────────────────────────

/**
 * The phonetic-complement shape: one mora printed over several lone kanji.
 *
 * @returns {void}
 */
function testPhoneticComplementsAreExcluded() {
  same(GUIDE_GROUP_MIN_READING_CHARS, 2, "the floor is 2 characters");
  const built = collectGuideGroups([
    {
      volume: "01",
      guides: [row("替", "か", 12), row("嚙", "か", 7), row("換", "か", 5), row("取", "と", 9), row("遂", "と", 4)],
    },
  ]);
  same(built.groups.length, 0, "か over 替 / 嚙 / 換 is not a candidate group, even though it is three distinct written forms");
  same(built.totals.rowsDroppedByReadingLength, 5, "and every one of those rows is counted by the guard that dropped it");
  same(built.totals.groupsSeen, 0, "so no group is ever formed from them");
  same(built.totals.candidateOccurrences, 0, "and nothing is reported as an occurrence");

  // The same reading at the floor is kept, which is what makes the guard a length rule and not a ban.
  // (可愛 is the multi-character form that carries it past the other guard — the real corpus's かわ
  // group is exactly this shape.)
  const kept = collectGuideGroups([{ volume: "01", guides: [row("乾", "かわ", 4), row("渇", "かわ", 5), row("可愛", "かわ", 5)] }]);
  same(kept.totals.candidateGroups, 1, "a 2-character reading over three forms is kept");
  same(groupOf(kept.groups, "かわ").formCount, 3, "all three forms, the lone kanji included");
  console.log("  2. a one-character reading over several lone kanji is excluded, and the guard says so");
}

// ─── 3. the module generates candidates and decides nothing ───────────────────

/**
 * A homophone pair and a name link, side by side, treated identically.
 *
 * @returns {void}
 */
function testItDoesNotDecide() {
  const built = collectGuideGroups([
    {
      volume: "01",
      guides: [
        row("美味", "うま", 113), // homophone noise
        row("上手", "うま", 104),
        row("翌桧", "あすなろ", 4), // the shape plan 07 calls an identity link
        row("羽立桧菜", "あすなろ", 1),
        row("呆然", "ぼうぜん", 19), // another homophone pair
        row("茫然", "ぼうぜん", 4),
      ],
    },
  ]);
  same(built.totals.candidateGroups, 3, "the noise and the link are the same kind of thing to this reader");
  const noise = groupOf(built.groups, "うま");
  const link = groupOf(built.groups, "あすなろ");
  ok(noise && link, "both are present");
  same(noise.forms.length, link.forms.length, "with the same number of forms");
  same(noise.formCount, 2, "the homophone pair has two");
  same(link.formCount, 2, "and so has the name link");
  deep(noise.forms.map((form) => form.form), ["美味", "上手"], "the noise is kept whole, not trimmed");
  deep(link.forms.map((form) => form.form), ["翌桧", "羽立桧菜"], "and so is the link");
  ok(!("identity" in noise) && !("isIdentityLink" in noise), "no group carries a verdict");
  ok(!("identity" in link) && !("isIdentityLink" in link), "not even the one that looks like a name");
  console.log("  3. 美味/上手 → うま and 翌桧/羽立桧菜 → あすなろ come out identically: the reader generates candidates");
}

// ─── 4. the multi-character-form guard, and what it costs ─────────────────────

/**
 * A group whose every form is a single character is dropped — including the one case where a form is
 * a name the published record holds.
 *
 * @returns {void}
 */
function testEveryFormSingleCharacter() {
  same(GUIDE_GROUP_MIN_FORM_CHARS, 2, "at least one form must be 2 characters long");
  const built = collectGuideGroups([
    {
      volume: "01",
      guides: [row("恐", "おそ", 112), row("遅", "おそ", 33), row("襲", "おそ", 28), row("芝", "しば", 416), row("縛", "しば", 10), row("撫子", "なでしこ", 105), row("赤井撫子", "なでしこ", 1)],
    },
  ]);
  same(built.totals.groupsSeen, 3, "three readings reach the group guards");
  same(built.totals.groupsDroppedWithEveryFormSingleCharacter, 2, "two of them are every-form-single-character: おそ and しば");
  same(built.totals.candidateGroups, 1, "and only なでしこ survives");
  ok(groupOf(built.groups, "なでしこ"), "the group with a multi-character form is kept");
  ok(!groupOf(built.groups, "しば"), "しば (← 芝 / 縛) is dropped");
  ok(!groupOf(built.groups, "おそ"), "おそ (← 恐 / 遅 / 襲) is dropped");
  // The cost, pinned rather than smoothed over: 芝 is a name the published record holds, and this
  // guard drops the group it belongs to. plan 07 §2.7 records it; a later slice that widens the
  // guard has to move this assertion on purpose.
  ok(
    built.groups.every((group) => group.forms.some((form) => form.characterCount >= GUIDE_GROUP_MIN_FORM_CHARS)),
    "every kept group has at least one multi-character form — the guard is exactly as wide as it says"
  );
  console.log("  4. every-form-single-character groups are dropped, and the 芝 / 縛 false negative is pinned");
}

// ─── 5. a group spans volumes ─────────────────────────────────────────────────

/**
 * The same reading printed in two volumes is one group, and each form knows which volumes printed it.
 *
 * @returns {void}
 */
function testGroupsSpanVolumes() {
  const built = collectGuideGroups([
    { volume: "01", guides: [row("三色院菫子", "パンジー", 3, ["ch1"])] },
    { volume: "02", guides: [row("三色院菫子", "パンジー", 5, ["ch0", "ch4"]), row("虹彩寺菫", "パンジー", 7, ["ch2"])] },
    { volume: "17", guides: [row("虹彩寺菫", "パンジー", 2, ["ch3"])] },
  ]);
  same(built.totals.candidateGroups, 1, "one reading across three volumes is one group, not three");
  const group = groupOf(built.groups, "パンジー");
  deep(group.volumes, ["01", "02", "17"], "and the group records every volume it appears in, in book order");
  same(group.occurrences, 17, "summing across them");
  const form = formOf(group, "虹彩寺菫");
  deep(form.volumes, ["02", "17"], "while the form knows only the volumes that printed it");
  deep(form.occurrences.map((entry) => [entry.volume, entry.count]), [["02", 7], ["17", 2]], "per volume, so a later slice can date it");
  deep(formOf(group, "三色院菫子").volumes, ["01", "02"], "and the other form knows its own");
  console.log("  5. one reading across three volumes is one group, and each form keeps its own volume list");
}

// ─── 6. a form guided two ways is in two groups ───────────────────────────────

/**
 * 嬉 guided うれ and うれし is two answers, and the reader keeps both.
 *
 * @returns {void}
 */
function testAFormUnderTwoReadings() {
  const built = collectGuideGroups([
    {
      volume: "01",
      guides: [row("嬉", "うれ", 669), row("嬉々", "うれ", 3), row("嬉", "うれし", 2), row("喜々", "うれし", 4)],
    },
  ]);
  same(built.totals.candidateGroups, 2, "two readings, two groups");
  const short = groupOf(built.groups, "うれ");
  const long = groupOf(built.groups, "うれし");
  ok(short && long, "both are kept");
  ok(formOf(short, "嬉"), "嬉 is under うれ");
  ok(formOf(long, "嬉"), "and the same form is under うれし — the reader does not pick one");
  same(formOf(short, "嬉").count, 669, "with its own count under the first");
  same(formOf(long, "嬉").count, 2, "and its own under the second");
  same(built.totals.candidateForms, 3, "distinct forms are counted across groups, so 嬉 is one form, not two");
  console.log("  6. a form guided two ways appears under both readings, each with its own count");
}

// ─── 7. an empty harvest, and a missing one ───────────────────────────────────

/**
 * 0 rows is an answer. A volume with no harvest file is a named fact.
 *
 * @returns {Promise<void>}
 */
async function testEmptyAndMissing() {
  const empty = collectGuideGroups([{ volume: "01", guides: [] }]);
  same(empty.groups.length, 0, "an empty harvest produces no groups");
  same(empty.totals.candidateGroups, 0, "and reports 0 rather than throwing");
  same(empty.totals.harvestRows, 0, "with the row count it actually saw");
  same(empty.totals.groupsSeen, 0, "and no groups seen");

  const noneAtAll = collectGuideGroups([]);
  same(noneAtAll.groups.length, 0, "no volumes at all is still an answer");
  same(noneAtAll.totals.volumes, 0, "and it says it read no volumes");

  // A volume whose harvest file is absent is named, not silently treated as an empty harvest:
  // readRubyGuideFile answers "no file here" with null, and a reader that folds that into [] reports
  // a zero it never measured.
  const dir = fixture("missing-harvest");
  const withFile = path.join(dir, "volume-01");
  const withoutFile = path.join(dir, "volume-02");
  fs.mkdirSync(withFile, { recursive: true });
  fs.mkdirSync(withoutFile, { recursive: true });
  await writeRubyGuideFile({
    volumeDir: withFile,
    base: "book(1)",
    sourceFile: "book(1).epub",
    bundleSchema: 8,
    occurrences: [
      { word: "翌桧", reading: "あすなろ", annotations: 1, annotated: [{ base: "翌桧", reading: "あすなろ" }], chapter: "ch1" },
      { word: "羽立桧菜", reading: "あすなろ", annotations: 1, annotated: [{ base: "羽立桧菜", reading: "あすなろ" }], chapter: "ch2" },
    ],
  });
  const read = await collectGuideGroupsFromVolumeFolders([
    { volume: "01", volumeDir: withFile, base: "book(1)" },
    { volume: "02", volumeDir: withoutFile, base: "book(2)" },
  ]);
  same(read.missing.length, 1, "the volume with no harvest file is named");
  same(read.missing[0], "02", "by its volume label");
  same(read.totals.volumes, 1, "while the totals count only the volumes it actually read");
  same(read.totals.candidateGroups, 1, "and the volume that had a file produced its group");
  ok(read.groups[0].forms.some((form) => form.form === "羽立桧菜"), "from the real file, through the real reader");
  same(read.groups[0].forms.length, 2, "both forms came back out of the harvest file");
  ok(read.groups[0].forms.some((form) => form.form === "翌桧"), "翌桧 is one of them");
  ok(read.groups[0].forms.some((form) => form.form === "羽立桧菜"), "and so is 羽立桧菜");
  ok(fs.existsSync(path.join(withFile, `book(1)${RUBY_GUIDE_FILE_SUFFIX}`)), "the fixture wrote a real harvest file to read back");

  // A malformed row must not take the whole fold down with it.
  const ragged = collectGuideGroups([{ volume: "01", guides: [{ word: "", reading: "パンジー", count: 3, chapters: [] }, { word: "虹彩寺菫", reading: "", count: 1 }, { word: "三色院菫子", reading: "パンジー" }] }]);
  same(ragged.totals.harvestRows, 3, "the rows are counted");
  same(ragged.groups.length, 0, "and none of them can form a group");
  same(ragged.totals.rowsSkippedWithoutWordOrReading, 2, "two name no word or no reading, and are counted as skipped rather than dropped by a guard");
  same(ragged.totals.rowsEligible, 1, "only the third row reaches the group guards");
  console.log("  7. an empty harvest answers 0, a missing file is named, and a ragged row does not throw");
}

// ─── 8. the core is script-neutral ────────────────────────────────────────────

/**
 * The candidate list does not move when the display filter is asked for, and the display filter is a
 * view over it.
 *
 * @returns {void}
 */
function testScriptNeutralCore() {
  const harvests = [
    {
      volume: "01",
      guides: [
        row("虹彩寺菫", "パンジー", 9, ["ch1"]), // katakana reading, Han form: the display shape
        row("三色院菫子", "パンジー", 4, ["ch2"]),
        row("翌桧", "あすなろ", 4, ["ch3"]), // hiragana reading, Han form: NOT the display shape
        row("羽立桧菜", "あすなろ", 1, ["ch4"]),
        row("Alpha", "ベータ", 2, ["ch5"]), // a Latin form guided in katakana
        row("別名", "ベータ", 3, ["ch6"]),
      ],
    },
  ];
  const withFlag = collectGuideGroups(harvests, { displaySubset: true });
  const withoutFlag = collectGuideGroups(harvests, { displaySubset: false });
  const byDefault = collectGuideGroups(harvests);

  same(withoutFlag.groups.length, withFlag.groups.length, "the candidate list is the same size with the display filter off");
  deep(withoutFlag.groups.map((group) => group.reading), withFlag.groups.map((group) => group.reading), "and the same groups, in the same order");
  deep(byDefault.groups.map((group) => group.reading), withFlag.groups.map((group) => group.reading), "and the same by default");
  same(withoutFlag.totals.candidateOccurrences, withFlag.totals.candidateOccurrences, "with the same occurrences");
  ok(withoutFlag.groups.every((group) => !("displayKatakanaOverHanForm" in group)), "with the filter off the flag is not even on the object");

  const selected = guideGroupDisplaySubset(withFlag.groups);
  ok(selected.length < withFlag.groups.length, "the display filter selects a strict subset");
  deep(selected.map((group) => group.reading), ["パンジー", "ベータ"], "the katakana-over-Han ones, and the Latin form does not stop them");
  ok(selected.every((group) => withFlag.groups.includes(group)), "the subset holds the same objects, not copies");
  ok(!groupOf(withFlag.groups, "あすなろ").displayKatakanaOverHanForm, "a hiragana reading over a Han form is not the display shape");
  ok(groupOf(withFlag.groups, "あすなろ") !== undefined, "while it is still a candidate — the display rule never removes a candidate");
  same(withFlag.totals.candidateGroupsForDisplay, selected.length, "and the total agrees with the view");

  // The core rule itself names no script: the same two strings in two different writing systems are
  // grouped by the same test.
  ok(readingSharesNoCharacterWithForm("パンジー", "虹彩寺菫"), "katakana over Han shares nothing");
  ok(readingSharesNoCharacterWithForm("あすなろ", "翌桧"), "hiragana over Han shares nothing");
  ok(readingSharesNoCharacterWithForm("beta", "別名"), "latin over Han shares nothing");
  ok(readingSharesNoCharacterWithForm("ベータ", "Alpha"), "and the form's script is not what the rule asks");
  ok(!readingSharesNoCharacterWithForm("かわい", "可愛い"), "a reading that reuses a character of the word is refused");
  ok(!readingSharesNoCharacterWithForm("", "任意"), "an empty reading is not a guide");
  ok(readingSharesNoCharacterWithForm("かま", "蒲田"), "and an ordinary per-character reading passes — measured, this guard is nearly inert on a guide-free harvest");
  console.log("  8. the grouping rule names no writing system, and the display filter is a view that removes nothing from it");
}

// ─── 9. determinism ───────────────────────────────────────────────────────────

/**
 * The same input twice produces the same bytes, so a measurement can be re-run rather than remembered.
 *
 * @returns {void}
 */
function testDeterminism() {
  const guides = [row("美味", "うま", 113), row("上手", "うま", 104), row("旨", "うま", 2), row("蒲公英", "たんぽぽ", 6), row("蒲田公英", "たんぽぽ", 3), row("手下", "たんぽぽ", 1)];
  const shuffled = [...guides].reverse();
  const a = collectGuideGroups([{ volume: "01", guides }]);
  const b = collectGuideGroups([{ volume: "01", guides: shuffled }]);
  deep(JSON.stringify(a), JSON.stringify(b), "input order does not change the output");
  const c = collectGuideGroups([{ volume: "01", guides }]);
  deep(JSON.stringify(a), JSON.stringify(c), "and a second pass is byte-identical");
  deep(a.groups.map((group) => group.reading), ["うま", "たんぽぽ"], "groups are ordered by occurrences, then by reading");
  deep(groupOf(a.groups, "たんぽぽ").forms.map((form) => form.form), ["蒲公英", "蒲田公英", "手下"], "forms by count, then by the form itself");

  // A harvest that lists the same pair twice inside one volume cannot double a count.
  const doubled = collectGuideGroups([{ volume: "01", guides: [row("美味", "うま", 10), row("上手", "うま", 5), row("美味", "うま", 7, ["ch9"])] }]);
  const group = groupOf(doubled.groups, "うま");
  same(group.forms.length, 2, "the duplicate is folded into the same form");
  same(formOf(group, "美味").count, 17, "its counts added");
  deep(formOf(group, "美味").occurrences[0].chapters, ["ch0", "ch9"], "and its chapters merged");
  console.log("  9. the fold is deterministic, ordered by count, and a repeated pair folds rather than doubling");
}

/**
 * Run every scenario.
 *
 * @returns {Promise<void>}
 */
async function main() {
  fs.rmSync(FIXTURES, { recursive: true, force: true });
  fs.mkdirSync(FIXTURES, { recursive: true });
  console.log("test-guide-groups: reading a volume's pronunciation guides as candidate name-groups");
  testGroupingRule();
  testPhoneticComplementsAreExcluded();
  testItDoesNotDecide();
  testEveryFormSingleCharacter();
  testGroupsSpanVolumes();
  testAFormUnderTwoReadings();
  await testEmptyAndMissing();
  testScriptNeutralCore();
  testDeterminism();
  console.log(`\ntest-guide-groups: ${checks} checks, 0 model calls, 0 reads of the real volumes.`);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
