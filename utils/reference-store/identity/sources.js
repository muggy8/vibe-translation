/**
 * utils/reference-store/identity/sources.js — the two things that actually STATE a link, read as they are.
 *
 * Two sources, and both of them are **statements**: neither one moves a row, re-keys a name or decides
 * which spelling is the person.
 *
 *   - **the record's own written forms** (plan 07 slice 2). Since slice 1 every volume's pronunciation
 *     markup is filed as written-form rows — one row per (volume, written form, guided reading) — and
 *     `written-forms/rows.js`'s `candidateGroupsInRecord` folds those rows back into the groups the
 *     markup describes: *one guided reading, two or more written forms*. A group is a statement that the
 *     author read these forms as this one word, which is the shape no name-matching rule over the body
 *     text can ever find (plan 07 §2.3: 主人公 guided サンちやん, 好きな女 guided パンジー).
 *
 *     **Which groups state a link is plan 07 §2.9's rule, and it is not re-implemented here.** The
 *     shipped `written-forms/shapes.js`'s `identityBearingGroups` answers it — *one of the group's written
 *     forms is a roster entry, **or the guided reading itself is*** — measured over the 17 real volumes at
 *     18 of the 97 candidate groups with zero false positives on the homophone noise. This file turns the
 *     selected groups into link statements; it does not decide which groups are selected.
 *
 *     **A link joins two names the record publishes, and only two.** `cast_identity_links.a` and `.b` are
 *     foreign keys to `cast(key)` and `PRAGMA foreign_keys` is ON, so a group whose roster holds exactly
 *     one name files no link and is **named** in `guideUnlinkedGroups` instead: すみれこ ← 菫子 / 董子 is a
 *     real group whose 菫子 is not a roster entry, and inventing a roster entry to make the link fileable
 *     would put a name the glossary never published into the roster every later volume measures. That is
 *     a schema-and-roster decision, not a door's, and it is written up rather than taken.
 *
 *   - **the record's own published Characters rows** — the same prose the glossary prints, already inside
 *     `facts` with `section = 'Characters'`. Read through the pinned shape table in `shapes.js`, never
 *     through a general prose rule.
 *
 * Both readers **state what they skipped**. A guided reading that is one small kana away from a roster
 * name (サンちやん / サンちゃん, チエリー / チェリー, ジヨーロ / ジョーロ) is reported as a `nearMiss` and
 * filed as nothing: the fold is a reporting rule, and filing it would be this door deciding a name match
 * on a typography table it has nowhere else (gotcha 121, and plan 07 §2.11's finding that those three
 * spellings are ruby readings the book never prints as body text).
 *
 * @module utils/reference-store/identity/sources
 */

const { GLOSSARY_CHARACTER_SECTION } = require("../glossary-adapter/labels");
const { EXTRACTION_SOURCE_STAGE } = require("../schema");
const { statedLinksInProse } = require("./shapes");
require("../../../types"); // JSDoc type definitions
/** @typedef {import("../../source/guide-groups").GuideGroup} GuideGroup */
/** @typedef {import("../../source/guide-groups").GuideGroupForm} GuideGroupForm */

/**
 * The small-kana fold table: a small kana mapped to the full-size one the roster is likely to print.
 *
 * **Used to REPORT a near miss, never to file a link.** 大賀太陽 guided サンちやん is the book's reading
 * of the roster's サンちゃん; saying so out loud is useful, filing it would be a door that decides a name
 * match on a ャ/ヤ pair, which is a spelling rule this layer does not have anywhere else (gotcha 121).
 *
 * The table is incomplete on purpose and the incompleteness is measured, not inherited: plan 07 §2.11
 * found it missing exactly one entry — ェ (U+30A7) → エ (U+30A8) — which is why チェリー / チエリー did not
 * resolve while the other two near misses already did. The katakana small vowels ァ ィ ゥ ォ and the
 * hiragana small vowels are still absent; adding them is a change to a measured reporting rule and has
 * to come with its own measurement of what starts matching, so they are named here rather than added
 * beside a fix nobody asked for.
 *
 * @type {Object<string, string>}
 */
const SMALL_KANA_TO_FULL = Object.freeze({
  "\u3083": "\u3084", // ゃ → や
  "\u3085": "\u3086", // ゅ → ゆ
  "\u3087": "\u3088", // ょ → よ
  "\u30c3": "\u30c4", // ッ → ツ
  "\u30e7": "\u30e8", // ョ → ヨ
  "\u30e3": "\u30e4", // ャ → ヤ
  "\u30a7": "\u30a8", // ェ → エ — the one entry plan 07 §2.11 measured as missing
});

/**
 * Fold one small-kana spelling onto the one the roster is likely to use.
 *
 * @param {string} text
 * @returns {string}
 */
function foldSmallKana(text) {
  return String(text || "")
    .split("")
    .map((ch) => (SMALL_KANA_TO_FULL[ch] === undefined ? ch : SMALL_KANA_TO_FULL[ch]))
    .join("");
}

/**
 * Volume labels are "01" in some callers and 1 in others; the earliest one is a number either way.
 *
 * @param {Array<string|number>|undefined} volumes
 * @returns {number|null} Null when the list is empty, which a group produced by the shipped fold never is.
 */
function firstVolumeOf(volumes) {
  const nums = (Array.isArray(volumes) ? volumes : []).map(Number).filter((n) => Number.isFinite(n));
  return nums.length ? Math.min(...nums) : null;
}

/**
 * The names one candidate group holds that **this record's roster publishes**.
 *
 * A group's members are its written forms, plus the guided reading **only when the roster already carries
 * that reading as an entry** — which is plan 07 §2.9's second half, and it is what puts パンジー inside the
 * group that guides 虹彩寺菫 with it. A reading the roster does not carry is a reading the book printed
 * over somebody's head, not a name the record publishes, and §2.11 is explicit that filing it as a
 * spelling would be the store inventing a name the book never prints.
 *
 * Each name carries the volumes that printed it **under this reading** and the earliest of them, because
 * the link a pair produces is stated by the volume at which the record could first have stated it.
 *
 * @param {GuideGroup} group - A group produced by `utils/source/guide-groups.js` through `candidateGroupsInRecord`.
 * @param {Set<string>} castKeys - The roster this record holds.
 * @returns {Array<{name: string, via: "form"|"reading", volumes: string[], firstVolume: number|null, occurrences: number}>} In name order.
 */
function guideNamesInGroup(group, castKeys) {
  /** @type {Map<string, {name: string, via: "form"|"reading", volumes: string[], firstVolume: number|null, occurrences: number}>} */
  const byName = new Map();
  for (const form of (group && Array.isArray(group.forms) ? group.forms : [])) {
    const name = String((form && form.form) || "");
    if (!name || !castKeys.has(name)) continue;
    const volumes = (form.volumes || []).map(String);
    byName.set(name, {
      name,
      via: "form",
      volumes,
      firstVolume: firstVolumeOf(volumes),
      occurrences: Number(form.count) || 0,
    });
  }
  const reading = String((group && group.reading) || "");
  if (reading && castKeys.has(reading) && !byName.has(reading)) {
    const volumes = (group.volumes || []).map(String);
    byName.set(reading, {
      name: reading,
      via: "reading",
      volumes,
      firstVolume: firstVolumeOf(volumes),
      occurrences: Number(group.occurrences) || 0,
    });
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * The link statements the record's own written forms state, and the groups they cannot state one for.
 *
 * **Only the identity-bearing groups reach this function** — plan 07 §2.9's rule is applied by the caller
 * through the shipped `identityBearingGroups`, so the homophone groups (美味 / 上手 → うま, 披露 / 疲労 →
 * ひろう) and the pronoun-and-description groups (おれ ← 俺 / 脇役, あなた ← 貴方 / 貴女, わたし, モブ) produce
 * **no identity and no link** and stay in the written-forms table as words, which is the account owner's
 * answer of 2026-10-15: *record the words, no character*.
 *
 * Inside a selected group every pair of published names is stated: the author read all of these forms as
 * this one word, so 虹彩寺菫 and 三色院菫子 and パンジー are one character, and no pair is more canonical
 * than another. That is deliberate — picking one name as the hub would be picking which spelling is the
 * person, which is the question every source in this corpus answers **never** (plan 06 §10.8, and the
 * reason `cast_identities` has no label column).
 *
 * A pair is filed under the **later** of the two names' first volumes: 月見 is guided つきみ in volume 4 and
 * 草見月 in volume 11, so the record could first state the link in volume 11, and volume 11 is the volume
 * whose own book completed it. Filing it under volume 4 would stamp a link with a volume that had never
 * seen half of it.
 *
 * @param {GuideGroup[]} groups - The identity-bearing groups, from `identityBearingGroups`.
 * @param {Set<string>} castKeys - The roster this record holds.
 * @returns {{links: Array<{a: string, b: string, statedBy: string, volume: number, sourceFile: string, reason: string, reading: string, occurrences: number, volumes: string[]}>, unlinkedGroups: Array<{reading: string, rosterName: string, via: string, forms: string[], volumes: string[], rows: number, occurrences: number, because: string}>, namesLinked: number}}
 */
function guideLinksFromGroups(groups, castKeys) {
  /** @type {Array<{a: string, b: string, statedBy: string, volume: number, sourceFile: string, reason: string, reading: string, occurrences: number, volumes: string[]}>} */
  const links = [];
  /** @type {Array<{reading: string, rosterName: string, via: string, forms: string[], volumes: string[], rows: number, occurrences: number, because: string}>} */
  const unlinkedGroups = [];
  let namesLinked = 0;

  for (const group of Array.isArray(groups) ? groups : []) {
    const reading = String((group && group.reading) || "");
    const names = guideNamesInGroup(group, castKeys);
    if (names.length < 2) {
      const only = names[0] || null;
      unlinkedGroups.push({
        reading,
        rosterName: only ? only.name : "",
        via: only ? only.via : "none",
        forms: (group.forms || []).map((form) => form.form),
        volumes: (group.volumes || []).map(String),
        rows: Number(group.rowCount) || 0,
        occurrences: Number(group.occurrences) || 0,
        because:
          `the guided reading ${reading} is printed over ${(group.forms || []).length} written form(s), and this record's ` +
          `roster publishes ${names.length} of them${only ? ` (${only.name})` : ""}. A link joins two names the record ` +
          "publishes, so this group states a character it cannot file one for: the other spellings are written forms the " +
          "book guides and the glossary never entered.",
      });
      continue;
    }
    namesLinked += names.length;
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const x = names[i];
        const y = names[j];
        const [a, b] = [x.name, y.name].sort();
        const volume = Math.max(x.firstVolume === null ? 0 : x.firstVolume, y.firstVolume === null ? 0 : y.firstVolume);
        links.push({
          a,
          b,
          statedBy: "ruby-guide",
          volume,
          sourceFile: `series.db written-forms(${reading})`,
          reason:
            `the record's written forms print ${x.name} (guided ${reading} from volume ${x.firstVolume}) and ` +
            `${y.name} (guided ${reading} from volume ${y.firstVolume}) under the same guided reading — ` +
            `${group.formCount} written form(s) under ${reading}, ${group.occurrences} guided occurrence(s), ` +
            `volumes ${(group.volumes || []).join(", ")}`,
          reading,
          occurrences: Number(group.occurrences) || 0,
          volumes: (group.volumes || []).map(String),
        });
      }
    }
  }
  return { links, unlinkedGroups, namesLinked };
}

/**
 * The guided readings that sit one small kana away from a roster name, and the ones that sit that far from
 * more than one.
 *
 * Asked over **every** candidate group, not only the identity-bearing ones: ジヨーロ ← 玄武 / 親友 / 如雨露 /
 * 主人公 is not selected by §2.9's rule (no form of it and not the reading is a roster entry) and plan 07
 * §2.9 still names it as one of the three near misses. Reporting is free; filing is not.
 *
 * More than one match is **named and left open**, never settled by table order — the same rule gotcha 117
 * draws for two roster entries declaring the same pronoun.
 *
 * @param {GuideGroup[]} groups - Every candidate group the record's rows describe.
 * @param {Set<string>} castKeys - The roster this record holds.
 * @returns {{nearMisses: Array<{reading: string, folded: string, rosterName: string, forms: string[], volumes: string[], occurrences: number}>, ambiguous: Array<{reading: string, folded: string, rosterNames: string[], occurrences: number}>}}
 */
function guideNearMisses(groups, castKeys) {
  /** @type {Array<{reading: string, folded: string, rosterName: string, forms: string[], volumes: string[], occurrences: number}>} */
  const nearMisses = [];
  /** @type {Array<{reading: string, folded: string, rosterNames: string[], occurrences: number}>} */
  const ambiguous = [];
  const roster = [...castKeys];
  for (const group of Array.isArray(groups) ? groups : []) {
    const reading = String((group && group.reading) || "");
    if (!reading || castKeys.has(reading)) continue;
    const folded = foldSmallKana(reading);
    const matches = roster.filter((key) => key !== reading && foldSmallKana(key) === folded);
    if (matches.length > 1) {
      ambiguous.push({
        reading,
        folded,
        rosterNames: matches.slice().sort(),
        occurrences: Number(group.occurrences) || 0,
      });
      continue;
    }
    if (matches.length === 1) {
      nearMisses.push({
        reading,
        folded,
        rosterName: matches[0],
        forms: (group.forms || []).map((form) => form.form),
        volumes: (group.volumes || []).map(String),
        occurrences: Number(group.occurrences) || 0,
      });
    }
  }
  return { nearMisses, ambiguous };
}

/**
 * The record's own published character rows — the same prose the volume's `glossary.md` prints.
 *
 * Two filters, both stated:
 *
 *   - the extraction's candidate copies (`source_stage = 'extract'`) are excluded: they are not record
 *     content anywhere else in this layer either, and a link stated by a chapter-level read is a
 *     different source from the one plan 06 §2.11 measured;
 *   - when `establishedVolume` is given, only the rows **that volume established** are returned. The
 *     record is cumulative, so volume 17's copy holds volume 1's rows too; filing them again from volume
 *     17 would file the same statement seventeen times and stamp it with the wrong volume. Each row is
 *     read once, by the volume that wrote it, and copy-forward carries the link with the row.
 *
 * @param {{db: Object}} ctx - Anything with a `db` holding `facts`.
 * @param {{establishedVolume?: number}} [opts]
 * @returns {Array<{factId: string, term: string, notes: string, section: string, establishedVolume: number}>}
 */
function characterRowsInRecord(ctx, { establishedVolume } = {}) {
  const rows =
    establishedVolume === undefined || establishedVolume === null
      ? ctx.db
          .prepare(
            "SELECT id, examples, body, section, established_volume FROM facts WHERE section = ? AND source_stage <> ? ORDER BY established_volume, ord"
          )
          .all(GLOSSARY_CHARACTER_SECTION, EXTRACTION_SOURCE_STAGE)
      : ctx.db
          .prepare(
            "SELECT id, examples, body, section, established_volume FROM facts WHERE section = ? AND source_stage <> ? AND established_volume = ? ORDER BY ord"
          )
          .all(GLOSSARY_CHARACTER_SECTION, EXTRACTION_SOURCE_STAGE, Number(establishedVolume));
  const out = [];
  for (const row of rows) {
    let examples = [];
    try {
      examples = JSON.parse(row.examples || "[]").map(String);
    } catch {
      examples = [];
    }
    const term = (examples[0] || "").trim();
    if (!term) continue;
    out.push({
      factId: row.id,
      term,
      notes: String(row.body || ""),
      section: row.section,
      establishedVolume: Number(row.established_volume),
    });
  }
  return out;
}

/**
 * The links the record's character rows state, through the pinned shape table.
 *
 * @param {Array<{factId: string, term: string, notes: string}>} rows - From `characterRowsInRecord`.
 * @param {Set<string>} castKeys - The roster this record holds.
 * @returns {{links: Array<{a: string, b: string, statedBy: string, factId: string, shape: string, reason: string}>, excluded: Array<{term: string, otherKey: string, shape: string, because: string}>, rowsNamingAnotherKey: number}}
 */
function characterRowStatedLinks(rows, castKeys) {
  const links = [];
  const excluded = [];
  let rowsNamingAnotherKey = 0;
  for (const row of rows) {
    const { stated, excluded: rejected } = statedLinksInProse({ term: row.term, notes: row.notes }, castKeys);
    if (stated.length || rejected.length) rowsNamingAnotherKey += 1;
    for (const hit of stated) {
      const [a, b] = [row.term, hit.otherKey].sort();
      links.push({
        a,
        b,
        statedBy: "glossary-character-row",
        volume: Number.isInteger(row.establishedVolume) ? row.establishedVolume : undefined,
        factId: row.factId,
        shape: hit.shape,
        reason: `the ${GLOSSARY_CHARACTER_SECTION} row ${row.factId} (established in volume ${row.establishedVolume}) states it through the shape "${hit.shape}": ${row.notes}`,
      });
    }
    for (const miss of rejected) {
      excluded.push({ term: row.term, otherKey: miss.otherKey, shape: miss.shape, because: miss.because });
    }
  }
  return { links, excluded, rowsNamingAnotherKey };
}

/**
 * The written forms the record holds that pair **one roster name with another** through the author's own
 * reading, and that plan 07 §2.9's rule **cannot see**.
 *
 * §2.9 works over *candidate groups*, and a candidate group needs two or more written forms under one
 * reading (`utils/source/guide-groups.js`). A guide the author applies once — 炭印嵐 annotated リリス,
 * 牡丹一華 annotated アネモネ, six times — is not a group, so the shipped fold never reports it, and the
 * door that replaced the old both-sides-on-the-roster rule stopped seeing it too. Measured on the 17 real
 * records: **2 of the old rule's 13 pairs** are of this shape (`test/measure-identities.js` §4b).
 *
 * **This reports. It files nothing.** Filing it would mean widening the candidate set, which is plan 07
 * §2.2's rule and the account owner's, not this door's; refusing to name it would mean the slice quietly
 * lost two links the previous door found. A named row is the half this layer is allowed to do.
 *
 * @param {Array<{volume: number, form: string, reading: string, occurrences: number}>} rows - The record's written-form rows, from `written-forms/rows.js`'s `writtenFormsInRecord`.
 * @param {Set<string>} castKeys - The roster this record holds.
 * @param {Set<string>} groupedReadings - The readings that already form a candidate group, so a pair is not reported twice.
 * @returns {Array<{a: string, b: string, reading: string, form: string, volumes: number[], occurrences: number, because: string}>} One row per (name, name, reading), in pair order.
 */
function guideSoloRosterPairs(rows, castKeys, groupedReadings) {
  /** @type {Map<string, {a: string, b: string, reading: string, form: string, volumes: Set<number>, occurrences: number}>} */
  const byKey = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const form = String((row && row.form) || "");
    const reading = String((row && row.reading) || "");
    if (!form || !reading || form === reading) continue;
    if (!castKeys.has(form) || !castKeys.has(reading)) continue;
    if (groupedReadings.has(reading)) continue;
    const [a, b] = [form, reading].sort();
    const id = `${a}\u0000${b}\u0000${reading}`;
    if (!byKey.has(id)) byKey.set(id, { a, b, reading, form, volumes: new Set(), occurrences: 0 });
    const pair = byKey.get(id);
    if (Number.isInteger(Number(row.volume))) pair.volumes.add(Number(row.volume));
    pair.occurrences += Number(row.occurrences) || 0;
  }
  return [...byKey.values()]
    .map((pair) => ({
      a: pair.a,
      b: pair.b,
      reading: pair.reading,
      form: pair.form,
      volumes: [...pair.volumes].sort((x, y) => x - y),
      occurrences: pair.occurrences,
      because:
        `the record guides ${pair.form} with the reading ${pair.reading}, and this roster publishes BOTH names. ` +
        "That is a stated link, but it is one written form under one reading, so it is not a candidate group and " +
        "plan 07 §2.9's rule has nothing to select. Filed by nothing; named here so the loss is on the record.",
    }))
    .sort((x, y) => (x.a === y.a ? (x.b < y.b ? -1 : 1) : x.a < y.a ? -1 : 1));
}

module.exports = {
  SMALL_KANA_TO_FULL,
  foldSmallKana,
  guideNamesInGroup,
  guideLinksFromGroups,
  guideNearMisses,
  guideSoloRosterPairs,
  characterRowsInRecord,
  characterRowStatedLinks,
};
