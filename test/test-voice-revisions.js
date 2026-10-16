#!/usr/bin/env node
/**
 * test/test-voice-revisions.js — a later volume replaces a voice claim this record published, the old row
 * survives, and the render says which answer it stands behind now and which one it stood behind before.
 *
 * Plan 06 slice 6. The acceptance line it has to meet, verbatim from the plan:
 *
 *   "A planted development in a fixture volume changes what the render calls current, and the old row
 *    survives byte-identical. Reuses `markSuperseded`; adds no new verb."
 *
 * "Byte-identical" is checked in two parts, because the honest answer is narrower than the phrase.
 * `markSuperseded` writes `status` **and** `updated_at` and nothing else. So: every **content** column of
 * the replaced row — body, evidence, examples, key, aspect, label, section, span, owner, `row_version`,
 * `ord` — is identical before and after, and the columns that do change are exactly those two. Both
 * numbers are printed rather than one of them being quoted as proof.
 *
 * Scenarios:
 *
 *   1. **the acceptance line** — volume 1 files a claim, volume 2's book contradicts it, the door files a
 *      replacement, and the render changes what it calls current. The replaced row's content digest is
 *      identical; the two columns that moved are named; `row_version` did not move.
 *   2. **current versus arc** — the replaced claim is gone from the render's bullets, gone from the
 *      chapter's known-facts block, gone from the axis query, and present in exactly one place: the arc
 *      line. Plus the volume-bounded half: at volume 1 the old claim is still the current one.
 *   3. **idempotence** — the same revision twice files one row, in one batch and across two runs, and the
 *      record and the rendered file come out byte-identical.
 *   4. **the quote rule** — a revision quoting a line this volume's book does not print is refused, and
 *      the record is unchanged in every table.
 *   5. **the refusals that keep the door narrow** — eleven shapes, each one proven to store nothing.
 *   6. **the audit, before and after** — the coverage rule counts what it counts today, and the arc lines
 *      the render added do not trip the artifact's own shape checks.
 *   7. **the cap is a cap and it is named** — more replaced answers than the section may print, and the
 *      line that says how many were left out.
 *   8. **what this slice did not add** — no finding kind, no store verb, no setting, no environment knob,
 *      no stage that calls the door, and no span written onto a published row.
 *
 * Fixtures only, under `/tmp/opencode/series-fixtures`. Nothing here reads the real 17 volumes or any file
 * under the series folder, and nothing here reaches a model (AGENTS.md rule 8, gotcha 69, gotcha 124).
 *
 * Plain `assert`, no framework, CommonJS — like the rest of the project.
 */

require("./test-home"); // the run's records get a throwaway home (gotcha 69)
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { assertInsideFixture, FIXTURES_ROOT } = require("./fixture-reference-store");
const rs = require("../utils/reference-store");
const { FINDING_LEVELS } = require("../utils/postmortem/levels");
const { MANIFEST_SCHEMA } = require("../intake/config");
const { readModuleLayer } = require("./module-layer");

const {
  openReferenceStore,
  copyForwardStore,
  rebuildVoiceFromExtraction,
  renderRebuiltVoice,
  auditVolumeRecord,
  fileVoiceRevision,
  importVoiceRevisions,
  voiceClaimChainForAxis,
  voiceClaimInForceForAxis,
  supersededVoiceClaims,
  claimsAnsweringAxis,
  parseVoiceMarkdown,
  MAX_REBUILD_ARC_LINES_PER_CHARACTER,
  MAX_REBUILD_BULLET_CHARS,
  REGISTER_MANIFEST_KEY,
  UPDATABLE_FIELDS,
} = rs;

// The root comes from the fixture helper, which honours AI_CLIENT_TEST_FIXTURES_ROOT: the runner
// gives every suite a root of its own, so a label reused by another suite cannot delete this one's
// fixture mid-run. Unset (a person running this suite by hand) means the same shared default as ever.
// FIXTURES_ROOT is destructured from the require above.

let checks = 0;
/** Count one assertion and run it. @param {boolean|void} condition @param {string} message */
function ok(condition, message) {
  checks++;
  assert.ok(condition, message);
}
/** @param {any} a @param {any} b @param {string} message */
function same(a, b, message) {
  checks++;
  assert.deepStrictEqual(a, b, message);
}

// ─── The fixture ──────────────────────────────────────────────────────────────

/**
 * Two books, one plan of record, whatever register block the scenario is testing.
 *
 * Spanish-shaped on purpose, like the slice-3 and slice-5 suites: a revision door proved only against
 * fixtures in the language the code happened to be written next to would prove the design works for that
 * language and nothing else. The distinction this fixture plants — how somebody addresses a superior — is
 * the one the declaration is asked to name, not one the pipeline knows.
 *
 * @param {string} label - Scenario name, so fixtures do not collide.
 * @param {{register?: any, seriesName?: string}} opts
 * @returns {{dir: string, volumes: Array<{folder: string, base: string, installmentNumber: string, dir: string}>}}
 */
function laySeries(label, { register, seriesName = "Revision Proof" } = {}) {
  const dir = path.join(FIXTURES_ROOT, label);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const books = [
    { installmentNumber: "01", folder: `${seriesName}(01)`, base: `${seriesName.toLowerCase().replace(/\s+/g, "_")}(1)`, lines: BOOK_01 },
    { installmentNumber: "02", folder: `${seriesName}(02)`, base: `${seriesName.toLowerCase().replace(/\s+/g, "_")}(2)`, lines: BOOK_02 },
  ];

  for (const volume of books) {
    const volumeDir = path.join(dir, volume.folder);
    fs.mkdirSync(volumeDir, { recursive: true });
    const segments = Object.entries(volume.lines).map(([id, lines]) => {
      const file = `${volume.base}-${id}.md`;
      fs.writeFileSync(path.join(volumeDir, file), lines.join("\n") + "\n", "utf8");
      return { id, file, title: lines[0].replace(/^#\s+/, ""), chars: lines.join("\n").length };
    });
    fs.writeFileSync(
      path.join(volumeDir, `${volume.base}-bundle.meta.json`),
      JSON.stringify({ format: "epub", schema: 8, base: volume.base, wholeFile: `${volume.base}-whole.md`, segments }, null, 2) + "\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(volumeDir, `${volume.base}-whole.md`),
      Object.values(volume.lines).flat().join("\n") + "\n",
      "utf8"
    );
  }

  const manifest = {
    schema: MANIFEST_SCHEMA,
    seriesLocation: dir,
    seriesName,
    sourceLanguage: "Spanish",
    targetLanguage: "English",
    generator: "test/test-voice-revisions.js",
    generatedAt: new Date().toISOString(),
    discovery: {
      summary: "fixture: two books, continuous prose, one headed chapter each",
      confidence: { volumes: 0.9, order: 0.9, sourceLanguage: 0.9 },
      evidence: ["fixture"],
      excluded: [],
    },
    volumes: books.map((volume) => ({
      folder: volume.folder,
      sourceFile: `${volume.folder}/${volume.base}.epub`,
      installmentNumber: volume.installmentNumber,
      title: seriesName,
      integrity: { isNarrative: true, confidence: 0.9, basis: "fixture: continuous prose in one headed section" },
    })),
  };
  if (register !== undefined) manifest[REGISTER_MANIFEST_KEY] = register;
  fs.writeFileSync(path.join(dir, "translation-target.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

  return { dir, volumes: books.map((volume) => ({ ...volume, dir: path.join(dir, volume.folder) })) };
}

/** Volume 1: Marina addresses a superior with the formal second person. */
const BOOK_01 = {
  ch0: [
    "# Capítulo 1",
    "Marina entró en el aula sin golpear.",
    "Usted está equivocado, señor director —Marina no bajó la voz.",
    "Renata cerró la puerta sin decir nada.",
  ],
};

/** Volume 2: the same character, the same superior, the familiar second person. The development. */
const BOOK_02 = {
  ch0: [
    "# Capítulo 2",
    "Marina entró en la oficina sin golpear.",
    "Usted está equivocado, señor director —Marina no bajó la voz.",
    "—¿Podés firmar esto, jefe? —Marina no bajó la voz esta vez.",
    "Renata cerró la puerta sin decir nada.",
  ],
};

/** Two questions this series declares for itself. */
const REGISTER = {
  axes: [
    {
      id: "treatment",
      asks: "How does this character address somebody they take to be above them?",
      values: ["formal-usted", "informal-vos"],
      scope: "character-addressee",
      evidence: ["capítulo 1: Marina se dirige al director con usted"],
    },
    {
      id: "voseo",
      asks: "Which second-person form does this character use with somebody they know?",
      values: ["vos", "tú", "usted"],
      scope: "character",
      evidence: ["capítulo 2: Marina pide a su jefe con vos"],
    },
  ],
  note: "Two questions: deference, and which second-person form.",
};

/** What volume 1's reading pass filed. */
const ENTRIES_01 = [
  {
    type: "voice",
    character: "Marina",
    quirkType: "formality",
    description: "Answers a superior with usted and never softens it.",
    examples: ["Usted está equivocado, señor director"],
    axis: "treatment",
    value: "formal-usted",
  },
  {
    type: "voice",
    character: "Marina",
    quirkType: "vocabulary",
    description: "Names the room she is in by what it is used for.",
    examples: ["Marina entró en el aula sin golpear."],
    axis: "voseo",
    value: "usted",
  },
  {
    type: "voice",
    character: "Renata",
    quirkType: "sentenceending",
    description: "Closes the door and says nothing at all.",
    examples: ["Renata cerró la puerta sin decir nada."],
  },
];

/** The same claims with the axis pair taken off — what a series with no declaration files. */
const ENTRIES_NO_AXIS = ENTRIES_01.map((entry) => {
  const copy = { ...entry };
  delete copy.axis;
  delete copy.value;
  return copy;
});

/** Volume 2's own reading pass. Deliberately axis-less: it has to file in a fixture whose series declared
 *  questions and in one that declared none, and it is not the claim under revision. */
const ENTRIES_02 = [
  {
    type: "voice",
    character: "Renata",
    quirkType: "sentenceending",
    description: "Stays silent in the office too, and leaves the door open this time.",
    examples: ["Renata cerró la puerta sin decir nada."],
  },
];

/** The development volume 2's own book prints. */
const REVISION = {
  key: "Marina",
  axis: "treatment",
  axisValue: "informal-vos",
  body: "Addresses the man she reports to with vos, and does not soften it.",
  quote: "—¿Podés firmar esto, jefe?",
  reason: "capítulo 2: the formal second person is gone where the same superior is present",
};

/**
 * Open one handle on a fixture volume's record, and refuse to go anywhere else.
 *
 * @param {{dir: string}} series @param {number} volume @param {string} folder @param {string} stage
 * @returns {Object}
 */
function openFixtureStore(series, volume, folder, stage) {
  const store = openReferenceStore({ volume, folder, seriesDir: series.dir, stage });
  assertInsideFixture(store.file, series.dir);
  return store;
}

/**
 * Build the state every scenario starts from: volume 1 filed and sealed, volume 2's record carried from it,
 * its own chapters registered, and its own reading pass filed through the same door the stage uses.
 *
 * Volume 2 gets its own claims because that is what a real volume 2 is: a record carrying the earlier
 * volumes' claims *and* holding its own. It is also what makes the coverage question askable — the rule
 * needs the volume's reference to have been mirrored into its record, and a volume that filed nothing has
 * no mirror, so an audit of it answers "not yet" rather than a number.
 *
 * @param {string} label @param {{register?: any, entries?: Array<Object>, entries2?: Array<Object>}} [opts]
 * @returns {{series: Object, v2: Object, copy: Object, entries: Array<Object>}}
 */
function buildTwoVolumes(label, opts = {}) {
  const { entries = ENTRIES_01, entries2 = ENTRIES_02 } = opts;
  // `register: undefined` has to mean "this series wrote no register block", not "use the default one" —
  // a destructuring default cannot tell those two apart, and the difference is the whole scenario.
  const register = Object.prototype.hasOwnProperty.call(opts, "register") ? opts.register : REGISTER;
  const series = laySeries(label, { register });
  const [first, second] = series.volumes;

  const candidateStore = openFixtureStore(series, 1, first.folder, "extract");
  const v1 = openFixtureStore(series, 1, first.folder, "rebuild");
  v1.registerChaptersFromSource();
  const filed = rebuildVoiceFromExtraction(v1, entries, { volume: 1, candidateStore });
  assert.ok(filed.ok, `volume 1's claims were refused: ${JSON.stringify(filed.refused.map((r) => r.because))}`);
  v1.sealVolume(1);
  candidateStore.close();
  v1.close();

  const copy = copyForwardStore({
    fromVolume: 1,
    toVolume: 2,
    seriesDir: series.dir,
    fromFolder: first.folder,
    toFolder: second.folder,
  });
  assert.ok(copy.ok, `the record did not carry forward: ${JSON.stringify(copy.refusal)}`);
  copy.closeDest();

  const v2 = openFixtureStore(series, 2, second.folder, "rebuild");
  v2.registerChaptersFromSource();
  if (entries2.length) {
    const candidateStore2 = openFixtureStore(series, 2, second.folder, "extract");
    const filed2 = rebuildVoiceFromExtraction(v2, entries2, { volume: 2, candidateStore: candidateStore2 });
    assert.ok(filed2.ok, `volume 2's own claims were refused: ${JSON.stringify(filed2.refused.map((r) => r.because))}`);
    candidateStore2.close();
  }
  return { series, v2, copy, entries };
}

// ─── Measurement helpers ──────────────────────────────────────────────────────

/**
 * One facts row, every column.
 * @param {Object} store @param {string} id
 * @returns {Object}
 */
function factRow(store, id) {
  return store.db.prepare("SELECT * FROM facts WHERE id = ?").get(id);
}

/**
 * The columns of a row that are neither a clock nor the supersession mark.
 *
 * Split out because the acceptance line says "byte-identical" and the door's own verb writes `status` and
 * `updated_at` and nothing else. The claim is about the row's **content** — the body, the evidence, the
 * examples, who it belongs to, what it answers, and its version number — and the honest test says which
 * columns moved rather than pretending none did.
 *
 * @param {Object} row
 * @returns {Object<string, any>}
 */
function contentOf(row) {
  const out = {};
  for (const [column, value] of Object.entries(row)) {
    if (column === "updated_at" || column === "status") continue;
    out[column] = value;
  }
  return out;
}

/**
 * Which columns of one row differ between two reads of it.
 * @param {Object} before @param {Object} after
 * @returns {string[]}
 */
function columnsThatMoved(before, after) {
  return Object.keys(after).filter((column) => JSON.stringify(before[column]) !== JSON.stringify(after[column]));
}

/**
 * Every table in one record, as one digest. Read off `sqlite_master` rather than a hand-written list, so a
 * table nobody thought to name is still covered.
 * @param {Object} store
 * @returns {Object<string, string>}
 */
function recordDigest(store) {
  const tables = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name);
  /** @type {Object<string, string>} */
  const out = {};
  for (const table of tables) out[table] = JSON.stringify(store.db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
  return out;
}

/**
 * Row counts over one record.
 * @param {Object} store
 * @returns {Object<string, number>}
 */
function rowCounts(store) {
  const one = (sql) => store.db.prepare(sql).get().n;
  return {
    facts: one("SELECT COUNT(*) n FROM facts"),
    cast: one("SELECT COUNT(*) n FROM cast"),
    superseded: one("SELECT COUNT(*) n FROM facts WHERE status = 'superseded'"),
    axisBearing: one("SELECT COUNT(*) n FROM facts WHERE axis IS NOT NULL"),
    adopted: one("SELECT COUNT(*) n FROM facts WHERE source_stage = 'rebuild'"),
    candidates: one("SELECT COUNT(*) n FROM facts WHERE source_stage = 'extract'"),
  };
}

/**
 * The `### ` section of one rendered character, or null when the render has none for them.
 * @param {string} markdown @param {string} display
 * @returns {string|null}
 */
function sectionOf(markdown, display) {
  const lines = String(markdown).split("\n");
  const start = lines.findIndex((line) => line.trim() === `### ${display}`);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.trim().startsWith("### "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

/** Volume 1 with TWO live answers to the one question, linked to nothing. */
const AMBIGUOUS_ENTRIES = [
  ...ENTRIES_01,
  {
    type: "voice",
    character: "Marina",
    quirkType: "formality",
    description: "Answers a superior with usted in one scene and usted in another, differently worded.",
    examples: ["Usted está equivocado, señor director"],
    axis: "treatment",
    value: "formal-usted",
  },
];

/**
 * The arc lines one rendered section prints.
 * @param {string} section
 * @returns {string[]}
 */
function arcLinesOf(section) {
  return String(section || "")
    .split("\n")
    .filter((line) => line.startsWith("_Earlier in this record"));
}

// ─── 1. the acceptance line ───────────────────────────────────────────────────

const acceptance = (() => {
  console.log("1. the acceptance line: a planted development changes what the render calls current");

  const built = buildTwoVolumes("voice-revision-acceptance");
  const { series, v2 } = built;
  const before = factRow(v2, voiceClaimInForceForAxis(v2, { key: "Marina", axis: "treatment" }).inForce.id);

  const result = fileVoiceRevision(v2, REVISION);
  ok(result.ok, `the revision was refused: ${result.refusal ? result.refusal.because : "unknown"}`);
  ok(result.filed, "it filed a row");
  ok(result.replaced, "and it names the row it replaced");
  same(result.replaced.id, before.id, "the row it names is the one that was in force");
  same(result.filed.supersedes, before.id, "the new row points at the old one");
  same(result.filed.status, "active", "the new row is the record's answer");
  same(result.filed.axis, "treatment", "it answers the same declared question");
  same(result.filed.axis_value, "informal-vos", "with the new answer");
  same(result.filed.aspect, before.aspect, "and the replaced row's aspect — the door cannot move a claim to another kind");
  same(result.filed.label, before.label, "or its label");
  same(result.filed.owner_volume, 2, "it belongs to the volume that read the line");
  same(result.evidence.length, 1, "cited to one line of this volume's own text");
  same(result.evidence[0].volume, 2, "of volume 2");

  const after = factRow(v2, before.id);

  // The replaced row: content identical, `row_version` unmoved, exactly two columns changed.
  same(contentOf(after), contentOf(before), "the replaced row's CONTENT is identical — body, evidence, examples, key, aspect, label, span, owner, ord, row_version");
  same(columnsThatMoved(before, after), ["status", "updated_at"], "and the only columns that moved are the two `markSuperseded` is allowed to write");
  same(after.status, "superseded", "the mark is the one the store's narrow door writes");
  same(after.row_version, before.row_version, "`row_version` did not move: this is not an edit to a published row");
  same(after.applies_to_volume, null, "no validity span was written onto the published row — retirement is a property of the link, not a column");
  ok(after.body !== REVISION.body, "the old claim's own words are still the old claim's words");
  ok(after.evidence === JSON.stringify(JSON.parse(after.evidence)), "and its evidence is still its own evidence, unchanged");

  // The render.
  const rendered = renderRebuiltVoice(v2, { volume: 2 });
  const marina = sectionOf(rendered.markdown, "Marina");
  ok(marina, "Marina's section is in the file");
  ok(marina.includes(REVISION.body), "the render calls the NEW claim current");
  ok(!marina.includes(`- **${before.label}**: ${before.body}`), "and the old claim is not a bullet");
  ok(marina.includes(before.body), "the old claim IS in the section — as the arc line");
  ok(marina.includes("_Earlier in this record"), "which is what it is called in the file");
  ok(marina.includes(`from volume ${before.applies_from_volume} until volume 2`), "and it names both volumes");

  const entry = rendered.characters.find((c) => c.key === "Marina");
  same(entry.bullets, 2, "Marina still has 2 current bullets (treatment revised, voseo untouched)");
  same(entry.arc, 1, "and 1 replaced answer printed");
  same(entry.arcOmitted, 0, "with nothing left out");

  console.log(
    `  row ${before.id}: content identical, ${JSON.stringify(columnsThatMoved(before, after))} moved, row_version ${before.row_version} → ${after.row_version}; ` +
    `render: ${entry.bullets} current bullet(s), ${entry.arc} arc line(s)`
  );

  v2.close();
  return { series, result, before, after, rendered };
})();

// ─── 2. current versus arc ────────────────────────────────────────────────────

{
  console.log("2. what is current, what is only in the arc, and what volume 1 still sees");

  const { series, result } = acceptance;
  const [first, second] = series.volumes;

  // Volume 2's own record: the axis query.
  const axisStore = openFixtureStore(series, 2, second.folder, "rebuild");
  const axis = claimsAnsweringAxis(axisStore, { axis: "treatment", key: "Marina", volume: 2 });
  ok(axis.ok, "the axis query answered");
  same(axis.claimCount, 1, "one claim answers 'how does she address a superior' as of volume 2");
  same(axis.rows.map((row) => row.body), [REVISION.body], "and it is the replacement, not the claim it replaced");
  axisStore.close();

  // The chapter's known-facts block: the replaced claim is refused, and the refusal is counted.
  const chapterText = fs.readFileSync(path.join(second.dir, `${second.base}-ch0.md`), "utf8");
  const known = openFixtureStore(series, 2, second.folder, "rebuild");
  const facts = known.chapterKnownFacts({ chapterText, volume: 2 });
  ok(facts.ok, "the chapter block ran");
  same(facts.claimsReplaced, 1, "1 claim was refused because it is no longer the record's current one");
  const shown = facts.characters.flatMap((c) => c.claims.map((claim) => claim.body));
  ok(!shown.includes(acceptance.before.body), "and the replaced claim is not in the block a chapter is shown");
  ok(shown.includes(REVISION.body), "the replacement is");
  known.close();

  // The arc read, on its own.
  const arcStore = openFixtureStore(series, 2, second.folder, "rebuild");
  const arc = supersededVoiceClaims(arcStore, { volume: 2 });
  same(arc.length, 1, "the record has 1 replaced voice claim");
  same(arc[0].id, acceptance.before.id, "and it is the one the door replaced");
  same(arc[0].replacedBy.map((row) => row.id), [result.filed.id], "read through `supersededBy`, not by walking `supersedes`");
  same(arc[0].appliesFromVolume, 1, "it held from volume 1");
  same(arc[0].replacedBy[0].appliesFromVolume, 2, "and was replaced in volume 2");

  // The chain, and the volume-bounded half: at volume 1 the OLD claim is still the current one.
  const chain = voiceClaimChainForAxis(arcStore, { key: "Marina", axis: "treatment", volume: 1 });
  same(chain.length, 1, "as of volume 1 the chain holds 1 row — the replacement postdates that volume");
  same(voiceClaimInForceForAxis(arcStore, { key: "Marina", axis: "treatment", volume: 1 }).inForce.id, acceptance.before.id,
    "and volume 1's answer is still the claim volume 2 replaced: a record cannot rewrite its own past");
  const chainAt2 = voiceClaimChainForAxis(arcStore, { key: "Marina", axis: "treatment", volume: 2 });
  same(chainAt2.length, 2, "as of volume 2 it holds both");
  same(voiceClaimInForceForAxis(arcStore, { key: "Marina", axis: "treatment", volume: 2 }).inForce.id, result.filed.id,
    "and the one in force is the replacement");
  same(supersededVoiceClaims(arcStore, { volume: 1 }).length, 0, "and volume 1's arc is empty — the replacement had not happened yet");
  arcStore.close();

  console.log(
    `  volume 2: axis query ${axis.claimCount} claim, chapter block refused ${facts.claimsReplaced}, arc ${arc.length}; ` +
    `volume 1: chain ${chain.length}, arc 0`
  );
}

// ─── 3. idempotence ───────────────────────────────────────────────────────────

{
  console.log("3. the same revision files one row, in one batch and across two runs");

  const built = buildTwoVolumes("voice-revision-idempotence");
  const { series, v2 } = built;
  const [first, second] = series.volumes;

  const firstBatch = importVoiceRevisions(v2, [REVISION, REVISION]);
  ok(firstBatch.ok, "the batch reported no refusal");
  same(firstBatch.filed.length, 1, "two identical proposals filed ONE row");
  same(firstBatch.alreadyFiled, ["Marina / treatment"], "and the second is reported as already settled, not refused");
  same(firstBatch.refused, [], "nothing was refused");

  const afterFirst = recordDigest(v2);
  const renderFirst = renderRebuiltVoice(v2, { volume: 2 }).markdown;

  const secondBatch = importVoiceRevisions(v2, [REVISION]);
  same(secondBatch.filed.length, 0, "a second pass files nothing");
  same(secondBatch.alreadyFiled.length, 1, "and says so");
  same(recordDigest(v2), afterFirst, "the whole record is unchanged — every table, every row");
  same(renderRebuiltVoice(v2, { volume: 2 }).markdown, renderFirst, "and the file it would publish is byte-identical");

  // And the sharper half: a later chapter of the same volume that proposes the same replacement again.
  const third = fileVoiceRevision(v2, { ...REVISION, body: REVISION.body });
  ok(third.ok && third.alreadyFiled, "the same claim from a second chapter is recognised as this volume's own decision");
  same(recordDigest(v2), afterFirst, "and it files nothing");

  // A DIFFERENT claim from the same volume does file — idempotence is per answer, not per character.
  const countsBefore = rowCounts(v2);
  const fourth = fileVoiceRevision(v2, {
    key: "Marina",
    axis: "voseo",
    axisValue: "vos",
    body: "With the people she knows she uses vos, and only with them.",
    quote: "—¿Podés firmar esto, jefe?",
  });
  ok(fourth.ok && !fourth.alreadyFiled, "a different question answered differently files");
  const countsAfter = rowCounts(v2);
  same(countsAfter.facts, countsBefore.facts + 1, "and the record grew by exactly that row");
  same(countsAfter.cast, countsBefore.cast, "with no new roster entry");

  console.log(`  2 identical proposals → ${firstBatch.filed.length} row; a re-run → ${secondBatch.filed.length} rows; digest identical`);
  v2.close();
}

// ─── 4. the quote rule ────────────────────────────────────────────────────────

{
  console.log("4. the load-bearing guard: the quote has to be a line this volume's book prints");

  const built = buildTwoVolumes("voice-revision-quote");
  const { v2 } = built;
  const digestBefore = recordDigest(v2);
  const countsBefore = rowCounts(v2);

  const refused = fileVoiceRevision(v2, {
    ...REVISION,
    quote: "Marina pidió al director que firmara el formulario en la sala de juntas",
  });
  ok(!refused.ok, "the revision was refused");
  same(refused.refusal.rule, "voice-revision-quote-not-in-source", "by the quote rule");
  ok(refused.refusal.because.includes("no line of volume 2's source text"), refused.refusal.because);
  same(refused.filed, null, "no row was filed");
  same(recordDigest(v2), digestBefore, "and the record is unchanged in every table — no row, no cast entry, no candidate");
  same(rowCounts(v2), countsBefore, "including the counts");

  // An empty quote is the same refusal, not a silent pass.
  const empty = fileVoiceRevision(v2, { ...REVISION, quote: "" });
  ok(!empty.ok, "a revision with no quote is refused too");
  same(empty.refusal.rule, "voice-revision-quote-not-in-source", "by the same rule");
  same(recordDigest(v2), digestBefore, "and it stored nothing");

  // A quote from VOLUME 1's book is not evidence for a volume 2 decision.
  const fromVolume1 = fileVoiceRevision(v2, { ...REVISION, quote: "Marina entró en el aula sin golpear." });
  ok(!fromVolume1.ok, "a line from the earlier volume's book does not justify replacing the earlier volume's claim here");
  same(fromVolume1.refusal.rule, "voice-revision-quote-not-in-source", "refused by the same rule");
  same(recordDigest(v2), digestBefore, "and nothing was stored");

  console.log("  3 revisions quoting lines this volume does not print: 0 rows filed, record digest identical");
  v2.close();
}

// ─── 5. the refusals ──────────────────────────────────────────────────────────

{
  console.log("5. every refusal the door can give, and that each one stores nothing");

  /** @type {Array<{name: string, entry: Object, expect: string, opts?: Object, stage?: string}>} */
  const shapes = [
    { name: "no character", entry: { key: "", axis: "treatment", axisValue: "informal-vos", body: "x", quote: "—" }, expect: "voice-revision-has-no-character" },
    { name: "no axis named", entry: { key: "Marina", body: "Something changed.", quote: "—¿Podés firmar esto, jefe?" }, expect: "voice-revision-has-no-axis" },
    { name: "no claim", entry: { key: "Marina", axis: "treatment", axisValue: "informal-vos", body: "", quote: "—¿Podés firmar esto, jefe?" }, expect: "voice-revision-has-no-claim" },
    { name: "a claim this record does not hold", entry: { key: "Renata", axis: "treatment", axisValue: "informal-vos", body: "Renata addresses a superior with vos.", quote: "—¿Podés firmar esto, jefe?" }, expect: "voice-revision-of-unknown-claim" },
    { name: "a character this record does not hold", entry: { key: "Nobody In This Book", axis: "treatment", axisValue: "informal-vos", body: "x", quote: "—¿Podés firmar esto, jefe?" }, expect: "voice-revision-of-unknown-claim" },
    { name: "the same words as the claim in force", entry: { ...REVISION, axisValue: "informal-vos", body: "Answers a superior with usted and never softens it." }, expect: "voice-revision-restates-the-current-claim" },
    { name: "an answer this series did not declare", entry: { ...REVISION, axisValue: "vos" }, expect: "register-value-outside-declared-set" },
    { name: "a question this series did not declare", entry: { ...REVISION, axis: "deference" }, expect: "register-axis-not-declared" },
    { name: "an axis named with no answer", entry: { ...REVISION, axisValue: "" }, expect: "register-axis-answer-has-no-value" },
    { name: "prose the writer never finished", entry: { ...REVISION, body: "Addresses her superior with vos (need to recheck which chapters)." }, expect: "voice-revision-claim-carries-unfinished-prose" },
    { name: "two live answers, linked to nothing", entry: { ...REVISION }, expect: "voice-revision-claim-ambiguous", ambiguous: true },
  ];

  let refused = 0;
  for (const shape of shapes) {
    const built = buildTwoVolumes(`voice-revision-refusal-${shape.name.replace(/[^a-z]+/gi, "-").toLowerCase()}`, {
      entries: shape.ambiguous ? AMBIGUOUS_ENTRIES : ENTRIES_01,
    });
    const digestBefore = recordDigest(built.v2);
    const result = fileVoiceRevision(built.v2, shape.entry);
    ok(!result.ok, `${shape.name}: refused`);
    same(result.refusal.rule, shape.expect, `${shape.name} → ${shape.expect}`);
    ok(result.refusal.because.length > 30, `${shape.name}: the refusal says why`);
    ok(result.refusal.fix.length > 5, `${shape.name}: the refusal names what to do instead`);
    same(recordDigest(built.v2), digestBefore, `${shape.name}: nothing was stored — every table unchanged`);
    refused++;
    built.v2.close();
  }

  // The handle guards.
  const built = buildTwoVolumes("voice-revision-handle-guards");
  const digestBefore = recordDigest(built.v2);
  const extractHandle = openFixtureStore(built.series, 2, built.series.volumes[1].folder, "extract");
  const wrongScope = fileVoiceRevision(extractHandle, REVISION);
  ok(!wrongScope.ok, "an extraction-scoped handle is refused");
  same(wrongScope.refusal.rule, "voice-revision-needs-a-document-scope", "because a row filed there is invisible to every reader of the record");
  const wrongVolume = fileVoiceRevision(built.v2, REVISION, { volume: 1 });
  ok(!wrongVolume.ok, "a handle filing for another volume is refused");
  same(wrongVolume.refusal.rule, "voice-revision-not-this-volumes-turn", "because ownership comes from the handle and the attribution would disagree with it");
  same(recordDigest(built.v2), digestBefore, "and neither stored anything");
  extractHandle.close();
  built.v2.close();

  // A series that declared no question, and a series that declared none on purpose.
  for (const [name, register] of [["absent", undefined], ["empty", { axes: [], note: "This book draws no register distinction." }]]) {
    const noDeclaration = buildTwoVolumes(`voice-revision-declaration-${name}`, { register, entries: ENTRIES_NO_AXIS });
    const digest = recordDigest(noDeclaration.v2);
    const result = fileVoiceRevision(noDeclaration.v2, REVISION);
    ok(!result.ok, `a series with a ${name} declaration cannot revise a voice claim`);
    same(result.refusal.rule, "voice-revision-needs-a-register-declaration", `${name}: the door names the door that opens it`);
    ok(result.refusal.fix.includes("npx gulp discover"), `${name}: the refusal names the intake as the door`);
    same(recordDigest(noDeclaration.v2), digest, `${name}: nothing was stored`);
    noDeclaration.v2.close();
  }

  console.log(`  ${refused} entry-shaped refusals + 2 handle refusals + 2 declaration refusals: 0 rows filed, every digest identical`);
}

// ─── 6. the audit, before and after ───────────────────────────────────────────

{
  console.log("6. the coverage rule counts what it counts today, and the arc lines pass the shape checks");

  const built = buildTwoVolumes("voice-revision-audit");
  const { v2 } = built;

  const beforeRender = renderRebuiltVoice(v2, { volume: 2 });
  const beforeAudit = auditVolumeRecord(v2, {
    title: "Volume 02",
    file: "character-voice.md",
    markdown: beforeRender.markdown,
    document: "character-voice",
  });

  const result = fileVoiceRevision(v2, REVISION);
  ok(result.ok, "the revision filed");

  const afterRender = renderRebuiltVoice(v2, { volume: 2 });
  const afterAudit = auditVolumeRecord(v2, {
    title: "Volume 02",
    file: "character-voice.md",
    markdown: afterRender.markdown,
    document: "character-voice",
  });

  same(afterAudit.coverage, beforeAudit.coverage, "the coverage rule's answer is identical — a superseded row still says something about a character");
  same(afterAudit.coverageAsked, beforeAudit.coverageAsked, "and it was asked in the same way");
  same(afterAudit.presence, beforeAudit.presence, "including the presence measurement the coverage answer is refined by");
  same(afterAudit.counts.cast, beforeAudit.counts.cast, "the roster is the same size");
  same(afterAudit.counts.cast_presence, beforeAudit.counts.cast_presence, "the presence rows are the same number");
  same(afterAudit.counts.facts, beforeAudit.counts.facts + 1, "and the only table that grew is `facts`, by exactly the replacement row");
  same(afterAudit.axes.claimsAnswering, beforeAudit.axes.claimsAnswering,
    "the axis inventory answers the SAME number of claims: the replaced one stopped being an answer at the moment the replacement became one");
  same(afterAudit.axes.claimsAnsweringNone, beforeAudit.axes.claimsAnsweringNone, "and the same number answering none");
  same(beforeAudit.axes.byAxis.find((a) => a.axis === "treatment").valuesAnswered, [{ value: "formal-usted", claims: 1 }],
    "before: the record answered 'how does she address a superior' with the formal form");
  same(afterAudit.axes.byAxis.find((a) => a.axis === "treatment").valuesAnswered, [{ value: "informal-vos", claims: 1 }],
    "after: it answers the same question with the familiar one, and the old answer is no longer an answer");
  same(afterAudit.findings.map((f) => `${f.severity} ${f.kind}`).sort(), beforeAudit.findings.map((f) => `${f.severity} ${f.kind}`).sort(),
    "while the audit raises no new finding about a record that gained a revision");
  same(afterAudit.highFindings, [], "no HIGH finding");

  // The arc lines are prose the artifact-shape check has to survive.
  const drafting = afterAudit.findings.filter((f) => f.kind === "reference-claim-carries-unfinished-prose");
  same(drafting, [], "the arc lines trip none of drafting.js's three shapes");
  const longest = afterRender.markdown.split("\n").reduce((max, line) => Math.max(max, line.length), 0);
  ok(longest <= MAX_REBUILD_BULLET_CHARS, `the longest line of the rendered file is ${longest} characters, inside the ${MAX_REBUILD_BULLET_CHARS}-character cap`);
  same(afterRender.truncated, beforeRender.truncated, "and nothing had to be truncated");

  /**
   * **The arc line survives being read back, and its position is what makes it survive.**
   *
   * `renderRebuiltVoice` writes a file `importVoice` reads back, so a line the render adds is only safe
   * if the parser keeps it out of a published claim's body. `parseVoiceMarkdown` treats a non-bullet line
   * **after** the first bullet as a continuation of that bullet and joins it onto the body; the same line
   * **before** the first bullet is the section's own prose (`lead`). The render puts the arc before the
   * bullets. Both halves are measured here: the shipped order, and the order that would have corrupted a
   * claim, so the rule is a fact on disk rather than a comment.
   */
  const parsed = parseVoiceMarkdown(afterRender.markdown);
  const marina = parsed.characters.find((character) => character.key === "Marina");
  ok(marina, "the importer reads Marina's section back");
  same(marina.entries.length, 2, "and it reads back the SAME 2 claims the render published — the arc line did not become a third");
  ok(!marina.entries.some((entry) => entry.body.includes("Earlier in this record")),
    "no published claim's body carries the arc line");
  ok(marina.lead.some((line) => line.startsWith("_Earlier in this record")),
    "the arc line comes back as the section's own prose, which is where the render put it");
  same(marina.entries.map((entry) => entry.body), afterRender.markdown.split("\n").filter((line) => line.startsWith("- **") && sectionOf(afterRender.markdown, "Marina").includes(line)).map((line) => line.replace(/^-\s+\*\*[^*]+\*\*:\s*/, "")),
    "and every bullet body is exactly what the render printed, character for character");

  // The counterfactual, measured rather than asserted: the same line moved after the bullets.
  const section = sectionOf(afterRender.markdown, "Marina");
  const arcLine = arcLinesOf(section)[0];
  const bullets = section.split("\n").filter((line) => line.startsWith("- **"));
  // `sectionOf` returns what follows the `### ` heading, so the replacement must not repeat the heading.
  const moved = afterRender.markdown.replace(section, ["", ...bullets, arcLine, ""].join("\n"));
  ok(moved !== afterRender.markdown, "the counterfactual file is the shipped one with the arc line moved below the bullets");
  const reparsed = parseVoiceMarkdown(moved);
  const marinaMoved = reparsed.characters.find((character) => character.key === "Marina");
  same(marinaMoved.entries.length, 2, "the moved file still parses as 2 claims — nothing announces the damage");
  ok(marinaMoved.entries[1].body.includes("Earlier in this record"),
    "but the arc line is now INSIDE the second claim's body: the importer read it as a continuation of that bullet");
  ok(marinaMoved.entries[1].body !== marina.entries[1].body,
    "and that body is no longer the body the record published — which is the defect the placement exists to prevent");

  console.log(
    `  coverage ${JSON.stringify(beforeAudit.coverage)} → ${JSON.stringify(afterAudit.coverage)}; findings ${beforeAudit.findings.length} → ${afterAudit.findings.length}; ` +
    `longest line ${longest}; round trip: ${marina.entries.length} claims + ${marina.lead.length} lead line(s), and the same line after the bullets lands inside "${marinaMoved.entries[1].body.slice(0, 40)}…"`
  );
  v2.close();
}

// ─── 7. the cap ───────────────────────────────────────────────────────────────

{
  console.log("7. the arc is capped, and the cap names what it left out");

  const built = buildTwoVolumes("voice-revision-arc-cap");
  const { v2 } = built;

  const bodies = [
    "Addresses the man she reports to with vos, and does not soften it.",
    "Uses vos with him in front of other people, and usted when they are alone.",
    "Switches back to the formal second person the day the office changes.",
    "Then drops it again, in the corridor, with no ceremony at all.",
    "And uses it once more, only when she is asking for something.",
    "Then not again for the rest of the volume.",
    "And one more time, in the last chapter, when nobody is watching.",
  ];
  const filed = [];
  for (const body of bodies) {
    const one = fileVoiceRevision(v2, { ...REVISION, body });
    ok(one.ok, `the revision "${body.slice(0, 24)}…" filed: ${one.refusal ? one.refusal.because : ""}`);
    filed.push(one);
  }
  same(filed.filter((r) => r.alreadyFiled).length, 0, "seven different answers, seven rows — none recognised as already filed");

  const rendered = renderRebuiltVoice(v2, { volume: 2 });
  const entry = rendered.characters.find((c) => c.key === "Marina");
  const section = sectionOf(rendered.markdown, "Marina");
  const arcLines = arcLinesOf(section);
  same(entry.arc, MAX_REBUILD_ARC_LINES_PER_CHARACTER, `the section prints at most ${MAX_REBUILD_ARC_LINES_PER_CHARACTER} replaced answers`);
  same(arcLines.length, entry.arc, "and that is how many lines the file actually carries");
  same(entry.arcOmitted, bodies.length - MAX_REBUILD_ARC_LINES_PER_CHARACTER,
    "and reports how many it left out: seven rows are superseded (volume 1's claim plus six of the seven volume 2 answers), six may be printed");
  ok(section.includes(`${entry.arcOmitted} more earlier answer(s)`), "the file says so too, in the section itself");
  same(supersededVoiceClaims(v2, { volume: 2 }).length, bodies.length, "while the record still holds all of them — the cap is on the file, not on the record");
  ok(arcLines[0].includes(ENTRIES_01[0].description), "the oldest replaced answer — volume 1's own claim — is the first line printed");
  const omitted = bodies[MAX_REBUILD_ARC_LINES_PER_CHARACTER - 1];
  ok(!arcLines.some((line) => line.includes(omitted)), `the ${MAX_REBUILD_ARC_LINES_PER_CHARACTER}th replaced answer is not printed`);
  ok(supersededVoiceClaims(v2, { volume: 2 }).some((row) => row.body === omitted), "and the record still holds it, which is what the 'more …' line points at");
  ok(section.includes(`- **Formality level**: ${bodies[bodies.length - 1]}`), "the newest answer is the current bullet, not an arc line");

  console.log(`  ${bodies.length} replaced answers in the record → ${entry.arc} printed, ${entry.arcOmitted} named as left out`);
  v2.close();
}

// ─── 8. what this slice did not add ───────────────────────────────────────────

{
  console.log("8. what this slice did not add");

  // No finding kind. The level table is the same 70 it was before this door existed.
  same(Object.keys(FINDING_LEVELS).length, 70, "the finding level table is still 70 kinds — this door reports refusals, not findings");
  const doorText = `${readModuleLayer(path.resolve(__dirname, ".."), "utils/reference-store/voice-revision.js")}`;
  for (const kind of Object.keys(FINDING_LEVELS)) {
    ok(!doorText.includes(`"${kind}"`), `the door does not emit the finding kind "${kind}"`);
  }
  ok(!doorText.includes("reportVolumeFindings"), "and it does not reach the finding channel");

  // No new verb onto a published row.
  const factsBarrel = Object.keys(require("../utils/reference-store/facts")).sort();
  same(factsBarrel.includes("markSuperseded"), true, "`markSuperseded` is the door this one calls");
  same(UPDATABLE_FIELDS.includes("appliesToVolume"), true, "and the update door that could write a span is untouched — this door does not use it");
  const fileLayer = readModuleLayer(path.resolve(__dirname, ".."), "utils/reference-store/voice-revision.js");
  same(/updateOwnFact|deleteOwnFact|challengeFact|resolveChallenge/.test(fileLayer), false,
    "the door calls no other verb onto a row it does not own");
  same(/UPDATE\s+facts|DELETE\s+FROM\s+facts/i.test(fileLayer), false, "and it issues no write statement of its own beyond the insert");

  // No setting, no knob.
  same(/\bprocess\.env\b/.test(fileLayer), false, "the door reads no environment variable");
  same(/\breadBoolEnv|readNumberEnv|readStringEnv\b/.test(fileLayer), false, "and no settings helper");

  // No stage calls the door, and it is not in any step list or prompt. The read half has exactly one
  // pipeline reader — the render — and that is the whole point of splitting the layer in two.
  const doorCallers = [];
  const readReaders = [];
  const SKIP = new Set(["node_modules", "test", "docs", "plan", "epub_source", "hooks", "calibration", "test-series"]);
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name)) walk(full);
      } else if (entry.name.endsWith(".js")) {
        const rel = path.relative(process.cwd(), full);
        const text = fs.readFileSync(full, "utf8");
        if (/\b(fileVoiceRevision|importVoiceRevisions)\b/.test(text)) doorCallers.push(rel);
        if (/\bsupersededVoiceClaims\b/.test(text)) readReaders.push(rel);
      }
    }
  };
  walk(process.cwd());
  const allowedDoorCallers = new Set([
    "utils/reference-store/voice-revision/file.js",
    "utils/reference-store/voice-revision.js",
  ]);
  const outside = doorCallers.filter((file) => !allowedDoorCallers.has(file));
  same(outside, [], "no stage, no command, no step list and no prompt calls the door — the call baselines are therefore unmoved");
  same(readReaders.slice().sort(), ["utils/reference-store/rebuild/render.js", "utils/reference-store/voice-revision.js", "utils/reference-store/voice-revision/rows.js"],
    "the arc read has exactly one reader in the pipeline: the render");

  // The render asks the shared read rather than answering the question itself.
  const renderLayer = fs.readFileSync(path.join(process.cwd(), "utils/reference-store/rebuild/render.js"), "utf8");
  ok(renderLayer.includes("supersededVoiceClaims"), "the render asks the shared arc read rather than walking `supersedes` itself");
  same(/supersedes\s*=/.test(renderLayer), false, "and it issues no query of its own over the chain");

  console.log(`  70 finding kinds, 0 new verbs, 0 settings, 0 callers of the door outside its own layer (${doorCallers.length} files name it, all of them the layer or this suite)`);
}

console.log(`\nvoice revisions: ${checks} checks, 0 model calls, 0 requests to the endpoint.`);
