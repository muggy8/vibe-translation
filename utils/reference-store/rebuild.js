/**
 * utils/reference-store/rebuild.js — rebuild one volume's character-voice reference from the
 * extraction output that already exists, with no model call anywhere in the path.
 *
 * Why this exists. Volume 01's `character-voice.md` is destroyed: 106 lines, one of them 54,341
 * characters, 3 character sections for a cast of 10, and 7 characters with no voice claim at all
 * (gotcha 96). Its **extraction output is healthy** — `character-voice-new.json`, 223 structured
 * claims, produced for about 1.1M tokens, and it did its job. Importing the destroyed document into
 * the store faithfully reproduces the damage; rebuilding from the extraction does not.
 *
 * ## The candidate question, and the decision
 *
 * `voice-adapter.js` renders rows whose `source_stage` is not `extract`. That filter is a guard, not
 * a preference: extraction claims are candidates the published document may or may not have adopted,
 * and a renderer that included them would put un-adopted extractor chatter into an artifact a
 * translator reads. **This module does not touch that filter.** It does not widen it, parameterise
 * it, or bypass it.
 *
 * Instead it adds a fourth kind of row: `source_stage = "rebuild"`, which only the code in this folder
 * ever stamps. A claim becomes renderable by being **adopted in the open** — a named, deterministic,
 * code-only step that re-runs the same evidence rule every other row goes through, and records that
 * it made the adoption decision rather than an author agent. Three things follow, and they are the
 * reason this shape was chosen over the alternatives:
 *
 *   - **The evidence rule is unchanged.** A rebuild claim that cites no line of this volume's text is
 *     refused exactly like an extraction claim and exactly like a glossary row. The gate is the same
 *     gate; what changed is who wrote the row down.
 *   - **Both halves survive.** Promoting the extraction rows in place (an `UPDATE` of their
 *     `source_stage`) would collapse "what the extractor found" and "what the document says" into one
 *     set of rows, and `unadoptedVoiceClaims` — the query that exists to compare them — would then
 *     answer "nothing" forever. Rebuild rows are copies; the extraction rows stay where they are.
 *   - **The provenance is in the record, not in a comment.** `store_info` carries a rebuild marker per
 *     volume, `integrity.js`/`validation.js` report it on every audit, and the rendered file says it
 *     in its own preamble. A rebuilt reference is never mistaken for an authored one.
 *
 * ## What it refuses
 *
 *   - a volume whose record already mirrors a **sealed** character-voice document: those rows are
 *     published, and the only door to a published row is `challengeFact`, not a rebuild;
 *   - an existing `character-voice.md` when the caller has not explicitly said what to do with it. The
 *     damaged file is moved to `character-voice.md.rejected` — kept as evidence, never read by the
 *     next volume — and it is never imported into the record as if it were trustworthy, and never
 *     silently overwritten.
 *
 * ## Ordering
 *
 * Sections come in the order the volume's chapters come, keyed on the earliest chapter any of that
 * character's claims cites; bullets within a section the same way. Doc 04 §7.1 decided the notes
 * record *what changed and when* and not *what the change means*, so the chronological order is the
 * only thing carrying the meaning, and an insertion-order render would lose it.
 *
 * No model call reaches this file, and no agent tool is defined here.
 *
 * ## Where the code lives
 *
 * The code is in `utils/reference-store/rebuild/`, one responsibility per file: `labels.js` (the bullet
 * labels and the two truncation bounds the artifact is written with), `names.js` (the alias declarations
 * applied before anything is filed — the operator's, and the ones read out of the volume's own
 * `glossary.md`), `mirror.js` (what the record already holds, and whether a rebuild may write into it),
 * `filing.js` (adopting the extraction's claims as rebuild rows and filing each one's candidate copy
 * beside it, through the second handle), `render.js` (rendering the reference from the record in chapter
 * order, with every bullet capped and every cap named), `earlier-volumes.js` (the guard that refuses a
 * rebuild whose record has forgotten the volumes before this one), `publish.js` (writing the artifact and
 * the POV map into the volume's folder, and sealing the record in the same act), and `volume.js` (the
 * whole flow for one volume, in order). This file is the public surface of the rebuild layer and the only
 * thing another module should require; the row-kind rules and the refusal shapes stay inside this folder,
 * which is a banned patch path for the dev team (AGENTS.md §3).
 *
 * @module utils/reference-store/rebuild
 */

const { REBUILD_SOURCE_STAGE } = require("./schema");

const labels = require("./rebuild/labels");
const names = require("./rebuild/names");
const mirror = require("./rebuild/mirror");
const filing = require("./rebuild/filing");
const render = require("./rebuild/render");
const earlierVolumes = require("./rebuild/earlier-volumes");
const publish = require("./rebuild/publish");
const volume = require("./rebuild/volume");

// The public surface, unchanged from the single file.
module.exports = {
  REBUILD_SOURCE_STAGE,
  REBUILT_VOICE_TITLE: labels.REBUILT_VOICE_TITLE,
  REBUILT_VOICE_SECTION: labels.REBUILT_VOICE_SECTION,
  QUIRK_TYPE_TO_VOICE_LABEL: labels.QUIRK_TYPE_TO_VOICE_LABEL,
  POV_VOICE_LABEL: labels.POV_VOICE_LABEL,
  MAX_REBUILD_BULLET_CHARS: labels.MAX_REBUILD_BULLET_CHARS,
  REBUILT_EXAMPLES_PER_BULLET: labels.REBUILT_EXAMPLES_PER_BULLET,
  MAX_REBUILD_ARC_LINES_PER_CHARACTER: labels.MAX_REBUILD_ARC_LINES_PER_CHARACTER,
  applyAliasDeclarations: names.applyAliasDeclarations,
  rebuildClaimAlreadyStored: mirror.rebuildClaimAlreadyStored,
  inspectVoiceMirrorForRebuild: mirror.inspectVoiceMirrorForRebuild,
  rebuildVoiceFromExtraction: filing.rebuildVoiceFromExtraction,
  renderRebuiltVoice: render.renderRebuiltVoice,
  writeRebuiltVoiceFile: publish.writeRebuiltVoiceFile,
  publishRebuiltVolume: publish.publishRebuiltVolume,
  rebuildVoiceVolume: volume.rebuildVoiceVolume,
  rebuildRecordIsMissingItsEarlierVolumes: earlierVolumes.rebuildRecordIsMissingItsEarlierVolumes,
  planHasEarlierVolumes: earlierVolumes.planHasEarlierVolumes,
};
