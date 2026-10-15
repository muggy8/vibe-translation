/**
 * utils/reference-store/confirmations/shapes.js — the entry kind that means "this is not a claim".
 *
 * A **pure leaf**: it requires nothing but the type definitions, the same shape
 * `glossary/carry-forward/table.js` has. That is deliberate. The two doors that read a volume's extraction
 * notebook — `extraction-adapter.js` and `rebuild/filing.js` — both have to recognise this kind, and the
 * door that files it needs the aspect and label tables `extraction-adapter.js` owns. If the constant lived
 * in `confirmations/file.js`, the adapter would require the door and the door would require the adapter:
 * a require cycle inside `utils/reference-store/`, which is exactly the shape AGENTS.md §3 warns about for
 * `utils/postmortem` (gotcha 85) and which hands one of them a half-built barrel.
 *
 * @module utils/reference-store/confirmations/shapes
 */

require("../../../types"); // JSDoc type definitions

/**
 * The `type` an extraction entry carries when it reports that a claim the record already stands behind is
 * still true in this volume, rather than asserting a new one.
 *
 * The other two kinds the notebook holds are `voice` (a claim about how somebody speaks) and `pov` (a
 * claim about whose eyes a passage is in). This one asserts nothing about the book on its own: it names a
 * character and the kind of thing that has not changed, and the claim it re-confirms is looked up in the
 * record. A door that does not know the kind must not turn it into a claim — which is why both doors
 * dispatch on it rather than falling through to the voice path.
 */
const CONFIRMATION_ENTRY_TYPE = "confirm";

module.exports = {
  CONFIRMATION_ENTRY_TYPE,
};
