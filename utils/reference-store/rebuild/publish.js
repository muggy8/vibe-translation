/**
 * utils/reference-store/rebuild/publish.js — put the artifact into the volume's own folder, and seal
 * the record that describes it, as one act.
 *
 * `writeRebuiltVoiceFile` moves the file it replaces to `.rejected` (never silently, never deleted),
 * writes the new one, and stores the file's own opening as the record's opening so the record and the
 * artifact say the same thing. `publishRebuiltVolume` then reads the file back and seals only when the
 * bytes on disk are what the record renders and the audit found no HIGH damage — and it writes
 * `pov-map.md` **before** the seal, so a refusal to overwrite an authored map stops the publish rather
 * than leaving a sealed volume its own gate cannot grade. A rehearsal never reaches this file.
 *
 * @module utils/reference-store/rebuild/publish
 */

const fs = require("fs");
const path = require("path");

const {
  DOCUMENT_VOICE,
  storeDocumentProse,
} = require("../document-prose");
const { writePovMapFile, POV_MAP_FILE } = require("../pov-map");
const { refusal } = require("../refusals");
const { moveArtifactAside, ensureArtifactRejectIgnoreRule } = require("../quarantine");
require("../../../types"); // JSDoc type definitions

/**
 * Publish the rebuilt reference into the volume's own folder **and seal the record that describes it**.
 *
 * These are one act and not two, and that is the whole point of this function. A volume's record is
 * sealed when the artifact it describes is the artifact the volume actually publishes; sealing anything
 * else publishes a record that does not describe the book. So the seal is not a flag a caller may set
 * and not a step a caller may skip: it happens here, after the file is on disk, or it does not happen.
 * A rehearsal writes a scratch copy somewhere else and never reaches this function, which is why a
 * rehearsal cannot seal — not because the command forgot to ask, but because nothing was published.
 *
 * Three things have to be true before the seal runs, and each one is checked rather than trusted:
 *
 *   1. the artifact is written — and an existing artifact is only replaced when `moveAside` says so;
 *   2. the file **on disk** is byte-for-byte what the record renders, read back rather than assumed,
 *      because a record that is sealed against a file it does not match is worse than a draft;
 *   3. the audit found no HIGH damage, because sealing is what lets the next volume build on this one
 *      and a damaged record must not become immutable just because a rebuild finished.
 *
 * @param {ReferenceStore} store - Opened with `stage: REBUILD_SOURCE_STAGE`.
 * @param {string} volumeDir - The volume folder the published artifact belongs to.
 * @param {{markdown: string, opening?: string[]}} rendered
 * @param {{highFindings?: Array<Object>}} audit - What the audit said about this reference.
 * @param {{file?: string, moveAside?: boolean, pov?: {markdown: string}|null}} [opts] - `pov`, when
 *   given, is the map rendered from the same record: it is written **before** the seal, because a
 *   volume published without the file its own acceptance check asks for is a volume that cannot be
 *   graded, and a seal that hides that is worse than no seal.
 * @returns {{ok: boolean, written: string|null, moved: string|null, sealed: Object|null, refusal: ReferenceRefusal|null}}
 */
function publishRebuiltVolume(store, volumeDir, rendered, audit, { file = "character-voice.md", moveAside = false, pov = null } = {}) {
  const written = writeRebuiltVoiceFile(store, volumeDir, rendered, { file, moveAside });
  if (!written.ok) return { ok: false, written: null, moved: null, unchanged: false, sealed: null, refusal: written.refusal };

  const target = written.written;
  /** @type {string|null} */
  let onDisk = null;
  try {
    onDisk = fs.readFileSync(target, "utf8");
  } catch (err) {
    return {
      ok: false,
      written: target,
      moved: written.moved,
      unchanged: written.unchanged,
      sealed: null,
      refusal: refusal({
        verb: "publish_rebuilt_voice",
        rule: "published-artifact-cannot-be-read",
        because: `${target} was written and cannot be read back: ${err.message}. A record is not sealed against a file nobody can open.`,
        useInstead: ["fix the folder or the file name, then rebuild again"],
        fix: "check the volume folder's permissions; the record and the rows are already in place.",
      }),
    };
  }

  if (onDisk !== rendered.markdown) {
    return {
      ok: false,
      written: target,
      moved: written.moved,
      unchanged: written.unchanged,
      sealed: null,
      refusal: refusal({
        verb: "publish_rebuilt_voice",
        rule: "published-artifact-is-not-what-the-record-renders",
        because:
          `${target} is ${onDisk.length} character(s) and the record renders ${rendered.markdown.length}. ` +
          "Sealing this record would publish a reference that does not describe the file the volume has.",
        useInstead: ["rebuild again so the file and the record come from the same render"],
        fix: "re-run the rebuild; whatever wrote that file was not this record.",
      }),
    };
  }

  /**
   * The map goes down before the seal does.
   *
   * The acceptance check names `pov-map.md`, and the harness refuses a named-file message whose file
   * is missing — so a volume published without it is a volume the stage's own gate cannot run on.
   * Sealing first and failing on the map afterwards would leave exactly that volume with a record
   * the next volume is allowed to build on. Writing it here means a refusal to overwrite an authored
   * map stops the publish, not just the map.
   */
  let povMap = null;
  if (pov) {
    const mapWritten = writePovMapFile(volumeDir, pov, { file: POV_MAP_FILE, moveAside });
    if (!mapWritten.ok) {
      return {
        ok: false,
        written: target,
        moved: written.moved,
        unchanged: written.unchanged,
        sealed: null,
        povMap: null,
        refusal: mapWritten.refusal,
      };
    }
    povMap = { written: mapWritten.written, moved: mapWritten.moved, unchanged: mapWritten.unchanged };
  }

  const high = (audit && audit.highFindings) || [];
  if (high.length) {
    return {
      ok: false,
      written: target,
      moved: written.moved,
      unchanged: written.unchanged,
      sealed: null,
      refusal: refusal({
        verb: "publish_rebuilt_voice",
        rule: "rebuild-will-not-seal-a-damaged-record",
        because:
          `the audit reports ${high.length} HIGH finding(s) against this reference ` +
          `(${high.map((f) => f.kind).join(", ")}). The file is written, but the record stays a draft: ` +
          "sealing is what lets the next volume build on this one, and a damaged record does not get to " +
          "become immutable because the rebuild finished.",
        useInstead: ["fix what the HIGH finding names and rebuild again", "challengeFact on a row that is wrong but published"],
        fix: high.map((f) => `${f.kind}: ${f.message}`).join(" | "),
      }),
    };
  }

  const sealed = store.sealVolume(store.volume);
  const marker = store.db.prepare("SELECT value FROM store_info WHERE key = ?").get(`sealed_volume_${store.volume}`);
  return {
    ok: true,
    written: target,
    moved: written.moved,
    unchanged: written.unchanged,
    povMap,
    sealed: {
      state: "sealed",
      at: (marker && marker.value) || "unknown",
      rows: sealed.sealedRows,
      snapshot: sealed.snapshot,
      alreadySealed: sealed.alreadySealed,
      because: "the rebuilt reference was published into this volume's own folder, so the record that describes it is sealed.",
    },
    refusal: null,
  };
}

/**
 * Write the rebuilt reference into the volume folder, and make the record agree with the file.
 *
 * Three things happen here and they happen in this order, because the order is the safety:
 *
 *   1. the existing artifact is moved to `character-voice.md.rejected` — kept as evidence, never read
 *      by the next volume — and a refusal here means nothing was written;
 *   2. the new file is written;
 *   3. the file's own opening lines are stored as document prose, so the record and the artifact say
 *      the same thing and a later import round-trips the preamble instead of inventing one.
 *
 * The damaged file is never imported. That is the point of the whole module.
 *
 * @param {ReferenceStore} store
 * @param {string} volumeDir - The volume folder the artifact lives in.
 * @param {{markdown: string, preamble?: string[]}} rendered
 * @param {{file?: string, moveAside?: boolean}} [opts] - `moveAside` is the explicit permission to
 *   touch an existing artifact. Without it an existing file is a refusal, not an overwrite.
 * @returns {{ok: boolean, written: string|null, moved: string|null, unchanged: boolean, asideSlot: number, keptAside: string[], refusal: ReferenceRefusal|null}}
 */
function writeRebuiltVoiceFile(store, volumeDir, rendered, { file = "character-voice.md", moveAside = false } = {}) {
  const target = path.join(volumeDir, file);

  /**
   * The one case where an existing file is not something being destroyed: the file on disk is already
   * byte-for-byte what this record renders. Re-running a rebuild over its own output is the ordinary
   * way that happens — a rebuild that published but did not seal, run again to seal — and refusing it
   * because `character-voice.md.rejected` is already there would lock the volume out of its own seal.
   * Nothing is lost by writing the same bytes, so nothing has to be moved aside.
   */
  let unchanged = false;
  if (fs.existsSync(target)) {
    try {
      unchanged = fs.readFileSync(target, "utf8") === rendered.markdown;
    } catch {
      unchanged = false;
    }
  }

  if (fs.existsSync(target) && !moveAside && !unchanged) {
    return {
      ok: false,
      written: null,
      moved: null,
      unchanged: false,
      refusal: refusal({
        verb: "write_rebuilt_voice",
        rule: "rebuild-will-not-overwrite-an-artifact",
        because: `${target} already exists and is not what this record renders. A rebuild replaces the reference it is rebuilding, and doing that silently is how volume 01's destroyed file would have been lost without a trace.`,
        useInstead: ["moveArtifactAside(volumeDir, file) — the damaged file is kept as `.rejected` evidence, then write"],
        fix: "say what to do with the existing file: move it aside deliberately, or rebuild into a different folder.",
      }),
    };
  }

  let moved = null;
  /** @type {{slot: number, keptAside: string[]}} */
  let asideReport = { slot: 0, keptAside: [] };
  if (moveAside && !unchanged) {
    const aside = moveArtifactAside(volumeDir, file);
    if (!aside.ok) return { ok: false, written: null, moved: null, unchanged: false, asideSlot: 0, keptAside: [], refusal: aside.refusal };
    moved = aside.moved;
    asideReport = { slot: aside.slot, keptAside: aside.keptAside.map((p) => path.basename(p)) };
  }

  fs.writeFileSync(target, rendered.markdown, "utf8");

  // The opening the file actually has, stored as the record's opening — the same block
  // `parseVoiceMarkdown` would have produced from this file, so the record and the artifact agree.
  storeDocumentProse(store, DOCUMENT_VOICE, [{ section: null, kind: "title", lines: rendered.opening }]);

  return {
    ok: true,
    written: target,
    moved,
    unchanged,
    asideSlot: asideReport.slot,
    keptAside: asideReport.keptAside,
    refusal: null,
  };
}

module.exports = {
  publishRebuiltVolume,
  writeRebuiltVoiceFile,
};
