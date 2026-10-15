/**
 * Read a module's whole LAYER: the file itself plus every module in the folder named
 * after it, at ANY depth inside that folder.
 *
 * Some suites pin a guarantee by reading source text ("glossary.js calls
 * volumeFailureError with its own task name", "consumeEvents handles tool.done").
 * Those guarantees belong to the MODULE, not to whichever file happens to hold the
 * code, and a large module is now split: `glossary.js` is the public face and
 * `glossary/` holds the implementation. Scanning only the face would report a wiring
 * that exists as a missing one — which is the failure mode this repo calls a check
 * that can never report.
 *
 * A split layer nests. `glossary/` is not only files: it holds `glossary/extract/`,
 * `glossary/carry-forward/` and `glossary/settlement/`, and a submodule that outgrew
 * itself splits the same way (AGENTS.md §3). Reading one level down and stopping fixes
 * the first blindness and quietly reintroduces it at the next level — the guarantee is
 * still in a file the scan never opened. So the walk follows the layer all the way
 * down, and it is bounded so it stays a read of ONE module:
 *
 *   - it never leaves the named folder;
 *   - it never follows a symlink, file or directory;
 *   - it never walks a non-implementation directory (`plan/`, `docs/`, anything dotted);
 *   - it stops at `MAX_LAYER_DEPTH` below the named folder, and `test/test-module-layer.js`
 *     pins that no real layer in this repository is deeper than that bound — so the bound
 *     cannot silently truncate a scan today.
 *
 * A module that still keeps everything in one file reads exactly as before. A module
 * that is a submodule of another layer (`character-voice/task.js`) also reads exactly as
 * before: the layer named after it is `character-voice/task/`, and a pin that asks about
 * the ENTRY POINT asks about that file, not about its whole stage. Widening the default
 * to "the folder that contains the file" would widen those pins for the wrong reason —
 * `character-voice/reconcile/fungibility.js` is pinned to read no environment variable,
 * and `character-voice/config.js` legitimately reads `SERIES_LOCATION`.
 */
const fs = require("fs");
const path = require("path");

/**
 * Directories that hold plans, prose or machine state rather than implementation, and so
 * are never part of a module's layer. A dotted name is skipped too.
 * @type {ReadonlySet<string>}
 */
const NON_IMPLEMENTATION_DIRS = new Set(["plan", "docs", "node_modules"]);

/**
 * How far below the named folder the walk may go. Measured on this repository's own tree
 * the deepest implementation folder inside a named layer is ONE deep (glossary/ →
 * glossary/extract/answer.js); the bound is the guard against a pathological tree, not a
 * limit anything reaches today, and `test/test-module-layer.js` pins the real maximum against
 * it so the bound cannot silently truncate a scan.
 * @type {number}
 */
const MAX_LAYER_DEPTH = 4;

/**
 * List every implementation file inside one folder, at any depth inside it.
 *
 * Depth-first, sorted at each level, so the same tree always produces the same list in
 * the same order. Symlinks and non-implementation directories are skipped; the walk
 * never leaves `dir`.
 *
 * @param {string} dir - Absolute path of the folder to walk.
 * @param {number} depth - How deep `dir` sits below the named layer folder (0 for it).
 * @returns {string[]} Absolute paths of every `.js` file found, in stable order.
 */
function walkImplementationFolder(dir, depth) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) continue; // a layer is the folder's own code, not whatever a link points at
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (NON_IMPLEMENTATION_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      if (depth >= MAX_LAYER_DEPTH) continue; // bounded: the walk is a read of one module, not of the repo
      found.push(...walkImplementationFolder(full, depth + 1));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      found.push(full);
    }
  }
  return found;
}

/**
 * The whole layer's FILES: the module itself plus every implementation file inside the
 * folder named after it, at any depth. One function, so the read and the cache-drop can
 * never drift apart — a drop that forgets less than the read reads is a "fresh process"
 * that is not fresh.
 *
 * @param {string} rootDir - The project root (the module lives in it).
 * @param {string} file - The module's file name, relative to rootDir ("glossary.js").
 * @param {string} [folder] - The implementation folder, relative to rootDir. Defaults
 *   to the folder named after the file ("glossary/"); pass it when the layer lives
 *   somewhere else on purpose (harness.js → "ai/"), or when the module is one file of a
 *   layer and the pin is about the whole layer (glossary/store.js → "glossary").
 * @returns {string[]} Absolute paths, the module first, then its folder's files.
 */
function moduleLayerFiles(rootDir, file, folder) {
  const face = path.join(rootDir, file);
  const files = [face];
  const dir = path.join(rootDir, folder || file.replace(/\.js$/, ""));
  if (fs.existsSync(dir) && fs.lstatSync(dir).isDirectory()) {
    // A module that is itself one file of the layer it names (glossary/store.js → "glossary")
    // is met again by the walk. Reading it twice would double every count a pin takes off the
    // joined text, so the layer is a set of files, not a list of visits.
    for (const found of walkImplementationFolder(dir, 0)) {
      if (found !== face) files.push(found);
    }
  }
  return files;
}

/**
 * Read a module's whole layer as one text blob, for a suite that pins a guarantee by
 * grepping source.
 *
 * @param {string} rootDir - The project root (the module lives in it).
 * @param {string} file - The module's file name, relative to rootDir ("glossary.js").
 * @param {string} [folder] - The implementation folder, relative to rootDir. Defaults
 *   to the folder named after the file ("glossary/"); pass it when the layer lives
 *   somewhere else on purpose (harness.js → "ai/").
 * @returns {string} The file's contents plus its whole folder's, joined for text scanning.
 */
function readModuleLayer(rootDir, file, folder) {
  return moduleLayerFiles(rootDir, file, folder).map((p) => fs.readFileSync(p, "utf8")).join("\n");
}

/**
 * Forget a module's whole LAYER, so the next `require` builds it from scratch.
 *
 * A suite that simulates "a fresh process" used to delete one cache entry. A module
 * that is now a face over a folder has several entries, and deleting only the face
 * leaves the implementation's own state — a Map of what this process already
 * measured, the coefficients it settled on — alive behind the reloaded face. That is
 * not a fresh process, and a test that believes it is will assert the wrong thing.
 *
 * The state usually lives in a SUBMODULE, and a submodule splits the same way the
 * module that held it did, so the nested folders have to be forgotten too: dropping the
 * face plus one level reloads `utils/tokens.js` and `utils/tokens/calibration.js` while
 * leaving `utils/tokens/calibration/deep.js` — the file holding the Map — in the cache.
 *
 * @param {string} rootDir - The project root.
 * @param {string} file - The module's file name, relative to rootDir ("utils/tokens.js").
 * @param {string} [folder] - The implementation folder. Defaults to the folder named after the file.
 * @returns {number} How many cache entries were dropped.
 */
function dropModuleLayer(rootDir, file, folder) {
  let dropped = 0;
  for (const target of moduleLayerFiles(rootDir, file, folder)) {
    let resolved;
    try {
      resolved = require.resolve(target);
    } catch {
      continue; // not loadable from here — nothing to forget
    }
    if (require.cache[resolved]) {
      delete require.cache[resolved];
      dropped++;
    }
  }
  return dropped;
}

module.exports = { readModuleLayer, dropModuleLayer, moduleLayerFiles, MAX_LAYER_DEPTH, NON_IMPLEMENTATION_DIRS };
