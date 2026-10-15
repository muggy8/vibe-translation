/**
 * utils/reference-store/rebuild/filing.js — adopt the extraction's claims as rebuild rows, and file
 * each one's extraction candidate beside it.
 *
 * The one place a claim becomes renderable: it goes through the same evidence rule every other row
 * goes through, and what the rebuild adds on top of filing is the adoption decision itself, stamped
 * `source_stage = "rebuild"`. The candidate copy is filed through a **second handle** on the same
 * record, opened as the extraction stage, because a row's kind comes from the scope its handle was
 * opened with — the two handles are never merged and neither may write the other's kind of row.
 *
 * `rebuildVoiceFromExtraction` is kept whole, with its six local helpers inside it. `filePov` and
 * `fileVoice` close over the run's counters (`povAttached`, `povUnattached`) and its result arrays;
 * lifting them out would mean rewriting those increments and every call site that feeds them, which
 * is a rewrite of the filing order this file exists to preserve, not a move. The four helpers that
 * could be lifted (`resolveName`, `registerName`, `candidateMissing`, `fileCandidate`) are called from
 * the two that cannot, so moving them would edit the blocks being kept anyway. A long function in a
 * file that does one job is the better outcome here than a smaller function nobody can trust.
 *
 * @module utils/reference-store/rebuild/filing
 */

const { REBUILD_SOURCE_STAGE, EXTRACTION_SOURCE_STAGE } = require("../schema");
const { resolveExtractionName } = require("../name-resolution");
const { screenClaim } = require("../drafting");
const {
  findEntryEvidence,
  QUIRK_TYPE_TO_ASPECT,
  UNMAPPED_ASPECT,
  extractionClaimAlreadyStored,
  voiceCandidateRow,
  povCandidateRow,
} = require("../extraction-adapter");
const {
  DOCUMENT_VOICE,
  markDocumentMirrored,
  markDocumentRebuilt,
} = require("../document-prose");
const { refusal } = require("../refusals");
const { registerFilingRefusal } = require("../register/filing");
// The confirmation door, and the entry kind it is keyed on. `confirmations/shapes.js` is a pure leaf, so
// this does not close a cycle with `../extraction-adapter`, which needs the same constant.
const { fileVoiceConfirmations } = require("../confirmations/file");
const { CONFIRMATION_ENTRY_TYPE } = require("../confirmations/shapes");

const { rebuildClaimAlreadyStored, inspectVoiceMirrorForRebuild } = require("./mirror");
const {
  QUIRK_TYPE_TO_VOICE_LABEL,
  POV_VOICE_LABEL,
  UNLABELED_VOICE_LABEL,
  REBUILT_EXAMPLES_PER_BULLET,
} = require("./labels");
require("../../../types"); // JSDoc type definitions

/**
 * File this volume's extraction claims as renderable rebuild rows — and, when a candidate handle is
 * given, file each one's candidate copy beside it.
 *
 * Every claim goes through `findEntryEvidence` — the same search an extraction claim and a document
 * row go through — so the only thing this step adds on top of filing is the adoption decision. A
 * claim whose quotes are nowhere in this volume's text is refused and named, exactly as it is when
 * the extraction stage files it.
 *
 * **Why the candidate copy is filed here.** A rebuilt record used to hold only the adopted rows, which
 * meant the record had one reading of the book and no second one: the coverage rule's "did this
 * volume's extraction find voice material for them?" question could never be answered about a rebuilt
 * reference, because the rebuild had consumed the extraction into the document. Filing the candidate
 * beside the adopted row keeps both readings in the record, so the disagreement between them stays a
 * query. It is not a copy of the document — it is the extraction's own row, built by the extraction
 * door's own shape function (`voiceCandidateRow` / `povCandidateRow`), so the two doors cannot drift
 * into two shapes of the same claim.
 *
 * **What is not filed as a candidate.** A claim the evidence rule refused. It never became a candidate
 * through either door, and it is not hidden: it is named per character in the audit's refused list.
 *
 * @param {ReferenceStore} store - Opened with `stage: REBUILD_SOURCE_STAGE`.
 * @param {Array<Object>} entries - The parsed `character-voice-new.json` array.
 * @param {{volume?: number, mirrorRowsRemoved?: number, candidateStore?: ReferenceStore|null}} [opts]
 *   - `mirrorRowsRemoved` is what the caller cleared with `resetDocumentMirror` before this ran; it goes
 *   into the rebuild marker so the record says what the rebuild replaced. `candidateStore` is a handle
 *   on the **same volume's record opened with the extract stage**: the write scope is what decides
 *   which kind of row a handle may write, so the rebuild's own handle cannot file candidates and does
 *   not try to.
 * @returns {{ok: boolean, filed: Array<Object>, filedCount: number, carried: Array<Object>, refused: Array<Object>, characters: number, adoptedClaims: number, adoptedCharacters: number, adoptedUnkeyed: number, candidateClaims: number, povAttached: number, povUnattached: number, resolved: Array<{name: string, key: string, how: string}>, unresolved: Array<{name: string, key: string}>, candidates: {filed: number, carried: number, refused: Array<Object>}, confirmations: {filed: Array<Object>, alreadyFiled: Array<Object>, refused: Array<Object>, confirmations: number, nonConfirmations: number}, screened: Array<Object>, refusal: ReferenceRefusal|null}}
 */
function rebuildVoiceFromExtraction(store, entries, { volume, mirrorRowsRemoved = 0, candidateStore = null } = {}) {
  const vol = Number(volume === undefined ? store.volume : volume);

  /** @type {{filed: number, carried: number, refused: Array<Object>}} What the candidate copies did. */
  const candidates = { filed: 0, carried: 0, refused: [] };

  /**
   * The candidate handle has to be a handle, not an intention.
   *
   * A row's `source_stage` comes from the scope the handle was opened with, never from the caller, so
   * a rebuild cannot file a candidate through its own handle — and it should not be able to. Asking
   * for candidates through a handle scoped to something else is a wiring mistake, and the honest answer
   * is a refusal that names the door, not a silent "no candidates then".
   */
  if (candidateStore && (candidateStore.scope.stage !== EXTRACTION_SOURCE_STAGE || candidateStore.volume !== vol)) {
    return {
      ok: false,
      filed: [],
      filedCount: 0,
      carried: [],
      refused: [],
      characters: 0,
      povAttached: 0,
      povUnattached: 0,
      resolved: [],
      unresolved: [],
      candidates,
      refusal: refusal({
        verb: "rebuild_voice",
        rule: "rebuild-candidates-need-the-extraction-scope",
        because:
          `the candidate handle is writing as stage "${candidateStore.scope.stage}" on volume ${candidateStore.volume}, ` +
          `not "${EXTRACTION_SOURCE_STAGE}" on volume ${vol}. A candidate is the extraction's own row, and only a handle ` +
          "opened as the extraction stage may write one.",
        useInstead: ["openReferenceStore({ volume, stage: 'extract' }) for the candidate handle"],
        fix: "open a second handle on the same volume's record with the extract stage and pass that.",
      }),
    };
  }

  if (store.scope.stage !== REBUILD_SOURCE_STAGE) {
    return {
      ok: false,
      filed: [],
      filedCount: 0,
      carried: [],
      refused: [],
      characters: 0,
      povAttached: 0,
      povUnattached: 0,
      resolved: [],
      unresolved: [],
      candidates,
      refusal: refusal({
        verb: "rebuild_voice",
        rule: "rebuild-needs-its-own-write-scope",
        because: `this handle writes as stage "${store.scope.stage}", not "${REBUILD_SOURCE_STAGE}". Rows adopted by a rebuild have to be distinguishable from rows the extractor filed and from rows mirrored from a document.`,
        useInstead: ["openReferenceStore({ volume, stage: 'rebuild' })"],
        fix: "open the volume's record with the rebuild stage; the write scope is frozen when a handle opens.",
      }),
    };
  }

  const mirror = inspectVoiceMirrorForRebuild(store, vol);
  if (!mirror.ok) {
    return {
      ok: false,
      filed: [],
      filedCount: 0,
      carried: [],
      refused: [],
      characters: 0,
      povAttached: 0,
      povUnattached: 0,
      resolved: [],
      unresolved: [],
      candidates,
      refusal: mirror.refusal,
    };
  }

  const listed = store.listChapters();
  const chapters = listed.chapters;
  if (chapters.length === 0) {
    return {
      ok: false,
      filed: [],
      filedCount: 0,
      carried: [],
      refused: [],
      characters: 0,
      povAttached: 0,
      povUnattached: 0,
      resolved: [],
      unresolved: [],
      candidates,
      refusal: refusal({
        verb: "rebuild_voice",
        rule: "rebuild-source-missing",
        because: `volume ${vol} has no extracted chapters, so nothing here can be checked against the book and nothing can be ordered by chapter.`,
        useInstead: ["extract the volume first (the same chapter files the evidence rule reads)"],
        fix: "run the extraction stage, or point the rebuild at a folder that already holds its extracted source.",
      }),
    };
  }

  /** @type {Array<Object>} */
  const filed = [];
  /** @type {Array<Object>} */
  const carried = [];
  /** @type {Array<Object>} */
  const refused = [];
  /**
   * Claims that were filed, but not with everything the extraction handed over: an example whose text
   * has the writer's note glued to it is a citation that is not a citation, so it is dropped and named
   * here rather than published.
   *
   * @type {Array<{kind: string, character: string|null, dropped: Array<{example: string, because: string}>}>}
   */
  const screened = [];
  /** @type {Map<string, {key: string|null, display: string, resolved: boolean, how: string, unattached: boolean, ambiguous: boolean, registered?: boolean}>} */
  const nameMap = new Map();
  let povAttached = 0;
  let povUnattached = 0;

  /**
   * Resolve one extraction name to a roster entry, without creating anything.
   *
   * @param {string} name
   * @returns {{key: string|null, display: string, resolved: boolean, how: string, unattached: boolean, ambiguous: boolean, registered?: boolean}}
   */
  const resolveName = (name) => {
    const known = nameMap.get(name);
    if (known) return known;
    const resolved = resolveExtractionName(store, name);
    nameMap.set(name, resolved);
    return resolved;
  };

  /**
   * Create the roster entry a claim needs — but only for a claim that is actually being filed.
   *
   * The order matters. Registering first would let a claim the evidence rule refuses leave a
   * character in the roster, and the coverage check would then demand a voice entry for somebody
   * this volume's text never printed.
   *
   * A name that resolved to **nobody** registers nothing and is not a failure: `key: null` is the resolver
   * refusing to make a roster entry out of the word for "I", and the claim goes on to be filed unattached
   * with the name it was written under. Reporting it as a failed registration would read as though the
   * claim had been refused, when what happened is that the store declined to invent somebody for it.
   *
   * @param {string} name
   * @returns {{key: string|null, display: string, resolved: boolean, how: string, registered: boolean}}
   */
  const registerName = (name) => {
    const resolved = resolveName(name);
    if (resolved.registered === undefined) {
      if (resolved.key === null) {
        resolved.registered = true;
      } else {
        const upsert = store.upsertCast({ key: resolved.key, display: resolved.display, firstSeenVolume: vol });
        resolved.registered = upsert.ok;
        if (!upsert.ok) refused.push({ kind: "voice", character: name, because: upsert.refusal.because });
      }
    }
    return resolved;
  };

  /**
   * Whether the candidate copy of a claim still has to be filed.
   *
   * Two things have to be true before a claim can be skipped as already done: the adopted row is in
   * the record, and so is its candidate. A record built before candidates existed has the first and not
   * the second, and re-running the rebuild is what fills that in.
   *
   * @param {{key: string|null, aspect: string, body: string}} row
   * @returns {boolean}
   */
  const candidateMissing = (row) =>
    !!candidateStore && !extractionClaimAlreadyStored(candidateStore, { key: row.key, aspect: row.aspect, body: row.body });

  /**
   * File the candidate copy of a claim that has just passed the evidence rule.
   *
   * The row is built by the extraction door's own shape function, not by this module's rendering
   * fields: a candidate is what the extractor filed, and if the rebuild wrote it with the artifact's
   * labels the extraction door would not recognise its own row on a second pass and the record would
   * hold the same claim twice.
   *
   * A candidate that cannot be filed never cancels the adopted row. The rebuild's own output is the
   * thing the volume publishes; the candidate is the second reading kept beside it, and a failure to
   * keep it is reported rather than allowed to stop the rebuild.
   *
   * @param {{key: string|null, aspect: string, label: string, section: null, body: string, examples: string[], formality: string|null}} row
   * @param {Array<Object>} evidence - The citation the adopted row was accepted on.
   * @returns {void}
   */
  const fileCandidate = (row, evidence) => {
    if (!candidateStore) return;
    if (!candidateMissing(row)) {
      candidates.carried += 1;
      return;
    }
    const result = candidateStore.insertFact({ ...row, evidence, establishedVolume: vol, appliesFromVolume: vol });
    if (!result.ok) {
      candidates.refused.push({ key: row.key, aspect: row.aspect, label: row.label, because: result.refusal.because });
      return;
    }
    candidates.filed += 1;
  };

  /**
   * File one POV entry.
   *
   * @param {Object} entry - The extraction's POV record.
   * @returns {void}
   */
  const filePov = (entry) => {
    const assigned = typeof entry.assignedCharacter === "string" ? entry.assignedCharacter.trim() : "";
    const aspectKey = assigned ? resolveName(assigned).key : null;

    const candidate = povCandidateRow(entry, aspectKey);
    if (!candidate) {
      refused.push({ kind: "pov", because: "the POV entry carries no description and no marker." });
      return;
    }
    // The extraction's own name for the eyes this section is seen through, kept whenever the store filed
    // the claim under somebody else or under nobody at all.
    candidate.extractedAs = assigned && (!aspectKey || aspectKey !== assigned) ? assigned : null;
    const body = candidate.body;
    const screen = screenClaim({
      body,
      examples: (Array.isArray(entry.examples) ? entry.examples : []).filter((s) => typeof s === "string"),
    });

    const adoptedAlready = rebuildClaimAlreadyStored(store, { key: aspectKey, aspect: "pov", body: screen.body });
    if (adoptedAlready && !candidateMissing(candidate)) {
      carried.push({ kind: "pov", character: aspectKey });
      return;
    }
    const { evidence, tried } = findEntryEvidence(store.volumeDir, chapters, vol, entry.examples, body, assigned);
    if (!evidence) {
      refused.push({
        kind: "pov",
        character: aspectKey,
        because: `none of this POV claim's quotes (${tried.join(", ") || "no quoted span"}) occurs in volume ${vol}'s source text.`,
      });
      return;
    }
    if (assigned && !registerName(assigned).registered) return;
    fileCandidate(candidate, evidence);
    if (adoptedAlready) {
      carried.push({ kind: "pov", character: aspectKey });
      return;
    }

    if (!screen.ok) {
      refused.push({
        kind: "pov",
        character: aspectKey,
        because: `this POV claim's own prose is not finished writing: ${screen.because}`,
      });
      return;
    }
    if (screen.dropped.length) screened.push({ kind: "pov", character: aspectKey, dropped: screen.dropped });

    const result = store.insertFact({
      key: aspectKey,
      aspect: "pov",
      label: POV_VOICE_LABEL,
      section: null,
      body: screen.body,
      examples: screen.examples.slice(0, REBUILT_EXAMPLES_PER_BULLET),
      extractedAs: candidate.extractedAs,
      evidence,
      establishedVolume: vol,
      appliesFromVolume: vol,
    });
    if (!result.ok) {
      refused.push({ kind: "pov", character: aspectKey, rule: result.refusal.rule, because: result.refusal.because });
      return;
    }
    filed.push(result.fact);
    if (aspectKey) povAttached += 1;
    else povUnattached += 1;
  };

  /**
   * File one voice-quirk entry, under the roster entry its character name resolves to.
   *
   * @param {Object} entry - The extraction's voice record.
   * @returns {void}
   */
  const fileVoice = (entry) => {
    const name = typeof entry.character === "string" ? entry.character.trim() : "";
    if (!name) {
      refused.push({ kind: "voice", character: null, because: "a voice claim names no character, so it belongs to nobody." });
      return;
    }
    const who = resolveName(name);

    const quirk = typeof entry.quirkType === "string" ? entry.quirkType.trim() : "";
    const aspect = QUIRK_TYPE_TO_ASPECT[quirk.toLowerCase()] || UNMAPPED_ASPECT;
    const label = QUIRK_TYPE_TO_VOICE_LABEL[quirk.toLowerCase()] || (quirk || UNLABELED_VOICE_LABEL);
    const description = typeof entry.description === "string" ? entry.description.trim() : "";
    const body = description || label;
    // Screened before anything is compared, because the adoption is stored with the screened body: a
    // claim whose scaffolding label was taken off has to be recognised as the same claim on the next run,
    // or a re-run files it a second time under the stripped wording. The candidate below deliberately
    // keeps the extractor's own text.
    const screen = screenClaim({
      body,
      examples: (Array.isArray(entry.examples) ? entry.examples : []).filter((s) => typeof s === "string"),
    });
    const candidate = voiceCandidateRow(entry, who.key);
    // Kept on both copies of the claim: the extraction's own name, whenever the store filed the claim
    // somewhere else or nowhere at all.
    const extractedAs = name && (!who.key || who.key !== name) ? name : null;
    candidate.extractedAs = extractedAs;

    const adoptedAlready = rebuildClaimAlreadyStored(store, { key: who.key, aspect, body: screen.body });
    if (adoptedAlready && !candidateMissing(candidate)) {
      carried.push({ kind: "voice", character: who.key, label });
      return;
    }

    const { evidence, tried } = findEntryEvidence(store.volumeDir, chapters, vol, entry.examples, description, name);
    if (!evidence) {
      refused.push({
        kind: "voice",
        character: name,
        label,
        because:
          `none of this claim's quotes (${tried.join(", ") || "no quoted span"}) occurs in volume ${vol}'s source ` +
          "text, so the extraction result is not evidence for anything.",
      });
      return;
    }

    // The register gate, before the roster entry is written, for the same reason the evidence rule
    // runs first: a claim refused for answering a question this series never declared must not leave
    // its character on the roster, and it must not leave a candidate copy behind either. `insertFact`
    // would refuse it anyway — this ordering is what makes the refusal cost nothing.
    const gate = registerFilingRefusal(store, candidate, "insert_fact");
    if (gate) {
      refused.push({ kind: "voice", character: name, key: who.key, label, rule: gate.rule, because: gate.because });
      return;
    }

    if (!registerName(name).registered) return;

    // The candidate first, then the adoption: the candidate is the extraction's reading of this claim
    // and it exists whether or not this rebuild goes on to adopt it. It keeps the extractor's own text
    // — including a drafting note — because the point of keeping it is that the gap between what the
    // extractor wrote and what the reference published is a query the audit can run.
    fileCandidate(candidate, evidence);
    if (adoptedAlready) {
      carried.push({ kind: "voice", character: who.key, label });
      return;
    }

    /**
     * The adoption is held to a stricter standard than the candidate: a claim whose own prose is
     * unfinished, or that quotes the same span three times while saying it is not there, is the writer's
     * work rather than a claim about the book, and it does not get to become a published bullet. A claim
     * that merely opens with the extractor's label is published with the label taken off.
     */
    if (!screen.ok) {
      refused.push({
        kind: "voice",
        character: who.key,
        label,
        because: `the claim's own prose is not finished writing: ${screen.because}`,
      });
      return;
    }
    if (screen.dropped.length) screened.push({ kind: "voice", character: who.key, label, dropped: screen.dropped });

    const result = store.insertFact({
      key: who.key,
      aspect,
      label,
      section: null,
      body: screen.body,
      examples: screen.examples.slice(0, REBUILT_EXAMPLES_PER_BULLET),
      formality: typeof entry.formalityLevel === "string" && entry.formalityLevel.trim() ? entry.formalityLevel.trim() : null,
      extractedAs,
      // The register pair travels with the adoption. It is the candidate's own pair — read by the
      // extraction door's shape function, not re-read here — so the adopted row and the candidate beside
      // it can never disagree about which declared question this claim answers, and both go through the
      // same filing gate (`register/filing.js`) on the way in.
      axis: candidate.axis,
      axisValue: candidate.axisValue,
      evidence,
      establishedVolume: vol,
      appliesFromVolume: vol,
    });
    if (!result.ok) {
      refused.push({ kind: "voice", character: who.key, label, rule: result.refusal.rule, because: result.refusal.because });
      return;
    }
    filed.push(result.fact);
  };

  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== "object") {
      refused.push({ kind: "entry", because: "the extraction file contained something that is not an object." });
      continue;
    }
    if (entry.type === "pov") filePov(entry);
    // A confirmation is not a claim, and `fileVoice` would file it as one: aspect `unclassified`, label
    // `confirm`, and a bullet in the published reference under a sentence the extraction never meant as a
    // claim. The kind is routed out here and filed by `confirmations/file.js` below, in the same breath,
    // with this volume's chapters and its adopted claims already in front of it.
    else if (entry.type === CONFIRMATION_ENTRY_TYPE) continue;
    else fileVoice(entry);
  }

  /**
   * The confirmations this volume's reading pass reported, filed after its claims.
   *
   * After the claims, because a confirmation is an observation about a claim this record already stands
   * behind, and before `renderRebuiltVoice` ever runs, because the render is what makes the observation
   * readable to a translator. The door files nothing into `facts`: it writes one row per (claim, volume)
   * into `claim_confirmations` and leaves every claim row exactly as it is.
   */
  const confirmations = fileVoiceConfirmations(store, entries, { volume: vol, volumeDir: store.volumeDir, chapters });

  const resolved = [];
  const unresolved = [];
  for (const [name, entry] of nameMap) {
    if (entry.resolved) resolved.push({ name, key: entry.key, how: entry.how });
    else unresolved.push({ name, key: entry.key, because: entry.how, unattached: entry.unattached, ambiguous: entry.ambiguous });
  }
  resolved.sort((a, b) => a.name.localeCompare(b.name, "ja"));
  unresolved.sort((a, b) => a.name.localeCompare(b.name, "ja"));

  markDocumentMirrored(store, DOCUMENT_VOICE, vol);

  /**
   * What the record holds when this run is finished, as opposed to what this run added.
   *
   * The two are not the same number, and the report has to say the first. A rebuild that runs a second
   * time over its own output files nothing (every claim is already there) and would otherwise report
   * "0 claim(s) adopted, 0 character(s) with at least one claim" about a record holding 214 claims across
   * 8 characters — a report that describes the run instead of the reference is a report nobody can act
   * on, and this is the report a human reads before deciding whether the volume is fit to build on.
   */
  const adopted = store.db
    .prepare(
      "SELECT COALESCE(SUM(CASE WHEN key IS NOT NULL THEN 1 ELSE 0 END), 0) AS claims, " +
        "COUNT(DISTINCT key) AS characters, " +
        "COALESCE(SUM(CASE WHEN key IS NULL THEN 1 ELSE 0 END), 0) AS unkeyed " +
        "FROM facts WHERE owner_volume = ? AND source_stage = ?"
    )
    .get(vol, REBUILD_SOURCE_STAGE);

  /** How many candidate copies this record now holds for this volume — again the record's number, not this run's. */
  const candidateRows = store.db
    .prepare("SELECT COUNT(*) AS n FROM facts WHERE owner_volume = ? AND source_stage = ?")
    .get(vol, EXTRACTION_SOURCE_STAGE).n;

  markDocumentRebuilt(store, DOCUMENT_VOICE, vol, {
    filed: filed.length,
    carried: carried.length,
    refused: refused.length,
    characters: new Set(filed.map((fact) => fact.key).filter(Boolean)).size,
    adoptedClaims: adopted.claims,
    adoptedCharacters: adopted.characters,
    adoptedUnkeyed: adopted.unkeyed,
    candidateClaims: candidateRows,
    povUnattached,
    mirrorRowsRemoved,
    candidatesFiled: candidates.filed,
    candidatesRefused: candidates.refused.length,
  });

  return {
    ok: refused.length === 0,
    filed,
    filedCount: filed.length,
    carried,
    refused,
    characters: new Set(filed.map((fact) => fact.key).filter(Boolean)).size,
    adoptedClaims: adopted.claims,
    adoptedCharacters: adopted.characters,
    adoptedUnkeyed: adopted.unkeyed,
    candidateClaims: candidateRows,
    povAttached,
    povUnattached,
    resolved,
    unresolved,
    candidates,
    screened,
    confirmations,
    // True when this volume's record was already sealed by another stage (the glossary seals at the end
    // of its own work). The render went ahead because the seal froze no character-voice rows — but it is
    // worth a line in the log, because it says the reference being written here is the first one this
    // volume ever had.
    volumeSealed: mirror.volumeSealed,
    refusal: null,
  };
}

module.exports = {
  rebuildVoiceFromExtraction,
};
