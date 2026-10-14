/**
 * utils/reference-store/rebuild/mirror.js — what this volume's record already holds, and whether a
 * rebuild is allowed to go ahead.
 *
 * The two questions asked before anything is filed: is this exact claim already in the record (a
 * rebuild must be re-runnable), and is the record one a rebuild may write into — sealed rows are
 * published and out of reach, and another stage's unsealed mirror rows are rows this handle is not
 * allowed to delete.
 *
 * @module utils/reference-store/rebuild/mirror
 */

const { REBUILD_SOURCE_STAGE, DOCUMENT_SOURCE_STAGE } = require("../schema");
const { refusal } = require("../refusals");
require("../../../types"); // JSDoc type definitions

/**
 * Whether this exact claim is already in the record as a rebuild claim.
 *
 * A rebuild is re-runnable: the rehearsal runs twice, and a real run may be re-run after a repair. A
 * second pass must not file the same 223 claims again and make the audit count a volume twice.
 *
 * @param {ReferenceStore} store
 * @param {{key: string|null, aspect: string, body: string}} claim
 * @returns {boolean}
 */
function rebuildClaimAlreadyStored(store, { key, aspect, body }) {
  const rows = store.db
    .prepare("SELECT body FROM facts WHERE aspect = ? AND source_stage = ? AND key IS ?")
    .all(aspect, REBUILD_SOURCE_STAGE, key);
  const needle = String(body || "").replace(/\s+/g, " ").trim();
  return rows.some((row) => String(row.body || "").replace(/\s+/g, " ").trim() === needle);
}

/**
 * What this volume's record already holds for its character-voice document, and whether a rebuild may
 * go ahead.
 *
 * The damaged file must not be treated as trustworthy, and it must not be silently overwritten. So the
 * rebuild looks at what the record already mirrors and answers in one of three ways: nothing there
 * (proceed); sealed rows, which are published and therefore out of reach — the only door to a published
 * row is `challengeFact`, and a rebuild is not a challenge; or this volume's own unsealed mirror rows,
 * which are the rows the rebuild is replacing but which **this handle is not allowed to delete**,
 * because they were written by the import stage and ownership is stamped by the handle that wrote them.
 * The third case is a refusal that names the legal verb: `resetDocumentMirror`, run from a handle opened
 * with the import stage. `rebuildVoiceVolume` does exactly that before it files anything.
 *
 * **The sealing question is asked about the character-voice document, not about the volume's seal
 * marker.** It used to be asked as "does this volume hold sealed rows whose `source_stage` is the
 * document mirror", which was true of the author route's record and false of the read-then-assemble
 * route's: that route files its adopted claims as `rebuild` rows and its extraction copies as `extract`
 * rows, so a volume sealed by it had zero sealed `document` rows and a full `--apply --move-aside`
 * rebuild ran straight over its published record (gotcha 109). The row query below closes that: it
 * counts sealed rows over **every** stage, so a published reference is caught whoever wrote it.
 *
 * What it does not count is the volume's seal marker on its own, and that is a deliberate correction,
 * not a loosening. `npx gulp` runs each stage over every volume before the next stage starts, and the
 * glossary stage seals the volume at the end of its own work on it (see `glossary/store.js`'s header),
 * so by the time the character-voice stage reaches a volume its record is already sealed — with nothing
 * in it but glossary rows. Refusing on the marker alone told that stage it was overwriting a published
 * character-voice reference when the reference it was about to write was the first one that volume ever
 * had. A seal with no character-voice rows under it is not a published character-voice reference; it is
 * a published glossary. The marker is still reported (`volumeSealed`), because a stage that renders into
 * a record another stage already sealed is worth seeing in the log.
 *
 * @param {ReferenceStore} store
 * @param {number} vol
 * @returns {{ok: boolean, sealed: number, sealedStages: Object<string, number>, volumeSealed: boolean, unsealed: number, refusal: ReferenceRefusal|null}}
 */
function inspectVoiceMirrorForRebuild(store, vol) {
  /** @type {Object<string, number>} */
  const sealedStages = {};
  let sealedTotal = 0;
  for (const row of store.db
    .prepare(
      "SELECT source_stage, COUNT(*) AS n FROM facts " +
        "WHERE owner_volume = ? AND sealed = 1 AND aspect != 'term_usage' GROUP BY source_stage"
    )
    .all(vol)) {
    sealedStages[row.source_stage] = row.n;
    sealedTotal += row.n;
  }
  const volumeSealed = store.isVolumeSealed(vol);

  if (sealedTotal > 0) {
    const kinds = Object.entries(sealedStages)
      .sort((a, b) => b[1] - a[1])
      .map(([stage, n]) => `${n} ${stage}`)
      .join(", ");
    return {
      ok: false,
      sealed: sealedTotal,
      sealedStages,
      volumeSealed,
      unsealed: 0,
      refusal: refusal({
        verb: "rebuild_voice",
        rule: "rebuild-refuses-a-sealed-voice-record",
        because:
          `volume ${vol}'s record holds ${sealedTotal} sealed character-voice row(s) of its own ` +
          `(${kinds})${volumeSealed ? ", and the volume is sealed" : ""}. ` +
          "Sealed rows are published; a rebuild does not replace them, whatever stage wrote them.",
        useInstead: [
          "challenge_fact",
          "reopenVolumeRecord({ volume, reason, cascade: \"retire\" }) — the recorded door that retires a published record and re-derives it",
        ],
        fix:
          `contest those rows with challenge_fact, or reopen volume ${vol}'s record deliberately with a reason ` +
          "(npm run reopen -- --volume=NN --reason=\"…\") and let the next run re-derive it from the beginning.",
      }),
    };
  }

  // The unsealed half keeps its `source_stage` filter, and that is deliberate: this half of the rule is
  // not about sealing, it is about rows a rebuild handle cannot delete and would therefore duplicate in
  // the render. `resetDocumentMirror` clears the document mirror, and the rebuild's own rows are already
  // caught by `rebuildClaimAlreadyStored`, which carries an identical claim instead of filing it twice.
  const unsealed = store.db
    .prepare("SELECT COUNT(*) AS n FROM facts WHERE owner_volume = ? AND source_stage = ? AND sealed = 0 AND aspect != 'term_usage'")
    .get(vol, DOCUMENT_SOURCE_STAGE).n;
  if (unsealed > 0 && store.scope.stage !== DOCUMENT_SOURCE_STAGE) {
    return {
      ok: false,
      sealed: 0,
      sealedStages,
      volumeSealed,
      unsealed,
      refusal: refusal({
        verb: "rebuild_voice",
        rule: "rebuild-needs-its-mirror-cleared-first",
        because: `volume ${vol}'s record still mirrors ${unsealed} row(s) of its existing character-voice document. A rebuild renders everything the record holds, so those rows would end up in the file next to the rebuilt ones — and a rebuild handle may not delete rows the import stage wrote, because ownership is stamped by the handle that wrote them.`,
        useInstead: [`resetDocumentMirror(store, { document: "voice" }) from a handle opened with stage "${DOCUMENT_SOURCE_STAGE}"`, "rebuildVoiceVolume(...) does that step for you"],
        fix: `clear this volume's voice mirror first; the rows are its own and unsealed, which is exactly what delete_own_fact exists for.`,
      }),
    };
  }

  return { ok: true, sealed: 0, sealedStages, volumeSealed, unsealed, refusal: null };
}

module.exports = {
  rebuildClaimAlreadyStored,
  inspectVoiceMirrorForRebuild,
};
