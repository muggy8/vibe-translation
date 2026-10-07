/**
 * index/settings.js — the runner's own knobs, and the two paths it needs.
 *
 * How long a step may run, which findings fail the run, which flags are passed through to
 * gulp, where the gulp CLI actually is, and where a structural failure leaves its marker.
 * Every default here is the pre-knob behavior: an unbounded step, fail on HIGH.
 */

const fs = require("fs");
const path = require("path");

const { postMortemDir } = require("../utils/postmortem");

const projectRoot = path.join(__dirname, ".."); // the runner's ROOT

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Flags this runner passes straight through to gulp. They mean the same thing to
 * the task modules as they always have — the task modules read `process.argv`,
 * and the child process gets these appended to it.
 * @type {string[]}
 */
const PASS_THROUGH_FLAGS = ["--dry-run", "--force", "--chunked"];

/**
 * The gulp CLI entry point. Resolved by path rather than `require.resolve`,
 * because gulp's package `exports` map does not expose `./bin/gulp.js` — the file
 * is there, it is just not importable. Falling back to `npx gulp` keeps a
 * non-standard install working.
 * @returns {{command: string, prefixArgs: string[]}}
 */
function gulpCommand() {
  const local = path.join(projectRoot, "node_modules", "gulp", "bin", "gulp.js");
  if (fs.existsSync(local)) return { command: process.execPath, prefixArgs: [local] };
  return { command: "npx", prefixArgs: ["gulp"] };
}

/**
 * How long one step may run before this runner kills it (INDEX_STEP_TIMEOUT_MS;
 * 0 = no bound, the default).
 *
 * The default is deliberately unbounded: a 17-volume overnight run legitimately
 * takes days, and the pipeline already bounds a single model call with
 * `AI_CALL_DEADLINE_MS` (an idle timeout — gotcha 26). A step-level wall clock
 * here would false-positive on a healthy long stage. Set it when you want a
 * hard ceiling on an unattended run.
 *
 * @returns {number} Milliseconds (0 = none).
 */
function stepTimeoutMs() {
  const n = parseInt(process.env.INDEX_STEP_TIMEOUT_MS, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Which findings make this runner exit non-zero.
 *
 * `high` (default): a step that did not finish what it claims to have finished
 * fails the run. MEDIUM and LOW are reported. `medium` also fails on gaps;
 * `never` reports everything and exits 0 (useful while this is new and you are
 * learning which findings are real).
 *
 * @returns {"high"|"medium"|"never"}
 */
function failOnLevel() {
  const raw = String(process.env.POSTMORTEM_FAIL_ON || "high").trim().toLowerCase();
  return raw === "medium" || raw === "never" ? raw : "high";
}

/**
 * The file a step writes when it dies from a structural failure.
 *
 * `isStructuralError` is an in-process flag (`err.structural === true`), and a
 * child process cannot hand its error object back to this one. The gulpfile's
 * marker wrapper writes this file before rethrowing, so the "a structural failure
 * is never continued past" rule (gotcha 21) survives the process boundary instead
 * of being guessed at from exit codes or error text.
 *
 * @returns {string} Absolute path.
 */
function structuralMarkerPath() {
  return path.join(postMortemDir(), "last-structural-failure.json");
}

module.exports = {
  PASS_THROUGH_FLAGS,
  gulpCommand,
  stepTimeoutMs,
  failOnLevel,
  structuralMarkerPath,
};
