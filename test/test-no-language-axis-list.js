#!/usr/bin/env node
/**
 * test/test-no-language-axis-list.js — the guard on the owner's rule: **there is no register axis list
 * in code, in any language.**
 *
 * Plan 06 §4 says the register questions are declared per series, by the intake, from the book. Plan 06
 * §9 says the failure to watch for is a Japanese axis table reappearing in a `.js` file — because the
 * moment one exists, every series that is not Japanese is being asked Japanese's questions, and the
 * declaration layer becomes decoration.
 *
 * So this suite scans the pipeline's own source and refuses that shape. It is deliberately a **scan with
 * named limits**, not a magic detector, and it prints its limits rather than hiding them:
 *
 *   - **What it scans:** every `.js` file the pipeline runs — repository root plus every implementation
 *     folder — excluding `node_modules`, `test/`, `docs/`, plan folders, the series folder, the run's
 *     records, hook scripts and hidden directories. Pipeline code, not fixtures and not prose.
 *   - **Detector 1 — a language named next to an axis word.** A line that names a language AND names
 *     something axis-shaped (`axis`, `register`, `formality`, `quirk`, `politeness`, `honorific`,
 *     `value set`). That is the shape of "the pipeline knows what Korean's politeness levels are".
 *   - **Detector 2 — a register value vocabulary.** Two or more distinct string literals drawn from a
 *     vocabulary that lives **only in this test file**. If the pipeline ever holds the answers, the
 *     answers are in the pipeline. One literal is a word in a sentence; two is a set.
 *   - **Detector 3 — an axis block written in code.** A literal of the shape
 *     `{ id: "…", … values: [ …` anywhere in a file. This one is language-agnostic and vocabulary
 *     -agnostic: it catches a "universal" axis list whose answers are words this guard has never
 *     heard, which is the hole detector 2 leaves.
 *   - **What it does NOT scan, and why that is written down:** the prompt files. `system-prompts/` and
 *     `user-prompts/` are where a language's names legitimately live today — six of them name Japanese —
 *     and removing the rest is plan 06 slice 10, a prompt program, not this scan. This suite pins how
 *     many of them do, so the debt has a number that can only go down, and scenario 4 runs the same
 *     detectors over the voice extraction prompt so a language name put back into it is caught.
 *   - **The two named exemptions:** `QUIRK_TYPE_TO_ASPECT` and `QUIRK_TYPE_TO_VOICE_LABEL` map the
 *     extraction prompt's own quirk kinds (four of which are register-ish) onto the store's aspects. They
 *     are the collapse plan 06 §2.3 measured, and plan 06 slice 5 (2026-10-14) closed it **per claim, on
 *     the axis a claim names, rather than by renaming the aspects** — because the rows sitting on
 *     `register` are sealed and a sealed row is never re-labelled. So the exemption is permanent in shape
 *     and exact in size: a new key in either table is a failure, because a growing exemption is not an
 *     exemption, and the read side (`register/answers.js`) reports the collapse from this same table so
 *     the audit's number cannot drift from the mapping's.
 *
 * Plain `assert`, no framework, CommonJS — like the rest of the project. 0 model calls, 0 writes.
 */

require("./test-home");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

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

// ─── The vocabulary, which lives here and nowhere else ────────────────────────

/**
 * Language names the guard looks for. They are here, in a test, because the rule is that they must not
 * be anywhere else: a language list in the pipeline is the defect, and a language list in the guard that
 * catches it is not.
 *
 * @type {string[]}
 */
const LANGUAGE_NAMES = [
  "Japanese", "Korean", "Chinese", "Spanish", "French", "German", "English",
  "Portuguese", "Italian", "Russian", "日本語", "한국어",
];

/**
 * Axis-shaped words. Shape words, not language words: a pipeline may say "register" all day, it may not
 * say "register" while naming a language.
 *
 * @type {RegExp}
 */
const AXIS_SHAPED = /\b(axis|axes|register|formality|quirk|politeness|speechLevel|honorific|valueSet|value set)\b/i;

/**
 * The register **answers** the guard watches for. This is the vocabulary the extraction prompt used to
 * close its answer shape around, and the vocabulary a declaration is supposed to replace. It exists in
 * exactly one file in this repository: this one.
 *
 * @type {string[]}
 */
const REGISTER_VALUE_VOCABULARY = [
  "polite", "plain", "honorific", "humble", "mixed",
  "丁寧語", "普通語", "尊敬語", "謙譲語", "ですます", "である",
];

/**
 * An **axis block written in code**: a literal that declares an id and a list of accepted answers.
 * Language-agnostic and vocabulary-agnostic — this is the detector that catches a "universal" axis list
 * whose answers are words this guard has never heard of.
 *
 * Measured before it was pinned (against the pipeline `.js` files it scans — 412 today, 408 when this
 * guard was pinned): **0 hits on legitimate material.** Two wider candidates were measured and dropped for firing on real files —
 * naming a language anywhere in a file that also mentions an axis and holds a list-shaped line fires
 * **4** times on legitimate code (`types.js`, `utils/reference-store/evidence.js`,
 * `utils/source/chapters.js`, `utils/source/extract.js` — all prose, no axis list), and any
 * `const AXIS… = [` fires **3** times on this layer's own legitimate shape constants
 * (`AXIS_FIELDS`, `AXIS_REQUIRED_FIELDS`, `AXIS_SCOPES` — lists of *field names*, not answers).
 *
 * @type {RegExp}
 */
const AXIS_BLOCK_IN_CODE = /\{\s*"?(?:id|axis)"?\s*:\s*"[^"]+"[^{}]{0,200}?\b(?:values|valueSet|answers)\s*:\s*\[/is;

// ─── The scan ─────────────────────────────────────────────────────────────────

/** Folders that are not pipeline code. Stated rather than inferred, because a scan whose limits are
 * unknown is a scan that can be quietly narrowed. */
const SKIP_DIRS = new Set([
  "node_modules", "test", "docs", "plan", "epub_source", "hooks", "calibration", "test-series",
]);

/**
 * Collect the pipeline's own `.js` files.
 *
 * @param {string} [dir] @param {string[]} [out]
 * @returns {string[]} Absolute paths, sorted.
 */
function pipelineSourceFiles(dir = ROOT, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      pipelineSourceFiles(full, out);
    } else if (entry.name.endsWith(".js")) {
      out.push(full);
    }
  }
  return out.sort();
}

/**
 * One file's findings. Pure: it takes text, so the self-test can feed it planted text without writing a
 * planted file anywhere.
 *
 * @param {string} file - Name to report.
 * @param {string} source - The text.
 * @returns {Array<{file: string, detector: string, detail: string}>}
 */
function scanSourceForAxisLists(file, source) {
  const findings = [];
  source.split("\n").forEach((line, i) => {
    const namedLanguage = LANGUAGE_NAMES.some((l) => line.includes(l));
    if (namedLanguage && AXIS_SHAPED.test(line)) {
      findings.push({
        file,
        detector: "language-named-next-to-an-axis",
        detail: `line ${i + 1}: ${line.trim().slice(0, 140)}`,
      });
    }
  });
  const literals = new Set();
  for (const value of REGISTER_VALUE_VOCABULARY) {
    if (new RegExp(`["'\`]${value}["'\`]`).test(source)) literals.add(value);
  }
  if (literals.size >= 2) {
    findings.push({
      file,
      detector: "register-value-vocabulary",
      detail: `${literals.size} declared answers held in code: ${[...literals].join(", ")}`,
    });
  }
  const block = AXIS_BLOCK_IN_CODE.exec(source);
  if (block) {
    findings.push({
      file,
      detector: "axis-block-in-code",
      detail: `declares an id and a value set in code: ${block[0].replace(/\s+/g, " ").slice(0, 140)}`,
    });
  }
  return findings;
}

// ─── 1. the real pipeline is clean ────────────────────────────────────────────

{
  console.log("1. the pipeline's own source");

  const files = pipelineSourceFiles();
  const relative = files.map((f) => path.relative(ROOT, f));
  ok(files.length > 300, `the scan reaches the whole pipeline (${files.length} .js files)`);

  // The files that would matter most if an axis list ever appeared in one of them.
  for (const expected of [
    "utils/reference-store/register/declaration.js",
    "utils/reference-store/register/filing.js",
    "utils/reference-store/schema.js",
    "utils/reference-store/extraction-adapter.js",
    "character-voice/task.js",
    "character-voice/stages.js",
    "intake/validate.js",
    "utils/reference-store/facts/validate.js",
  ]) {
    ok(relative.includes(expected), `the scan covers ${expected}`);
  }

  const findings = [];
  for (const file of files) {
    findings.push(...scanSourceForAxisLists(path.relative(ROOT, file), fs.readFileSync(file, "utf8")));
  }
  if (findings.length) {
    console.log(findings.map((f) => `  [${f.detector}] ${f.file} — ${f.detail}`).join("\n"));
  }
  same(findings, [], "no axis list and no register value vocabulary anywhere in the pipeline's code");

  // The module that owns the shape names no language at all — the strongest form of the rule.
  for (const file of ["utils/reference-store/register/declaration.js", "utils/reference-store/register/filing.js", "utils/reference-store/register.js"]) {
    const text = fs.readFileSync(path.join(ROOT, file), "utf8");
    const named = LANGUAGE_NAMES.filter((l) => text.includes(l));
    same(named, [], `${file} names no language, in prose or in code`);
  }

  console.log(`  ${files.length} pipeline .js files scanned, 0 findings`);
}

// ─── 2. the scan is not vacuous: planted defects are caught ───────────────────

{
  console.log("2. planted defects, and the boundary of each detector");

  /** @type {Array<{name: string, text: string, expectDetectors: string[]}>} */
  const planted = [
    {
      name: "a Japanese axis table in a pipeline module",
      text: `// The register axes Japanese books turn on.\nconst REGISTER_AXES = [\n  { id: "formality", asks: "How polite?", values: ["丁寧語", "普通語", "尊敬語", "謙譲語"] },\n  { id: "pronoun", asks: "Which first person?", values: ["俺", "僕", "私"] },\n];\nmodule.exports = { REGISTER_AXES };\n`,
      expectDetectors: ["language-named-next-to-an-axis", "register-value-vocabulary", "axis-block-in-code"],
    },
    {
      name: "a \"universal\" four-axis list",
      text: `// Every language has these four register axes.\nconst UNIVERSAL_AXES = [\n  { id: "formality", values: ["polite", "plain", "honorific", "humble"] },\n  { id: "pronoun", values: ["first-person", "third-person"] },\n];\n// A Korean series gets the same four register axes.\nmodule.exports = { UNIVERSAL_AXES };\n`,
      expectDetectors: ["language-named-next-to-an-axis", "register-value-vocabulary", "axis-block-in-code"],
    },
    {
      name: "a \"universal\" axis list whose answers are words this guard has never heard",
      text: `const DEFAULT_AXES = [\n  { id: "deference", asks: "how much deference?", values: ["flat", "warm", "cold", "elevated"] },\n];\nmodule.exports = { DEFAULT_AXES };\n`,
      expectDetectors: ["axis-block-in-code"],
    },
    {
      name: "the same axis block written across several lines",
      text: `const REGISTER_AXES = [\n  {\n    id: "addressing",\n    asks: "how does the character address others?",\n    values: ["casual", "formal", "intimate"],\n  },\n];\nmodule.exports = { REGISTER_AXES };\n`,
      expectDetectors: ["axis-block-in-code"],
    },
    {
      name: "a default value set bolted onto the filing gate",
      text: `function defaultRegisterValues(axis) {\n  if (axis === "formality") return ["polite", "plain", "honorific", "humble", "mixed"];\n  return null;\n}\nmodule.exports = { defaultRegisterValues };\n`,
      expectDetectors: ["register-value-vocabulary"],
    },
    {
      name: "a language named next to an axis, with no vocabulary",
      text: `// The Spanish axes this stage asks about.\nconst ASKS = { axis: "formality", asks: "how formal?" };\nmodule.exports = { ASKS };\n`,
      expectDetectors: ["language-named-next-to-an-axis"],
    },
    // The boundary, stated honestly: one vocabulary word in a sentence is not a set, a language named
    // without an axis word is the intake doing its job, and a list of *field names* is not a value set.
    {
      name: "one vocabulary word, in prose (not a set)",
      text: `// A value outside the declared set is refused, so "polite" is never bucketed into a nearby answer.\nmodule.exports = { ok: true };\n`,
      expectDetectors: [],
    },
    {
      name: "a language named with no axis word (the intake's own job)",
      text: `const sourceLanguage = "Japanese";\nmodule.exports = { sourceLanguage };\n`,
      expectDetectors: [],
    },
    {
      name: "an axis word with no language (the shape this layer actually holds)",
      text: `const AXIS_REQUIRED_FIELDS = ["id", "asks", "values"];\nfunction registerFilingRefusal(ctx, proposal) { return null; }\nmodule.exports = { AXIS_REQUIRED_FIELDS, registerFilingRefusal };\n`,
      expectDetectors: [],
    },
    {
      name: "this layer's own shape constants: field names and scopes, never answers",
      text: `const AXIS_FIELDS = ["id", "asks", "values", "guidance", "scope", "renders", "evidence"];\nconst AXIS_SCOPES = ["character", "character-addressee"];\nmodule.exports = { AXIS_FIELDS, AXIS_SCOPES };\n`,
      expectDetectors: [],
    },
  ];

  for (const plant of planted) {
    const findings = scanSourceForAxisLists(`planted:${plant.name}`, plant.text);
    const detectors = [...new Set(findings.map((f) => f.detector))].sort();
    same(detectors, [...plant.expectDetectors].sort(), `planted defect caught: ${plant.name}`);
    if (plant.expectDetectors.length) {
      ok(findings.every((f) => f.detail), `and the finding says where: ${findings[0].detail}`);
    }
  }

  console.log(`  ${planted.length} planted sources: ${planted.filter((p) => p.expectDetectors.length).length} caught, ${planted.filter((p) => !p.expectDetectors.length).length} correctly left alone`);
}

// ─── 3. the two exemptions are pinned by name and by key set ──────────────────

{
  console.log("3. the two collapse tables are exempt, and the exemption does not grow");

  const { QUIRK_TYPE_TO_ASPECT } = require("../utils/reference-store/extraction-adapter");
  const { QUIRK_TYPE_TO_VOICE_LABEL } = require("../utils/reference-store/rebuild");
  const { FACT_ASPECTS } = require("../utils/reference-store/schema");
  const { collapsedAspectAccount, aspectOfQuirkType } = require("../utils/reference-store/register");

  // The mapping the extraction prompt's own quirk kinds need. Plan 06 slice 5 (2026-10-14) closed §2.3's
  // collapse **on the axis, not on these aspect names**, and that is why the four-into-one is still here
  // and still pinned at four: the rows sitting on `register` are published, and a sealed row is never
  // edited, moved or re-labelled. Renaming the aspect would be rewriting sealed rows, which this store
  // forbids. What answers a question now is `facts.axis` / `facts.axis_value`, checked at filing against
  // the series' own declaration; this table is the fallback for a claim that names no question.
  same(Object.keys(QUIRK_TYPE_TO_ASPECT).sort(), [
    "catchphrase", "dialect", "formality", "internalvoice", "pronoun", "sentenceending", "vocabulary",
  ], "QUIRK_TYPE_TO_ASPECT has exactly the seven keys the extraction prompt's quirkType list has");
  same(Object.keys(QUIRK_TYPE_TO_VOICE_LABEL).sort(), [
    "catchphrase", "dialect", "formality", "internalvoice", "pronoun", "sentenceending", "vocabulary",
  ], "QUIRK_TYPE_TO_VOICE_LABEL is the same seven, on the rebuild side");
  same(QUIRK_TYPE_TO_ASPECT.formality, "register",
    "formality still lands on `register`: the aspect is the fallback for a claim that names no axis, and renaming it would re-label sealed rows (plan 06 slice 5)");
  same(QUIRK_TYPE_TO_ASPECT.vocabulary, "register",
    "vocabulary still lands on the same aspect — so a claim that answers a declared question is answerable by that question, and one that names none is answerable only by this collapsed aspect");
  same(QUIRK_TYPE_TO_ASPECT.dialect, "register", "dialect still lands on the same aspect");
  same(
    Object.values(QUIRK_TYPE_TO_ASPECT).filter((aspect) => aspect === "register").length,
    4,
    "four of the seven kinds still share one aspect — the collapse is closed per claim (by the axis a claim names), not by renaming the aspect, because a sealed row is never re-labelled"
  );

  // The table maps onto the store's closed aspect vocabulary and onto nothing else: it is not a list of
  // questions, and a value that was an axis id would be the axis list the owner forbade, wearing a table.
  const unmapped = Object.entries(QUIRK_TYPE_TO_ASPECT).filter(([, aspect]) => !FACT_ASPECTS.includes(aspect));
  same(unmapped, [], "every value of the mapping is an aspect this store's vocabulary declares — the table maps kinds onto aspects, never onto questions");

  // The read side reports the collapse, and it derives the number from this table rather than restating it,
  // so the audit's number and the mapping cannot drift apart.
  const collapse = collapsedAspectAccount();
  same([collapse.aspect, collapse.kindsCollapsed, collapse.kinds],
    ["register", 4, ["dialect", "formality", "sentenceending", "vocabulary"]],
    "register/answers.js reports this same collapse, derived from this same table");
  same(aspectOfQuirkType("formality").answersADeclaredQuestion, false,
    "an aspect on its own answers no declared question — the pair `facts.axis` / `facts.axis_value` is what makes a claim answerable (plan 06 §2.3, slice 5)");

  // Neither table names a language or a language's forms: the exemption is about the prompt's field
  // names, not about Japanese. (One combined check per table instead of two: it refuses the same set of
  // defects, and the freed checks went to the two assertions above.)
  for (const [name, table] of [["QUIRK_TYPE_TO_ASPECT", QUIRK_TYPE_TO_ASPECT], ["QUIRK_TYPE_TO_VOICE_LABEL", QUIRK_TYPE_TO_VOICE_LABEL]]) {
    const text = JSON.stringify(table);
    same(
      [
        ...LANGUAGE_NAMES.filter((l) => text.includes(l)),
        ...REGISTER_VALUE_VOCABULARY.filter((v) => text.includes(v)),
      ],
      [],
      `${name} names no language and holds no register answer values`
    );
  }

  console.log("  7 keys each, 4 of them still collapsed into `register` (the fallback), the collapse reported by the read side from the same table, neither table holding a language");
}

// ─── 4. the prompt debt is named, counted, and can only shrink ────────────────

{
  console.log("4. what this guard does NOT cover, with a number attached");

  const promptDirs = ["system-prompts", "user-prompts"];
  const promptFiles = [];
  for (const dir of promptDirs) {
    for (const name of fs.readdirSync(path.join(ROOT, dir)).sort()) {
      if (name.endsWith(".md")) promptFiles.push(path.join(dir, name));
    }
  }
  const namingJapanese = promptFiles.filter((rel) => /japanese|日本語/i.test(fs.readFileSync(path.join(ROOT, rel), "utf8")));

  ok(promptFiles.length >= 40, `${promptFiles.length} prompt files exist`);
  // Pinned at exactly 6 since plan 06 slice 4 took the voice extraction prompt out of this list. It was 7.
  // The number is pinned rather than capped because a cap lets a new Japanese-named prompt in silently,
  // and the six that remain are the ones plan 06 slice 10 still has to do.
  same(namingJapanese.length, 6,
    `prompt files that name Japanese: ${namingJapanese.length} — 6 since slice 4 removed the voice extraction prompt; the rest are plan 06 slice 10`);
  same(namingJapanese.includes("system-prompts/character-voice-extract.md"), false,
    "the voice extraction prompt names Japanese again — slice 4 is what took it out, and the register questions " +
      "are appended in code (character-voice/prompts.js), not written into the file");
  ok(namingJapanese.includes("system-prompts/character-voice-acceptance.md"),
    "the voice acceptance prompt still names Japanese — that is slice 10's, not slice 4's");
  ok(namingJapanese.includes("system-prompts/translation-target.md"),
    "the intake prompt names Japanese too — it is the file that asks the intake to decide the register questions from the book");

  // The planted check, which is the half that makes the scan above more than a count: a language name put
  // back into the voice prompt is caught by the same rule that catches one put into a `.js` file.
  const voicePrompt = fs.readFileSync(path.join(ROOT, "system-prompts", "character-voice-extract.md"), "utf8");
  same(scanSourceForAxisLists("system-prompts/character-voice-extract.md", voicePrompt), [],
    "the voice extraction prompt trips the axis-list guard on its own text");
  const planted = scanSourceForAxisLists("planted: a Japanese axis list put back into the voice prompt",
    `${voicePrompt}\n\nAnswer the formality axis in Japanese: "丁寧語", "普通語", "尊敬語", "謙譲語".\n`);
  ok(planted.some((f) => f.detector === "register-value-vocabulary"),
    "the planted Japanese register vocabulary in the voice prompt was not reported");
  ok(planted.some((f) => f.detector === "language-named-next-to-an-axis"),
    "a language named next to an axis word in the voice prompt was not reported");

  console.log(`  ${namingJapanese.length}/${promptFiles.length} prompt files name Japanese; the .js scan does not cover them, and that is written down`);
}

console.log(`\nno axis list in code: ${checks} checks, 0 model calls.`);
