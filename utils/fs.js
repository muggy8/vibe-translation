/**
 * utils/fs.js — Filesystem utility functions shared across the ai-client
 * modules.
 *
 * @example
 * const { fileExists, assertWrote } = require("../utils/fs");
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ─── Filesystem helpers ───────────────────────────────────────────────────────

/**
 * Check whether a file exists.
 *
 * @param {string} filePath - The path to check.
 * @returns {Promise<boolean>} True if the file exists, false otherwise.
 */
async function fileExists(filePath) {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fail loudly if an agent-mode stage left its output file(s) missing, empty,
 * or still holding a scaffold stub (see {@link isPlaceholderContent}).
 *
 * @param {string | string[]} filePaths - Expected output file path or array of paths.
 * @param {string} who - Who was supposed to write it (for the error message).
 * @returns {Promise<void>}
 */
async function assertWrote(filePaths, who) {
  const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
  for (const filePath of paths) {
    const content = await fs.promises.readFile(filePath, "utf-8").catch(() => null);
    if (isPlaceholderContent(content)) {
      throw new Error(
        `${who} did not produce ${filePath}` +
          (content !== null ? " (the file is empty or still holds its scaffold stub)" : ".") +
          ` Check the run log in .logs/ for the agent transcript.`
      );
    }
  }
}

/**
 * The scaffold stubs the workflows pre-write as a name anchor for the agent
 * ("a stronger anchor than 'create a new file'"). Every one of them starts
 * with this marker, so a stub that survived into the final output is
 * detectable without reading each workflow's scaffolding code.
 *
 * @type {string}
 */
const STUB_MARKER = "(stub —";

/**
 * Decide whether file content counts as "the agent did not actually write this".
 *
 * Three shapes qualify: the file is absent (null), it is empty or whitespace,
 * or it still holds a scaffold stub. The stub case is the dangerous one — a
 * crashed run leaves a file that EXISTS, so every "does the output exist?" check
 * (including the idempotency skip checks) would treat scaffolding as finished
 * work.
 *
 * @param {string|null|undefined} content - The file content, or null when the file is absent.
 * @returns {boolean} True when the content must NOT be treated as real output.
 */
function isPlaceholderContent(content) {
  if (content === null || content === undefined) return true;
  const text = String(content).trim();
  if (text === "") return true;
  return text.startsWith(STUB_MARKER);
}

/**
 * Fail loudly if an agent-mode stage left its output file(s) missing, empty or
 * stubbed — the hard stop callers run AFTER a recovery turn, so a stage can
 * never publish scaffolding as a finished artifact.
 *
 * @param {string | string[]} filePaths - Expected output file path or array of paths.
 * @param {string} who - Who was supposed to write it (for the error message).
 * @returns {Promise<void>}
 */
async function assertRealOutput(filePaths, who) {
  const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
  const bad = [];
  for (const filePath of paths) {
    const content = await fs.promises.readFile(filePath, "utf-8").catch(() => null);
    if (isPlaceholderContent(content)) bad.push(filePath);
  }
  if (bad.length > 0) {
    throw new Error(
      `${who} never wrote real output for: ${bad.join(", ")} ` +
        `(missing, empty, or still a scaffold stub). Check the agent transcript in .logs/.`
    );
  }
}

/**
 * The smallest a chat reply may be before it is allowed to stand as an artifact.
 *
 * Sized from a live failure: an author agent replied with 164 characters of
 * planning narration ("I need the full content of two very long lines in the
 * previous reference. Let me temporarily split them…") and made no writeFile
 * call, and that sentence became the volume's character voice reference — and
 * then the series-level one. A real artifact is a document, not a sentence about
 * a plan.
 *
 * `AGENT_RECOVERY_MIN_CHARS=0` turns the whole plausibility gate off (the pre-fix
 * behavior: write whatever the model said).
 *
 * @type {number}
 */
const FALLBACK_MIN_CONTENT_CHARS = (() => {
  const n = parseInt(process.env.AGENT_RECOVERY_MIN_CHARS, 10);
  return Number.isInteger(n) && n >= 0 ? n : 1000;
})();

/**
 * Does this text have the SHAPE of a document this pipeline writes: a Markdown
 * heading, or a table? Shape only — makes no size claim (see
 * {@link looksLikeArtifact} for the size half of the question).
 *
 * @param {string} text
 * @returns {boolean}
 */
function hasDocumentShape(text) {
  return /^#{1,6}[ \t]/m.test(text) || /^\s*\|.*\|\s*$/m.test(text);
}

/**
 * Decide whether a chat reply is plausibly the DOCUMENT the agent was asked to
 * write, rather than a remark about what it is about to write.
 *
 * Every prompt in this pipeline specifies a headed Markdown shape (`# Glossary —
 * …`, `# POV Map — …`, `## Plot Summary`), so "a headed document of some size" is
 * the contract the prompt already states, not a guess about style. A reply that
 * fails this is not evidence of artifact content, and writing it to disk is worse
 * than leaving the file missing: a missing file fails loudly, while a
 * plausible-looking wrong file gets audited, published, and copied to the series
 * root (observed live).
 *
 * @param {string|null|undefined} content - The agent's chat reply.
 * @returns {{ok: boolean, reason: string}} Why it was accepted or refused.
 */
function looksLikeArtifact(content) {
  if (typeof content !== "string") return { ok: false, reason: "no chat content" };
  const text = content.trim();
  if (text.length === 0) return { ok: false, reason: "the reply is empty" };
  if (FALLBACK_MIN_CONTENT_CHARS > 0) {
    if (text.length < FALLBACK_MIN_CONTENT_CHARS) {
      return {
        ok: false,
        reason: `the reply is ${text.length} chars — below the ${FALLBACK_MIN_CONTENT_CHARS}-char floor for an artifact`,
      };
    }
    if (!hasDocumentShape(text)) {
      return {
        ok: false,
        reason: "the reply holds no Markdown heading and no table — every artifact this pipeline writes is a headed document",
      };
    }
  }
  return { ok: true, reason: "" };
}

/**
 * The "which expected outputs are still not real content" clause of the warning.
 * @param {Array<{filePath: string, existing: string|null}>} missing
 * @returns {string}
 */
function missingOutputsNote(missing) {
  const parts = missing.map(
    ({ filePath, existing }) =>
      `${filePath} is ${existing !== null && existing.trim() !== "" ? "still a scaffold stub" : "empty"}`
  );
  return ` (${parts.join("; ")})`;
}

/**
 * Fail loudly if an agent-mode stage left its output file(s) missing, empty or
 * stubbed, or recover by writing provided chat-reply content to disk as a
 * fallback.
 *
 * This is a recovery wrapper for the author agent: when the model produces
 * the output in its chat reply instead of calling writeFile, the content is
 * still available in the agent handle's returned result and can be written
 * directly.
 *
 * The fallback is GATED (see {@link looksLikeArtifact}): it writes only when a
 * SINGLE file is missing and the reply actually looks like the document that file
 * should hold. Two observed failures motivated this:
 *   - a 164-character planning sentence became a character voice reference;
 *   - the SAME chat reply was written into BOTH expected outputs (a voice
 *     reference and a POV map), so one agent's no-op turn produced two wrong
 *     artifacts instead of one missing one.
 * Refusing is never fatal by itself: the caller still gets `true`, so it sends
 * the recovery turn, and `assertRealOutput` after that turn is the hard stop.
 *
 * The return value gates the CALLER's recovery turn: callers must only send
 * a recovery turn when this returns true (a file was actually missing).
 * Always returning true here made every stage run a redundant "recovery" turn
 * over an already-correct file — a second stochastic rewrite of the output
 * plus a false claim in the prompt that the model had replied in chat.
 *
 * A file that EXISTS but is empty or still holds its scaffold stub counts as
 * missing: the previous version only asked "does the path exist?", so an
 * interrupted run's 0-byte file (or an untouched wiki stub) was treated as
 * finished work and never recovered — and the next run skipped the volume
 * entirely.
 *
 * @param {string | string[]} filePaths - Expected output file path or array of paths.
 * @param {string} who - Who was supposed to write it (for the error message).
 * @param {string} [content] - Optional chat-reply content to write if a file is missing.
 * @returns {Promise<boolean>} True if at least one file was missing (the
 *   fallback was used, or recovery is still needed because the content was not
 *   usable), false if every file already held real output.
 */
async function assertWroteWithFallback(filePaths, who, content) {
  const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
  const missing = [];
  for (const filePath of paths) {
    const existing = await fs.promises.readFile(filePath, "utf-8").catch(() => null);
    if (isPlaceholderContent(existing)) missing.push({ filePath, existing });
  }
  if (missing.length === 0) return false;

  // One chat reply can be ONE artifact's content. It cannot be the content of two
  // different documents, so a multi-file gap is repaired by the recovery turn —
  // never by duplicating one reply across every expected output.
  const check =
    missing.length > 1
      ? {
          ok: false,
          reason: `${missing.length} outputs are missing — one chat reply cannot be the content of all of them`,
        }
      : looksLikeArtifact(content);

  if (check.ok) {
    const { filePath, existing } = missing[0];
    // Fallback: write the chat-reply content to disk (this also OVERWRITES a
    // stub, which a plain "does the file exist?" check would have left alone).
    await fs.promises.writeFile(filePath, content, "utf8");
    console.log(
      `[fallback] ${who} replied in chat instead of using writeFile; ` +
        `wrote ${filePath} from the chat reply (${String(content).length} chars)` +
        (existing !== null && existing.trim() !== "" ? " — replacing its scaffold stub" : "") +
        "."
    );
  } else {
    // Nothing usable to recover with — the caller will send a recovery turn
    // that re-sends the full task.
    console.warn(
      `[warning] ${who} produced no usable output${missingOutputsNote(missing)}` +
        ` (${check.reason}) — recovery turn will re-send the task.`
    );
  }
  return true;
}

/**
 * Whether a file on disk holds real output (not absent, not empty, not a
 * scaffold stub).
 *
 * The idempotency skip checks all ask "does the output already exist?" — this
 * is the version of that question that cannot be answered by a stub left behind
 * by a crashed run.
 *
 * @param {string} filePath - The file to inspect.
 * @returns {Promise<boolean>} True when the file holds real, non-stub content.
 */
async function hasRealOutput(filePath) {
  const content = await fs.promises.readFile(filePath, "utf-8").catch(() => null);
  return !isPlaceholderContent(content);
}

/**
 * Whether a per-volume snapshot may be PUBLISHED as one of the four
 * series-level artifacts (glossary.md / character-voice.md / style-guide.md /
 * shared-wiki.md).
 *
 * Stricter than {@link hasRealOutput}, and deliberately so: the root-copy walk
 * is where one bad artifact becomes the series' reference — the consistency
 * audit, every later volume's prompts, and the translation stage all read the
 * copy. "Exists, not empty, not a stub" is the right question for a per-volume
 * skip check; it is not enough for publication. Observed live: a 164-character
 * planning sentence satisfied hasRealOutput, passed the acceptance loop, and was
 * promoted to the series root as the character voice reference.
 *
 * The extra rule is SHAPE, not size — no magic floor to argue about: every
 * prompt that writes one of these four files specifies a headed Markdown
 * document (or a table), so a file with no heading and no table is not that
 * document at any length. A snapshot that exists but fails the shape check is
 * reported, not skipped silently: a silent skip is how the corruption looked
 * like a finished run.
 *
 * @param {string} filePath - The per-volume snapshot to inspect.
 * @param {string} [artifactName] - What the artifact is called, for the warning.
 * @returns {Promise<boolean>} True when the file may be copied to the series root.
 */
async function isPublishableArtifact(filePath, artifactName = "series artifact") {
  const content = await fs.promises.readFile(filePath, "utf-8").catch(() => null);
  // Nothing there at all: the walk simply continues to the previous volume.
  if (content === null) return false;
  if (isPlaceholderContent(content)) return false;
  if (!hasDocumentShape(content)) {
    console.warn(
      `[warning] ${filePath} exists but is not a publishable ${artifactName}: ` +
        `${content.trim().length} chars with no Markdown heading and no table. ` +
        `Not copied to the series root.`
    );
    return false;
  }
  return true;
}

/**
 * Write a provenance sidecar next to a series-root artifact copy.
 *
 * The root copies (glossary.md, character-voice.md, style-guide.md,
 * shared-wiki.md) are byte-identical copies of a per-volume snapshot, and
 * nothing in the file itself records which volume they came from — this
 * sidecar (`<copy>.provenance.json`) does: the source path, the volume, the
 * copy timestamp, and the content hash (so a later manual refresh of the
 * copy without re-running the task is detectable).
 *
 * Best-effort: a failure only warns — the copy itself is the deliverable.
 *
 * @param {string} targetFile - The root copy that was just written.
 * @param {string} sourceFile - The per-volume snapshot it was copied from.
 * @returns {Promise<void>}
 */
async function writeProvenanceSidecar(targetFile, sourceFile) {
  try {
    const crypto = require("crypto");
    const content = await fs.promises.readFile(targetFile);
    const sidecar = {
      file: path.basename(targetFile),
      copiedFrom: sourceFile,
      volume: path.basename(path.dirname(sourceFile)),
      copiedAt: new Date().toISOString(),
      sha256: crypto.createHash("sha256").update(content).digest("hex"),
    };
    await fs.promises.writeFile(
      `${targetFile}.provenance.json`,
      JSON.stringify(sidecar, null, 2) + "\n",
      "utf8"
    );
  } catch (err) {
    console.warn(
      `[provenance] could not write the sidecar for ${targetFile} (${err.message}) — continuing.`
    );
  }
}

/**
 * Read a cumulative reference artifact and prepare it as an INLINE prompt
 * message, optionally truncating it with the task's own truncator.
 *
 * A `{ file }` message is inlined whole by the harness — the model cannot page
 * through it the way it can page through a file it reads with readFile. So a
 * cumulative reference (the previous volume's glossary / voice reference /
 * style guide) handed to a one-shot extraction grows with the SERIES and
 * eventually crowds out the source text it is supposed to be checked against.
 * This is where the truncation helpers AGENTS.md describes get applied.
 *
 * The rendered shape matches the harness's own inline format exactly
 * (`File: <name>\nContent:\n\n<content>`), so the model sees the same thing it
 * would have seen with a `{ file }` message — just bounded.
 *
 * @param {string} filePath - The artifact to inline.
 * @param {string} name - The name the model is told the file has.
 * @param {{truncate?: (content: string) => string}} [opts] - The task's truncator (applied only to the inlined copy; the file on disk is never modified).
 * @returns {Promise<{text: string}>} A runOneShot message.
 */
async function inlineReferenceMessage(filePath, name, { truncate } = {}) {
  const raw = await fs.promises.readFile(filePath, "utf8");
  const content = typeof truncate === "function" ? truncate(raw) : raw;
  if (content.length !== raw.length) {
    console.log(
      `[context] inlining ${name} truncated: ${raw.length} → ${content.length} chars (the file on disk is unchanged).`
    );
  }
  return { text: `File: ${name}\nContent:\n\n${content}` };
}

/**
 * A cheap content fingerprint for a set of files, so a caller can ask afterwards
 * whether anything actually changed.
 *
 * Why this exists: a QA loop's feedback pass is only worth its cost if it moves
 * the artifact. Observed live on the 17-volume series — the character-voice
 * feedback pass on volume 01 made 46 tool calls (29 reads, 15 searches, ZERO
 * writes), spent 2.63M tokens, and left `character-voice.md` and `pov-map.md`
 * byte-identical to what the compile pass had written. Both files existed and
 * were real, so `assertWroteWithFallback` reported no gap, no recovery turn ran,
 * `assertRealOutput` passed, and the loop cheerfully started another iteration
 * that re-audited the unchanged document for another 8.4M tokens. Every existing
 * check asks "is the file there?"; none asks "did this pass do anything?".
 *
 * Content hashes, not mtimes: an agent that rewrites a file with identical text
 * is exactly the no-op this detects, and a tool that touched mtime without
 * touching content would hide it.
 *
 * Fail-soft: an unreadable file fingerprints as `missing`, so a read error cannot
 * masquerade as "nothing changed".
 *
 * @param {string|string[]} filePaths - The file(s) to fingerprint.
 * @returns {Promise<string>} A stable string that differs whenever any listed
 *   file's content (or presence) differs.
 */
async function fingerprintFiles(filePaths) {
  const list = (Array.isArray(filePaths) ? filePaths : [filePaths]).filter(Boolean);
  const parts = [];
  for (const filePath of list) {
    try {
      const buf = await fs.promises.readFile(filePath);
      parts.push(`${filePath}:${buf.length}:${crypto.createHash("sha256").update(buf).digest("hex")}`);
    } catch (err) {
      parts.push(`${filePath}:missing:${err.code || err.message}`);
    }
  }
  return parts.join("|");
}

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

// ─── Exports ──────────────────────────────────────────────────────────────────

/**
 * Where a shortcut actually points, when the path IS a shortcut.
 *
 * A staged book is now usually a shortcut, so "the source file is missing" has a
 * second meaning it never used to have: the name is there and the book behind it
 * is not. A reader of the error needs both halves — the name the plan of record
 * lists, and the file that name was reaching.
 *
 * @param {string} filePath
 * @returns {Promise<{pointsTo: string, resolves: string|null}|null>}
 *   `pointsTo` is the file the shortcut NAMES (absolute); `resolves` is the real
 *   file it reaches, or null when that file is gone. Null when `filePath` is not
 *   a shortcut at all.
 */
async function shortcutTarget(filePath) {
  let st = null;
  try {
    st = await fs.promises.lstat(filePath);
  } catch {
    return null;
  }
  if (!st.isSymbolicLink()) return null;
  const pointsTo = path.resolve(path.dirname(filePath), await fs.promises.readlink(filePath));
  try {
    return { pointsTo, resolves: await fs.promises.realpath(filePath) };
  } catch {
    return { pointsTo, resolves: null };
  }
}

/**
 * Delete the files one processing attempt wrote, so a different attempt starts
 * from a clean folder.
 *
 * This exists because the whole-installment → chapter-by-chapter fallback swaps
 * the SHAPE of the work mid-volume, and the two modes leave different files
 * behind. A half-finished whole attempt leaves a partial (or scaffold-stub)
 * artifact, a research skeleton full of `- (pending)` lines, and a rolling-state
 * file recording scores for documents that no longer exist. The chunked path
 * would then read those as its starting point — and this codebase has been
 * burned by exactly that class of bug before (AGENTS.md gotcha 3: every stray
 * cleanup in the repo was added after a live failure; gotcha 50: "the file is
 * there" is never evidence the work was done).
 *
 * Deletes ONLY the names it is given. It never walks the folder and never
 * touches the source bundle: the extraction is keyed on the source fingerprint
 * and is valid regardless of which mode processes it.
 *
 * @param {string} volumeDir - The volume folder.
 * @param {string[]} fileNames - File names (relative to the folder) the attempt wrote.
 * @param {{glob?: RegExp}} [opts] - Optional pattern matched against file names, for a mode's per-chapter strays (e.g. /^wiki-.+\.md$/).
 * @returns {Promise<string[]>} The names actually removed.
 */
async function wipeAttemptOutputs(volumeDir, fileNames, { glob } = {}) {
  const removed = [];
  for (const name of fileNames || []) {
    const target = path.join(volumeDir, name);
    try {
      await fs.promises.rm(target);
      removed.push(name);
    } catch {
      // Not there — the attempt never got that far. Not an error.
    }
  }
  if (glob) {
    let entries = [];
    try {
      entries = await fs.promises.readdir(volumeDir);
    } catch {
      entries = [];
    }
    for (const name of entries) {
      if (!glob.test(name)) continue;
      try {
        await fs.promises.rm(path.join(volumeDir, name));
        removed.push(name);
      } catch {}
    }
  }
  return removed;
}

module.exports = {
  fileExists,
  assertWrote,
  assertWroteWithFallback,
  assertRealOutput,
  isPlaceholderContent,
  looksLikeArtifact,
  hasDocumentShape,
  hasRealOutput,
  isPublishableArtifact,
  STUB_MARKER,
  FALLBACK_MIN_CONTENT_CHARS,
  inlineReferenceMessage,
  writeProvenanceSidecar,
  fingerprintFiles,
  stageSourceFile,
  shortcutTarget,
  wipeAttemptOutputs,
};
