/**
 * index.js — Run the pipeline one step at a time, and check what each step left.
 *
 * Why this entry point exists. `npx gulp` (the default task) runs all nine steps
 * inside ONE Node process. That has two consequences this project feels:
 *
 *   1. Node caches every module the first time it is required, and gulpfile.js
 *      requires all ten task modules at the top of the file. A fix written to
 *      disk mid-run is not the code the rest of the run executes.
 *   2. `ON_TASK_ERROR=continue` runs the remaining steps on a foundation the
 *      previous step failed to build (gotcha 21 records what that looked like:
 *      every step re-running a rejected intake, three attempts apiece).
 *
 * This file changes both by running each step as its own process:
 *
 *   - a fresh process means a fresh module cache, so a fix applied between steps
 *     IS the code the next step runs — no module-cache surgery, and no volume
 *     half-built by old code and half by new;
 *   - the post-mortem runs BEFORE the next step, so a broken glossary is found
 *     before the character-voice stage builds on it, not after the translation
 *     stage has already paid for it.
 *
 * The step itself is still gulp: `node node_modules/gulp/bin/gulp.js <step>`, so
 * every per-machine hook (hooks/pre-<task>, hooks/post-<task>) fires exactly as it
 * does today, including the model-container switches the translation stage needs
 * (gotcha 22). Nothing about how a step RUNS changes here; only who runs it, and
 * what happens after it.
 *
 * Scope, honestly stated. This file ORCHESTRATES and ASSESSES. It does not fix
 * anything: there is no diagnosis agent here, no patching, no retry loop. The
 * findings it writes to `.postmortem/<step>.json` are the input a later diagnosis
 * stage consumes. Keeping the two separate is deliberate — assessment is
 * deterministic, free, and safe to run on every step of every run; deciding to
 * rewrite code is neither.
 *
 * Usage:
 *   node index.js                      # every step, in gulp order
 *   node index.js --stages=glossary,jump-in-wiki
 *   node index.js --force              # passed through to every step
 *   node index.js --volume 07          # passed through to every step
 *   node index.js --dry-run            # no model calls, no post-mortem (nothing is written)
 *   node index.js --post-mortem=off    # orchestration only
 *   node index.js --fail-on=never      # report findings, do not fail the run on them
 *   node index.js --ledger=off         # record nothing about what this run assessed
 *   node index.js --list               # print the step list and exit
 *
 * It also REMEMBERS. Every assessed step appends one entry to
 * `.postmortem/ledger.json` (see `utils/ledger.js`): what the step left behind, and
 * later what was decided about it. Nothing else in the pipeline records a DECISION —
 * the state files record artifacts — and without that record the delivery stage cannot
 * tell a repair from a repeat of a repair that already failed.
 *
 * The code lives in index/: settings.js (the runner's knobs), args.js (what the operator asked
 * for), run-step.js (one step, in its own process), assess.js (what a step left behind),
 * steps.js (the walk and the summary), main.js (the step list and the run lock). This file is
 * the entry point and the public surface.
 *
 * @module index
 */


// The env file is read BEFORE anything that turns a knob into a value at require time,
// and so is the one knob that has a default: the step children inherit both, and
// gulpfile.js reads the task modules only after this point (AGENTS.md gotcha 79).
require("./configs/env-defaults").bootstrapEnv();

const { main } = require("./index/main");

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[index] ${err.message}`);
    process.exit(1);
  });
