/**
 * resolveSourceBundle and its cache: the one door every task walks through, the
 * cached metadata that makes a re-run cheap, the plain-text title, the part files for
 * an oversized plain-text source, and the fingerprint that lets a changed source
 * invalidate the outputs built from it.
 *
 * Part of the source.js layer (split out of the original single file).
 */

const fs = require("fs").promises;
const path = require("path");
const { fileExists, shortcutTarget } = require("../fs");
const { structuralError } = require("../../configs/shared");
const tokens = require("../tokens");
const { scriptMixOf } = tokens;
require("../../types"); // JSDoc type definitions

const { chunkThresholdChars, splitPlainTextSegments } = require("./mode");
const { BUNDLE_SCHEMA_VERSION, EMPTY_SEGMENT_CHARS, TEXT_PART_TARGET_CHARS } = require("./config");
const { isEpubPath, readJsonOrNull, sha256OfFile } = require("./epub");
const { extractEpubToBundle } = require("./extract");

/**
 * The chapter title a plain-text source actually declares, if it declares one.
 *
 * The merge used to head every plain-text volume with `path.basename(sourceFile)`
 * — so the published book literally began `# test_story(1).md`: a file name
 * presented to a reader as a chapter title. A title is only printed when the
 * source itself carries one (a leading Markdown heading); otherwise the segment
 * is marked `syntheticTitle` and the merge adds no heading at all.
 *
 * @param {string} originalPath - The plain-text source file.
 * @returns {Promise<{title: string, synthetic: boolean}>} The declared title, or the base name marked synthetic.
 */
async function plainTextTitle(originalPath) {
  const base = path.basename(originalPath).replace(/\.[^.]+$/, "");
  let head = "";
  try {
    const handle = await fs.open(originalPath, "r");
    try {
      const buf = Buffer.alloc(4096);
      const { bytesRead } = await handle.read(buf, 0, 4096, 0);
      head = buf.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return { title: base, synthetic: true };
  }
  for (const line of head.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const m = t.match(/^#{1,6}\s+(.+?)\s*#*$/);
    if (m && m[1].trim()) return { title: m[1].trim(), synthetic: false };
    // The first real line is not a heading: the source declares no title.
    break;
  }
  return { title: base, synthetic: true };
}

// ─── Bundle resolution (the pipeline entry point) ───────────────────────────


/**
 * Split an oversized plain-text source into part files inside the volume folder
 * (the plain-text analogue of an epub's per-chapter files), cached so a re-run
 * does not re-split an unchanged source.
 *
 * The cache is keyed on the source fingerprint and the target size: a re-released
 * / errata-fixed source (or a changed SOURCE_CHUNK target) re-splits. A missing
 * part file forces a re-split too (fail-open).
 *
 * @param {string} originalPath - The staged source file.
 * @param {string} volumeDir - The volume folder (where the parts are written).
 * @param {string} base - The source base name (no extension).
 * @param {number} size - The source file size (bytes).
 * @param {string} fingerprint - sha256 of the source file.
 * @param {boolean} force - Re-split even when a valid cache exists.
 * @returns {Promise<Array<{file: string, chars: number, cacheHit: boolean}>>}
 */
async function materializeTextParts(originalPath, volumeDir, base, size, fingerprint, force) {
  const metaPath = path.join(volumeDir, `${base}-parts.meta.json`);
  let meta = null;
  if (!force) {
    try {
      meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
    } catch {
      meta = null;
    }
  }
  // Every part file must still be on disk. `fileExists` is async, so a bare
  // `.every(p => fileExists(...))` is always truthy (a pending promise is
  // truthy) — a deleted part file used to be accepted as a cache hit and the
  // bundle then pointed at files that were not there.
  const partsOnDisk =
    Array.isArray(meta?.parts) &&
    meta.parts.length > 0 &&
    meta.parts.every((p) => typeof p.file === "string");
  const allPartsExist =
    partsOnDisk &&
    (await Promise.all(meta.parts.map((p) => fileExists(path.join(volumeDir, p.file))))).every(Boolean);
  const validCache =
    meta &&
    meta.fingerprint === fingerprint &&
    meta.targetChars === TEXT_PART_TARGET_CHARS &&
    partsOnDisk &&
    allPartsExist;
  if (validCache) {
    return meta.parts.map((p) => ({ file: p.file, chars: p.chars || 0, cacheHit: true }));
  }
  const text = await fs.readFile(originalPath, "utf8");
  const segments = splitPlainTextSegments(text, TEXT_PART_TARGET_CHARS);
  const parts = [];
  for (let i = 0; i < segments.length; i += 1) {
    const file = `${base}-part-${String(i + 1).padStart(2, "0")}.md`;
    await fs.writeFile(path.join(volumeDir, file), segments[i], "utf8");
    parts.push({ file, chars: segments[i].length });
  }
  // Remove stale part files from a previous (different) split so they are not
  // mistaken for the current ones on a later run.
  const escBase = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const existing = await fs.readdir(volumeDir);
  for (const name of existing) {
    if (new RegExp(`^${escBase}-part-\\d+\\.md$`).test(name) && !parts.some((p) => p.file === name)) {
      await fs.rm(path.join(volumeDir, name), { force: true });
    }
  }
  await fs.writeFile(metaPath, JSON.stringify({ schema: 1, fingerprint, targetChars: TEXT_PART_TARGET_CHARS, parts }, null, 2), "utf8");
  return parts.map((p) => ({ ...p, cacheHit: false }));
}


async function resolveSourceBundle({ seriesDir, volume, volumeDir, force = false }) {
  const originalPath = path.resolve(seriesDir, volume.sourceFile);
  if (!(await fileExists(originalPath))) {
    // A staged book is a shortcut to the copy at the series root, so this failure
    // has two shapes now, and the second one is unfindable without being named:
    // the folder lost its book, or the book is there and the ORIGINAL it was
    // reaching is gone. Say which.
    const link = await shortcutTarget(originalPath);
    const linkNote = link
      ? ` The name in the volume folder is a shortcut to "${link.pointsTo}", which ` +
        (link.resolves ? "is not readable." : "does not exist — restore THAT file.")
      : "";
    // STRUCTURAL: the manifest's plan of record points at a book that is no
    // there (a deleted file, a moved folder, a disk failure). No run policy may
    // skip past it — every artifact built after this point would be built on a
    // missing book.
    throw structuralError(
      `Required source file not found: ${originalPath} (volume ${volume.installmentNumber}, ` +
        `listed in the plan of record as "${volume.sourceFile}").${linkNote} ` +
        `The file is gone or the folder moved — restore it, or re-run "npx gulp discover --force" ` +
        `to re-plan the series.`
    );
  }
  const base = path.basename(originalPath).replace(/\.[^.]+$/, "");

  if (!isEpubPath(originalPath)) {
    const st = await fs.stat(originalPath);
    const fingerprint = await sha256OfFile(originalPath);
    // An oversized plain-text source (bigger than the whole-installment
    // threshold) is split into part files in the volume folder so the
    // chapter-by-chapter fallback can process it, exactly like a big epub.
    // A small source stays a single "whole" segment, as before.
    if (st.size > 0 && st.size > chunkThresholdChars()) {
      const parts = await materializeTextParts(originalPath, volumeDir, base, st.size, fingerprint, force);
      const wholeText = await fs.readFile(originalPath, "utf8");
      return {
        format: "text",
        originalPath,
        base,
        volumeDir,
        wholePath: originalPath,
        segments: await Promise.all(
          parts.map(async (p, i) => ({
            id: `part-${String(i + 1).padStart(2, "0")}`,
            file: p.file,
            // A pipeline-made slice of an oversized text file is not a chapter of
            // the book: the label exists so the stage can name its outputs, and
            // `syntheticTitle` stops the merge from printing it as a heading.
            title: `Part ${i + 1} of ${parts.length}`,
            syntheticTitle: true,
            chars: p.chars,
            scriptMix: scriptMixOf(await fs.readFile(path.join(volumeDir, p.file), "utf8")),
          }))
        ),
        imagesDir: null,
        wholeChars: st.size,
        scriptMix: scriptMixOf(wholeText),
        cacheHit: parts.every((p) => p.cacheHit),
        sourceFingerprint: fingerprint,
      };
    }
    const declared = await plainTextTitle(originalPath);
    const wholeText = await fs.readFile(originalPath, "utf8");
    return {
      format: "text",
      originalPath,
      base,
      volumeDir,
      wholePath: originalPath,
      segments: [
        {
          id: "whole",
          file: path.basename(originalPath),
          title: declared.title,
          // True when the "title" is only the file name — the merge must not
          // print it as a chapter heading in the published book.
          syntheticTitle: declared.synthetic,
          chars: st.size,
          bodyChars: st.size,
          empty: st.size < EMPTY_SEGMENT_CHARS,
          scriptMix: scriptMixOf(wholeText),
        },
      ],
      imagesDir: null,
      wholeChars: st.size,
      scriptMix: scriptMixOf(wholeText),
      cacheHit: false,
      // Content hash of the source file — the artifact skip-checks compare it
      // against the fingerprint persisted in the last run's rolling state so
      // a re-released / errata-fixed source invalidates the stale artifacts
      // (see isSourceStale in configs/shared.js).
      sourceFingerprint: fingerprint,
    };
  }

  const metaPath = path.join(volumeDir, `${base}-bundle.meta.json`);
  const st = await fs.stat(originalPath);
  const sha = await sha256OfFile(originalPath);
  const relSource = path.relative(volumeDir, originalPath) || path.basename(originalPath);

  let cached = null;
  if (!force) {
    cached = await readJsonOrNull(metaPath);
    const fresh =
      cached &&
      cached.sourceFile === relSource &&
      cached.mtimeMs === st.mtimeMs &&
      cached.size === st.size &&
      cached.sha256 === sha &&
      // Caches written under an older extraction schema (see
      // BUNDLE_SCHEMA_VERSION) are re-extracted so the files on disk match
      // the current one.
      cached.schema === BUNDLE_SCHEMA_VERSION;
    if (fresh) {
      const missing = [];
      for (const seg of cached.segments || []) {
        if (!(await fileExists(path.join(volumeDir, seg.file)))) missing.push(seg.file);
      }
      if (!(await fileExists(path.join(volumeDir, cached.wholeFile)))) missing.push(cached.wholeFile);
      if (missing.length === 0) {
        console.log(
          `[source] bundle for "${path.basename(originalPath)}" is up to date (cache hit) — ` +
            `reusing ${cached.segments.length} segment(s).`
        );
        return materializeBundle(cached, { originalPath, volumeDir, cacheHit: true });
      }
      console.log(
        `[source] bundle for "${path.basename(originalPath)}" is missing file(s) ` +
          `(${missing.join(", ")}) — re-extracting.`
      );
    } else if (cached) {
      const reason =
        cached.schema === BUNDLE_SCHEMA_VERSION
          ? "source changed"
          : `schema ${cached.schema === undefined ? "1 (pre-versioning)" : cached.schema} → ${BUNDLE_SCHEMA_VERSION} ` +
            `(chapters now come from the book's own contents list, not one per spine page)`;
      console.log(
        `[source] bundle for "${path.basename(originalPath)}" is stale (${reason}) — re-extracting.`
      );
    }
  }

  const meta = await extractEpubToBundle(originalPath, volumeDir, base);
  meta.sourceFile = relSource;
  meta.mtimeMs = st.mtimeMs;
  meta.size = st.size;
  meta.sha256 = sha;
  meta.generatedAt = new Date().toISOString();
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2) + "\n", "utf-8");
  // Remove segment files from a previous cache whose names changed under the
  // current id scheme — otherwise stale strays (e.g. old "int.K" interludes)
  // would linger in the volume folder and could be read by agents.
  if (cached) {
    const currentFiles = new Set((meta.segments || []).map((s) => s.file));
    for (const oldSeg of cached.segments || []) {
      if (currentFiles.has(oldSeg.file)) continue;
      const oldPath = path.join(volumeDir, oldSeg.file);
      if (await fileExists(oldPath)) {
        await fs.rm(oldPath);
        console.log(`[source] removed stale segment file "${oldSeg.file}" (renamed by the current id scheme).`);
      }
    }
  }
  console.log(
    `[source] extracted "${path.basename(originalPath)}" into ${meta.segments.length} segment(s) ` +
      `+ ${meta.images.length} image(s) in ${volumeDir}.`
  );
  return materializeBundle(meta, { originalPath, volumeDir, cacheHit: false });
}


/**
 * Build the in-memory SourceBundle from a persisted meta object.
 *
 * @param {Object} meta - The persisted bundle meta.
 * @param {{originalPath: string, volumeDir: string, cacheHit: boolean}} p
 * @returns {SourceBundle}
 */
function materializeBundle(meta, { originalPath, volumeDir, cacheHit }) {
  return {
    format: meta.format === "epub" ? "epub" : "text",
    originalPath,
    base: meta.base,
    volumeDir,
    wholePath: path.join(volumeDir, meta.wholeFile),
    segments: (meta.segments || []).map((s) => ({
      id: s.id,
      file: s.file,
      title: s.title,
      chars: s.chars,
      // Carried through so "this chapter is empty IN THE SOURCE" is visible in
      // the translation stage and the handoff, not only in the cache file.
      bodyChars: s.bodyChars,
      empty: s.empty,
      // True when the extraction could not give this chapter a real title (the
      // book's contents did not name it and it prints no heading of its own) —
      // the merge then prints no heading rather than inventing one.
      syntheticTitle: s.syntheticTitle === true,
      // Persisted by the extraction (schema 6). null on an older cache — the
      // token rule then falls back to the character rule and says so.
      scriptMix: s.scriptMix || null,
      path: path.join(volumeDir, s.file),
    })),
    packaging: meta.packaging || null,
    imagesDir: (meta.images || []).length > 0 ? path.join(volumeDir, "images") : null,
    wholeChars: meta.wholeChars || 0,
    scriptMix: meta.scriptMix || null,
    cacheHit,
    // The cache meta records the epub's sha256 (see resolveSourceBundle) —
    // the same value the artifact skip-checks compare against.
    sourceFingerprint: meta.sha256 || null,
  };
}

// ─── Prompt helpers (chapter-aware materials lines) ─────────────────────────
// The task modules build their agent/one-shot prompts in code; these helpers
// keep the bundle-aware wording in exactly one place.


module.exports = {
  plainTextTitle,
  materializeTextParts,
  resolveSourceBundle,
  materializeBundle,
};
