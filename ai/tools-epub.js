/**
 * The intake agent's senses: epubInfo (the book's catalog card), readEpubText (a
 * bounded plain-text slice, capped per call so 17 books cannot blow the context
 * window), and stageVolume (create the volume folder and put the source in it — a
 * RELATIVE shortcut to the original, never a second copy, and never written
 * through a broken shortcut: gotcha 77).
 *
 * Part of the harness.js layer (split out of the original single file).
 */

require("dotenv").config();
const path = require("path");
require("../types"); // JSDoc type definitions
const { tool } = require("ai");
const { z } = require("zod");

/**
 * Build the epub-aware tools the series-intake agent needs to actually look
 * inside a book. The plain filesystem tools cannot do this: readFile rejects
 * binary files and an epub is a zip, so without these the agent could only
 * guess from file names.
 *
 * These tools are deliberately senses, not decisions — they unzip, read, and
 * report. Which files are volumes, what order they go in, what language they
 * are in, and where each volume's artifacts will live are the agent's calls.
 *
 *   - epubInfo(filePath)                 the book's catalog card + section list
 *   - readEpubText(filePath, ...)        a bounded slice of one section's text
 *   - stageVolume({sourceFile, folder, as})
 *                                        create the volume folder and put the
 *                                        source in it — LINKED, not copied (the
 *                                        agent's "put the book where it belongs"
 *                                        action; a copy is the fallback only
 *                                        where this filesystem cannot link)
 *
 * Text comes back in bounded windows (sampleChars per call) on purpose: an
 * agent sampling 17 books must not blow its own context window, and it only
 * needs enough of each opening to tell the books apart.
 *
 * @param {{cwd?: string, allowedDirs: string[], sampleChars?: number}} cfg
 * @returns {Promise<{tools: Object, approve: Function}>} The tool set plus its
 *   approve gate (compose it with createGatedFsTools' gate using AND).
 */
async function createEpubTools({ cwd = process.cwd(), allowedDirs, sampleChars = 1500 }) {
  if (!Array.isArray(allowedDirs) || allowedDirs.length === 0) {
    throw new Error("createEpubTools requires a non-empty allowedDirs array.");
  }
  const fsp = require("fs").promises;
  const crypto = require("crypto");
  const { openEpub, readEpubSection, scriptCounts, isEpubPath, classifyNavEntry } = require("../utils/source");
  const { stageSourceFile } = require("../utils/fs");
  const allowed = allowedDirs.map((dir) => path.resolve(dir));
  const inside = (p) => {
    const resolved = path.resolve(cwd, p);
    return allowed.some((dir) => resolved === dir || resolved.startsWith(dir + path.sep));
  };
  /** Raw (uncompressed) size of a zip entry, when the archive reports one. */
  const entryBytes = (entry) =>
    entry && entry._data && typeof entry._data.uncompressedSize === "number"
      ? entry._data.uncompressedSize
      : null;
  const sha256Of = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

  /**
   * One open book per path, reused across calls (invalidated when the file's
   * mtime/size changes). openEpub reads the whole archive into memory and
   * parses its catalog, so re-opening it on every readEpubText call made an
   * agent that samples a book's opening at three offsets pay for the whole
   * book three times. The cache is bounded: an intake agent works through one
   * series at a time, and a few open archives is all that needs to stay warm.
   */
  const OPEN_CACHE_MAX = 6;
  const openCache = new Map();
  const openBook = async (abs) => {
    const st = await fsp.stat(abs);
    const hit = openCache.get(abs);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.opened;
    const opened = await openEpub(abs);
    if (openCache.size >= OPEN_CACHE_MAX) openCache.delete(openCache.keys().next().value);
    openCache.set(abs, { mtimeMs: st.mtimeMs, size: st.size, opened });
    return opened;
  };

  const tools = {
    epubInfo: tool({
      description:
        "Open an .epub file and report what it is: its catalog card (title, " +
        "author, language tag, publisher, identifier, and the series name and " +
        "book number the reading app embedded), how many readable sections it " +
        "has with their titles, its text size and its image count. Note that " +
        "readableSections counts PAGES: a reflowable book gives every page its " +
        "own entry (cover, illustration plates, notices), so 'contentsList' is " +
        "the book's own list of its sections — that is the chapter count, not " +
        "readableSections.",
      inputSchema: z.object({
        filePath: z
          .string()
          .describe("Path to the .epub file (relative to the working folder)."),
      }),
      execute: async ({ filePath }) => {
        const abs = path.resolve(cwd, filePath);
        try {
          const opened = await openBook(abs);
          const st = await fsp.stat(abs);
          const sections = opened.textItems.map((it) => ({
            index: it.index,
            title: opened.titles.get(it.zipPath) || it.href,
            bytes: entryBytes(opened.zip.file(it.zipPath)),
          }));
          const textBytes = sections.reduce((n, s) => n + (s.bytes || 0), 0);
          // A spine item is a PAGE, not a chapter (see utils/source.js
          // groupSpineIntoChapters): this series' books have 35 pages and 10
          // chapters. Reporting only the page count made the intake agent
          // describe books as "35 sections", so the book's own contents list is
          // reported beside it.
          const contentsList = (opened.navEntries || [])
            .filter((e) => e.inToc !== false && classifyNavEntry(e).chapter)
            .map((e) => e.title);
          return JSON.stringify(
            {
              file: filePath,
              sizeBytes: st.size,
              entries: opened.entryCount,
              images: opened.imageCount,
              readableSections: sections.length,
              contentsList,
              textBytes,
              metadata: opened.metadata,
              sections,
            },
            null,
            1
          );
        } catch (err) {
          return `epubInfo error for ${filePath}: ${err.message}`;
        }
      },
    }),

    readEpubText: tool({
      description:
        `Read the plain text of one readable section of an .epub file as a ` +
        `bounded slice (up to ${sampleChars} characters per call; use offset ` +
        `to move further in). Use it to sample a book's opening: the writing ` +
        `system, any volume/series markers inside the text, and whether the ` +
        `file is prose at all. Returns the text plus a raw count of the ` +
        `scripts seen (kana / hangul / Han / latin) as evidence.`,
      inputSchema: z.object({
        filePath: z.string().describe("Path to the .epub file."),
        section: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("1-based section index (from epubInfo). Default: 1."),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Character offset into the section. Default: 0."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(6000)
          .optional()
          .describe(`Characters to return (default ${sampleChars}, max 6000).`),
      }),
      execute: async ({ filePath, section, offset, limit }) => {
        const abs = path.resolve(cwd, filePath);
        try {
          const opened = await openBook(abs);
          const slice = await readEpubSection(opened, section || 1, {
            offset: offset || 0,
            limit: Math.min(limit || sampleChars, 6000),
          });
          return JSON.stringify(
            {
              file: filePath,
              section: slice.index,
              title: slice.title,
              totalChars: slice.totalChars,
              from: slice.from,
              scripts: scriptCounts(slice.text),
              text: slice.text,
            },
            null,
            1
          );
        } catch (err) {
          return `readEpubText error for ${filePath}: ${err.message}`;
        }
      },
    }),

    stageVolume: tool({
      description:
        "Create a volume folder inside the series location and put a source " +
        "file in it — the action that lays the series out for the rest of " +
        "the pipeline. The book is LINKED, not copied: the folder gets its own " +
        "name for the same stored file, so a series does not cost twice its " +
        "bytes (where linking is not possible on this filesystem, a copy is " +
        "made instead and the answer says so). The original file is never " +
        "moved or modified. Re-staging the same content is a no-op; staging a " +
        "DIFFERENT file over an existing one is refused, and so is staging over " +
        "a shortcut that points at a file that no longer exists.",
      inputSchema: z.object({
        sourceFile: z
          .string()
          .describe("Path of the source file to stage (relative to the working folder)."),
        folder: z
          .string()
          .describe(
            "The volume folder to create, relative to the working folder. A plain folder name — no absolute path, no '..'."
          ),
        as: z
          .string()
          .optional()
          .describe(
            "File name to store the source under inside the folder (default: its original name)."
          ),
      }),
      execute: async ({ sourceFile, folder, as }) => {
        const src = path.resolve(cwd, sourceFile);
        const dir = path.resolve(cwd, folder);
        const name = as || path.basename(src);
        if (path.isAbsolute(folder)) {
          return `stageVolume refused: folder "${folder}" must be relative to the series location.`;
        }
        if (folder.split(/[\\/]/).includes("..")) {
          return `stageVolume refused: folder "${folder}" escapes the series location.`;
        }
        if (folder.includes("/") || folder.includes("\\")) {
          return `stageVolume refused: folder "${folder}" must be a single folder name directly inside the series location.`;
        }
        if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
          return `stageVolume refused: "${as}" is not a plain file name.`;
        }
        if (!inside(dir) || !inside(path.join(dir, name))) {
          return `stageVolume refused: "${folder}" is outside the allowed write area.`;
        }
        let st;
        try {
          st = await fsp.stat(src);
        } catch {
          return `stageVolume refused: source file not found: ${sourceFile}`;
        }
        if (!st.isFile()) return `stageVolume refused: "${sourceFile}" is not a file.`;
        const target = path.join(dir, name);
        // One read of the book, for the content hash the duplicate-book check and
        // the no-clobber guard both need. Staging itself then LINKS the book rather
        // than copying it — see stageSourceFile for why the destination is inspected
        // with lstat first.
        const srcHash = sha256Of(await fsp.readFile(src));
        const staged = await stageSourceFile({ src, target, srcSha256: srcHash, cwd });
        if (!staged.ok) return `stageVolume refused: ${staged.reason}`;
        return JSON.stringify({
          staged: true,
          unchanged: staged.unchanged,
          file: target,
          bytes: st.size,
          sha256: srcHash,
          // "link" = the folder's name for the same stored bytes; "copy" = the
          // fallback this filesystem forced. The run log and the agent both get
          // to see which one happened.
          via: staged.mode,
          ...(staged.mode === "link" ? { linksTo: staged.linkTo } : {}),
          ...(staged.reason ? { note: staged.reason } : {}),
          isEpub: isEpubPath(target),
        });
      },
    }),
  };

  const approve = (call) => {
    // Looking inside a book is always allowed — the agent must be able to read
    // before it decides. Staging writes, so it goes through the same
    // confinement as writeFile, and deleteFile stays denied outright.
    if (call.toolName === "deleteFile") return false;
    if (call.toolName !== "stageVolume") return true;
    const input = call.input || {};
    if (typeof input.folder !== "string" || input.folder.trim() === "") return false;
    if (typeof input.sourceFile !== "string" || input.sourceFile.trim() === "") return false;
    // One folder level, no escaping, no absolute paths — the same rule the tool
    // itself enforces and the manifest validator (sanitizeFolderName) requires.
    const folder = input.folder.trim();
    if (path.isAbsolute(folder) || folder.includes("/") || folder.includes("\\")) return false;
    if (folder.split(/[\\/]/).includes("..")) return false;
    const dir = path.resolve(cwd, folder);
    const name = input.as || path.basename(String(input.sourceFile));
    return inside(dir) && inside(path.join(dir, name));
  };

  return { tools, approve };
}

// ─── File-tool contract (what the library's tools actually accept) ───────────
//
// The open-harness file tools are stricter than the way a language model
// naturally reaches for them, and nothing in the request validates the gap — the
// schema is "some string", so a wrong shape is only discovered when the tool
// runs. Two shapes bit the live series:
//
// 1. grep and listFiles take `dirPath`, and the tool WALKS it. This pipeline's
//    own prompts hand an agent a single file and say "read it selectively with
//    readFile/grep" (glossary.js), so the agent passes that file and the walk
//    dies: `ENOTDIR: not a directory, scandir '<base>-whole.md'`. Observed: 40
//    such failures across the logged runs. Recoverable (the model sees the error
//    and retries), but every one is a wasted step out of a validator's capped
//    budget.
// 2. grep's `glob` is a filename SUFFIX — the implementation is
//    `file.endsWith(glob)` — but the word "glob" makes every model write
//    "*.md". That matches NOTHING and answers "No matches found for /*.md/."
//    Observed: 398 of 1030 logged grep calls. This one is worse than a crash:
//    it is silent, and the agent reports the term as absent from the source.
//
// So the tools an agent is handed are RE-DESCRIBED (the description is the half
// the model actually reads) and their input is REPAIRED when it lands on the
// wrong side of the contract. The repair is reported in the answer's `status`
// line, so the agent learns the correct shape instead of being quietly
// redirected.


module.exports = {
  createEpubTools,
};
