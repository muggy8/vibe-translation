#!/usr/bin/env node
/**
 * test/test-voice-prompt-declaration.js — plan 06 slice 4: the voice extraction prompt stops naming a
 * language, and the questions it asks come from the series' own declaration.
 *
 * What this suite is the guard for. Until this slice, `system-prompts/character-voice-extract.md` named
 * one language's politeness categories, one language's pronouns, one language's regional varieties and
 * one language's page markers, and its answer shape closed `formalityLevel` into five words four of which
 * were that language's grammar. A book that is not that book had no value to put in the field, so the
 * field was either left empty or filled with the nearest wrong thing. Plan 06 §4.2 says the questions
 * belong to the series and code holds only their **shape**; `test/test-no-language-axis-list.js` guards
 * the code half. This suite guards the prompt half, which that scan deliberately does not read.
 *
 * The five things it pins:
 *
 *   1. **The prompt file names no language and prints no character of any one language's script.** It
 *      still asks for the same two outputs, the same quotes, the same envelope, and the same role
 *      signature the wire log is classified by — the removal is confined to the language-specific text.
 *   2. **The questions reach the model as text appended in code**, from the series' plan of record: the
 *      declared questions with their declared answers, and — when a series declares none, or its block is
 *      malformed, or absent — an instruction to name none. There is no question list behind any branch.
 *   3. **The pair reaches the wire and the answer shape stays open.** The extraction call is sent the
 *      composed prompt, and its `response_format` is still open on purpose: the value set belongs to the
 *      series, so closing it in the pipeline is the axis list the owner forbade.
 *   4. **A series that declares its questions in another language's words runs the whole route** — read,
 *      file, render, audit, grade — and the pair lands in `facts.axis` / `facts.axis_value`. A second
 *      fixture declares its questions in this repository's usual language and runs the same route through
 *      the same code, which is the point: the pipeline is not the one choosing the questions.
 *   5. **An answer outside the declared set is refused through the real prompt path and stores nothing**,
 *      and the axis-less doors (`extract-voice`) still file claims and say out loud that they filed none
 *      of them against a register question.
 *
 * 0 model calls: the harness is replaced with a stub in every scenario that reads a book. Every fixture
 * is under `/tmp/opencode`; the real corpus is not reachable from here (AGENTS.md rule 8, gotcha 69).
 */

process.env.SOURCE_TEXT_PART_TARGET_CHARS = "1000";
delete process.env.SOURCE_CHUNK_THRESHOLD_CHARS;

require("./test-home"); // the run's records get a throwaway home (gotcha 69)

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const harness = require("../harness");
const rs = require("../utils/reference-store");
const { resolveSourceBundle } = require("../utils/source");
const { readModuleLayer } = require("./module-layer");
const { assertInsideFixture, FIXTURES_ROOT } = require("./fixture-reference-store");
const { REGISTER_MANIFEST_KEY, readRegisterDeclaration } = require("../utils/reference-store/register");
const { MANIFEST_SCHEMA } = require("../intake/config");
const { buildExtractSystemPrompt, buildRegisterDeclarationNote, REGISTER_NOTE_HEADING } = require("../character-voice/prompts");
const { VOICE_ENTRY_KEYS, voiceResponseFormat, parseVoiceQuirks } = require("../character-voice/stages");
const { openVoiceRecord, fileVoiceExtraction } = require("../character-voice/store");
const { assembleFromRecord, reopenRecordForStage } = require("../character-voice/assemble");
const { auditVoiceArtifact } = require("../character-voice/store");
const { runQaLoop } = require("../character-voice/qa");
const reading = require("../character-voice/reading");
const ev = require("../extract-voice");

const ROOT = path.resolve(__dirname, "..");
const SYSTEM_PROMPT_FILE = path.join(ROOT, "system-prompts", "character-voice-extract.md");
const USER_PROMPT_FILE = path.join(ROOT, "user-prompts", "character-voice-extract.md");

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

/**
 * The scenarios, in order. Async because four of them run a real reading pass, a real render,
 * a real audit and a real grade against a fixture, with the model replaced by a stub.
 */
async function main() {
  // ─── 1. the prompt file names no language and prints no script ────────────────

  {
    console.log("1. the voice extraction prompt, on its own text");

    const text = fs.readFileSync(SYSTEM_PROMPT_FILE, "utf8");

    // The languages the owner's rule names, and the ones a prompt could legitimately be about. A prompt
    // file is allowed to name a language (the intake prompt does); this one is not, because it is the file
    // plan 06 slice 4 exists for.
    const languages = ["Japanese", "Korean", "Chinese", "Spanish", "French", "German", "English", "Portuguese", "Italian", "Russian", "日本語", "한국어"];
    same(languages.filter((l) => text.includes(l)), [], "the voice extraction prompt names a language");

    // No character of any CJK script anywhere in the file — the shape that replaced the language's *name*
    // with the language's *letters*, which is the same defect wearing a different hat.
    const script = [...text].filter((ch) => /[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/.test(ch));
    same(script, [], `the prompt prints ${script.length} character(s) of a CJK script: ${script.join("")}`);

    // The register pair is asked for, in both the rules and the example.
    ok(/`axis`/.test(text) && /`value`/.test(text), "the prompt does not name the `axis` / `value` pair it asks for");
    ok(!/formalityLevel/.test(text), "the prompt still names `formalityLevel`, the enumeration the declaration replaces");
    ok(/Register questions declared for this series/.test(text),
      "the prompt does not point at the block the code appends, so the model is told to answer questions it is never shown");
    ok(/Never invent a question/.test(text) && /Never invent an answer/.test(text),
      "the prompt does not forbid inventing a question or an answer");
    ok(/name no axis/.test(text), "the prompt does not say what to do when the series declares none");

    // What the slice was NOT asked to change, pinned so it did not get changed on the way.
    ok(/\*\*Voice and Perspective Analyst\*\*/.test(text),
      "the role signature moved — the wire log classifies a voice-extract call by it, and so does the prompt audit");
    ok(/produce two outputs/.test(text), "the prompt no longer opens by naming its two outputs");
    ok(/Respond with \*\*only\*\* a JSON object holding one key, `entries`/.test(text),
      "the prompt no longer asks for the envelope its schema declares");
    ok(/\{"entries": \[\]\}/.test(text), "the prompt no longer says what the nothing-new answer looks like");
    ok(/Example shape \(do not copy these values\):/.test(text), "the prompt's example heading moved");
    const fences = (text.match(/```/g) || []).length;
    same(fences % 2, 0, `the prompt has an unclosed markdown fence (${fences} fence markers)`);

    // The observation kinds stay, because they name *what kind of thing was noticed*, not a language's
    // forms — and the two collapse tables and the pinned exemption lists are keyed on exactly these seven.
    const kinds = ["sentenceEnding", "pronoun", "formality", "vocabulary", "catchphrase", "dialect", "internalVoice"];
    for (const kind of kinds) ok(text.includes(`\`${kind}\``), `the prompt no longer names the observation kind \`${kind}\``);
    // The seven are the keys of the two collapse tables plan 06 slice 5 removes, and of the pinned
    // exemption in test/test-no-language-axis-list.js. Changing them here would move a guard in another
    // slice without touching that slice.
    const { QUIRK_TYPE_TO_ASPECT } = require("../utils/reference-store/extraction-adapter");
    same(kinds.map((k) => k.toLowerCase()).sort(), Object.keys(QUIRK_TYPE_TO_ASPECT).sort(),
      "the prompt's observation kinds and the store's collapse table no longer name the same seven");
    same(VOICE_ENTRY_KEYS.includes("quirkType"), true, "the answer-shape inventory lost `quirkType`, the field the kinds are written in");

    // The POV markers: the prompt asks for the delimiter this book prints instead of listing one language's.
    ok(/Report the delimiter this volume actually prints/.test(text),
      "the prompt does not ask for the marker this volume prints");
    ok(!/[※☆]/.test(text), "the prompt lists a language's page markers again");

    // The user prompt is the other half of the same request, and it used to tell the model to answer a bare
    // array while the system prompt and the schema asked for an envelope.
    const user = fs.readFileSync(USER_PROMPT_FILE, "utf8");
    ok(/Respond with \*\*only\*\* a JSON object holding one key, `entries`/.test(user),
      "the voice user prompt does not ask for the envelope the system prompt and the schema ask for");
    ok(/\{"entries": \[\]\}/.test(user), "the voice user prompt does not say what the nothing-new answer looks like");
    ok(!/Respond with \*\*only\*\* a JSON array/.test(user), "the voice user prompt still asks for a bare JSON array");
    ok(!/[※☆]/.test(user), "the voice user prompt lists a language's page markers again");
    same(languages.filter((l) => user.includes(l)), [], "the voice user prompt names a language");

    console.log("  no language, no CJK, the pair asked for, the role/envelope/example/kinds intact");
  }

  // ─── 2. the questions reach the model as text the code appends ────────────────

  {
    console.log("2. the declaration block, in all four states");

    const base = fs.readFileSync(SYSTEM_PROMPT_FILE, "utf8");

    const declared = {
      state: "declared",
      axes: [
        {
          id: "voseo", asks: "Which second-person form does this character use with somebody they know?",
          values: ["vos", "tú", "usted"], guidance: "Mixing them in one line is the character, not the model.",
          scope: "character", renders: { vos: "keep the informal you", usted: "keep the distance" },
          evidence: ["chapter 1: Diego asks with vos", "chapter 4: Diego answers a teacher with usted", "chapter 5", "chapter 6", "chapter 7", "chapter 8"],
        },
        {
          id: "addressing", asks: "How does this character speak to somebody they take to be above them?",
          values: Array.from({ length: 17 }, (_, i) => `value-${i + 1}`), scope: "character-addressee",
        },
      ],
      note: "Two questions.",
    };

    const note = buildRegisterDeclarationNote(declared);
    for (const axis of declared.axes) {
      ok(note.includes(`\`${axis.id}\``), `the block does not name the declared axis "${axis.id}"`);
      ok(note.includes(axis.asks), `the block does not carry the axis "${axis.id}" own question`);
    }
    for (const value of declared.axes[0].values) ok(note.includes(`\`${value}\``), `the block does not carry the declared value "${value}"`);
    ok(/\*\*whom\*\* the character is addressing/.test(note), "the block does not say what a per-addressee answer has to name");
    ok(note.includes("The intake's own note on this question"), "the block drops the intake's own guidance");
    ok(note.includes("`vos` → keep the informal you"), "the block drops the declared renderings");
    ok(note.includes("Where the intake saw this question in the book"), "the block drops the intake's evidence");
    ok(note.includes("and 2 more"), "the block does not say how much evidence it left out");
    // The long value list is wrapped rather than printed as one unreadable line.
    const valueLines = note.split("\n").filter((l) => l.startsWith("  Answer it with exactly one of:"));
    same(valueLines.length, 3, "the block does not wrap a 17-value axis as 12 + 5 on two lines, beside the 3-value axis's one line");
    ok(note.includes("`value-17`"), "the wrapped value list lost the last declared value");
    ok(note.split("\n").every((l) => l.length < 400), "the block prints a line long enough to be unreadable");

    const composed = buildExtractSystemPrompt(base, declared);
    ok(composed.startsWith(base), "the composed prompt no longer starts with the shared role file");
    ok(composed.includes(REGISTER_NOTE_HEADING), "the composed prompt does not carry the declaration block");
    ok(composed.includes("`voseo`"), "the composed prompt does not reach the model with the series' question in it");
    same(composed.length > base.length, true, "appending the block made the prompt shorter, which is not what appending means");

    // The three states that ask nothing, and the difference between them.
    const empty = buildRegisterDeclarationNote({ state: "empty", axes: [], note: "Nothing in this book turns on how people address each other." });
    ok(empty.includes("declares no register questions"), "the empty declaration is not announced as empty");
    ok(empty.includes("Nothing in this book turns on"), "the block drops the series' own reason for declaring none");
    ok(/Name no `axis` and no `value`/.test(empty), "the empty declaration does not forbid naming an axis");

    const absent = buildRegisterDeclarationNote(undefined);
    ok(absent.includes("This series has no register declaration."), "an absent declaration is not announced as absent");
    ok(/Name no `axis` and no `value`/.test(absent), "the absent declaration does not forbid naming an axis");

    const malformed = buildRegisterDeclarationNote({ state: "malformed", axes: [], problems: ["axes[0].values must be a non-empty array"] });
    ok(malformed.includes("present but malformed"), "a malformed declaration is not announced as malformed");

    // No branch holds a question of its own. This is the owner's rule, stated as a number.
    for (const [name, block] of [["declared", note], ["empty", empty], ["absent", absent], ["malformed", malformed]]) {
      const invented = block.split("\n").filter((l) => /^\s*Answer it with exactly one of:/.test(l));
      if (name === "declared") ok(invented.length > 0, "the declared block carries no accepted-answer line at all");
      else same(invented, [], `the ${name} block asks a question of its own (${invented.join(" | ")})`);
    }

    const promptsLayer = readModuleLayer(ROOT, "character-voice/prompts.js");
    ok(!/process\.env/.test(promptsLayer), "character-voice/prompts.js reads no environment variable");
    ok(!/CONFIG\.|settings\./.test(promptsLayer), "character-voice/prompts.js reads no setting either");

    console.log("  four states, three of them asking nothing; no question list behind any of them");
  }

  // ─── The fixture ──────────────────────────────────────────────────────────────

  /**
   * One chapter block, long enough to become its own segment.
   *
   * @param {string} title @param {string[]} lines @param {number} minChars
   * @returns {string}
   */
  function chapterBlock(title, lines, minChars) {
    const one = lines.join("\n");
    let body = `# ${title}\n${one}`;
    while (body.length < minChars) body += `\n${one}`;
    return body;
  }

  /** A Spanish-shaped book: what it turns on is which second-person form, and who is addressed from above. */
  const BOOK_ES = [
    chapterBlock("Capítulo 1", [
      "Marina entró en el aula sin golpear.",
      "—¿Podés repetir lo que dijiste, vos? —preguntó Diego.",
      "Usted está equivocado, señor director —Marina no bajó la voz.",
      "Renata cerró la puerta sin decir nada.",
      "Yo no voy a repetir nada —dijo Diego.",
    ], 1200),
    chapterBlock("Capítulo 2", [
      "Diego buscó a Marina en el pasillo.",
      "Che, no insistas —dijo Diego.",
      "Usted decide, señora directora —dijo Renata.",
      "Marina miró la pared y no respondió.",
    ], 1200),
  ].join("\n\n");

  /** The same shape of book in this repository's usual language, so the route is proven language-neutral. */
  const BOOK_JS = [
    chapterBlock("第一章", [
      "如月雨露は教室に入った。",
      "「さぁ、今日も俺の熱き血潮を迸らせるぜ！」",
      "担任の教師は黒板を叩いた。",
      "「気にすんな！」と大賀太陽が叫んだ。",
    ], 1200),
    chapterBlock("第二章", [
      "三色院菫子は本を読んでいた。",
      "先生、よろしくお願いいたします —如月雨露が言った。",
      "大賀太陽は笑った。",
    ], 1200),
  ].join("\n\n");

  /** What this fixture series declares for the Spanish book. */
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
        evidence: ["capítulo 1: Marina se dirige al director con usted"],
      },
    ],
    note: "Two questions: who uses which second-person form, and who is addressed from above.",
  };

  /** What this fixture series declares for the Japanese-shaped book. */
  const REGISTER_JS = {
    axes: [
      {
        id: "self-reference",
        asks: "Which word does this character use for themselves?",
        values: ["俺", "僕", "私"],
        scope: "character",
        evidence: ["第一章: 如月雨露は俺を使う"],
      },
      {
        id: "teacher-address",
        asks: "How does this character address a teacher?",
        values: ["敬称", "敬称なし"],
        scope: "character-addressee",
        evidence: ["第二章: 先生と呼ぶ"],
      },
    ],
    note: "Two questions this book turns on.",
  };

  /**
   * Lay out a one-volume fixture series with a plan of record whose register block is whatever this
   * scenario needs, and a book made of headed chapters long enough to become segments.
   *
   * @param {string} label
   * @param {{register: any, book: string, seriesName: string, sourceLanguage: string}} opts
   * @returns {{dir: string, folder: string, base: string, volumeDir: string, manifest: Object}}
   */
  function laySeries(label, { register, book, seriesName, sourceLanguage }) {
    const dir = path.join(FIXTURES_ROOT, label);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });

    process.env.SERIES_LOCATION = dir;
    process.env.POSTMORTEM_DIR = path.join(dir, ".postmortem");
    process.env.LOGS_DIR = path.join(dir, ".logs");
    process.env.DRY_RUN_DIR = path.join(dir, ".dry-run");

    const folder = `${seriesName}(01)`;
    const base = `${seriesName.toLowerCase().replace(/\s+/g, "_")}(1)`;
    const volumeDir = path.join(dir, folder);
    fs.mkdirSync(volumeDir, { recursive: true });
    fs.writeFileSync(path.join(volumeDir, "book.txt"), book + "\n", "utf8");

    const manifest = {
      schema: MANIFEST_SCHEMA,
      seriesLocation: dir,
      seriesName,
      sourceLanguage,
      targetLanguage: "English",
      generator: "test/test-voice-prompt-declaration.js",
      generatedAt: new Date().toISOString(),
      discovery: {
        summary: "fixture: one book, continuous prose, two headed chapters",
        confidence: { volumes: 0.9, order: 0.9, sourceLanguage: 0.9 },
        evidence: ["fixture"],
        excluded: [],
      },
      volumes: [
        {
          folder,
          sourceFile: `${folder}/book.txt`,
          installmentNumber: "01",
          title: seriesName,
          integrity: { isNarrative: true, confidence: 0.9, basis: "fixture: continuous prose in two headed sections" },
        },
      ],
    };
    if (register !== undefined) manifest[REGISTER_MANIFEST_KEY] = register;
    fs.writeFileSync(path.join(dir, "translation-target.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

    return { dir, folder, base, volumeDir, manifest };
  }

  /**
   * Answer the extraction call the way the new prompt asks to be answered, from the chapter it was given,
   * and answer the acceptance grade beside it so the gate can run.
   *
   * Every quote is a line the fixture book really prints, so the evidence rule is never tripped by
   * accident and a refusal can be attributed to the register gate alone.
   *
   * @param {Array<Object>} calls - Every call the stub heard, filled in.
   * @param {(entryIndex: number) => Object} build - The claims to answer with.
   * @returns {void}
   */
  function stubExtraction(calls, build) {
    let extractIndex = 0;
    harness.runOneShot = async ({ systemPrompt, messages, label, responseFormat }) => {
      if (typeof label === "string" && label.includes("acceptance")) {
        calls.push({ label, systemPrompt, messages, responseFormat, kind: "acceptance" });
        return JSON.stringify({ score: 84, band: "Pass with minor edits", note: "Fixture grade." });
      }
      const fileMessage = messages.find((m) => m && m.file);
      const text = fileMessage ? fs.readFileSync(fileMessage.file, "utf8") : "";
      const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
      const index = extractIndex++;
      calls.push({ label, systemPrompt, messages, responseFormat, kind: "extract", index });
      return JSON.stringify({ entries: build(lines, index) });
    };
  }

  /** Restore the real harness after a scenario has replaced it. */
  function restoreHarness() {
    delete harness.runOneShot;
  }

  /**
   * Run one fixture volume through the stage's own route: open the record, read the chapters with the
   * composed prompt, file what came back, render both artifacts, audit, and grade.
   *
   * @param {{dir: string, folder: string, volumeDir: string}} series
   * @param {Object} declaration - The declaration read off the fixture's own plan of record.
   * @param {(entryIndex: number) => Object} build
   * @returns {Promise<{ctx: Object, calls: Array<Object>, read: Object, entries: Array<Object>, voice: Object, built: Object, audit: Object, qa: Object}>}
   */
  async function runRoute(series, declaration, build) {
    const bundle = await resolveSourceBundle({ seriesDir: series.dir, volume: { folder: series.folder, installmentNumber: "01", sourceFile: `${series.folder}/book.txt` }, volumeDir: series.volumeDir, force: false });
    const segments = bundle.segments;

    const ctx = {
      values: { INSTALLMENT_NUMBER: "01", SOURCE_NAME: "Fixture", SOURCE_LANGUAGE: "es", TARGET_LANGUAGE: "en" },
      folderName: series.folder,
      volumeDir: series.volumeDir,
      seriesDir: series.dir,
      sourceFile: bundle.wholePath,
      bundle,
      isFirst: true,
      previousFolderName: null,
      previousVoiceRefFile: null,
      voiceOutputFile: path.join(series.volumeDir, "character-voice.md"),
      povOutputFile: path.join(series.volumeDir, "pov-map.md"),
      validationOutputFile: path.join(series.volumeDir, "character-voice-validation.md"),
      extractPrompt: "Volume being processed: 01",
      extractSystemPrompt: buildExtractSystemPrompt(fs.readFileSync(SYSTEM_PROMPT_FILE, "utf8"), declaration),
      acceptancePrompt: "Score this reference 0-100.",
      acceptanceSystemPrompt: "**Quality Gatekeeper** for a character voice reference",
      registerDeclaration: declaration,
      refStore: null,
    };

    const attempt = openVoiceRecord(ctx, null);
    assert.ok(attempt.ok, `the fixture record refused to open: ${attempt.error}`);
    ctx.refStore = attempt.opened.store;

    const calls = [];
    stubExtraction(calls, build);
    try {
      const read = await reading.readVolumeChapters({ ctx, segments, volumeDir: series.volumeDir, installmentNumber: "01", log: () => {} });
      assert.ok(read.ok, `the reading pass refused: ${read.refusal && read.refusal.because}`);
      const entries = reading.consolidateExtraction(read.chapters);
      const voice = fileVoiceExtraction(ctx, entries);
      const built = assembleFromRecord(ctx, entries, segments);
      assert.ok(built.ok, `the render refused: ${built.refusal && built.refusal.because}`);
      reopenRecordForStage(ctx);
      const audit = await auditVoiceArtifact(ctx, { refused: [...voice.refused, ...built.rebuild.refused] });
      const qa = await runQaLoop(ctx);
      // Read the record's shape before the handle closes: measuring a record you can no longer open is
      // not a measurement.
      const shape = axisShape(ctx.refStore);
      return { ctx, calls, read, entries, voice, built, audit, qa, shape };
    } finally {
      restoreHarness();
      try { ctx.refStore && ctx.refStore.close(); } catch { /* already closed */ }
    }
  }

  /** How a fixture record's rows are shaped. @param {Object} store */
  function axisShape(store) {
    return {
      facts: store.db.prepare("SELECT COUNT(*) n FROM facts").get().n,
      cast: store.db.prepare("SELECT COUNT(*) n FROM cast").get().n,
      axisRows: store.db.prepare("SELECT COUNT(*) n FROM facts WHERE axis IS NOT NULL").get().n,
      // Two doors file a claim about the same character on this route — the reading pass's candidate
      // (`extract`) and the adopted row the render is built from (`rebuild`) — and the pair travels with
      // both. Counting them together would report four where two questions were answered.
      axisByStage: store.db.prepare("SELECT source_stage, COUNT(*) n FROM facts WHERE axis IS NOT NULL GROUP BY source_stage ORDER BY source_stage").all().map((r) => ({ source_stage: r.source_stage, n: r.n })),
      pairs: store.db.prepare("SELECT axis, axis_value FROM facts WHERE axis IS NOT NULL AND source_stage = 'extract' ORDER BY axis, axis_value").all().map((r) => ({ axis: r.axis, axis_value: r.axis_value })),
      castKeys: store.db.prepare("SELECT key FROM cast ORDER BY key").all().map((r) => r.key),
    };
  }

  // ─── 3. the pair reaches the wire, and the shape stays open ───────────────────

  {
    console.log("3. the extraction call, on the wire");

    const series = laySeries("slice4-wire", { register: REGISTER_ES, book: BOOK_ES, seriesName: "Reg Wire", sourceLanguage: "Spanish" });
    const declaration = readRegisterDeclaration(series.dir);
    same(declaration.state, "declared", "the fixture's own plan of record does not read as a declared declaration");

    const calls = [];
    stubExtraction(calls, (lines) => [
      { type: "voice", character: "Diego", quirkType: "pronoun", description: "Asks with vos and never switches.", examples: [lines[1]], axis: "voseo", value: "vos" },
      { type: "voice", character: "Marina", quirkType: "vocabulary", description: "Answers a superior with usted.", examples: [lines[2]], axis: "treatment", value: "formal-usted" },
      { type: "pov", povCategory: "narrationType", description: "The chapter stays outside every character.", examples: [lines[0]], narrationType: "third-person-omniscient", sectionDescription: "Capítulo 1" },
    ]);
    const bundle = await resolveSourceBundle({ seriesDir: series.dir, volume: { folder: series.folder, installmentNumber: "01", sourceFile: `${series.folder}/book.txt` }, volumeDir: series.volumeDir, force: false });
    const { runExtract } = require("../character-voice/stages");
    const ctx = {
      values: { INSTALLMENT_NUMBER: "01" },
      volumeDir: series.volumeDir,
      bundle,
      extractPrompt: "Volume being processed: 01",
      extractSystemPrompt: buildExtractSystemPrompt(fs.readFileSync(SYSTEM_PROMPT_FILE, "utf8"), declaration),
      previousVoiceRefFile: null,
    };
    try {
      await runExtract(ctx, bundle.segments[0], 0);
    } finally {
      restoreHarness();
    }

    same(calls.length, 1, "the extraction pass made the wrong number of calls");
    const sent = calls[0].systemPrompt;
    ok(sent.includes(REGISTER_NOTE_HEADING), "the call was sent a system prompt with no declaration block in it");
    ok(sent.includes("`voseo`") && sent.includes("Which second-person form"), "the declared question did not reach the model");
    ok(sent.includes("`formal-usted`"), "a declared answer did not reach the model, so the model cannot answer in the declared words");
    ok(sent.includes("Name the one your claim answers in"), "the model was not told where a register answer goes");
    ok(!sent.includes("formalityLevel"), "the wire prompt still names `formalityLevel`");

    const shape = calls[0].responseFormat;
    const item = shape.json_schema.schema.properties.entries.items;
    same(item.required, ["type"], "the voice entry shape changed what it requires");
    ok(item.additionalProperties === undefined, "the voice entry shape gained additionalProperties — it is open on purpose");
    ok(shape.json_schema.strict === undefined, "the voice shape gained `strict`, which is a promise this shape does not make");
    ok(Object.prototype.hasOwnProperty.call(item.properties, "axis") && Object.prototype.hasOwnProperty.call(item.properties, "value"),
      "the declared shape does not carry the axis pair it asks for");
    same(VOICE_ENTRY_KEYS.filter((k) => k === "axis" || k === "value"), ["axis", "value"], "the answer-shape inventory does not hold the pair");

    console.log("  the block is on the wire; the shape is still open and still names the pair");
  }

  // ─── 4. a series that declares its own questions runs the whole route ─────────

  {
    console.log("4. read → file → render → audit → grade, on a declared series");

    const es = laySeries("slice4-route-es", { register: REGISTER_ES, book: BOOK_ES, seriesName: "Reg Route Es", sourceLanguage: "Spanish" });
    const esDecl = readRegisterDeclaration(es.dir);
    const esRun = await runRoute(es, esDecl, (lines, index) => index === 0 ? [
      { type: "voice", character: "Diego", quirkType: "pronoun", description: "Asks with vos, and uses che when he is impatient.", examples: [lines[1]], axis: "voseo", value: "vos" },
      { type: "voice", character: "Marina", quirkType: "vocabulary", description: "Answers a superior with usted and never softens it.", examples: [lines[2]], axis: "treatment", value: "formal-usted" },
      { type: "pov", povCategory: "narrationType", description: "The chapter stays outside every character.", examples: [lines[0]], narrationType: "third-person-omniscient", sectionDescription: "Capítulo 1" },
    ] : [
      { type: "pov", povCategory: "narrationType", description: "The second chapter stays outside every character too.", examples: [lines[0]], narrationType: "third-person-omniscient", sectionDescription: "Capítulo 2" },
    ]);

    same(esRun.entries.length, 4, "the fixture's reading pass did not bring back the four claims it was answered with");
    same(esRun.voice.refused, [], `the register gate refused a claim this series declared: ${JSON.stringify(esRun.voice.refused)}`);
    same(esRun.voice.importedCount, 4, "the reading pass's claims were not all filed");

    const shape = esRun.shape;
    same(shape.axisByStage, [{ source_stage: "extract", n: 2 }, { source_stage: "rebuild", n: 2 }],
      "the pair did not travel from the reading pass's candidate to the adopted row the render is built from");
    same(shape.pairs, [
      { axis: "treatment", axis_value: "formal-usted" },
      { axis: "voseo", axis_value: "vos" },
    ], "the record holds a different pair than the one the series declared and the extraction answered");

    const voiceFile = fs.readFileSync(path.join(es.volumeDir, "character-voice.md"), "utf8");
    ok(voiceFile.includes("Answers a superior with usted"), "the rendered reference lost the claim that answers a declared question");
    ok(!voiceFile.includes("formality"), "the rendered reference prints a formality heading the field no longer fills");
    const povFile = fs.readFileSync(path.join(es.volumeDir, "pov-map.md"), "utf8");
    ok(povFile.includes("Capítulo 1"), "the POV map lost the chapter section");

    same(esRun.audit.highFindings.map((f) => f.kind), [], `the deterministic audit reports HIGH findings on a declared volume: ${esRun.audit.highFindings.map((f) => `${f.kind}: ${f.message}`).join(" | ")}`);
    same(esRun.qa.accepted, true, `the acceptance gate refused the assembled reference (scores: ${esRun.qa.scores.join(", ")})`);

    // The same route, the same code, a different book and a different pair of questions.
    const js = laySeries("slice4-route-js", { register: REGISTER_JS, book: BOOK_JS, seriesName: "Reg Route Js", sourceLanguage: "Japanese" });
    const jsDecl = readRegisterDeclaration(js.dir);
    const jsRun = await runRoute(js, jsDecl, (lines, index) => index === 0 ? [
      { type: "voice", character: "如月雨露", quirkType: "pronoun", description: "Uses 俺 for himself in every chapter.", examples: [lines[1]], axis: "self-reference", value: "俺" },
      { type: "voice", character: "大賀太陽", quirkType: "catchphrase", description: "Turns a mistake into a chant.", examples: [lines[3]] },
      { type: "pov", povCategory: "narrationType", description: "The chapter follows one character throughout.", examples: [lines[0]], assignedCharacter: "如月雨露", narrationType: "first-person-internal", sectionDescription: "第一章" },
    ] : [
      { type: "pov", povCategory: "narrationType", description: "The second chapter follows the same character.", examples: [lines[0]], assignedCharacter: "如月雨露", narrationType: "first-person-internal", sectionDescription: "第二章" },
    ]);
    const jsShape = jsRun.shape;
    same(jsShape.axisByStage, [{ source_stage: "extract", n: 1 }, { source_stage: "rebuild", n: 1 }], "the second fixture's declared axis did not reach its record");
    same(jsShape.pairs, [{ axis: "self-reference", axis_value: "俺" }], "the second fixture filed a different pair than the one it declared");
    same(jsRun.voice.refused, [], "the register gate refused a claim the second fixture declared");
    same(jsRun.qa.accepted, true, `the acceptance gate refused the second fixture (scores: ${jsRun.qa.scores.join(", ")})`);

    // Two series, two question sets, one code path: the difference between them is entirely theirs.
    same(REGISTER_ES.axes.map((a) => a.id), ["voseo", "treatment"], "the two fixtures' declarations stopped being different");
    same(REGISTER_JS.axes.map((a) => a.id), ["self-reference", "teacher-address"], "and so did the second one's");
    same(jsRun.calls.length, esRun.calls.length, "the two routes made different numbers of model calls");

    console.log(`  Spanish-shaped series: ${esRun.voice.importedCount} filed, ${shape.axisRows} axis-bearing row(s), grade ${esRun.qa.scores.join("/")}`);
    console.log(`  Japanese-shaped series: ${jsRun.voice.importedCount} filed, ${jsShape.axisRows} axis-bearing row(s), grade ${jsRun.qa.scores.join("/")}`);
  }

  // ─── 5. an answer outside the declared set is refused, and stores nothing ─────

  {
    console.log("5. a value the series never declared");

    const series = laySeries("slice4-out-of-set", { register: REGISTER_ES, book: BOOK_ES, seriesName: "Reg Out", sourceLanguage: "Spanish" });
    const declaration = readRegisterDeclaration(series.dir);

    const run = await runRoute(series, declaration, (lines, index) => index === 0 ? [
      { type: "voice", character: "Diego", quirkType: "pronoun", description: "Asks with a form this book does not print.", examples: [lines[1]], axis: "voseo", value: "vosotros" },
      { type: "voice", character: "Renata", quirkType: "vocabulary", description: "Answers a superior with a form this series never declared.", examples: [lines[2]], axis: "treatment", value: "formal" },
      { type: "voice", character: "Marina", quirkType: "vocabulary", description: "Answers a superior with usted.", examples: [lines[2]], axis: "treatment", value: "formal-usted" },
    ] : [
      { type: "pov", povCategory: "narrationType", description: "The second chapter stays outside every character.", examples: [lines[0]], narrationType: "third-person-omniscient", sectionDescription: "Capítulo 2" },
    ]);

    const rules = run.voice.refused.map((r) => r.rule);
    same(rules, ["register-value-outside-declared-set", "register-value-outside-declared-set"],
      `the gate refused ${run.voice.refused.length} claim(s) with ${JSON.stringify(rules)} — two of them should be refused for answering with a value this series never declared`);
    same(run.voice.importedCount, 2, "the claims that did answer a declared question were not filed alongside the refused ones");

    const shape = run.shape;
    same(shape.axisByStage, [{ source_stage: "extract", n: 1 }, { source_stage: "rebuild", n: 1 }],
      "a refused axis-bearing claim still left a row behind, or the filed pair did not travel to the adopted row");
    same(shape.pairs, [{ axis: "treatment", axis_value: "formal-usted" }], "the record holds the refused pair");

    same(shape.castKeys, ["Marina"],
      `a claim the register gate refused still left its character on the roster: ${shape.castKeys.join(", ")}`);

    const refusalText = run.voice.refused[0].because;
    ok(refusalText.includes("vosotros") && refusalText.includes('"vos", "tú", "usted"'),
      `the refusal does not name both the value it refused and the values this series declares: ${refusalText}`);

    // The refusal reaches the report the grader reads, and it is named as a register refusal rather than as
    // a missing quote — the two doors print this line through one function so they cannot disagree.
    const validation = fs.readFileSync(path.join(series.volumeDir, "character-voice-validation.md"), "utf8");
    ok(/vosotros/.test(validation) && /formal-usted/.test(validation) && /refused to record/.test(validation),
      `the validation report the grader is handed does not name the claim the register gate turned down:\n${validation.slice(0, 1200)}`);
    const { describeVoiceRefusals } = require("../character-voice/store");
    ok(describeVoiceRefusals(run.voice.refused).includes("refused by this series' register declaration"),
      "the refusal line describes a register refusal as a missing quote");
    ok(describeVoiceRefusals(run.voice.refused).includes("2 × register-value-outside-declared-set"),
      "the refusal line does not count the refusals by the rule that produced them");

    console.log(`  ${run.voice.refused.length} refused by name, ${run.voice.importedCount} filed, ${shape.axisRows} axis-bearing row(s) in the record`);
  }

  // ─── 6. the axis-less doors still work, and say so ────────────────────────────

  {
    console.log("6. extract-voice on a series that declares nothing");

    // The announcement, in all four states.
    const declaredLine = ev.registerAnnouncementLines({ state: "declared", axes: [{ id: "voseo", asks: "Which form?" }], note: null, file: "translation-target.json" });
    ok(declaredLine[0].includes("declares 1 register question(s)") && declaredLine[0].includes('"voseo"'),
      `the declared announcement does not name the question: ${declaredLine[0]}`);
    const emptyLine = ev.registerAnnouncementLines({ state: "empty", axes: [], note: "Nothing turns on address.", file: "translation-target.json" });
    ok(emptyLine[0].includes("declares no register questions") && emptyLine[0].includes("Nothing turns on address."),
      `the empty announcement does not carry the series' own reason: ${emptyLine[0]}`);
    const absentLine = ev.registerAnnouncementLines({ state: "absent", axes: [], note: null, file: "translation-target.json" });
    ok(absentLine[0].includes("NO register axis") && absentLine[0].includes("npx gulp discover"),
      `the absent announcement does not name the consequence or the door that fixes it: ${absentLine[0]}`);
    const malformedLine = ev.registerAnnouncementLines({ state: "malformed", axes: [], note: null, file: "translation-target.json" });
    ok(malformedLine[0].includes("malformed"), `the malformed announcement does not say the block is malformed: ${malformedLine[0]}`);
    for (const line of [...declaredLine, ...emptyLine, ...absentLine, ...malformedLine]) {
      same(/Japanese|Korean|Chinese|Spanish|polite|honorific|humble|丁寧語|ですます/.test(line), false,
        `the announcement names a language or a language's register answers: ${line}`);
    }

    // The door itself: a series with no register block, read through the real command.
    const series = laySeries("slice4-axisless", { register: undefined, book: BOOK_JS, seriesName: "Reg Axisless", sourceLanguage: "Japanese" });
    same(readRegisterDeclaration(series.dir).state, "absent", "the fixture's plan of record should carry no register block");

    const logged = [];
    const calls = [];
    stubExtraction(calls, (lines) => [
      { type: "voice", character: "如月雨露", quirkType: "pronoun", description: "Uses 俺 for himself in every chapter.", examples: [lines[1]] },
    ]);
    let result;
    try {
      result = await ev.runExtractPass({ seriesDir: series.dir, volumeArg: "01", log: (line) => logged.push(line) });
    } finally {
      restoreHarness();
    }

    same(result.ok, true, `the axis-less door refused a volume it is supposed to read: ${JSON.stringify(result.refusal)}`);
    same(calls.length, 2, "the axis-less reading pass did not make one call per chapter");
    ok(logged.some((l) => l.includes("NO register axis") && l.includes("npx gulp discover")),
      "the axis-less door filed a volume with no register axis and said nothing about it");
    ok(logged.some((l) => l.includes("axis:         NO register axis")),
      "the door did not print, after filing, that none of the claims it filed answer a register question");

    // The prompt the axis-less door sent still carries a block — the honest one.
    const sent = calls[0].systemPrompt;
    ok(sent.includes("This series has no register declaration."),
      "the axis-less door sent a prompt that did not tell the model the series declares nothing");
    ok(sent.includes("Name no `axis` and no `value`"),
      "the axis-less door sent a prompt that left the model free to invent a question");

    // And the claims still file, exactly as they did before this slice.
    const store = rs.openReferenceStore({ volume: 1, folder: series.folder, seriesDir: series.dir, stage: rs.DOCUMENT_SOURCE_STAGE });
    try {
      assertInsideFixture(store.file, series.dir);
      const shape = axisShape(store);
      same(shape.facts, 1, "the axis-less door filed a different number of claims than it used to");
      same(shape.axisRows, 0, "an axis-less volume somehow filed an axis-bearing row");
      same(shape.cast, 1, "the claim did not register its character");
    } finally {
      store.close();
    }

    // The dry-run preview shows the block a live run would send, for a series that has none.
    const dry = await ev.runExtractPass({ seriesDir: series.dir, volumeArg: "01", dryRun: true, log: () => {} });
    same(dry.ok, true, "the axis-less door's --dry-run refused");
    same(dry.entries, 0, "--dry-run filed claims, which it must not do");

    console.log(`  ${calls.length} call, ${result.entries} claim(s) filed, 0 axis-bearing rows, the absence printed twice`);
  }

  // ─── 7. the stage still refuses what it refused before ────────────────────────

  {
    console.log("7. the two doors still disagree on purpose");

    const { resolveStageRegisterDeclaration } = require("../character-voice/task");
    const { isStructuralError } = require("../configs/shared");

    let refused = null;
    try {
      resolveStageRegisterDeclaration({});
    } catch (err) {
      refused = err;
    }
    ok(refused && isStructuralError(refused), "the stage no longer refuses a series with no declaration structurally");
    ok(refused && /gulp discover/.test(refused.message), `the stage's refusal does not name the door: ${refused && refused.message}`);

    // The stage composes the same block the manual door composes, so the two cannot ask a book two
    // different questions.
    const taskLayer = readModuleLayer(ROOT, "character-voice/task.js");
    ok(/buildExtractSystemPrompt\(prompts\.extractSystemPrompt, registerDeclaration\)/.test(taskLayer),
      "the stage no longer composes the extraction system prompt from the series' declaration");
    const extractLayer = readModuleLayer(ROOT, "extract-voice.js");
    ok(/buildExtractSystemPrompt\(baseSystemPrompt, registerDeclaration\)/.test(extractLayer),
      "extract-voice no longer composes the same prompt from the same declaration");
    ok(/readRegisterDeclaration\(seriesDir\)/.test(extractLayer),
      "extract-voice no longer reads the declaration off the series' own plan of record");
    for (const [name, layer] of [["character-voice/task.js", taskLayer], ["extract-voice.js", extractLayer]]) {
      ok(!/process\.env\.REGISTER|process\.env\.AXIS/.test(layer), `${name} puts an environment knob in front of the declaration`);
    }

    // The prompt file is read from disk by both doors, and neither one holds a copy of it.
    ok(/extractSystemPromptFile/.test(extractLayer), "extract-voice no longer reads the shared role file");
    const stagePromptCopy = readModuleLayer(ROOT, "character-voice/prompts.js");
    ok(!/You are a \*\*Voice and Perspective Analyst\*\*/.test(stagePromptCopy),
      "character-voice/prompts.js holds a copy of the role file, which is a second prompt nobody diffs");

    console.log("  the stage refuses, the manual door announces, and both compose the same block");
  }

}

main().then(() => {
  console.log(`\nvoice prompt and declaration: ${checks} checks, 0 model calls.`);
}).catch((err) => {
  console.error((err && err.stack) || err);
  process.exit(1);
});

