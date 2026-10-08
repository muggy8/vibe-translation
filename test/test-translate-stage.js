/**
 * test-translate-stage.js — the `translate` task, run for real, against the
 * stub model server.
 *
 * Until now the `translate` task had NO offline test: `--dry-run` stops before
 * the live branch (gotcha 49) and the pure-helper suite never calls the task.
 * The one thing that actually turns a book into a draft — the per-chapter
 * one-shot, its prompt budget, its continuity tail, its deterministic QA, its
 * state file, its merge, and the task's end-of-run completeness gate — was only
 * ever exercised by an expensive live run.
 *
 * These scenarios run the REAL task (real manifest resolution, real source
 * bundle, real prompt assembly, real token calibration probe, real provider,
 * real streaming, real files on disk) against `test/fake-backend.js`. The model
 * is a scripted HTTP endpoint; everything else is production code.
 *
 * Scenarios (each in its own process — translate.js reads SERIES_LOCATION at
 * module load):
 *   happy      the whole task end to end, and what the model was actually asked
 *   idempotent a second run makes ZERO model calls
 *   truncated  a reply cut off at the output cap fails the chapter, not the book
 *   echo       a draft that is still source-script is kept and marked for repair
 *   dead       a dead endpoint fails with the SERVER's message
 *
 * Plain `assert`, no framework. Run standalone: `node test/test-translate-stage.js`.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const childScenario = (process.argv.find((a) => a.startsWith("--child=")) || "").replace("--child=", "");

// ─── Offline pins (before any module reads them) ─────────────────────────────
process.env.AI_API_KEY = "fake-key";
process.env.AI_RETRY = "0";
process.env.AI_CONTEXT_WINDOW = "32000";
// Pinned with the window: `AI_MAX_TOKENS` overrides the derived cap, and a cap
// larger than the window this suite pins leaves the agent no room for its prompt
// (the harness compacts before the first turn). An empty value blocks `.env`
// without disabling the derivation. See test-fake-backend.js.
process.env.AI_MAX_TOKENS = "";
process.env.AI_THINKING = "false";
process.env.AI_CALL_DEADLINE_MS = "0";
process.env.TRANSLATION_SOURCE_LANGUAGE = "Japanese";
process.env.TRANSLATION_TARGET_LANGUAGE = "English";
// Keep the machine's real calibration cache out of the test (the task probes
// the stub, which is the point — it just must not write to the repo's file).
process.env.TOKEN_CALIBRATION_FILE = path.join(os.tmpdir(), `ai-client-calibration-${process.pid}.json`);
if (!childScenario) {
  // The parent only spawns children; the un-monitored policies are pinned per
  // child so each scenario states what it is testing.
}

const { startFakeBackend } = require("./fake-backend");

// ─── The fixture ─────────────────────────────────────────────────────────────

/**
 * The fixture's source text, and the English the stub model answers with.
 * The pair is fixed so the deterministic QA (residue, length band, glossary
 * coverage) runs against a draft with known properties — the same idea as
 * test/calibration/, but driving the whole task instead of one grader call.
 */
const SOURCE_TEXT = `# 第一章

朝、教室の窓から柔らかい光が差し込んでいた。
「またお前か」と雪乃は言った。
私は答えなかった。答えられることが、そこにはなかった。
放課後、屋上で風が吹いた。雪乃は遠くを見ていた。
「名前を呼んで」と、彼女は静かに言った。
私は雪乃の名前を呼んだ。それだけで、十分だった。

翌日、彼女はいつもと同じ場所に立っていた。
同じ制服、同じ鞄、同じ視線。
ただ、私を見る角度だけが違っていた。
「昨日のこと」と彼女は言った。「あれはあれだ」と私は言った。
それ以上の会話は、二人の間には必要なかった。
夕方の廊下は長く、靴音だけが響いた。
雪乃は振り返らなかった。私も同じだった。

週末、彼女は駅前の広場で待っていた。
人混みの中で、彼女の声は小さかった。
「もう少し長く生きていて」と彼女は言った。
私はうなずいた。うなずく以外にできることがなかった。
風が吹いて、彼女の髪が動いた。
それだけのことが、その日には重要だった。

春休み前日、彼女は教室に残っていた。
黒板には消えかけの文字が残り、窓は開いたままだった。
「これからもここで待つ」と彼女は言った。
私はその言葉を、そのまま覚えておくことにした。

新しい学期、新しい教室。
雪乃は同じ場所に立っていた。
私は同じ歩き方で、そこへ向かった。
`;

/** A faithful rendering: no source script left, glossary renderings present. */
const TRANSLATED_TEXT = `In the morning, soft light came through the classroom window.

"You again," Yukino said.

I did not answer. There was nothing there that I could answer.

After class, the wind blew on the rooftop. Yukino was looking into the distance.

"Say my name," she said quietly.

I said Yukino's name. That alone was enough.

The next day she was standing in the same place as always.

The same uniform, the same bag, the same gaze.

Only the angle at which she looked at me was different.

"About yesterday," she said. "That was that," I said.

No further conversation was necessary between the two of us.

The corridor in the evening was long, and only the sound of our shoes echoed in it.

Yukino did not turn around. Neither did I.

At the weekend she was waiting in the square in front of the station.

In the crowd her voice was small.

"Stay alive a little longer," she said.

I nodded. There was nothing else I could do but nod.

The wind blew and her hair moved.

That small thing was what mattered on that day.

The day before spring break, she was still in the classroom.

Half-erased writing was left on the blackboard, and the window was still open.

"I will keep waiting here," she said.

I decided to keep those words exactly as they were.

A new term, a new classroom.

Yukino was standing in the same place.

I walked toward it the same way I always did.`;

/** The stub answering with the SOURCE instead of a translation (a real failure
 * mode of a translation model: it echoes what it was given). */
const ECHOED_TEXT = SOURCE_TEXT;

const GLOSSARY_MD = `# Glossary

| Source | Rendering | Notes |
| --- | --- | --- |
| 雪乃 | Yukino | main cast |
| 屋上 | rooftop | recurring setting |
`;

/**
 * Build a temp series the translate task can run on: two volumes, each with a
 * staged plain-text source and a glossary, plus the PASS consistency sign-off
 * the stage's entry gate demands.
 *
 * @returns {{seriesDir: string, manifest: Object}}
 */
function makeSeries() {
  const seriesDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-client-translate-"));
  const volumes = [];
  for (const installment of ["01", "02"]) {
    const folder = `Book(${installment})`;
    const volumeDir = path.join(seriesDir, folder);
    fs.mkdirSync(volumeDir, { recursive: true });
    fs.writeFileSync(path.join(volumeDir, `${folder}.md`), SOURCE_TEXT, "utf8");
    fs.writeFileSync(path.join(volumeDir, "glossary.md"), GLOSSARY_MD, "utf8");
    volumes.push({
      folder,
      sourceFile: `${folder}/${folder}.md`,
      installmentNumber: installment,
      title: folder,
      integrity: { isNarrative: true, confidence: 0.9, basis: "test fixture" },
    });
  }
  // The pre-translation sign-off (consistency-audit's deliverable). The gate
  // reads the verdict line, so this is the real gate, not a bypass.
  fs.writeFileSync(
    path.join(seriesDir, "consistency-report.md"),
    "# Consistency Report\n\n**PASS**\n\nNo findings.\n",
    "utf8"
  );
  return {
    seriesDir,
    manifest: {
      schema: 2,
      seriesName: "Book",
      seriesLocation: seriesDir,
      sourceLanguage: "Japanese",
      targetLanguage: "English",
      discovery: { summary: "fixture", confidence: 0.9, evidence: [], excluded: [] },
      volumes,
    },
  };
}

/**
 * Stand the stub up and wire it into the real role-endpoint config.
 *
 * @param {(req: import("./fake-backend").FakeRequest) => Object} reply
 * @returns {Promise<Object>} { backend, cleanup }
 */
async function wireStub(reply) {
  const backend = await startFakeBackend({
    model: ["stub", "stub-translate"],
    reply,
  });
  backend.pointEnvAt({ prefixes: ["TRANSLATE"] });
  return backend;
}

/**
 * Hand the task a plan of record without running the intake agent. Patched on
 * the module object BEFORE translate.js is required, because it destructures
 * `getTranslationTarget` at load time.
 *
 * @param {Object} manifest
 */
function stubIntake(manifest) {
  const gtt = require("../get-translation-target");
  gtt.getTranslationTarget = async () => manifest;
}

// ─── Scenario: the whole task, end to end ────────────────────────────────────

async function scenarioHappyPath() {
  const { seriesDir, manifest } = makeSeries();
  process.env.SERIES_LOCATION = seriesDir;
  process.env.SERIES_ARTIFACTS_DIR = seriesDir;
  stubIntake(manifest);

  const backend = await wireStub(() => ({ text: TRANSLATED_TEXT }));
  const { translate } = require("../translate");
  await translate();

  // 1. The drafts exist and hold the model's answer.
  const vol1 = path.join(seriesDir, "Book(01)");
  const draft = fs.readFileSync(path.join(vol1, "translation-whole.md"), "utf8");
  assert.ok(draft.includes("Yukino's name"), `the draft holds the translated text: ${draft.slice(0, 80)}`);
  assert.ok(fs.existsSync(path.join(seriesDir, "Book(02)", "translation-whole.md")), "volume 02 was translated too");

  // 2. The merged volume, the QA report, the state file, the series report.
  const merged = fs.readFileSync(path.join(vol1, "translation.md"), "utf8");
  assert.ok(merged.includes("soft light came through the classroom window"), "translation.md carries the chapter");
  assert.ok(fs.existsSync(path.join(vol1, "translation-qa.md")), "the per-volume QA report was written");
  assert.ok(fs.existsSync(path.join(vol1, "translation-state.json")), "the per-chapter state was persisted");
  assert.ok(
    fs.existsSync(path.join(seriesDir, "translation-report.md")),
    "the series-level report was rebuilt at the end of the task"
  );

  const state = JSON.parse(fs.readFileSync(path.join(vol1, "translation-state.json"), "utf8"));
  const entry = state.chapters.whole;
  assert.ok(entry, `the chapter entry exists (keys: ${Object.keys(state.chapters).join(", ")})`);
  assert.strictEqual(entry.qaFailed, false, "the draft passed the deterministic QA");
  assert.ok(entry.sourceHash && entry.draftHash && entry.contextHash, "the idempotency keys are recorded");

  // 3. The model was asked the right thing — the real prompt assembly ran.
  const translateCalls = backend.requests.filter((r) => r.maxTokens !== 1);
  assert.strictEqual(translateCalls.length, 2, `one call per volume (got ${translateCalls.length})`);
  const firstPrompt = translateCalls[0].userText;
  assert.ok(firstPrompt.includes("雪乃"), "the prompt carries the source text");
  assert.ok(firstPrompt.includes("Yukino"), "and the glossary's canonical rendering (terminology law)");
  assert.ok(firstPrompt.includes("rooftop"), "including every term the chapter actually uses");
  assert.ok(
    !translateCalls[0].messages.some((m) => m.role === "system"),
    "the translate stage sends no system message (the Index-Translate instTrans contract)"
  );
  assert.deepStrictEqual(
    translateCalls[0].chatTemplateKwargs,
    { enable_thinking: false },
    "and it runs in the model's fast mode — this template's only thinking switch"
  );
  assert.strictEqual(translateCalls[0].reasoningEffort, null, "and it never sends reasoning_effort, which this template ignores");
  assert.ok(firstPrompt.includes("【源文】"), "the prompt uses the instTrans 【源文】 block");
  assert.strictEqual(translateCalls[0].temperature, 0, "the translator decodes greedily, as the model's own client does");

  // 4. Cross-volume continuity: volume 02's first chapter sees volume 01's ending.
  const secondPrompt = translateCalls[1].userText;
  assert.ok(
    /the same way I always did/.test(secondPrompt),
    `volume 02's prompt carries the previous volume's published ending: ${secondPrompt.slice(0, 400)}`
  );
  assert.ok(
    !/soft light came through the classroom window/.test(secondPrompt),
    "and only the ending, not the whole of the previous volume"
  );

  // 5. The token calibration probe really ran against this endpoint (once per
  // volume's stage pass), and it cost the server one generated token.
  const probes = backend.requests.filter((r) => r.maxTokens === 1);
  assert.ok(probes.length >= 1, `the stage calibrated its token estimate against the endpoint (${probes.length} probe(s))`);
  assert.ok(
    probes.every((p) => !p.messages.some((m) => m.role === "system")),
    "a probe measures the sample alone — no system prompt"
  );

  fs.rmSync(seriesDir, { recursive: true, force: true });
  fs.rmSync(process.env.TOKEN_CALIBRATION_FILE, { force: true });
  await backend.close();
}

// ─── Scenario: a re-run spends nothing ───────────────────────────────────────

async function scenarioIdempotentReRun() {
  const { seriesDir, manifest } = makeSeries();
  process.env.SERIES_LOCATION = seriesDir;
  process.env.SERIES_ARTIFACTS_DIR = seriesDir;
  stubIntake(manifest);

  const backend = await wireStub(() => ({ text: TRANSLATED_TEXT }));
  const { translate } = require("../translate");

  await translate();
  const firstRunCalls = backend.requests.length;
  assert.ok(firstRunCalls > 0, "the first run made model calls");

  backend.reset();
  await translate();

  const modelCalls = backend.requests.filter((r) => r.maxTokens !== 1);
  assert.strictEqual(
    modelCalls.length,
    0,
    `a re-run over unchanged source + references makes NO translation calls (made ${modelCalls.length})`
  );

  // …and the book is still there (the merge re-runs even when every chapter skips).
  assert.ok(
    fs.readFileSync(path.join(seriesDir, "Book(01)", "translation.md"), "utf8").includes("Yukino"),
    "the merged volume survived the skipped run"
  );

  fs.rmSync(seriesDir, { recursive: true, force: true });
  fs.rmSync(process.env.TOKEN_CALIBRATION_FILE, { force: true });
  await backend.close();
}

// ─── Scenario: a truncated reply fails the chapter, not the book ─────────────

async function scenarioTruncatedReply() {
  const { seriesDir, manifest } = makeSeries();
  process.env.SERIES_LOCATION = seriesDir;
  process.env.SERIES_ARTIFACTS_DIR = seriesDir;
  process.env.ON_VOLUME_ERROR = "skip";
  stubIntake(manifest);

  let translationCalls = 0;
  const backend = await wireStub((req) => {
    // The stage calibrates its token estimate first (one generated token); that
    // probe is not one of the chapter calls the scenario is scripting.
    if (req.maxTokens === 1) return { text: "x" };
    if (translationCalls++ === 0) return { text: TRANSLATED_TEXT }; // volume 01 is fine
    return { text: TRANSLATED_TEXT.slice(0, 40), finishReason: "length" }; // volume 02 is cut off
  });
  const { translate } = require("../translate");

  let err = null;
  try {
    await translate();
  } catch (e) {
    err = e;
  }
  assert.ok(err, "a volume whose chapter produced no usable draft fails the task");
  assert.ok(
    /INCOMPLETE|FAILED/.test(err.message),
    `and the failure names the incomplete volume: ${err.message}`
  );

  // The truncated answer was NEVER written as a draft (a half chapter would
  // otherwise pass every later check and become the published book).
  const vol2 = path.join(seriesDir, "Book(02)");
  const draftFile = path.join(vol2, "translation-whole.md");
  assert.ok(
    !fs.existsSync(draftFile) || !fs.readFileSync(draftFile, "utf8").includes(TRANSLATED_TEXT.slice(0, 40)),
    "the truncated reply was not persisted as the volume's draft"
  );

  // The healthy volume still shipped: one bad chapter does not stop the series.
  assert.ok(
    fs.existsSync(path.join(seriesDir, "Book(01)", "translation-whole.md")),
    "the volume that answered properly was still translated"
  );

  fs.rmSync(seriesDir, { recursive: true, force: true });
  fs.rmSync(process.env.TOKEN_CALIBRATION_FILE, { force: true });
  await backend.close();
}

// ─── Scenario: a draft that is still the source is kept, not thrown away ─────

async function scenarioEchoedSource() {
  const { seriesDir, manifest } = makeSeries();
  process.env.SERIES_LOCATION = seriesDir;
  process.env.SERIES_ARTIFACTS_DIR = seriesDir;
  process.env.ON_VOLUME_ERROR = "skip";
  stubIntake(manifest);

  const backend = await wireStub(() => ({ text: ECHOED_TEXT }));
  const { translate } = require("../translate");

  let err = null;
  try {
    await translate();
  } catch (e) {
    err = e;
  }
  assert.ok(err, "a chapter whose draft failed the deterministic QA fails the run");

  const vol1 = path.join(seriesDir, "Book(01)");
  const draft = fs.readFileSync(path.join(vol1, "translation-whole.md"), "utf8");
  assert.ok(draft.includes("雪乃"), "the bad draft is KEPT (gotcha 39: retranslate needs something to repair)");
  assert.ok(fs.existsSync(path.join(vol1, "translation-whole.rejected.md")), "and the rejected attempt is quarantined");

  const state = JSON.parse(fs.readFileSync(path.join(vol1, "translation-state.json"), "utf8"));
  const entry = state.chapters.whole;
  assert.strictEqual(entry.qaFailed, true, "the state records it as a QA failure");
  const findings = Array.isArray(entry.qaFindings) ? entry.qaFindings.join("\n") : String(entry.qaFindings || "");
  assert.ok(findings.length > 0, `the state records the findings the QA loop must fix: ${findings}`);
  assert.ok(
    /residue/i.test(findings),
    `and the finding names the residue, so retranslate knows what to correct: ${findings}`
  );

  // The published volume says so out loud rather than shipping it clean.
  const merged = fs.readFileSync(path.join(vol1, "translation.md"), "utf8");
  assert.ok(/UNVERIFIED/i.test(merged), "the publish gate marks the chapter UNVERIFIED");

  fs.rmSync(seriesDir, { recursive: true, force: true });
  fs.rmSync(process.env.TOKEN_CALIBRATION_FILE, { force: true });
  await backend.close();
}

// ─── Scenario: a dead endpoint reports the endpoint, not "no content" ────────

async function scenarioDeadEndpoint() {
  const { seriesDir, manifest } = makeSeries();
  process.env.SERIES_LOCATION = seriesDir;
  process.env.SERIES_ARTIFACTS_DIR = seriesDir;
  process.env.ON_VOLUME_ERROR = "skip";
  stubIntake(manifest);

  const backend = await wireStub(() => ({ status: 500, error: "model container is not running" }));
  const { translate } = require("../translate");

  // The chapter-level failure is reported per chapter (the task keeps going and
  // fails at its completeness gate), so what has to carry the server's message
  // is the log line the task prints.
  const lines = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...a) => lines.push(a.join(" "));
  console.error = (...a) => lines.push(a.join(" "));
  let err = null;
  try {
    await translate();
  } catch (e) {
    err = e;
  } finally {
    console.log = realLog;
    console.error = realError;
  }
  const log = lines.join("\n");
  assert.ok(err, "a dead endpoint fails the task");
  assert.ok(
    /container is not running/.test(log),
    `the run log carries the SERVER's own message, not a vague "no content": ${log.slice(-600)}`
  );
  assert.ok(
    !/returned no content/.test(log),
    'and it is not reported as "The model returned no content" (that wording blames the model for a container problem)'
  );

  fs.rmSync(seriesDir, { recursive: true, force: true });
  fs.rmSync(process.env.TOKEN_CALIBRATION_FILE, { force: true });
  await backend.close();
}

// ─── Entry points ────────────────────────────────────────────────────────────

const CHILD_SCENARIOS = {
  happy: scenarioHappyPath,
  idempotent: scenarioIdempotentReRun,
  truncated: scenarioTruncatedReply,
  echo: scenarioEchoedSource,
  dead: scenarioDeadEndpoint,
};

if (childScenario) {
  const run = CHILD_SCENARIOS[childScenario];
  if (!run) {
    console.error(`CHILD-FAIL: unknown scenario --child=${childScenario}`);
    process.exit(1);
  }
  run()
    .then(() => console.log("CHILD-OK"))
    .catch((e) => {
      console.error("CHILD-FAIL:", (e && e.stack) || e);
      process.exit(1);
    });
} else {
  console.log("test-translate-stage.js — the real translate task against the stub endpoint");
  for (const name of Object.keys(CHILD_SCENARIOS)) {
    let out = "";
    try {
      out = execFileSync(process.execPath, [__filename, `--child=${name}`], { encoding: "utf8", timeout: 240000 });
    } catch (e) {
      console.error(`\nFAIL in scenario "${name}":\n${(e && e.stdout) || ""}${(e && e.stderr) || e}`);
      process.exit(1);
    }
    assert.ok(out.includes("CHILD-OK"), `scenario ${name} did not report success`);
    console.log(`  ok - ${name}`);
  }
  console.log(`\ntest-translate-stage.js: ${Object.keys(CHILD_SCENARIOS).length} scenarios passed.`);
}
