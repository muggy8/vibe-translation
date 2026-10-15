/**
 * utils/reference-store/voice-revision/file.js — the door a later volume uses to replace a voice claim
 * this record already published.
 *
 * Plan 06 slice 6. It is the voice side of `glossary-adapter/revision.js`, and it is the **only** way
 * onto a published voice claim, because there is no other one: `update_own_fact` refuses a row this
 * handle does not own, `challenge_fact` marks a row `disputed` (the right mark for a claim somebody
 * disagrees with and the wrong mark for a claim a later volume replaced), and `resolve_challenge` only
 * supersedes as the closing half of a dispute that was opened as a challenge. `markSuperseded` is the
 * narrow door onto a published row, and it refuses unless the replacement row it is attributed to
 * already exists — so this file's job is to file that row and to make the mark mean something.
 *
 * ## What a voice revision is keyed on, and why it is not keyed on the claim's words
 *
 * **(roster entry, declared register axis).** A character's *answer to a question the series declared*
 * is the thing that changes when the character changes. `(key, aspect, body)` is the store's **dedupe**
 * identity — the one `rebuildClaimAlreadyStored` uses to decide "this volume already filed this claim" —
 * and it cannot be the identity of a replacement, because rewording the body is the whole content of a
 * revision. `aspect` is not the key either: plan 06 §2.3 measured four of the seven quirk kinds landing
 * on the one `register` aspect, so a claim about *how formal* and a claim about *which words* share an
 * aspect and are only separable by the axis each one names.
 *
 * That has a consequence the door states out loud rather than hiding: **a series whose plan of record
 * declares no register question has no door onto its voice claims.** It is not a fallback, there is no
 * axis list behind it in this file or anywhere else (plan 06 §4), and the refusal names the door that
 * opens it — the intake. Plan 06 §10.10 already records that the real corpus is in exactly that state,
 * which is why every measurement in this slice runs on fixtures.
 *
 * ## The guards, in the order they run
 *
 *   1. **The handle may not be the extraction's.** A row filed under `extract` is excluded by every
 *      renderer, by `currentClaimSql`, by the chapter block and by the axis queries. A revision filed
 *      through that handle would write a row nothing can see and report success.
 *   2. **The handle's volume is the volume filing.** `insertFact` stamps ownership from the scope the
 *      handle was opened with, and `markSuperseded` attributes the act to the volume and stage of the row
 *      that replaces. Passing a `volume` that is not the handle's own would make the two disagree, so it is
 *      refused rather than reconciled.
 *   3. **The entry has to name a character, a question and a claim.**
 *   3b. **A series that declared no register question is refused, and told which door opens it.** Asked
 *      before the record is read, because the read would answer "no claim answers that question" — true,
 *      and the wrong reason: no claim answers it because the series never asked one.
 *   3c. **The register gate runs before the record is read.** Which question and which answer this series
 *      allows is a fact about the series, not about this claim, so a claim answering a question the series
 *      never asked is told that rather than being told the record has nothing. Same gate every other filing
 *      door goes through, reading the declaration frozen onto the handle in `open.js`.
 *   4. **The claim being replaced has to be the one in force at this volume** — the row no in-range row
 *      supersedes (`./rows.js`). Two live answers to one question that are linked to nothing is a
 *      refusal, not a pick by `ord`: the same reason `resolveExtractionName` refuses to settle a name by
 *      table order (gotcha 117).
 *   5. **The new claim is screened before anything is compared**, the same `screenClaim` the rebuild door
 *      runs, so a revision whose prose is still being written never becomes a published bullet.
 *   6. **Idempotent per volume, asked of the whole chain.** Re-running one volume over the same proposals
 *      files one revision. The glossary door learned this the hard way (its step 4): a rendering this
 *      volume filed and a later chapter of the same volume replaced is still a decision this volume made,
 *      and re-filing it flips the character back to the superseded answer and grows the record on every
 *      re-run.
 *   7. **A revision that restates the claim in force is refused.** Same words, same character, same
 *      question: that is a *confirmation*, and a confirmation is slice 7's job, not a replacement. It
 *      would add a row, mark the old one superseded, and render the identical bullet.
 *   8. **The quote has to be a line this volume's own text prints.** `findQuoteEvidence` — the revision
 *      door's half of the evidence rule, shared with the glossary's rather than duplicated. This is the
 *      load-bearing guard: it is the only thing between "a later volume found evidence in its own book"
 *      and "a later volume changed a character because it felt like it". Refused, not filed with a
 *      warning.
 *   9. **Both writes in one transaction.** A replacement row whose predecessor is still `active` is a
 *      character with two live answers to one question; a `superseded` mark with no replacement row behind
 *      it is an unattributed edit to a published row. Either half alone is a broken record.
 *
 * ## What the door does NOT do
 *
 * It does not write `applies_to_volume` on the row it replaces, and that is a decision, not an omission.
 * `markSuperseded` changes `status` (and `updated_at`) and nothing else, and `currentClaimSql` already
 * means "no live row supersedes this one" — so retirement from every *current* answer is a property of
 * the link, not a span the door has to maintain. Writing a span onto a published row would be editing a
 * published row, which is the thing this door exists to avoid.
 *
 * It files no `cast` entry and no `cast_alias`: who a claim belongs to is decided by the roster rules
 * (`name-resolution.js`, `castAlias`), and a revision is not a place to change it (gotcha 121). It keeps
 * the replaced row's `aspect`, `label` and `section`, so a revision cannot smuggle a claim into a
 * different kind of claim. It leaves the coverage rule alone: `integrity/coverage.js` asks whether the
 * record says anything about a character, and a superseded row still says something.
 *
 * @module utils/reference-store/voice-revision/file
 */

const { normalizeQuote } = require("../evidence");
const { EXTRACTION_SOURCE_STAGE } = require("../schema");
const { markSuperseded } = require("../facts");
const { refusal } = require("../refusals");
const { screenClaim } = require("../drafting");
const { findQuoteEvidence } = require("../glossary-adapter/quote-evidence");
const { registerFilingRefusal } = require("../register/filing");
const { voiceClaimInForceForAxis, voiceRevisionAlreadyFiled } = require("./rows");
require("../../../types"); // JSDoc type definitions

/**
 * How many quoted spans one revision prints in its bullet.
 *
 * One, on purpose. A revision's example is the line this volume read, which is also the evidence the row
 * was accepted on — the bullet is self-citing the way every other rebuilt bullet is. A voice *claim* may
 * carry a list of quoted forms (that is what a vocabulary or an ending-pattern entry is), but a revision
 * is one answer replacing one answer, and a list here would be a new claim wearing a replacement.
 */
const REVISION_EXAMPLES_PER_ROW = 1;

/**
 * File one voice revision: this volume's replacement of a voice claim this record already published.
 *
 * @param {ReferenceStore} store - Opened with a handle that is NOT the extraction stage's: the row has to
 *   be one the renderers and the current-claim queries can see.
 * @param {Object} entry - `{key, axis, axisValue, body, quote, reason?}` — the roster entry as the record
 *   spells it, the declared question being answered, the new answer, the new claim, and a line this
 *   volume's own text prints.
 * @param {{volume?: number}} [opts]
 * @returns {{ok: boolean, filed: Object|null, replaced: Object|null, alreadyFiled: boolean, evidence: Array<Object>|null, refusal: ReferenceRefusal|null}}
 */
function fileVoiceRevision(store, entry, { volume } = {}) {
  const vol = Number(volume === undefined ? store.volume : volume);
  const text = (value) => (typeof value === "string" ? value.trim() : "");
  const key = text(entry && entry.key);
  const axis = text(entry && entry.axis);
  const axisValue = text(entry && (entry.axisValue === undefined ? entry.value : entry.axisValue));
  const body = text(entry && entry.body);
  const quote = text(entry && entry.quote);

  const refuse = (rule, because, fix) => ({
    ok: false,
    filed: null,
    replaced: null,
    alreadyFiled: false,
    evidence: null,
    refusal: refusal({ verb: "file_voice_revision", rule, because, fix }),
  });

  // 1 — the handle. A row filed under the extraction stage is invisible to every reader of this record.
  if (store.scope.stage === EXTRACTION_SOURCE_STAGE) {
    return refuse(
      "voice-revision-needs-a-document-scope",
      `this handle writes as stage "${store.scope.stage}". Every renderer, \`currentClaimSql\`, the chapter ` +
        "block and the axis queries exclude the extraction's own rows — they are the candidate copies, not " +
        "the record's answer. A revision filed through this handle would write a row nothing can read and " +
        "report that it succeeded.",
      "open the volume's record with the stage that publishes it (rebuild, import, merge, repair or verify)."
    );
  }

  // 2 — ownership is the handle's, so the volume being filed for has to be the handle's own.
  if (Number(store.scope.volume) !== vol) {
    return refuse(
      "voice-revision-not-this-volumes-turn",
      `the revision is asked for volume ${vol} but this handle writes as volume ${store.scope.volume}. ` +
        "`insertFact` stamps ownership from the handle and `markSuperseded` attributes the act to the " +
        "volume and stage of the row that replaces, so the two would disagree about who made this decision.",
      `open volume ${vol}'s record and file the revision through that handle.`
    );
  }

  // 3 — the entry.
  if (!key) {
    return refuse(
      "voice-revision-has-no-character",
      "a voice revision arrived with no character, so there is no claim it replaces. A revision names the " +
        "roster entry exactly as this record spells it.",
      "name the character under the key this volume's record already holds."
    );
  }
  if (!axis) {
    return refuse(
      "voice-revision-has-no-axis",
      `"${key}": a voice revision names the question it answers, and this one names none. The door is keyed ` +
        "on (character, declared register question) because that is the pair that changes when a character " +
        "changes — the claim's own words are the dedupe identity, and rewording them is the whole content " +
        "of a revision. There is no question list in the pipeline to fall back on, in any language.",
      "name the axis this series declares (translation-target.json), or run the intake so it declares one."
    );
  }
  if (!body) {
    return refuse(
      "voice-revision-has-no-claim",
      `"${key}" / "${axis}": a revision with no claim is a complaint, not a replacement. The reference's ` +
        "bullet is the answer a translator writes to, and this is the only door on this route that can supply a new one.",
      "the revision owes a `body`: the claim this volume's text supports."
    );
  }

  // 3b — a series that declared no question has no door onto its voice claims, and it is told so.
  // Asked here rather than left to the lookup below, because the lookup would answer "there is no claim
  // answering that question" — true, and the wrong reason: there is no claim answering it because the
  // series never asked one, and the fix is the intake, not the claim.
  const declarationState = store.registerDeclaration && store.registerDeclaration.state
    ? store.registerDeclaration.state
    : "absent";
  if (declarationState !== "declared" || !(store.registerDeclaration.axes || []).length) {
    return refuse(
      "voice-revision-needs-a-register-declaration",
      `this series declares no register question (${declarationState}${store.registerDeclaration && store.registerDeclaration.file ? ` in ${store.registerDeclaration.file}` : ""}), so nothing in its ` +
        "record answers one, and there is nothing for a revision to replace. The door is keyed on the " +
        "question the series asked because that is the pair a character's development changes; there is no " +
        "question list in the pipeline to fall back on, in any language.",
      "run the intake (npx gulp discover) so the series declares its own questions from the book."
    );
  }

  // 3c — the register gate, before the record is read: which question and which answer this series allows
  // is a fact about the series, not about this claim, and a claim answering a question the series never
  // asked should be told that rather than told "no claim answers that question" — which is true, and the
  // wrong reason. It is the same gate (`register/filing.js`) every other filing door goes through, reading
  // the declaration frozen onto the handle in `open.js`.
  const gate = registerFilingRefusal(store, { axis, axisValue }, "file_voice_revision");
  if (gate) return refuse(gate.rule, gate.because, gate.fix);

  // 4 — which claim is being replaced.
  const lookup = voiceClaimInForceForAxis(store, { key, axis, volume: vol });
  if (lookup.ambiguous) {
    return refuse(
      "voice-revision-claim-ambiguous",
      `"${key}" answers "${axis}" ${lookup.candidates.length} different ways in this record, and none of ` +
        `them supersedes another:\n${lookup.candidates.map((row) => `  - row ${row.id} (volume ${row.ownerVolume}): ${String(row.body).slice(0, 120)}`).join("\n")}\n` +
        "A door that replaced one of them would be choosing by filing order, which is not a reason. The " +
        "record holds two live answers to one question and has to say which one it stands behind before a " +
        "later volume can replace it.",
      "resolve which answer this record stands behind, then revise that one."
    );
  }
  const current = lookup.inForce;
  if (!current) {
    return refuse(
      "voice-revision-of-unknown-claim",
      `"${key}" has no claim answering "${axis}" in this record as of volume ${vol}, so there is nothing ` +
        "for this revision to replace. A claim this volume found belongs in the extraction, which files it " +
        "with its own evidence; a revision is only ever the replacement of a claim the record already published.",
      `file it as a new claim, or name the axis this record already answers for "${key}".`
    );
  }

  // 5 — screen the new claim before anything is compared, so the body compared below is the body filed.
  const screen = screenClaim({ body, examples: quote ? [quote] : [] });
  if (!screen.ok) {
    return refuse(
      "voice-revision-claim-carries-unfinished-prose",
      `"${key}" / "${axis}": the replacement's own prose is not finished writing — ${screen.because}. ` +
        "A revision is published as a bullet a translator writes to; the writer's working notes are not one.",
      "write the claim out as the assertion you mean, and quote the line you read."
    );
  }

  // 6 — idempotence, asked of the whole chain rather than only the row in force.
  const settled = voiceRevisionAlreadyFiled(lookup.rows, vol, screen.body);
  if (settled) {
    return { ok: true, filed: settled, replaced: null, alreadyFiled: true, evidence: null, refusal: null };
  }

  // 7 — a revision that restates the answer in force is a confirmation, not a development.
  if (normalizeQuote(screen.body) === normalizeQuote(current.body)) {
    return refuse(
      "voice-revision-restates-the-current-claim",
      `"${key}" / "${axis}": the replacement says the same thing as the claim already in force ` +
        `(row ${current.id}, in force from volume ${current.appliesFromVolume}). Filing it would add a ` +
        "row, mark the published one superseded, and render the identical bullet — a record that grew " +
        "without learning anything. Confirming that an answer still holds is a different act from " +
        "replacing it, and this door is only the second one.",
      "file nothing (the answer already stands), or bring the claim this volume's text actually shows to be different."
    );
  }

  // 8 — the quote has to be in THIS volume's book.
  const listed = store.listChapters();
  const found = findQuoteEvidence(store.volumeDir, listed.chapters, vol, quote);
  if (!found.evidence) {
    return refuse(
      "voice-revision-quote-not-in-source",
      `"${key}" / "${axis}": the revision quotes ${quote ? `"${quote}"` : "nothing"}, and no line of volume ` +
        `${vol}'s source text contains it. A later volume may replace an earlier volume's claim when its ` +
        "own book shows the earlier one no longer holds; it may not replace one on the strength of the " +
        "previous reference's own bullet.",
      "quote the line you actually read in this volume, character for character."
    );
  }

  // 9 — both writes, or neither.
  let inserted = null;
  store.db.exec("BEGIN");
  try {
    inserted = store.insertFact({
      // The replaced row's kind travels with the replacement: a revision answers the same question about
      // the same character, and a door that could change the aspect could file a different claim.
      key: current.key,
      aspect: current.aspect,
      label: current.label,
      section: current.section,
      body: screen.body,
      examples: screen.examples.slice(0, REVISION_EXAMPLES_PER_ROW),
      axis: current.axis,
      axisValue,
      // `formality` is the legacy column plan 06 §2.3 measured. A revision does not restate it: the
      // axis/value pair is the answer now, and copying the old value would assert an answer the whole
      // point of this call is to replace.
      evidence: found.evidence,
      establishedVolume: vol,
      appliesFromVolume: vol,
      supersedes: current.id,
    });
    if (!inserted.ok) {
      store.db.exec("ROLLBACK");
      return refuse(
        inserted.refusal ? inserted.refusal.rule : "insert refused",
        inserted.refusal ? inserted.refusal.because : `the replacement claim for "${key}" could not be filed.`,
        "the record's own insert contract is the fix."
      );
    }
    const marked = markSuperseded(store, current.id, { byVolume: vol, byStage: store.scope.stage });
    if (!marked.ok) {
      store.db.exec("ROLLBACK");
      return refuse(marked.refusal.rule, marked.refusal.because, marked.refusal.fix);
    }
    store.db.exec("COMMIT");
  } catch (err) {
    store.db.exec("ROLLBACK");
    throw err;
  }

  return {
    ok: true,
    filed: inserted.fact,
    replaced: {
      id: current.id,
      key: current.key,
      aspect: current.aspect,
      label: current.label,
      axis: current.axis,
      axisValue: current.axisValue === null || current.axisValue === undefined ? null : String(current.axisValue),
      body: current.body,
      appliesFromVolume: Number(current.appliesFromVolume),
      establishedVolume: Number(current.establishedVolume),
      ownerVolume: Number(current.ownerVolume),
    },
    alreadyFiled: false,
    evidence: found.evidence,
    refusal: null,
  };
}

/**
 * File this volume's voice revisions into its record, and report every one — filed and refused.
 *
 * The batch half of {@link fileVoiceRevision}, and the shape the glossary's `importGlossaryRevisions`
 * uses. It never throws on a refusal: a pass that proposed three revisions and had one refused has still
 * made two correct decisions, and a door that threw would throw all three away and leave the volume with
 * none. What it hands back instead is the refusals with the rule that produced each one, because the
 * report the acceptance grader reads is where a refusal has to appear.
 *
 * @param {ReferenceStore} store
 * @param {Array<Object>} entries - `{key, axis, axisValue, body, quote, reason?}` elements.
 * @param {{volume?: number}} [opts]
 * @returns {{ok: boolean, filed: Array<Object>, replaced: Array<Object>, alreadyFiled: Array<string>, refused: Array<{key: string, axis: string, axisValue: string, body: string, quote: string, rule: string, because: string}>}}
 */
function importVoiceRevisions(store, entries, { volume } = {}) {
  const vol = Number(volume === undefined ? store.volume : volume);
  const text = (value) => (typeof value === "string" ? value.trim() : "");

  /** @type {Array<Object>} */
  const filed = [];
  /** @type {Array<Object>} */
  const replaced = [];
  /** @type {Array<string>} */
  const alreadyFiled = [];
  /** @type {Array<Object>} */
  const refused = [];

  for (const entry of Array.isArray(entries) ? entries : []) {
    const result = fileVoiceRevision(store, entry, { volume: vol });
    if (result.ok) {
      if (result.alreadyFiled) {
        alreadyFiled.push(`${text(entry && entry.key)} / ${text(entry && entry.axis)}`);
        continue;
      }
      filed.push(result.filed);
      replaced.push(result.replaced);
      continue;
    }
    refused.push({
      key: text(entry && entry.key),
      axis: text(entry && entry.axis),
      axisValue: text(entry && (entry.axisValue === undefined ? entry.value : entry.axisValue)),
      body: text(entry && entry.body),
      quote: text(entry && entry.quote),
      rule: result.refusal.rule,
      because: result.refusal.because,
    });
  }

  return { ok: refused.length === 0, filed, replaced, alreadyFiled, refused };
}

module.exports = {
  REVISION_EXAMPLES_PER_ROW,
  fileVoiceRevision,
  importVoiceRevisions,
};
