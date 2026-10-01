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
const { parseAcceptanceReply } = require("../utils/prompt");
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
// A section truncated away entirely loses its heading (no empty section shown).
assert.ok(!truncated.includes("## Characters"), "truncateGlossary: a fully truncated section loses its heading");
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
  assert.strictEqual(relevantRows, 200, "the entry cap is still respected");
  assert.ok(
    relevant.includes("whose source term occurs in the text being translated (3 such row(s)"),
    "the note says WHY these rows were chosen"
  );

  // Without a source text the old newest-window behavior is kept (and the note
  // says so rather than pretending the selection was relevance-based).
  const legacy = truncateGlossary(withCast);
  assert.ok(!legacy.includes("| ソラ | Sora | protagonist |"), "no source text → the old document-order window");
  assert.ok(legacy.includes("Showing the 200 in document order"), "the note is honest about which rule ran");
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

delete process.env.SERIES_LOCATION;
assert.throws(
  () => validateRequiredEnv({ dryRun: true }),
  /SERIES_LOCATION/,
  "SERIES_LOCATION is always required"
);
assert.throws(
  () => validateRequiredEnv(),
  /SERIES_LOCATION.*AI_API_KEY/,
  "the message aggregates every missing variable"
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
});
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
  console.log("All tests passed.");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
