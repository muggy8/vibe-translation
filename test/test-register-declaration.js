#!/usr/bin/env node
/**
 * test/test-register-declaration.js — a series declares its own register questions, and the pipeline
 * refuses anything that is not one of them.
 *
 * Plan 06 slice 3. The account owner's rule is the thing this suite exists to keep true: **the register
 * questions are declared per series, by the intake, from the book, and there is no axis list in code, in
 * any language.** So this suite is not only "does the gate fire" — it is "does the pipeline work on a
 * book that is not Japanese, asking questions Japanese was never asked", and "is every refusal a refusal
 * that names what it refused and stores nothing".
 *
 * Scenarios:
 *
 *   1. **the declaration's guards** — every malformed shape is refused, and each refusal names the thing
 *      that is wrong and where. These guards are the only review a declaration gets: the intake writes
 *      it and nobody confirms it (plan 06 §4.3).
 *   2. **absent, empty and malformed are three facts** — read off a real plan of record, reported
 *      differently, and refused differently.
 *   3. **the stage's decision** — absent and malformed are structural refusals that name the door; empty
 *      runs and announces; declared runs.
 *   4. **the manifest gate** — a malformed block is refused before any volume is processed, a missing one
 *      is not, and the manifest schema did not move.
 *   5. **the filing gate, on a book that is not Japanese** — a Spanish-shaped series with Spanish-shaped
 *      axes files its claims and renders its reference, and a value outside the declared set is refused,
 *      named, and stores nothing — not bucketed, not re-cased, not filed under a nearby value.
 *   6. **one axis versus six** — the same pipeline runs on both, and the six-axis series answers a
 *      question the one-axis series cannot even be asked.
 *   7. **the gate is not a caller's choice** — it reads the declaration frozen into the store handle, a
 *      handle with no declaration is the refusing branch, and no door can hand it one.
 *   8. **no axis list in code, no knob, no new finding kind** — the shape constants are shape constants,
 *      the layer reads no environment variable, and a register refusal is a refusal, not a finding.
 *
 * Fixtures only, under `/tmp/opencode/series-fixtures`. Nothing here reads the real 17 volumes or any file
 * under the series folder, and nothing here reaches a model (AGENTS.md rule 8, gotcha 69).
 *
 * Plain `assert`, no framework, CommonJS — like the rest of the project.
 */

require("./test-home"); // the run's records get a throwaway home (gotcha 69)
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { readModuleLayer } = require("./module-layer");
const { assertInsideFixture } = require("./fixture-reference-store");
const rs = require("../utils/reference-store");
const {
  REGISTER_MANIFEST_KEY,
  AXIS_ID_PATTERN,
  AXIS_ID_MIN_CHARS,
  AXIS_ID_MAX_CHARS,
  AXIS_FIELDS,
  AXIS_REQUIRED_FIELDS,
  AXIS_SCOPES,
  DECLARATION_FIELDS,
  DECLARATION_STATES,
  registerAxisProblems,
  registerDeclarationProblems,
  validateRegisterDeclaration,
  describeRegisterDeclaration,
  readRegisterDeclaration,
  declaredAxisIds,
  registerDeclarationRefusalText,
  REGISTER_GATE_RULES,
  namedAxisOfProposal,
  registerFilingRefusal,
  openReferenceStore,
  importVoiceExtraction,
  rebuildVoiceFromExtraction,
  renderRebuiltVoice,
  SCHEMA_VERSION,
  MIGRATIONS,
} = rs;
const { validateManifest } = require("../intake/validate");
const { MANIFEST_SCHEMA } = require("../intake/config");
const { isStructuralError } = require("../configs/shared");
const { FINDING_LEVELS } = require("../utils/postmortem/levels");
const { resolveStageRegisterDeclaration } = require("../character-voice");

const ROOT = path.resolve(__dirname, "..");
const FIXTURES_ROOT = "/tmp/opencode/series-fixtures";

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
 * Lay out a one-volume fixture series with a plan of record whose register block is whatever this
 * scenario is testing — including nothing at all.
 *
 * The books are Spanish on purpose. Every other suite in this repository is Japanese, and a register
 * slice that was only ever tested against Japanese fixtures would not prove the owner's rule: it would
 * prove the design works for the language it was designed next to.
 *
 * @param {string} label - Scenario name, so fixtures do not collide.
 * @param {{register?: any, chapters: Object<string,string[]>, sourceLanguage?: string, seriesName?: string}} opts
 * @returns {{dir: string, folder: string, base: string, volumeDir: string}}
 */
function layFixture(label, { register, chapters, sourceLanguage = "Spanish", seriesName = "Reg Story" }) {
  const dir = path.join(FIXTURES_ROOT, label);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  process.env.SERIES_LOCATION = dir;

  const folder = `${seriesName}(01)`;
  const base = `${seriesName.toLowerCase().replace(/\s+/g, "_")}(1)`;
  const volumeDir = path.join(dir, folder);
  fs.mkdirSync(volumeDir, { recursive: true });

  const segments = Object.entries(chapters).map(([id, lines], index) => {
    const file = `${base}-${id}.md`;
    fs.writeFileSync(path.join(volumeDir, file), lines.join("\n") + "\n", "utf8");
    return { id, file, title: lines[0].replace(/^#\s+/, ""), chars: lines.join("\n").length };
  });
  fs.writeFileSync(
    path.join(volumeDir, `${base}-bundle.meta.json`),
    JSON.stringify({ format: "epub", schema: 8, base, wholeFile: `${base}-whole.md`, segments }, null, 2) + "\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(volumeDir, `${base}-whole.md`),
    Object.values(chapters).flat().join("\n") + "\n",
    "utf8"
  );

  const manifest = {
    schema: MANIFEST_SCHEMA,
    seriesLocation: dir,
    seriesName,
    sourceLanguage,
    targetLanguage: "English",
    generator: "test/test-register-declaration.js",
    generatedAt: new Date().toISOString(),
    discovery: {
      summary: "fixture: one book, continuous prose, one headed chapter",
      confidence: { volumes: 0.9, order: 0.9, sourceLanguage: 0.9 },
      evidence: ["fixture"],
      excluded: [],
    },
    volumes: [
      {
        folder,
        sourceFile: `${folder}/${base}.epub`,
        installmentNumber: "01",
        title: seriesName,
        integrity: { isNarrative: true, confidence: 0.9, basis: "fixture: continuous prose in one headed section" },
      },
    ],
  };
  if (register !== undefined) manifest[REGISTER_MANIFEST_KEY] = register;
  fs.writeFileSync(path.join(dir, "translation-target.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

  return { dir, folder, base, volumeDir };
}

/**
 * Open one handle on a fixture volume's record.
 *
 * @param {{dir: string, folder: string}} fixture
 * @param {string} stage
 * @returns {Object} The store handle.
 */
function openFixtureStore(fixture, stage) {
  const store = openReferenceStore({ volume: 1, folder: fixture.folder, seriesDir: fixture.dir, stage });
  assertInsideFixture(store.file, fixture.dir);
  return store;
}

/** How many facts a store holds, and how many of them name an axis. @param {Object} store */
function factShape(store) {
  return {
    facts: store.db.prepare("SELECT COUNT(*) n FROM facts").get().n,
    cast: store.db.prepare("SELECT COUNT(*) n FROM cast").get().n,
    axisRows: store.db.prepare("SELECT COUNT(*) n FROM facts WHERE axis IS NOT NULL").get().n,
  };
}

// ─── The fixture content ──────────────────────────────────────────────────────

/** A Spanish-shaped book: the distinctions it turns on are second-person form and deference. */
const SOURCE_ES = {
  ch0: [
    "# Capítulo 1",
    "Marina entró en el aula sin golpear.",
    "—¿Podés repetir lo que dijiste, vos? —preguntó Diego.",
    "Usted está equivocado, señor director —Marina no bajó la voz.",
    "Renata cerró la puerta sin decir nada.",
    "Yo no voy a repetir nada —dijo Diego.",
    "—Che, che —insistió Diego.",
    "Diego pensaba en primera persona, sin comillas.",
  ],
};

/** The declaration this fixture series makes for itself. Two axes, both answerable from the page above. */
const REGISTER_ES = {
  axes: [
    {
      id: "voseo",
      asks: "Which second-person form does this character use with somebody they know?",
      values: ["vos", "tú", "usted"],
      scope: "character",
      evidence: ["capítulo 1: Diego pregunta con vos"],
    },
    {
      id: "treatment",
      asks: "How does this character address somebody they take to be above them?",
      values: ["formal-usted", "informal-tú"],
      scope: "character-addressee",
      guidance: "The same character drops it when nobody important is listening.",
      renders: {
        "formal-usted": "keep the distance explicit in English",
        "informal-tú": "plain you",
      },
      evidence: ["capítulo 1: Marina se dirige al director con usted"],
    },
  ],
  note: "Two axes: this book turns on who uses which second-person form, and on who is addressed from above.",
};

/** The reading pass's claims, in the shape `character-voice-new.json` holds. */
const ENTRIES_ES = [
  {
    type: "voice",
    character: "Marina",
    quirkType: "vocabulary",
    description: "Answers a superior with usted and never softens it.",
    examples: ["Usted está equivocado, señor director"],
    axis: "treatment",
    value: "formal-usted",
  },
  {
    type: "voice",
    character: "Diego",
    quirkType: "vocabulary",
    description: "Asks him to repeat himself with vos.",
    examples: ["¿Podés repetir lo que dijiste, vos?"],
    axis: "voseo",
    value: "vos",
  },
  {
    // The planted defect: a quote the book really prints, answering a real axis, with a form this book
    // never prints. It is refused, and it stores nothing.
    type: "voice",
    character: "Renata",
    quirkType: "vocabulary",
    description: "Says nothing, in a form this series never declared.",
    examples: ["Renata cerró la puerta sin decir nada."],
    axis: "voseo",
    value: "vos-formal",
  },
];

/** Six axes, six claims, six lines of the same book. */
const REGISTER_SIX = {
  axes: [
    { id: "voseo", asks: "Which second-person form do they use?", values: ["vos", "tú", "usted"] },
    { id: "treatment", asks: "How do they address somebody above them?", values: ["formal-usted", "informal-tú"] },
    { id: "self-reference", asks: "Which word do they use for themselves?", values: ["yo", "uno", "nosotros"] },
    { id: "interjection", asks: "What do they say when they are pressing somebody?", values: ["che", "mirá", "nada"] },
    { id: "thought-style", asks: "How is their thinking written?", values: ["unquoted-first-person", "quoted"] },
    { id: "volume-of-speech", asks: "How much do they say out loud?", values: ["silent", "talkative"] },
  ],
};

const ENTRIES_SIX = [
  { type: "voice", character: "Diego", quirkType: "vocabulary", description: "Presses him with vos.", examples: ["¿Podés repetir lo que dijiste, vos?"], axis: "voseo", value: "vos" },
  { type: "voice", character: "Marina", quirkType: "vocabulary", description: "Answers a superior with usted and never softens it.", examples: ["Usted está equivocado, señor director"], axis: "treatment", value: "formal-usted" },
  { type: "voice", character: "Diego", quirkType: "pronoun", description: "Refuses to repeat anything, in the first person.", examples: ["Yo no voy a repetir nada"], axis: "self-reference", value: "yo" },
  { type: "voice", character: "Diego", quirkType: "catchphrase", description: "Presses the same word twice when he is not being heard.", examples: ["—Che, che —insistió Diego."], axis: "interjection", value: "che" },
  { type: "voice", character: "Diego", quirkType: "internalvoice", description: "His thinking is written without quotation marks.", examples: ["Diego pensaba en primera persona, sin comillas."], axis: "thought-style", value: "unquoted-first-person" },
  { type: "voice", character: "Renata", quirkType: "vocabulary", description: "Closes the door and says nothing.", examples: ["Renata cerró la puerta sin decir nada."], axis: "volume-of-speech", value: "silent" },
];

// ─── 1. the guards: every malformed shape is named ────────────────────────────

{
  console.log("1. the declaration's guards");

  // A well-formed declaration produces no problem at all, in either language shape.
  same(registerDeclarationProblems(REGISTER_ES), [], "the fixture's own declaration is well formed");
  same(registerDeclarationProblems(REGISTER_SIX), [], "and so is the six-axis one");
  same(registerDeclarationProblems({ axes: [], note: "This series turns on nothing in how people speak." }), [],
    "an empty declaration with a stated reason is well formed");

  /** @type {Array<{block: any, expect: string}>} Each block must produce a problem naming `expect`. */
  const malformed = [
    [{ axes: [{ id: "Formality", asks: "a", values: ["b"] }] }, "not a slug"],
    [{ axes: [{ id: "form ality", asks: "a", values: ["b"] }] }, "not a slug"],
    [{ axes: [{ id: "-formality", asks: "a", values: ["b"] }] }, "not a slug"],
    [{ axes: [{ id: "formality-", asks: "a", values: ["b"] }] }, "not a slug"],
    [{ axes: [{ id: "f", asks: "a", values: ["b"] }] }, "is 1 character"],
    [{ axes: [{ id: "a".repeat(41), asks: "a", values: ["b"] }] }, "is 41 character"],
    [{ axes: [{ id: "voseo", asks: "a", values: ["b"] }, { id: "voseo", asks: "c", values: ["d"] }] }, "declares the axis id \"voseo\" again"],
    [{ axes: [{ id: "voseo", asks: "a", values: [] }] }, "\"values\" is empty"],
    [{ axes: [{ id: "voseo", asks: "a", values: ["vos", "vos"] }] }, "lists \"vos\" twice"],
    [{ axes: [{ id: "voseo", asks: "a", values: ["vos", "  " ] } ] }, "every value is a non-empty string"],
    [{ axes: [{ id: "voseo", asks: "a", values: ["vos", 7] }] }, "every value is a non-empty string"],
    [{ axes: [{ id: "voseo", asks: "a", values: ["vos"], colour: "blue" }] }, "which this shape does not have"],
    [{ axes: [{ asks: "a", values: ["vos"] }] }, "missing a non-empty string \"id\""],
    [{ axes: [{ id: "voseo", values: ["vos"] }] }, "missing a non-empty string \"asks\""],
    [{ axes: [{ id: "voseo", asks: "a", values: ["vos"], scope: "series" }] }, "it is one of: character, character-addressee"],
    [{ axes: [{ id: "voseo", asks: "a", values: ["vos"], renders: { "vos-formal": "keep it" } }] }, "decides \"vos-formal\", which its own \"values\" does not declare"],
    [{ axes: [{ id: "voseo", asks: "a", values: ["vos"], renders: { vos: "  " } }] }, "must be a non-empty string"],
    [{ axes: [{ id: "voseo", asks: "a", values: ["vos"], evidence: [] }] }, "\"evidence\" must be a non-empty array"],
    [{ axes: [{ id: "voseo", asks: "a", values: ["vos"], guidance: "" }] }, "\"guidance\" must be a non-empty string"],
    [{ axes: [] }, "empty and manifest \"register\".note is missing"],
    [{ axes: [], note: "   " }, "note is missing"],
    [{ axes: [{ id: "voseo", asks: "a", values: ["vos"] }], note: "" }, "note must be a non-empty string"],
    [{}, "axes is absent"],
    [{ axes: "voseo" }, "not an array"],
    [[], "it is an object"],
    ["register", "it is an object"],
    [null, "it is an object"],
    [{ axes: ["voseo"] }, "is not an object"],
    [{ axes: [{ id: "voseo", asks: "a", values: ["vos"] }], axesExtra: 1 }, "names \"axesExtra\", which this shape does not have"],
  ];
  for (const [block, expect] of malformed) {
    const problems = registerDeclarationProblems(block);
    ok(problems.length > 0, `a malformed block is refused: ${JSON.stringify(block)}`);
    ok(
      problems.some((p) => p.includes(expect)),
      `the refusal names ${JSON.stringify(expect)} — got: ${problems.join(" | ")}`
    );
    ok(problems.every((p) => p.includes("manifest \"register\"")), `every problem says where it came from: ${problems.join(" | ")}`);
  }

  // `validateRegisterDeclaration` is the door the intake calls: it throws, and it counts.
  let thrown = null;
  try {
    validateRegisterDeclaration({ axes: [{ id: "Bad Id", asks: "a", values: [] }] });
  } catch (err) {
    thrown = err;
  }
  ok(thrown !== null, "a malformed declaration throws rather than being accepted");
  ok(/2 problem\(s\) in the series' register declaration/.test(thrown.message), `the message counts them: ${thrown.message}`);
  ok(/not a slug/.test(thrown.message) && /"values" is empty/.test(thrown.message), "and names both: " + thrown.message);

  // The shape constants are SHAPE constants: nothing in them names a language or a language's forms.
  same(AXIS_REQUIRED_FIELDS, ["id", "asks", "values"], "an axis requires an id, a question, and a value set");
  same(AXIS_SCOPES, ["character", "character-addressee"], "the two scopes are shape answers, not language answers");
  same(DECLARATION_FIELDS, ["axes", "note"], "the block itself has two fields");
  same(DECLARATION_STATES, ["declared", "empty", "absent", "malformed"], "four states, and absent and empty are different ones");
  ok(AXIS_FIELDS.every((f) => /^[a-z]+$/.test(f)), "no axis field name is a language's term");
  ok(AXIS_ID_PATTERN.test("address-form") && AXIS_ID_PATTERN.test("voseo") && !AXIS_ID_PATTERN.test("Voseo"),
    "the slug pattern accepts a hyphenated id and refuses a capitalised one");
  same([AXIS_ID_MIN_CHARS, AXIS_ID_MAX_CHARS], [2, 40], "the id bounds are constants");

  console.log(`  guards: ${malformed.length} malformed shapes refused, each by name`);
}

// ─── 2. absent, empty and malformed are three different facts ─────────────────

{
  console.log("2. absent, empty and malformed, read off a real plan of record");

  same(describeRegisterDeclaration(undefined).state, "absent", "no block at all is `absent`");
  same(describeRegisterDeclaration({ axes: [], note: "nothing here turns on speech" }).state, "empty",
    "an empty list with a reason is `empty`, not `absent`");
  same(describeRegisterDeclaration({ axes: [] }).state, "malformed", "an empty list with no reason is `malformed`");
  same(describeRegisterDeclaration(REGISTER_ES).state, "declared", "the fixture's declaration is `declared`");
  same(describeRegisterDeclaration(REGISTER_ES).axes.map((a) => a.id), ["voseo", "treatment"], "and its axes come back trimmed and in order");
  same(describeRegisterDeclaration(REGISTER_ES).axes[1].scope, "character-addressee", "a declared scope survives");
  same(describeRegisterDeclaration(REGISTER_ES).axes[0].scope, "character", "and an axis that named none is read as `character`");
  same(declaredAxisIds(describeRegisterDeclaration(REGISTER_ES)), ["voseo", "treatment"], "declaredAxisIds answers the ids");

  // The same four states, read out of files.
  const noFile = layFixture("register-no-plan", { chapters: SOURCE_ES });
  fs.rmSync(path.join(noFile.dir, "translation-target.json"), { force: true });
  const absentFile = readRegisterDeclaration(noFile.dir);
  same(absentFile.state, "absent", "a series with no plan of record is `absent`");
  ok(/no plan of record at/.test(absentFile.note), `and the note says what could not be read: ${absentFile.note}`);

  const noBlock = layFixture("register-no-block", { chapters: SOURCE_ES });
  const absentBlock = readRegisterDeclaration(noBlock.dir);
  same(absentBlock.state, "absent", "a plan with no register block is `absent`");
  ok(/has no "register" block/.test(absentBlock.note), `and it names the file: ${absentBlock.note}`);

  const broken = layFixture("register-broken", {
    chapters: SOURCE_ES,
    register: { axes: [{ id: "Not A Slug", asks: "x", values: ["a", "a"] }] },
  });
  const malformedRead = readRegisterDeclaration(broken.dir);
  same(malformedRead.state, "malformed", "a plan with a block it cannot trust is `malformed`");
  ok(malformedRead.problems.some((p) => /not a slug/.test(p)), "and the problems travel with it");
  ok(malformedRead.problems.some((p) => /lists "a" twice/.test(p)), "both of them");

  const emptyRead = layFixture("register-empty", {
    chapters: SOURCE_ES,
    register: { axes: [], note: "This comedy turns on what happens, not on how anyone speaks." },
  });
  const emptyDescribed = readRegisterDeclaration(emptyRead.dir);
  same(emptyDescribed.state, "empty", "an empty declaration with a reason is `empty`");
  same(emptyDescribed.note, "This comedy turns on what happens, not on how anyone speaks.", "and the reason is kept, because it is the point");

  const unparseable = layFixture("register-unparseable", { chapters: SOURCE_ES });
  fs.writeFileSync(path.join(unparseable.dir, "translation-target.json"), "{ this is not json", "utf8");
  same(readRegisterDeclaration(unparseable.dir).state, "absent", "a plan that does not parse is `absent`, with the reason in its note");
  ok(/does not parse/.test(readRegisterDeclaration(unparseable.dir).note), "and it says so");

  console.log("  absent / empty / malformed / declared, each read off a file and named");
}

// ─── 3. the stage's decision ──────────────────────────────────────────────────

{
  console.log("3. the character-voice stage: two refusals, two announcements");

  const manifestWith = (register) => {
    const m = { schema: MANIFEST_SCHEMA, seriesName: "Reg Story", sourceLanguage: "Spanish", targetLanguage: "English", volumes: [] };
    if (register !== undefined) m[REGISTER_MANIFEST_KEY] = register;
    return m;
  };

  // absent → a structural refusal that names the door.
  let err = null;
  try {
    resolveStageRegisterDeclaration(manifestWith(undefined));
  } catch (e) {
    err = e;
  }
  ok(err !== null, "a series with no declaration is refused");
  ok(isStructuralError(err), "and the refusal is STRUCTURAL, so ON_TASK_ERROR=continue cannot walk past it");
  ok(/no register declaration/.test(err.message), `it says what is missing: ${err.message.split("\n")[0]}`);
  ok(/npx gulp discover/.test(err.message), "it names the door that fixes it");
  ok(/no default list in the pipeline to fall back on, in any language/.test(err.message),
    "and it says why there is no fallback: " + err.message.split("\n")[0]);
  ok(/"register": \{ "axes": \[\], "note"/.test(err.message), "and it offers the honest alternative: declare none, with a reason");

  // malformed → a refusal that lists the problems.
  err = null;
  try {
    resolveStageRegisterDeclaration(manifestWith({ axes: [{ id: "Bad Id", asks: "x", values: [] }] }));
  } catch (e) {
    err = e;
  }
  ok(err !== null && isStructuralError(err), "a malformed declaration is refused structurally too");
  ok(/present but malformed/.test(err.message), `and says which: ${err.message.split("\n")[0]}`);
  ok(/not a slug/.test(err.message) && /"values" is empty/.test(err.message), "naming every problem: " + err.message);

  // empty → runs, and announces.
  const emptyDeclared = resolveStageRegisterDeclaration(manifestWith({ axes: [], note: "Nothing here turns on speech." }));
  same(emptyDeclared.state, "empty", "an empty declaration is accepted");
  same(emptyDeclared.axes, [], "with no axes");

  // declared → runs, and announces the axes.
  const declared = resolveStageRegisterDeclaration(manifestWith(REGISTER_ES));
  same(declared.state, "declared", "a declared series runs");
  same(declared.axes.map((a) => a.id), ["voseo", "treatment"], "and carries its axes into the run");

  // The refusal text is the same door from the store side.
  const storeSide = layFixture("register-stage-refusal", { chapters: SOURCE_ES });
  const text = registerDeclarationRefusalText(readRegisterDeclaration(storeSide.dir), "character-voice");
  ok(/character-voice stage cannot run/.test(text), "the store-side text names the stage");
  ok(text.includes(storeSide.dir), "and the file it looked at");

  console.log("  absent and malformed refuse structurally; empty and declared run and announce");
}

// ─── 4. the manifest gate, and the schema that did not move ───────────────────

{
  console.log("4. intake/validate.js: a malformed block is refused, a missing one is not");

  const manifestFixture = layFixture("register-manifest-gate", { chapters: SOURCE_ES });
  const baseManifest = () => JSON.parse(fs.readFileSync(path.join(manifestFixture.dir, "translation-target.json"), "utf8"));

  const untouched = validateManifest(baseManifest());
  ok(untouched.volumes.length === 1, "a plan with no register block still validates — the block is optional for the manifest");

  const good = baseManifest();
  good[REGISTER_MANIFEST_KEY] = REGISTER_ES;
  same(validateManifest(good)[REGISTER_MANIFEST_KEY].axes.length, 2, "a well-formed declaration validates");

  const bad = baseManifest();
  bad[REGISTER_MANIFEST_KEY] = { axes: [{ id: "Bad Id", asks: "x", values: ["a", "a"] }] };
  let err = null;
  try {
    validateManifest(bad);
  } catch (e) {
    err = e;
  }
  ok(err !== null, "a malformed declaration fails the manifest, before any volume is processed");
  ok(/register declaration/.test(err.message) && /not a slug/.test(err.message), `and names the problem: ${err.message}`);

  const emptyBlock = baseManifest();
  emptyBlock[REGISTER_MANIFEST_KEY] = { axes: [], note: "Nothing here turns on speech." };
  same(validateManifest(emptyBlock)[REGISTER_MANIFEST_KEY].axes, [], "an empty declaration with a reason validates");

  const unexplained = baseManifest();
  unexplained[REGISTER_MANIFEST_KEY] = { axes: [] };
  let err2 = null;
  try {
    validateManifest(unexplained);
  } catch (e) {
    err2 = e;
  }
  ok(err2 !== null && /note is missing/.test(err2.message), `an empty declaration with no reason is refused: ${err2 && err2.message}`);

  // The consequence the plan insisted on: adding the block did not invalidate the corpus's plan.
  same(MANIFEST_SCHEMA, 2, "the manifest schema is still 2 — `discover` is not forced, and an older plan stays valid");
  same(baseManifest().schema, 2, "and a schema-2 plan with no register block is still a schema-2 plan");

  console.log("  optional for the manifest, required by the voice stage, schema unmoved");
}

// ─── 5. the filing gate, on a book that is not Japanese ───────────────────────

{
  console.log("5. filing: a value outside the declared set is refused, named, and stores nothing");

  const fixture = layFixture("register-filing", { chapters: SOURCE_ES, register: REGISTER_ES });
  const store = openFixtureStore(fixture, "extract");
  try {
    same(store.registerDeclaration.state, "declared", "the handle carries the series' own declaration");
    ok(Object.isFrozen(store.registerDeclaration), "and it is frozen at open, like the write scope");

    const before = factShape(store);
    const filed = importVoiceExtraction(store, ENTRIES_ES);
    same(filed.importedCount, 2, "the two claims that answer declared axes are filed");
    same(filed.refused.length, 1, "and the one that does not is refused");
    same(filed.refused[0].rule, "register-value-outside-declared-set", "the refusal names its rule");
    same(filed.refused[0].character, "Renata", "and the claim it refused");
    ok(/not one of the forms this series declares/.test(filed.refused[0].because), `and why: ${filed.refused[0].because}`);
    ok(/"vos", "tú", "usted"/.test(filed.refused[0].because), "naming the values that ARE declared, so the fix is actionable");

    const after = factShape(store);
    same(after.facts, before.facts + 2, "exactly two rows were written — the refused claim stored nothing");
    same(after.axisRows, 2, "both of them name the axis they answer");
    same(store.db.prepare("SELECT COUNT(*) n FROM facts WHERE key = 'Renata'").get().n, 0,
      "no row was filed for the refused claim, under any value");
    same(store.db.prepare("SELECT COUNT(*) n FROM cast WHERE key = 'Renata'").get().n, 0,
      "and it did not leave its character on the roster either — a refused claim registers nothing");
    ok(store.getCast("Marina") && store.getCast("Diego"), "the two characters whose claims filed ARE on the roster");

    const rows = store.db.prepare("SELECT key, axis, axis_value FROM facts WHERE axis IS NOT NULL ORDER BY key").all()
      .map((row) => ({ ...row }));
    same(rows, [
      { key: "Diego", axis: "voseo", axis_value: "vos" },
      { key: "Marina", axis: "treatment", axis_value: "formal-usted" },
    ], "the pair is stored exactly as the series declared it — not bucketed, not re-cased");

    // A value that differs only in case is a different value, and it is refused.
    const caseClaim = store.insertFact({
      key: "Diego",
      aspect: "register",
      body: "Asks him to repeat himself with Vos.",
      evidence: [{ volume: 1, chapter: "ch0", line: 3, quote: "¿Podés repetir lo que dijiste, vos?" }],
      axis: "voseo",
      axisValue: "Vos",
    });
    ok(!caseClaim.ok, "a value that is only capitalised differently is refused, not matched to the declared one");
    same(caseClaim.refusal.rule, "register-value-outside-declared-set", "with the same rule");
    same(store.db.prepare("SELECT COUNT(*) n FROM facts").get().n, after.facts, "and it stored nothing");

    // An axis the series never declared.
    const unknownAxis = store.insertFact({
      key: "Diego",
      aspect: "register",
      body: "Answers a superior the way he answers everybody.",
      evidence: [{ volume: 1, chapter: "ch0", line: 3, quote: "¿Podés repetir lo que dijiste, vos?" }],
      axis: "honorific-register",
      axisValue: "low",
    });
    ok(!unknownAxis.ok, "an axis this series never declared is refused");
    same(unknownAxis.refusal.rule, "register-axis-not-declared", "by its own rule");
    ok(/It declares: voseo, treatment/.test(unknownAxis.refusal.because), `naming the axes it DOES declare: ${unknownAxis.refusal.because}`);

    // An axis named with no answer.
    const noAnswer = store.insertFact({
      key: "Diego",
      aspect: "register",
      body: "Something about his second-person forms, unstated.",
      evidence: [{ volume: 1, chapter: "ch0", line: 3, quote: "¿Podés repetir lo que dijiste, vos?" }],
      axis: "voseo",
    });
    ok(!noAnswer.ok, "an axis named without an answer is refused — a question recorded without an answer is not a claim");
    same(noAnswer.refusal.rule, "register-axis-answer-has-no-value", "by its own rule");

    // An answer with no axis.
    const noAxis = store.insertFact({
      key: "Diego",
      aspect: "register",
      body: "An answer to a question nobody asked.",
      evidence: [{ volume: 1, chapter: "ch0", line: 3, quote: "¿Podés repetir lo que dijiste, vos?" }],
      axisValue: "vos",
    });
    ok(!noAxis.ok, "an answer with no axis is refused");
    same(noAxis.refusal.rule, "register-value-without-an-axis", "by its own rule");
    same(store.db.prepare("SELECT COUNT(*) n FROM facts").get().n, after.facts, "and none of the four stored anything");

    // The claim that names no axis is filed exactly as it was before this slice existed.
    const plain = store.insertFact({
      key: "Diego",
      aspect: "register",
      body: "A claim that never claimed to answer a declared question.",
      evidence: [{ volume: 1, chapter: "ch0", line: 3, quote: "¿Podés repetir lo que dijiste, vos?" }],
    });
    ok(plain.ok, `a claim with no axis files as it always did: ${plain.refusal && plain.refusal.because}`);
    same(store.db.prepare("SELECT COUNT(*) n FROM facts WHERE axis IS NULL").get().n, 1,
      "and its axis pair is null, which is the honest shape for a claim that named none");

    console.log(`  filed 2, refused 4 rules, stored nothing for any of them; ${factShape(store).facts} rows in the record`);
  } finally {
    store.close();
  }
}

// ─── 6. the same claims, rebuilt and rendered ─────────────────────────────────

{
  console.log("6. the rebuild door files the same pair, and the reference renders it");

  const fixture = layFixture("register-rebuild", { chapters: SOURCE_ES, register: REGISTER_ES });
  const candidateStore = openFixtureStore(fixture, "extract");
  const rebuildStore = openFixtureStore(fixture, "rebuild");
  try {
    const res = rebuildVoiceFromExtraction(rebuildStore, ENTRIES_ES, { volume: 1, candidateStore });
    ok(res.ok === false, "the rebuild reports the refusal rather than hiding it");
    same(res.filedCount, 2, "and adopts the two claims that answer declared axes");
    same(res.refused.length, 1, "refusing the one that does not");
    same(res.refused[0].rule, "register-value-outside-declared-set", "naming the rule");
    same(res.candidates.refused.length, 0, "and it never filed a candidate copy of the refused claim, because the gate ran first");

    const adopted = rebuildStore.db
      .prepare("SELECT key, axis, axis_value, source_stage FROM facts WHERE axis IS NOT NULL ORDER BY source_stage, key")
      .all();
    same(adopted.length, 4, "both doors filed their own copy of the pair: the candidate and the adoption");
    ok(adopted.every((r) => r.axis && r.axis_value), "and neither copy lost it");
    same(new Set(adopted.map((r) => r.source_stage)), new Set(["extract", "rebuild"]), "one pair, two kinds of row, same answers");

    const rendered = renderRebuiltVoice(rebuildStore, { volume: 1 });
    ok(rendered.markdown.includes("Answers a superior with usted"), "the published reference carries the claim that answered a declared axis");
    ok(rendered.markdown.includes("Asks him to repeat himself with vos"), "and the other one");
    ok(!rendered.markdown.includes("Says nothing, in a form this series never declared"),
      "and carries nothing from the claim the declaration refused");
    same(rendered.characters.map((c) => c.key).includes("Renata"), false, "the refused character is not in the rendered reference");

    console.log(`  rebuilt ${res.filedCount} claim(s); rendered ${rendered.sections} section(s), ${rendered.characters.length} character(s)`);
  } finally {
    rebuildStore.close();
    candidateStore.close();
  }
}

// ─── 7. one axis versus six ───────────────────────────────────────────────────

{
  console.log("7. a series with one axis and a series with six both run — and six answers more");

  const one = layFixture("register-one-axis", {
    chapters: SOURCE_ES,
    register: { axes: [{ id: "voseo", asks: "Which second-person form do they use?", values: ["vos", "tú", "usted"] }] },
  });
  const six = layFixture("register-six-axes", { chapters: SOURCE_ES, register: REGISTER_SIX });

  const oneStore = openFixtureStore(one, "extract");
  const sixStore = openFixtureStore(six, "extract");
  try {
    const oneFiled = importVoiceExtraction(oneStore, ENTRIES_SIX);
    same(oneFiled.importedCount, 1, "the one-axis series files the one claim that answers its one axis");
    same(oneFiled.refused.length, 5, "and refuses the five that answer questions it never asked");
    ok(oneFiled.refused.every((r) => r.rule === "register-axis-not-declared"),
      "every refusal is the same rule, because the axes are simply not there");

    const sixFiled = importVoiceExtraction(sixStore, ENTRIES_SIX);
    same(sixFiled.refused.length, 0, "the six-axis series refuses nothing: six claims, six declared axes");
    same(sixFiled.importedCount, 6, "and files all six");

    const oneAxes = oneStore.db.prepare("SELECT DISTINCT axis FROM facts ORDER BY axis").all().map((r) => r.axis);
    const sixAxes = sixStore.db.prepare("SELECT DISTINCT axis FROM facts ORDER BY axis").all().map((r) => r.axis);
    same(oneAxes, ["voseo"], "one axis in the record");
    same(sixAxes, ["interjection", "self-reference", "thought-style", "treatment", "volume-of-speech", "voseo"],
      "six axes in the record, from the same book and the same reading pass");

    // The question the one-axis series cannot ask.
    const question = "treatment";
    same(sixStore.db.prepare("SELECT COUNT(*) n FROM facts WHERE axis = ?").get(question).n, 1,
      "the six-axis series answers \"how do they address somebody above them?\"");
    same(oneStore.db.prepare("SELECT COUNT(*) n FROM facts WHERE axis = ?").get(question).n, 0,
      "the one-axis series has no answer, and cannot be made to have one");
    const asked = oneStore.insertFact({
      key: "Marina",
      aspect: "register",
      body: "Answers a superior with usted.",
      evidence: [{ volume: 1, chapter: "ch0", line: 4, quote: "Usted está equivocado, señor director" }],
      axis: question,
      axisValue: "formal-usted",
    });
    ok(!asked.ok, "and filing that answer into the one-axis series is refused, not quietly accepted");
    same(asked.refusal.rule, "register-axis-not-declared", "by name");
    ok(/It declares: voseo\./.test(asked.refusal.because), `naming what it does declare: ${asked.refusal.because}`);

    console.log(`  one axis: ${oneFiled.importedCount} filed / ${oneFiled.refused.length} refused; six axes: ${sixFiled.importedCount} filed / ${sixFiled.refused.length} refused`);
  } finally {
    oneStore.close();
    sixStore.close();
  }
}

// ─── 8. no declaration, and the gate that will not be skipped ─────────────────

{
  console.log("8. no declaration: the corpus doors keep working, and an axis-bearing claim does not");

  const fixture = layFixture("register-absent-filing", { chapters: SOURCE_ES });
  const store = openFixtureStore(fixture, "extract");
  try {
    same(store.registerDeclaration.state, "absent", "a series whose intake never wrote a block opens with state `absent`");

    const filed = importVoiceExtraction(store, ENTRIES_ES.map((e) => {
      const { axis, value, ...rest } = e;
      return rest;
    }));
    same(filed.refused.length, 0, "the same claims with no axis file exactly as they did before this slice — which is what keeps `rebuild-voice` and `extract-voice` working on a corpus whose intake has not re-run");
    same(filed.importedCount, 3, "all three of them, including the one whose value was never declared, because it never named one");

    const axisClaim = store.insertFact({
      key: "Diego",
      aspect: "register",
      body: "Answers with vos, on an axis nobody declared.",
      evidence: [{ volume: 1, chapter: "ch0", line: 3, quote: "¿Podés repetir lo que dijiste, vos?" }],
      axis: "voseo",
      axisValue: "vos",
    });
    ok(!axisClaim.ok, "but the moment a claim names an axis, the absent declaration refuses it");
    same(axisClaim.refusal.rule, "register-declaration-absent", "with the rule that names the door");
    ok(/npx gulp discover/.test(axisClaim.refusal.fix), `and the fix it names: ${axisClaim.refusal.fix}`);
    same(store.db.prepare("SELECT COUNT(*) n FROM facts WHERE axis IS NOT NULL").get().n, 0, "and nothing was stored");

    // A malformed declaration refuses an axis-bearing claim too: nothing can be checked against it.
    const brokenFixture = layFixture("register-malformed-filing", {
      chapters: SOURCE_ES,
      register: { axes: [{ id: "Not A Slug", asks: "x", values: ["a", "a"] }] },
    });
    const brokenStore = openFixtureStore(brokenFixture, "extract");
    try {
      const res = brokenStore.insertFact({
        key: "Diego",
        aspect: "register",
        body: "Answers with vos, against a declaration that cannot be trusted.",
        evidence: [{ volume: 1, chapter: "ch0", line: 3, quote: "¿Podés repetir lo que dijiste, vos?" }],
        axis: "voseo",
        axisValue: "vos",
      });
      ok(!res.ok, "a malformed declaration refuses an axis-bearing claim");
      same(res.refusal.rule, "register-declaration-malformed", "with its own rule");
      ok(/not a slug/.test(res.refusal.because), "and the problems it cannot get past");

      const plain = brokenStore.insertFact({
        key: null,
        aspect: "register",
        body: "A claim that names no axis, on a series with a broken declaration.",
        evidence: [{ volume: 1, chapter: "ch0", line: 3, quote: "¿Podés repetir lo que dijiste, vos?" }],
      });
      ok(plain.ok, "while a claim that names no axis still files — the gate is about axes, not about punishing a volume");
    } finally {
      brokenStore.close();
    }

    // The gate is not a caller's choice.
    const gateRules = readModuleLayer(ROOT, "utils/reference-store/facts/validate.js");
    ok(/registerFilingRefusal\(ctx, proposal/.test(gateRules),
      "the gate runs inside the check every insert and every update already shares, on the handle's own declaration");
    const insertLayer = readModuleLayer(ROOT, "utils/reference-store/facts/insert.js");
    ok(!/registerDeclaration\s*=/.test(insertLayer), "and no door is handed a declaration of its own");
    const openLayer = readModuleLayer(ROOT, "utils/reference-store/open.js");
    ok(/Object\.freeze\(readRegisterDeclaration\(resolved\.seriesDir\)\)/.test(openLayer),
      "it is frozen onto the handle at open, read from the series' own plan of record");

    // A handle that was never given one is read as a series with no declaration — the refusing branch.
    const handMade = { registerDeclaration: undefined, volume: 1, scope: { volume: 1, stage: "merge" } };
    const refusalFromNothing = registerFilingRefusal(handMade, { axis: "voseo", axisValue: "vos" }, "insert_fact");
    ok(refusalFromNothing !== null, "a handle with no declaration refuses an axis-bearing claim rather than waving it through");
    same(refusalFromNothing.rule, "register-declaration-absent", "with the absent rule");
    same(registerFilingRefusal(handMade, { aspect: "register", body: "no axis named" }, "insert_fact"), null,
      "and files a claim that names none");

    console.log("  absent: axis-less claims file, axis-bearing claims are refused and store nothing");
  } finally {
    store.close();
  }
}

// ─── 9. the rules, the shape, and what this slice did NOT add ─────────────────

{
  console.log("9. six rules, no knob, no new finding kind, no axis list in code");

  same(REGISTER_GATE_RULES, [
    "register-declaration-absent",
    "register-declaration-malformed",
    "register-axis-not-declared",
    "register-axis-answer-has-no-value",
    "register-value-outside-declared-set",
    "register-value-without-an-axis",
  ], "the gate can refuse on exactly these six rules");

  // Every one of them fired somewhere above, and each is reachable from a proposal shape.
  const declared = describeRegisterDeclaration(REGISTER_ES);
  const cases = [
    [{ axis: "voseo", axisValue: "vos" }, { state: "absent", axes: [] }, "register-declaration-absent"],
    [{ axis: "voseo", axisValue: "vos" }, { state: "malformed", axes: [], problems: ["x"] }, "register-declaration-malformed"],
    [{ axis: "nope", axisValue: "vos" }, declared, "register-axis-not-declared"],
    [{ axis: "voseo" }, declared, "register-axis-answer-has-no-value"],
    [{ axis: "voseo", axisValue: "vos-formal" }, declared, "register-value-outside-declared-set"],
    [{ axisValue: "vos" }, declared, "register-value-without-an-axis"],
    [{}, declared, null],
    [{ axis: "", axisValue: "  " }, declared, null],
  ];
  for (const [proposal, declaration, expect] of cases) {
    const refusal = registerFilingRefusal({ registerDeclaration: declaration, volume: 1, scope: { volume: 1, stage: "merge" } }, proposal, "insert_fact");
    if (expect === null) {
      same(refusal, null, `a proposal that names nothing is not this gate's business: ${JSON.stringify(proposal)}`);
      continue;
    }
    ok(refusal !== null, `the gate fires for ${JSON.stringify(proposal)}`);
    same(refusal.rule, expect, "and only that rule");
    ok(REGISTER_GATE_RULES.includes(refusal.rule), "which is one of the six");
    ok(refusal.because && refusal.because.length > 20, "every refusal says why in a sentence a reader can act on");
    ok(refusal.fix && refusal.fix.length > 10, "and says what to do instead");
  }

  same(namedAxisOfProposal({ axis: " voseo ", axisValue: " vos " }), { axis: "voseo", value: "vos", namedValue: true },
    "the pair is read trimmed");
  same(namedAxisOfProposal({ axis: "", axisValue: "" }), { axis: null, value: null, namedValue: true },
    "a blank is not an answer");
  same(namedAxisOfProposal({}), { axis: null, value: null, namedValue: false }, "and an absent field is absent");

  // No environment knob reaches any of this.
  for (const file of ["utils/reference-store/register/declaration.js", "utils/reference-store/register/filing.js", "utils/reference-store/register.js"]) {
    const layer = readModuleLayer(ROOT, file);
    ok(!/process\.env/.test(layer), `${file} reads no environment variable`);
    ok(!/CONFIG\.|settings\./.test(layer), `${file} reads no setting either`);
  }

  // A register refusal is a refusal, not a finding: the level table did not gain a kind.
  const kinds = Object.keys(FINDING_LEVELS);
  same(kinds.length, 70, "the finding level table is still 70 kinds — this slice added none");
  same(kinds.filter((k) => k.startsWith("register-")), [], "and none of them is a register kind");

  // The schema moved by one migration, appended, and the pair is nullable.
  same(SCHEMA_VERSION, 10, "the store is at schema 10");
  same(MIGRATIONS[MIGRATIONS.length - 1].version, 10, "appended, not edited");
  const up = MIGRATIONS[MIGRATIONS.length - 1].up.join("\n");
  ok(/ALTER TABLE facts ADD COLUMN axis TEXT/.test(up) && /ALTER TABLE facts ADD COLUMN axis_value TEXT/.test(up),
    "the two columns are added by migration 10");
  ok(!/NOT NULL/.test(up), "and neither is required: a claim that names no axis is the normal case today");

  // The stage asks the question before it opens a volume, and the answer travels with the run.
  const taskLayer = readModuleLayer(ROOT, "character-voice/task.js");
  const askedAt = taskLayer.indexOf("resolveStageRegisterDeclaration(manifest)");
  const openedAt = taskLayer.indexOf("runVolumeSeries(");
  ok(askedAt > 0, "the stage asks the declaration in its own entry point");
  ok(openedAt > askedAt, "and before any volume is opened");
  ok(/registerDeclaration/.test(taskLayer.slice(askedAt, openedAt)), "and carries it into the run");

  // The extraction's answer shape was NOT closed, and the aspect collapse was not undone.
  const voiceShape = require("../character-voice/stages").voiceResponseFormat();
  const entrySchema = voiceShape.json_schema.schema.properties.entries.items;
  ok(entrySchema.additionalProperties === undefined && entrySchema.strict !== true,
    "the voice entry schema is still open — the value is checked at filing, not on the wire (test-answer-envelopes scenario 7)");
  const stagesLayer = readModuleLayer(ROOT, "character-voice/stages.js");
  ok(!/axis/i.test(stagesLayer.match(/VOICE_ENTRY_KEYS[\s\S]{0,400}/)[0]),
    "and the answer shape does not name an axis yet: asking the extraction for one is slice 4, which is a prompt change");
  const adapterLayer = readModuleLayer(ROOT, "utils/reference-store/extraction-adapter.js");
  ok(/sentenceending: "register"[\s\S]*formality: "register"[\s\S]*vocabulary: "register"/.test(adapterLayer),
    "the aspect collapse is still there, untouched: undoing it is slice 5, and it needs this slice first");

  console.log("  six rules, all reachable; no knob; 70 finding kinds; schema 10; the answer shape stayed open");
}

console.log(`\nregister declaration: ${checks} checks, 0 model calls.`);
