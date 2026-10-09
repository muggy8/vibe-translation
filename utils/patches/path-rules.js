/**
 * Deciding what a path means and refusing the ones that cannot mean it. Specific rule first, catch-all last, so a refusal names WHICH rule it hit — 'not allowed' is not information, and a team that cannot tell which rule it tripped cannot write a usable second proposal (gotcha 75).
 *
 * Part of the patches.js layer (split out of the original single file).
 */

const path = require("path");

const { ANSWER_KEY_FILES, BANNED_PATCH_PATHS, PROJECT_SOURCE_DIRS, ROOT } = require("./rules");

/**
 * Look a banned rule up by id, so a refusal can name the rule it is applying even when the rule is a
 * catch-all rather than a pattern match.
 *
 * @param {string} id
 * @returns {Object|null}
 */
function ruleById(id) {
  return BANNED_PATCH_PATHS.find((rule) => rule.id === id) || null;
}


/**
 * Which banned rule a file hits, if any.
 *
 * @param {string} filePath - Project-relative path (`glossary.js`, `utils/tickets.js`), or an absolute
 *   path that lies under `root`.
 * @param {string} [root] - The folder project-relative means relative to. The dev turn's tool gate
 *   passes its own cwd; everything else uses this project's root.
 * @returns {{banned: boolean, rule: Object|null}}
 */
function patchPathIsBanned(filePath, root = ROOT) {
  const rel = normalizeProjectPath(filePath, root);
  if (!rel) return { banned: true, rule: ruleById("path-outside-project") };

  // The named rules FIRST, each with its own reason, so a refusal can say which rule it hit. A refusal
  // that says "not allowed" without naming the rule is the refusal a reader routes around.
  for (const rule of BANNED_PATCH_PATHS) {
    if (rule.catchAll || !rule.pattern) continue;
    if (rule.pattern.test(rel)) return { banned: true, rule };
  }

  // Everything left that is not project source is the corpus (a staged book, a volume's artifacts, a
  // fixture series) — the deliverable, and not a patch target.
  if (!isProjectSourcePath(rel)) return { banned: true, rule: ruleById("edit-corpus") };
  if (corpusIsNamedArtifact(rel)) return { banned: true, rule: ruleById("edit-corpus") };

  return { banned: false, rule: null };
}


/**
 * Which folders and root files are the project's own source, as opposed to what the pipeline produced.
 *
 * Written as a whitelist rather than a blacklist on purpose: `ai-client/` also holds generated output
 * (`test-series/`, a series' `.run/` records folder), and a patch channel whose default is "allowed unless
 * listed" would default to editing the run's own evidence.
 *
 * @param {string} rel - A normalized, project-relative path.
 * @returns {boolean}
 */
function isProjectSourcePath(rel) {
  if (PROJECT_SOURCE_DIRS.some((dir) => rel.startsWith(dir))) return true;
  // Root-level modules and the two documents that describe them. A folder name is not a file: a path
  // with a slash in it is either a source folder above or something the pipeline generated.
  return /^[^/]+\.(?:js|md|json)$/.test(rel);
}


/**
 * A generated artifact of the pipeline, wherever it sits (`test-series/…`, a fixture series folder).
 * Those are output, and output is not a patch target.
 *
 * Deliberately NOT applied to the prompt files: `system-prompts/glossary.md` is source that a patch may
 * legitimately change, and it shares a name with the artifact the glossary task writes.
 *
 * @param {string} rel
 * @returns {boolean}
 */
function corpusIsNamedArtifact(rel) {
  return (
    rel.startsWith("test-series/") ||
    rel.includes("/test_story") ||
    rel.endsWith(".rejected") ||
    rel.endsWith(".rejected.md") ||
    rel.endsWith(".rejected-passage.md") ||
    rel.endsWith(".provenance.json") ||
    rel.endsWith("-rolling-state.json") ||
    rel.endsWith("-bundle.meta.json")
  );
}


/**
 * Every file a patch touches, checked against the banned list.
 *
 * @param {string[]} files
 * @returns {Array<{file: string, because: string, escalateTo: string, rule: string}>}
 */
function patchTouchesBanned(files) {
  const out = [];
  for (const f of files || []) {
    const verdict = patchPathIsBanned(f);
    if (verdict.banned && verdict.rule) {
      out.push({
        file: normalizeProjectPath(f),
        rule: verdict.rule.id,
        because: verdict.rule.because,
        escalateTo: verdict.rule.escalateTo,
      });
    }
  }
  return out;
}


/**
 * Files whose edit has to be declared loudly, because the same edit can weaken the check instead of
 * the thing being checked.
 *
 * @param {string[]} files
 * @returns {Array<{file: string, because: string}>}
 */
function patchTouchesAnswerKey(files) {
  const out = [];
  for (const f of files || []) {
    const rel = normalizeProjectPath(f);
    for (const key of ANSWER_KEY_FILES) {
      if (key.pattern.test(rel)) out.push({ file: rel, because: key.because });
    }
  }
  return out;
}

// ─── The proposal contract ────────────────────────────────────────────────────


/**
 * Normalise a path to project-relative forward slashes, and reject the ones that cannot mean that.
 *
 * An absolute path is resolved against `root` rather than refused outright: the dev team's brief names
 * the project root in full, and a channel that refused every path the role was told to use would refuse
 * the work, not the danger. An absolute path that is genuinely outside `root` still returns `null`,
 * which is what makes `path-outside-project` the refusal it is.
 *
 * @param {string} p
 * @param {string} [root]
 * @returns {string|null}
 */
function normalizeProjectPath(p, root = ROOT) {
  const raw = String(p || "").trim();
  // An absolute path is not automatically outside the project. `renderTicketForDev` names the project
  // root in full, so a dev team that uses the path it was handed must land inside the project, not be
  // refused for every write it attempts. An absolute path OUTSIDE the root is still `null`, because
  // `null` is what makes `path-outside-project` the refusal it is.
  if (path.isAbsolute(raw)) {
    const relToRoot = path.relative(path.resolve(root), path.normalize(raw)).replace(/\\/g, "/");
    if (!relToRoot || relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) return null;
    return relToRoot.replace(/^ai-client\//, "") || null;
  }
  let rel = raw.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  if (rel.startsWith("../") || rel.startsWith("~/")) return null;
  while (rel.startsWith("./")) rel = rel.slice(2);
  if (!rel) return null;
  if (rel.split("/").includes("..")) return null;
  // Strip the `ai-client/` prefix a git path from the repository root carries.
  if (rel.startsWith("ai-client/")) rel = rel.slice("ai-client/".length);
  return rel || null;
}


module.exports = {
  ruleById,
  patchPathIsBanned,
  isProjectSourcePath,
  corpusIsNamedArtifact,
  patchTouchesBanned,
  patchTouchesAnswerKey,
  normalizeProjectPath,
};
