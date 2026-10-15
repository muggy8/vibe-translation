/**
 * utils/reference-store/confirmations.js — the barrel for "a volume saw this claim again" (plan 06 slice 7).
 *
 * Three files, one public surface, in the shape AGENTS.md §3 requires:
 *
 *   - `confirmations/shapes.js` — a **pure leaf** holding the one entry kind that means "this is not a
 *     claim", so the two doors that read a volume's extraction notebook can both recognise it without one
 *     of them requiring the other (gotcha 85).
 *   - `confirmations/rows.js` — the **read**: which claims this volume re-confirmed, which volumes have
 *     re-confirmed this claim, and how many there are. It issues no write statement, and it is the read
 *     the render and the stage's log both ask, so "has this volume seen this claim" has one answer.
 *   - `confirmations/file.js` — the **door**: resolve which claim the entry means, check the character is
 *     in this volume's own text and the quoted line is in this volume's own book, and file one row.
 *
 * ## What this layer is, in one line
 *
 * `claim_confirmations` is one row per (claim, volume that saw it) and it carries **no body**. It is the
 * reason "this claim still holds" stops being an assumption the render makes on behalf of every volume
 * nobody asked (plan 06 §2.4) and becomes a list of volumes that said so.
 *
 * ## What it never touches
 *
 * It writes **nothing into `facts`** — not `applies_to_volume`, not `status`, not `updated_at`, not
 * `row_version`. A confirmation is an observation about a published row, and a published row is never
 * edited, moved or re-labelled (AGENTS.md rule 5). It files no claim, no candidate, no cast entry, no
 * `cast_alias`, no challenge, and it marks nothing. It adds **no verb** to the store and **no finding
 * kind**: a volume that confirmed nothing is a volume whose characters did not reappear, which is a fact
 * about the book rather than a defect in the record, and the level table stays at 70 kinds.
 *
 * It is a **guard** layer: it lives inside `utils/reference-store/`, which is already a banned patch path
 * for the dev team, and all three files stay inside that folder.
 *
 * @module utils/reference-store/confirmations
 */

const shapes = require("./confirmations/shapes");
const rows = require("./confirmations/rows");
const file = require("./confirmations/file");

module.exports = {
  // The kind, shared with both doors that read the notebook.
  CONFIRMATION_ENTRY_TYPE: shapes.CONFIRMATION_ENTRY_TYPE,

  // The read: this volume's confirmations, one claim's confirmations, and the counts.
  CONFIRMATION_COLUMNS: rows.CONFIRMATION_COLUMNS,
  claimConfirmationsForVolume: rows.claimConfirmationsForVolume,
  confirmationsForClaim: rows.confirmationsForClaim,
  confirmationsForCharacter: rows.confirmationsForCharacter,
  confirmationCounts: rows.confirmationCounts,
  confirmationAlreadyFiled: rows.confirmationAlreadyFiled,

  // The door: one confirmation, and the batch half that reports every refusal instead of throwing them.
  claimsOpenToConfirmation: file.claimsOpenToConfirmation,
  resolveConfirmedClaim: file.resolveConfirmedClaim,
  preparedNamesForEntry: file.preparedNamesForEntry,
  prepareVolumeLines: file.prepareVolumeLines,
  characterInPreparedLines: file.characterInPreparedLines,
  fileVoiceConfirmation: file.fileVoiceConfirmation,
  fileVoiceConfirmations: file.fileVoiceConfirmations,
};
