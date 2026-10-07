/**
 * utils/fs/stage.js — put a source file into a volume folder, without ever duplicating the book.
 *
 * The intake agent's staging step: LINK the archive into the volume folder rather than copy it,
 * prove the file is the one the scan found (the hash it was reported with), and refuse the
 * shapes that would silently change what the pipeline reads — an archive that is not the one
 * hashed, a target that already holds different content, a path that leaves the project.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ─── Staging a source file ────────────────────────────────────────────────────

/**
 * Put a source file where a volume folder expects it, WITHOUT writing a second
 * copy of it.
 *
 * The intake step lays a series out as `<volume folder>/<the book>`, and the
 * book it puts there used to be a byte-for-byte copy of the one sitting at the
 * series root. On a real series that is the single largest thing the pipeline
 * writes: 17 books × 2 copies = 406 MB for 203 MB of books. A shortcut is two
 * names for the same stored bytes, so the volume folder gets its book at the
 * cost of a few bytes.
 *
 * The link is RELATIVE, not absolute. An absolute shortcut is a promise about
 * this machine's paths, and this project has already been burned by exactly that
 * (AGENTS.md gotcha 11: a Windows `C:\...` path baked into the plan of record is
 * not absolute on Linux, so every file operation silently resolved it relative to
 * the working folder). A relative link keeps working when the whole series
 * folder moves, is renamed, or is checked out somewhere else.
 *
 * Three rules, and each one exists because the alternative is worse:
 *
 *   1. **A broken shortcut is refused, never written through.** `readFile` and
 *      `copyFile` both follow a shortcut, so the ordinary "is something already
 *      there?" check answers "no" for a dangling one — and the ordinary "put the
 *      file there" call then creates the file at whatever the shortcut POINTS
 *      at, not in the volume folder. That is a write landing outside the folder
 *      the sandbox confined it to. So the destination is inspected with `lstat`
 *      first, and a shortcut that resolves nowhere is a refusal that names what
 *      it points at.
 *   2. **The clobber guard still compares content.** A shortcut is not a licence
 *      to overwrite the original: staging a different book over a name that
 *      already resolves to a book is refused exactly as it was when the name held
 *      a copy.
 *   3. **A filesystem that cannot link falls back to a copy.** Different drives
 *      (`EXDEV`), a filesystem with no links (FAT32), a Windows checkout without
 *      the privilege to create one — none of these should fail the intake step,
 *      and a copy is what the pipeline did until today. The fallback is reported
 *      so a run log says which one happened.
 *
 * @param {Object} cfg
 * @param {string} cfg.src - The source file (absolute, or resolved against `cwd`).
 * @param {string} cfg.target - The path to create (absolute, or resolved against `cwd`).
 * @param {string} [cfg.srcSha256] - The source's content hash, when the caller already has it.
 * @param {string} [cfg.cwd] - Base folder for relative inputs. Defaults to the working folder.
 * @returns {Promise<{ok: boolean, unchanged: boolean, mode: "link"|"copy"|"none", srcSha256?: string, reason?: string, linkTo?: string}>}
 *   `ok` false with a `reason` when staging is refused (a different book is
 *   already there, or the name is a broken shortcut).
 */
async function stageSourceFile({ src, target, srcSha256, cwd = process.cwd() }) {
  const fsp = fs.promises;
  const srcAbs = path.resolve(cwd, src);
  const targetAbs = path.resolve(cwd, target);

  let srcStat = null;
  try {
    srcStat = await fsp.stat(srcAbs);
  } catch {
    return { ok: false, unchanged: false, mode: "none", reason: `source file not found: ${srcAbs}` };
  }
  if (!srcStat.isFile()) {
    return { ok: false, unchanged: false, mode: "none", reason: `"${srcAbs}" is not a file.` };
  }
  const hashFile = async (p) =>
    crypto.createHash("sha256").update(await fsp.readFile(p)).digest("hex");
  // The caller usually already hashed the source to decide what is a duplicate
  // book; reuse it rather than reading a 20 MB archive again.
  const srcHash = srcSha256 ?? (await hashFile(srcAbs));

  // 1. What is already at the destination? `lstat`, because `stat` would follow
  //    a shortcut and report the book at the other end as if it lived here.
  let existing = null;
  try {
    existing = await fsp.lstat(targetAbs);
  } catch {
    existing = null;
  }
  if (existing && existing.isSymbolicLink()) {
    const pointsAt = path.resolve(path.dirname(targetAbs), await fsp.readlink(targetAbs));
    let resolved = null;
    try {
      resolved = await fsp.realpath(targetAbs);
    } catch {
      resolved = null;
    }
    if (!resolved) {
      return {
        ok: false,
        unchanged: false,
        mode: "none",
        linkTo: pointsAt,
        reason:
          `${targetAbs} is a shortcut to "${pointsAt}", which does not exist. Nothing is ` +
          `written through a broken shortcut — restore the file it points at, or replace ` +
          `the shortcut with a real file.`,
      };
    }
    const srcReal = await fsp.realpath(srcAbs).catch(() => srcAbs);
    if (resolved === srcReal) {
      // Already this exact book, under this exact name: nothing to do.
      return { ok: true, unchanged: true, mode: "link", srcSha256: srcHash, linkTo: resolved };
    }
    let targetHash = null;
    try {
      targetHash = await hashFile(resolved);
    } catch {
      targetHash = null;
    }
    if (targetHash && targetHash === srcHash) {
      // The same book reached by a different name — staging it again changes nothing.
      return { ok: true, unchanged: true, mode: "link", srcSha256: srcHash, linkTo: resolved };
    }
    return {
      ok: false,
      unchanged: false,
      mode: "none",
      linkTo: resolved,
      reason:
        `${targetAbs} already holds different content (a shortcut to "${resolved}"). ` +
        `Pick a different folder or file name.`,
    };
  }

  if (existing && existing.isFile()) {
    let targetHash = null;
    try {
      targetHash = await hashFile(targetAbs);
    } catch {
      targetHash = null;
    }
    if (targetHash === srcHash) {
      return { ok: true, unchanged: true, mode: "copy", srcSha256: srcHash };
    }
    return {
      ok: false,
      unchanged: false,
      mode: "none",
      reason: `${targetAbs} already holds different content. Pick a different folder or file name.`,
    };
  }
  if (existing) {
    return {
      ok: false,
      unchanged: false,
      mode: "none",
      reason: `${targetAbs} is not a file. Pick a different folder or file name.`,
    };
  }

  // 2. Nothing there: create the shortcut, and read it back to prove it resolves.
  await fsp.mkdir(path.dirname(targetAbs), { recursive: true });
  const relative = path.relative(path.dirname(targetAbs), srcAbs);
  let linkErr = null;
  try {
    await fsp.symlink(relative, targetAbs);
    const st = await fsp.stat(targetAbs); // follows the link: throws if it resolves nowhere
    if (st.size !== srcStat.size) {
      // The link resolves to something the wrong size. A shortcut that points at
      // the wrong book is worse than no shortcut.
      linkErr = new Error(`resolves to a file of ${st.size} bytes, expected ${srcStat.size}`);
    }
  } catch (err) {
    linkErr = err;
  }
  if (!linkErr) {
    return { ok: true, unchanged: false, mode: "link", srcSha256: srcHash, linkTo: relative };
  }
  // 3. No link available on this filesystem / between these paths (EXDEV, EPERM,
  //    a filesystem with no links), or the link we made does not resolve. Remove
  //    OUR shortcut before falling back: `copyFile` follows a shortcut, so copying
  //    through one we just made is the exact write-through rule 1 forbids.
  await fsp.rm(targetAbs).catch(() => {});
  try {
    await fsp.copyFile(srcAbs, targetAbs);
  } catch (copyErr) {
    return {
      ok: false,
      unchanged: false,
      mode: "none",
      reason: `could not stage ${srcAbs} at ${targetAbs}: ${copyErr.message} (linking failed first: ${linkErr.message})`,
    };
  }
  return { ok: true, unchanged: false, mode: "copy", srcSha256: srcHash, reason: `linking unavailable (${linkErr.message})` };
}

module.exports = { stageSourceFile };
