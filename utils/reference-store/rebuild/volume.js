/**
 * utils/reference-store/rebuild/volume.js — the whole flow for one volume, in order.
 *
 * Clear this volume's mirror of the reference being replaced (from the handle that wrote those rows),
 * apply the declared aliases, file the extraction claims and their candidates, render the reference and
 * the POV map, audit the result, and publish-and-seal only when the caller said this is the volume's
 * real folder. Whether the artifact is published is the caller's decision; the seal is not.
 *
 * @module utils/reference-store/rebuild/volume
 */

const path = require("path");

const { openReferenceStore } = require("../open");
const { REBUILD_SOURCE_STAGE, EXTRACTION_SOURCE_STAGE, DOCUMENT_SOURCE_STAGE } = require("../schema");
const { auditVolumeRecord, renderVolumeAuditReport, resetDocumentMirror, volumeRecordExists } = require("../pipeline-store");
const { renderPovMap } = require("../pov-map");
const { refusal } = require("../refusals");

const { applyAliasDeclarations, declarationsFromVolumeGlossary } = require("./names");
const { rebuildVoiceFromExtraction } = require("./filing");
const { renderRebuiltVoice } = require("./render");
const { rebuildRecordIsMissingItsEarlierVolumes, planHasEarlierVolumes } = require("./earlier-volumes");
const { publishRebuiltVolume } = require("./publish");
require("../../../types"); // JSDoc type definitions

/**
 * Rebuild one volume's character-voice reference, end to end, and say what happened.
 *
 * The whole flow the command runs: clear this volume's mirror of the reference being replaced, apply
 * the declared aliases, file the extraction claims as rebuild rows (and their candidate copies), render
 * the file, audit the result, and — when the caller says this is the real volume folder — publish the
 * artifact and seal the record. Whether the **artifact** is published is the caller's decision, because
 * the artifact is the thing the next volume reads; the seal is not the caller's decision, because a
 * published reference with a draft record is exactly the state that blocks the next volume. It does not
 * carry an earlier volume's record forward — `rebuildRecordIsMissingItsEarlierVolumes` refuses rather
 * than rendering a reference that has silently forgotten the volumes before this one.
 *
 * @param {Object} opts
 * @param {number|string} opts.volume
 * @param {string} [opts.folder]
 * @param {string} [opts.seriesDir]
 * @param {Array<Object>} opts.entries - Parsed `character-voice-new.json`.
 * @param {Array<{key: string, alias: string, reason: string}>} [opts.aliases]
 * @param {Array<{id: string, file: string, chars?: number}>|null} [opts.bundleSegments]
 * @param {boolean} [opts.apply] - Publish the artifact into this volume's own folder and seal the record.
 *   Without it the caller has a rehearsal: the record is built, the file is a scratch copy, and nothing
 *   is sealed.
 * @param {boolean} [opts.moveAside] - With `apply`: move an existing artifact to `.rejected` first.
 * @returns {{ok: boolean, refusal: ReferenceRefusal|null, aliases: {applied: Array<Object>, refused: Array<Object>}, cleared: {deleted: number, refused: Array<Object>}, rebuild: Object|null, rendered: Object|null, povRendered: Object|null, audit: Object|null, published: Object|null, store: ReferenceStore|null}}
 */
function rebuildVoiceVolume({ volume, folder, seriesDir, entries, aliases = [], bundleSegments = null, apply = false, moveAside = false }) {
  const volNumber = Number(volume);

  /**
   * The one shape both halves of the "carry it first" guard return.
   * @returns {ReturnType<typeof rebuildVoiceVolume>}
   */
  const needsCarryingFirst = () => ({
    ok: false,
    refusal: refusal({
      verb: "rebuild_voice",
      rule: "rebuild-record-missing-its-earlier-volumes",
      because: `volume ${volNumber} is not the first volume, and its record holds nothing from the volumes before it. A rebuild files this volume's claims; it does not carry the earlier record forward, and a reference rebuilt into an empty record would silently drop every character the earlier volumes established.`,
      useInstead: ["openVolumeRecord({ volume, folder, seriesDir }) — or run the character-voice stage once, which carries the previous volume's record first", "rebuild volume 1 first, then work forward"],
      fix: `carry volume ${volNumber - 1}'s record into volume ${volNumber} before rebuilding it.`,
    }),
    aliases: { applied: [], refused: [] },
    cleared: { deleted: 0, refused: [] },
    rebuild: null,
    rendered: null,
    povRendered: null,
    audit: null,
    published: null,
    store: null,
  });

  // Asked before anything is opened: opening a store CREATES its file, and a refusal that left an
  // empty record behind would then block the copy-forward this refusal is telling the operator to run.
  if (planHasEarlierVolumes(seriesDir, volNumber) && !volumeRecordExists({ volume: volNumber, folder, seriesDir })) {
    return needsCarryingFirst();
  }

  // Step one is clearing this volume's mirror of the reference being replaced, and it has to happen
  // from a handle opened with the stage that wrote those rows: ownership is stamped by the handle, and
  // a rebuild handle is not allowed to delete the import stage's rows. `resetDocumentMirror` is the
  // legal verb for exactly that set — this volume's own, unsealed — and a volume whose voice record has
  // been sealed is refused further down, because a published record is not what a rebuild replaces.
  let cleared = { deleted: 0, refused: [] };
  const mirrorHandle = openReferenceStore({ volume, folder, seriesDir, stage: DOCUMENT_SOURCE_STAGE });
  try {
    cleared = resetDocumentMirror(mirrorHandle, { document: "voice" });
  } finally {
    mirrorHandle.close();
  }

  const opened = openReferenceStore({ volume, folder, seriesDir, stage: REBUILD_SOURCE_STAGE });
  try {
    const registered = opened.registerChaptersFromSource(bundleSegments);
    if (!registered.ok) {
      return {
        ok: false,
        refusal: refusal({
          verb: "rebuild_voice",
          rule: "rebuild-source-unreadable",
          because: `this volume's own source could not be listed: ${registered.error}`,
          useInstead: ["extract the volume first"],
          fix: "point the rebuild at the volume folder that already holds its extracted chapters.",
        }),
        aliases: { applied: [], refused: [] },
        cleared,
        rebuild: null,
        rendered: null,
        povRendered: null,
        audit: null,
        published: null,
        store: null,
      };
    }

    if (rebuildRecordIsMissingItsEarlierVolumes(opened, volNumber, seriesDir)) {
      return needsCarryingFirst();
    }

    // The glossary's own declaration of who narrates in the first person, read from the volume folder.
    //
    // The pipeline's door gets this from `importGlossary`, which the rebuild path does not run — it files
    // claims, it does not re-import a glossary the volume already published. Asked here instead, so the
    // two doors cannot give two different answers to `俺（ジョーロ）`: a volume rebuilt through
    // `rebuild-voice` and a volume rebuilt through the stage must agree about whose "I" that is, or the
    // pronoun split this rule exists to prevent comes back through the door that bypasses the stage.
    const fromGlossary = declarationsFromVolumeGlossary(path.join(seriesDir, folder));
    const aliasResult = applyAliasDeclarations(opened, [...fromGlossary.declarations, ...aliases]);

    // The candidate copies are filed through a second handle on the same file, opened as the extraction
    // stage. That is not a workaround: a row's kind comes from the scope its handle was opened with, so
    // the rebuild's own handle cannot file a candidate and is not allowed to try. Two handles, two
    // kinds of row, each confined to its own.
    const candidateHandle = openReferenceStore({ volume, folder, seriesDir, stage: EXTRACTION_SOURCE_STAGE });
    let rebuild;
    try {
      rebuild = rebuildVoiceFromExtraction(opened, entries, {
        mirrorRowsRemoved: cleared.deleted,
        candidateStore: candidateHandle,
      });
    } finally {
      candidateHandle.close();
    }
    if (rebuild.refusal) {
      return { ok: false, refusal: rebuild.refusal, aliases: aliasResult, cleared, rebuild, rendered: null, povRendered: null, audit: null, published: null, store: null };
    }

    const rendered = renderRebuiltVoice(opened, { volume });
    /**
     * The POV map, rendered from the same record in the same breath.
     *
     * It is not a bonus artifact: the stage's acceptance check names `pov-map.md`, and the harness
     * throws on a named file that is not there, so a route that publishes the reference without the
     * map cannot be graded by the gate at all. The record already holds the point-of-view claims —
     * this renders them instead of leaving them where nobody reads them.
     */
    const povRendered = renderPovMap(opened, { volume });
    let audit = auditVolumeRecord(opened, {
      title: "Character-voice reference (rebuilt from extraction)",
      file: "character-voice.md",
      markdown: rendered.markdown,
      refused: rebuild.refused,
    });

    /**
     * Publish, and only then seal — and only when the caller said this is the volume's real folder.
     *
     * A rehearsal built a record and a scratch file in a copy; nothing was published, so nothing is
     * sealed, and the report says so in as many words. A published reference whose record is still a
     * draft is the state that blocks the next volume, so the seal is not offered separately.
     */
    let published = null;
    /** @type {{state: "sealed"|"not-sealed", at?: string, rows?: number, snapshot?: number, alreadySealed?: boolean, because: string}} */
    let sealedAnswer = {
      state: "not-sealed",
      because:
        "this run did not publish the reference into the volume's own folder, so the record stays a draft. " +
        "A record is sealed when the reference it describes is the one the volume actually publishes.",
    };
    if (apply) {
      published = publishRebuiltVolume(opened, path.join(seriesDir, folder), rendered, audit, { file: "character-voice.md", moveAside, pov: povRendered });
      sealedAnswer = published.ok
        ? published.sealed
        : {
            state: "not-sealed",
            because: `the reference was written but the seal was refused: ${published.refusal.rule} — ${published.refusal.because}`,
          };
    }

    // The report is re-rendered rather than re-audited: the audit already ran, and running it again to
    // add one line would re-check every citation in the volume for the sake of that line.
    audit = {
      ...audit,
      markdown: renderVolumeAuditReport(audit, {
        title: "Character-voice reference (rebuilt from extraction)",
        file: "character-voice.md",
        volume: volNumber,
        refused: rebuild.refused,
        sealed: sealedAnswer,
      }),
    };

    if (apply && !published.ok) {
      return { ok: false, refusal: published.refusal, aliases: aliasResult, cleared, rebuild, rendered, povRendered, audit, published, store: opened };
    }

    return { ok: true, refusal: null, aliases: aliasResult, cleared, rebuild, rendered, povRendered, audit, published, store: opened };
  } finally {
    opened.close();
  }
}

module.exports = {
  rebuildVoiceVolume,
};
