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
process.env.PASSING_SCORE = "70";
process.env.ACCEPTANCE_PASSING_SCORE = "70";
process.env.ACCEPTANCE_MIN_SAMPLES = "3";
// Pin the un-monitored run policies so the policy tests below are
// deterministic regardless of the local .env.
process.env.ON_VOLUME_ERROR = "skip";
process.env.ON_MISSING_PREVIOUS = "skip";
process.env.ON_QA_LIMIT = "accept";

const {
  parseTerms,
  buildGlossaryResearcherTurnPrompt,
  buildGlossaryAuthorTurnPrompt,
  buildGlossaryValidatorTurnPrompt,
  buildGlossaryFeedbackTurnPrompt,
  buildGlossarySegmentFeedbackPrompt,
  glossaryRecoveryPrompt,
  buildGlossaryIndex,
  compareGlossaryCarryForward,
  reportCarryForwardLoss,
  seedGlossaryFromPrevious,
  assertGlossaryCarryForward,
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
const { parseAcceptanceReply, findingsMergeMaxStepsFor, authorMaxStepsFor } = require("../utils/prompt");
const {
  extractJsonObject,
  validateManifest,
} = require("../get-translation-target");
const {
  meetsAcceptanceCriteria,
  meetsExceptionalCriteria,
  isExceptionalScore,
  isAcceptedState,
  computeRollingAverage,
} = require("../configs/shared");
const sharedConfigPath = path.resolve(__dirname, "..", "configs", "shared.js");

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
// Fewer than ACCEPTANCE_MIN_SAMPLES (3) checks → never accepted.
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

// ─── meetsAcceptanceCriteria: the "best" strategy is GONE ───────────────────
// It asked for ACCEPTANCE_BEST_MIN_PASSES (default 3) passing scores inside a
// window that can only ever hold ACCEPTANCE_WINDOW_SIZE (default 2) — so
// ACCEPTANCE_STRATEGY=best could never accept anything: every volume burned all
// QA_MAX_ITERATIONS validator turns and fell through to ON_QA_LIMIT. Setting the
// removed variables must now have no effect at all.
function strategyIgnoredCheck(scores) {
  const script =
    `const { meetsAcceptanceCriteria } = require(${JSON.stringify(sharedConfigPath)});` +
    `console.log(String(meetsAcceptanceCriteria(${JSON.stringify(scores)})));`;
  const out = execFileSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      ACCEPTANCE_STRATEGY: "best",
      ACCEPTANCE_BEST_MIN_PASSES: "3",
      ACCEPTANCE_WINDOW_SIZE: "2",
      ACCEPTANCE_MIN_SAMPLES: "2",
      PASSING_SCORE: "70",
    },
  });
  return out.trim() === "true";
}
// Two 95s in a 2-window: accepted (the old "best" reading would have refused).
assert.strictEqual(strategyIgnoredCheck([95, 95]), true, "ACCEPTANCE_STRATEGY=best no longer blocks acceptance");
assert.strictEqual(strategyIgnoredCheck([80, 80, 80, 60, 60]), true, "average 72 → accepted regardless of the removed strategy");
// The sample floor: 45 is the rubric's "Requires revision" band, so a window of
// [95, 45] is NOT accepted even though its average is exactly the passing score
// — one grader's enthusiasm does not cancel another's rejection.
assert.strictEqual(strategyIgnoredCheck([95, 45]), false, "a sample below the floor blocks acceptance whatever the average");
assert.strictEqual(strategyIgnoredCheck([95, 60]), true, "average 77.5 with both samples at/above the floor (55) → accepted");
assert.strictEqual(strategyIgnoredCheck([95, 44]), false, "average 69.5 → rejected");

// ─── meetsExceptionalCriteria (the "is this a fluke?" test) ─────────────────
{
  const { meetsExceptionalCriteria, isExceptionalScore } = require("../configs/shared");
  // Below the exceptional floor: nothing to confirm.
  assert.strictEqual(isExceptionalScore(84), false);
  assert.strictEqual(isExceptionalScore(85), true);
  assert.strictEqual(
    meetsExceptionalCriteria(80, [{ score: 90, temperature: 0 }]).accepted,
    false,
    "a non-exceptional first score is never fast-accepted"
  );
  // Confirmed: every grade holds the band and the deterministic grade agrees.
  const confirmed = meetsExceptionalCriteria(87, [
    { score: 86, temperature: 0 },
    { score: 85, temperature: 0.2 },
  ]);
  assert.strictEqual(confirmed.accepted, true, confirmed.reason);
  // A confirmation collapsed out of the band → fluke.
  const fluke = meetsExceptionalCriteria(88, [
    { score: 74, temperature: 0 },
    { score: 87, temperature: 0.2 },
  ]);
  assert.strictEqual(fluke.accepted, false, "a grade below 82 breaks the consensus");
  // The noisy grades agree but the deterministic one does not → fluke.
  const noisy = meetsExceptionalCriteria(88, [
    { score: 83, temperature: 0 },
    { score: 89, temperature: 0.2 },
  ]);
  assert.strictEqual(noisy.accepted, false, "the temperature-0 grade must itself be exceptional");
  // An unparseable confirmation fails closed.
  assert.strictEqual(
    meetsExceptionalCriteria(90, [{ score: null, temperature: 0 }, { score: 91, temperature: 0.2 }]).accepted,
    false,
    "an unparseable confirmation grade is a failed check"
  );
  // No confirmation ran, or no deterministic anchor among them.
  assert.strictEqual(meetsExceptionalCriteria(95, []).accepted, false);
  assert.strictEqual(
    meetsExceptionalCriteria(95, [{ score: 94, temperature: 0.2 }, { score: 93, temperature: 0.2 }]).accepted,
    false,
    "a confirmation set without the temperature-0 anchor cannot accept"
  );
}

// ─── parseAcceptanceReply (JSON contract + legacy fallback) ────────────────
// The JSON contract the acceptance prompts now require.
assert.deepStrictEqual(
  parseAcceptanceReply('{"score": 88, "band": "Pass", "note": "Solid glossary."}'),
  { score: 88, band: "Pass", note: "Solid glossary." }
);
// Tolerates fences + surrounding prose (extractJsonObject).
assert.deepStrictEqual(
  parseAcceptanceReply('Here is the verdict:\n```json\n{"score": 71, "band": "Pass with minor edits", "note": "nits"}\n```\nDone.'),
  { score: 71, band: "Pass with minor edits", note: "nits" }
);
// Out-of-range JSON score → invalid JSON contract → legacy parse also
// rejects it (first standalone integer is >100) → null (fail-closed).
assert.strictEqual(parseAcceptanceReply('{"score": 105, "band": "Pass"}'), null);
// Missing / non-integer score key → legacy fallback.
assert.strictEqual(parseAcceptanceReply('{"band": "Pass"}'), null);
// Legacy integer replies still count (an old-format reply never fails a run).
assert.deepStrictEqual(parseAcceptanceReply("85"), { score: 85, band: null, note: null });
assert.deepStrictEqual(parseAcceptanceReply("Score: 72/100"), { score: 72, band: null, note: null });
// Unparseable → null (fail-closed).
assert.strictEqual(parseAcceptanceReply("no score here"), null);
assert.strictEqual(parseAcceptanceReply(""), null);
assert.strictEqual(parseAcceptanceReply(undefined), null);

// ─── meetsAcceptanceCriteria (current defaults: window 2 / min 2) ──────────
// The window/min-sample defaults are read at module load; exercise them in a
// spawned process with the window/min-sample overrides blanked (empty string
// → parseInt NaN → the code defaults apply).
function defaultCriteriaCheck(scores) {
  const script =
    `const { meetsAcceptanceCriteria } = require(${JSON.stringify(sharedConfigPath)});` +
    `console.log(String(meetsAcceptanceCriteria(${JSON.stringify(scores)})));`;
  const out = execFileSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      PASSING_SCORE: "70",
      ACCEPTANCE_PASSING_SCORE: "70",
      ACCEPTANCE_WINDOW_SIZE: "",
      ACCEPTANCE_MIN_SAMPLES: "",
    },
  });
  return out.trim() === "true";
}
// One check is not enough (min samples 2); two fresh passes decide.
assert.strictEqual(defaultCriteriaCheck([100]), false);
assert.strictEqual(defaultCriteriaCheck([100, 100]), true);
assert.strictEqual(defaultCriteriaCheck([90, 55]), true); // avg 72.5, both samples at the floor (55)
// 50 is below the sample floor: the average is exactly the passing score, but
// one grader put the artifact in the rubric's "Requires revision" band, and a
// rejection is not noise to average away.
assert.strictEqual(defaultCriteriaCheck([90, 50]), false); // avg 70 — blocked by the sample floor
assert.strictEqual(defaultCriteriaCheck([89, 50]), false); // avg 69.5
// A legacy 5-score state file is evaluated as a whole under the new default
// (a volume accepted under the old rule keeps skipping — no re-validation).
assert.strictEqual(defaultCriteriaCheck([95, 45, 45, 45, 45]), false);
assert.strictEqual(defaultCriteriaCheck([80, 75, 65, 90, 90]), true);

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
// Schema 2: the intake agent's plan of record. The series-level decisions are
// required, folder names are sanitized, and installment numbers are normalized.
// Every volume needs an integrity block ("is this actually a book?" — see
// validateVolumeIntegrity), so the fixtures build volumes through this helper
// with a sound default; tests that are actually about the integrity rule build
// their blocks explicitly.
const OK_INTEGRITY = { isNarrative: true, confidence: 0.9, basis: "a continuous narrative" };
const V = (installmentNumber, folder, sourceFile) => ({
  installmentNumber,
  folder,
  sourceFile,
  integrity: { ...OK_INTEGRITY },
});
const goodManifest = {
  schema: 2,
  seriesLocation: "/x",
  seriesName: "s",
  sourceLanguage: "Japanese",
  targetLanguage: "English",
  volumes: [V("01", "s(1)", "s(1)/s(1).md"), V("02", "s(2)", "s(2)/s(2).md")],
};
assert.strictEqual(validateManifest(goodManifest), goodManifest);
assert.throws(() => validateManifest({ ...goodManifest, schema: 1 }), /schema/);
assert.throws(() => validateManifest({ ...goodManifest, seriesName: "" }), /seriesName/);
assert.throws(() => validateManifest({ ...goodManifest, sourceLanguage: undefined }), /sourceLanguage/);
assert.throws(() => validateManifest({}), /schema/);
assert.throws(() => validateManifest(null), /not a JSON object/i);
assert.throws(() => validateManifest({ ...goodManifest, volumes: [] }), /no volumes/i);
assert.throws(
  () =>
    validateManifest({
      ...goodManifest,
      volumes: [V("01", "s(1)", "")],
    }),
  /sourceFile/
);
assert.throws(
  () =>
    validateManifest({
      ...goodManifest,
      volumes: [
        V("01", "s(1)", "s(1)/a"),
        V("01", "s(2)", "s(2)/b"),
      ],
    }),
  /duplicates installment/
);
assert.throws(
  () =>
    validateManifest({
      ...goodManifest,
      volumes: [
        V("01", "s(1)", "s(1)/a"),
        V("02", "s(1)", "s(1)/b"),
      ],
    }),
  /duplicates folder/
);
// A volume's source must be the staged copy inside its own folder: otherwise the
// artifacts land in one folder while the book sits in another (or at the series
// root, where the next intake would see it as a new book).
assert.throws(
  () =>
    validateManifest({
      ...goodManifest,
      volumes: [V("01", "s(1)", "loose.md")],
    }),
  /inside its own volume folder/
);
assert.throws(
  () =>
    validateManifest({
      ...goodManifest,
      volumes: [V("01", "s(1)", "s(2)/other.md")],
    }),
  /inside its own volume folder/
);
assert.strictEqual(
  validateManifest({
    ...goodManifest,
    volumes: [V("01", "s(1)", "s(1)\\s(1).md")],
  }).volumes[0].sourceFile,
  "s(1)/s(1).md",
  "backslash separators are stored as forward slashes"
);
// A folder name that would escape the series folder or break a file system.
assert.throws(
  () =>
    validateManifest({
      ...goodManifest,
      volumes: [V("01", "../evil", "a")],
    }),
  /single folder name/
);
assert.throws(
  () =>
    validateManifest({
      ...goodManifest,
      volumes: [V("01", "s(1)", "../secret.txt")],
    }),
  /\.\./
);
// Installment numbers are normalized ("1" -> "01"), and a non-number fails.
const normalized = validateManifest({
  ...goodManifest,
  volumes: [V("1", "s(1)", "s(1)/a")],
});
assert.strictEqual(normalized.volumes[0].installmentNumber, "01");
assert.throws(
  () =>
    validateManifest({
      ...goodManifest,
      volumes: [V("first", "s(1)", "s(1)/a")],
    }),
  /positive integer/
);
// The discovery block is optional, but a malformed one is a validation failure.
const withDiscovery = validateManifest({
  ...goodManifest,
  discovery: {
    summary: "s",
    confidence: { order: 0.9 },
    evidence: ["e"],
    excluded: [{ file: "art.epub", reason: "art book" }],
  },
});
assert.strictEqual(withDiscovery.discovery.confidence.order, 0.9);
assert.strictEqual(withDiscovery.volumes.length, 2);
assert.throws(
  () =>
    validateManifest({
      ...goodManifest,
      discovery: { confidence: { order: 90 } },
    }),
  /0 to 1/
);
assert.throws(
  () => validateManifest({ ...goodManifest, discovery: { excluded: [{ file: "x" }] } }),
  /reason/
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
assert.ok(gResearcherTurn.includes("- (pending: "), "glossary researcher turn mentions the unique placeholder");

const glossaryCtx2 = { ...glossaryCtx, isFirst: false, previousFolderName: "story_name(1)" };
assert.ok(buildGlossaryAuthorTurnPrompt(glossaryCtx2, terms, false).includes("../story_name(1)/glossary.md"), "volume-2: previous glossary path");
assert.ok(buildGlossaryValidatorTurnPrompt(glossaryCtx2).includes("../story_name(1)/glossary.md"), "volume-2 validator: previous glossary path");
assert.ok(buildGlossaryFeedbackTurnPrompt(glossaryCtx2).includes("../story_name(1)/glossary.md"), "volume-2 feedback: previous glossary path");

// ─── the glossary is AMENDED, not rewritten ─────────────────────────────────
// The cumulative glossary outgrows one reply around volume 03, and every glossary
// pass used to be told "writeFile, complete contents, overwrite". Observed on the
// live 17-volume run: one agent tried to obey and its writeFile argument was cut
// off mid-string (the tool call failed and the volume died); others paged the
// file 8–17 times, patched it 16–39 times, ran out of their step budget, and
// shipped a glossary missing 457 of the 769 terms it had to carry.
// The workflow now copies the baseline in, so the agent edits a file it can see.

// A seeded volume (the copy already happened) is told to edit in place, and is
// explicitly forbidden from the whole-file write.
const seededCtx = {
  ...glossaryCtx2,
  glossarySeeded: true,
  glossaryIndex: "### Characters (2)\nソラ → Sora, 月影 → Moonshadow",
};
const seededTurn = buildGlossaryAuthorTurnPrompt(seededCtx, terms, false);
assert.ok(seededTurn.includes("ALREADY holds"), "seeded author turn says the file already holds the glossary");
assert.ok(seededTurn.includes("editFile"), "seeded author turn instructs editFile");
assert.ok(seededTurn.includes("Do NOT rewrite the whole file with writeFile"), "seeded author turn forbids the whole-file rewrite");
assert.ok(seededTurn.includes('The glossary to amend: "glossary.md"'), "seeded author turn names the same-folder file to amend");
assert.ok(seededTurn.includes("ソラ → Sora"), "seeded author turn carries the compact term index");
assert.ok(seededTurn.includes("Never delete a row"), "seeded author turn protects the carried-forward rows");

// An unseeded volume (first volume, or a failed seed) is the one case where a
// whole-file write is correct — and it says so instead of editing a missing file.
const unseededTurn = buildGlossaryAuthorTurnPrompt(glossaryCtx2, terms, false);
assert.ok(unseededTurn.includes("does not exist yet"), "unseeded author turn says the file must be created");
assert.ok(unseededTurn.includes("writeFile"), "unseeded author turn instructs writeFile");
assert.ok(!unseededTurn.includes("ALREADY holds"), "unseeded author turn does not claim a baseline that is not there");

// Both feedback passes get the same instruction and the same index.
const seededFeedback = buildGlossaryFeedbackTurnPrompt(seededCtx);
assert.ok(seededFeedback.includes("editFile"), "feedback turn instructs editFile");
assert.ok(seededFeedback.includes("Do NOT rewrite the whole file with writeFile"), "feedback turn forbids the whole-file rewrite");
assert.ok(seededFeedback.includes("ソラ → Sora"), "feedback turn carries the term index");
const segFeedback = buildGlossarySegmentFeedbackPrompt(
  { ...seededCtx, bundle: { segments: [{ id: "ch1", file: "story_name(1)-ch1.md" }] } },
  { id: "ch1", file: "story_name(1)-ch1.md" },
  0
);
assert.ok(segFeedback.includes("editFile"), "per-chapter feedback turn instructs editFile");
assert.ok(segFeedback.includes("ソラ → Sora"), "per-chapter feedback turn carries the term index");

// The recovery turn used to demand the exact instruction that broke the file.
const recoveryWithContent = glossaryRecoveryPrompt(true);
assert.ok(recoveryWithContent.includes("editFile"), "recovery turn applies the additions with editFile");
assert.ok(recoveryWithContent.includes("Do NOT rewrite"), "recovery turn does not ask for a whole-file rewrite");
assert.ok(!recoveryWithContent.includes("rewrite the complete glossary using writeFile"), "recovery turn: no whole-file rewrite demand");
assert.ok(glossaryRecoveryPrompt(false).includes("editFile"), "empty-output recovery turn also edits");

// The compact index: sections, term → rendering, and an honest note when capped.
const indexMarkdown =
  "# Glossary\n\n## Characters\n| Src | Tgt | Notes |\n|---|---|---|\n| ソラ | Sora | protagonist |\n" +
  "## Places\n| Src | Tgt | Notes |\n|---|---|---|\n| 月影学園 | Moonshadow Academy | school |\n";
const index = buildGlossaryIndex(indexMarkdown);
assert.ok(index.includes("### Characters (1)"), "glossary index names the section and its count");
assert.ok(index.includes("ソラ → Sora"), "glossary index pairs each term with the rendering it already has");
assert.ok(!index.includes("protagonist"), "glossary index drops the Notes column (it is what makes the file big)");
assert.strictEqual(buildGlossaryIndex("no tables here"), "", "glossary index: no rows, no index");
process.env.GLOSSARY_INDEX_MAX_CHARS = "40";
const cappedIndex = buildGlossaryIndex(indexMarkdown);
assert.ok(cappedIndex.includes("are not listed here"), "capped glossary index SAYS it truncated (gotcha 43)");
assert.ok(
  cappedIndex.includes("a term missing from this list is not a term missing from the glossary"),
  "capped glossary index says what its own truncation does NOT prove (gotcha 43)"
);
delete process.env.GLOSSARY_INDEX_MAX_CHARS;

// ─── the carry-forward guard (deterministic, no model call) ─────────────────
// Nothing else in the stage can see a lost term: the validator reads this
// volume's source and the current glossary, and a term that belonged to volume
// 2 is invisible to it. Volume 06 shipped 411 of volume 05's 769 terms and
// every later volume would have been translated against that.
const prevGlossary =
  "## Characters\n| Src | Tgt | Notes |\n|---|---|---|\n| A | Alpha | a |\n| B | Beta | b |\n" +
  "## Terms\n| Src | Tgt | Notes |\n|---|---|---|\n| C | Gamma | c |";
const grown = prevGlossary + "\n| D | Delta | d |";
const shrunk = "## Characters\n| Src | Tgt | Notes |\n|---|---|---|\n| A | Alpha | a |\n| D | Delta | d |";

const grownDiff = compareGlossaryCarryForward(prevGlossary, grown);
assert.strictEqual(grownDiff.previousCount, 3);
assert.strictEqual(grownDiff.currentCount, 4);
assert.deepStrictEqual(grownDiff.missing, [], "a grown glossary loses nothing");
assert.deepStrictEqual(grownDiff.added, ["D"], "the guard reports what the volume added");

const shrunkDiff = compareGlossaryCarryForward(prevGlossary, shrunk);
assert.deepStrictEqual(
  shrunkDiff.missing.map((e) => `${e.term}[${e.section}]`),
  ["B[Characters]", "C[Terms]"],
  "the guard names every lost term AND the section it came from"
);
assert.strictEqual(shrunkDiff.currentCount, 2);
// Reordering and re-sectioning are not a loss.
assert.deepStrictEqual(
  compareGlossaryCarryForward(prevGlossary, "## Terms\n| Src | Tgt |\n|---|---|\n| C | Gamma |\n| B | Beta |\n| A | Alpha |").missing,
  [],
  "a reordered glossary is not a lost glossary"
);
assert.deepStrictEqual(compareGlossaryCarryForward("", prevGlossary).missing, [], "no baseline, nothing to carry");

// An entry is a SET OF SPELLINGS, not a cell of text. This is the live false
// positive that quarantined a good volume 02: the agent widened two rows with a
// new alias, the guard compared whole cells as exact strings, called an
// improvement a loss, and threw away a glossary that had grown 88 terms → 140.
const aliasPrev =
  "## Characters\n| Src | Tgt | Notes |\n|---|---|---|\n" +
  "| 三つ編み魔王 / 三つ編み悪魔 / 呪われし姫君 | the Braided Demon King | a |\n" +
  "| 鈍感系巻き込まれ型主人公 | the Oblivious Protagonist | b |";
const aliasWidened =
  "## Characters\n| Src | Tgt | Notes |\n|---|---|---|\n" +
  "| 三つ編み魔王 / 三つ編み悪魔 / 魔王 / 呪われし姫君 | the Braided Demon King | a, widened |\n" +
  "| 鈍感系巻き込まれ型主人公 / 鈍感純情ＢＯＹ | the Oblivious Protagonist | b, widened |";
const aliasDiff = compareGlossaryCarryForward(aliasPrev, aliasWidened);
assert.deepStrictEqual(aliasDiff.missing, [], "widening a row with a new alias is NOT a lost term");
assert.strictEqual(aliasDiff.restructured, 2, "and it is reported as reworded, not as an addition");
assert.deepStrictEqual(aliasDiff.added, [], "a widened row is not a new entry");
assert.doesNotThrow(
  () => reportCarryForwardLoss("02", aliasDiff, "the amend pass", "the previous volume's glossary"),
  "the guard that rejected volume 02 now passes it"
);
// One row SPLIT into several still carries every spelling it named.
assert.deepStrictEqual(
  compareGlossaryCarryForward(aliasPrev, "## Characters\n| Src | Tgt |\n|---|---|\n| 三つ編み魔王 | X |\n| 三つ編み悪魔 | Y |\n| 呪われし姫君 | Z |\n| 鈍感系巻き込まれ型主人公 | W |").missing,
  [],
  "splitting one alias row into several is not a loss"
);
// …but a spelling that is genuinely gone is still caught, alias row or not.
const aliasLost = compareGlossaryCarryForward(
  aliasPrev,
  "## Characters\n| Src | Tgt |\n|---|---|\n| 三つ編み魔王 / 三つ編み悪魔 | X |\n| 鈍感系巻き込まれ型主人公 | W |"
);
assert.deepStrictEqual(
  aliasLost.missing.map((e) => e.term),
  ["三つ編み魔王 / 三つ編み悪魔 / 呪われし姫君"],
  "dropping one spelling out of an alias row IS a loss — the gate is about spellings"
);
// …and a one-character term is not proven carried by a substring landing inside
// someone else's Notes cell.
assert.deepStrictEqual(
  compareGlossaryCarryForward(
    prevGlossary,
    "## Characters\n| Src | Tgt | Notes |\n|---|---|---|\n| A | Alpha | a |\n| D | Delta | d, cf. B and C"
  ).missing.map((e) => e.term),
  ["B", "C"],
  "a short spelling mentioned in a Notes cell is not evidence an entry survived"
);

// A RENAME is not a loss. This is the live failure that aborted a 12-hour run:
// volume 15 chapter 6 re-proposed 双ふた花ばの恋物語 under the fully furiganed
// spelling the chapter actually prints, the amend pass reconciled the two
// spellings into one row exactly as its system prompt tells it to ("reconcile
// them to a single canonical form and note the change"), and the gate — which
// read only the term column — called the rewritten row a deletion and quarantined
// a glossary that had GROWN from 445 terms to 460.
const renamePrev =
  "## Items\n| Src | Tgt | Notes |\n|---|---|---|\n" +
  "| 双ふた花ばの恋物語 | *The Twin Flowers' Love Story* | a library book |\n" +
  "| 子犬のワルツ | Minute Waltz | a piece of music |";
const renameNoted =
  "## Items\n| Src | Tgt | Notes |\n|---|---|---|\n" +
  "| 双ふた花ばの恋こい物もの語がたり | *The Twin Flowers' Love Story* | Coined title (also written 双ふた花ばの恋物語): Pansy's favourite book |\n" +
  "| 子犬のワルツ | Minute Waltz | a piece of music |";
const renameDiff = compareGlossaryCarryForward(renamePrev, renameNoted);
assert.deepStrictEqual(
  renameDiff.missing,
  [],
  "a term carried under another source-language spelling is NOT a lost term"
);
assert.strictEqual(renameDiff.renamed.length, 1, "…and it is reported as a rename, not silently absorbed");
assert.strictEqual(renameDiff.renamed[0].now, "双ふた花ばの恋こい物もの語がたり", "the rename names the row the entry moved into");
assert.deepStrictEqual(renameDiff.added, [], "a renamed row is not this volume's new work");
assert.doesNotThrow(
  () => reportCarryForwardLoss("15", renameDiff, "the amend pass for chapter ch6", "the glossary as of the previous chapter"),
  "the gate that killed volume 15 now passes it"
);
// A rename with no "also written" note is still a rename when the row carries the
// same target-language rendering and that rendering is unique on both sides.
const bareDiff = compareGlossaryCarryForward(
  renamePrev,
  renameNoted.replace("Coined title (also written 双ふた花ばの恋物語): ", "Coined title: ")
);
assert.deepStrictEqual(bareDiff.missing, [], "the unchanged rendering is the other half of the rename evidence");
assert.strictEqual(bareDiff.renamed.length, 1, "…reported as a rename, not a loss");
assert.deepStrictEqual(bareDiff.added, [], "…and not counted as an addition either");
// A genuinely deleted entry is still caught: no row, no spelling, no rendering.
const deletedDiff = compareGlossaryCarryForward(
  renamePrev,
  "## Items\n| Src | Tgt | Notes |\n|---|---|---|\n| 子犬のワルツ | Minute Waltz | a piece of music |\n| 新語 | New Thing | new |"
);
assert.deepStrictEqual(deletedDiff.missing.map((e) => e.term), ["双ふた花ばの恋物語"], "a deleted entry is still a loss");
assert.strictEqual(deletedDiff.renamed.length, 0, "…and nothing is excused as a rename");
assert.throws(
  () => reportCarryForwardLoss("15", deletedDiff, "the amend pass", "the previous volume's glossary"),
  /dropped 1 of the 2 term\(s\)/,
  "the gate still fails the volume on a real deletion"
);
// An incidental mention does not excuse a deletion: the rename test only trusts a
// row that is this volume's new work, never one already carrying a term.
assert.deepStrictEqual(
  compareGlossaryCarryForward(
    renamePrev,
    "## Items\n| Src | Tgt | Notes |\n|---|---|---|\n| 子犬のワルツ | Minute Waltz | a piece of music; cf. 双ふた花ばの恋物語 |\n| 新語 | New Thing | new |"
  ).missing.map((e) => e.term),
  ["双ふた花ばの恋物語"],
  "a carried-forward row mentioning the lost term in its Notes is not the row it moved into"
);

assert.doesNotThrow(() => reportCarryForwardLoss("02", grownDiff, "the amend pass", "the previous volume's glossary"), "no loss, no failure");
assert.throws(
  () => reportCarryForwardLoss("06", shrunkDiff, "the amend pass", "the previous volume's glossary"),
  /dropped 2 of the 3 term\(s\)/,
  "a lost term fails the volume, loudly and with the numbers"
);
assert.throws(
  () => reportCarryForwardLoss("06", shrunkDiff, "the amend pass", "the previous volume's glossary"),
  /cumulative/,
  "the failure message says why it matters"
);

// The step caps that ran out on the live run now follow what they must read.
assert.ok(findingsMergeMaxStepsFor(10, 473000) > 20, "findings-merge cap: a flat 20 lost a whole validation round on 10 chapters");
assert.ok(findingsMergeMaxStepsFor(1, 0) >= 20, "findings-merge cap keeps the old floor for a small volume");
assert.ok(authorMaxStepsFor(473000, 200000) > 40, "author cap: a flat 40 was where 17 of the 25 step-cap warnings came from");
assert.strictEqual(authorMaxStepsFor(0, 0), 40, "author cap floor is the old flat value");
assert.strictEqual(validatorMaxStepsFor(0), 40, "validator cap floor unchanged");

// ─── truncateGlossary ────────────────────────────────────────────────────────
// Under the threshold: returns content unchanged.
const shortGlossary = "## Characters\n| Source | Rendering | Notes |\n|---|---|---|\n| A | Alpha | a |\n| B | Beta | b |";
assert.strictEqual(truncateGlossary(shortGlossary), shortGlossary, "truncateGlossary: short content unchanged");
assert.strictEqual(truncateGlossary(""), "", "truncateGlossary: empty content unchanged");

// Over the threshold (64KB). The glossary the workflow actually writes is a set
// of Markdown TABLES — the old list-item splitter matched none of them, so
// truncation never happened (the helper returned the file untouched).
const tableRows = Array.from(
  { length: 1200 },
  (_, i) => `| Term${i} | Rendering${i} | This is a description for term ${i} that is quite long |`
);
const longGlossary = [
  "# Glossary — Test",
  "",
  "## Characters",
  "| Source | Rendering | Notes |",
  "|---|---|---|",
  ...tableRows.slice(0, 600),
  "",
  "## Terms & Concepts",
  "| Source | Rendering | Notes |",
  "|---|---|---|",
  ...tableRows.slice(600),
].join("\n");
assert.ok(longGlossary.length > 64 * 1024, `fixture is ${longGlossary.length} chars (over the 64KB threshold)`);
const truncated = truncateGlossary(longGlossary);
assert.ok(truncated.includes("[TRUNCATED:"), "truncateGlossary: truncated content has the header note");
assert.ok(!truncated.includes("| Term0 |"), "truncateGlossary: the oldest rows are removed");
assert.ok(truncated.includes("| Term1199 |"), "truncateGlossary: the newest rows are kept");
assert.ok(truncated.includes("| Source | Rendering | Notes |"), "truncateGlossary: the surviving tables keep their header row");
assert.ok(truncated.includes("## Terms & Concepts"), "truncateGlossary: a surviving section keeps its heading");
// Exactly the newest window survives.
const keptRows = (truncated.match(/^\| Term\d+ \|/gm) || []).length;
assert.strictEqual(keptRows, 200, "truncateGlossary: keeps GLOSSARY_TRUNCATION_MAX_ENTRIES (200) rows");
// A section truncated away entirely loses its heading (no empty section shown) — but its terms are
// still named in the index at the end, which is the whole point of appending one.
assert.ok(!/^## Characters$/m.test(truncated), "truncateGlossary: a fully truncated section loses its heading");
assert.ok(/### Characters \(\d+\)/.test(truncated), "truncateGlossary: the section's terms are still named in the index");
// Under the entry cap but over the byte threshold: unchanged (nothing to drop).
const manyColumns = "## Characters\n| Source | Rendering | Notes |\n|---|---|---|\n" + tableRows.slice(0, 150).join("\n") + "\n" + "x".repeat(70 * 1024);
assert.strictEqual(truncateGlossary(manyColumns), manyColumns, "truncateGlossary: ≤ 200 rows → unchanged even when oversized");

// Relevance-ordered truncation (the recency bug): a glossary is organised by
// SECTION, so "drop the oldest rows in document order" threw away the volume-1
// main cast — which is exactly what volume 17 still contains — and the extractor
// dutifully rediscovered the protagonists as new terms. With the volume's source
// text, the rows that occur in it are kept no matter where they sit.
{
  // The volume-1 cast sits at the TOP of the Characters table (document order),
  // and 1,198 filler rows follow it.
  const cast = ["| ソラ | Sora | protagonist |", "| 黒鋼 | Kurogane | the other one |"];
  const withCast = [
    "# Glossary — Test",
    "",
    "## Characters",
    "| Source | Rendering | Notes |",
    "|---|---|---|",
    ...cast,
    ...tableRows,
    "",
    "## Terms & Concepts",
    "| Source | Rendering | Notes |",
    "|---|---|---|",
    "| 鏡 | Mirror | the recording system |",
  ].join("\n");
  assert.ok(withCast.length > 64 * 1024, "fixture is oversized");

  const volumeText = "ソラは黒鋼を見た。鏡が音もなく働いていた。";
  const relevant = truncateGlossary(withCast, volumeText);
  assert.ok(relevant.includes("| ソラ | Sora | protagonist |"), "the volume-1 cast survives (it occurs in this volume)");
  assert.ok(relevant.includes("| 黒鋼 | Kurogane | the other one |"), "the second protagonist survives");
  assert.ok(relevant.includes("| 鏡 | Mirror | the recording system |"), "a term from a LATER section survives too");
  assert.ok(relevant.includes("## Characters"), "the section a kept row belongs to keeps its heading");
  assert.ok(relevant.includes("## Terms & Concepts"), "cross-section relevance keeps both headings it needs");
  const relevantRows = (relevant.match(/^\| (?:Term\d+|ソラ|黒鋼|鏡) \|/gm) || []).length;
  assert.strictEqual(relevantRows, 200, "the entry cap still bounds how many rows are shown in full");
  assert.ok(
    relevant.includes("3 row(s) name a term that occurs in the text being translated"),
    "the note says WHY these rows were chosen, and counts the relevant half separately: " +
      (relevant.match(/\[TRUNCATED:[^\n]*/) || ["(no note)"])[0]
  );
  assert.ok(
    relevant.includes("with 197 background rows in document order"),
    "and it counts the background half, so the two halves add up to what it shows: " +
      (relevant.match(/\[TRUNCATED:[^\n]*/) || ["(no note)"])[0]
  );
  assert.ok(
    relevant.includes("[EVERY TERM THIS GLOSSARY ALREADY HOLDS — all 1203 of them"),
    "the excerpt ends with the complete name-and-rendering list, so a row the cap cut is still named"
  );

  // Without a source text the old newest-window behavior is kept (and the note
  // says so rather than pretending the selection was relevance-based).
  const legacy = truncateGlossary(withCast);
  assert.ok(!legacy.includes("| ソラ | Sora | protagonist |"), "no source text → the old document-order window");
  assert.ok(legacy.includes("Showing the 200 in document order"), "the note is honest about which rule ran");
}

// The relevance rule reads the SPELLINGS INSIDE a row, not the whole first cell — and it survives
// furigana, which is what the whole-cell rule could not. Volume 14's row is 双ふた花ばの恋物語;
// volume 15 chapter 6 prints 双ふた花ばの恋こい物もの語がたり. Neither contains the other, the row was
// invisible, the term was re-proposed as new, the amend pass reconciled it into the row that already
// held it, and the gate called that a deletion: a glossary that had GROWN from 445 rows to 460 was
// quarantined and a 12-hour run ended (gotcha 68).
{
  // The three rows under test sit AFTER the 800 filler rows on purpose: the background half of the
  // window is taken in document order, so a row at the very end is only shown in full when the
  // relevance rule matched it — which is what makes the third row a test of the rule, not of the window.
  const furiganed = [
    "# Glossary — Test",
    "",
    "## Terms & Concepts",
    "| Source | Rendering | Notes |",
    "|---|---|---|",
    ...tableRows.slice(0, 800),
    "| 双ふた花ばの恋物語 | *The Twin Flowers' Love Story* | the coined library book |",
    "| 三つ編み魔王 / 三つ編み悪魔 | The Braided Demon | one entry, two spellings |",
    "| 学校 | School | a building the chapter never mentions |",
  ].join("\n");
  assert.ok(furiganed.length > 64 * 1024, "fixture is oversized");

  // The book prints the title with furigana INSIDE the word, and it prints one alias of the
  // slash-separated row, and it says 校舎 / 数学 — never 学校.
  const chapter =
    "双ふた花ばの恋こい物もの語がたり』という本。三つ編み悪魔が笑った。校舎の脇で数学の話をした。";
  const out = truncateGlossary(furiganed, chapter);

  assert.ok(
    out.includes("| 双ふた花ばの恋物語 |"),
    "the row survives although the chapter spells the term a different way — the exact row whose " +
      "invisibility started the volume-15 chain"
  );
  assert.ok(
    out.includes("| 三つ編み魔王 / 三つ編み悪魔 |"),
    "a row counts when ANY spelling its term column names occurs, not when the whole cell does"
  );
  assert.ok(
    !out.includes("| 学校 | School |"),
    "and the Han-skeleton test is not trusted below GLOSSARY_SKELETON_MIN_CHARS: 校 and 学 sit all " +
      "over a real page, so a two-character skeleton matches everything and therefore nothing"
  );
  assert.ok(
    out.includes("学校 → School"),
    "yet the term is still NAMED in the complete list at the end: the window hides a row's Notes, " +
      "never the existence of an entry"
  );
  assert.ok(
    out.includes("2 row(s) name a term that occurs in the text being translated"),
    "the note counts the rows the text mentions: " + (out.match(/\[TRUNCATED:[^\n]*/) || ["(no note)"])[0]
  );
}

// When the text mentions MORE terms than the window holds, the cap cuts FULL rows — and nothing is
// hidden by it, because every term the file holds is still named in the list appended below the tables.
// That list is the half the extractor needs in order to not call an existing term new, and it is what
// the volume-15 chain was missing: the extractor re-proposed 双ふた花ばの恋物語 because the row that
// held it had been cut, and the prompt's "do not re-add a term merely because you cannot see it" asked
// a one-shot call with no file tools to check something it had no way to check.
{
  const mentioned = Array.from({ length: 260 }, (_, i) => `| 用語${i} | Term${i} | a term this chapter uses |`);
  const capped = [
    "# Glossary — Test",
    "",
    "## Terms & Concepts",
    "| Source | Rendering | Notes |",
    "|---|---|---|",
    ...mentioned,
    ...tableRows.slice(0, 700),
  ].join("\n");
  assert.ok(capped.length > 64 * 1024, "fixture is oversized");
  const src = mentioned.map((_, i) => `用語${i}について書いた。`).join("");

  const shown = truncateGlossary(capped, src);
  const keptFull = mentioned.filter((row) => shown.includes(row));
  assert.strictEqual(keptFull.length, 200, `the cap bounds the rows shown IN FULL: ${keptFull.length}`);
  const cutNames = mentioned.filter((row) => !shown.includes(row)).map((row) => row.split("|")[1].trim());
  const unnamed = cutNames.filter((t) => !shown.includes(`${t} → Term`));
  assert.deepStrictEqual(unnamed, [], `${cutNames.length} rows were cut by the cap; every term they hold must still be named`);
  assert.ok(!shown.includes("| Term0 | Rendering0 |"), "no room was left for background rows, which is the right trade");
  assert.ok(
    shown.includes("260 row(s) name a term that occurs in the text being translated"),
    (shown.match(/\[TRUNCATED:[^\n]*/) || ["(no note)"])[0]
  );
  assert.ok(
    shown.includes("the 200 most relevant of them are among the rows shown, with 0 background rows in document order"),
    "the note says which half the cap cut: " + (shown.match(/\[TRUNCATED:[^\n]*/) || ["(no note)"])[0]
  );
  assert.ok(
    shown.includes("[EVERY TERM THIS GLOSSARY ALREADY HOLDS — all 960 of them"),
    "and the excerpt says out loud that the list at the end is the whole glossary"
  );
}

// ─── buildUnusedEntriesNote (the coverage audit feeding back) ────────────────
const { buildUnusedEntriesNote } = require("../glossary");

{
  const coverage = {
    volume: "02",
    terms: [
      { term: "ソラ", section: "Characters", occurrences: 41 },
      { term: "黒鋼", section: "Characters", occurrences: 0 },
      { term: "鏡", section: "Items", occurrences: 0 },
    ],
  };
  const note = buildUnusedEntriesNote(coverage);
  assert.ok(note.includes("## Entries the previous volume never used"), "the note has its own section");
  assert.ok(note.includes("2 glossary entr"), "it counts the unused entries");
  assert.ok(note.includes("- 黒鋼 (Characters)") && note.includes("- 鏡 (Items)"), "it names them");
  assert.ok(!note.includes("ソラ"), "a term that WAS used is not flagged");
  assert.ok(note.includes("candidate for removal"), "it says what to do about them");
  assert.ok(note.includes("volume 02"), "it says which volume the audit came from");

  // Nothing to say → nothing injected.
  assert.strictEqual(buildUnusedEntriesNote(null), "", "no coverage file → no note");
  assert.strictEqual(buildUnusedEntriesNote({ terms: [] }), "", "empty coverage → no note");
  assert.strictEqual(
    buildUnusedEntriesNote({ volume: "01", terms: [{ term: "x", occurrences: 3 }] }),
    "",
    "every term used → no note"
  );

  // Bounded: a 200-term list is noise, so the note names the cap and counts the rest.
  const many = {
    volume: "03",
    terms: Array.from({ length: 200 }, (_, i) => ({ term: `Term${i}`, occurrences: 0 })),
  };
  const bounded = buildUnusedEntriesNote(many, 40);
  assert.strictEqual((bounded.match(/^- Term/gm) || []).length, 40, "the note names at most the cap");
  assert.ok(bounded.includes("and 160 more"), "and says how many it left out");
}

// ─── buildPerTermResearchPrompt ──────────────────────────────────────────────
const perTermPrompt = buildPerTermResearchPrompt(glossaryCtx, { term: "ソラ", type: "character", query: "ソラ" }, 0);
assert.ok(perTermPrompt.includes("ソラ"), "per-term prompt carries the term");
assert.ok(perTermPrompt.includes("glossary-research.md"), "per-term prompt names the notes file");
assert.ok(perTermPrompt.includes("- (pending: "), "per-term prompt mentions the unique placeholder");
assert.ok(perTermPrompt.includes("editFile"), "per-term prompt instructs editFile");

// ─── character-voice: parseVoiceQuirks ──────────────────────────────────────
const {
  parseVoiceQuirks,
  truncateVoiceRef,
  emittedToolCallAsText,
  buildExtractTurnPrompt,
  buildAuthorTurnPrompt,
  buildValidatorTurnPrompt,
  buildFeedbackTurnPrompt,
  parseVoiceSections,
  voicePrimaryName,
  buildVoiceIndex,
  voiceWriteInstruction,
  voiceRecoveryPrompt,
  compareVoiceCarryForward,
} = require("../character-voice");

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

// ─── utils/prompt: selectSectionsByRelevance ─────────────────────────────────
const { selectSectionsByRelevance } = require("../utils/prompt");

{
  const doc = ["# Ref", "", "### Sora", "quirk A", "### Kurogane", "quirk B", "### Nobody", "quirk C"].join("\n");
  // Under the cap: untouched.
  const untouched = selectSectionsByRelevance({ content: doc, headingRe: /^### /m, sourceText: "Sora", maxUnits: 3 });
  assert.strictEqual(untouched.content, doc, "at or under the cap the document is returned unchanged");
  assert.strictEqual(untouched.truncated, false);

  // Relevance wins over position: the FIRST section survives, the last one goes.
  const picked = selectSectionsByRelevance({ content: doc, headingRe: /^### /m, sourceText: "Sora", maxUnits: 1 });
  assert.ok(picked.content.includes("### Sora"), "the relevant section is kept");
  assert.ok(!picked.content.includes("### Nobody"), "the irrelevant newest section is the one dropped");
  assert.strictEqual(picked.relevant, 1);
  assert.strictEqual(picked.dropped, 2);

  // A quoted source-language span inside a section also counts as relevance.
  const quoted = ["## Honorifics", "- keep 〜さん", "## Onomatopoeia", "- render ギューッ as a swoosh"].join("\n");
  const q = selectSectionsByRelevance({ content: quoted, headingRe: /^## /m, sourceText: "彼はさんづけで呼んだ", maxUnits: 1 });
  assert.ok(q.content.includes("## Honorifics"), "a section quoting a pattern the source contains is kept");
  assert.ok(!q.content.includes("## Onomatopoeia"), "the section whose pattern is absent goes");

  // No source text → the old "last N" window, and the note says so.
  const legacy = selectSectionsByRelevance({ content: doc, headingRe: /^### /m, maxUnits: 1 });
  assert.ok(legacy.content.includes("### Nobody"), "no source text keeps the legacy window");
  assert.ok(legacy.content.includes("Showing the last 1"), "the note names the rule that ran");
}

// ─── character-voice: truncateVoiceRef ──────────────────────────────────────
const shortVoiceRef = "### ソラ\n- sentence endings: 〜である\n### 黒鋼\n- sentence endings: 〜だぜ";
assert.strictEqual(truncateVoiceRef(shortVoiceRef), shortVoiceRef, "truncateVoiceRef: short content unchanged");

// Over threshold: need > 64KB of character sections
const longVoiceRef = "Header\n\n" + Array.from({ length: 2000 }, (_, i) => `### Character${i}\n- sentence endings: quirk ${i} quirk ${i} quirk ${i} quirk ${i} quirk ${i} quirk ${i}`).join("\n\n");
const truncatedVoice = truncateVoiceRef(longVoiceRef);
assert.ok(truncatedVoice.includes("[TRUNCATED:"), "truncateVoiceRef: truncated content has header note");
assert.ok(!truncatedVoice.includes("Character0"), "truncateVoiceRef: with no source text the legacy window is used");
assert.ok(truncatedVoice.includes("Character"), "truncateVoiceRef: some entries kept");

// The recency bug: the volume-1 cast sits at the TOP of the reference forever,
// and "show the last N sections" dropped them — so volume 17 rediscovered the
// protagonists as new characters. With the volume's source text they survive.
{
  const castRef =
    "Header\n\n### 主人公\n- sentence endings: 〜である quirk quirk quirk\n\n### 黒鋼\n- sentence endings: 〜だぜ quirk quirk quirk\n\n" +
    longVoiceRef.replace("Header\n\n", "");
  assert.ok(castRef.length > 64 * 1024, "voice fixture is oversized");
  const relevantVoice = truncateVoiceRef(castRef, "主人公は黒鋼と歩いた。");
  assert.ok(relevantVoice.includes("### 主人公"), "the volume-1 protagonist is kept whatever their position");
  assert.ok(relevantVoice.includes("### 黒鋼"), "the second protagonist is kept");
  assert.ok(relevantVoice.includes("occurs in the text being processed"), "the note says why these sections were chosen");
}

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
  truncateStyleGuide,
  parseStyleSections,
  countStyleRules,
  buildStyleIndex,
  styleWriteInstruction,
  styleRecoveryPrompt,
  compareStyleCarryForward,
} = require("../style-guide");

// ─── style-guide: truncateStyleGuide ─────────────────────────────────────────
{
  // Over the byte threshold with more sections than the cap.
  const filler = Array.from(
    { length: 420 },
    (_, i) =>
      `## Category${i}\n- policy ${i}: render pattern${i} this way, with enough prose in every section ` +
      `to push the whole document past the byte threshold on its own, repeated a few times so the size grows.`
  ).join("\n\n");
  const bigGuide =
    "# Style Guide\n\n## Honorifics\n- keep 〜さん as -san.\n\n## POV markers\n- render ※ as a bold header.\n\n" + filler;
  assert.ok(bigGuide.length > 64 * 1024, `style fixture is ${bigGuide.length} chars`);

  const legacy = truncateStyleGuide(bigGuide);
  assert.ok(legacy.includes("[TRUNCATED:"), "oversized guide is truncated");
  assert.ok(!legacy.includes("## Honorifics"), "with no source text the legacy last-N window drops the first section");

  // Relevance: the honorific policy quotes 〜さん, which this volume contains, so
  // it survives even though it is the FIRST section in the document.
  const relevant = truncateStyleGuide(bigGuide, "彼女はさんづけで呼ばれた。");
  assert.ok(relevant.includes("## Honorifics"), "a policy whose quoted pattern occurs in this volume is kept");
  assert.ok(relevant.includes("occurs in the text being processed"), "the note says why these sections were chosen");
  assert.ok(!relevant.includes("## Category419"), "the sections that go are the irrelevant ones at the end of the window");
  assert.ok(relevant.includes("occurs in the text being processed (1 such section(s))"), "exactly one section was relevance-selected");
}

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

// ─── the cumulative-document rules the glossary established, now in the other
//     two cumulative stages (gotcha 64) ───────────────────────────────────────
//
// The character voice reference and the style guide hit the same wall the glossary
// did: the document outgrows one reply, the agent pages it, runs out of steps, and
// rebuilds it from memory. Volume 01's character-voice feedback turn made 46 tool
// calls — 29 reads, 15 searches, ZERO writes — and hit its flat step cap while
// still verifying findings, because the one write it had been told to do was the
// last thing in its instructions.

// voicePrimaryName: the part of a heading that says WHO the section is about.
assert.strictEqual(voicePrimaryName("如月雨露（ジョーロ）【俺人格】"), "如月雨露", "primary name drops the alias and persona tags");
assert.strictEqual(voicePrimaryName("山田（生徒会会計）"), "山田", "primary name drops a bracketed role");
assert.strictEqual(voicePrimaryName("ジョーロの母"), "ジョーロの母", "a heading with no brackets is its own primary name");

const voiceRefPrev =
  "# Character Voice Reference\n\n## Characters\n\n" +
  "### 如月雨露（ジョーロ）【俺人格】\n- quirk A\n\n" +
  "### 如月雨露（ジョーロ）【僕人格】\n- quirk B\n\n" +
  "### 日向葵（ひまわり）\n- quirk C\n";
assert.strictEqual(parseVoiceSections(voiceRefPrev).length, 3, "parseVoiceSections counts the ### character sections");
assert.deepStrictEqual(
  parseVoiceSections(voiceRefPrev).map((s) => s.primary),
  ["如月雨露", "如月雨露", "日向葵"],
  "and keys each one on its character, not its full heading"
);

// A reworded heading is NOT a lost character — the persona tag is the half a
// feedback pass is most likely to reword, and treating that as a deletion is the
// false positive that cost the glossary a good volume 02.
const voiceRenamed = voiceRefPrev
  .replace("【俺人格】", "【俺】")
  .replace("日向葵（ひまわり）", "日向葵（ひまわりちゃん）");
const voiceRenamedDiff = compareVoiceCarryForward(voiceRefPrev, voiceRenamed);
assert.deepStrictEqual(voiceRenamedDiff.missing, [], "rewording a character heading is not losing the character");
assert.strictEqual(voiceRenamedDiff.restructured, 2, "and it is reported as reworded, so a mass rename is visible");

// The reference is cumulative: a character who only ever appeared in volume 2 is
// invisible to this volume's validator, so nothing else in the stage can see it go.
const voiceLost = compareVoiceCarryForward(
  voiceRefPrev,
  voiceRefPrev.replace("### 日向葵（ひまわり）\n- quirk C\n", "")
);
assert.deepStrictEqual(voiceLost.missing.map((m) => m.name), ["日向葵"], "a dropped character section is a loss");
assert.strictEqual(voiceLost.missing[0].expected, 1);
assert.strictEqual(voiceLost.missing[0].found, 0);

// Three personas of one character, then two: "the heading was renamed" cannot
// explain a COUNT dropping, so the merged-away persona is reported.
const voiceMergedPersonas = compareVoiceCarryForward(
  voiceRefPrev,
  voiceRefPrev.replace("### 如月雨露（ジョーロ）【僕人格】\n- quirk B\n\n", "")
);
assert.deepStrictEqual(
  voiceMergedPersonas.missing.map((m) => `${m.name} ${m.found}/${m.expected}`),
  ["如月雨露 1/2"],
  "one of two same-named sections disappearing is a loss, not a rename"
);

// A new character is an addition, and no baseline means nothing to carry.
const voiceGrown = compareVoiceCarryForward(voiceRefPrev, voiceRefPrev + "\n### 山田（生徒会会計）\n- quirk D\n");
assert.deepStrictEqual(voiceGrown.missing, [], "a grown reference loses nothing");
assert.deepStrictEqual(voiceGrown.added, ["山田"], "and the guard reports what the volume added");
assert.deepStrictEqual(compareVoiceCarryForward("", voiceRefPrev).missing, [], "no baseline, nothing to carry");

// The write instruction follows the file, exactly as glossaryWriteInstruction does.
const voiceSeeded = voiceWriteInstruction(true, "amend");
assert.ok(voiceSeeded.includes("ALREADY holds"), "a seeded reference is described as already there");
assert.ok(voiceSeeded.includes("editFile"), "and amended IN PLACE with editFile");
assert.ok(voiceSeeded.includes('Do NOT rewrite "character-voice.md" with writeFile'), "the whole-file write is forbidden by name");
assert.ok(voiceSeeded.includes("pov-map.md"), "the per-volume map is still written whole — the two files are not the same kind");
assert.ok(voiceSeeded.includes("HIGH"), "and the pass works in severity order so a capped turn still leaves a better document");
const voiceUnseeded = voiceWriteInstruction(false, "amend");
assert.ok(voiceUnseeded.includes("does not exist yet") || voiceUnseeded.includes("neither file exists yet"), "the first volume really does write both files whole");
assert.ok(!voiceUnseeded.includes("Do NOT rewrite"), "and is not told to edit a file that is not there");
assert.ok(voiceWriteInstruction(true, "correct").includes("Correct"), "the feedback wording says correct, not amend");

// The recovery turn must not demand the instruction that broke the file.
const voiceRecovery = voiceRecoveryPrompt(true, true);
assert.ok(voiceRecovery.includes("editFile"), "the recovery turn edits");
assert.ok(!/rewrite both files using writeFile/.test(voiceRecovery), "and never demands the whole-file rewrite that destroyed it");
assert.ok(voiceRecoveryPrompt(true, false).includes("writeFile"), "with no seeded file, writing it whole is the right ask");

// The index is a map, not the document, and it says when it truncates (gotcha 43).
assert.ok(buildVoiceIndex(voiceRefPrev).includes("日向葵（ひまわり）"), "the voice index lists the sections");
assert.strictEqual(buildVoiceIndex("no sections here"), "", "voice index: no sections, no index");
process.env.VOICE_INDEX_MAX_CHARS = "40";
const cappedVoiceIndex = buildVoiceIndex(voiceRefPrev);
assert.ok(cappedVoiceIndex.includes("are not listed here"), "capped voice index SAYS it truncated");
assert.ok(cappedVoiceIndex.includes("grep"), "capped voice index names the way to check anyway");
delete process.env.VOICE_INDEX_MAX_CHARS;

// The turn prompts carry the instruction, so the agent is never handed a prompt
// that contradicts it.
const voiceCtxSeeded = { ...voiceCtx, isFirst: false, previousFolderName: "test_story(1)", voiceSeeded: true };
assert.ok(buildAuthorTurnPrompt(voiceCtxSeeded, "[]").includes("editFile"), "the compile turn says amend in place");
assert.ok(buildFeedbackTurnPrompt(voiceCtxSeeded).includes("editFile"), "the feedback turn says patch, not rewrite");
assert.ok(!buildFeedbackTurnPrompt(voiceCtxSeeded).includes("write the complete corrected files"), "and no leftover demand to rewrite everything");
assert.ok(buildFeedbackTurnPrompt(voiceCtxSeeded).includes("ONE grep"), "the feedback turn batches its source checks instead of one search per finding");
assert.ok(buildAuthorTurnPrompt(voiceCtx, "[]").includes("neither file exists yet"), "the first volume's compile turn writes both files whole");

// ─── style-guide: the same rules, on a document whose unit is a section ──────
const styleRefPrev =
  "# Style Guide\n\n## Address & Honorifics\n- rule one\n- rule two\n\n" +
  "## Pronouns\n- rule three\n\n## Open Questions\n- undecided thing\n";
assert.deepStrictEqual(
  parseStyleSections(styleRefPrev).map((s) => s.name),
  ["Address & Honorifics", "Pronouns", "Open Questions"],
  "parseStyleSections reads the guide's category sections"
);
assert.strictEqual(countStyleRules(styleRefPrev), 4, "countStyleRules counts the bullet rules");

// A missing CATEGORY means every rule inside it is gone — that is the half this
// document specifies exactly, so it is the half the guard may fail on.
const styleLost = compareStyleCarryForward(styleRefPrev, styleRefPrev.replace("## Pronouns\n- rule three\n\n", ""));
assert.deepStrictEqual(styleLost.missing.map((s) => s.name), ["Pronouns"], "a dropped category is a loss");

// Fewer bullets is REPORTED, not failed: a guide that says the same thing in
// fewer words is not damaged, and a guard that compares prose starts calling an
// improvement a loss (the mistake that cost the glossary a good volume 02).
const styleReworded = compareStyleCarryForward(
  styleRefPrev,
  styleRefPrev.replace("- rule one\n- rule two", "- one rule covering both")
);
assert.deepStrictEqual(styleReworded.missing, [], "rewording rules within a kept category is not a loss");
assert.strictEqual(styleReworded.currentRules, 3, "two rules collapsed into one is fewer rules…");
assert.strictEqual(styleReworded.previousRules, 4, "…and the guard reports the drop without failing the volume over it");

const styleGrown = compareStyleCarryForward(styleRefPrev, `${styleRefPrev}\n## Tense & Aspect\n- new rule\n`);
assert.deepStrictEqual(styleGrown.missing, [], "a grown guide loses nothing");
assert.deepStrictEqual(styleGrown.added, ["Tense & Aspect"], "and the guard reports what the volume added");

const styleSeeded = styleWriteInstruction(true, "amend");
assert.ok(styleSeeded.includes("ALREADY holds"), "a seeded guide is described as already there");
assert.ok(styleSeeded.includes("editFile"), "and amended IN PLACE with editFile");
assert.ok(styleSeeded.includes('Do NOT rewrite the whole file with writeFile'), "the whole-file write is forbidden by name");
assert.ok(styleSeeded.includes("Open Questions"), "the guide's own escape hatch is named");
assert.ok(!styleWriteInstruction(false, "amend").includes("editFile"), "the first volume writes the guide whole");
assert.ok(styleRecoveryPrompt(true, true).includes("editFile"), "the recovery turn edits");
assert.ok(!/rewrite the file using writeFile/.test(styleRecoveryPrompt(true, true)), "and never demands the whole-file rewrite");
assert.ok(styleBuildAuthorTurnPrompt({ ...styleCtx, isFirst: false, previousFolderName: "test_story(1)", styleSeeded: true }, "[]").includes("editFile"), "the style compile turn says amend in place");
assert.ok(styleBuildFeedbackTurnPrompt({ ...styleCtx, isFirst: false, previousFolderName: "test_story(1)", styleSeeded: true }).includes("editFile"), "the style feedback turn says patch, not rewrite");

// ─── Source bundle: segment id assignment (utils/source.js) ─────────────────
const { assignSegmentIds, classifyTitle, shouldProcessChunked } = require("../utils/source");

assert.strictEqual(classifyTitle("Interlude: The Train"), "interlude", "classifyTitle detects interludes");
assert.strictEqual(classifyTitle("序章"), "prologue", "classifyTitle detects Japanese prologues");
assert.strictEqual(classifyTitle("Epilogue"), "epilogue", "classifyTitle detects epilogues");
assert.strictEqual(classifyTitle("Chapter 3: The Battle"), "chapter", "classifyTitle defaults to chapter");

// Interludes are anchored to the chapter that existed immediately before
// them, with the counter restarting at 1 for each chapter (ch2.1, ch2.2,
// then ch7.1 …). Epilogues get no special id — they continue the chN.K
// counter of their anchor chapter (the epilogue after ch3 with one
// interlude is ch3.2).
assert.deepStrictEqual(
  assignSegmentIds([
    "Prologue",
    "Chapter 1: Beginning",
    "Interlude 1",
    "Chapter 2: The Forest",
    "Interlude 2",
    "Interlude 3",
    "Chapter 7: The City",
    "Interlude 4",
    "Epilogue",
  ]),
  ["ch0", "ch1", "ch1.1", "ch2", "ch2.1", "ch2.2", "ch3", "ch3.1", "ch3.2"],
  "segment ids: chN.K interludes anchored to the preceding chapter, epilogue as the next chN.K"
);

// An epilogue with no interludes after its chapter is chN.1.
assert.deepStrictEqual(
  assignSegmentIds(["Chapter 1: A", "Epilogue"]),
  ["ch1", "ch1.1"],
  "an epilogue with no prior interludes is ch1.1"
);

// An interlude sitting before any chapter is anchored to ch0.
assert.deepStrictEqual(
  assignSegmentIds(["Interlude 0", "Prologue", "Chapter 1: Beginning"]),
  ["ch0.1", "ch0", "ch1"],
  "an interlude before any chapter is anchored to ch0"
);

// shouldProcessChunked: epub-only, threshold- and flag-driven.
const chunkBundle = { format: "epub", segments: [{ id: "ch1" }, { id: "ch2" }], wholeChars: 5000 };
assert.strictEqual(shouldProcessChunked(chunkBundle, { thresholdChars: 100 }), true, "falls back above the threshold");
assert.strictEqual(shouldProcessChunked(chunkBundle, { thresholdChars: 10000 }), false, "stays whole below the threshold");
assert.strictEqual(shouldProcessChunked(chunkBundle, { thresholdChars: 10000, forceChunked: true }), true, "--chunked forces the fallback");
assert.strictEqual(shouldProcessChunked({ format: "text", segments: [], wholeChars: 999999 }, {}), false, "text sources are never chunked");

// ─── Un-monitored run policies (configs/shared.js) ──────────────────────────
const {
  normalizePolicy,
  validateRequiredEnv,
  ON_VOLUME_ERROR,
  ON_MISSING_PREVIOUS,
  ON_QA_LIMIT,
} = require("../configs/shared");

// normalizePolicy: case/whitespace-insensitive; unknown/empty values fall
// back to the default (a typo in .env must not crash the run).
assert.strictEqual(normalizePolicy("SKIP", ["abort", "skip"], "abort"), "skip");
assert.strictEqual(normalizePolicy(" skip ", ["abort", "skip"], "abort"), "skip");
assert.strictEqual(normalizePolicy("abort", ["abort", "skip"], "skip"), "abort");
assert.strictEqual(normalizePolicy("", ["abort", "skip"], "abort"), "abort");
assert.strictEqual(normalizePolicy(undefined, ["abort", "skip"], "abort"), "abort");
assert.strictEqual(normalizePolicy("nonsense", ["abort", "skip"], "abort"), "abort", "unknown value falls back to the default");
assert.strictEqual(normalizePolicy("Accept", ["accept", "fail"], "fail"), "accept");

// The exported constants reflect the pinned env values (set above the requires).
assert.strictEqual(ON_VOLUME_ERROR, "skip");
assert.strictEqual(ON_MISSING_PREVIOUS, "skip");
assert.strictEqual(ON_QA_LIMIT, "accept");

// validateRequiredEnv: aggregated fail-fast for missing required vars.
process.env.SERIES_LOCATION = "/tmp/series";
process.env.SERIES_NAME = "test_series";
process.env.AI_API_KEY = "test-key";
assert.doesNotThrow(() => validateRequiredEnv(), "all vars set: passes");
assert.doesNotThrow(() => validateRequiredEnv({ dryRun: true }), "dry-run: passes");

delete process.env.AI_API_KEY;
assert.doesNotThrow(() => validateRequiredEnv({ dryRun: true }), "dry-run does not require AI_API_KEY");
assert.throws(() => validateRequiredEnv(), /AI_API_KEY/, "live run requires AI_API_KEY");

delete process.env.SERIES_NAME;
assert.doesNotThrow(
  () => validateRequiredEnv({ dryRun: true }),
  "SERIES_NAME is never required: the intake step decides it and the manifest carries it"
);

// SERIES_LOCATION is not on the list either: unset, it defaults to the repo's own
// epub_source/ folder (configs/env-defaults.js), and validateRequiredEnv applies that
// default as the backstop for a caller that did not come through an entry point.
delete process.env.SERIES_LOCATION;
assert.doesNotThrow(
  () => validateRequiredEnv({ dryRun: true }),
  "SERIES_LOCATION unset: the run defaults to <repo>/epub_source instead of failing"
);
assert.strictEqual(
  process.env.SERIES_LOCATION,
  path.resolve(__dirname, "..", "epub_source"),
  "the default is the repo's epub_source folder, absolute"
);
assert.throws(
  () => validateRequiredEnv(),
  /AI_API_KEY/,
  "the variable that IS required still fails the run, and the message names it"
);

// ─── isSourceStale / sourceFingerprint (configs/shared) ─────────────────────
// Source-staleness detection: a persisted rolling state carries the source
// fingerprint of the run that produced the accepted output. A changed source
// (different fingerprint) invalidates the skip — but every "unknown" side is
// fail-open (legacy state files without a fingerprint keep skipping).
const { isSourceStale } = require("../configs/shared");
assert.strictEqual(isSourceStale({ sourceFingerprint: "a" }, { sourceFingerprint: "a" }), false, "same fingerprint: fresh");
assert.strictEqual(isSourceStale({ sourceFingerprint: "a" }, { sourceFingerprint: "b" }), true, "different fingerprint: stale");
assert.strictEqual(isSourceStale({ sourceFingerprint: "a" }, { sourceFingerprint: undefined }), false, "bundle without fingerprint: fail-open");
assert.strictEqual(isSourceStale({ sourceFingerprint: "a" }, {}), false, "empty bundle: fail-open");
assert.strictEqual(isSourceStale({}, { sourceFingerprint: "x" }), false, "legacy state (no fingerprint): fail-open");
assert.strictEqual(isSourceStale(null, { sourceFingerprint: "x" }), false, "missing state: fail-open");
assert.strictEqual(isSourceStale({ sourceFingerprint: "a" }, null), false, "missing bundle: fail-open");

// ─── glossary coverage (glossary.js, deterministic) ──────────────────────────
const {
  parseGlossaryTableTerms,
  countTermOccurrences,
  buildGlossaryCoverageReportMarkdown,
  emittedToolCallAsText: glossaryEmittedToolCallAsText,
} = require("../glossary");
const coverageGlossary = [
  "# Glossary — Test, Volume 01",
  "## Characters",
  "| Source | Rendering | Type |",
  "|---|---|---|",
  "| ソラ・ハルカ | Sora Haruka | character |",
  "| `魔法学園` | Magic Academy | place |",
  "",
  "## Items",
  "| Item | Rendering | Type |",
  "|---|---|---|",
  "| 魔法学園 | Magic Academy | place |",
].join("\n");
const coverageEntries = parseGlossaryTableTerms(coverageGlossary);
assert.deepStrictEqual(
  coverageEntries.map((e) => [e.term, e.section]),
  [["ソラ・ハルカ", "Characters"], ["魔法学園", "Characters"], ["魔法学園", "Items"]],
  "parseGlossaryTableTerms: first cell per row, section tracked, backticks stripped"
);
assert.deepStrictEqual(parseGlossaryTableTerms(""), []);
assert.deepStrictEqual(parseGlossaryTableTerms("no tables here\n|"), []);
assert.strictEqual(countTermOccurrences("ソラ・ハルカは言った。ソラが笑った。", "ソラ・ハルカ"), 1);
assert.strictEqual(countTermOccurrences("学園学園学園", "学園"), 3);
assert.strictEqual(countTermOccurrences("なにもない", "ソラ・ハルカ"), 0);
assert.strictEqual(countTermOccurrences("x", ""), 0, "empty term: zero occurrences");
const coverageReport = buildGlossaryCoverageReportMarkdown({
  seriesName: "Test",
  installmentNumber: "01",
  entries: coverageEntries,
  sourceText: "ソラ・ハルカは魔法学園に向かう。",
});
assert.ok(coverageReport.includes("# Glossary Coverage — Test, Volume 01"));
assert.ok(coverageReport.includes("| ソラ・ハルカ | Characters | 1 |"));
assert.ok(coverageReport.includes("(none — every glossary term appears in this volume's source)"));
const coverageReportZero = buildGlossaryCoverageReportMarkdown({
  seriesName: "Test",
  installmentNumber: "01",
  entries: coverageEntries,
  sourceText: "なにもない",
});
assert.ok(coverageReportZero.includes("- ソラ・ハルカ (Characters)"));
assert.ok(coverageReportZero.includes("- 魔法学園 (Items)"));
assert.ok(
  buildGlossaryCoverageReportMarkdown({ seriesName: "T", installmentNumber: "01", entries: [], sourceText: "x" }).includes(
    "(no terms parsed from the glossary)"
  ),
  "empty entries: placeholder row"
);

// ─── malformed-tool-call guards (all task modules) ──────────────────────────
// The fail-loudly guard for small malformed tool calls (a local Qwen endpoint
// intermittently emits a few dozen chars of "tool_call" / "<function=…" text
// with zero real tool_calls). Ported to every task module — pin the behavior.
const { emittedToolCallAsText: wikiEmittedToolCallAsText } = require("../jump-in-wiki");
const {
  emittedToolCallAsText: auditEmittedToolCallAsText,
  assertRealToolCalls: auditAssertRealToolCalls,
  buildAuditTurnPrompt,
} = require("../consistency-audit");
for (const [name, fn] of [
  ["glossary", glossaryEmittedToolCallAsText],
  ["wiki", wikiEmittedToolCallAsText],
  ["audit", auditEmittedToolCallAsText],
]) {
  assert.strictEqual(fn({ text: "tool_call <function=readFile>", toolCalls: [] }), true, `${name}: tool_call text with no real calls is flagged`);
  assert.strictEqual(fn({ text: "tool_call", toolCalls: [{ name: "readFile" }] }), false, `${name}: real tool calls are not flagged`);
  assert.strictEqual(fn({ text: "I wrote the file.", toolCalls: [] }), false, `${name}: ordinary reply not flagged`);
  assert.strictEqual(fn(null), false, `${name}: null result not flagged`);
}
assert.throws(
  () => auditAssertRealToolCalls({ text: "<function=readFile>", toolCalls: [] }, "the audit agent"),
  /emitted tool-call syntax as plain text/,
  "assertRealToolCalls throws a diagnostic error"
);
assert.doesNotThrow(() => auditAssertRealToolCalls({ text: "tool_call", toolCalls: [{ name: "x" }] }, "the audit agent"));
assert.strictEqual(
  buildAuditTurnPrompt({ userPrompt: "Series {{SOURCE_NAME}} has {{VOLUME_COUNT}} volumes.", values: { SOURCE_NAME: "Test", VOLUME_COUNT: "17" } }),
  "Series Test has 17 volumes.",
  "buildAuditTurnPrompt fills placeholders"
);
assert.throws(
  () => buildAuditTurnPrompt({ userPrompt: "{{SOURCE_NAME}}", values: { SOURCE_NAME: "" } }),
  /Missing value for placeholder/,
  "buildAuditTurnPrompt is strict (empty value)"
);
assert.throws(
  () => buildAuditTurnPrompt({ userPrompt: "{{SOURCE_NAME}}", values: {} }),
  /Unfilled placeholder left in user prompt/,
  "buildAuditTurnPrompt is strict (unfilled placeholder)"
);

// ─── translation handoff (utils/handoff.js) ──────────────────────────────────
const { buildChaptersJson, renderNewEntry, buildTranslationBriefMarkdown } = require("../utils/handoff");
const handoffBundle = {
  segments: [
    { id: "ch0", file: "t-whole.md", title: "Prologue", chars: 123 },
    { id: "ch1", file: "t-ch1.md", title: "Chapter 1", chars: 456, bodyChars: 440, empty: false },
    { id: "ch1.1", file: "t-ch1.1.md", title: "Interlude", chars: 78, bodyChars: 12, empty: true },
  ],
};
assert.deepStrictEqual(buildChaptersJson(handoffBundle)[2], {
  id: "ch1.1",
  file: "t-ch1.1.md",
  title: "Interlude",
  chars: 78,
  bodyChars: 12,
  empty: true,
  syntheticTitle: false,
});
// A segment the extraction did not measure keeps `bodyChars` unknown (undefined)
// rather than inventing a number, and is never marked empty.
assert.deepStrictEqual(buildChaptersJson(handoffBundle)[0], {
  id: "ch0",
  file: "t-whole.md",
  title: "Prologue",
  chars: 123,
  bodyChars: undefined,
  empty: false,
  syntheticTitle: false,
});
// A title the pipeline invented (a file name, "Section 3") is marked as such:
// the merge prints no heading for it, and the reports must not present it as a
// title the book actually has.
assert.strictEqual(
  buildChaptersJson({ segments: [{ id: "ch2", file: "t-ch2.md", title: "Untitled section 3", chars: 900, syntheticTitle: true }] })[0]
    .syntheticTitle,
  true
);
assert.deepStrictEqual(buildChaptersJson({ segments: [] }), []);
assert.strictEqual(renderNewEntry({ term: "ソラ", type: "character" }), "- ソラ (character)");
assert.strictEqual(renderNewEntry({ type: "voice", character: "ソラ", quirkType: "sentenceEnding", description: "formal" }), "- ソラ — sentenceEnding: formal");
assert.strictEqual(renderNewEntry({ type: "pov", description: "ch3 is first-person" }), "- [pov] ch3 is first-person");
assert.strictEqual(renderNewEntry({ category: "honorific", pattern: "〜さん", description: "keep" }), "- [honorific] 〜さん — keep");
assert.ok(renderNewEntry(null).startsWith("- "));
assert.ok(renderNewEntry({ weird: true }).startsWith("- "));
const brief = buildTranslationBriefMarkdown({
  seriesName: "Test",
  installmentNumber: "01",
  sourceLanguage: "Japanese",
  targetLanguage: "English",
  chapters: buildChaptersJson(handoffBundle),
  newTerms: [{ term: "ソラ", type: "character" }],
  newQuirks: [],
  newStyle: null,
  presentVolumeFiles: ["glossary.md", "wiki.md"],
  presentSeriesFiles: ["glossary.md"],
});
assert.ok(brief.includes("# Translation Brief — Test, Volume 01"));
assert.ok(brief.includes("### New glossary terms (1)"));
assert.ok(
  brief.includes("| ch1.1 | Interlude **(EMPTY IN SOURCE)** | 78 | t-ch1.1.md |"),
  "the brief calls out a chapter that is empty in the source"
);
assert.ok(brief.includes("- **glossary.md**"));
assert.ok(brief.includes("~~pov-map.md~~"), "missing volume artifact: struck through");
assert.ok(brief.includes("~~shared-wiki.md~~"), "missing series artifact: struck through");
assert.ok(
  buildTranslationBriefMarkdown({
    seriesName: "T", installmentNumber: "01", sourceLanguage: "J", targetLanguage: "E",
    chapters: [], newTerms: [], newQuirks: null, newStyle: null,
    presentVolumeFiles: [], presentSeriesFiles: [],
  }).includes("(no persisted extraction data"),
  "all-empty extraction: fallback note"
);

// ─── wiki author turn: canonical glossary reference ──────────────────────────
// When the glossary task has already written the per-volume glossary.md, the
// wiki agent prompts offer it as a read-only reference for the shared wiki's
// Glossary section (drift guard). Absent before the first run.
const wikiWithGlossary = buildWikiAuthorTurnPrompt({ ...wikiCtx, glossaryFile: "glossary.md" });
assert.ok(wikiWithGlossary.includes('The canonical glossary: "glossary.md"'), "wiki author turn names the canonical glossary when present");
assert.ok(!wikiAuthorTurn.includes("The canonical glossary"), "wiki author turn (no glossary yet): no reference line");

// ─── async tail: fingerprint round-trip through the state file ───────────────
(async () => {
  const { saveRollingState, loadRollingState } = require("../configs/shared");
  const fsSync = require("fs");
  const os = require("os");
  const tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "rolling-"));
  const stateFile = path.join(tmpDir, "state.json");
  try {
    await saveRollingState(stateFile, [80, 90, 95], { sourceFingerprint: "abc" });
    const state = await loadRollingState(stateFile);
    assert.deepStrictEqual(state.results, [80, 90, 95]);
    assert.strictEqual(state.sourceFingerprint, "abc", "save/load round-trips the fingerprint");
    assert.strictEqual(isSourceStale(state, { sourceFingerprint: "abc" }), false);
    assert.strictEqual(isSourceStale(state, { sourceFingerprint: "other" }), true);
    // legacy file (no fingerprint) loads and stays fail-open
    const legacyFile = path.join(tmpDir, "legacy.json");
    fsSync.writeFileSync(legacyFile, JSON.stringify({ results: [80, 90, 95] }));
    const legacy = await loadRollingState(legacyFile);
    assert.strictEqual(legacy.sourceFingerprint, undefined);
    assert.strictEqual(isSourceStale(legacy, { sourceFingerprint: "x" }), false);
    // corrupt file: loadRollingState returns null (fail-open)
    const corruptFile = path.join(tmpDir, "corrupt.json");
    fsSync.writeFileSync(corruptFile, "{not json");
    assert.strictEqual(await loadRollingState(corruptFile), null);
  } finally {
    fsSync.rmSync(tmpDir, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

// ─── async tail 2: the seed + carry-forward guard on real files ──────────────
// The two halves of the fix, end to end: the workflow copies the previous
// volume's glossary in verbatim (so the agent amends a file it can read instead
// of reproducing one too big for a reply), and the guard fails the volume when
// terms disappear anyway.
(async () => {
  const fsAsync = require("fs").promises;
  const os = require("os");
  const tmpDir = await fsAsync.mkdtemp(path.join(os.tmpdir(), "carry-forward-"));
  try {
    const prevDir = path.join(tmpDir, "Series(05)");
    const volDir = path.join(tmpDir, "Series(06)");
    await fsAsync.mkdir(prevDir);
    await fsAsync.mkdir(volDir);
    const prevFile = path.join(prevDir, "glossary.md");
    const outFile = path.join(volDir, "glossary.md");
    await fsAsync.writeFile(prevFile, prevGlossary, "utf8");

    const ctx = {
      values: { INSTALLMENT_NUMBER: "06" },
      volumeDir: volDir,
      glossaryOutputFile: outFile,
      previousGlossaryFile: prevFile,
      previousFolderName: "Series(05)",
      isFirst: false,
    };

    // 1. The seed is a verbatim copy — every term survives before any model
    //    touches the file, and the index is built from it.
    assert.strictEqual(await seedGlossaryFromPrevious(ctx), true, "seed reports it seeded");
    assert.strictEqual(await fsAsync.readFile(outFile, "utf8"), prevGlossary, "the seed is a byte-for-byte copy");
    assert.strictEqual(ctx.glossarySeeded, true);
    assert.ok(ctx.glossaryIndex.includes("A → Alpha"), "the seed builds the term index the amend pass needs");

    // 2. A half-written glossary from a previous failed run is RESET to the
    //    previous volume's clean baseline — that is what "carry forward" means,
    //    and it is how a damaged volume 04 stops poisoning volume 05.
    await fsAsync.writeFile(outFile, "# Glossary\n\n## Characters\n| Src | Tgt |\n|---|---|\n| A | Alpha |\n", "utf8");
    await seedGlossaryFromPrevious(ctx);
    assert.strictEqual(await fsAsync.readFile(outFile, "utf8"), prevGlossary, "a partial glossary is reset to the baseline");

    // 3. The guard passes when the amended file still holds everything.
    await fsAsync.writeFile(outFile, grown, "utf8");
    await assertGlossaryCarryForward(ctx, "the amend pass");

    // 4. The guard FAILS the volume when terms disappeared — the volume 05 → 06
    //    case (769 terms in, 411 out) that no other check in the stage can see.
    await fsAsync.writeFile(outFile, shrunk, "utf8");
    await assert.rejects(
      () => assertGlossaryCarryForward(ctx, "the amend pass"),
      /dropped 2 of the 3 term\(s\)/,
      "a glossary that lost terms fails the volume instead of shipping"
    );

    // 5. And the damaged document is moved ASIDE, which is what makes the next
    //    volume skip instead of translating against a glossary missing 45% of
    //    its terms. A failed cumulative volume normally stops the next one
    //    because its artifact is MISSING — a present-but-short one is the case
    //    the ON_MISSING_PREVIOUS cascade cannot see.
    assert.strictEqual(await fsAsync.stat(outFile).then(() => true, () => false), false, "the damaged glossary is no longer where the next volume would read it");
    const quarantined = await fsAsync.readFile(`${outFile}.rejected`, "utf8");
    assert.strictEqual(quarantined, shrunk, "the damaged document survives as the evidence");

    // 6. The guard is a knob (GLOSSARY_CARRY_FORWARD_GUARD=false), and the first
    //    volume has nothing to carry.
    await fsAsync.copyFile(`${outFile}.rejected`, outFile);
    process.env.GLOSSARY_CARRY_FORWARD_GUARD = "false";
    await assertGlossaryCarryForward(ctx, "the amend pass");
    assert.strictEqual(await fsAsync.readFile(outFile, "utf8"), shrunk, "guard off: the file is left where it is");
    delete process.env.GLOSSARY_CARRY_FORWARD_GUARD;
    await assertGlossaryCarryForward({ ...ctx, isFirst: true, previousGlossaryFile: null }, "the amend pass");
    assert.strictEqual(await seedGlossaryFromPrevious({ ...ctx, isFirst: true, previousGlossaryFile: null }), false, "first volume: nothing to seed");
  } finally {
    await fsAsync.rm(tmpDir, { recursive: true, force: true });
  }
  await chunkedGlossaryFlowTest();
  await chunkedGlossaryFirstVolumeTest();
  console.log("All tests passed.");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

// ─── the chunked (chapter-by-chapter) glossary flow ──────────────────────────
// The seed, the per-chapter carry-forward guard and the findings-merge step cap
// all live in the chapter-by-chapter path, and a whole-installment fixture never
// reaches it. The harness is stubbed (the mode wiring is what is under test, not
// the provider); the files, the QA loop and the guards are the real ones.
async function chunkedGlossaryFlowTest() {
  const fsAsync = require("fs").promises;
  const os = require("os");
  const harness = require("../harness");
  const { runChunkedVolumeAgent } = require("../glossary");

  const tmpDir = await fsAsync.mkdtemp(path.join(os.tmpdir(), "chunked-glossary-"));
  const prevDir = path.join(tmpDir, "Series(05)");
  const volDir = path.join(tmpDir, "Series(06)");
  const outFile = path.join(volDir, "glossary.md");

  // Save and restore the harness methods the flow reaches for, so the suites
  // that run after this one get the real ones back.
  const real = {
    createGatedFsTools: harness.createGatedFsTools,
    createWikiTools: harness.createWikiTools,
    createAgentHandle: harness.createAgentHandle,
    runOneShot: harness.runOneShot,
  };
  const restore = () => Object.assign(harness, real);

  const VALIDATION_REPORT =
    "# Glossary validation — Series, volume 06\n\n" +
    "The glossary covers the chapter sources. No HIGH findings.\n\n" +
    "FINDING [LOW] chapters=ch1 — one Notes cell is longer than a gloss.\n";

  try {
    await fsAsync.mkdir(prevDir);
    await fsAsync.mkdir(volDir);
    await fsAsync.writeFile(path.join(prevDir, "glossary.md"), prevGlossary, "utf8");
    const segments = [
      { id: "ch1", file: "book-ch1.md", title: "第一章", bodyChars: 100 },
      { id: "ch2", file: "book-ch2.md", title: "第二章", bodyChars: 100 },
    ];
    for (const s of segments) {
      await fsAsync.writeFile(path.join(volDir, s.file), `${s.title}\n\n本文。\n`, "utf8");
    }

    const ctx = {
      values: { INSTALLMENT_NUMBER: "06", SOURCE_NAME: "Series", SOURCE_LANGUAGE: "Japanese", TARGET_LANGUAGE: "English" },
      folderName: "Series(06)",
      volumeDir: volDir,
      sourceFile: path.join(volDir, segments[0].file),
      glossaryOutputFile: outFile,
      researchNotesFile: path.join(volDir, "glossary-research.md"),
      validationOutputFile: path.join(volDir, "glossary-validation.md"),
      isFirst: false,
      previousGlossaryFile: path.join(prevDir, "glossary.md"),
      previousFolderName: "Series(05)",
      chunked: true,
      bundle: { format: "epub", segments, wholeChars: 200, wholePath: path.join(volDir, segments[0].file) },
      termsPrompt: "Extract the new terms.",
      termsSystemPrompt: "You extract terms.",
      glossarySystemPrompt: "You maintain the glossary.",
      validatorSystemPrompt: "You audit the glossary.",
      glossaryTemplate: "Amend the glossary for {{SOURCE_NAME}}.\n{{TERMS_LIST}}\n{{RESEARCH_NOTES}}\n{{DISPUTES}}",
      feedbackPrompt: "Apply the findings.",
      disputesText: "",
    };

    // The scripted agents: validators write their chapter's partial, the merger
    // consolidates it, the author agents leave the seeded glossary alone (which
    // is exactly what the new instruction asks them to do).
    let amendCalls = 0;
    let shrinkOnAmendCall = 0;
    harness.createGatedFsTools = async () => ({ tools: {}, approve: async () => true });
    harness.createWikiTools = () => ({});
    harness.runOneShot = async ({ label }) =>
      label.startsWith("glossary-terms")
        ? "[]" // no new terms: keeps the research agents out of a wiring test
        : '{"score": 80, "band": "Pass with minor edits", "note": "Carries the previous terms."}';
    harness.createAgentHandle = async ({ name }) => ({
      name,
      sendTurn: async () => {
        if (name.startsWith("validator-merge-")) {
          await fsAsync.writeFile(path.join(volDir, "glossary-validation.md"), VALIDATION_REPORT, "utf8");
        } else if (name.startsWith("validator-")) {
          const id = name.split("-").pop();
          await fsAsync.writeFile(path.join(volDir, `glossary-validation-${id}.md`), VALIDATION_REPORT, "utf8");
        } else if (name.startsWith("author-")) {
          amendCalls++;
          // The failure the guard exists for: a chapter pass that rewrites the
          // glossary from memory instead of editing it.
          if (amendCalls === shrinkOnAmendCall) {
            await fsAsync.writeFile(outFile, shrunk, "utf8");
          }
        }
        return { text: "", toolCalls: [{ toolCallId: "1", toolName: "readFile", input: {} }] };
      },
      close: async () => {},
    });

    // 1. The happy path: the volume's glossary starts from the previous volume's
    //    copy, every chapter amends it, and the QA loop accepts it.
    await runChunkedVolumeAgent(ctx);
    assert.ok(
      (await fsAsync.readFile(outFile, "utf8")).includes("| A | Alpha |"),
      "chunked: the volume's glossary carries the previous volume's terms verbatim"
    );
    assert.ok(amendCalls >= 2, "chunked: every chapter got its own amend pass");
    assert.ok(
      await fsAsync.stat(path.join(volDir, "glossary-validation-ch1.md")).then(() => true, () => false),
      "chunked: the per-chapter validation partials were written"
    );
    // This file pins ACCEPTANCE_MIN_SAMPLES=3 while the window holds 2, so the
    // loop runs its whole iteration budget — which means every per-chapter
    // FEEDBACK pass also ran, each one guarded. The glossary still holds all
    // three carried-forward terms after all of them.
    assert.deepStrictEqual(
      compareGlossaryCarryForward(prevGlossary, await fsAsync.readFile(outFile, "utf8")).missing,
      [],
      "chunked: the per-chapter feedback passes did not shrink the glossary"
    );

    // 2. A chapter pass that shrinks the glossary is caught AT THAT CHAPTER —
    //    not eight chapters and one acceptance loop later.
    amendCalls = 0;
    shrinkOnAmendCall = 2; // the second chapter's amend pass
    await fsAsync.writeFile(outFile, prevGlossary, "utf8");
    await assert.rejects(
      () => runChunkedVolumeAgent(ctx),
      /the amend pass for chapter ch2 dropped 2 of the 3 term\(s\)/,
      "chunked: the guard names the chapter that broke the glossary"
    );
    assert.strictEqual(await fsAsync.stat(outFile).then(() => true, () => false), false, "chunked: the damaged glossary is moved out of the next volume's way");
    assert.ok(
      await fsAsync.stat(`${outFile}.rejected`).then(() => true, () => false),
      "chunked: the damaged document survives as the evidence"
    );
  } finally {
    restore();
    await fsAsync.rm(tmpDir, { recursive: true, force: true });
  }
}

// ─── the chunked glossary flow on the FIRST volume ─────────────────────────────
// The write instruction used to be decided by "did the workflow copy the previous volume's glossary
// in?", and on volume 01 there is nothing to copy — so every chapter, including the last, was told to
// write the whole document with writeFile. See utils/fs/current-artifact.js and the character-voice
// case in test-chunked-preproduction.js that this mirrors.
async function chunkedGlossaryFirstVolumeTest() {
  const fsAsync = require("fs").promises;
  const os = require("os");
  const harness = require("../harness");
  const { runChunkedVolumeAgent } = require("../glossary");

  const tmpDir = await fsAsync.mkdtemp(path.join(os.tmpdir(), "chunked-glossary-first-"));
  const volDir = path.join(tmpDir, "Series(01)");
  const outFile = path.join(volDir, "glossary.md");
  const VALIDATION_REPORT =
    "# Glossary validation — Series, volume 01\n\n" +
    "The glossary covers the chapter sources. No HIGH findings.\n\n" +
    "FINDING [LOW] chapters=ch1 — one Notes cell is longer than a gloss.\n";
  const firstDraft =
    "## Characters\n| Src | Tgt | Notes |\n|---|---|---|\n| A | Alpha | first volume, chapter 1 |\n";
  const addedRow = "| B | Beta | first volume, chapter 2 |\n";

  const real = {
    createGatedFsTools: harness.createGatedFsTools,
    createWikiTools: harness.createWikiTools,
    createAgentHandle: harness.createAgentHandle,
    runOneShot: harness.runOneShot,
  };

  try {
    await fsAsync.mkdir(volDir);
    const segments = [
      { id: "ch1", file: "book-ch1.md", title: "第一章", bodyChars: 100 },
      { id: "ch2", file: "book-ch2.md", title: "第二章", bodyChars: 100 },
    ];
    for (const s of segments) {
      await fsAsync.writeFile(path.join(volDir, s.file), `${s.title}\n\n本文。\n`, "utf8");
    }

    const ctx = {
      values: { INSTALLMENT_NUMBER: "01", SOURCE_NAME: "Series", SOURCE_LANGUAGE: "Japanese", TARGET_LANGUAGE: "English" },
      folderName: "Series(01)",
      volumeDir: volDir,
      sourceFile: path.join(volDir, segments[0].file),
      glossaryOutputFile: outFile,
      researchNotesFile: path.join(volDir, "glossary-research.md"),
      validationOutputFile: path.join(volDir, "glossary-validation.md"),
      isFirst: true,
      previousGlossaryFile: null,
      previousFolderName: null,
      chunked: true,
      bundle: { format: "epub", segments, wholeChars: 200, wholePath: path.join(volDir, segments[0].file) },
      termsPrompt: "Extract the new terms.",
      termsSystemPrompt: "You extract terms.",
      glossarySystemPrompt: "You maintain the glossary.",
      validatorSystemPrompt: "You audit the glossary.",
      glossaryTemplate: "Amend the glossary for {{SOURCE_NAME}}.\n{{TERMS_LIST}}\n{{RESEARCH_NOTES}}\n{{DISPUTES}}",
      feedbackPrompt: "Apply the findings.",
      disputesText: "",
    };

    /** The per-chapter amend passes' prompts, in reading order. */
    const amendPrompts = [];
    harness.createGatedFsTools = async () => ({ tools: {}, approve: async () => true });
    harness.createWikiTools = () => ({});
    harness.runOneShot = async ({ label }) =>
      label.startsWith("glossary-terms")
        ? "[]"
        : '{"score": 80, "band": "Pass with minor edits", "note": "Carries the previous terms."}';
    harness.createAgentHandle = async ({ name }) => ({
      name,
      sendTurn: async (prompt) => {
        if (/^author-01-ch\d+$/.test(name)) {
          amendPrompts.push(prompt);
          // The agent does what it is told: chapter 1 creates the file, chapter 2 adds a row to the
          // one that is already there.
          const prior = await fsAsync.readFile(outFile, "utf8").catch(() => null);
          await fsAsync.writeFile(outFile, prior === null ? firstDraft : prior + addedRow, "utf8");
        } else if (name.startsWith("validator-merge-")) {
          await fsAsync.writeFile(path.join(volDir, "glossary-validation.md"), VALIDATION_REPORT, "utf8");
        } else if (name.startsWith("validator-")) {
          const id = name.split("-").pop();
          await fsAsync.writeFile(path.join(volDir, `glossary-validation-${id}.md`), VALIDATION_REPORT, "utf8");
        } else if (name.startsWith("feedback-author-")) {
          await fsAsync.writeFile(outFile, await fsAsync.readFile(outFile, "utf8"), "utf8");
        }
        return { text: "", toolCalls: [{ toolCallId: "1", toolName: "readFile", input: {} }] };
      },
      close: async () => {},
    });

    await runChunkedVolumeAgent(ctx);

    assert.strictEqual(amendPrompts.length, segments.length, "chunked volume 01: every chapter got its own amend pass");
    assert.ok(
      amendPrompts[0].includes("does not exist yet"),
      `chunked volume 01: chapter 1 is told to create glossary.md: ${amendPrompts[0].slice(0, 400)}`
    );
    assert.ok(
      !amendPrompts[0].includes("ALREADY holds the"),
      "chunked volume 01: chapter 1 is not told to amend a glossary that does not exist"
    );
    assert.ok(
      !amendPrompts[0].includes('What "glossary.md" already holds'),
      "chunked volume 01: chapter 1 is not handed a map of a glossary that does not exist"
    );
    assert.ok(
      amendPrompts[1].includes("ALREADY holds the"),
      `chunked volume 01: chapter 2 is told to amend glossary.md in place: ${amendPrompts[1].slice(0, 400)}`
    );
    assert.ok(
      !amendPrompts[1].includes("does not exist yet"),
      "chunked volume 01: chapter 2 is not told to write a glossary that is already there whole"
    );
    assert.ok(
      amendPrompts[1].includes('What "glossary.md" already holds') && amendPrompts[1].includes("A → Alpha"),
      `chunked volume 01: chapter 2 is handed the map of what chapter 1 wrote: ${amendPrompts[1].slice(0, 400)}`
    );

    const written = await fsAsync.readFile(outFile, "utf8");
    assert.ok(written.includes("| A | Alpha |"), "chunked volume 01: chapter 1's term survived chapter 2");
    assert.ok(written.includes("| B | Beta |"), "chunked volume 01: chapter 2's term is in the glossary");
  } finally {
    Object.assign(harness, real);
    await fsAsync.rm(tmpDir, { recursive: true, force: true });
  }
}
