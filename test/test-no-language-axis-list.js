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
 *   - **What it scans with a different rule:** the prompt files. `system-prompts/` and `user-prompts/` are
 *     prose addressed to a model, and a language name can legitimately live there — the intake's job
 *     includes working out which language the book is in, and it cannot do that without naming the
 *     candidates. So scenario 4 does not count how many prompt files name a language (that count was a
 *     lie waiting to happen: it counted the intake's detection rule as if it were the defect). It reads
 *     **every line in every prompt file that names a language**, puts each one in a named bucket by what
 *     the mention is FOR, pins the whole inventory, and pins the framing bucket at **empty**. A prompt
 *     that names the language of the work it is analysing — the defect plan 06 slice 4 removed from the
 *     voice extraction prompt and slice 10 removed from five more — is a finding whether or not the file
 *     has a right to name languages at all.
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

// ─── 4. the prompt debt, measured as a distinction rather than a count ────────

/**
 * The shape plan 06 slice 4 removed from the voice extraction prompt, and slice 10 removed from five
 * more: a prompt naming **the language of the work it is analysing**, before the model has read a word of
 * the book. `a Japanese light novel series` is the whole defect — it tells the model what to look for.
 *
 * Measured against all 43 prompt files before slice 10: it fires on **5** lines, and all 5 are the role
 * sentence of a prompt (`character-voice-acceptance`, `style-guide-acceptance`, `style-guide-extract`,
 * `style-guide`, `style-guide-validator`). It fires on **0** of the 7 language-naming lines that remain,
 * which name a language as something to work out from the page or as the language being written. That
 * zero-false-hit measurement is why this shape is pinned and the raw file count was not.
 *
 * The boundary, stated rather than hidden: it reads a language name attached to a noun for the work. A
 * legitimate detection sentence written that way — "a Chinese book uses Han characters" — would trip it,
 * and the guard would be wrong. That is deliberate: the wrong answer here is a human looking at one line
 * and moving it into the pinned table, not a defect walking past.
 *
 * @type {RegExp}
 */
const FRAMING_SHAPE = new RegExp(
  `\\b(?:${LANGUAGE_NAMES.map((l) => l.replace(/[.*+?^${}()/[\]\\]/g, "\\$&")).join("|")})` +
    `\\s+(?:light[-\\s]+)?(?:novel|series|book|books|manga|manhwa|web\\s+novel|trilogy)\\b`,
  "i"
);

/** The buckets a language mention in a prompt may be in. A mention in none of them is a finding. */
const PROMPT_MENTION_BUCKETS = [
  "names-the-work-being-analysed", // the defect: must stay empty
  "works-out-the-source-language", // the intake's job: legitimate
  "names-the-language-being-written", // the output language: legitimate today, named as debt
];

/**
 * Every line in every prompt file that names a language, and what that mention is for. Pinned as an
 * inventory rather than as a count: a new language-naming line anywhere in any prompt file fails this
 * guard until somebody reads it and says which bucket it belongs in.
 *
 * Measured 2026-10-15, after plan 06 slice 10 took the five framing sentences out: 7 lines, 2 files.
 *
 * @type {Array<{file: string, line: string, bucket: string, because: string}>}
 */
const PROMPT_LANGUAGE_MENTIONS = [
  {
    file: "system-prompts/translation-target.md",
    line: '"Book Three", a Japanese volume marker.',
    bucket: "works-out-the-source-language",
    because: "an example of a volume-number marker the intake may find in a file or folder name",
  },
  {
    file: "system-prompts/translation-target.md",
    line: "- kana (hiragana or katakana) present → Japanese;",
    bucket: "works-out-the-source-language",
    because: "a detection rule: script evidence → a language name",
  },
  {
    file: "system-prompts/translation-target.md",
    line: "- hangul present → Korean;",
    bucket: "works-out-the-source-language",
    because: "a detection rule, and the reason the rule is not a hard-wire: it names three candidates",
  },
  {
    file: "system-prompts/translation-target.md",
    line: "- Han characters with no kana and no hangul → Chinese;",
    bucket: "works-out-the-source-language",
    because: "a detection rule",
  },
  {
    file: "system-prompts/translation-target.md",
    line: 'language by name ("Japanese", "Korean"), not a code.',
    bucket: "works-out-the-source-language",
    because: "the answer format the intake's own language decision is written in",
  },
  {
    file: "system-prompts/translation-target.md",
    line: "- source-language characters are fine and preferred (Japanese folder names are",
    bucket: "works-out-the-source-language",
    because: "a folder-naming rule that gives one example; it does not say the series is Japanese",
  },
  {
    file: "system-prompts/verify-translate.md",
    line: "4. **Readability** — awkward, broken, or ambiguous English; leftover source-language text (stray kanji/kana that should have been translated); duplicated or garbled passages.",
    bucket: "names-the-language-being-written",
    because: "the target language is a setting (TRANSLATION_TARGET_LANGUAGE, default English) and this rubric line states it as a fact — named as debt, not fixed by this slice",
  },
];

/**
 * The five role sentences plan 06 slice 10 took out of the prompts. Kept here so the guard can plant each
 * one back and prove the rewritten scan reports it — the whole point of rewriting the guard instead of
 * lowering a number.
 *
 * @type {Array<{file: string, sentence: string}>}
 */
const SLICE10_FRAMING_SENTENCES = [
  {
    file: "system-prompts/character-voice-acceptance.md",
    sentence: "You are a **Quality Gatekeeper** for a character voice and perspective reference for a Japanese light novel series.",
  },
  {
    file: "system-prompts/style-guide-acceptance.md",
    sentence: "You are a **Quality Gatekeeper** for a style guide for a Japanese light novel series.",
  },
  {
    file: "system-prompts/style-guide-extract.md",
    sentence: "You are a **Style Convention Analyst** for a long-running Japanese light novel series being translated from the source language.",
  },
  {
    file: "system-prompts/style-guide.md",
    sentence: "You are a **Style Guide Archivist** maintaining the canonical style guide for a Japanese light novel series being translated from the source language into the target language.",
  },
  {
    file: "system-prompts/style-guide-validator.md",
    sentence: "You are a **Style Guide Auditor** operating in **adversarial mode**. You validate the style guide for a Japanese light novel series being translated from the source language.",
  },
];

/**
 * The prompt files that print characters of one language's script in their examples, measured 2026-10-15.
 * Named because "no prompt names a language" is not the same claim as "no prompt prints one": the voice
 * extraction prompt meets the stronger version (slice 4), these six do not, and their examples are
 * instructions — one of them mirrored by a closed answer schema — so they are not this slice's to change.
 *
 * @type {string[]}
 */
const PROMPT_FILES_PRINTING_CJK = [
  "system-prompts/glossary-terms.md",
  "system-prompts/style-guide-extract.md",
  "system-prompts/style-guide-validator.md",
  "system-prompts/style-guide.md",
  "system-prompts/translation-target.md",
  "user-prompts/translate.md",
];

/**
 * Every language-naming line of one prompt file, with the framing shape already tested against it. Pure:
 * it takes text, so a planted sentence can be scanned without writing a planted file.
 *
 * @param {string} file - Name to report.
 * @param {string} text - The prompt's text.
 * @returns {Array<{file: string, line: string, named: string[], framing: boolean}>}
 */
function promptLanguageMentions(file, text) {
  const out = [];
  text.split("\n").forEach((raw) => {
    const line = raw.trim();
    const named = LANGUAGE_NAMES.filter((l) => line.includes(l));
    if (!named.length) return;
    out.push({ file, line, named, framing: FRAMING_SHAPE.test(line) });
  });
  return out;
}

/**
 * Compare a prompt file's language mentions against the pinned inventory. Two independent rules, and both
 * have to hold: an unknown mention is a finding, and a mention whose framing shape contradicts the bucket
 * it was filed under is a finding — so the table cannot file a framing claim as a detection rule.
 *
 * @param {Array<{file: string, line: string, framing: boolean}>} mentions
 * @param {Array<{file: string, line: string, bucket: string}>} table
 * @returns {Array<{detector: string, detail: string}>}
 */
function promptMentionFindings(mentions, table) {
  const findings = [];
  for (const m of mentions) {
    const row = table.find((t) => t.file === m.file && t.line === m.line);
    if (!row) {
      findings.push({
        detector: m.framing
          ? "a-prompt-names-the-language-of-the-work-it-analyses"
          : "language-mention-in-a-prompt-nobody-classified",
        detail: `${m.file}: ${m.line.slice(0, 140)}`,
      });
      continue;
    }
    if (m.framing !== (row.bucket === "names-the-work-being-analysed")) {
      findings.push({
        detector: "a-framing-claim-was-filed-as-something-else",
        detail: `${m.file} is filed as "${row.bucket}" but reads as the work's own language: ${m.line.slice(0, 140)}`,
      });
    }
  }
  return findings;
}

{
  console.log("4. what each prompt file names a language FOR, pinned line by line");

  const promptFiles = [];
  for (const dir of ["system-prompts", "user-prompts"]) {
    for (const name of fs.readdirSync(path.join(ROOT, dir)).sort()) {
      if (name.endsWith(".md")) promptFiles.push(`${dir}/${name}`);
    }
  }
  ok(promptFiles.length >= 40, `${promptFiles.length} prompt files exist`);

  const mentions = [];
  for (const rel of promptFiles) {
    mentions.push(...promptLanguageMentions(rel, fs.readFileSync(path.join(ROOT, rel), "utf8")));
  }

  // 4a. the inventory: every mention is one a person has read and bucketed. The crisp check runs first and
  // prints the offending line, so a planted framing sentence fails by naming itself rather than by dumping
  // two inventories.
  const mentionFindings = promptMentionFindings(mentions, PROMPT_LANGUAGE_MENTIONS);
  if (mentionFindings.length) {
    console.log(mentionFindings.map((f) => `  [${f.detector}] ${f.detail}`).join("\n"));
  }
  same(mentionFindings, [], "no prompt file names a language in a way nobody classified");
  same(mentions.map((m) => `${m.file} :: ${m.line}`), PROMPT_LANGUAGE_MENTIONS.map((m) => `${m.file} :: ${m.line}`),
    "every line in every prompt file that names a language is in the pinned inventory, and the inventory holds nothing else");

  // 4b. the two lists the owner's rule turns on.
  const framing = PROMPT_LANGUAGE_MENTIONS.filter((m) => m.bucket === "names-the-work-being-analysed");
  same(framing, [],
    "no prompt file names a language as the thing being analysed — the defect plan 06 slices 4 and 10 removed, pinned empty");
  same(mentions.filter((m) => m.framing).map((m) => m.file), [],
    "and the shape detector agrees with the inventory: 0 prompt lines read as naming the work's own language");

  const detection = PROMPT_LANGUAGE_MENTIONS.filter((m) => m.bucket === "works-out-the-source-language");
  same([...new Set(detection.map((m) => m.file))], ["system-prompts/translation-target.md"],
    "the only prompt file that names a language as a property to detect is the intake's own — it decides the source language, and the register questions, from the book");
  same(detection.length, 6, "the intake's language decision is 6 lines, and 6 lines is all of it");

  const target = PROMPT_LANGUAGE_MENTIONS.filter((m) => m.bucket === "names-the-language-being-written");
  same([...new Set(target.map((m) => m.file))], ["system-prompts/verify-translate.md"],
    "one prompt names the OUTPUT language as a fact rather than reading it from the setting — named as debt, not this slice's to change");

  // 4c. the five files slice 10 fixed now name no language at all, in any form.
  for (const plant of SLICE10_FRAMING_SENTENCES) {
    const text = fs.readFileSync(path.join(ROOT, plant.file), "utf8");
    same(LANGUAGE_NAMES.filter((l) => text.includes(l)), [],
      `${plant.file} names no language anywhere after slice 10`);
  }

  // 4d. the planted half: each removed sentence put back is reported, by both rules.
  for (const plant of SLICE10_FRAMING_SENTENCES) {
    const text = fs.readFileSync(path.join(ROOT, plant.file), "utf8");
    const planted = promptLanguageMentions(plant.file, `${text}\n${plant.sentence}\n`);
    const hit = planted.filter((m) => m.framing);
    same(hit.length, 1, `the framing sentence put back into ${plant.file} was reported as naming the work's own language`);
    same(promptMentionFindings(planted, PROMPT_LANGUAGE_MENTIONS).length, 1,
      `and the inventory rule reported it too: ${plant.file}`);
  }

  // 4e. the boundary, in both directions. A detection rule is not the defect — but a new one still has to
  // be read and bucketed, and a framing claim inside a file that legitimately names languages is still the
  // defect. The lists are per line, not per file.
  const intakeText = fs.readFileSync(path.join(ROOT, "system-prompts/translation-target.md"), "utf8");
  const plantedDetection = promptLanguageMentions("system-prompts/glossary-terms.md",
    `${fs.readFileSync(path.join(ROOT, "system-prompts/glossary-terms.md"), "utf8")}\n- hangul present → Korean;\n`);
  same(plantedDetection.filter((m) => m.framing), [],
    "a detection rule is NOT read as the defect: 'hangul present → Korean' names no work");
  same(promptMentionFindings(plantedDetection, PROMPT_LANGUAGE_MENTIONS).length, 1,
    "but a detection rule appearing somewhere new is still reported, because nobody has said that file may name a language");
  const plantedFramingInIntake = promptLanguageMentions("system-prompts/translation-target.md",
    `${intakeText}\nYou validate the style guide for a Japanese light novel series.\n`);
  same(plantedFramingInIntake.filter((m) => m.framing).length, 1,
    "and a framing claim inside the file that legitimately detects languages is still the defect — the buckets are per line");

  // 4e. the voice extraction prompt: the stronger claim slice 4 made, still true.
  const voicePrompt = fs.readFileSync(path.join(ROOT, "system-prompts", "character-voice-extract.md"), "utf8");
  same(scanSourceForAxisLists("system-prompts/character-voice-extract.md", voicePrompt), [],
    "the voice extraction prompt trips the axis-list guard on its own text");
  same(LANGUAGE_NAMES.filter((l) => voicePrompt.includes(l)), [],
    "the voice extraction prompt names no language — slice 4, and the register questions are appended in code (character-voice/prompts.js), not written into the file");
  const plantedVoice = scanSourceForAxisLists("planted: a Japanese axis list put back into the voice prompt",
    `${voicePrompt}\n\nAnswer the formality axis in Japanese: "丁寧語", "普通語", "尊敬語", "謙譲語".\n`);
  ok(plantedVoice.some((f) => f.detector === "register-value-vocabulary"),
    "the planted Japanese register vocabulary in the voice prompt was not reported");
  ok(plantedVoice.some((f) => f.detector === "language-named-next-to-an-axis"),
    "a language named next to an axis word in the voice prompt was not reported");

  // 4f. naming a language and printing one are different claims, and only the weaker one is clean today.
  const CJK_SCRIPT = /[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/;
  const printing = promptFiles.filter((rel) => CJK_SCRIPT.test(fs.readFileSync(path.join(ROOT, rel), "utf8")));
  same(printing, PROMPT_FILES_PRINTING_CJK,
    "the prompt files that still print one language's script in their examples are these six, named — their examples are instructions, and one is mirrored by a closed answer schema, so they are not this guard's to delete");
  same(PROMPT_FILES_PRINTING_CJK.includes("system-prompts/character-voice-extract.md"), false,
    "the voice extraction prompt prints 0 characters of any CJK script — the stronger form slice 4 met");

  console.log(`  ${promptFiles.length} prompt files: ${framing.length} name a language as the work, ` +
    `${new Set(detection.map((m) => m.file)).size} names languages as things to detect (${detection.length} lines), ` +
    `${new Set(target.map((m) => m.file)).size} names the output language, ` +
    `${printing.length} still print one language's script in their examples`);
}

console.log(`\nno axis list in code: ${checks} checks, 0 model calls.`);
