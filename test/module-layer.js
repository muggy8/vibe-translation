/**
 * Read a module's whole LAYER: the file itself plus every module in the folder named
 * after it.
 *
 * Some suites pin a guarantee by reading source text ("glossary.js calls
 * volumeFailureError with its own task name", "consumeEvents handles tool.done").
 * Those guarantees belong to the MODULE, not to whichever file happens to hold the
 * code, and a large module is now split: `glossary.js` is the public face and
 * `glossary/` holds the implementation. Scanning only the face would report a wiring
 * that exists as a missing one — which is the failure mode this repo calls a check
 * that can never report.
 *
 * A module that still keeps everything in one file reads exactly as before.
 */
const fs = require("fs");
const path = require("path");

/**
 * @param {string} rootDir - The project root (the module lives in it).
 * @param {string} file - The module's file name, relative to rootDir ("glossary.js").
 * @param {string} [folder] - The implementation folder, relative to rootDir. Defaults
 *   to the folder named after the file ("glossary/"); pass it when the layer lives
 *   somewhere else on purpose (harness.js → "ai/").
 * @returns {string} The file's contents plus its folder's, joined for text scanning.
 */
function readModuleLayer(rootDir, file, folder) {
  const parts = [fs.readFileSync(path.join(rootDir, file), "utf8")];
  const dir = path.join(rootDir, folder || file.replace(/\.js$/, ""));
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
    for (const name of fs.readdirSync(dir).sort()) {
      if (name.endsWith(".js")) parts.push(fs.readFileSync(path.join(dir, name), "utf8"));
    }
  }
  return parts.join("\n");
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
 * @param {string} rootDir - The project root.
 * @param {string} file - The module's file name, relative to rootDir ("utils/tokens.js").
 * @param {string} [folder] - The implementation folder. Defaults to the folder named after the file.
 * @returns {number} How many cache entries were dropped.
 */
function dropModuleLayer(rootDir, file, folder) {
  const targets = [path.join(rootDir, file)];
  const dir = path.join(rootDir, folder || file.replace(/\.js$/, ""));
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
    for (const name of fs.readdirSync(dir).sort()) {
      if (name.endsWith(".js")) targets.push(path.join(dir, name));
    }
  }
  let dropped = 0;
  for (const target of targets) {
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

module.exports = { readModuleLayer, dropModuleLayer };
