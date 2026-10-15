/**
 * utils/reference-store/voice-revision.js — the barrel for the voice revision door (plan 06 slice 6).
 *
 * Two concerns, two files, one public surface, in the shape AGENTS.md §3 requires:
 *
 *   - `voice-revision/rows.js` — the **read**: which claim this record stands behind for one (roster
 *     entry, declared register question) pair at one volume, whether it can answer at all, and what that
 *     claim replaced. It issues no write statement, and it is the read both the door and the render ask,
 *     so "which claim is current" and "what came before it" have one answer each.
 *   - `voice-revision/file.js` — the **door**: file this volume's replacement as a new row and mark the
 *     published one superseded through `facts/supersede.js`, in one transaction, with the quote checked
 *     against this volume's own book first.
 *
 * The pair is the voice side of `glossary-adapter/rows.js` + `glossary-adapter/revision.js`, and it adds
 * no verb to the store: `markSuperseded` is the only door onto a published row and this layer calls it
 * rather than replacing it. It is a **guard** layer — it lives inside `utils/reference-store/`, which is
 * already a banned patch path for the dev team, and both files stay inside that folder.
 *
 * It is wired into **no stage**. Nothing in the pipeline calls it, no setting reaches it, and no prompt
 * mentions it; the call baselines are therefore unmoved. Whether a stage should call it, and what would
 * tell it that a character changed, is plan 06 §10's open decision (the honest answer today is that only
 * a model could supply that, and plan 06 §6 lists turning extraction noise into published "development"
 * as the risk to avoid). The slice that can be built and measured is the door and the render, so that is
 * what was built and measured.
 *
 * @module utils/reference-store/voice-revision
 */

const rows = require("./voice-revision/rows");
const file = require("./voice-revision/file");

module.exports = {
  // The read: the chain, the claim in force at a volume, and the arc.
  CHAIN_COLUMNS: rows.CHAIN_COLUMNS,
  voiceContentScope: rows.voiceContentScope,
  voiceClaimChainForAxis: rows.voiceClaimChainForAxis,
  voiceClaimInForceForAxis: rows.voiceClaimInForceForAxis,
  voiceRevisionAlreadyFiled: rows.voiceRevisionAlreadyFiled,
  supersededVoiceClaims: rows.supersededVoiceClaims,

  // The door: one revision, and the batch half that reports every refusal instead of throwing them.
  REVISION_EXAMPLES_PER_ROW: file.REVISION_EXAMPLES_PER_ROW,
  fileVoiceRevision: file.fileVoiceRevision,
  importVoiceRevisions: file.importVoiceRevisions,
};
