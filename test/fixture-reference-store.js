/**
 * test/fixture-reference-store.js — the throwaway series the reference-store suites run on.
 *
 * Every rule `test/fixture-series.js` states applies here and harder, because this layer's
 * whole job is writing into the volume folder: a reference-store test that forgot to point
 * `SERIES_LOCATION` at a fixture would build a real volume's database inside the real
 * corpus, and the corpus is the thing these suites exist to protect (AGENTS.md rule 8,
 * gotcha 69). So this helper does two things a fixture builder here must do:
 *
 *   - it sets `SERIES_LOCATION` to its own folder, and **asserts** the store path it hands
 *     back is inside that folder — a fixture that silently resolved to whatever `.env` says
 *     is a fixture that writes into the books;
 *   - it lays the source out the way the extraction lays it out (`<base>-bundle.meta.json`
 *     plus one file per chapter), because evidence verification reads those files, and a
 *     fixture with no source can only ever test the "no source" refusal.
 *
 * The two volumes exist because copy-forward (slice 3) and ownership across volumes
 * (slice 5) are the tests that need a second one.
 *
 * The fixture *documents* are shaped on purpose, because a fixture that is only tidy can only
 * ever test the tidy case. The glossary has a preamble, a paragraph under one of its sections, a
 * row whose term the book never prints but whose notes quote a line it does (the `governs` case),
 * and a row that can cite neither. The character-voice reference exists in two shapes — complete,
 * and missing two of the three characters the glossary's Characters section registered — so the
 * coverage finding has a planted case rather than a hypothetical one. And one source line is
 * written only with its reading aids between the characters, because a store that can only match
 * strings exactly refuses the case this corpus is full of (gotcha 96).
 *
 * @module test/fixture-reference-store
 */

const fs = require("fs");
const path = require("path");

const { GLOSSARY_HEADER } = require("../utils/reference-store/glossary-adapter");

/**
 * The table header line the fixture glossaries are written with.
 *
 * Built from the store's own constant rather than typed out, because a fixture that spells the labels out
 * pins them in a test file where nothing says they are the artifact's labels. The one place that claim is
 * allowed to be pinned is `test/test-glossary-re-render.js`, which pins the constant itself and proves
 * that every reader of a published glossary drops the header row by POSITION — so a fixture written under
 * any other words still parses into the same rows.
 */
const GLOSSARY_TABLE_HEADER = `| ${GLOSSARY_HEADER.join(" | ")} |`;

/**
 * The separator line that belongs under {@link GLOSSARY_TABLE_HEADER}.
 *
 * Built from the same constant, for the same reason: a fixture that hand-writes `|---|---|---|` beside a
 * header the store writes with four cells is a fixture whose data rows are one cell short of its own table,
 * and the reader is then correct to report it as short.
 */
const GLOSSARY_TABLE_SEPARATOR = `|${GLOSSARY_HEADER.map(() => "---").join("|")}|`;

/** What a fixture row's `Readings` cell says when the fixture record files no written-form rows. */
const NO_READING = "no reading recorded";

/**
 * Where these fixtures live. Each suite passes its own label so they cannot collide, and
 * `test/runner.js` gives each suite a root of its own so a reused label cannot collide either.
 * See `test/fixture-guard.js` for the rule and `test/fixture-series.js` for why the override exists.
 */
const { FIXTURES_ROOT_DEFAULT, FIXTURES_ROOT_ENV, assertSafeFixturesRoot, resolveFixturesRoot } =
  require("./fixture-guard");

const FIXTURES_ROOT = resolveFixturesRoot();

/** The two volumes, in reading order. */
const VOLUMES = [
  { folder: "Test Story(01)", installmentNumber: "01", base: "test_story(1)" },
  { folder: "Test Story(02)", installmentNumber: "02", base: "test_story(2)" },
];

/**
 * Volume 01's source, chapter by chapter.
 *
 * Written so that every term and every quoted phrase the fixture artifacts use really
 * occurs on a known line — which is what lets the tests assert BOTH halves of the evidence
 * rule: a citation that verifies, and a citation that names the wrong line and is refused.
 *
 * @type {Object<string, string[]>} chapter id → lines
 */
const SOURCE_01 = {
  ch0: [
    "# プロローグ",
    "如月雨露は教室に入った。",
    "「さぁ、今日も俺の熱き血潮を迸らせるぜ！」",
    "大賀太陽は笑った。",
    // 担任教師 is the fixture's "in every chapter" character: named in all three, with no voice
    // claim and nothing from the extraction. That is the case the coverage rule's chapter signal
    // exists for — somebody the book keeps pointing at, whom the reference never mentions.
    "担任の教師は黒板を叩いた。",
  ],
  ch1: [
    "# 第一章",
    "三色院菫子は本を読んでいた。",
    "如月雨露は「気にすんな！」と言った。",
    "山田は会計の人である。",
    "「ドンマイだ！ ドンマイ！」と大賀太陽が叫んだ。",
    "担任の教師は出口に立っていた。",
  ],
  ch2: [
    "# 第二章",
    "ジョーロは窓を見た。",
    "「気にすんな！」はジョーロの定型である。",
    // Written only with its reading aids between the characters, exactly as the real books write
    // a name: 秋野桜 is never printed as three bare kanji anywhere in this fixture. This is the
    // line the skeleton rule exists for (review 05 §3.1).
    "秋野あきの桜さくらは廊下で立ち止まった。",
    "担任の教師は何も言わなかった。",
  ],
};

/** Volume 02's source. */
const SOURCE_02 = {
  ch0: [
    "# 第二章",
    "如月雨露は「気にすんな！」と言った。",
    "駱駝はあとがきに書いた。",
  ],
};

/**
 * The canonical glossary (the shape `renderGlossary` writes).
 *
 * Every term in it occurs in volume 01's source, so a clean import is possible; the suites
 * add a row that does NOT occur to exercise the refusal.
 *
 * **Every `Readings` cell is the empty marker**, because no fixture here files a `written_forms` row, and
 * `assertCleanRoundTrip` compares this text against what the record renders — which is the marker on every
 * row. A fixture that printed a guide here would be a fixture whose round trip fails for a reason that has
 * nothing to do with what it is testing. The filled case is exercised where a record is actually given
 * written-form rows: `test/test-glossary-re-render.js` scenario 12 and `test/test-written-forms.js`
 * scenario 14.
 */
const GLOSSARY_01 = `# Glossary

_Canonical renderings for the fixture series._

## Characters

${GLOSSARY_TABLE_HEADER}
${GLOSSARY_TABLE_SEPARATOR}
| 如月雨露 | Kisaragi Amatsuyu | ${NO_READING} | Protagonist; the narrator |
| 大賀太陽 | Oga Taiyo | ${NO_READING} | Best friend since junior high |
| 三色院菫子 | Sanshokuin Sumireko | ${NO_READING} | Library committee |

## Nicknames

${GLOSSARY_TABLE_HEADER}
${GLOSSARY_TABLE_SEPARATOR}
| ジョーロ | Joro | ${NO_READING} | Nickname of Kisaragi Amatsuyu |

## Terms

Parodies and coinages are indexed here by their in-story form.

${GLOSSARY_TABLE_HEADER}
${GLOSSARY_TABLE_SEPARATOR}
| 会計担当 | The Accounting Person | ${NO_READING} | The book says it plainly: 「山田は会計の人である。」 |
`;

/** A glossary row whose term is nowhere in the book: the refusal case. */
const GLOSSARY_UNVERIFIABLE_ROW = `| 存在しない用語 | Not In The Book | ${NO_READING} | This term is never printed |`;

/**
 * The canonical character-voice reference (the shape `renderVoice` writes).
 *
 * Its quotes are real lines of volume 01's source, so the import can verify them.
 */
const VOICE_01 = `# Character Voice Reference

## Characters

### 如月雨露（ジョーロ）【俺人格】

- **Pronouns**: 一人称は俺。
- **Catchphrases**: 「気にすんな！」はジョーロの定型である。

### 大賀太陽（サンちゃん）

- **Catchphrases**: 「ドンマイだ！ ドンマイ！」と大賀太陽が叫んだ。
- **Notes**: 大賀太陽は笑った。

### 三色院菫子

- **Appears in**: 三色院菫子は本を読んでいた。
`;

/**
 * The same reference with two of its three characters missing.
 *
 * This is volume 01's real failure in fixture shape: the character-voice reference lost most of
 * the cast, and an import that only checks "did every line I read verify?" imports it as a
 * clean, small store. The roster the glossary registered is what makes the loss visible, so the
 * integrity query compares the two (review 05 §4 item D).
 */
const VOICE_01_MISSING_CHARACTERS = `# Character Voice Reference

## Characters

### 如月雨露（ジョーロ）【俺人格】

- **Pronouns**: 一人称は俺。
- **Catchphrases**: 「気にすんな！」はジョーロの定型である。
`;

/**
 * The extraction output for volume 01, in the shape `character-voice-new.json` has.
 *
 * The rebuild path (`utils/reference-store/rebuild.js`) reads this file and nothing else, so the
 * fixture has to be the real shape: `type`, `character`, `quirkType`, `description`, `examples`,
 * `formalityLevel`, and the POV variant with `povCategory`, `marker`, `assignedCharacter`,
 * `sectionDescription`. Its quotes are real lines of `SOURCE_01`, including the furigana-only line
 * the skeleton rule exists for, and it names characters three different ways — the roster's own
 * spelling, the spelling with a bracketed nickname, and a spelling nobody in the glossary uses
 * (俺（主人公）) — because that is exactly the case that makes a rebuilt reference fragment its
 * roster if the name is not resolved.
 *
 * @type {Array<Object>}
 */
const EXTRACTION_01 = [
  {
    type: "voice",
    character: "如月雨露（ジョーロ）",
    quirkType: "pronoun",
    description: "First person is 俺 throughout the prologue.",
    examples: ["さぁ、今日も俺の熱き血潮を迸らせるぜ！"],
    formalityLevel: "casual",
  },
  {
    type: "voice",
    character: "俺（主人公）",
    quirkType: "catchphrase",
    description: "Turns down every request with the same four words.",
    examples: ["気にすんな！"],
  },
  {
    type: "voice",
    character: "三色院菫子（パンジー）",
    quirkType: "vocabulary",
    description: "Narration about her is flat and bookish.",
    examples: ["三色院菫子は本を読んでいた。"],
  },
  {
    type: "voice",
    character: "大賀太陽（サンちゃん）",
    quirkType: "catchphrase",
    description: "Encourages people with the same word twice.",
    examples: ["ドンマイだ！ ドンマイ！"],
  },
  {
    type: "voice",
    character: "秋野桜（コスモス）",
    quirkType: "sentenceEnding",
    description: "Her name is only ever printed with its reading aids.",
    examples: ["秋野あきの桜さくらは廊下で立ち止まった。"],
  },
  {
    type: "voice",
    character: "山田",
    quirkType: "vocabulary",
    description: "Named only by what job he has.",
    examples: ["山田は会計の人である。"],
  },
  {
    type: "pov",
    povCategory: "marker",
    marker: "※",
    assignedCharacter: "如月雨露（ジョーロ）",
    sectionDescription: "The break before the second scene keeps the same narrator.",
    examples: ["如月雨露は教室に入った。"],
  },
  {
    type: "pov",
    povCategory: "distance",
    sectionDescription: "Narration borrows the protagonist's vocabulary when it describes the library committee.",
    examples: ["三色院菫子は本を読んでいた。"],
  },
];

/**
 * An extraction claim whose quote is nowhere in the book.
 *
 * The evidence rule has no exception for a rebuild, and this is the claim that proves it.
 */
const EXTRACTION_01_UNVERIFIABLE = {
  type: "voice",
  character: "存在しない人物",
  quirkType: "catchphrase",
  description: "A line the extractor invented, about somebody the book never prints.",
  examples: ["存在しない台詞など無い。"],
};

/**
 * Lay out a two-volume fixture series with a plan of record and extracted sources.
 *
 * Points `SERIES_LOCATION` at the fixture. A suite that then opens a store without naming a
 * series is opening a fixture store, which is the point.
 *
 * @param {string} label - Scenario name, so fixtures do not collide.
 * @param {string} [root] - Where to put it. Defaults to `FIXTURES_ROOT`.
 * @returns {{dir: string, volumes: Array<{folder: string, installmentNumber: string, base: string, dir: string}>}}
 */
function fixtureStoreSeries(label, root) {
  const dir = path.join(resolveFixturesRoot(root), label);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const previousSeries = process.env.SERIES_LOCATION;
  process.env.SERIES_LOCATION = dir;

  for (const volume of VOLUMES) {
    const volumeDir = path.join(dir, volume.folder);
    fs.mkdirSync(volumeDir, { recursive: true });
    const source = volume.installmentNumber === "01" ? SOURCE_01 : SOURCE_02;
    const segments = Object.entries(source).map(([id, lines], index) => {
      const file = `${volume.base}-${id}.md`;
      fs.writeFileSync(path.join(volumeDir, file), lines.join("\n") + "\n", "utf8");
      return { id, file, title: lines[0].replace(/^#\s+/, ""), chars: lines.join("\n").length };
    });
    fs.writeFileSync(
      path.join(volumeDir, `${volume.base}-bundle.meta.json`),
      JSON.stringify({ format: "epub", schema: 6, base: volume.base, wholeFile: `${volume.base}-whole.md`, segments }, null, 2) + "\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(volumeDir, `${volume.base}-whole.md`),
      Object.values(source).flat().join("\n") + "\n",
      "utf8"
    );
  }

  fs.writeFileSync(
    path.join(dir, "translation-target.json"),
    JSON.stringify(
      {
        schema: 2,
        seriesLocation: dir,
        seriesName: "Test Story",
        sourceLanguage: "Japanese",
        targetLanguage: "English",
        generator: "test/fixture-reference-store.js",
        generatedAt: new Date().toISOString(),
        discovery: {
          summary: "fixture",
          confidence: { volumes: 0.9, order: 0.9, sourceLanguage: 0.9 },
          evidence: ["two books"],
          excluded: [],
        },
        volumes: VOLUMES.map((v) => ({
          folder: v.folder,
          sourceFile: `${v.folder}/${v.base}.epub`,
          installmentNumber: v.installmentNumber,
          title: "Test Story",
          integrity: {
            isNarrative: true,
            confidence: 0.9,
            basis: "fixture: continuous prose in one headed section, no packaging pages",
          },
        })),
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  return {
    dir,
    previousSeries,
    volumes: VOLUMES.map((v) => ({ ...v, dir: path.join(dir, v.folder) })),
  };
}

/**
 * The guard every suite calls after it resolves a store path: a reference-store fixture that
 * resolved to the real corpus is not a fixture, it is a write into the books.
 *
 * @param {string} file - The resolved store path.
 * @param {string} fixtureDir - The fixture folder it must be inside.
 * @returns {void}
 */
function assertInsideFixture(file, fixtureDir) {
  const rel = path.relative(path.resolve(fixtureDir), path.resolve(file));
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `test/fixture-reference-store.js: the store path "${file}" is not inside the fixture ` +
        `"${fixtureDir}". A reference-store suite must not be able to reach the real corpus.`
    );
  }
}

module.exports = {
  FIXTURES_ROOT,
  FIXTURES_ROOT_DEFAULT,
  FIXTURES_ROOT_ENV,
  assertSafeFixturesRoot,
  VOLUMES,
  SOURCE_01,
  SOURCE_02,
  GLOSSARY_TABLE_HEADER,
  GLOSSARY_TABLE_SEPARATOR,
  GLOSSARY_NO_READING_CELL: NO_READING,
  GLOSSARY_01,
  GLOSSARY_UNVERIFIABLE_ROW,
  VOICE_01,
  VOICE_01_MISSING_CHARACTERS,
  EXTRACTION_01,
  EXTRACTION_01_UNVERIFIABLE,
  fixtureStoreSeries,
  assertInsideFixture,
};
