/**
 * index/args.js — what the operator asked for.
 *
 * One parser, one error message per mistake. An unknown flag is refused rather than
 * ignored: a mistyped flag on a tool that can wipe a volume's accepted output should fail
 * loudly, and `--list` exists so a runner can be read before it is run.
 */

const GULPFILE = require("../gulpfile");
const { PIPELINE_STEPS } = GULPFILE;
const { TASKS } = require("../utils/hooks");
const { ledgerEnabled } = require("../utils/ledger");
const { PASS_THROUGH_FLAGS, failOnLevel } = require("./settings");

// ─── argv ─────────────────────────────────────────────────────────────────────

/**
 * Parse this runner's own argv, and separate it from the flags handed to gulp.
 *
 * @param {string[]} argv - process.argv.slice(2).
 * @returns {{steps: Array<{name: string, run: Function}>, gulpArgs: string[], postMortem: boolean, ledger: boolean, failOn: string, list: boolean}}
 */
function parseArgs(argv) {
  const gulpArgs = [];
  let only = null;
  let postMortem = process.env.POSTMORTEM_ENABLED !== "false";
  let ledger = ledgerEnabled();
  let failOn = failOnLevel();
  let list = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--list") {
      list = true;
      continue;
    }
    if (arg === "--post-mortem=off" || arg === "--no-post-mortem") {
      postMortem = false;
      continue;
    }
    if (arg === "--post-mortem=on") {
      postMortem = true;
      continue;
    }
    if (arg.startsWith("--post-mortem=")) {
      postMortem = arg.endsWith("off") ? false : true;
      continue;
    }
    if (arg === "--ledger=off" || arg === "--no-ledger") {
      ledger = false;
      continue;
    }
    if (arg === "--ledger=on") {
      ledger = true;
      continue;
    }
    if (arg.startsWith("--fail-on=")) {
      const v = arg.replace("--fail-on=", "");
      if (v === "high" || v === "medium" || v === "never") failOn = v;
      continue;
    }
    if (arg.startsWith("--stages=") || arg.startsWith("--steps=")) {
      only = arg.replace(/^--(stages|steps)=/, "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      continue;
    }
    if (PASS_THROUGH_FLAGS.includes(arg)) {
      gulpArgs.push(arg);
      continue;
    }
    if (arg === "--volume" || arg.startsWith("--volume=")) {
      if (arg.startsWith("--volume=")) {
        gulpArgs.push("--volume", arg.replace("--volume=", ""));
      } else {
        gulpArgs.push("--volume", argv[i + 1] || "");
        i++;
      }
      continue;
    }
    // Anything else goes to gulp untouched. Unknown flags are its problem to
    // report, not this runner's to guess about.
    gulpArgs.push(arg);
  }

  let steps = PIPELINE_STEPS;
  if (only) {
    // The default run order is PIPELINE_STEPS, but any gulp task can be run
    // individually — verify-translate, retranslate and translation-report are real
    // steps that are not part of the default sequence. The universe of valid names
    // is utils/hooks.js TASKS, which test-postmortem.js pins against the artifact
    // manifest so a name cannot exist in one list and not the others.
    const byName = new Map(PIPELINE_STEPS.map((s) => [s.name, s]));
    for (const name of TASKS) {
      if (byName.has(name)) continue;
      const task = GULPFILE[name];
      if (typeof task === "function") byName.set(name, { name, run: task });
    }
    const chosen = only.map((name) => {
      const step = byName.get(name);
      if (!step) {
        throw new Error(
          `--stages: "${name}" is not a pipeline step. Known steps: ` +
            `${[...byName.keys()].join(", ")}.`
        );
      }
      return step;
    });
    steps = chosen;
  }

  return { steps, gulpArgs, postMortem, ledger, failOn, list };
}

module.exports = { parseArgs };
