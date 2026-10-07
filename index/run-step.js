/**
 * index/run-step.js — one step, in its own process.
 *
 * A separate process is the point: a stage that leaks memory, hangs a container switch, or
 * dies on a model call cannot take the runner (or the next step) with it. The structural
 * marker file is how a child tells the parent WHAT kind of failure it had, because an
 * in-process flag cannot cross the process boundary (gotcha 21).
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const { gulpCommand, stepTimeoutMs, structuralMarkerPath } = require("./settings");

const projectRoot = path.join(__dirname, ".."); // the runner's ROOT

// ─── Running one step ─────────────────────────────────────────────────────────

/**
 * Run one pipeline step in its own process.
 *
 * Awaited, never `spawnSync`. A synchronous spawn parks this process's event
 * loop for the child's whole life (gotcha 63 — where every stage hung until the
 * call deadline fired and the log blamed an endpoint that was actually blocked by
 * its own runner).
 *
 * Output is streamed live (an un-monitored run must be watchable) and buffered
 * (the digest and the report need it).
 *
 * @param {string} stepName - The gulp task name.
 * @param {string[]} gulpArgs - Flags to pass through.
 * @returns {Promise<{code: number|null, killed: boolean, output: string, structural: Object|null}>}
 */
function runStep(stepName, gulpArgs) {
  return new Promise((resolve) => {
    const marker = structuralMarkerPath();
    try {
      fs.rmSync(marker); // this step's outcome, not the previous step's
    } catch {}

    const { command, prefixArgs } = gulpCommand();
    const child = spawn(command, [...prefixArgs, stepName, ...gulpArgs], {
      cwd: projectRoot,
      env: process.env,
    });

    let output = "";
    let killed = false;
    const capture = (chunk) => {
      output += chunk.toString();
      process.stderr.write(chunk);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);

    const timeoutMs = stepTimeoutMs();
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            killed = true;
            child.kill("SIGKILL");
          }, timeoutMs)
        : null;

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -2, killed: false, output: `${output}\nspawn error: ${err.message}`, structural: null });
    });

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      let structural = null;
      try {
        structural = JSON.parse(fs.readFileSync(marker, "utf8"));
      } catch {}
      resolve({ code: killed ? -1 : code, killed, output, structural });
    });
  });
}

/**
 * The last few lines of a step's output that actually explain something.
 *
 * A gulp failure prints a stack trace; what a human scanning an overnight run
 * needs is the error line. Same idea as the pipeline-loop test's digest.
 *
 * @param {string} output
 * @returns {string[]}
 */
function digestOf(output) {
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  const interesting = lines.filter(
    (l) =>
      /\[error\]|Error:|FAILED|failed:|WARNING|structural|errored/i.test(l)
  );
  const picked = interesting.length ? interesting.slice(-6) : lines.slice(-3);
  return picked.map((l) => (l.length > 220 ? `${l.slice(0, 220)}…` : l));
}

module.exports = { runStep, digestOf };
