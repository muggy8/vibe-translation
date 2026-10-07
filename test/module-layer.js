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

module.exports = { readModuleLayer };
