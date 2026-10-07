/**
 * Landing a patch and undoing one — with git ASKED, not guessed. Only the declared files are staged (never `git add -A`: this repository's tree holds the account owner's in-progress work), and a revert NAMES the files a patch created instead of deleting them, because deleting is Tier C.
 *
 * Part of the patches.js layer (split out of the original single file).
 */

const path = require("path");
const { execFileSync } = require("child_process");

const { ROOT } = require("./rules");
const { normalizeProjectPath, patchTouchesBanned } = require("./path-rules");
const { patchPaths, readPatches, writePatches } = require("./record");

/**
 * The working tree inside `ai-client/`, as git reports it.
 *
 * Scoped on purpose. This repository's working tree is deliberately dirty outside `ai-client/` — the
 * translation output the account owner is working through — and a patch channel that looked at the
 * whole tree would either refuse everything or sweep the corpus into a commit. `git add -A` is never
 * used here for the same reason.
 *
 * @param {string} [root] - The project root.
 * @returns {{files: Array<{status: string, path: string}>, error: string|null}}
 */
function workingTreeChanges(root = ROOT) {
  const repo = gitRootOf(root);
  if (repo.error) return { files: [], error: repo.error };
  const scope = path.relative(repo.root, path.resolve(root)) || ".";
  let out;
  try {
    // `-uall`, not the default: git collapses a folder whose contents are all new into `outer/`, and
    // this list has to name FILES. `commitPatch` compares it against the patch's declared files, and
    // `revertPatch` prints the created ones for the account owner to remove — "the folder `utils/new/`"
    // is not something either of those can act on.
    out = execFileSync("git", ["-C", repo.root, "status", "--porcelain", "-uall", "--", scope], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    return { files: [], error: `git status failed: ${String(err.stderr || err.message).trim()}` };
  }
  const files = out
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.trim())
    .map((line) => ({ status: line.slice(0, 2).trim(), path: normalizeProjectPath(line.slice(3).trim()) }))
    .filter((f) => f.path);
  return { files, error: null, repoRoot: repo.root };
}


/**
 * Where the repository actually is, asked of git rather than guessed from the folder layout.
 *
 * `ai-client/` is a subdirectory of this repository, so "the git root" is not `path.resolve(root, "..")`
 * in general — it is whatever git says, which is also what makes the same code work against a throwaway
 * fixture repository in a test.
 *
 * @param {string} [root]
 * @returns {{root: string, error: null} | {root: null, error: string}}
 */
function gitRootOf(root = ROOT) {
  try {
    const out = execFileSync("git", ["-C", path.resolve(root), "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { root: out.trim(), error: null };
  } catch (err) {
    return {
      root: null,
      error:
        `git cannot be read from ${root}: ${String(err.stderr || err.message).trim()}. The patch ` +
        `channel needs git, because "what did this patch change?" is a question about the working tree.`,
    };
  }
}


/**
 * Commit an accepted patch to `main`, staging exactly the files it declared.
 *
 * Only the dev team's CLI calls this. The commit is the acceptance act: until it happens the change is
 * a proposal sitting in a working tree, and the pipeline's own reload boundary (gotcha 66) means the
 * change only becomes the code a run executes when a run starts after it.
 *
 * @param {string} patchId
 * @param {{root?: string, message?: string, paths?: {json: string, markdown: string}}} [opts]
 * @returns {{commit: Object|null, error: string|null, extra?: string[]}}
 */
function commitPatch(patchId, { root = ROOT, message, paths = patchPaths() } = {}) {
  const all = readPatches(paths.json).patches;
  const patch = all.find((p) => p.id === patchId);
  if (!patch) return { commit: null, error: `no patch ${patchId}` };
  if (patch.status !== "accepted") {
    return {
      commit: null,
      error:
        `patch ${patchId} is ${patch.status}. The commit to main is the acceptance act, and only the ` +
        `manager's acceptance opens it.`,
    };
  }
  if (!patch.files || !patch.files.length) {
    return { commit: null, error: `patch ${patchId} declares no files. A commit with no declared paths is a commit of whatever happens to be in the tree.` };
  }

  const tree = workingTreeChanges(root);
  if (tree.error) return { commit: null, error: tree.error };
  const declared = new Set(patch.files.map((f) => normalizeProjectPath(f)));
  const extra = tree.files.map((f) => f.path).filter((f) => !declared.has(f));
  if (extra.length) {
    return {
      commit: null,
      extra,
      error:
        `the working tree holds ${extra.length} change(s) inside ai-client/ that ${patchId} does not name: ` +
        `${extra.map((f) => `\`${f}\``).join(", ")}. Committing now would sweep them into a commit nobody ` +
        `reviewed. Either declare them or put them back.`,
    };
  }

  const banned = patchTouchesBanned(patch.files);
  if (banned.length) {
    return {
      commit: null,
      error: `${patchId} touches files a patch may not edit: ${banned.map((b) => `${b.file} (${b.rule})`).join(", ")}. ${banned[0].because}`,
    };
  }

  const gitRoot = gitRootOf(root);
  if (gitRoot.error) return { commit: null, error: gitRoot.error };
  const args = ["-C", gitRoot.root, "add", "--", ...patch.files];
  try {
    execFileSync("git", args, { stdio: ["ignore", "pipe", "pipe"] });
    execFileSync(
      "git",
      ["-C", gitRoot.root, "commit", "-m", message || commitMessageFor(patch), "--", ...patch.files],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    const hash = execFileSync("git", ["-C", gitRoot.root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    patch.commit = { hash, at: new Date().toISOString(), files: patch.files.slice(), message: message || commitMessageFor(patch) };
    patch.status = "committed";
    patch.updatedAt = patch.commit.at;
    const written = writePatches(all, paths);
    if (written.error) return { commit: null, error: written.error };
    return { commit: patch.commit, error: null };
  } catch (err) {
    return { commit: null, error: `git commit failed: ${String(err.stderr || err.message).trim()}` };
  }
}


/**
 * @param {Patch} patch
 * @returns {string}
 */
function commitMessageFor(patch) {
  return (
    `fix(${patch.step}): ${patch.summary || patch.finding}\n\n` +
    `Ticket ${patch.ticketId}, option ${patch.optionId} (${patch.optionLabel || "unnamed"}).\n` +
    `Why: ${patch.why || "not stated"}\n` +
    `Accepted by ${patch.decision ? patch.decision.decidedBy : "?"}: ${patch.decision ? patch.decision.reason : "no reason recorded"}\n` +
    `Checks: ${(patch.checks || []).map((c) => `${c.id} ${c.passed ? "ok" : `FAILED (${c.exitCode})`}`).join(", ") || "none"}\n` +
    `Could break: ${patch.couldBreak || "not stated"}`
  );
}


/**
 * Put the working tree back after a rejection.
 *
 * Restores the files git tracks. A file the patch CREATED is left in place and named out loud: deleting
 * a file is Tier C (`delete-evidence`), and the patch channel does not get to decide that. The honest
 * failure is the one that says which files are still there and who removes them.
 *
 * @param {string} patchId
 * @param {{root?: string, paths?: {json: string, markdown: string}}} [opts]
 * @returns {{restored: string[], leftBehind: string[], error: string|null}}
 */
function revertPatch(patchId, { root = ROOT, paths = patchPaths() } = {}) {
  const all = readPatches(paths.json).patches;
  const patch = all.find((p) => p.id === patchId);
  if (!patch) return { restored: [], leftBehind: [], error: `no patch ${patchId}` };
  if (patch.status !== "rejected") {
    return { restored: [], leftBehind: [], error: `patch ${patchId} is ${patch.status}. Only a rejected patch is reverted.` };
  }
  const gitRoot = gitRootOf(root);
  if (gitRoot.error) return { restored: [], leftBehind: [], error: gitRoot.error };
  const tree = workingTreeChanges(root);
  if (tree.error) return { restored: [], leftBehind: [], error: tree.error };

  const mine = tree.files.filter((f) => (patch.files || []).includes(f.path));
  const tracked = mine.filter((f) => f.status !== "??");
  const created = mine.filter((f) => f.status === "??");

  /** @type {string[]} */
  const restored = [];
  for (const f of tracked) {
    try {
      execFileSync("git", ["-C", gitRoot.root, "checkout", "--", f.path], { stdio: ["ignore", "pipe", "pipe"] });
      restored.push(f.path);
    } catch (err) {
      return { restored, leftBehind: created.map((c) => c.path), error: `git checkout failed for ${f.path}: ${String(err.stderr || err.message).trim()}` };
    }
  }

  patch.reverted = { restored, leftBehind: created.map((c) => c.path), at: new Date().toISOString() };
  patch.updatedAt = patch.reverted.at;
  writePatches(all, paths);
  return { restored, leftBehind: created.map((c) => c.path), error: null };
}


module.exports = {
  workingTreeChanges,
  gitRootOf,
  commitPatch,
  commitMessageFor,
  revertPatch,
};
