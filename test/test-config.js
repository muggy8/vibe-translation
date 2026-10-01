/**
 * test-config.js — self-checks for the consolidated environment knobs.
 *
 * The env surface was cut down to one variable per decision. These tests pin
 * both halves of that promise:
 *   - the new name works, and
 *   - the OLD name still works (an existing .env must not silently change
 *     behavior when the pipeline upgrades underneath it).
 *
 * Constants that are read at module load (configs/shared.js) are exercised in a
 * spawned process with a pinned environment — the same pattern as
 * test-glossary-load.js. Helpers that read the environment when called
 * (utils/translate.js) are exercised directly.
 *
 * Run with `npm test`.
 */
const assert = require("assert");
const path = require("path");
const { execFileSync } = require("child_process");

const sharedConfigPath = path.resolve(__dirname, "..", "configs", "shared.js");

/**
 * Evaluate a configs/shared.js export in a child process with a pinned env.
 *
 * @param {string} exportName - The export to read (e.g. "PASSING_SCORE").
 * @param {Record<string, string>} env - Env values to set for the child.
 * @returns {string} The child's stdout (trimmed).
 */
function sharedExportIn(exportName, env) {
  const script =
    `const c = require(${JSON.stringify(sharedConfigPath)});` +
    `console.log(String(c.${exportName}));`;
  return execFileSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  }).trim();
}

/** Env values meaning "unset" for the child (empty string → parseInt NaN → default). */
const UNSET = {
  PASSING_SCORE: "",
  ACCEPTANCE_PASSING_SCORE: "",
  VERIFY_PASSING_SCORE: "",
  POLISH_VERIFY_PASSING_SCORE: "",
  ACCEPTANCE_WINDOW_SIZE: "",
  ACCEPTANCE_MIN_SAMPLES: "",
  SERIES_ARTIFACTS_DIR: "",
  GLOSSARY_OUTPUT_FILE: "",
  VOICE_OUTPUT_FILE: "",
  STYLE_OUTPUT_FILE: "",
  SHARED_WIKI_OUTPUT_FILE: "",
};

// ─── PASSING_SCORE (one threshold for every scored gate) ─────────────────────

assert.strictEqual(
  sharedExportIn("PASSING_SCORE", { ...UNSET, PASSING_SCORE: "" }),
  "70",
  "default 70 (the rubric boundary between 'Pass with minor edits' and 'Requires revision')"
);
assert.strictEqual(
  sharedExportIn("PASSING_SCORE", { ...UNSET, PASSING_SCORE: "69" }),
  "69",
  "PASSING_SCORE is the knob"
);
assert.strictEqual(
  sharedExportIn("PASSING_SCORE", { ...UNSET, ACCEPTANCE_PASSING_SCORE: "80" }),
  "80",
  "the old ACCEPTANCE_PASSING_SCORE still works"
);
assert.strictEqual(
  sharedExportIn("PASSING_SCORE", { ...UNSET, VERIFY_PASSING_SCORE: "75" }),
  "75",
  "the old VERIFY_PASSING_SCORE still works"
);
assert.strictEqual(
  sharedExportIn("PASSING_SCORE", { ...UNSET, PASSING_SCORE: "69", ACCEPTANCE_PASSING_SCORE: "80" }),
  "69",
  "the new name wins over the old one"
);
assert.strictEqual(
  sharedExportIn("PASSING_SCORE", { ...UNSET, PASSING_SCORE: "250" }),
  "100",
  "clamped to the 0-100 rubric"
);
assert.strictEqual(
  sharedExportIn("ACCEPTANCE_PASSING_SCORE", { ...UNSET, PASSING_SCORE: "69" }),
  "69",
  "the acceptance constant and the shared threshold are the same number"
);

// ─── ACCEPTANCE_MIN_SAMPLES (derived from the window, not a knob) ────────────

assert.strictEqual(
  sharedExportIn("ACCEPTANCE_MIN_SAMPLES", { ...UNSET, ACCEPTANCE_WINDOW_SIZE: "" }),
  "2",
  "default window (2) -> 2 samples"
);
assert.strictEqual(
  sharedExportIn("ACCEPTANCE_MIN_SAMPLES", { ...UNSET, ACCEPTANCE_WINDOW_SIZE: "5" }),
  "2",
  "a wider window still needs two fresh passes"
);
assert.strictEqual(
  sharedExportIn("ACCEPTANCE_MIN_SAMPLES", { ...UNSET, ACCEPTANCE_WINDOW_SIZE: "1" }),
  "2",
  "the window is floored at 2, so the derived sample count is too"
);
{
  // The footgun the separate variable allowed: a window of 2 asking for 3
  // samples makes acceptance impossible (the window can never hold 3).
  const ok = execFileSync(process.execPath, ["-e",
    `const { meetsAcceptanceCriteria } = require(${JSON.stringify(sharedConfigPath)});` +
    `console.log(String(meetsAcceptanceCriteria([100, 100])));`,
  ], { encoding: "utf8", env: { ...process.env, ...UNSET, ACCEPTANCE_WINDOW_SIZE: "2" } }).trim();
  assert.strictEqual(ok, "true", "a full 2-score window can accept — no impossible combination");
}
assert.strictEqual(
  sharedExportIn("ACCEPTANCE_MIN_SAMPLES", { ...UNSET, ACCEPTANCE_MIN_SAMPLES: "3" }),
  "3",
  "the old name still overrides"
);

// ─── ACCEPTANCE_SAMPLE_FLOOR (a bad sample cannot be averaged away) ──────────

{
  // The hole this closes: with a passing score of 69 and a window of 2, the
  // average of [100, 38] is 69 — so a document one grader put in the rubric's
  // "Reject" band was accepted because a second grader loved it.
  const verdicts = execFileSync(process.execPath, ["-e",
    `const { meetsAcceptanceCriteria } = require(${JSON.stringify(sharedConfigPath)});` +
    `console.log(JSON.stringify([` +
    `meetsAcceptanceCriteria([100, 38]), meetsAcceptanceCriteria([100, 40]), ` +
    `meetsAcceptanceCriteria([72, 71]), meetsAcceptanceCriteria([100, 100])]));`,
  ], { encoding: "utf8", env: { ...process.env, ...UNSET, PASSING_SCORE: "69", ACCEPTANCE_WINDOW_SIZE: "2" } }).trim();
  assert.strictEqual(
    verdicts,
    JSON.stringify([false, false, true, true]),
    "a sample in the rubric's Reject band blocks acceptance; a genuinely passing window still accepts"
  );

  assert.strictEqual(
    sharedExportIn("ACCEPTANCE_SAMPLE_FLOOR", { ...UNSET, PASSING_SCORE: "69" }),
    "54",
    "default floor: the passing score minus 15 (the bottom of the 'Pass with minor edits' band)"
  );
  assert.strictEqual(
    sharedExportIn("ACCEPTANCE_SAMPLE_FLOOR", { ...UNSET, ACCEPTANCE_SAMPLE_FLOOR: "0" }),
    "0",
    "0 restores pure averaging"
  );

  const averaged = execFileSync(process.execPath, ["-e",
    `const { meetsAcceptanceCriteria } = require(${JSON.stringify(sharedConfigPath)});` +
    `console.log(String(meetsAcceptanceCriteria([100, 38])));`,
  ], { encoding: "utf8", env: { ...process.env, ...UNSET, PASSING_SCORE: "69", ACCEPTANCE_SAMPLE_FLOOR: "0" } }).trim();
  assert.strictEqual(averaged, "true", "with the floor disabled the old averaging behavior is back");
}

// ─── seriesArtifactFile (one directory knob for the four root copies) ─────────

{
  const { seriesArtifactFile } = require("../configs/shared");
  const root = "/series";

  delete process.env.SERIES_ARTIFACTS_DIR;
  delete process.env.GLOSSARY_OUTPUT_FILE;
  assert.strictEqual(
    seriesArtifactFile("glossary.md", "GLOSSARY_OUTPUT_FILE", root),
    path.join(root, "glossary.md"),
    "default: the series root"
  );

  process.env.SERIES_ARTIFACTS_DIR = "/series/artifacts";
  assert.strictEqual(
    seriesArtifactFile("glossary.md", "GLOSSARY_OUTPUT_FILE", root),
    path.join("/series/artifacts", "glossary.md"),
    "SERIES_ARTIFACTS_DIR redirects every root copy"
  );
  assert.strictEqual(
    seriesArtifactFile("shared-wiki.md", "SHARED_WIKI_OUTPUT_FILE", root),
    path.join("/series/artifacts", "shared-wiki.md"),
    "the same knob covers the wiki copy"
  );

  process.env.GLOSSARY_OUTPUT_FILE = "/elsewhere/glossary.md";
  assert.strictEqual(
    seriesArtifactFile("glossary.md", "GLOSSARY_OUTPUT_FILE", root),
    "/elsewhere/glossary.md",
    "the old per-file name still wins (an existing .env keeps its exact paths)"
  );
  delete process.env.SERIES_ARTIFACTS_DIR;
  delete process.env.GLOSSARY_OUTPUT_FILE;
}

// ─── stageConcurrency (STAGE_CONCURRENCY) ────────────────────────────────────

{
  const { stageConcurrency } = require("../utils/translate");

  delete process.env.STAGE_CONCURRENCY;
  delete process.env.VERIFY_CONCURRENCY;
  assert.strictEqual(stageConcurrency("VERIFY"), 1, "default: serial");

  process.env.STAGE_CONCURRENCY = "4";
  assert.strictEqual(stageConcurrency("VERIFY"), 4, "STAGE_CONCURRENCY covers every stage");
  assert.strictEqual(stageConcurrency("POLISH"), 4, "…including polish");
  assert.strictEqual(stageConcurrency("AUDIT"), 4, "…and the audit batches");

  process.env.POLISH_CONCURRENCY = "2";
  assert.strictEqual(stageConcurrency("POLISH"), 2, "the old per-stage name still overrides");
  assert.strictEqual(stageConcurrency("VERIFY"), 4, "…only for its own stage");

  process.env.STAGE_CONCURRENCY = "0";
  assert.strictEqual(stageConcurrency("VERIFY"), 1, "floored at 1");
  process.env.STAGE_CONCURRENCY = "abc";
  assert.strictEqual(stageConcurrency("VERIFY"), 1, "invalid -> default");

  delete process.env.STAGE_CONCURRENCY;
  delete process.env.POLISH_CONCURRENCY;
}

// ─── judgeTemperature / stageThinking / writerTemperature ────────────────────

{
  const { judgeTemperature, stageThinking, writerTemperature } = require("../utils/translate");
  const clean = {
    JUDGE_TEMPERATURE: undefined,
    VERIFY_TEMPERATURE: undefined,
    AUDIT_TEMPERATURE: undefined,
    STAGE_THINKING_LEVEL: undefined,
    AI_THINKING: undefined,
    AI_THINKING_LEVEL: undefined,
    VERIFY_THINKING: undefined,
    VERIFY_THINKING_LEVEL: undefined,
    EDIT_THINKING: undefined,
    EDIT_THINKING_LEVEL: undefined,
    AUDIT_THINKING: undefined,
    AUDIT_THINKING_LEVEL: undefined,
    EDIT_TEMPERATURE: undefined,
    AI_TEMPERATURE: undefined,
  };
  const saved = {};
  for (const key of Object.keys(clean)) {
    saved[key] = process.env[key];
    if (clean[key] === undefined) delete process.env[key];
  }

  assert.strictEqual(judgeTemperature(), 0.2, "grading defaults to a stable 0.2");
  process.env.JUDGE_TEMPERATURE = "0.4";
  assert.strictEqual(judgeTemperature(), 0.4, "JUDGE_TEMPERATURE is the knob");
  delete process.env.JUDGE_TEMPERATURE;
  process.env.VERIFY_TEMPERATURE = "0.3";
  assert.strictEqual(judgeTemperature(), 0.3, "the old VERIFY_TEMPERATURE still works");
  delete process.env.VERIFY_TEMPERATURE;

  assert.deepStrictEqual(
    stageThinking("VERIFY"),
    { thinking: true, thinkingLevel: "medium" },
    "judges think by default, at medium (less than the authoring agents' xhigh)"
  );
  process.env.AI_THINKING = "false";
  assert.strictEqual(stageThinking("VERIFY").thinking, false, "AI_THINKING=false turns it off");
  delete process.env.AI_THINKING;
  process.env.STAGE_THINKING_LEVEL = "low";
  assert.strictEqual(stageThinking("AUDIT").thinkingLevel, "low", "STAGE_THINKING_LEVEL covers the stages");
  process.env.AUDIT_THINKING_LEVEL = "high";
  assert.strictEqual(stageThinking("AUDIT").thinkingLevel, "high", "the old per-stage name still overrides");
  assert.strictEqual(stageThinking("EDIT").thinkingLevel, "low", "…only for its own stage");
  delete process.env.STAGE_THINKING_LEVEL;
  delete process.env.AUDIT_THINKING_LEVEL;

  process.env.AI_TEMPERATURE = "0.6";
  assert.strictEqual(writerTemperature("EDIT", 0.6), 0.6, "a writer follows the house temperature");
  process.env.EDIT_TEMPERATURE = "0.8";
  assert.strictEqual(writerTemperature("EDIT", 0.6), 0.8, "the stage's own knob wins");
  delete process.env.EDIT_TEMPERATURE;
  delete process.env.AI_TEMPERATURE;
  assert.strictEqual(writerTemperature("EDIT", 0.6), 0.6, "fallback when neither is set");

  for (const [key, value] of Object.entries(saved)) {
    if (value !== undefined) process.env[key] = value;
  }
}

// ─── AI_CONTEXT_WINDOW + the derived output cap (harness) ────────────────────

{
  const { envContextWindow, envMaxTokens } = require("../harness");
  const saved = {
    AI_CONTEXT_WINDOW: process.env.AI_CONTEXT_WINDOW,
    AGENT_CONTEXT_WINDOW: process.env.AGENT_CONTEXT_WINDOW,
    AI_MAX_TOKENS: process.env.AI_MAX_TOKENS,
  };
  delete process.env.AI_CONTEXT_WINDOW;
  delete process.env.AGENT_CONTEXT_WINDOW;
  delete process.env.AI_MAX_TOKENS;

  assert.strictEqual(envContextWindow(), 128000, "default context");
  assert.strictEqual(envMaxTokens(), 32000, "output cap derived from the context (a quarter of it)");

  process.env.AI_CONTEXT_WINDOW = "262144";
  assert.strictEqual(envContextWindow(), 262144, "AI_CONTEXT_WINDOW is the knob");
  assert.strictEqual(envMaxTokens(), 65536, "…and it sizes the output cap too");
  assert.ok(
    envMaxTokens() < envContextWindow(),
    "the derived cap always leaves room for the prompt (the failure this replaces: max_tokens == context, rejected before the call started)"
  );

  process.env.AGENT_CONTEXT_WINDOW = "32768";
  assert.strictEqual(envContextWindow(), 262144, "the new name wins over the legacy one");
  delete process.env.AI_CONTEXT_WINDOW;
  assert.strictEqual(envContextWindow(), 32768, "the legacy AGENT_CONTEXT_WINDOW still works");

  process.env.AI_MAX_TOKENS = "8192";
  assert.strictEqual(envMaxTokens(), 8192, "AI_MAX_TOKENS still overrides the derived value");

  for (const [key, value] of Object.entries(saved)) {
    if (value !== undefined) process.env[key] = value;
  }
}

console.log("config: all checks passed.");
