/**
 * test-glossary-load.js — self-checks for the pure parsing helpers, the
 * agent-mode prompt builders, and the agent safety nets in glossary.js and
 * jump-in-wiki.js. Run with `npm test`.
 */
const assert = require("assert");

const {
  parseTerms,
  buildGlossaryResearcherTurnPrompt,
  buildGlossaryAuthorTurnPrompt,
  buildGlossaryValidatorTurnPrompt,
  buildGlossaryFeedbackTurnPrompt,
} = require("../glossary");
const {
  transformUserPrompt,
  isPassingVerdict,
  installmentNumberFromDir,
  validatorMaxStepsFor,
  writePromptDump,
  buildWikiAuthorSystemPrompt,
  buildWikiValidatorSystemPrompt,
  buildWikiAuthorTurnPrompt,
  buildWikiValidatorTurnPrompt,
  buildWikiFeedbackTurnPrompt,
} = require("../jump-in-wiki");
const {
  extractJsonObject,
  validateManifest,
} = require("../get-translation-target");

// ─── parseTerms ─────────────────────────────────────────────────────────────
assert.deepStrictEqual(parseTerms(""), []);
assert.deepStrictEqual(parseTerms(null), []);
assert.deepStrictEqual(
  parseTerms('```json\n[{"term":"如月雨露","type":"character","query":"如月雨露"}]```'),
  [{ term: "如月雨露", type: "character", query: "如月雨露" }]
);
assert.deepStrictEqual(
  parseTerms('[{"term":"A"}]'),
  [{ term: "A", type: "concept", query: "A" }]
);
assert.deepStrictEqual(
  parseTerms('Here are the terms:\n[{"term":"B","type":"item","query":"B"}]\nDone.'),
  [{ term: "B", type: "item", query: "B" }]
);
assert.deepStrictEqual(
  parseTerms('[{"term":"  "},{"term":"C","type":"place"}]'),
  [{ term: "C", type: "place", query: "C" }]
);
assert.throws(() => parseTerms("no json here"), /No JSON array/);
assert.throws(() => parseTerms('{"term":"A"}'), /No JSON array/);

// ─── transformUserPrompt ────────────────────────────────────────────────────
assert.strictEqual(
  transformUserPrompt("Hi {{NAME}}, vol {{NUM}}", { NAME: "X", NUM: "01" }),
  "Hi X, vol 01"
);
assert.throws(() => transformUserPrompt("{{A}}", { A: "" }), /Missing value/);
assert.throws(() => transformUserPrompt("{{A}} {{B}}", { A: "1" }), /Unfilled placeholder/);

// ─── isPassingVerdict ───────────────────────────────────────────────────────
assert.strictEqual(isPassingVerdict("PASS"), true);
assert.strictEqual(isPassingVerdict("  pass\n"), true);
assert.strictEqual(isPassingVerdict("PASS with minor edits"), true);
assert.strictEqual(isPassingVerdict("Verdict: PASS"), true);
assert.strictEqual(isPassingVerdict("FAIL"), false);
assert.strictEqual(isPassingVerdict("The glossary does not pass."), false);
assert.strictEqual(isPassingVerdict("FAIL — it does not pass the check."), false);
assert.strictEqual(isPassingVerdict(""), false);
assert.strictEqual(isPassingVerdict(undefined), false);

// ─── installmentNumberFromDir ───────────────────────────────────────────────
assert.strictEqual(installmentNumberFromDir("Series(1)"), "01");
assert.strictEqual(installmentNumberFromDir("Series(12)"), "12");
assert.throws(() => installmentNumberFromDir("Series"), /Cannot derive/);

// ─── extractJsonObject ──────────────────────────────────────────────────────
assert.deepStrictEqual(extractJsonObject('{"a":1}'), { a: 1 });
assert.deepStrictEqual(extractJsonObject('```json\n{"a":1}\n```'), { a: 1 });
assert.deepStrictEqual(
  extractJsonObject('Here you go:\n{"a":{"b":2}}\nDone.'),
  { a: { b: 2 } }
);
assert.throws(() => extractJsonObject("no json object here"), /No JSON object/);
assert.throws(() => extractJsonObject(""), /No text/);

// ─── validateManifest ───────────────────────────────────────────────────────
const goodManifest = {
  seriesLocation: "/x",
  seriesName: "s",
  volumes: [
    { installmentNumber: "01", folder: "s(1)", sourceFile: "s(1)/s(1).md" },
    { installmentNumber: "02", folder: "s(2)", sourceFile: "s(2)/s(2).md" },
  ],
};
assert.strictEqual(validateManifest(goodManifest), goodManifest);
assert.throws(() => validateManifest({}), /no volumes/i);
assert.throws(() => validateManifest({ volumes: [] }), /no volumes/i);
assert.throws(
  () =>
    validateManifest({
      volumes: [{ installmentNumber: "01", folder: "s(1)", sourceFile: "" }],
    }),
  /sourceFile/
);
assert.throws(
  () =>
    validateManifest({
      volumes: [
        { installmentNumber: "01", folder: "s(1)", sourceFile: "a" },
        { installmentNumber: "01", folder: "s(2)", sourceFile: "b" },
      ],
    }),
  /duplicates installment/
);

// ─── validatorMaxStepsFor ───────────────────────────────────────────────────
// The cap must scale with the source size (a fixed 40 ran out on the 521KB
// volume-01 source: the validator hit the cap before writing its report).
assert.strictEqual(validatorMaxStepsFor(0), 40);
assert.strictEqual(validatorMaxStepsFor(1000), 40);
assert.strictEqual(validatorMaxStepsFor(521 * 1024), 58); // ceil(17 chunks) * 2 + 24
assert.strictEqual(validatorMaxStepsFor(1024 * 1024), 88); // ceil(32 chunks) * 2 + 24

// ─── agent-mode prompt builders: jump-in-wiki ───────────────────────────────
// In agent-only mode the prompt files use the new file names directly
// (wiki.md / shared-wiki.md). The buildWikiAuthorSystemPrompt and
// buildWikiValidatorSystemPrompt simply append AGENT_TOOLS_NOTE.
const wikiCtx = {
  values: { INSTALLMENT_NUMBER: "01", SOURCE_NAME: "test", SOURCE_LANGUAGE: "Japanese" },
  folderName: "story_name(1)",
  isFirst: true,
  previousFolderName: null,
  userPrompt:
    "Materials: `../(previous volume folder)/wiki.md` and `shared-wiki.md`.\n\n" +
    "## Output\n\nWrite wiki.md and shared-wiki.md using writeFile.\n\n" +
    "## Constraints\n\n- no hallucination",
  validatorUserPrompt:
    "Audit `wiki.md` and `shared-wiki.md` against the source " +
    "and save the report in `jump-in-wiki-validation-01.md`.",
  feedbackUserPrompt:
    "Correct `wiki.md` and `shared-wiki.md`; the previous state " +
    "is in `wiki.md` from the previous volume folder and " +
    "`shared-wiki.md` previous version, path in the materials list.\n\n" +
    "## Output\nWrite wiki.md and shared-wiki.md using writeFile.",
};

const wikiAuthorTurn = buildWikiAuthorTurnPrompt(wikiCtx);
assert.ok(wikiAuthorTurn.includes('"wiki.md"'), "wiki author turn names wiki.md");
assert.ok(wikiAuthorTurn.includes('"shared-wiki.md"'), "wiki author turn names shared-wiki.md");
assert.ok(wikiAuthorTurn.includes('"story_name(1).md"'), "wiki author turn points at the same-folder source");
assert.ok(!wikiAuthorTurn.includes("../story_name"), "wiki author turn (first volume): no previous-volume paths");

// ─── agentOutputNames / system prompts (agent mode: prompts use new file names) ──

// In agent-only mode the prompt files use the new file names directly
// (wiki.md / shared-wiki.md). The buildWikiAuthorSystemPrompt and
// buildWikiValidatorSystemPrompt simply append AGENT_TOOLS_NOTE.
wikiCtx.systemPrompt =
  "Layout: `wiki.md` and `shared-wiki.md`.";
wikiCtx.validatorSystemPrompt = "Audits wiki.md and shared-wiki.md.";
const wikiAuthorSystem = buildWikiAuthorSystemPrompt(wikiCtx);
assert.ok(wikiAuthorSystem.includes("wiki.md"), "wiki author system prompt names wiki.md");
assert.ok(wikiAuthorSystem.includes("shared-wiki.md"), "wiki author system prompt names shared-wiki.md");
const wikiValidatorSystem = buildWikiValidatorSystemPrompt(wikiCtx);
assert.ok(wikiValidatorSystem.includes("wiki.md"), "wiki validator system prompt names wiki.md");
assert.ok(wikiValidatorSystem.includes("shared-wiki.md"), "wiki validator system prompt names shared-wiki.md");

const wikiValidatorTurn = buildWikiValidatorTurnPrompt(wikiCtx);
assert.ok(wikiValidatorTurn.includes('"wiki.md"'), "wiki validator turn names wiki.md");
assert.ok(wikiValidatorTurn.includes('"shared-wiki.md"'), "wiki validator turn names shared-wiki.md");
assert.ok(wikiValidatorTurn.includes("jump-in-wiki-validation-01.md"), "wiki validator turn keeps the real report name");

const wikiFeedbackTurn = buildWikiFeedbackTurnPrompt(wikiCtx);
assert.ok(wikiFeedbackTurn.includes('"wiki.md"') && wikiFeedbackTurn.includes('"shared-wiki.md"'), "wiki feedback turn names the real files");

// A non-first volume points the agents at the previous volume's files.
const wikiCtx2 = { ...wikiCtx, isFirst: false, previousFolderName: "story_name(1)" };
assert.ok(buildWikiAuthorTurnPrompt(wikiCtx2).includes("../story_name(1)/wiki.md"), "volume-2 author turn lists the previous wiki");
assert.ok(buildWikiValidatorTurnPrompt(wikiCtx2).includes("../story_name(1)/shared-wiki.md"), "volume-2 validator turn lists the previous shared wiki");
assert.ok(buildWikiFeedbackTurnPrompt(wikiCtx2).includes("../story_name(1)/shared-wiki.md"), "volume-2 feedback turn lists the previous shared wiki");

// ─── agent-mode prompt builders: glossary ───────────────────────────────────
const glossaryCtx = {
  values: {
    INSTALLMENT_NUMBER: "01",
    SOURCE_NAME: "test",
    SOURCE_LANGUAGE: "Japanese",
    TARGET_LANGUAGE: "English",
  },
  folderName: "story_name(1)",
  isFirst: true,
  previousFolderName: null,
  glossaryTemplate:
    "Amend the glossary for {{SOURCE_NAME}}, volume {{INSTALLMENT_NUMBER}} " +
    "({{SOURCE_LANGUAGE}} -> {{TARGET_LANGUAGE}}).\nNew terms:\n{{TERMS_LIST}}\n" +
    "Research notes:\n{{RESEARCH_NOTES}}",
  validatorPrompt: "Audit `glossary.md` against the source and write `glossary-validation.md`.",
  feedbackPrompt: "Apply the findings from `glossary-validation.md` to `glossary.md`.",
};
const terms = [{ term: "ソラ", type: "character", query: "ソラ" }];

const gAuthorTurn = buildGlossaryAuthorTurnPrompt(glossaryCtx, terms, false);
assert.ok(gAuthorTurn.includes('"glossary.md"'), "glossary author turn names glossary.md");
assert.ok(gAuthorTurn.includes("ソラ"), "glossary author turn carries the term list");
assert.ok(gAuthorTurn.includes('"story_name(1).md"'), "glossary author turn points at the same-folder source");
assert.ok(!gAuthorTurn.includes("glossary-01.md"), "glossary author turn: no per-volume classic name");
assert.ok(gAuthorTurn.includes("(absent — this is the first volume)"), "glossary author turn (first volume): no previous glossary");

const gValidatorTurn = buildGlossaryValidatorTurnPrompt(glossaryCtx);
assert.ok(gValidatorTurn.includes('"glossary-validation.md"'), "glossary validator turn names the report file");
assert.ok(gValidatorTurn.includes('"glossary.md"'), "glossary validator turn names the glossary");
assert.ok(gValidatorTurn.includes('"story_name(1).md"'), "glossary validator turn points at the same-folder source");

const gFeedbackTurn = buildGlossaryFeedbackTurnPrompt(glossaryCtx);
assert.ok(gFeedbackTurn.includes('"glossary.md"'), "glossary feedback turn names the glossary");
assert.ok(gFeedbackTurn.includes("glossary-validation.md"), "glossary feedback turn names the report");

const gResearcherTurn = buildGlossaryResearcherTurnPrompt(glossaryCtx, terms);
assert.ok(gResearcherTurn.includes("glossary-research.md"), "glossary researcher turn names the notes file");
assert.ok(gResearcherTurn.includes("ソラ"), "glossary researcher turn carries the term list");
assert.ok(gResearcherTurn.includes("- (pending)"), "glossary researcher turn mentions the placeholder");

const glossaryCtx2 = { ...glossaryCtx, isFirst: false, previousFolderName: "story_name(1)" };
assert.ok(buildGlossaryAuthorTurnPrompt(glossaryCtx2, terms, false).includes("../story_name(1)/glossary.md"), "volume-2: previous glossary path");
assert.ok(buildGlossaryValidatorTurnPrompt(glossaryCtx2).includes("../story_name(1)/glossary.md"), "volume-2 validator: previous glossary path");
assert.ok(buildGlossaryFeedbackTurnPrompt(glossaryCtx2).includes("../story_name(1)/glossary.md"), "volume-2 feedback: previous glossary path");

console.log("All tests passed.");
