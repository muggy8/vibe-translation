/**
 * The file sandbox and the file-tool contract.
 *
 * createGatedFsTools hands out exactly five tools (readFile / listFiles / grep /
 * writeFile / editFile); deleteFile is not offered and the gate refuses it anyway.
 * Writes are confined to the volume folder, reads are allowed anywhere (an agent
 * needs the previous volume).
 *
 * applyFsToolContract fixes the three ways a model reaches for these tools
 * incorrectly (gotcha 60): grep/listFiles take a FOLDER (a file passed as dirPath
 * crashed with ENOTDIR 40 times in one live run), grep's glob is a filename ENDING
 * (a model writing "*.md" matched NOTHING 398 times and reported "no matches"), and
 * an archive is refused as text (the library's binary list does not know .epub).
 * The normalization runs INSIDE the approve gate, so a repaired path can never slip
 * past a gate that judged the agent's original one.
 *
 * Part of the harness.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
require("../types"); // JSDoc type definitions

const { loadEsm } = require("./provider");
const { envMaxLineLength, envMaxReadBytes } = require("./env");

/** The grep contract, stated where the model will read it. */
const GREP_TOOL_DESCRIPTION =
  "Search file contents with a regex pattern. dirPath is a DIRECTORY to search " +
  "from (defaults to your working folder) and must NOT be a file path — to " +
  "search one file, pass its folder and narrow with glob. glob is a filename " +
  "ENDING (e.g. \".md\" or \"whole.md\"), NOT a wildcard pattern: \"*.md\" " +
  "matches nothing. Searches recursively, skipping node_modules and .git. " +
  "Returns matching lines with file paths and line numbers. Large result sets " +
  "are paginated automatically; use offset and limit to continue.";


/** The listFiles contract, stated where the model will read it. */
const LIST_FILES_TOOL_DESCRIPTION =
  "List files and directories at the given path. dirPath is a DIRECTORY " +
  "(defaults to your working folder) and must NOT be a file path. Set recursive " +
  "to true to walk subdirectories. Large results are paginated automatically; " +
  "use offset and limit to continue.";


/**
 * Repair the two ways an agent misuses a directory-taking file tool (see the
 * contract note above). Pure about shape; it only inspects the filesystem to
 * tell a file from a folder.
 *
 * @param {{input: Object, cwd: string, toolName: string}} cfg
 * @returns {Promise<{input: Object, notes: string[]}>} The input to hand the
 *   library tool, plus the notes that must be shown to the agent.
 */
async function normalizeDirToolInput({ input, cwd, toolName }) {
  const out = { ...(input || {}) };
  const notes = [];
  const rawDir = typeof out.dirPath === "string" ? out.dirPath.trim() : "";
  const resolved = path.resolve(cwd, rawDir || ".");

  let st = null;
  try {
    st = await fs.promises.stat(resolved);
  } catch {
    st = null; // a missing path is the library's problem to report, not ours
  }
  if (st && st.isFile()) {
    const name = path.basename(resolved);
    out.dirPath = path.dirname(resolved);
    if (toolName === "grep") out.glob = name;
    notes.push(
      `Note: ${toolName} takes a FOLDER, not a single file — "${rawDir}" is a ` +
        `file, so it ran over that file's folder` +
        (toolName === "grep" ? ` limited to "${name}".` : ".")
    );
  }

  // grep's glob is a suffix. Take the last path segment and drop a leading
  // wildcard, which is the shape every model reaches for.
  if (toolName === "grep" && typeof out.glob === "string" && out.glob.trim() !== "") {
    const raw = out.glob.trim();
    const suffix = raw.split(/[\\/]/).pop().replace(/^\*+/, "");
    if (suffix === "") {
      delete out.glob;
      notes.push(
        `Note: grep's glob matches a filename ENDING, so "${raw}" would match ` +
          `nothing; the search ran over every file in the folder.`
      );
    } else if (suffix !== raw) {
      out.glob = suffix;
      notes.push(
        `Note: grep's glob matches a filename ENDING, not a wildcard pattern — ` +
          `"${raw}" was read as the suffix "${suffix}".`
      );
    }
  }

  return { input: out, notes };
}


/**
 * Pre-flight an agent's grep pattern. The library compiles it with `new
 * RegExp`, so a pattern using another dialect's inline flags (the common one is
 * `(?i)`) throws a raw SyntaxError at the agent. Answer with the usable form
 * instead, naming the flag the tool actually has.
 *
 * @param {Object} input - The normalized grep input.
 * @returns {{error: string}|null} The error to return instead of searching, or
 *   null when the pattern compiles.
 */
function grepPatternError(input) {
  const pattern = typeof input?.pattern === "string" ? input.pattern : null;
  if (pattern === null) return null; // the library reports the missing argument
  try {
    new RegExp(pattern, input.ignoreCase ? "i" : undefined);
    return null;
  } catch (err) {
    return {
      error:
        `grep could not compile /${pattern}/ (${err.message}). This tool uses ` +
        `JavaScript regular expressions: there is no inline (?i) flag — pass ` +
        `ignoreCase: true instead. To search a literal string, escape it.`,
      pattern,
      matchCount: 0,
      matches: [],
    };
  }
}


/**
 * Archive formats the plain file tools must not decode as text. The library's
 * own binary list knows about `.zip` but NOT about `.epub`, which is the format
 * this whole pipeline works in.
 */
const ARCHIVE_EXTENSIONS = new Set([".epub", ".zip", ".7z", ".rar", ".tar", ".gz", ".pdf"]);


/**
 * True for a path the plain file tools must not treat as text.
 * @param {unknown} filePath
 * @returns {boolean}
 */
function isArchivePath(filePath) {
  return ARCHIVE_EXTENSIONS.has(path.extname(String(filePath || "")).toLowerCase());
}


/**
 * Wrap an fs provider so the plain text tools cannot read a book archive as
 * text. The library's binary-file list does not know about `.epub`, so a grep
 * over a volume folder (which holds the staged book) or the series root (which
 * holds all 17 of them) would decode zip bytes as UTF-8 and report matches from
 * the noise. This is the rule the intake brief already states ("the file tools
 * REFUSE .epub paths"), enforced where it can actually be enforced.
 *
 * A refused read is what the library's grep wants: it catches the failure and
 * skips the file, so a folder search simply stops seeing books.
 *
 * @param {import("@openharness/core").FsProvider} provider
 * @returns {import("@openharness/core").FsProvider} The same provider with a
 *   book-aware readFile.
 */
function withBookAwareReads(provider) {
  return {
    resolvePath: (p) => provider.resolvePath(p),
    readFile: async (p) => {
      if (isArchivePath(p)) {
        throw new Error(archiveReadMessage(p));
      }
      return provider.readFile(p);
    },
    writeFile: (p, content) => provider.writeFile(p, content),
    exists: (p) => provider.exists(p),
    stat: (p) => provider.stat(p),
    readdir: (p) => provider.readdir(p),
    mkdir: (p, options) => provider.mkdir(p, options),
    remove: (p, options) => provider.remove(p, options),
    rename: (from, to) => provider.rename(from, to),
  };
}


/**
 * The refusal a text tool gives for a book archive, phrased as the fix.
 * @param {string} filePath
 * @returns {string}
 */
function archiveReadMessage(filePath) {
  return (
    `"${filePath}" is an archive, not a text file — the plain file tools read ` +
    `text only. A staged book is read through the epub tools (epubInfo / ` +
    `readEpubText), never as text.`
  );
}


/**
 * Re-describe and repair the read tools. Applied BEFORE the approve gate sees
 * the call (the gate wraps this execute), so a repaired path can never slip past
 * a gate that judged the agent's original path.
 *
 * @param {Object} fsTools - The tools from core.createFsTools.
 * @param {string} cwd - The folder the library resolves relative paths against.
 * @returns {Object} The same tool set with grep, listFiles and readFile replaced.
 */
function applyFsToolContract(fsTools, cwd) {
  const wrapped = { ...fsTools };
  for (const [toolName, description] of [
    ["grep", GREP_TOOL_DESCRIPTION],
    ["listFiles", LIST_FILES_TOOL_DESCRIPTION],
  ]) {
    const original = fsTools[toolName];
    if (!original || typeof original.execute !== "function") continue;
    wrapped[toolName] = {
      ...original,
      description,
      execute: async (input, options) => {
        const fixed = await normalizeDirToolInput({ input, cwd, toolName });
        if (toolName === "grep") {
          const bad = grepPatternError(fixed.input);
          if (bad) return bad;
        }
        const result = await original.execute(fixed.input, options);
        if (fixed.notes.length > 0 && result && typeof result === "object") {
          result.status = [fixed.notes.join(" "), result.status].filter(Boolean).join(" ");
        }
        return result;
      },
    };
  }
  // readFile: an archive answers with the reason it cannot be read, rather than
  // the provider's throw (which the library re-raises as a tool error).
  const readFile = fsTools.readFile;
  if (readFile && typeof readFile.execute === "function") {
    wrapped.readFile = {
      ...readFile,
      description:
        "Read the contents of a TEXT file. Returns the text content with line " +
        "numbers. Archives (.epub, .zip) are not text files and cannot be read " +
        "with this tool. For large files, use offset and limit to read specific " +
        "line ranges.",
      execute: async (input, options) => {
        if (isArchivePath(input && input.filePath)) {
          return { error: archiveReadMessage(String(input.filePath)) };
        }
        return readFile.execute(input, options);
      },
    };
  }

  return wrapped;
}


/**
 * Build the filesystem tools (readFile/listFiles/grep/writeFile/editFile/
 * deleteFile) with an open-harness approve() gate:
 *
 * - reads (readFile, listFiles, grep) are always allowed, with the line and byte
 *   caps raised from the library defaults (see {@link envMaxLineLength} and
 *   {@link envMaxReadBytes}) so an agent can read a whole cumulative artifact,
 *   and with the file-tool contract applied (see the note above: grep and
 *   listFiles take a FOLDER, grep's glob is a filename ending, and an archive is
 *   not a text file);
 * - writes/edits are confined to `allowedDirs` (paths resolved relative to
 *   `cwd`), so a wandering agent cannot clobber the rest of the series, and never
 *   over an archive — a staged book is the source the pipeline exists to
 *   translate, and the volume folder is where the book lives;
 * - deleteFile is NOT offered at all (see {@link withoutDeleteFile}) and the gate
 *   refuses it outright if anything still reaches for it — no workflow lets an
 *   agent delete.
 *
 * @param {{cwd?: string, allowedDirs: string[]}} cfg
 * @returns {Promise<{tools: Object, approve: Function}>}
 */
async function createGatedFsTools({ cwd = process.cwd(), allowedDirs }) {
  if (!Array.isArray(allowedDirs) || allowedDirs.length === 0) {
    throw new Error("createGatedFsTools requires a non-empty allowedDirs array.");
  }
  const { core } = await loadEsm();
  // The caps are raised from the library defaults (2000 chars/line, 32 KB/read):
  // the cumulative artifacts hold lines longer than 2000 chars, and an agent that
  // cannot faithfully re-read what it must preserve starts rewriting it from
  // memory. See envMaxLineLength / envMaxReadBytes.
  const fsTools = core.createFsTools(withBookAwareReads(new core.NodeFsProvider({ cwd })), {
    maxLineLength: envMaxLineLength(),
    maxOutputBytes: envMaxReadBytes(),
  });
  const allowed = allowedDirs.map((dir) => path.resolve(dir));
  const approve = (call) => {
    const mutating =
      call.toolName === "writeFile" ||
      call.toolName === "editFile" ||
      call.toolName === "deleteFile";
    if (!mutating) return true;
    if (call.toolName === "deleteFile") return false;
    const raw = call.input?.filePath;
    if (typeof raw !== "string" || raw.length === 0) return false;
    // A staged book is the source the whole pipeline exists to translate. The
    // volume folder is where the book lives, so this gate — not only the intake
    // gate — has to refuse writing over it.
    if (isArchivePath(raw)) return false;
    const resolved = path.resolve(cwd, raw);
    return allowed.some(
      (dir) => resolved === dir || resolved.startsWith(dir + path.sep)
    );
  };
  return { tools: withoutDeleteFile(applyFsToolContract(fsTools, cwd)), approve };
}


/**
 * Drop `deleteFile` from a tool set handed to an agent.
 *
 * The approve gate refuses it every time (the WORKFLOW deletes stale strays,
 * never the agent — gotcha 8), so offering it is a promise the sandbox will not
 * keep: the model reaches for it, gets a denial, and spends a step of a capped
 * budget learning that it cannot (observed in the live agent transcripts: turns
 * that reason "could I use deleteFile? No." instead of writing the artifact).
 * It also contradicts {@link AGENT_TOOLS_NOTE}, which names the five tools the
 * agent actually has.
 *
 * The gate's refusal is KEPT: a caller that composes its own tool set (the
 * intake gate) still gets the denial, and a tool that is not advertised can
 * still be refused if a future library version injects it.
 *
 * @param {Object} tools - The wrapped tool map.
 * @returns {Object} The same map without `deleteFile`.
 */
function withoutDeleteFile(tools) {
  if (!tools || !Object.prototype.hasOwnProperty.call(tools, "deleteFile")) return tools;
  const kept = { ...tools };
  delete kept.deleteFile;
  return kept;
}

// ─── Event consumption ──────────────────────────────────────────────────────


module.exports = {
  GREP_TOOL_DESCRIPTION,
  LIST_FILES_TOOL_DESCRIPTION,
  normalizeDirToolInput,
  grepPatternError,
  ARCHIVE_EXTENSIONS,
  isArchivePath,
  withBookAwareReads,
  archiveReadMessage,
  applyFsToolContract,
  createGatedFsTools,
  withoutDeleteFile,
};
