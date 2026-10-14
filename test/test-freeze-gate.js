#!/usr/bin/env node
/**
 * test/test-freeze-gate.js — the gate that stops a step rewriting what a published translation
 * was already built from.
 *
 * `test/test-prerequisite-gate.js` pins the half of the account owner's rule that says a step may not
 * START before its foundation is finished. This file pins the other half, which that gate cannot ask:
 * once a volume's translation is published, the glossary, voice reference, style guide, wiki, audit and
 * extracted text that translation was made from are **frozen** — and a resumed run is no exception.
 * Measured against the code before 2026-10-13: `utils/series-run/skip.js`'s first line was
 * `if (force || regeneratedAny) return false;`, and nothing downstream asked whether anything had
 * already consumed what it was about to rebuild. Rewrite volume 5's glossary after volumes 1–8 are
 * translated, resume, and the run printed "already accepted, skipping" for eight translations built
 * from a glossary that no longer existed.
 *
 * What is checked, and from which door:
 *   1. the door table — every door declared with what it rewrites and why it is covered, the table
 *      frozen against reassignment, and the four manual doors mapped to the stage whose artifact they
 *      threaten;
 *   2. "frozen" is read off the `translate` declaration, not a second list — and a volume holding only
 *      HALF of `translate`'s required output is not frozen;
 *   3. `npx gulp glossary --force` refuses on a translated series, through the real gulp door, with a
 *      STRUCTURAL error, and names the volume, what it would rewrite, why, and the door past it;
 *   4. a plain `npx gulp glossary` on the same series is NOT refused — the skip stands and the freeze
 *      is never asked;
 *   5. `extract` on a warm cache is allowed and `npx gulp extract --force` is refused, because the
 *      prerequisite gate runs `extract` before every step and a freeze that blocked it outright would
 *      make a resumed run unable to run anything at all;
 *   6. the state-shaped cancellations — a changed source fingerprint, a failing acceptance grade, the
 *      cumulative cascade — are refused by the same gate inside the volume loop, which reuses the skip
 *      decision rather than re-deriving it;
 *   7. `missing-output` is the ONE cancellation that is not a rewrite: filling a hole in a
 *      half-translated volume is allowed, and refusing it would make an inconsistent series unrepairable;
 *   8. `--volume` narrows the question — a frozen volume 01 does not block a legal volume-02 run;
 *   9. `--dry-run` reports and does not refuse, the same rule the prerequisite gate keeps;
 *  10. there is no quiet switch: `--force`, `--allow-fail`, `ON_TASK_ERROR=continue`,
 *      `ON_VOLUME_ERROR=skip`, a ledger that already recorded this step failing, and every environment
 *      variable this repository defines are checked — none is an input to the question, and no setting
 *      in `configs/` names a freeze knob;
 *  11. the recorded release is the only way past: a reason under the floor is refused, an unknown door
 *      is refused, a release is per door, it touches NO translation file (byte-identical before and
 *      after), it is standing rather than consumed, and after it the same refused act is allowed;
 *  12. the four manual doors refuse — and `rebuild-voice` WITHOUT `--apply` (a rehearsal into a copy)
 *      stays allowed, because freezing the rehearsal would remove the only cheap way to look at a
 *      renderer change before publishing it;
 *  13. a legal resumed `translate` is unblocked: `translate` is not a door, `consistency-audit` skips
 *      while its provenance still fingerprints the four artifacts, and the prerequisite gate still
 *      says the series is complete;
 *  14. a standing release is visible in the resume triage and in the delivery report — a state a
 *      machine knows and a person cannot read is how a run gets reported as fine;
 *  15. the table is inside `BANNED_PATCH_PATHS`, the door past it is banned too, and this file is
 *      inside `constraint-tests`.
 *
 * Fixtures only, under `/tmp/opencode/series-fixtures`. Nothing here reads the real 17 volumes or any
 * file under the series folder, and nothing here reaches a model: `AI_API_KEY` is blank and
 * `AI_BASE_URL` points at a closed port, so a call that was not supposed to happen fails instead of
 * succeeding. `AI_CLIENT_HOOKS_DIR` points at an empty folder so no test can switch a model container
 * (gotcha 22).
 *
 * Plain `assert`, no framework, CommonJS — like the rest of the project.
 */

require("./test-home"); // the run's records get a throwaway home (gotcha 69)
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const fx = require("./fixture-series");
const { readModuleLayer } = require("./module-layer");
const fz = require("../utils/prereqs/freeze");
const prereqs = require("../utils/prereqs");
const { specForStep } = require("../utils/artifacts");
const { isStructuralError } = require("../configs/shared");
const { patchPathIsBanned } = require("../utils/patches");
const resume = require("../utils/resume");
const rs = require("../utils/reference-store");

const FIXTURES = path.resolve("/tmp/opencode/series-fixtures", "freeze-gate");
const EMPTY_HOOKS = path.join(FIXTURES, "empty-hooks");
/** A port nothing listens on: a model call that should not happen fails instead of succeeding. */
const DEAD_ENDPOINT = "http://127.0.0.1:1/v1";

/** The four root commands that are not gulp tasks, so no wrapper can reach them. */
const MANUAL_DOORS = ["rebuild-voice", "extract-voice", "reopen-volume", "attribute-voice"];

let checks = 0;
/**
 * Count one assertion and run it.
 * @param {boolean|void} condition
 * @param {string} message
 */
function ok(condition, message) {
  checks++;
  assert.ok(condition, message);
}
/**
 * @param {unknown} a
 * @param {unknown} b
 * @param {string} message
 */
function same(a, b, message) {
  checks++;
  assert.deepStrictEqual(a, b, message);
}

/**
 * Point this process at one fixture series: its books, its records, its (empty) hooks, and an endpoint
 * that cannot answer.
 * @param {string} label
 * @param {boolean} [complete] - Lay out every step's declared output (which publishes a translation in
 *   both volumes, i.e. freezes them), or only the plan of record.
 * @returns {Promise<{dir: string, ledgerDir: string, volumes: Array<{folder: string, installmentNumber: string}>}>}
 */
async function series(label, complete = true) {
  const built = complete ? await fx.completeSeries(label, FIXTURES) : await fx.fixtureSeries(label, FIXTURES);
  process.env.SERIES_LOCATION = built.dir;
  process.env.AI_CLIENT_HOOKS_DIR = EMPTY_HOOKS;
  process.env.AI_API_KEY = "";
  process.env.AI_BASE_URL = DEAD_ENDPOINT;
  process.env.INDEX_RUN_ID = `freeze-${label}`;
  return built;
}

/**
 * Run one command in a child process and hand back its exit code and merged output.
 * @param {string[]} args - Arguments to `process.execPath`.
 * @param {Object} [env] - Extra environment for the child.
 * @returns {Promise<{code: number|null, output: string}>}
 */
function runChild(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: {
        ...process.env,
        AI_CLIENT_HOOKS_DIR: EMPTY_HOOKS,
        AI_API_KEY: "",
        AI_BASE_URL: DEAD_ENDPOINT,
        ...env,
      },
    });
    let output = "";
    child.stdout.on("data", (c) => (output += c.toString()));
    child.stderr.on("data", (c) => (output += c.toString()));
    child.on("close", (code) => resolve({ code, output }));
  });
}

/**
 * Run one gulp step in a child process.
 * @param {string} step
 * @param {string[]} [flags]
 * @param {Object} [env]
 */
function runGulp(step, flags = [], env = {}) {
  return runChild([path.join(ROOT, "node_modules", "gulp", "bin", "gulp.js"), step, ...flags], env);
}

/**
 * Snapshot every byte of every translation file in a fixture, so a release can be proved to have
 * touched none of them.
 * @param {string} seriesDir
 * @param {Array<{folder: string, installmentNumber: string}>} volumes
 * @returns {Promise<Object<string, string>>} `folder/name` → sha256
 */
async function translationChecksums(seriesDir, volumes) {
  const crypto = require("crypto");
  const out = {};
  for (const v of volumes) {
    for (const name of fz.requiredTranslationArtifacts(v.installmentNumber)) {
      const file = path.join(seriesDir, v.folder, name);
      try {
        out[`${v.folder}/${name}`] = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      } catch {
        out[`${v.folder}/${name}`] = "ABSENT";
      }
    }
  }
  return out;
}

/**
 * Write a rolling-state file the way the QA loop writes it, so the skip-check can be made to cancel
 * for a specific reason.
 * @param {string} file
 * @param {Object} state
 * @returns {Promise<void>}
 */
async function writeRollingState(file, state) {
  await fs.promises.writeFile(file, JSON.stringify(state, null, 2) + "\n", "utf8");
}

const scenarios = [];
/**
 * Register one scenario.
 * @param {string} name
 * @param {Function} fn
 */
function scenario(name, fn) {
  scenarios.push({ name, fn });
}

// ─── 1. The door table ────────────────────────────────────────────────────────

scenario("the door table names what each door rewrites, and why it is covered", async () => {
  const doors = fz.frozenDoors();
  ok(doors.length >= 11, `the gate covers the five pre-production steps, discover, extract and the four manual doors: ${doors.join(", ")}`);
  for (const name of doors) {
    const row = fz.freezeDoorRow(name);
    ok(row.door === name, `${name}: the row names its own door`);
    ok(["volume", "series"].includes(row.scope), `${name}: scope is volume or series, got ${row.scope}`);
    ok(row.writes.length > 20, `${name}: a refusal has to say what would be rewritten`);
    ok(row.because.length > 30, `${name}: a door nobody can explain is a door somebody will remove`);
    ok(typeof row.missingIsRepair === "boolean", `${name}: whether an absent artifact is a hole to fill is declared, not assumed`);
  }
  // The two doors whose output is not a declared per-volume file are NOT excused by a missing file:
  // what they rewrite is the extracted text and the plan of record.
  same([fz.freezeDoorRow("extract").missingIsRepair, fz.freezeDoorRow("discover").missingIsRepair], [false, false],
    "extract and discover are not excused by an absent artifact — neither declares a per-volume file to stand in for the act");
  for (const step of ["glossary", "character-voice", "style-guide", "jump-in-wiki", "consistency-audit"]) {
    ok(fz.freezeDoorRow(step).missingIsRepair === true, `${step} fills a hole rather than overwriting, when its own artifact is not there`);
  }
  // The manual doors threaten a gulp step's artifact, so a release naming that stage covers them.
  for (const door of MANUAL_DOORS) {
    ok(fz.DOOR_OWNER[door] === "character-voice", `${door} is judged against the character-voice stage's artifact`);
  }
  // A table any importing module can reassign is a dial (AGENTS.md §4 rule 3).
  fz.FREEZE_DOORS.glossary = undefined;
  delete fz.FREEZE_DOORS.glossary;
  ok(Boolean(fz.freezeDoorRow("glossary")), "the door table is frozen: an importing module cannot drop a door from it");
  ok(fz.freezeDoorRow("translate") === null, "translate is not a door — the gate freezes what it was built FROM, not the translation itself");
  ok(fz.freezeDoorRow("polish") === null && fz.freezeDoorRow("verify-translate") === null, "the translation stage's own steps are not doors");
});

// ─── 2. "Frozen" is read off the declaration ──────────────────────────────────

scenario("a volume is frozen by the translate step's own declaration, not a second list", async () => {
  const built = await series("frozen-read");
  const declared = specForStep("translate")
    .volume.filter((e) => e.level === "required")
    .map((e) => e.name.replace("{installment}", "01"));
  same(fz.requiredTranslationArtifacts("01"), declared, "the frozen test asks the translate declaration, so a second list of one artifact never appears (gotcha 141)");

  const both = await fz.readFrozenState({ volumeDir: path.join(built.dir, built.volumes[0].folder), installment: "01" });
  ok(both.frozen, "a volume holding both required translation outputs is frozen");
  ok(both.artifacts.length === 2 && both.artifacts.every((a) => a.bytes > 0), `and the refusal can name what is at stake with real sizes: ${JSON.stringify(both.artifacts)}`);

  // Half a translation is not a translation.
  const half = path.join(FIXTURES, "frozen-half");
  await fs.promises.rm(half, { recursive: true, force: true });
  await fs.promises.cp(path.join(built.dir, built.volumes[0].folder), half, { recursive: true });
  await fs.promises.rm(path.join(half, "translation-state.json"), { force: true });
  const notYet = await fz.readFrozenState({ volumeDir: half, installment: "01" });
  ok(!notYet.frozen, "a volume with translation.md but no translation-state.json is NOT frozen — the declaration is the whole test");

  const scope = await fz.readFreezeScope({ seriesDir: built.dir });
  same(scope.volumes.map((v) => v.frozen), [true, true], "both fixture volumes read as frozen");
});

// ─── 3. `glossary --force` refuses, through the real gulp door ────────────────

scenario("npx gulp glossary --force refuses on a translated series, and the refusal is structural", async () => {
  const built = await series("glossary-force");
  const before = await translationChecksums(built.dir, built.volumes);
  const glossaryBefore = fs.readFileSync(path.join(built.dir, built.volumes[0].folder, "glossary.md"), "utf8");

  const res = await runGulp("glossary", ["--force"]);
  ok(res.code !== 0, `the step refuses (exit ${res.code}): ${res.output.slice(0, 400)}`);
  ok(/refuses to rewrite/.test(res.output), `the refusal says what it is refusing: ${res.output.slice(0, 500)}`);
  ok(/volume 01/.test(res.output) && /volume 02/.test(res.output), "it names every frozen volume, not a count");
  ok(/glossary\.md/.test(res.output), "it names the artifact it would rewrite");
  ok(/translation\.md/.test(res.output), "it names the translation that was built on it");
  ok(/--force` was given/.test(res.output), "it names the act that would have done it, not just 'frozen'");
  ok(/release-translation\.js/.test(res.output), "it names the only door past it");
  ok(res.output.includes("no override"), "it says plainly that there is no override");

  // The refusal is STRUCTURAL, so ON_TASK_ERROR=continue and ON_VOLUME_ERROR=skip cannot walk past it.
  const markerFile = path.join(built.ledgerDir, "last-structural-failure.json");
  ok(fs.existsSync(markerFile), "the structural marker was written, so index.js can tell this from a transient failure");
  const marker = JSON.parse(fs.readFileSync(markerFile, "utf8"));
  ok(marker.step === "glossary", `the marker names the step: ${JSON.stringify(marker)}`);
  ok(isStructuralError(fz.freezeRefusal(marker.message)), "and the refusal this gate throws is the structural kind, in the process that throws it");

  same(await translationChecksums(built.dir, built.volumes), before, "a refusal touches no translation");
  ok(fs.readFileSync(path.join(built.dir, built.volumes[0].folder, "glossary.md"), "utf8") === glossaryBefore, "and it touches the artifact it refused to rewrite either");
});

// ─── 4. A plain run is not refused ────────────────────────────────────────────

scenario("a plain npx gulp glossary on the same series is not refused — the skip stands", async () => {
  const built = await series("glossary-plain");
  const res = await runGulp("glossary");
  ok(!/refuses to rewrite/.test(res.output), `the freeze gate did not fire on a run that rewrites nothing: ${res.output.slice(0, 600)}`);
  ok(!/last-structural-failure/.test(fs.readdirSync(built.ledgerDir).join(",")),
    `and no structural refusal was recorded: ${fs.readdirSync(built.ledgerDir).join(", ")}`);
  ok(fs.existsSync(path.join(built.dir, built.volumes[0].folder, "glossary.md")), "the finished glossary is still there");

  // The gate is not even asked when the skip stands: `evaluateFreeze` is only reached by an act that
  // would rewrite, and a plain run's act is a skip. Proved in-process, through the same door the four
  // cumulative stages use.
  const verdict = await fz.evaluateFreeze({ door: "glossary", seriesDir: built.dir, cancelledBy: "skip" });
  ok(verdict.ok, "an uncancelling skip is not a rewrite, so it is not a refusal");

  const v = built.volumes[0];
  const volDir = path.join(built.dir, v.folder);
  await writeRollingState(path.join(volDir, "glossary-validation-rolling-state.json"), {
    results: [80, 85], acceptedBy: "rolling-window", sourceFingerprint: "same",
  });
  const skipped = await require("../utils/series-run/skip").volumeAlreadyAccepted({
    installmentNumber: v.installmentNumber,
    outputFiles: [path.join(volDir, "glossary.md")],
    validationOutputFile: path.join(volDir, "glossary-validation.md"),
    bundle: { sourceFingerprint: "same" },
    force: false,
    regeneratedAny: false,
    artifactLabel: "glossary",
    step: "glossary",
    seriesDir: built.dir,
    folder: v.folder,
    dryRun: false,
  });
  ok(skipped === true, "the volume is skipped, and the freeze gate was never asked about it");
});

// ─── 5. extract: warm cache allowed, --force refused ──────────────────────────

scenario("extract verifies a frozen volume's text for free, and refuses to re-extract it", async () => {
  const built = await series("extract-warm");
  const before = await translationChecksums(built.dir, built.volumes);

  // The prerequisite gate runs `extract` before EVERY step. A freeze that blocked it outright would
  // make a resumed run sitting in the translation stage unable to run anything at all.
  const warm = await fz.evaluateFreeze({ door: "extract", seriesDir: built.dir, cancelledBy: "skip" });
  ok(warm.ok, "a warm-cache extract VERIFIES the text and rewrites nothing, so it is allowed on a frozen series");

  const cold = await fz.evaluateFreeze({ door: "extract", seriesDir: built.dir, cancelledBy: "source-changed" });
  ok(!cold.ok && cold.frozen.length === 2, "a re-extraction of a frozen volume's text is a rewrite, and it is named");
  ok(cold.bullets[0].includes("source book changed"), `and it says which: ${cold.bullets[0]}`);

  const res = await runGulp("extract", ["--force"]);
  ok(res.code !== 0, `npx gulp extract --force refuses (exit ${res.code}): ${res.output.slice(0, 400)}`);
  ok(/refuses to rewrite/.test(res.output), `and says why: ${res.output.slice(0, 500)}`);
  same(await translationChecksums(built.dir, built.volumes), before, "the refusal wrote nothing into the series");
});

// ─── 6. The state-shaped cancellations, inside the volume loop ────────────────

scenario("a changed source, a failed grade and the cascade are refused where the loop decides them", async () => {
  const built = await series("loop-cancels");
  const v = built.volumes[0];
  const volDir = path.join(built.dir, v.folder);
  const rolling = path.join(volDir, "glossary-validation-rolling-state.json");
  const validation = path.join(volDir, "glossary-validation.md");

  const ask = (over) =>
    require("../utils/series-run/skip").volumeAlreadyAccepted({
      installmentNumber: v.installmentNumber,
      outputFiles: [path.join(volDir, "glossary.md")],
      validationOutputFile: validation,
      bundle: over.bundle || { sourceFingerprint: "same" },
      force: over.force || false,
      regeneratedAny: over.regeneratedAny || false,
      cascadeFrom: over.cascadeFrom || null,
      artifactLabel: "glossary",
      step: "glossary",
      seriesDir: built.dir,
      folder: v.folder,
      dryRun: false,
    });

  // The skip stands: accepted window, matching fingerprint. Nothing is asked, nothing is refused.
  await writeRollingState(rolling, { results: [80, 85], acceptedBy: "rolling-window", sourceFingerprint: "same" });
  ok(await ask({}) === true, "an accepted volume with an unchanged source is skipped, and the freeze gate is never asked");

  // source-changed
  await writeRollingState(rolling, { results: [80, 85], acceptedBy: "rolling-window", sourceFingerprint: "old-fingerprint" });
  let err = null;
  try { await ask({ bundle: { sourceFingerprint: "new-fingerprint" } }); } catch (e) { err = e; }
  ok(err && isStructuralError(err), `a changed source book is refused structurally: ${err && err.message}`);
  ok(err && /source book changed/.test(err.message), "and the refusal names the act");

  // failed-grade
  await writeRollingState(rolling, { results: [40, 45], acceptedBy: "rolling-window", sourceFingerprint: "same" });
  err = null;
  try { await ask({}); } catch (e) { err = e; }
  ok(err && isStructuralError(err), `a volume whose acceptance window never passed is refused: ${err && err.message}`);
  ok(err && /acceptance window never met/.test(err.message), "and it says so");

  // no-acceptance-state
  await fs.promises.rm(rolling, { force: true });
  err = null;
  try { await ask({}); } catch (e) { err = e; }
  ok(err && isStructuralError(err), "a volume with no readable acceptance window is refused rather than silently rebuilt");

  // cascade
  await writeRollingState(rolling, { results: [80, 85], acceptedBy: "rolling-window", sourceFingerprint: "same" });
  err = null;
  try { await ask({ regeneratedAny: true, cascadeFrom: "01" }); } catch (e) { err = e; }
  ok(err && isStructuralError(err), "the cumulative cascade is refused too — rebuilding volume 1 rewrites volume 2's base");
  ok(err && /volume 01 is being rebuilt/.test(err.message), `and it names where the cascade came from rather than saying 'an earlier volume': ${err && err.message}`);

  // force
  err = null;
  try { await ask({ force: true }); } catch (e) { err = e; }
  ok(err && isStructuralError(err), "--force is refused inside the loop as well as at the door");
});

// ─── 7. missing-output is the one cancellation that is not a rewrite ──────────

scenario("filling a hole in a half-translated volume is allowed — it is not overwriting", async () => {
  const built = await series("missing-is-repair");
  const v = built.volumes[0];
  const volDir = path.join(built.dir, v.folder);
  // The volume has a published translation, but its glossary was never written.
  await fs.promises.rm(path.join(volDir, "glossary.md"), { force: true });
  await fs.promises.rm(path.join(volDir, "glossary-validation.md"), { force: true });
  await fs.promises.rm(path.join(volDir, "glossary-validation-rolling-state.json"), { force: true });

  const verdict = await fz.evaluateFreeze({ door: "glossary", seriesDir: built.dir, cancelledBy: "missing-output", volumeArg: v.installmentNumber });
  ok(verdict.ok, `a frozen volume whose glossary is ABSENT is completed, not refused: ${JSON.stringify(verdict.frozen.map((g) => g.line))}`);

  const rolling = path.join(volDir, "glossary-validation-rolling-state.json");
  const allowed = await require("../utils/series-run/skip").volumeAlreadyAccepted({
    installmentNumber: v.installmentNumber,
    outputFiles: [path.join(volDir, "glossary.md")],
    validationOutputFile: path.join(volDir, "glossary-validation.md"),
    bundle: { sourceFingerprint: "same" },
    force: false,
    regeneratedAny: false,
    artifactLabel: "glossary",
    step: "glossary",
    seriesDir: built.dir,
    folder: v.folder,
    dryRun: false,
  });
  ok(allowed === false, "the loop regenerates it — which is the repair, not a refusal");

  // The other half of the same rule: `extract` and `discover` declare no per-volume artifact, so an
  // absent file of their own does not excuse rewriting the extracted text or the plan of record.
  const extract = await fz.evaluateFreeze({ door: "extract", seriesDir: built.dir, cancelledBy: "missing-output", volumeArg: v.installmentNumber });
  ok(!extract.ok, "extract is NOT excused by an absent report: what it rewrites is the book's extracted text");
});

// ─── 8. --volume narrows the question ─────────────────────────────────────────

scenario("--volume 02 is not blocked by a frozen volume 01 this run does not touch", async () => {
  const built = await series("volume-narrow");
  // Un-publish volume 02's translation: this run is about to translate volume 02, and volume 01 stays
  // finished. Volume 01 must not be the reason volume 02 cannot be rebuilt.
  await fx.removeStepOutputs(built.dir, "translate", built.volumes[1].folder, built.volumes[1].installmentNumber);

  const narrowed = await fz.evaluateFreeze({ door: "glossary", seriesDir: built.dir, cancelledBy: "force", volumeArg: "02" });
  ok(narrowed.ok, `a legal --volume 02 run is allowed even though volume 01 is frozen: ${JSON.stringify(narrowed.frozen.map((g) => g.line))}`);

  const widened = await fz.evaluateFreeze({ door: "glossary", seriesDir: built.dir, cancelledBy: "force" });
  ok(!widened.ok && widened.frozen.length === 1 && widened.frozen[0].installment === "01",
    "without --volume, the frozen volume is named — the narrowing is a scope, not an excuse");

  const bogus = await fz.evaluateFreeze({ door: "glossary", seriesDir: built.dir, cancelledBy: "force", volumeArg: "99" });
  ok(!bogus.ok && /matches none/.test(bogus.message), `a --volume that names nothing is reported, not silently narrowed to nothing: ${bogus.message}`);
});

// ─── 9. --dry-run reports and does not refuse ─────────────────────────────────

scenario("--dry-run reports the freeze and does not refuse", async () => {
  const built = await series("dry-run");
  const lines = [];
  const verdict = await fz.assertDoorAllowed({
    door: "glossary",
    seriesDir: built.dir,
    cancelledBy: "force",
    dryRun: true,
    log: (line) => lines.push(line),
  });
  ok(verdict.reported, "the dry run was told");
  ok(lines.some((l) => /DRY RUN/.test(l)), `and it says plainly that it is not refusing: ${lines[0]}`);
  ok(lines.length > 1, "it still prints every volume it would have refused on");

  const res = await runGulp("glossary", ["--force", "--dry-run"]);
  ok(!/refuses to rewrite/.test(res.output), `the real door does not refuse on a dry run (exit ${res.code}): ${res.output.slice(0, 500)}`);
});

// ─── 10. There is no quiet switch ─────────────────────────────────────────────

scenario("no flag, no run policy, no ledger entry and no setting reaches the gate", async () => {
  const built = await series("no-switch");
  const attempts = [
    ["--allow-fail", ["--force", "--allow-fail"], {}],
    ["ON_TASK_ERROR=continue", ["--force"], { ON_TASK_ERROR: "continue" }],
    ["ON_VOLUME_ERROR=skip", ["--force"], { ON_VOLUME_ERROR: "skip" }],
    ["--allow-fail + both policies", ["--force", "--allow-fail"], { ON_TASK_ERROR: "continue", ON_VOLUME_ERROR: "skip" }],
  ];
  for (const [label, flags, env] of attempts) {
    const res = await runGulp("glossary", flags, env);
    ok(res.code !== 0 && /refuses to rewrite/.test(res.output), `${label} does not walk past the gate (exit ${res.code}): ${res.output.slice(0, 300)}`);
  }

  // A ledger that already recorded this step failing is not a permission either.
  const { appendLedgerEntry } = require("../utils/ledger");
  appendLedgerEntry({ run: "freeze-probe", step: "glossary", kind: "intervention", action: "wipe-and-cascade", outcome: "unchanged" });
  const verdict = await fz.evaluateFreeze({ door: "glossary", seriesDir: built.dir, cancelledBy: "force" });
  ok(!verdict.ok, "the ledger is a record of attempts, not an input to the question");

  // And there is no knob: nothing in configs/ names a freeze setting, and the gate reads no env var
  // other than the series location it is handed.
  const settings = fs.readdirSync(path.join(ROOT, "configs")).filter((f) => f.endsWith(".js"));
  const knobs = [];
  for (const file of settings) knobs.push(...readEnvNames(path.join(ROOT, "configs", file)));
  for (const file of fs.readdirSync(path.join(ROOT, "configs", "shared")).filter((f) => f.endsWith(".js"))) {
    knobs.push(...readEnvNames(path.join(ROOT, "configs", "shared", file)));
  }
  const freezeKnobs = knobs.filter((name) => /FREEZE|RELEASE|UNFREEZE|THAW/i.test(name));
  same(freezeKnobs, [], `a check you can switch off is not a check (AGENTS.md §4 rule 3). configs/ defines: ${knobs.join(", ")}`);

  // The whole freeze MODULE, not just the cover: `utils/prereqs/freeze.js` is a thin cover over the
  // folder named after it, and a scan of the cover alone is a check that can never report (gotcha 67).
  const source = readModuleLayer(ROOT, "utils/prereqs/freeze.js");
  const envReads = source.match(/process\.env\.[A-Z_]+/g) || [];
  same(envReads, [], `the freeze module — the cover and every file in utils/prereqs/freeze/ — reads no environment variable at all${envReads.length ? `; found ${envReads.join(", ")}` : ""}`);
});

/**
 * Every `process.env.<NAME>` a file reads.
 * @param {string} file
 * @returns {string[]}
 */
function readEnvNames(file) {
  const text = fs.readFileSync(file, "utf8");
  return [...new Set((text.match(/process\.env\.[A-Z][A-Z0-9_]+/g) || []).map((m) => m.replace("process.env.", "")))];
}

// ─── 11. The recorded release is the only way past ────────────────────────────

scenario("a recorded release is the only way past, it is per door, and it touches no translation", async () => {
  const built = await series("release");
  const before = await translationChecksums(built.dir, built.volumes);
  const thin = "redo";
  const reason = "the glossary missed the running joke in chapter 4 and every later volume copied it forward";

  // A reason under the floor is refused — the same floor reopen-volume.js holds.
  let res = await runChild([path.join(ROOT, "release-translation.js"), "--volume=01", "--door=glossary", `--reason=${thin}`]);
  ok(res.code !== 0 && /reason-too-thin/.test(res.output), `a thin reason is refused (exit ${res.code}): ${res.output.slice(0, 400)}`);
  ok(res.output.includes(String(fz.MIN_RELEASE_REASON_CHARS)), "and it says how long a reason has to be");
  same(fz.MIN_RELEASE_REASON_CHARS, 20, "the floor is the same one reopen-volume.js holds");

  // An unknown door is refused rather than guessed at.
  res = await runChild([path.join(ROOT, "release-translation.js"), "--volume=01", "--door=translate", `--reason=${reason}`]);
  ok(res.code !== 0 && /unknown-door/.test(res.output), `releasing a door this gate does not cover is refused: ${res.output.slice(0, 400)}`);

  // A volume this series does not have is refused too: the record is read against real folders.
  res = await runChild([path.join(ROOT, "release-translation.js"), "--volume=77", "--door=glossary", `--reason=${reason}`]);
  ok(res.code !== 0 && /unknown-volume/.test(res.output), `a release against a volume that does not exist is refused: ${res.output.slice(0, 400)}`);

  // Nothing recorded yet: still refused.
  let verdict = await fz.evaluateFreeze({ door: "glossary", seriesDir: built.dir, cancelledBy: "force" });
  ok(!verdict.ok, "before the release, the act is refused");

  // Record it.
  res = await runChild([path.join(ROOT, "release-translation.js"), "--volume=01", "--door=glossary", `--reason=${reason}`]);
  ok(res.code === 0 && /RELEASED/.test(res.output), `the release is recorded (exit ${res.code}): ${res.output.slice(0, 600)}`);
  ok(res.output.includes("translation.md"), "and it names the translation it invalidates, from the declaration");

  const record = fz.readTranslationReleases();
  ok(!record.error && record.releases.length === 1, `one row, in the run's own records: ${record.file}`);
  same(record.releases[0].volumes, ["01"], "it names the volume");
  same(record.releases[0].doors, ["glossary"], "it names the door");
  ok(record.releases[0].invalidated.includes("translation.md"), "it names what stops vouching");
  ok(record.releases[0].reason === reason, "it keeps the reason in the owner's words");

  // Per door: releasing glossary does not release character-voice.
  verdict = await fz.evaluateFreeze({ door: "glossary", seriesDir: built.dir, cancelledBy: "force", volumeArg: "01" });
  ok(verdict.ok, "the released door is allowed");
  const other = await fz.evaluateFreeze({ door: "character-voice", seriesDir: built.dir, cancelledBy: "force", volumeArg: "01" });
  ok(!other.ok, "and the door that was NOT released is still refused");

  // Volume 02 was not named, so it stays frozen.
  const v2 = await fz.evaluateFreeze({ door: "glossary", seriesDir: built.dir, cancelledBy: "force", volumeArg: "02" });
  ok(!v2.ok, "a release names volumes, and an unnamed volume stays frozen");

  // Standing, not consumed: the same release still covers the act on a second ask.
  const again = await fz.evaluateFreeze({ door: "glossary", seriesDir: built.dir, cancelledBy: "force", volumeArg: "01" });
  ok(again.ok, "a release does not expire and is not spent by one run — the translation is still on disk, so an expiring release would make the volume impossible to rebuild");

  // A manual door is covered by a release naming its owning stage.
  const manual = await fz.evaluateFreeze({ door: "reopen-volume", seriesDir: built.dir, cancelledBy: "act", volumeArg: "01" });
  ok(!manual.ok, "a release naming `glossary` does not release `reopen-volume`");
  const ownerRelease = fz.recordTranslationRelease({ volumes: ["01"], doors: ["character-voice"], reason });
  ok(ownerRelease.ok, "recording the owning stage is how a manual door is released");
  const manualNow = await fz.evaluateFreeze({ door: "reopen-volume", seriesDir: built.dir, cancelledBy: "act", volumeArg: "01" });
  ok(manualNow.ok, "and the manual door reads the same release");

  // The whole point: nothing was done to a translation.
  same(await translationChecksums(built.dir, built.volumes), before, "a release deletes, edits, marks or schedules NOTHING in a volume folder");
  ok(fs.existsSync(path.join(built.dir, built.volumes[1].folder, "translation.md")), "both translations stand exactly where they were");

  // A record that cannot be read is reported, never treated as "no releases".
  const broken = path.join(built.ledgerDir, fz.RELEASE_RECORD_FILE);
  await fs.promises.writeFile(broken, "{ not json", "utf8");
  const unreadable = await fz.evaluateFreeze({ door: "style-guide", seriesDir: built.dir, cancelledBy: "force" });
  ok(!unreadable.ok && unreadable.recordError, `a release record that cannot be read is named, not silently read as empty: ${unreadable.recordError}`);
});

// ─── 12. The four manual doors ────────────────────────────────────────────────

scenario("the four manual doors refuse on a frozen volume, and a rehearsal stays allowed", async () => {
  const built = await series("manual-doors");
  const volDir = path.join(built.dir, built.volumes[0].folder);
  // Two of the four open the volume's reference record before they ask anything, so the fixture needs
  // one. Created here, in the fixture, never read from the real corpus.
  const store = rs.openReferenceStore({ volume: 1, folder: built.volumes[0].folder, seriesDir: built.dir, stage: "attribution", create: true });
  store.close();

  // These four commands check the model credentials before they do anything else, so the child needs a
  // key present to reach the gate at all. `AI_BASE_URL` still points at a closed port, so a call that
  // was not supposed to happen fails instead of succeeding — and none of these cases gets that far.
  const env = { AI_API_KEY: "fixture-key-not-a-key" };
  const cases = [
    ["extract-voice", [path.join(ROOT, "extract-voice.js"), "--volume=01"]],
    ["reopen-volume", [path.join(ROOT, "reopen-volume.js"), "--volume=01", "--reason=the extraction pass that built this record swallowed parse errors"]],
    ["attribute-voice", [path.join(ROOT, "attribute-voice.js"), "--volume=01"]],
    ["rebuild-voice --apply", [path.join(ROOT, "rebuild-voice.js"), "--volume=01", "--apply"]],
  ];
  for (const [label, args] of cases) {
    const res = await runChild(args, env);
    ok(res.code !== 0, `${label} refuses on a frozen volume (exit ${res.code}): ${res.output.slice(0, 500)}`);
    ok(/refuses to rewrite/.test(res.output), `${label} says which gate refused it: ${res.output.slice(0, 500)}`);
    ok(/release-translation\.js/.test(res.output), `${label} names the door past it`);
  }

  // `--check` and `--answers` read the record and write nothing: they are not rewrites.
  const check = await runChild([path.join(ROOT, "attribute-voice.js"), "--volume=01", "--check"], env);
  ok(!/refuses to rewrite/.test(check.output), `attribute-voice --check is not gated (exit ${check.code}): ${check.output.slice(0, 400)}`);
  const answers = await runChild([path.join(ROOT, "attribute-voice.js"), "--volume=01", "--answers"], env);
  ok(!/refuses to rewrite/.test(answers.output), `attribute-voice --answers is not gated (exit ${answers.code}): ${answers.output.slice(0, 400)}`);

  // A rehearsal writes into a copy under --out and touches nothing in the series folder, so freezing it
  // would remove the only cheap way to look at a renderer change before publishing it.
  const rehearsal = await runChild([path.join(ROOT, "rebuild-voice.js"), "--volume=01", "--out", path.join(FIXTURES, "manual-doors-rehearsal")], env);
  ok(!/refuses to rewrite/.test(rehearsal.output), `rebuild-voice WITHOUT --apply is allowed (exit ${rehearsal.code}): ${rehearsal.output.slice(0, 500)}`);

  // `--list` and `--history` read and write nothing.
  const listed = await runChild([path.join(ROOT, "reopen-volume.js"), "--list"], env);
  ok(!/refuses to rewrite/.test(listed.output), `reopen-volume --list is not gated (exit ${listed.code}): ${listed.output.slice(0, 300)}`);

  // Nothing was written into the frozen volume by any of the refusals.
  ok(fs.existsSync(path.join(volDir, "character-voice.md")), "the published voice reference the refusals protected is still there");
});

// ─── 13. A legal resumed translate is unblocked ───────────────────────────────

scenario("a legal resumed translate is not blocked by the freeze", async () => {
  const built = await series("resumed-translate");

  const gate = await prereqs.evaluatePrerequisites({ step: "translate", seriesDir: built.dir, volumeArg: null });
  ok(gate.ok, `the prerequisite gate still says the series is complete: ${JSON.stringify(gate.gaps || {})}`);

  // `translate` is not a door, and `consistency-audit` skips while its provenance still fingerprints
  // the four artifacts — so the audit's gate is never reached by a legal resumed run.
  ok(fz.freezeDoorRow("translate") === null, "translate is not frozen: it is the act the freeze protects, not the thing being protected");
  ok(fz.freezeDoorRow("consistency-audit").scope === "series", "the audit is a SERIES door: it is frozen when any volume in scope is frozen");

  const audit = await fz.evaluateFreeze({ door: "consistency-audit", seriesDir: built.dir, cancelledBy: "audit-stale" });
  ok(!audit.ok && audit.frozen.length === 2, `re-signing a translated series is what is refused: ${audit.headline}`);
  ok(audit.bullets[0].includes("sign-off"), `and it says what is at stake: ${audit.bullets[0]}`);

  const fresh = fz.readTranslationReleases();
  same(fresh.releases, [], "and with no release recorded, that refusal stands");

  // A plain run of the audit skips (its provenance sidecar still fingerprints the four artifacts), so
  // it never reaches the gate at all — which is what keeps a legal resumed translate unblocked.
  const skipped = await fz.evaluateFreeze({ door: "consistency-audit", seriesDir: built.dir, cancelledBy: "skip" });
  ok(skipped.ok, "an audit that skips is not a rewrite, so it is not refused");
});

// ─── 14. A standing release is visible to the delivery layer ──────────────────

scenario("the resume triage and the delivery report name a standing release", async () => {
  const built = await series("release-visible");
  const reason = "volume 1's voice reference was built from a chapter the converter cut off mid-array";

  const state = await resume.readWorkingState({ seriesDir: built.dir });
  same(state.releases, [], "with nothing recorded, the snapshot says so");
  ok(state.volumes.every((v) => Array.isArray(v.releasedDoors)), "every volume inventory carries the field, so 'nothing released' is an answer rather than an absence");
  ok(resume.frozenVolumes(state.volumes).length === 2, "and the triage can see which volumes the freeze is holding");
  ok(resume.frozenVolumes(state.volumes).every((v) => v.releasedDoors.length === 0), "none of them released");

  const recorded = fz.recordTranslationRelease({ volumes: ["01"], doors: ["character-voice"], reason });
  ok(recorded.ok, "record one release");

  const after = await resume.readWorkingState({ seriesDir: built.dir });
  ok(after.releases.length === 1, "the snapshot carries it");
  same(after.volumes.find((v) => v.installment === "01").releasedDoors, ["character-voice"], "and it is attached to the volume it names");
  same(after.volumes.find((v) => v.installment === "02").releasedDoors, [], "the volume it did not name stays shut");

  const plan = resume.planResume(after);
  ok(plan.releases.length === 1, "the plan carries it");
  ok(plan.markdown.includes("Frozen references"), `the report names the freeze at all: ${plan.markdown.slice(0, 800)}`);
  ok(plan.markdown.includes("release-translation"), "and it prints the door past it");
  ok(plan.markdown.includes(reason), "the reason is in the report a person reads, not only in the record");
  ok(/Volume 01: released for `character-voice`/.test(plan.markdown),
    `it names which volume is unlocked for which door: ${plan.markdown.match(/Volume 01[^\n]*/)?.[0] || "not found"}`);

  // A record that cannot be read is named, not silently read as "no releases".
  await fs.promises.writeFile(path.join(built.ledgerDir, fz.RELEASE_RECORD_FILE), "{ not json", "utf8");
  const broken = await resume.readWorkingState({ seriesDir: built.dir });
  ok(broken.releasesError, `the snapshot reports it: ${broken.releasesError}`);
  ok(resume.planResume(broken).markdown.includes("could not be read"), "and the report says so rather than printing an empty list");
});

// ─── 15. The table and its door are banned patch paths ────────────────────────

scenario("the freeze table, the door past it, and this file are banned patch paths", async () => {
  for (const file of ["utils/prereqs.js", "utils/prereqs/freeze.js", "release-translation.js"]) {
    const verdict = patchPathIsBanned(file);
    ok(verdict.banned, `${file} must be a banned patch path`);
    ok(verdict.rule.because.length > 30, `${file}'s ban names a reason: ${verdict.rule.id}`);
    ok(/account owner/.test(verdict.rule.escalateTo), `${file}'s ban says who decides instead`);
  }
  ok(patchPathIsBanned("utils/prereqs/freeze.js").rule.id === "constraint-tables", "the freeze table is inside the same ban as the prerequisite table, because the folder is the table");
  ok(patchPathIsBanned("release-translation.js").rule.id === "freeze-gate-doors", "the door past the gate has its own named ban");
  const here = patchPathIsBanned("test/test-freeze-gate.js");
  ok(here.banned && here.rule.id === "constraint-tests", "editing the test that proves a guard works is how a guard becomes decoration");

  // The false-positive half: the ban does not swallow the files this gate wraps, only the table and
  // the door.
  for (const file of ["consistency-audit.js", "gulpfile.js", "index.js", "package.json", "utils/translate.js", "utils/series-run/skip.js", "utils/artifacts/translation.js"]) {
    ok(!patchPathIsBanned(file).banned, `${file} is a legitimate patch target and must stay one`);
  }
});

// ─── Runner ───────────────────────────────────────────────────────────────────

(async () => {
  await fs.promises.mkdir(EMPTY_HOOKS, { recursive: true });
  for (const { name, fn } of scenarios) {
    try {
      await fn();
      console.log(`  ok   ${name}`);
    } catch (err) {
      console.error(`\nFAIL: ${name}\n  ${err && err.stack ? err.stack : err}`);
      process.exitCode = 1;
      break;
    }
  }
  if (process.exitCode) throw new Error("freeze gate suite failed");
  console.log(`freeze gate: ok — ${scenarios.length} scenarios, ${checks} checks`);
})();
