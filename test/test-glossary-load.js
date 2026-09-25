/**
 * test-glossary-load.js — self-checks for the pure parsing helpers, the
 * agent-mode prompt builders, and the agent safety nets in glossary.js and
 * jump-in-wiki.js. Run with `npm test`.
 */
const assert = require("assert");
const path = require("path");
const { execFileSync } = require("child_process");

// Pin the acceptance-criterion config so the criterion tests below are
// deterministic regardless of the local .env (dotenv does not override
// values that are already set in the environment).
process.env.ACCEPTANCE_PASSING_SCORE = "70";
process.env.ACCEPTANCE_STRATEGY = "average";
process.env.BEST_OF_MIN_PASSES = "3";
process.env.ROLLING_MIN_SAMPLES = "3";

const {
  parseTerms,
  buildGlossaryResearcherTurnPrompt,
  buildGlossaryAuthorTurnPrompt,
  buildGlossaryValidatorTurnPrompt,
  buildGlossaryFeedbackTurnPrompt,
  truncateGlossary,
  buildPerTermResearchPrompt,
} = require("../glossary");
const {
  transformUserPrompt,
  isPassingVerdict,
  parseAcceptanceScore,
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
const {
  meetsAcceptanceCriteria,
  isAcceptedState,
  computeRollingAverage,
} = require("../configs/shared");

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

// ─── parseAcceptanceScore ──────────────────────────────────────────────────
// Exact integer replies.
assert.strictEqual(parseAcceptanceScore("72"), 72);
assert.strictEqual(parseAcceptanceScore("  72\n"), 72);
assert.strictEqual(parseAcceptanceScore("0"), 0);
assert.strictEqual(parseAcceptanceScore("100"), 100);
// Numbers wrapped in prose / fraction forms.
assert.strictEqual(parseAcceptanceScore("Score: 72"), 72);
assert.strictEqual(parseAcceptanceScore("72/100"), 72);
assert.strictEqual(parseAcceptanceScore("Score: 72/100"), 72);
assert.strictEqual(parseAcceptanceScore("72 out of 100"), 72);
assert.strictEqual(parseAcceptanceScore("72 of 100"), 72);
assert.strictEqual(parseAcceptanceScore("The score is 85."), 85);
assert.strictEqual(parseAcceptanceScore("Score: 72 (out of 100)"), 72);
// The first number wins when extra prose follows.
assert.strictEqual(parseAcceptanceScore("72 — the glossary covers volume 01 in full."), 72);
// Out-of-range and non-numeric replies are unparseable (fail-closed).
assert.strictEqual(parseAcceptanceScore("105"), null);
assert.strictEqual(parseAcceptanceScore("150/100"), null);
assert.strictEqual(parseAcceptanceScore("PASS"), null);
assert.strictEqual(parseAcceptanceScore("no score here"), null);
assert.strictEqual(parseAcceptanceScore(""), null);
assert.strictEqual(parseAcceptanceScore(undefined), null);

// ─── computeRollingAverage (scores) ────────────────────────────────────────
assert.strictEqual(computeRollingAverage([70, 80]), 75);
assert.strictEqual(computeRollingAverage([95, 45, 45, 45, 45]), 55);
assert.strictEqual(computeRollingAverage([]), 0);
assert.strictEqual(computeRollingAverage(null), 0);

// ─── meetsAcceptanceCriteria (rolling-average strategy; env pinned above) ──
// Fewer than ROLLING_MIN_SAMPLES (3) checks → never accepted.
assert.strictEqual(meetsAcceptanceCriteria([100]), false);
assert.strictEqual(meetsAcceptanceCriteria([100, 100]), false);
// Average >= 70 → accepted (boundary is inclusive).
assert.strictEqual(meetsAcceptanceCriteria([70, 70, 70]), true);
assert.strictEqual(meetsAcceptanceCriteria([80, 75, 65]), true);
assert.strictEqual(meetsAcceptanceCriteria([90, 60, 60]), true);
// Average below 70 → not accepted.
assert.strictEqual(meetsAcceptanceCriteria([60, 60, 60]), false);
// A single spike does not carry the window.
assert.strictEqual(meetsAcceptanceCriteria([95, 45, 45, 45, 45]), false);
// Empty / invalid input → false.
assert.strictEqual(meetsAcceptanceCriteria([]), false);
assert.strictEqual(meetsAcceptanceCriteria(null), false);

// ─── isAcceptedState ───────────────────────────────────────────────────────
assert.strictEqual(isAcceptedState(null), false);
assert.strictEqual(isAcceptedState({ results: [80, 80, 80] }), true);
assert.strictEqual(isAcceptedState({ results: [50, 50, 50] }), false);
assert.strictEqual(isAcceptedState({ results: [100] }), false);

// ─── meetsAcceptanceCriteria (best-X-out-of-Y strategy) ────────────────────
// The strategy is read from the environment at module load, so the best
// strategy is exercised in a spawned process with an env override.
const sharedConfigPath = path.resolve(__dirname, "..", "configs", "shared.js");
function bestStrategyCheck(scores) {
  const script =
    `const { meetsAcceptanceCriteria } = require(${JSON.stringify(sharedConfigPath)});` +
    `console.log(String(meetsAcceptanceCriteria(${JSON.stringify(scores)})));`;
  const out = execFileSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      ACCEPTANCE_STRATEGY: "best",
      ACCEPTANCE_PASSING_SCORE: "70",
      BEST_OF_MIN_PASSES: "3",
      ROLLING_MIN_SAMPLES: "3",
    },
  });
  return out.trim() === "true";
}
// Best 3 out of 5: at least 3 scores >= 70 (fewer than 3 checks never accepted).
assert.strictEqual(bestStrategyCheck([80, 80, 80, 60, 60]), true);
assert.strictEqual(bestStrategyCheck([70, 70, 70]), true);
assert.strictEqual(bestStrategyCheck([100, 100]), false);
// Fewer than BEST_OF_MIN_PASSES qualifying scores → not accepted, even when
// the average would pass.
assert.strictEqual(bestStrategyCheck([95, 45, 45, 45, 45]), false);
assert.strictEqual(bestStrategyCheck([80, 80, 60, 60, 60]), false);

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

// ─── truncateGlossary ────────────────────────────────────────────────────────
// Under the threshold: returns content unchanged.
const shortGlossary = "- TermA (character): A character\n- TermB (place): A place";
assert.strictEqual(truncateGlossary(shortGlossary), shortGlossary, "truncateGlossary: short content unchanged");

// Over the threshold (64KB): returns truncated content with header note.
// Each entry is ~60 bytes; need ~1100+ entries to exceed 64KB.
const longGlossary = Array.from({ length: 1200 }, (_, i) => `- Term${i} (character): This is a description for term ${i} that is quite long`).join("\n");
const truncated = truncateGlossary(longGlossary);
assert.ok(truncated.includes("[TRUNCATED:"), "truncateGlossary: truncated content has header note");
assert.ok(!truncated.includes("Term0"), "truncateGlossary: first entries removed");
assert.ok(truncated.includes("Term1199"), "truncateGlossary: last entries kept");

// ─── buildPerTermResearchPrompt ──────────────────────────────────────────────
const perTermPrompt = buildPerTermResearchPrompt(glossaryCtx, { term: "ソラ", type: "character", query: "ソラ" }, 0);
assert.ok(perTermPrompt.includes("ソラ"), "per-term prompt carries the term");
assert.ok(perTermPrompt.includes("glossary-research.md"), "per-term prompt names the notes file");
assert.ok(perTermPrompt.includes("- (pending)"), "per-term prompt mentions the placeholder");
assert.ok(perTermPrompt.includes("editFile"), "per-term prompt instructs editFile");

// ─── character-voice: parseVoiceQuirks ──────────────────────────────────────
const { parseVoiceQuirks, truncateVoiceRef, emittedToolCallAsText, buildExtractTurnPrompt, buildAuthorTurnPrompt, buildValidatorTurnPrompt, buildFeedbackTurnPrompt } = require("../character-voice");

// Empty/null input
assert.deepStrictEqual(parseVoiceQuirks(""), []);
assert.deepStrictEqual(parseVoiceQuirks(null), []);
assert.deepStrictEqual(parseVoiceQuirks(undefined), []);

// With markdown fences
assert.deepStrictEqual(
  parseVoiceQuirks('```json\n[{"type":"voice","character":"ソラ","quirkType":"sentenceEnding","description":"formal","examples":["〜である"],"formalityLevel":"plain","notes":"test"}]\n```'),
  [{ type: "voice", character: "ソラ", quirkType: "sentenceEnding", description: "formal", examples: ["〜である"], formalityLevel: "plain", notes: "test" }]
);

// With surrounding prose
const proseOutput = 'Here are the quirks:\n[{"type":"voice","character":"黒鋼","quirkType":"pronoun","description":"casual","examples":["俺"],"formalityLevel":"plain","notes":""}]';
const parsed = parseVoiceQuirks(proseOutput);
assert.strictEqual(parsed.length, 1);
assert.strictEqual(parsed[0].character, "黒鋼");
assert.strictEqual(parsed[0].quirkType, "pronoun");

// POV entries
const povOutput = '[{"type":"pov","povCategory":"marker","marker":"※","description":"POV shift","narrationType":"first-person-internal","sectionDescription":"opening","examples":["※ソラの視点"],"notes":""}]';
const povParsed = parseVoiceQuirks(povOutput);
assert.strictEqual(povParsed.length, 1);
assert.strictEqual(povParsed[0].type, "pov");
assert.strictEqual(povParsed[0].povCategory, "marker");
assert.strictEqual(povParsed[0].marker, "※");

// No JSON array
assert.throws(() => parseVoiceQuirks("no json here"), /No JSON array/);
assert.throws(() => parseVoiceQuirks('{"type":"voice"}'), /No JSON array/);

// ─── character-voice: truncateVoiceRef ──────────────────────────────────────
const shortVoiceRef = "### ソラ\n- sentence endings: 〜である\n### 黒鋼\n- sentence endings: 〜だぜ";
assert.strictEqual(truncateVoiceRef(shortVoiceRef), shortVoiceRef, "truncateVoiceRef: short content unchanged");

// Over threshold: need > 64KB of character sections
const longVoiceRef = "Header\n\n" + Array.from({ length: 2000 }, (_, i) => `### Character${i}\n- sentence endings: quirk ${i} quirk ${i} quirk ${i} quirk ${i} quirk ${i} quirk ${i}`).join("\n\n");
const truncatedVoice = truncateVoiceRef(longVoiceRef);
assert.ok(truncatedVoice.includes("[TRUNCATED:"), "truncateVoiceRef: truncated content has header note");
assert.ok(!truncatedVoice.includes("Character0"), "truncateVoiceRef: first entries removed");
assert.ok(truncatedVoice.includes("Character"), "truncateVoiceRef: some entries kept");

// ─── character-voice: emittedToolCallAsText ──────────────────────────────────
// A turn that made real tool calls is never flagged, even if its text also
// mentions tool-call syntax.
assert.strictEqual(
  emittedToolCallAsText({ text: "tool_call <function=readFile>", toolCalls: [{ name: "readFile" }] }),
  false,
  "emittedToolCallAsText: real tool calls are not flagged"
);
// A turn with no real tool calls but tool-call markers in the text is the
// malformed-tool-call signature (observed live from a local Qwen endpoint).
assert.strictEqual(
  emittedToolCallAsText({ text: "tool_call\n<function=readFile>\n<parameter=path>\nfile.md\n</parameter>\n</function>", toolCalls: [] }),
  true,
  "emittedToolCallAsText: tool_call text with no real calls is flagged"
);
assert.strictEqual(
  emittedToolCallAsText({ text: "tool_call <listFiles>", toolCalls: [] }),
  true,
  "emittedToolCallAsText: listFiles marker is flagged"
);
assert.strictEqual(
  emittedToolCallAsText({ text: "Here is <function=readFile> the content", toolCalls: [] }),
  true,
  "emittedToolCallAsText: <function= marker is flagged"
);
// Ordinary chat replies (no markers) and missing/empty results are not flagged.
assert.strictEqual(
  emittedToolCallAsText({ text: "I wrote the file to character-voice.md.", toolCalls: [] }),
  false,
  "emittedToolCallAsText: ordinary reply not flagged"
);
assert.strictEqual(emittedToolCallAsText(null), false, "emittedToolCallAsText: null result not flagged");
assert.strictEqual(emittedToolCallAsText({}), false, "emittedToolCallAsText: empty result not flagged");
assert.strictEqual(emittedToolCallAsText({ text: "", toolCalls: [] }), false, "emittedToolCallAsText: empty text not flagged");

// ─── character-voice: prompt builders ───────────────────────────────────────
const voiceCtx = {
  values: { INSTALLMENT_NUMBER: "01", SOURCE_NAME: "Test", SOURCE_LANGUAGE: "Japanese", TARGET_LANGUAGE: "English" },
  folderName: "test_story(1)",
  sourceFile: "test-series/test_story(1)/test_story(1).md",
  isFirst: true,
  previousFolderName: null,
  extractUserPrompt: "# Extraction — {{SOURCE_NAME}}, Volume {{INSTALLMENT_NUMBER}}",
  authorUserPrompt: "# Compilation — {{SOURCE_NAME}}, Volume {{INSTALLMENT_NUMBER}}\n\n{{EXTRACTION_RESULTS}}",
  validatorUserPrompt: "# Validation — {{SOURCE_NAME}}, Volume {{INSTALLMENT_NUMBER}}",
  feedbackUserPrompt: "# Feedback — {{SOURCE_NAME}}, Volume {{INSTALLMENT_NUMBER}}",
  voiceOutputFile: "character-voice.md",
  povOutputFile: "pov-map.md",
};

const extractPrompt = buildExtractTurnPrompt(voiceCtx);
assert.ok(extractPrompt.includes("Test"), "extract prompt carries series name");
assert.ok(extractPrompt.includes("01"), "extract prompt carries installment");

const authorPrompt = buildAuthorTurnPrompt(voiceCtx, '[{"type":"voice","character":"ソラ"}]');
assert.ok(authorPrompt.includes("Test"), "author prompt carries series name");
assert.ok(authorPrompt.includes('{"type":"voice","character":"ソラ"}'), "author prompt carries extraction results");
assert.ok(authorPrompt.includes('"test_story(1).md" (same folder)'), "author prompt names the volume source at its real path");
assert.ok(authorPrompt.includes("absent — this is the first volume"), "author prompt (first volume): previous reference absent");

const authorPromptFirst = buildAuthorTurnPrompt({ ...voiceCtx, values: { ...voiceCtx.values, INSTALLMENT_NUMBER: "01" } }, "");
assert.ok(authorPromptFirst.includes("this is the first volume"), "author prompt (empty results): mentions first volume");

const validatorPrompt = buildValidatorTurnPrompt(voiceCtx);
assert.ok(validatorPrompt.includes("Test"), "validator prompt carries series name");
assert.ok(validatorPrompt.includes("01"), "validator prompt carries installment");
assert.ok(validatorPrompt.includes('"character-voice.md" (same folder)'), "validator prompt names the reference under audit");
assert.ok(validatorPrompt.includes('"pov-map.md" (same folder)'), "validator prompt names the POV map under audit");

const feedbackPrompt = buildFeedbackTurnPrompt(voiceCtx);
assert.ok(feedbackPrompt.includes("Test"), "feedback prompt carries series name");
assert.ok(feedbackPrompt.includes("01"), "feedback prompt carries installment");
assert.ok(feedbackPrompt.includes("character-voice-validation.md"), "feedback prompt names the validation report");

// Non-first volume: the previous reference is named at its real relative path
// (../<previous folder>/character-voice.md) — the convention from glossary.js.
const voiceCtxVol2 = {
  ...voiceCtx,
  values: { ...voiceCtx.values, INSTALLMENT_NUMBER: "02" },
  folderName: "test_story(2)",
  sourceFile: "test-series/test_story(2)/test_story(2).md",
  isFirst: false,
  previousFolderName: "test_story(1)",
};
for (const [name, prompt] of [
  ["author", buildAuthorTurnPrompt(voiceCtxVol2, "[]")],
  ["validator", buildValidatorTurnPrompt(voiceCtxVol2)],
  ["feedback", buildFeedbackTurnPrompt(voiceCtxVol2)],
]) {
  assert.ok(prompt.includes("../test_story(1)/character-voice.md"), `${name} prompt (volume 02) names the previous reference at its real path`);
}

// ─── style-guide: parseStyleObservations ─────────────────────────────────────
const {
  parseStyleObservations,
  emittedToolCallAsText: styleEmittedToolCallAsText,
  buildExtractTurnPrompt: styleBuildExtractTurnPrompt,
  buildAuthorTurnPrompt: styleBuildAuthorTurnPrompt,
  buildValidatorTurnPrompt: styleBuildValidatorTurnPrompt,
  buildFeedbackTurnPrompt: styleBuildFeedbackTurnPrompt,
} = require("../style-guide");

assert.deepStrictEqual(parseStyleObservations(""), []);
assert.deepStrictEqual(parseStyleObservations(null), []);
assert.deepStrictEqual(
  parseStyleObservations('```json\n[{"category":"honorific","pattern":"〜さん","description":"ex","examples":["ex"],"frequency":"high","notes":"ex"}]```'),
  [{ category: "honorific", pattern: "〜さん", description: "ex", examples: ["ex"], frequency: "high", notes: "ex" }]
);
assert.deepStrictEqual(
  parseStyleObservations('Here are the constructs:\n[{"category":"pronoun","pattern":"俺"}]\nDone.'),
  [{ category: "pronoun", pattern: "俺" }]
);
assert.deepStrictEqual(
  parseStyleObservations('[{"pattern":"no-category"},{"category":"povMarker","pattern":"※"}]'),
  [{ category: "povMarker", pattern: "※" }]
);
assert.throws(() => parseStyleObservations("no json here"), /No JSON array/);
assert.throws(() => parseStyleObservations('{"category":"honorific"}'), /No JSON array/);

// ─── style-guide: emittedToolCallAsText ──────────────────────────────────────
assert.strictEqual(
  styleEmittedToolCallAsText({ text: "tool_call <function=readFile>", toolCalls: [] }),
  true,
  "style emittedToolCallAsText: tool_call text with no real calls is flagged"
);
assert.strictEqual(
  styleEmittedToolCallAsText({ text: "wrote the file", toolCalls: [{ name: "writeFile" }] }),
  false,
  "style emittedToolCallAsText: real tool calls are not flagged"
);
assert.strictEqual(styleEmittedToolCallAsText(null), false, "style emittedToolCallAsText: null result not flagged");

// ─── style-guide: prompt builders ────────────────────────────────────────────
const styleCtx = {
  values: { INSTALLMENT_NUMBER: "01", SOURCE_NAME: "Test", SOURCE_LANGUAGE: "Japanese", TARGET_LANGUAGE: "English" },
  folderName: "test_story(1)",
  sourceFile: "test-series/test_story(1)/test_story(1).md",
  isFirst: true,
  previousFolderName: null,
  extractUserPrompt: "# Extraction — {{SOURCE_NAME}}, Volume {{INSTALLMENT_NUMBER}}",
  authorUserPrompt: "# Compilation — {{SOURCE_NAME}}, Volume {{INSTALLMENT_NUMBER}}\n\n{{EXTRACTION_RESULTS}}",
  validatorUserPrompt: "# Validation — {{SOURCE_NAME}}, Volume {{INSTALLMENT_NUMBER}}",
  feedbackUserPrompt: "# Feedback — {{SOURCE_NAME}}, Volume {{INSTALLMENT_NUMBER}}",
  styleOutputFile: "style-guide.md",
};

const styleExtractPrompt = styleBuildExtractTurnPrompt(styleCtx);
assert.ok(styleExtractPrompt.includes("Test"), "style extract prompt carries series name");
assert.ok(styleExtractPrompt.includes("01"), "style extract prompt carries installment");

const styleAuthorPrompt = styleBuildAuthorTurnPrompt(styleCtx, '[{"category":"honorific","pattern":"〜ちゃん"}]');
assert.ok(styleAuthorPrompt.includes("Test"), "style author prompt carries series name");
assert.ok(styleAuthorPrompt.includes('{"category":"honorific","pattern":"〜ちゃん"}'), "style author prompt carries extraction results");
assert.ok(styleAuthorPrompt.includes('"test_story(1).md" (same folder)'), "style author prompt names the volume source at its real path");
assert.ok(styleAuthorPrompt.includes("absent — this is the first volume"), "style author prompt (first volume): previous guide absent");

const styleAuthorPromptFirst = styleBuildAuthorTurnPrompt({ ...styleCtx, values: { ...styleCtx.values, INSTALLMENT_NUMBER: "01" } }, "");
assert.ok(styleAuthorPromptFirst.includes("this is the first volume"), "style author prompt (empty results): mentions first volume");

const styleValidatorPrompt = styleBuildValidatorTurnPrompt(styleCtx);
assert.ok(styleValidatorPrompt.includes("Test"), "style validator prompt carries series name");
assert.ok(styleValidatorPrompt.includes("01"), "style validator prompt carries installment");
assert.ok(styleValidatorPrompt.includes('"style-guide.md" (same folder)'), "style validator prompt names the guide under audit");

const styleFeedbackPrompt = styleBuildFeedbackTurnPrompt(styleCtx);
assert.ok(styleFeedbackPrompt.includes("Test"), "style feedback prompt carries series name");
assert.ok(styleFeedbackPrompt.includes("01"), "style feedback prompt carries installment");
assert.ok(styleFeedbackPrompt.includes("style-guide-validation.md"), "style feedback prompt names the validation report");

// Non-first volume: the previous guide is named at its real relative path
// (../<previous folder>/style-guide.md) — the convention from character-voice.js.
const styleCtxVol2 = {
  ...styleCtx,
  values: { ...styleCtx.values, INSTALLMENT_NUMBER: "02" },
  folderName: "test_story(2)",
  sourceFile: "test-series/test_story(2)/test_story(2).md",
  isFirst: false,
  previousFolderName: "test_story(1)",
};
for (const [name, prompt] of [
  ["author", styleBuildAuthorTurnPrompt(styleCtxVol2, "[]")],
  ["validator", styleBuildValidatorTurnPrompt(styleCtxVol2)],
  ["feedback", styleBuildFeedbackTurnPrompt(styleCtxVol2)],
]) {
  assert.ok(prompt.includes("../test_story(1)/style-guide.md"), `${name} prompt (volume 02) names the previous guide at its real path`);
}

console.log("All tests passed.");
