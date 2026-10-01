/**
 * utils/hooks.js — Per-machine pipeline hooks (git-style, entirely optional).
 *
 * Lets each machine attach small executable "hooks" that run before and after
 * each pipeline step (glossary, character-voice, style-guide, jump-in-wiki,
 * consistency-audit, translate, verify-translate, retranslate, translate-qa,
 * polish) and around the whole default run (the "pipeline" pseudo-step). The
 * hooks are
 * user-specific and live OUTSIDE the committed source: they are executable
 * files in a local `hooks/` directory (gitignored), named like git hooks.
 *
 * This is deliberately a dumb "exec an executable file" runner. It does not
 * interpret hook content, load any npm package, or touch the project's
 * package.json. Each hook is a plain executable — a shell script, or a
 * `#!/usr/bin/env node` / `python` script using built-ins — that shells out to
 * whatever the local machine already has (git, curl, mail, jq, a private CLI,
 * …). Machine-local config (API keys, recipients, paths) is read by the hook
 * itself from wherever the machine keeps it (e.g. a dotfile), so secrets never
 * enter the repo.
 *
 * Hook discovery, per step `<task>` and phase (first existing file wins):
 *   - before  -> hooks/pre-<task>   (or pre-<task>.sh / pre-<task>.js)
 *   - after   -> hooks/post-<task>  (or post-<task>.sh / post-<task>.js)
 *   - the whole default run wraps a "pipeline" pseudo-step: pre-pipeline /
 *     post-pipeline.
 * The directory is <project root>/hooks by default; override it with the
 * AI_CLIENT_HOOKS_DIR env var (the git core.hooksPath analogue).
 *
 * Semantics:
 *   - No hook file for a step  -> that hook is skipped silently (the step runs
 *     exactly as it does with no hooks). This is the default on a fresh checkout.
 *   - Hook file present but NOT executable -> warn + skip (fail-open; an
 *     optional hook never crashes the pipeline).
 *   - --dry-run runs NO hooks (dry-run is side-effect-free).
 *   - A before-hook that exits non-zero ABORTS the step (the task does not run
 *     and the after-hook does not run).
 *   - An after-hook runs even when the task itself failed (so a cleanup or
 *     "task failed" notification can fire). If the task failed, an after-hook
 *     error is logged but the ORIGINAL task error is rethrown; if the task
 *     succeeded, an after-hook error fails the run.
 *
 * Wired in from gulpfile.js via withHooks(taskName, taskFn), so the four task
 * modules stay untouched.
 *
 * @example
 * const { withHooks, PIPELINE_TASK } = require("./utils/hooks");
 * const glossaryTask = withHooks("glossary", glossary);
 * exports.glossary = glossaryTask;
 * exports.default = withHooks(PIPELINE_TASK, series(glossaryTask, …));
 */

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
require("../types"); // JSDoc type definitions
const harness = require("../harness");

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * The pipeline steps (gulp task names). "discover" is step 0 — the series
 * intake that writes the plan of record every other step reads.
 * @type {string[]}
 */
const TASKS = [
  "discover",
  "glossary",
  "character-voice",
  "style-guide",
  "jump-in-wiki",
  "consistency-audit",
  "translate",
  "verify-translate",
  "retranslate",
  "translate-qa",
  "polish",
];

/**
 * Pseudo-step that wraps the whole default run (all eight steps).
 * @type {string}
 */
const PIPELINE_TASK = "pipeline";

/**
 * Env var that overrides the hooks directory (git core.hooksPath analogue).
 * @type {string}
 */
const HOOKS_DIR_ENV = "AI_CLIENT_HOOKS_DIR";

// Project root (this file lives in <root>/utils/).
const PROJECT_ROOT = path.resolve(__dirname, "..");

/**
 * Candidate file names for a hook point, tried in order. The bare name is the
 * git convention; the .sh / .js suffixes are friendlier for editors that
 * syntax-highlight by extension.
 *
 * @param {string} hookName - The hook base name (e.g. "pre-jump-in-wiki").
 * @returns {string[]} The candidate names to look for.
 */
function hookCandidates(hookName) {
  return [hookName, `${hookName}.sh`, `${hookName}.js`];
}
// ─── Discovery ────────────────────────────────────────────────────────────────

/**
 * Resolve the hooks directory for this process.
 *
 * @returns {string} Absolute path to the hooks directory (may not exist).
 */
/**
 * How long a hook may run before it is killed (AI_CLIENT_HOOK_TIMEOUT_MS, default
 * 30 minutes; 0 = no timeout). A hook that hangs (a stuck model-switch poll, a
 * wedged git push) would otherwise block an un-monitored run forever, so there
 * is a wall-clock bound by default. A hook that legitimately runs long can
 * raise or disable the bound.
 *
 * @returns {number} The timeout in milliseconds (0 = none).
 */
function hookTimeoutMs() {
  const n = parseInt(process.env.AI_CLIENT_HOOK_TIMEOUT_MS, 10);
  return Number.isFinite(n) && n >= 0 ? n : 30 * 60 * 1000;
}

function getHooksDir() {
  return path.resolve(process.env[HOOKS_DIR_ENV] || path.join(PROJECT_ROOT, "hooks"));
}

/**
 * Find the hook file for a step + phase, or null when none exists.
 *
 * @param {string} hooksDir - Absolute hooks directory.
 * @param {string} task - The step name (a TASKS entry or PIPELINE_TASK).
 * @param {"before"|"after"} phase - Which side of the step.
 * @returns {string|null} Absolute path to the hook file, or null.
 */
function findHookFile(hooksDir, task, phase) {
  const hookName = `${phase === "before" ? "pre" : "post"}-${task}`;
  for (const name of hookCandidates(hookName)) {
    const p = path.join(hooksDir, name);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  return null;
}

/**
 * Extract the --volume argument value from an argv array (mirrors the task
 * modules' own parsing).
 *
 * @param {string[]} argv - The process argv.
 * @returns {string|null} The requested volume number, or null.
 */
function parseVolumeArg(argv) {
  const eq = argv.find((a) => a.startsWith("--volume="));
  if (eq) return eq.replace("--volume=", "");
  const idx = argv.indexOf("--volume");
  if (idx !== -1 && idx + 1 < argv.length) return argv[idx + 1];
  return null;
}

// ─── Context & env ────────────────────────────────────────────────────────────

/**
 * Build the context object describing a hook invocation. It is also the source
 * of the AI_CLIENT_* environment variables injected into shell hooks.
 *
 * @param {string} task - The step name.
 * @param {"before"|"after"} phase - Which side of the step.
 * @param {{succeeded?: boolean, error?: Error}} [extra] - Outcome info, only set
 *   for "after" hooks (succeeded = whether the task resolved; error = the task
 *   error when it threw).
 * @returns {HookContext} The hook context.
 */
function buildHookContext(task, phase, extra = {}) {
  const argv = process.argv;
  const seriesDir = process.env.SERIES_LOCATION || "";
  return {
    task,
    phase,
    seriesDir: seriesDir ? path.resolve(seriesDir) : "",
    seriesName: process.env.SERIES_NAME || "",
    dryRun: argv.includes("--dry-run"),
    force: argv.includes("--force"),
    chunked: argv.includes("--chunked"),
    volume: parseVolumeArg(argv),
    succeeded: extra.succeeded,
    error: extra.error,
    argv,
    env: process.env,
  };
}

/**
 * Build the AI_CLIENT_* environment variables injected into a hook process. The
 * hook also inherits the full process.env (the machine's environment plus the
 * project .env the task modules load), so it can read e.g. $SERIES_LOCATION or
 * its own machine-local variables.
 *
 * @param {HookContext} ctx - The hook context.
 * @returns {Object<string,string>} The env overrides to merge over process.env.
 */
function buildEnvOverrides(ctx) {
  return {
    AI_CLIENT_TASK: ctx.task,
    AI_CLIENT_PHASE: ctx.phase,
    AI_CLIENT_SERIES_DIR: ctx.seriesDir,
    AI_CLIENT_SERIES_NAME: ctx.seriesName,
    AI_CLIENT_DRY_RUN: ctx.dryRun ? "1" : "0",
    AI_CLIENT_FORCE: ctx.force ? "1" : "0",
    AI_CLIENT_CHUNKED: ctx.chunked ? "1" : "0",
    AI_CLIENT_VOLUME: ctx.volume || "",
    // Only meaningful on "after" hooks (succeeded/error are undefined before).
    AI_CLIENT_TASK_SUCCEEDED:
      ctx.succeeded === undefined ? "" : ctx.succeeded ? "1" : "0",
    AI_CLIENT_TASK_ERROR: ctx.error
      ? String(ctx.error.message || ctx.error).split("\n")[0]
      : "",
  };
}
// ─── Execution ────────────────────────────────────────────────────────────────

/**
 * Create a helper that streams a child process's output line-by-line into the
 * run log (real time, so a stalled hook is diagnosable) while also keeping the
 * full output for the error message.
 *
 * @param {string} prefix - The log prefix (e.g. "[hooks] glossary before").
 * @returns {{onData: (chunk: Buffer) => void, getFull: () => string}} The helper.
 */
function makeOutput(prefix) {
  let carry = "";
  let full = "";
  return {
    onData(chunk) {
      const s = chunk.toString();
      full += s;
      carry += s;
      let nl;
      while ((nl = carry.indexOf("\n")) !== -1) {
        const line = carry.slice(0, nl);
        carry = carry.slice(nl + 1);
        if (line.trim()) harness.logLine(`${prefix} ${line}`);
      }
    },
    getFull() {
      return full;
    },
  };
}

/**
 * Run an executable hook file, streaming its output into the run log. Resolves
 * when the process exits 0, rejects with a descriptive error otherwise.
 *
 * @param {string} filePath - Absolute path to the executable hook file.
 * @param {HookContext} ctx - The hook context (for the injected env + logging).
 * @returns {Promise<void>}
 */
function execHookFile(filePath, ctx) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...buildEnvOverrides(ctx) };
    const prefix = `[hooks] ${ctx.task} ${ctx.phase}`;
    const so = makeOutput(prefix);
    const se = makeOutput(prefix);

    const timeoutMs = hookTimeoutMs();
    const child = execFile(filePath, [], {
      env,
      cwd: PROJECT_ROOT,
      maxBuffer: 64 * 1024 * 1024,
      // A hung hook must not block the run forever; the child is killed after
      // this long (0 = no bound, honouring an explicit opt-out).
      ...(timeoutMs > 0 ? { timeout: timeoutMs, killSignal: "SIGKILL" } : {}),
    });
    child.stdout.on("data", so.onData);
    child.stderr.on("data", se.onData);
    child.on("error", (e) => {
      if (e.code === "ENOEXEC") {
        reject(
          new Error(
            `${filePath} is not a valid executable — add a shebang ` +
              `(e.g. #!/usr/bin/sh) and chmod +x it.`
          )
        );
      } else if (e.code === "EACCES") {
        reject(new Error(`${filePath} is not executable — chmod +x it.`));
      } else {
        reject(e);
      }
    });
    child.on("close", (code, signal) => {
      if (signal) {
        // Killed by the timeout (or another signal): the hook did not finish.
        reject(
          new Error(
            `${filePath} was killed${signal ? ` with signal ${signal}` : ""} ` +
              `before it finished (timeout of ${timeoutMs} ms). If this hook ` +
              `legitimately runs longer, raise or disable AI_CLIENT_HOOK_TIMEOUT_MS ` +
              `(set it to 0 to disable the bound).`
          )
        );
        return;
      }
      if (code === 0) {
        resolve();
      } else {
        const out = so.getFull();
        const err = se.getFull();
        reject(
          new Error(
            `${filePath} exited with code ${code}${
              out || err ? `\n--- stdout ---\n${out}\n--- stderr ---\n${err}` : ""
            }`
          )
        );
      }
    });
  });
}

/**
 * Run the configured hook for a step + phase (a no-op when none is defined).
 * Handles the skip rules: absent file -> silent skip; not executable -> warn +
 * skip; --dry-run -> skip. Throws when the hook runs and fails.
 *
 * @param {string} task - The step name.
 * @param {"before"|"after"} phase - Which side of the step.
 * @param {HookContext} ctx - The hook context.
 * @returns {Promise<void>}
 */
async function runHook(task, phase, ctx) {
  const hooksDir = getHooksDir();
  const filePath = findHookFile(hooksDir, task, phase);
  const prefix = `[hooks] ${task} ${phase}`;

  if (!filePath) return; // no hook configured -> proceed as normal

  if (ctx.dryRun) {
    harness.logLine(`${prefix}: skipped (dry-run; ${filePath})`);
    return;
  }

  let st;
  try {
    st = fs.statSync(filePath);
  } catch {
    return;
  }
  if (!(st.mode & 0o111)) {
    harness.logLine(
      `${prefix}: WARNING ${filePath} is not executable; skipping ` +
        `(chmod +x it to enable).`
    );
    return;
  }

  harness.logLine(`${prefix}: running ${filePath}`);
  const started = Date.now();
  try {
    await execHookFile(filePath, ctx);
    harness.logLine(`${prefix}: ok (${Date.now() - started}ms)`);
  } catch (err) {
    harness.logLine(`${prefix}: FAILED (${Date.now() - started}ms)`);
    throw err;
  }
}
// ─── Decorator ────────────────────────────────────────────────────────────────

/**
 * Wrap a gulp task so a before/after hook fires around it. This is the single
 * integration point: the four task modules are wrapped (not modified) in
 * gulpfile.js.
 *
 * Lifecycle: before-hook -> task() -> after-hook.
 *   - A before-hook failure aborts before the task runs.
 *   - An after-hook runs even if the task threw; a failed after-hook only
 *     masks the task error when the task had already failed (the task error is
 *     always the one that propagates when the task threw).
 *
 * @param {string} task - The step name (a TASKS entry or PIPELINE_TASK).
 * @param {Function} taskFn - The original (async) gulp task function.
 * @returns {Function} A drop-in async gulp task that fires the hooks.
 */
function withHooks(task, taskFn) {
  return async function hooked(...args) {
    await runHook(task, "before", buildHookContext(task, "before"));

    let taskError = null;
    let result;
    try {
      result = await taskFn(...args);
    } catch (err) {
      taskError = err;
    }

    const afterCtx = buildHookContext(task, "after", {
      succeeded: !taskError,
      error: taskError,
    });
    try {
      await runHook(task, "after", afterCtx);
    } catch (hookErr) {
      if (taskError) {
        harness.logLine(
          `[hooks] ${task} after: hook failed, but the task already failed — ` +
            `keeping the task error.`
        );
      } else {
        throw hookErr;
      }
    }

    if (taskError) throw taskError;
    return result;
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  TASKS,
  PIPELINE_TASK,
  HOOKS_DIR_ENV,
  hookTimeoutMs,
  getHooksDir,
  findHookFile,
  buildHookContext,
  buildEnvOverrides,
  execHookFile,
  runHook,
  withHooks,
};
