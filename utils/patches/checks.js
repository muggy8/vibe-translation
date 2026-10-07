/**
 * The machine runs the checks, because the harness gives an agent no shell. The command comes from the table, never from the caller; a check that never ran is reported as missing, not as failed; and the `npm test` chain is compared before and after the turn, because the banned-path table cannot see a patch that leaves package.json alone and quietly drops a suite.
 *
 * Part of the patches.js layer (split out of the original single file).
 */

const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const { CHECK_TIMEOUT_MS, REQUIRED_CHECKS, ROOT } = require("./rules");
const { patchPaths, readPatches, writePatches } = require("./record");

/**
 * The `npm test` chain may only grow. A patch that removes a test file from it is refused by name.
 *
 * @param {string} before - The `npm test` script as it was.
 * @param {string} after - The `npm test` script as the patch left it.
 * @returns {{ok: boolean, removed: string[], added: string[]}}
 */
function testChainIsIntact(before, after) {
  const filesOf = (script) =>
    String(script || "")
      .split("&&")
      .map((part) => {
        const m = part.match(/node\s+([^\s]+\.js)/);
        return m ? m[1].replace(/\\/g, "/") : null;
      })
      .filter(Boolean);
  const was = filesOf(before);
  const now = filesOf(after);
  const removed = was.filter((f) => !now.includes(f));
  const added = now.filter((f) => !was.includes(f));
  return { ok: removed.length === 0, removed, added };
}


/**
 * The `npm test` script as it currently stands in `package.json`.
 *
 * Read before the dev turn and again after it, so `testChainIsIntact` can answer the question the
 * banned-path list cannot: a patch is not allowed to edit `package.json`'s test chain at all, but the
 * chain is also what the gate runs, so a chain that quietly lost a suite has to be caught even by a
 * patch that never names `package.json` in its proposal.
 *
 * @param {string} [root]
 * @returns {{script: string|null, error: string|null}}
 */
function readTestChain(root = ROOT) {
  try {
    const raw = fs.readFileSync(path.join(root, "package.json"), "utf8");
    const pkg = JSON.parse(raw);
    return { script: (pkg.scripts && pkg.scripts.test) || "", error: null };
  } catch (err) {
    return { script: null, error: `cannot read the npm test chain from ${root}/package.json: ${err.message}` };
  }
}

// ─── Reading it ───────────────────────────────────────────────────────────────


/**
 * Judge a set of recorded checks. A patch is verifiable only when every pinned command ran and exited 0.
 *
 * @param {PatchCheck[]} checks
 * @returns {{accepted: boolean, missing: string[], failed: string[]}}
 */
function judgeChecks(checks) {
  const ran = checks || [];
  const missing = REQUIRED_CHECKS.filter((c) => !ran.some((r) => r.id === c.id)).map((c) => c.id);
  const failed = ran
    .filter((r) => !r.passed)
    .map((r) => (r.exitCode === null ? `${r.id} did not run` : `${r.id} exited ${r.exitCode}`));
  return { accepted: missing.length === 0 && failed.length === 0, missing, failed };
}


/**
 * Record the result of the pinned checks on a patch.
 *
 * The commands are run by `runChecks` in this module and the result reaches the patch only through
 * `recordChecks`. A proposal cannot be accepted while a check is missing or failed — the point of
 * running them is that the team does not get to say it ran them.
 *
 * @param {string} patchId
 * @param {PatchCheck[]} checks
 * @param {{json: string, markdown: string}} [paths]
 * @returns {{patch: Patch|null, verdict: Object, error: string|null}}
 */
function recordChecks(patchId, checks, paths = patchPaths()) {
  const all = readPatches(paths.json).patches;
  const patch = all.find((p) => p.id === patchId);
  if (!patch) return { patch: null, verdict: judgeChecks([]), error: `no patch ${patchId}` };
  if (patch.status !== "proposed" && patch.status !== "verified") {
    return { patch: null, verdict: judgeChecks(patch.checks || []), error: `patch ${patchId} is ${patch.status}; its checks are not re-run after a decision.` };
  }
  patch.checks = normalizeChecks(checks);
  patch.checkVerdict = judgeChecks(patch.checks);
  patch.status = patch.checkVerdict.accepted ? "verified" : "proposed";
  patch.updatedAt = new Date().toISOString();
  const written = writePatches(all, paths);
  return { patch: written.error ? null : patch, verdict: patch.checkVerdict, error: written.error || null };
}


/**
 * Put a recorded check into the shape the record stores, from the pinned table rather than from the
 * caller's claim.
 *
 * The command a check claims to have run is not stored verbatim: it is taken from `REQUIRED_CHECKS`, so
 * a record cannot quietly report a different (softer) command than the one that was pinned. An id that
 * is not pinned is dropped, and `judgeChecks` then reports it as missing — a check that is not on the
 * list is not a check.
 *
 * @param {Array<Object>} checks
 * @returns {PatchCheck[]}
 */
function normalizeChecks(checks) {
  const out = [];
  for (const raw of checks || []) {
    const pinned = REQUIRED_CHECKS.find((c) => c.id === (raw && raw.id));
    if (!pinned) continue;
    const exitCode = Number.isInteger(raw.exitCode) ? raw.exitCode : null;
    out.push({
      id: pinned.id,
      command: `${pinned.command} ${pinned.args.join(" ")}`.trim(),
      exitCode,
      passed: exitCode === 0,
      tail: String(raw.tail || "").slice(-4000),
      at: raw.at || new Date().toISOString(),
    });
  }
  return out;
}


/**
 * Run the pinned checks. The machine runs them; the team does not get to say it ran them.
 *
 * Lives here rather than in `fix.js` for two reasons: it is the half of the patch channel a test can
 * exercise without a model, and `fix.js` is meant to stay thin.
 *
 * The `checks` argument NARROWS which pinned commands to run; it cannot replace one. Each entry is
 * looked up in `REQUIRED_CHECKS` by id and the pinned command is what gets executed, so a caller that
 * handed this function `{id: "npm-test", command: "echo ok"}` would still get `npm test` run, and its
 * real exit code recorded. Combined with `normalizeChecks` (which re-derives the command on the way
 * into the record), there is no path through this module that reports a softer gate than the pinned one.
 *
 * Run through a shell because `npm` is a `.cmd` shim on Windows and a bare spawn does not resolve it.
 * The command string comes from `REQUIRED_CHECKS`, a code constant, never from a proposal.
 *
 * @param {{root?: string, checks?: Array<{id: string}>, timeoutMs?: number}} [opts]
 * @returns {PatchCheck[]} - One record per pinned command that ran, in the pinned order.
 */
function runChecks({ root = ROOT, checks = REQUIRED_CHECKS, timeoutMs = CHECK_TIMEOUT_MS } = {}) {
  const wanted = new Set((checks || []).map((c) => c && c.id));
  const out = [];
  for (const pinned of REQUIRED_CHECKS) {
    if (wanted.size && !wanted.has(pinned.id)) continue;
    const command = `${pinned.command} ${pinned.args.join(" ")}`.trim();
    let res;
    try {
      res = spawnSync(command, { shell: true, cwd: root, encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
    } catch (err) {
      res = { error: err, status: undefined, stdout: "", stderr: String(err && err.message) };
    }
    const exitCode = res.status === undefined || res.error ? null : res.status;
    const tail = `${res.stdout || ""}${res.stderr || ""}`.slice(-4000);
    const record = {
      id: pinned.id,
      command,
      exitCode,
      passed: exitCode === 0,
      tail: exitCode === 0 ? "" : tail,
      at: new Date().toISOString(),
    };
    if (res.error) record.note = `the check could not be started: ${res.error.message}`;
    else if (exitCode !== null && exitCode !== 0 && res.signal) record.note = `the check was killed by ${res.signal}`;
    out.push(record);
  }
  return out;
}

// ─── The manager's judgment ───────────────────────────────────────────────────


module.exports = {
  testChainIsIntact,
  readTestChain,
  judgeChecks,
  recordChecks,
  normalizeChecks,
  runChecks,
};
