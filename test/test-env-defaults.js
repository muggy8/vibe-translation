/**
 * test-env-defaults.js — self-checks for the one setting a fresh clone does not
 * have to set: SERIES_LOCATION defaults to the repo's own `epub_source/` folder
 * (configs/env-defaults.js).
 *
 * What this pins, and why each half matters:
 *   - unset → the default, absolute, and the run SAYS it used the default (a run
 *     quietly pointed at a folder nobody chose is the surprise this project refuses);
 *   - set → untouched, exactly as written, and no announcement;
 *   - the default is applied BEFORE a task module reads the variable at require time
 *     (AGENTS.md gotcha 79) — the half that decides whether the default works at all;
 *   - the folder actually ships with the repo, so a clone can run before it is told
 *     where anything is.
 *
 * Every scenario runs in a child process whose working directory is a temp folder:
 * the task modules call `dotenv.config()` themselves, and with the repo as the cwd
 * that would load this machine's `.env` and quietly set SERIES_LOCATION, which is the
 * exact thing these tests are trying to leave unset.
 *
 * No network, no endpoint, no model call. Run with `npm test` (or standalone:
 * `node test/test-env-defaults.js`).
 */
require("./test-home"); // the run's records get a throwaway home (gotcha 69)
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_DIR = path.join(ROOT, "epub_source");
const ENV_DEFAULTS = path.join(ROOT, "configs", "env-defaults.js");

/** A working directory with no `.env` in it, so dotenv finds nothing to load. */
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-client-env-defaults-"));

/**
 * Run Node in a clean child: no inherited SERIES_LOCATION, no `.env` to load.
 *
 * @param {string[]} argv - Node's arguments (`["-e", snippet]` or `["<file>", …]`).
 * @param {Record<string, string>} [env] - Extra env values for the child.
 * @returns {{out: string, err: string, status: number|null}} The child's streams and exit code.
 */
function runNode(argv, env = {}) {
  const res = spawnSync(process.execPath, argv, {
    cwd: scratchDir,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH || "",
      // dotenv v17 prints a banner on stdout ("◇ injected env (0) from .env"), which
      // would sit in front of the JSON these tests parse.
      DOTENV_CONFIG_QUIET: "true",
      ...env,
    },
  });
  if (res.error) throw res.error;
  return {
    out: String(res.stdout || "").trim(),
    err: String(res.stderr || "").trim(),
    status: res.status,
  };
}

/** Run a snippet in that clean child. */
function runIn(script, env = {}) {
  return runNode(["-e", script], env);
}

/**
 * Read the JSON a child printed, ignoring anything else it printed first.
 *
 * @param {string} out - The child's stdout.
 * @returns {Object} The parsed object.
 */
function lastJson(out) {
  const line = String(out || "")
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("{") || s.startsWith("["))
    .pop();
  return JSON.parse(line || "{}");
}

/**
 * Ask a clean child what SERIES_LOCATION ended up as, and whether the default spoke up.
 *
 * @param {Record<string, string>} [env] - The SERIES_LOCATION to start from (absent = unset).
 * @returns {{applied: boolean, value: string, announced: boolean}}
 */
function whatItResolvedTo(env = {}) {
  const r = runIn(
    `const d = require(${JSON.stringify(ENV_DEFAULTS)});` +
      `const r = d.applySeriesLocationDefault();` +
      `console.log(JSON.stringify({ applied: r.applied, value: process.env.SERIES_LOCATION,` +
      `  expected: d.defaultSeriesLocation() }));`,
    env
  );
  const parsed = lastJson(r.out);
  return {
    applied: parsed.applied,
    value: parsed.value,
    announced: /SERIES_LOCATION is not set/.test(r.err),
    expected: parsed.expected,
    err: r.err,
  };
}

// ─── The default folder ships with the repo ──────────────────────────────────

assert.ok(fs.existsSync(DEFAULT_DIR), "epub_source/ exists in a fresh clone");
assert.ok(fs.statSync(DEFAULT_DIR).isDirectory(), "epub_source/ is a folder");
assert.ok(
  fs.existsSync(path.join(DEFAULT_DIR, "README.md")),
  "epub_source/ carries a README saying what to put in it"
);
assert.strictEqual(
  whatItResolvedTo().expected,
  DEFAULT_DIR,
  "defaultSeriesLocation() is the repo's epub_source folder, absolute"
);

// ─── Unset → the default, and the run says so ────────────────────────────────

const unset = whatItResolvedTo();
assert.strictEqual(unset.applied, true, "nothing set it, so the default was applied");
assert.strictEqual(unset.value, DEFAULT_DIR, "SERIES_LOCATION became the default folder");
assert.strictEqual(
  path.isAbsolute(unset.value),
  true,
  "the default is absolute: a relative one would mean a different folder per working directory"
);
assert.ok(unset.announced, "using the default is announced, not silent");
assert.ok(unset.err.includes(DEFAULT_DIR), "the announcement names the folder it chose");

// An empty or whitespace-only value is unset, not a decision.
for (const blank of ["", "   "]) {
  const r = whatItResolvedTo({ SERIES_LOCATION: blank });
  assert.strictEqual(r.applied, true, `SERIES_LOCATION="${blank}" counts as unset`);
  assert.strictEqual(r.value, DEFAULT_DIR, `SERIES_LOCATION="${blank}" resolves to the default`);
}

// ─── Set → untouched, and nothing is announced ───────────────────────────────

for (const explicit of ["./my-series", "/data/books/my-series", "D:\\books\\my-series"]) {
  const r = whatItResolvedTo({ SERIES_LOCATION: explicit });
  assert.strictEqual(r.applied, false, "an explicit value is not overridden");
  assert.strictEqual(r.value, explicit, `the value is left exactly as written (${explicit})`);
  assert.strictEqual(r.announced, false, "no announcement when the operator chose the folder");
}

// Called twice in one process: the second call is a no-op, and the announcement is
// not repeated (a nine-step run would otherwise print it nine times).
const twice = runIn(
  `const d = require(${JSON.stringify(ENV_DEFAULTS)});` +
    `const a = d.applySeriesLocationDefault();` +
    `const b = d.applySeriesLocationDefault();` +
    `console.log(JSON.stringify({ first: a.applied, second: b.applied, dir: process.env.SERIES_LOCATION }));`
);
const twiceOut = lastJson(twice.out);
assert.strictEqual(twiceOut.first, true, "the first call applies the default");
assert.strictEqual(twiceOut.second, false, "the second call changes nothing");
assert.strictEqual(twiceOut.dir, DEFAULT_DIR, "and the folder stands");
assert.strictEqual(
  (twice.err.match(/SERIES_LOCATION is not set/g) || []).length,
  1,
  "announced once per process"
);

// ─── Gotcha 79: the default is there BEFORE a task module reads it ───────────
// translate/config.js decides `seriesDir` when it is required. A default applied
// later (inside validateRequiredEnv, which runs when a task starts) would leave that
// constant undefined, and the task would fail with "SERIES_LOCATION is not set" even
// though the entry point had one. This is the check that keeps it applied at the door.

const viaTaskBarrel = runIn(
  `require(${JSON.stringify(path.join(ROOT, "translate.js"))});` +
    `const cfg = require(${JSON.stringify(path.join(ROOT, "translate", "config.js"))});` +
    `console.log(JSON.stringify({ seriesDir: cfg.seriesDir, env: process.env.SERIES_LOCATION }));`
);
const barrelOut = lastJson(viaTaskBarrel.out);
assert.strictEqual(
  barrelOut.seriesDir,
  DEFAULT_DIR,
  "the task module's require-time constant sees the default (the entry point applied it first)"
);
assert.strictEqual(barrelOut.env, DEFAULT_DIR, "and the environment agrees");

// gulpfile.js is the entry point the pipeline actually runs through.
const viaGulpfile = runIn(
  `require(${JSON.stringify(path.join(ROOT, "gulpfile.js"))});` +
    `console.log(process.env.SERIES_LOCATION);`
);
assert.strictEqual(viaGulpfile.out, DEFAULT_DIR, "gulpfile.js applies the default before its task requires");

// index.js (npm run pipeline) applies it too, and its step children inherit it.
const viaIndex = runNode([path.join(ROOT, "index.js"), "--list"]);
assert.ok(
  viaIndex.err.includes(DEFAULT_DIR) && /discover/.test(viaIndex.out),
  "index.js announces the default and still lists the steps"
);

// ─── The default is a source folder, not a scratch folder ────────────────────
// Nothing in the pipeline writes pipeline output OUTSIDE the series folder, and an
// empty source folder fails loudly rather than running nine steps over zero volumes:
// a default must not turn "you forgot to put the books in" into a silent no-op.

const emptySeries = fs.mkdtempSync(path.join(os.tmpdir(), "ai-client-empty-series-"));
const loud = runIn(
  `(async () => {` +
    `  const { discoverSeries } = require(${JSON.stringify(path.join(ROOT, "get-translation-target.js"))});` +
    `  try { await discoverSeries({ dryRun: true }); console.log("NO ERROR"); }` +
    `  catch (e) { console.log("THREW: " + e.message); }` +
    `})();`,
  { SERIES_LOCATION: emptySeries }
);
assert.ok(loud.out.startsWith("THREW:"), `an empty series folder must fail, not run: ${loud.out}`);
assert.ok(/No volumes found in/.test(loud.out), "the failure says there were no volumes");
assert.ok(
  loud.out.includes(emptySeries),
  "and it names the folder it looked in, so the operator knows where to put the books"
);
fs.rmSync(emptySeries, { recursive: true, force: true });

// ─── The delivery layer does not inherit the default ─────────────────────────
// A manager's decision, a diagnosis and a patch are answers about ONE run, and a folder
// inherited from a default says nothing about which one. chosenSeriesLocation() is how
// those three roles tell "an operator chose this folder" from "the default landed here"
// — they cannot just read process.env, because by then a transitive require has already
// filled the default in.

const afterTheDefault = lastJson(
  runIn(
    `const d = require(${JSON.stringify(ENV_DEFAULTS)});` +
      `d.applySeriesLocationDefault();` +
      `console.log(JSON.stringify({ env: process.env.SERIES_LOCATION, chosen: d.chosenSeriesLocation() }));`
  ).out
);
assert.strictEqual(afterTheDefault.env, DEFAULT_DIR, "the pipeline's own variable is filled in");
assert.strictEqual(afterTheDefault.chosen, null, "but nobody chose it, so the delivery layer still refuses");

const afterAnExplicit = lastJson(
  runIn(
    `const d = require(${JSON.stringify(ENV_DEFAULTS)});` +
      `d.applySeriesLocationDefault();` +
      `console.log(JSON.stringify({ chosen: d.chosenSeriesLocation() }));`,
    { SERIES_LOCATION: "/data/books/my-series" }
  ).out
);
assert.strictEqual(afterAnExplicit.chosen, "/data/books/my-series", "a folder an operator set IS a choice");

fs.rmSync(scratchDir, { recursive: true, force: true });

console.log("test-env-defaults.js: ok");
