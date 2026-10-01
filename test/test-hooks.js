/**
 * test-hooks.js — self-checks for the per-machine pipeline hook runner in
 * utils/hooks.js. Run with `npm test`. No AI, no network; the executable-hook
 * tests use trivial shell scripts in a temporary directory.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  TASKS,
  PIPELINE_TASK,
  HOOKS_DIR_ENV,
  hookTimeoutMs,
  getHooksDir,
  findHookFile,
  buildHookContext,
  buildEnvOverrides,
  execHookFile,
  withHooks,
} = require("../utils/hooks");

// ─── temp-dir helpers ─────────────────────────────────────────────────────────

const tmpDirs = [];
function makeTmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ai-client-hooks-"));
  tmpDirs.push(d);
  return d;
}
function writeHook(dir, name, body, mode = 0o755) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body, "utf8");
  fs.chmodSync(p, mode);
  return p;
}
function cleanup() {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
}

// ─── constants ────────────────────────────────────────────────────────────────

assert.deepStrictEqual(
  TASKS,
  [
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
  ]
);
assert.strictEqual(PIPELINE_TASK, "pipeline");
assert.strictEqual(HOOKS_DIR_ENV, "AI_CLIENT_HOOKS_DIR");

// ─── getHooksDir ──────────────────────────────────────────────────────────────

{
  const prev = process.env[HOOKS_DIR_ENV];
  delete process.env[HOOKS_DIR_ENV];
  const def = getHooksDir();
  assert.ok(def.endsWith(path.join("hooks")), `default dir should end in hooks: ${def}`);
  process.env[HOOKS_DIR_ENV] = "/custom/hooks";
  assert.strictEqual(getHooksDir(), path.resolve("/custom/hooks"));
  if (prev === undefined) delete process.env[HOOKS_DIR_ENV];
  else process.env[HOOKS_DIR_ENV] = prev;
}

// ─── findHookFile ─────────────────────────────────────────────────────────────

{
  const dir = makeTmpDir();
  assert.strictEqual(findHookFile(dir, "glossary", "before"), null, "absent -> null");

  writeHook(dir, "pre-glossary", "#!/usr/bin/sh\ntrue\n");
  assert.strictEqual(
    findHookFile(dir, "glossary", "before"),
    path.join(dir, "pre-glossary"),
    "bare name is found"
  );

  const dir2 = makeTmpDir();
  writeHook(dir2, "post-glossary.sh", "#!/usr/bin/sh\ntrue\n");
  assert.strictEqual(
    findHookFile(dir2, "glossary", "after"),
    path.join(dir2, "post-glossary.sh"),
    ".sh fallback when the bare name is absent"
  );
  writeHook(dir2, "post-glossary", "#!/usr/bin/sh\ntrue\n");
  assert.strictEqual(
    findHookFile(dir2, "glossary", "after"),
    path.join(dir2, "post-glossary"),
    "bare name wins over .sh"
  );

  const dir3 = makeTmpDir();
  writeHook(dir3, "pre-pipeline.js", "#!/usr/bin/env node\n");
  assert.strictEqual(
    findHookFile(dir3, PIPELINE_TASK, "before"),
    path.join(dir3, "pre-pipeline.js"),
    ".js is found"
  );
}
// ─── buildHookContext ─────────────────────────────────────────────────────────

{
  const prevSeries = process.env.SERIES_LOCATION;
  const prevName = process.env.SERIES_NAME;
  process.env.SERIES_LOCATION = "/series";
  process.env.SERIES_NAME = "demo";
  process.argv.push("--dry-run", "--volume", "03");
  try {
    const ctx = buildHookContext("glossary", "before");
    assert.strictEqual(ctx.task, "glossary");
    assert.strictEqual(ctx.phase, "before");
    assert.strictEqual(ctx.seriesName, "demo");
    assert.ok(ctx.seriesDir.endsWith(path.join("series")), `seriesDir: ${ctx.seriesDir}`);
    assert.strictEqual(ctx.dryRun, true);
    assert.strictEqual(ctx.volume, "03");
    assert.strictEqual(ctx.succeeded, undefined);
  } finally {
    // Pop exactly the three args pushed above (in reverse order).
    process.argv.pop();
    process.argv.pop();
    process.argv.pop();
    if (prevSeries === undefined) delete process.env.SERIES_LOCATION;
    else process.env.SERIES_LOCATION = prevSeries;
    if (prevName === undefined) delete process.env.SERIES_NAME;
    else process.env.SERIES_NAME = prevName;
  }
}

// ─── buildEnvOverrides ────────────────────────────────────────────────────────

{
  const base = {
    task: "glossary",
    phase: "after",
    seriesDir: "/series",
    seriesName: "demo",
    dryRun: false,
    force: true,
    chunked: false,
    volume: "02",
  };
  const before = buildEnvOverrides({ ...base, phase: "before", succeeded: undefined, error: null });
  assert.strictEqual(before.AI_CLIENT_PHASE, "before");
  assert.strictEqual(before.AI_CLIENT_TASK_SUCCEEDED, "");
  assert.strictEqual(before.AI_CLIENT_TASK_ERROR, "");

  const afterOk = buildEnvOverrides({ ...base, succeeded: true, error: null });
  assert.strictEqual(afterOk.AI_CLIENT_TASK_SUCCEEDED, "1");
  assert.strictEqual(afterOk.AI_CLIENT_FORCE, "1");
  assert.strictEqual(afterOk.AI_CLIENT_CHUNKED, "0");
  assert.strictEqual(afterOk.AI_CLIENT_VOLUME, "02");

  const afterFail = buildEnvOverrides({ ...base, succeeded: false, error: new Error("boom\nmore") });
  assert.strictEqual(afterFail.AI_CLIENT_TASK_SUCCEEDED, "0");
  assert.strictEqual(afterFail.AI_CLIENT_TASK_ERROR, "boom");
}
// ─── executable-hook lifecycle (withHooks) ───────────────────────────────────

(async () => {
  const marker = (dir) => path.join(dir, "marker.log");

  // Happy path: before -> task -> after.
  {
    const dir = makeTmpDir();
    const m = marker(dir);
    process.env[HOOKS_DIR_ENV] = dir;
    writeHook(dir, "pre-glossary", `#!/usr/bin/sh\necho before >> "${m}"\n`);
    writeHook(dir, "post-glossary", `#!/usr/bin/sh\necho after >> "${m}"\n`);
    let taskRan = false;
    const hooked = withHooks("glossary", async () => {
      taskRan = true;
      return "RESULT";
    });
    const res = await hooked();
    assert.strictEqual(res, "RESULT");
    assert.strictEqual(taskRan, true);
    assert.strictEqual(fs.readFileSync(m, "utf8"), "before\nafter\n");
    delete process.env[HOOKS_DIR_ENV];
  }

  // Before-hook fails -> task never runs, error propagates.
  {
    const dir = makeTmpDir();
    process.env[HOOKS_DIR_ENV] = dir;
    writeHook(dir, "pre-glossary", "#!/usr/bin/sh\necho boom >&2\nexit 3\n");
    let taskRan = false;
    const hooked = withHooks("glossary", async () => {
      taskRan = true;
    });
    await assert.rejects(hooked(), /exited with code 3/);
    assert.strictEqual(taskRan, false, "task must not run when the before-hook fails");
    delete process.env[HOOKS_DIR_ENV];
  }

  // Task fails -> after-hook still runs, task error propagates.
  {
    const dir = makeTmpDir();
    const m = marker(dir);
    process.env[HOOKS_DIR_ENV] = dir;
    writeHook(dir, "post-glossary", `#!/usr/bin/sh\necho after >> "${m}"\n`);
    const hooked = withHooks("glossary", async () => {
      throw new Error("TASK FAILED");
    });
    await assert.rejects(hooked(), /TASK FAILED/);
    assert.strictEqual(fs.readFileSync(m, "utf8"), "after\n", "after-hook must run even when the task fails");
    delete process.env[HOOKS_DIR_ENV];
  }

  // After-hook fails (task ok) -> hook error propagates.
  {
    const dir = makeTmpDir();
    process.env[HOOKS_DIR_ENV] = dir;
    writeHook(dir, "post-glossary", "#!/usr/bin/sh\nexit 5\n");
    const hooked = withHooks("glossary", async () => "ok");
    await assert.rejects(hooked(), /exited with code 5/);
    delete process.env[HOOKS_DIR_ENV];
  }

  // After-hook fails (task failed) -> the TASK error wins.
  {
    const dir = makeTmpDir();
    process.env[HOOKS_DIR_ENV] = dir;
    writeHook(dir, "post-glossary", "#!/usr/bin/sh\nexit 5\n");
    const hooked = withHooks("glossary", async () => {
      throw new Error("TASK FAILED");
    });
    await assert.rejects(hooked(), /TASK FAILED/);
    delete process.env[HOOKS_DIR_ENV];
  }

  // No hook file -> runs as normal, no error.
  {
    const dir = makeTmpDir();
    process.env[HOOKS_DIR_ENV] = dir;
    let taskRan = false;
    const hooked = withHooks("glossary", async () => {
      taskRan = true;
      return "ok";
    });
    const res = await hooked();
    assert.strictEqual(res, "ok");
    assert.strictEqual(taskRan, true);
    delete process.env[HOOKS_DIR_ENV];
  }

  // Present but not executable -> skipped, task runs.
  {
    const dir = makeTmpDir();
    process.env[HOOKS_DIR_ENV] = dir;
    writeHook(dir, "pre-glossary", "#!/usr/bin/sh\necho should-not-run\n", 0o644);
    let taskRan = false;
    const hooked = withHooks("glossary", async () => {
      taskRan = true;
      return "ok";
    });
    const res = await hooked();
    assert.strictEqual(res, "ok");
    assert.strictEqual(taskRan, true, "task runs even when the hook is not executable");
    delete process.env[HOOKS_DIR_ENV];
  }

  // --dry-run -> hooks are skipped (task still runs).
  {
    const dir = makeTmpDir();
    const m = marker(dir);
    process.env[HOOKS_DIR_ENV] = dir;
    writeHook(dir, "pre-glossary", `#!/usr/bin/sh\necho before >> "${m}"\n`);
    process.argv.push("--dry-run");
    let taskRan = false;
    try {
      const hooked = withHooks("glossary", async () => {
        taskRan = true;
        return "ok";
      });
      const res = await hooked();
      assert.strictEqual(res, "ok");
      assert.strictEqual(taskRan, true);
      assert.ok(!fs.existsSync(m), "hook must not run under --dry-run");
    } finally {
      process.argv.splice(-1, 1);
      delete process.env[HOOKS_DIR_ENV];
    }
  }

  // env is injected into the hook process.
  {
    const dir = makeTmpDir();
    const m = marker(dir);
    process.env[HOOKS_DIR_ENV] = dir;
    writeHook(
      dir,
      "post-glossary",
      `#!/usr/bin/sh\nprintf '%s|%s|%s|%s\\n' "$AI_CLIENT_TASK" "$AI_CLIENT_PHASE" "$AI_CLIENT_TASK_SUCCEEDED" "$AI_CLIENT_SERIES_NAME" >> "${m}"\n`
    );
    const hooked = withHooks("glossary", async () => "ok");
    await hooked();
    const line = fs.readFileSync(m, "utf8").trim();
    assert.strictEqual(line.split("|")[0], "glossary");
    assert.strictEqual(line.split("|")[1], "after");
    assert.strictEqual(line.split("|")[2], "1");
    delete process.env[HOOKS_DIR_ENV];
  }

  // hookTimeoutMs: default 30 min, overridable, 0 = disabled.
  {
    delete process.env.AI_CLIENT_HOOK_TIMEOUT_MS;
    assert.strictEqual(hookTimeoutMs(), 30 * 60 * 1000, "default is 30 minutes");
    process.env.AI_CLIENT_HOOK_TIMEOUT_MS = "5000";
    assert.strictEqual(hookTimeoutMs(), 5000, "overridable");
    process.env.AI_CLIENT_HOOK_TIMEOUT_MS = "0";
    assert.strictEqual(hookTimeoutMs(), 0, "0 disables the bound");
    process.env.AI_CLIENT_HOOK_TIMEOUT_MS = "not-a-number";
    assert.strictEqual(hookTimeoutMs(), 30 * 60 * 1000, "an invalid value falls back to the default");
    delete process.env.AI_CLIENT_HOOK_TIMEOUT_MS;
  }

  // A hook that hangs is killed by the timeout (a hung hook must not block an
  // un-monitored run forever).
  {
    const dir = makeTmpDir();
    writeHook(dir, "pre-glossary", "#!/usr/bin/sh\nsleep 30\n");
    process.env[HOOKS_DIR_ENV] = dir;
    process.env.AI_CLIENT_HOOK_TIMEOUT_MS = "700"; // 0.7 s
    let taskRan = false;
    const hooked = withHooks("glossary", async () => {
      taskRan = true;
      return "ok";
    });
    const started = Date.now();
    await assert.rejects(hooked(), /timeout|killed/i);
    assert.ok(Date.now() - started < 2500, "the hook is killed well before its own sleep");
    assert.strictEqual(taskRan, false, "a before-hook timeout stops the task");
    delete process.env.AI_CLIENT_HOOK_TIMEOUT_MS;
    delete process.env[HOOKS_DIR_ENV];
  }

  console.log("hooks: all checks passed");
  cleanup();
})().catch((err) => {
  cleanup();
  console.error(err);
  process.exit(1);
});
