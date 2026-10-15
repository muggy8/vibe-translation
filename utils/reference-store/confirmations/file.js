/**
 * utils/reference-store/confirmations/file.js — the door that records "this volume saw this claim again".
 *
 * Plan 06 slice 7. The chapter call has been asked since the beginning to compare what it read against
 * what the reference already covers, and to answer a trait that has not moved with "unchanged" rather than
 * re-stating it. That answer used to have nowhere to go, so the record's claim that a character still
 * talks like volume 1 is an **assumption the render makes on behalf of every volume nobody asked** — plan
 * 06 §2.4, and the reason `applies_to_volume` is null in all 22,469 rows of this corpus.
 *
 * ## What this door writes, and what it never writes
 *
 * One row in `claim_confirmations`: the claim it re-confirms, the volume that saw it, the chapter that saw
 * it first, and the line that showed it. **No body** — the claim it points at is the body, which is why
 * this is a table and not another `facts` row (plan 05's §5 rejected the copy-the-body shape: a series
 * would carry the same sentence up to seventeen times and the coverage rules would count one fact
 * seventeen times).
 *
 * It writes **nothing into `facts`**. Not `applies_to_volume`, not `status`, not `updated_at`, not
 * `row_version`. That is a stricter rule than the revision door's: `markSuperseded` moves `status` and
 * `updated_at` because a replacement has to be attributed, and a confirmation attributes nothing to the
 * claim — it only reports what a later volume saw. A published row is untouched in every column, which is
 * what "a sealed row is never edited" actually requires (AGENTS.md rule 5).
 *
 * ## Where the answer comes from, and why it costs nothing
 *
 * The chapter call already runs. Giving its "unchanged" answer a destination costs a slightly larger
 * answer, not another call (plan 06 §5). So the entry that feeds this door is a third kind in the same
 * array the claims arrive in — `type: "confirm"` — and the door is called from the same place the claims
 * are filed.
 *
 * ## The guards, in the order they run
 *
 *   1. **The handle may not be the extraction's.** A row filed under `extract` is excluded by every
 *      renderer, by `currentClaimSql`, by the chapter block and by the axis queries. A confirmation filed
 *      through that handle would be a record of an observation nothing can read.
 *   2. **The handle's volume is the volume that saw it.** The row's `seen_volume` has to be the volume the
 *      reading pass was reading; a door that lets a caller name a different one is a door that files
 *      observations about books it never opened.
 *   3. **The entry names a character, and that character is somebody this record already knows.** A
 *      confirmation of a character the roster does not hold is a claim about a new character wearing a
 *      confirmation, and a new character is the claim door's job.
 *   4. **The claim it confirms has to be one this record currently stands behind at this volume** —
 *      `currentClaimSql`, the validity span, the renderers' exclusion of the extraction's own copies, and
 *      no glossary rows. Two live claims the entry could mean and nothing that separates them is a
 *      refusal, not a pick by `ord`: the same reason `resolveExtractionName` refuses to settle a name by
 *      table order (gotcha 117).
 *   5. **A volume cannot confirm its own new claim.** A claim this volume established has not been seen
 *      *again* by anything; the earliest a confirmation is possible is the next volume. Without this the
 *      first volume of a series would confirm every claim it filed and the render would print
 *      "confirmed in volume 1" for a trait nobody re-saw.
 *   6. **This volume's own text has to contain the character.** Measured with the store's one name rule
 *      (`presence.js`'s search names and `evidence.js`'s verbatim-then-Han-skeleton match), the same rule
 *      the coverage audit and the chapter block use — reused, not copied, so the door and the audit cannot
 *      disagree about who is on the page. A confirmation of a character this book never prints is the model
 *      agreeing with the reference from memory.
 *   7. **If the entry offers a line, that line has to be in this volume.** `findQuoteEvidence`, the same
 *      half of the evidence rule both revision doors use. An entry that offers no line is filed with
 *      `quote = null` and the presence rule is the whole guard — and the row says so, because "the volume
 *      saw the character" and "the volume printed the line" are different strengths of observation.
 *   8. **Idempotent per (claim, volume).** The same claim named by three chapters of volume 5 is one
 *      observation, and re-running volume 5 files nothing new. `UNIQUE (fact_id, seen_volume)` is the rule;
 *      the door reports "already filed" rather than failing on it.
 *
 * ## What this door does NOT do
 *
 * It does not file a claim, a candidate, a cast entry, a `cast_alias`, or a challenge. It does not mark
 * anything. It does not read the identity tables (plan 06 §10.8, pinned by
 * `test/test-identity-table-isolation.js`). It does not narrow on `axis`: **0 of the 22,469 `facts` rows in
 * the 17 published records carries one** (plan 06 §2.11), so an axis-first ladder would answer "nothing to
 * confirm" for every record this corpus has. The ladder is the label the extraction named, then the aspect,
 * then — only when the record holds exactly one current claim about that character — that claim, and which
 * of the three resolved it is written into the row.
 *
 * @module utils/reference-store/confirmations/file
 */

const { EXTRACTION_SOURCE_STAGE } = require("../schema");
const { currentClaimSql } = require("../facts");
const { refusal } = require("../refusals");
const { resolveExtractionName } = require("../name-resolution");
const { prepareLineForQuoteSearch, matchPreparedLine } = require("../evidence");
const { rosterForChapterQuery, searchNamesForPerson } = require("../chapter-facts");
const { findQuoteEvidence } = require("../glossary-adapter/quote-evidence");
const { readChapterLines } = require("../source-chapters");
const { QUIRK_TYPE_TO_ASPECT, UNMAPPED_ASPECT } = require("../extraction-adapter");
const { QUIRK_TYPE_TO_VOICE_LABEL } = require("../rebuild/labels");

const { confirmationAlreadyFiled } = require("./rows");
const { CONFIRMATION_ENTRY_TYPE } = require("./shapes");
require("../../../types"); // JSDoc type definitions

/**
 * The claim a confirmation is allowed to point at, in the order the ladder tries them.
 *
 * @param {{db: Object}} store
 * @param {string} key - The roster entry, already resolved.
 * @param {number} volume - The volume doing the confirming: the span is judged as of this volume.
 * @returns {Array<Object>} Current, in-span, record-content claims about this character, oldest first.
 */
function claimsOpenToConfirmation(store, key, volume) {
  const vol = Number(volume);
  const current = currentClaimSql("f");
  return store.db
    .prepare(
      "SELECT f.id, f.key, f.aspect, f.label, f.body, f.axis, f.axis_value AS axisValue, " +
        "f.established_volume AS establishedVolume, f.owner_volume AS ownerVolume, " +
        "f.applies_from_volume AS appliesFromVolume, f.source_stage AS sourceStage " +
        `FROM facts f WHERE f.key = ? AND f.source_stage != ? AND f.aspect != 'term_usage' AND ${current} ` +
        "AND f.applies_from_volume <= ? AND (f.applies_to_volume IS NULL OR f.applies_to_volume >= ?) " +
        "ORDER BY f.established_volume, f.ord, f.id"
    )
    .all(String(key), EXTRACTION_SOURCE_STAGE, vol, vol);
}

/**
 * Which of this character's current claims the entry means, and how sure the door is about it.
 *
 * Three steps, in this order, and the step that decided it is returned so it can be written into the row:
 *
 *   1. **the label the extraction named** — `QUIRK_TYPE_TO_VOICE_LABEL`, the label the filing doors write
 *      onto the row. It separates the four quirk kinds that collapse onto the one `register` aspect
 *      (plan 06 §2.3), which is the reason the ladder starts here and not on the aspect.
 *   2. **the aspect that label maps to** — for a claim carried in from a document whose label the
 *      extraction did not use.
 *   3. **the only claim the record stands behind about this character** — when the record says exactly one
 *      thing about them, an "unchanged" note cannot mean anything else. Named as the reason, because it is
 *      the weakest of the three and a reader should be able to see that it fired.
 *
 * Zero candidates and more-than-one-candidate-both-still-possible are both refusals. The door never picks.
 *
 * @param {Array<Object>} candidates - {@link claimsOpenToConfirmation}'s rows.
 * @param {string} quirkType - The entry's own `quirkType`, possibly empty.
 * @returns {{claim: Object|null, how: string|null, ambiguous: Array<Object>}}
 */
function resolveConfirmedClaim(candidates, quirkType) {
  const quirk = String(quirkType || "").trim().toLowerCase();
  const label = QUIRK_TYPE_TO_VOICE_LABEL[quirk] || null;
  const aspect = QUIRK_TYPE_TO_ASPECT[quirk] || null;

  if (label) {
    const byLabel = candidates.filter((row) => String(row.label || "").trim() === label);
    if (byLabel.length === 1) return { claim: byLabel[0], how: `label:${label}`, ambiguous: [] };
    if (byLabel.length > 1) return { claim: null, how: null, ambiguous: byLabel };
  }
  if (aspect) {
    const byAspect = candidates.filter((row) => row.aspect === aspect);
    if (byAspect.length === 1) return { claim: byAspect[0], how: `aspect:${aspect}`, ambiguous: [] };
    if (byAspect.length > 1) return { claim: null, how: null, ambiguous: byAspect };
  }
  if (candidates.length === 1) return { claim: candidates[0], how: "only-current-claim", ambiguous: [] };
  return { claim: null, how: null, ambiguous: candidates };
}

/**
 * One roster entry's search names, prepared once for a whole volume.
 *
 * The store's own name rule, reached through the same helpers the chapter block uses
 * (`rosterForChapterQuery` + `searchNamesForPerson`), so this door and the coverage audit cannot disagree
 * about whether a character is in a book. Merged entries are included the way the coverage rule includes
 * them — a person whose name is printed in the folded spelling is still in the book.
 *
 * @param {{db: Object}} store
 * @param {string} key
 * @returns {Array<{name: string, prepared: Object}>} Empty when the roster does not hold this entry.
 */
function preparedNamesForEntry(store, key) {
  const cast = rosterForChapterQuery(store);
  const entry = cast.entries.find((row) => row.key === key);
  if (!entry) return [];
  return searchNamesForPerson(entry, cast.mergedBy.get(entry.key) || [], cast.mergedKeys);
}

/**
 * Whether this volume's own text contains this character, and through which of their names.
 *
 * @param {Array<{name: string, prepared: Object}>} names - {@link preparedNamesForEntry}'s rows.
 * @param {Array<Object>} preparedLines - The volume's chapter lines, prepared once per run.
 * @returns {{present: boolean, through: string|null, matches: number}}
 */
function characterInPreparedLines(names, preparedLines) {
  let total = 0;
  let through = null;
  for (const { name, prepared } of names) {
    let hits = 0;
    for (const line of preparedLines) {
      if (matchPreparedLine(line, prepared)) hits += 1;
    }
    if (!hits) continue;
    if (!through) through = name;
    total += hits;
  }
  return { present: total > 0, through, matches: total };
}

/**
 * One volume's chapter lines, prepared once so the presence rule is a scan rather than a re-read.
 *
 * @param {{db: Object, volumeDir: string}} store
 * @param {string} [volumeDir] - Defaults to the volume this handle is opened on.
 * @param {Array<{id: string, file: string}>} chapters
 * @returns {Array<Object>} Rows {@link prepareLineForQuoteSearch} produces. Empty when no chapter can be read.
 */
function prepareVolumeLines(store, volumeDir, chapters) {
  /** @type {Array<Object>} */
  const out = [];
  for (const chapter of Array.isArray(chapters) ? chapters : []) {
    if (!chapter || !chapter.file) continue;
    const lines = readChapterLines(volumeDir || store.volumeDir, chapter.file);
    if (!lines) continue;
    for (const line of lines) {
      const trimmed = String(line || "").trim();
      if (trimmed) out.push(prepareLineForQuoteSearch(trimmed));
    }
  }
  return out;
}

/**
 * File one confirmation: this volume re-saw a claim this record already stands behind.
 *
 * @param {ReferenceStore} store - A handle that is not the extraction stage's.
 * @param {Object} entry - The extraction's `type: "confirm"` record: `{character, quirkType?, examples?, chapter?}`.
 * @param {{volume?: number, volumeDir?: string, chapters?: Array<{id: string, file: string}>, preparedLines?: Array<Object>}} [opts]
 *   The volume doing the confirming, and this volume's own source: its chapter files (for the quote rule)
 *   and their lines, prepared once per run by {@link fileVoiceConfirmations}.
 * @returns {{ok: boolean, filed: Object|null, already: Object|null, claim: Object|null, how: string|null, quote: string|null, refusal: ReferenceRefusal|null}}
 */
function fileVoiceConfirmation(store, entry, { volume, volumeDir, chapters = [], preparedLines = null } = {}) {
  const vol = Number(volume === undefined ? store.volume : volume);
  const text = (value) => (typeof value === "string" ? value.trim() : "");

  /**
   * The one shape every outcome that is not a filed confirmation returns.
   * @param {string} rule
   * @param {string} because
   * @param {string[]} [useInstead]
   * @param {Object} [detail]
   */
  const refused = (rule, because, useInstead = [], detail = {}) => ({
    ok: false,
    filed: null,
    already: null,
    claim: null,
    how: null,
    quote: null,
    refusal: refusal({ verb: "confirm_voice_claim", rule, because, useInstead, fix: detail.fix || "", detail }),
  });

  // Guard 1 — the extraction handle files rows every renderer excludes.
  if (store.scope.stage === EXTRACTION_SOURCE_STAGE) {
    return refused(
      "voice-confirmation-needs-a-record-handle",
      `this handle writes as stage "${EXTRACTION_SOURCE_STAGE}". A confirmation is an act on the record, and ` +
        `a row filed under "${EXTRACTION_SOURCE_STAGE}" is excluded by every renderer, by the current-claim ` +
        "query and by the chapter block — so the confirmation would be filed where nothing can read it.",
      ['openReferenceStore({ volume, stage: "rebuild" }) — the handle the claims are filed through']
    );
  }
  // Guard 2 — the volume that saw it is the volume this handle is opened on.
  if (Number(store.volume) !== vol) {
    return refused(
      "voice-confirmation-volume-is-not-the-handles",
      `the confirmation names volume ${vol} but this handle is opened on volume ${store.volume}. A volume can ` +
        "only report what its own reading pass read.",
      ["open the record of the volume that did the reading"]
    );
  }

  const name = text(entry && entry.character);
  if (!name) {
    return refused(
      "voice-confirmation-names-nobody",
      "the confirmation names no character, so there is nothing in the record it could be about."
    );
  }

  // Guard 3 — the character has to be somebody this record already holds.
  const who = resolveExtractionName(store, name);
  if (!who.key) {
    return refused(
      "voice-confirmation-names-nobody-in-this-record",
      `"${name}" does not resolve to a roster entry this record holds (${who.how}${who.unattached ? ", unattached" : ""}), ` +
        "so there is no published claim for this volume to have seen again. A character the record does not " +
        "know is the claim door's job, not this one's.",
      ["file the claim first (insert_fact / rebuildVoiceFromExtraction)"],
      { name, how: who.how }
    );
  }

  // Guard 4 — the claim has to be one the record currently stands behind at this volume.
  const candidates = claimsOpenToConfirmation(store, who.key, vol);
  if (!candidates.length) {
    return refused(
      "voice-confirmation-has-no-claim-to-confirm",
      `this record holds no current claim about ${who.key} at volume ${vol}, so there is nothing for volume ${vol} ` +
        "to have confirmed. Either the claim was never filed, or this record has already replaced it.",
      ["file the claim through the claim door", "if the record replaced it, the replacement is the claim to confirm"],
      { key: who.key }
    );
  }
  const resolved = resolveConfirmedClaim(candidates, text(entry && entry.quirkType));
  if (!resolved.claim) {
    return refused(
      "voice-confirmation-is-ambiguous",
      `volume ${vol}'s confirmation of ${who.key} could mean ${resolved.ambiguous.length} of the claims this record ` +
        `stands behind about them (${resolved.ambiguous.map((row) => `${row.id} [${row.label || "unlabeled"}]`).join("; ")}), ` +
        "and nothing in the entry separates them. The door does not pick one by table order.",
      ["name the quirk type the entry is about"],
      { key: who.key, candidates: resolved.ambiguous.map((row) => row.id) }
    );
  }

  // Guard 5 — a volume cannot confirm its own new claim.
  if (Number(resolved.claim.establishedVolume) === vol) {
    return refused(
      "voice-confirmation-cannot-confirm-its-own-volume",
      `the claim this entry confirms (${resolved.claim.id}) was established in volume ${vol} itself. A confirmation ` +
        "means a claim was seen *again*, and the earliest a volume can see its own claim again is the next volume.",
      ["let a later volume confirm it"],
      { factId: resolved.claim.id, establishedVolume: resolved.claim.establishedVolume }
    );
  }

  // Guard 6 — this volume's own text has to contain the character.
  //
  // The batch door prepares the volume's lines once and hands them to every entry, because the same scan
  // repeated per entry is the only cost this guard has. Asked on its own, this door prepares them itself
  // rather than treating "no lines" as "the character is not in the book" — a door that refuses every
  // confirmation called without a pre-built list is a door that quietly works only from one call site.
  const lines = preparedLines || prepareVolumeLines(store, volumeDir, chapters);
  const seen = characterInPreparedLines(preparedNamesForEntry(store, who.key), lines);
  if (!seen.present) {
    return refused(
      "voice-confirmation-character-not-in-this-volume",
      `${who.key} does not appear in volume ${vol}'s own text, measured with the store's own name rule, so volume ${vol} ` +
        "has not seen this claim again — it has repeated what it was shown. The claim stays where it is and nothing is filed.",
      ["re-read the chapter that does contain the character"],
      { key: who.key, volume: vol }
    );
  }

  // Guard 7 — an offered line has to be a line this volume prints.
  const offered = (Array.isArray(entry && entry.examples) ? entry.examples : []).filter((s) => typeof s === "string" && s.trim());
  let quote = null;
  if (offered.length) {
    const hit = findQuoteEvidence(volumeDir || store.volumeDir, chapters, vol, offered[0]);
    if (!hit.evidence) {
      return refused(
        "voice-confirmation-quote-not-in-this-volume",
        `the line this confirmation quoted ("${offered[0].slice(0, 120)}") does not occur in volume ${vol}'s source text, ` +
          "so the observation is not backed by this volume's own book.",
        ["quote a line this volume actually prints", "or name no line and let the character's presence carry it"],
        { quote: offered[0] }
      );
    }
    quote = offered[0].trim();
  }

  // Guard 8 — one observation per (claim, volume).
  const already = confirmationAlreadyFiled(store, resolved.claim.id, vol);
  if (already) {
    return { ok: true, filed: null, already, claim: resolved.claim, how: resolved.how, quote, refusal: null };
  }

  const chapter = text(entry && entry.chapter) || null;
  const note =
    `confirmed by volume ${vol}${chapter ? ` in chapter ${chapter}` : ""}` +
    (quote ? ` — the volume printed the line it quotes` : " — the entry offered no line, so this volume's text containing the character is the whole evidence") +
    `; resolved by ${resolved.how}`;

  store.db
    .prepare("INSERT INTO claim_confirmations (fact_id, seen_volume, seen_chapter, quote, seen_by_stage, seen_at, note) VALUES (?,?,?,?,?,?,?)")
    .run(resolved.claim.id, vol, chapter, quote, store.scope.stage, new Date().toISOString(), note);

  return {
    ok: true,
    filed: {
      factId: resolved.claim.id,
      seenVolume: vol,
      seenChapter: chapter,
      quote,
      seenByStage: store.scope.stage,
      note,
    },
    already: null,
    claim: resolved.claim,
    how: resolved.how,
    quote,
    refusal: null,
  };
}

/**
 * File every confirmation one volume's extraction output carries, and report the rest of that output as
 * not-this-door's-business.
 *
 * The volume's chapter lines are prepared **once** here and handed to every entry, because the presence
 * rule is the same scan repeated per entry and a volume's text does not change between them.
 *
 * @param {ReferenceStore} store - A handle that is not the extraction stage's.
 * @param {Array<Object>} entries - The parsed notebook, mixed kinds.
 * @param {{volume?: number, volumeDir?: string, chapters?: Array<{id: string, file: string}>}} opts
 * @returns {{ok: boolean, filed: Array<Object>, alreadyFiled: Array<Object>, refused: Array<Object>, confirmations: number, nonConfirmations: number}}
 */
function fileVoiceConfirmations(store, entries, { volume, volumeDir, chapters = [] } = {}) {
  const vol = Number(volume === undefined ? store.volume : volume);
  const list = Array.isArray(entries) ? entries : [];
  const confirmations = list.filter((entry) => entry && typeof entry === "object" && String(entry.type || "").trim() === CONFIRMATION_ENTRY_TYPE);

  /** @type {Array<Object>} */
  const preparedLines = prepareVolumeLines(store, volumeDir, chapters);

  /** @type {Array<Object>} */
  const filed = [];
  /** @type {Array<Object>} */
  const alreadyFiled = [];
  /** @type {Array<Object>} */
  const refused = [];
  for (const entry of confirmations) {
    const result = fileVoiceConfirmation(store, entry, { volume: vol, volumeDir, chapters, preparedLines });
    if (result.filed) filed.push(result.filed);
    else if (result.already) alreadyFiled.push({ factId: result.claim ? result.claim.id : result.already.fact_id, chapter: entry.chapter || null });
    else if (result.refusal) refused.push({ kind: "confirm", character: entry.character || null, rule: result.refusal.rule, because: result.refusal.because });
  }
  return {
    ok: true,
    filed,
    alreadyFiled,
    refused,
    confirmations: confirmations.length,
    nonConfirmations: list.length - confirmations.length,
  };
}

module.exports = {
  CONFIRMATION_ENTRY_TYPE,
  claimsOpenToConfirmation,
  resolveConfirmedClaim,
  preparedNamesForEntry,
  prepareVolumeLines,
  characterInPreparedLines,
  fileVoiceConfirmation,
  fileVoiceConfirmations,
};
