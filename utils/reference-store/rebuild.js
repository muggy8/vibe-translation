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
 * Instead it adds a fourth kind of row: `source_stage = "rebuild"`, which only the code in this file
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
 * @module utils/reference-store/rebuild
 */

const fs = require("fs");
const path = require("path");

const { openReferenceStore } = require("./open");
const { readPlanOfRecord, installmentKey } = require("./paths");
const { REBUILD_SOURCE_STAGE, EXTRACTION_SOURCE_STAGE, DOCUMENT_SOURCE_STAGE } = require("./schema");
const { resolveExtractionName } = require("./name-resolution");
const { screenClaim } = require("./drafting");
const { moveArtifactAside, ensureArtifactRejectIgnoreRule } = require("./quarantine");
const {
  findEntryEvidence,
  QUIRK_TYPE_TO_ASPECT,
  UNMAPPED_ASPECT,
  extractionClaimAlreadyStored,
  voiceCandidateRow,
  povCandidateRow,
} = require("./extraction-adapter");
const {
  DOCUMENT_VOICE,
  storeDocumentProse,
  markDocumentMirrored,
  markDocumentRebuilt,
} = require("./document-prose");
const { auditVolumeRecord, renderVolumeAuditReport, resetDocumentMirror, volumeRecordExists } = require("./pipeline-store");
const { renderPovMap, writePovMapFile, POV_MAP_FILE } = require("./pov-map");
const { refusal } = require("./refusals");
require("../../types"); // JSDoc type definitions

/** The heading the rebuilt file opens with — the same title the authored artifact uses. */
const REBUILT_VOICE_TITLE = "# Character Voice Reference";

/** The section every character lives under, matching `system-prompts/character-voice.md`. */
const REBUILT_VOICE_SECTION = "Characters";

/**
 * The extraction prompt's `quirkType` values, spelled the way the artifact spells them.
 *
 * `QUIRK_TYPE_TO_ASPECT` maps a quirk type onto the aspect a query runs on; this maps it onto the
 * bullet label the file prints. They are separate on purpose: the artifact's wording is what
 * `voice-adapter.js`'s `VOICE_LABEL_TO_ASPECT` reads back, and every label here is already in that
 * table, so a rebuilt file re-imports into the same aspects it was filed as. The extractor's own
 * distinction (sentence endings vs vocabulary vs formality vs dialect, all one `register` aspect)
 * survives the round trip because the label carries it.
 *
 * @type {Object<string, string>}
 */
const QUIRK_TYPE_TO_VOICE_LABEL = {
  sentenceending: "Sentence endings",
  pronoun: "Pronouns",
  formality: "Formality level",
  vocabulary: "Vocabulary register",
  catchphrase: "Catchphrases",
  dialect: "Dialect",
  internalvoice: "Internal voice",
};

/** The label a POV claim gets when it is attached to a character. */
const POV_VOICE_LABEL = "Point of view";

/** The label a claim whose quirk type the prompt did not list gets. */
const UNLABELED_VOICE_LABEL = "Notes";

/**
 * How long one rendered **line** may be.
 *
 * The artifact-shape check reports a line longer than an agent's file tools can read (`AGENT_MAX_LINE
 * _LENGTH`, default 8000) as HIGH, and volume 01's destroyed reference is exactly that failure. A
 * rebuild that emitted a 9,000-character bullet would produce a file its own audit refuses. The cap is
 * therefore smaller than the read limit, it counts the `- **Label**: ` prefix, and a claim over it is
 * **named as truncated** in the file — the full text stays in the record, where the audit and (slice 8)
 * the translator can reach it.
 */
const MAX_REBUILD_BULLET_CHARS = 2000;

/** How many of a claim's own quotes are printed in its bullet. */
const REBUILT_EXAMPLES_PER_BULLET = 3;

/** What a capped bullet says about itself, so a reader knows the line is not the whole claim. */
const TRUNCATION_NOTE = " (truncated here; the full claim is in this volume's reference record)";

// `displayAliasSpans` and `resolveExtractionName` live in `name-resolution.js`, the leaf both this
// module and `extraction-adapter.js` require so the two doors that file extraction names into the
// record cannot drift into two different answers about the same name.

/**
 * Declare an alias the artifacts do not record, through the store's own verb.
 *
 * This is the human-supplied half of name resolution, and it goes through `castAlias` because that is
 * the door that records a reason. When the alias is already its own cast entry `castAlias` treats it
 * as a merge, which is why declarations are applied **before** any claim is filed: the alias should be
 * an alias of a roster entry, not a second roster entry that then has to be merged away.
 *
 * @param {ReferenceStore} store
 * @param {Array<{key: string, alias: string, reason: string}>} aliases
 * @returns {{applied: Array<{key: string, alias: string}>, refused: Array<{key: string, alias: string, because: string}>}}
 */
function applyAliasDeclarations(store, aliases = []) {
  const applied = [];
  const refused = [];
  for (const entry of Array.isArray(aliases) ? aliases : []) {
    const key = typeof entry?.key === "string" ? entry.key.trim() : "";
    const alias = typeof entry?.alias === "string" ? entry.alias.trim() : "";
    const reason = typeof entry?.reason === "string" ? entry.reason.trim() : "";
    if (!key || !alias) {
      refused.push({ key, alias, because: "an alias declaration needs both the roster entry and the alias." });
      continue;
    }
    if (!reason) {
      refused.push({ key, alias, because: `the alias ${alias} → ${key} needs a reason: the store records why a name was linked, not just that it was.` });
      continue;
    }
    const result = store.castAlias(key, alias, reason);
    if (result.ok) applied.push({ key, alias });
    else refused.push({ key, alias, because: result.refusal.because });
  }
  return { applied, refused };
}

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
 * **The sealing question is asked about the volume, not about one kind of row.** It used to be asked as
 * "does this volume hold sealed rows whose `source_stage` is the document mirror", which was true of the
 * author route's record and false of the read-then-assemble route's: that route files its adopted claims
 * as `rebuild` rows and its extraction copies as `extract` rows, so a volume sealed by it had zero sealed
 * `document` rows and a full `--apply --move-aside` rebuild ran straight over its published record
 * (gotcha 109). Asking "is this volume sealed" is both narrower and wider than the row query: narrower
 * because it is one fact the store already keeps, wider because it does not care which stage wrote the
 * rows the seal froze. The row counts are still taken, over every stage, so the refusal can name what it
 * is refusing to overwrite rather than only that it is refusing.
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

  if (volumeSealed || sealedTotal > 0) {
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
          `volume ${vol}'s record is ${volumeSealed ? "sealed" : "holds sealed rows"}: ` +
          `${sealedTotal} sealed row(s) of its own (${kinds || "no stage counted, only the seal"}). ` +
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
 * @returns {{ok: boolean, filed: Array<Object>, filedCount: number, carried: Array<Object>, refused: Array<Object>, characters: number, adoptedClaims: number, adoptedCharacters: number, adoptedUnkeyed: number, candidateClaims: number, povAttached: number, povUnattached: number, resolved: Array<{name: string, key: string, how: string}>, unresolved: Array<{name: string, key: string}>, candidates: {filed: number, carried: number, refused: Array<Object>}, refusal: ReferenceRefusal|null}}
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
  /** @type {Map<string, {key: string, display: string, resolved: boolean, how: string, registered?: boolean}>} */
  const nameMap = new Map();
  let povAttached = 0;
  let povUnattached = 0;

  /**
   * Resolve one extraction name to a roster entry, without creating anything.
   *
   * @param {string} name
   * @returns {{key: string, display: string, resolved: boolean, how: string, registered?: boolean}}
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
   * @param {string} name
   * @returns {{key: string, display: string, resolved: boolean, registered: boolean}}
   */
  const registerName = (name) => {
    const resolved = resolveName(name);
    if (resolved.registered === undefined) {
      const upsert = store.upsertCast({ key: resolved.key, display: resolved.display, firstSeenVolume: vol });
      resolved.registered = upsert.ok;
      if (!upsert.ok) refused.push({ kind: "voice", character: name, because: upsert.refusal.because });
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
    const body = candidate.body;

    const adoptedAlready = rebuildClaimAlreadyStored(store, { key: aspectKey, aspect: "pov", body });
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

    const screen = screenClaim({
      body,
      examples: (Array.isArray(entry.examples) ? entry.examples : []).filter((s) => typeof s === "string"),
    });
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
      body,
      examples: screen.examples.slice(0, REBUILT_EXAMPLES_PER_BULLET),
      evidence,
      establishedVolume: vol,
      appliesFromVolume: vol,
    });
    if (!result.ok) {
      refused.push({ kind: "pov", character: aspectKey, because: result.refusal.because });
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
    const candidate = voiceCandidateRow(entry, who.key);

    const adoptedAlready = rebuildClaimAlreadyStored(store, { key: who.key, aspect, body });
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
     * work rather than a claim about the book, and it does not get to become a published bullet.
     */
    const screen = screenClaim({
      body,
      examples: (Array.isArray(entry.examples) ? entry.examples : []).filter((s) => typeof s === "string"),
    });
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
      body,
      examples: screen.examples.slice(0, REBUILT_EXAMPLES_PER_BULLET),
      formality: typeof entry.formalityLevel === "string" && entry.formalityLevel.trim() ? entry.formalityLevel.trim() : null,
      evidence,
      establishedVolume: vol,
      appliesFromVolume: vol,
    });
    if (!result.ok) {
      refused.push({ kind: "voice", character: who.key, label, because: result.refusal.because });
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
    else fileVoice(entry);
  }

  const resolved = [];
  const unresolved = [];
  for (const [name, entry] of nameMap) {
    if (entry.resolved) resolved.push({ name, key: entry.key, how: entry.how });
    else unresolved.push({ name, key: entry.key });
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
      "SELECT SUM(CASE WHEN key IS NOT NULL THEN 1 ELSE 0 END) AS claims, " +
        "COUNT(DISTINCT key) AS characters, " +
        "SUM(CASE WHEN key IS NULL THEN 1 ELSE 0 END) AS unkeyed " +
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
    refusal: null,
  };
}

/**
 * One claim's quotes, printed the way the artifact prints them.
 *
 * The verified quote is what makes a bullet usable: a translator needs the line, not only a
 * description of it. The store already holds the examples it accepted, so the rebuilt file carries
 * them and is therefore self-citing — re-importing it finds the same spans the evidence rule found.
 *
 * @param {string[]} examples
 * @returns {string} Empty when the claim carried none.
 */
function renderExamples(examples) {
  const spans = [];
  for (const example of Array.isArray(examples) ? examples : []) {
    const span = String(example || "").replace(/\s+/g, " ").trim();
    if (!span) continue;
    spans.push(span.startsWith("「") || span.startsWith("“") ? span : `「${span}」`);
    if (spans.length >= REBUILT_EXAMPLES_PER_BULLET) break;
  }
  return spans.length ? ` — e.g. ${spans.join(" / ")}` : "";
}

/**
 * Keep one bullet inside the read limit, and say out loud when it had to.
 *
 * @param {string} body
 * @param {number} budget - How many characters the body may use once the `- **Label**: ` prefix is
 *   counted. The cap is on the **line**, because the thing the artifact-shape check measures is lines.
 * @returns {string}
 */
function fitBullet(body, budget) {
  const text = String(body || "").replace(/\s*\n\s*/g, " ").trim();
  if (text.length <= budget) return text;
  return `${text.slice(0, Math.max(0, budget - TRUNCATION_NOTE.length - 1))}…${TRUNCATION_NOTE}`;
}

/**
 * Render this volume's character-voice reference from its record, in chapter order.
 *
 * Sections are ordered by the earliest chapter any of that character's claims cites; bullets within a
 * section the same way. Doc 04 §7.1: the notes record what changed and when, so the order is the
 * meaning. Rows the extractor filed but the record never adopted are not rendered — that is
 * `voice-adapter.js`'s guard, and it is untouched here.
 *
 * @param {ReferenceStore} store
 * @param {{volume?: number, title?: string, preamble?: string[]}} [opts]
 * @returns {{markdown: string, opening: string[], sections: number, characters: Array<{key: string, display: string, bullets: number, firstChapter: string|null}>, unattached: number, truncated: number}}
 */
function renderRebuiltVoice(store, { volume, title = REBUILT_VOICE_TITLE, preamble = null } = {}) {
  const vol = Number(volume === undefined ? store.volume : volume);

  /** @type {Map<string, number>} `volume:chapter` → its position in the source */
  const chapterOrder = new Map();
  for (const row of store.db.prepare("SELECT volume, chapter_id, ord FROM chapters").all()) {
    chapterOrder.set(`${row.volume}:${row.chapter_id}`, row.ord);
  }

  /**
   * The sort key of one row: when the book first printed the evidence for it.
   * @param {{established_volume: number, established_chapter: string|null, ord: number}} row
   * @returns {number}
   */
  const when = (row) => {
    const ord = chapterOrder.get(`${row.established_volume}:${row.established_chapter}`);
    return ord === undefined ? Number.MAX_SAFE_INTEGER : ord;
  };

  const rows = store.db
    .prepare(
      "SELECT f.id, f.key, f.label, f.body, f.examples, f.ord, f.established_volume, f.established_chapter, " +
        "c.display AS display " +
        "FROM facts f JOIN cast c ON c.key = f.key " +
        "WHERE f.key IS NOT NULL AND f.source_stage != ? AND c.merged_into IS NULL " +
        "ORDER BY f.established_volume, f.ord, f.id"
    )
    .all(EXTRACTION_SOURCE_STAGE);

  /** @type {Map<string, {key: string, display: string, rows: Array<Object>}>} */
  const byCharacter = new Map();
  for (const row of rows) {
    if (!byCharacter.has(row.key)) byCharacter.set(row.key, { key: row.key, display: row.display, rows: [] });
    byCharacter.get(row.key).rows.push(row);
  }

  const sections = [...byCharacter.values()].sort((a, b) => {
    const wa = Math.min(...a.rows.map(when));
    const wb = Math.min(...b.rows.map(when));
    if (wa !== wb) return wa - wb;
    return a.key.localeCompare(b.key, "ja");
  });

  const opening = [title, ""];
  for (const line of preamble || defaultRebuiltPreamble(vol)) opening.push(line, "");
  opening.push(`## ${REBUILT_VOICE_SECTION}`, "");

  const out = [...opening];
  /** @type {Array<{key: string, display: string, bullets: number, firstChapter: string|null}>} */
  const characters = [];
  let truncated = 0;

  for (const character of sections) {
    const ordered = [...character.rows].sort((a, b) => {
      const wa = when(a);
      const wb = when(b);
      if (wa !== wb) return wa - wb;
      return a.ord - b.ord;
    });
    const first = ordered[0];
    out.push(`### ${character.display}`, "");
    for (const row of ordered) {
      const label = row.label || "Notes";
      const prefix = `- **${label}**: `;
      const full = `${row.body}${renderExamples(JSON.parse(row.examples || "[]"))}`;
      const body = fitBullet(full, MAX_REBUILD_BULLET_CHARS - prefix.length);
      if (body !== full) truncated += 1;
      out.push(`${prefix}${body}`);
    }
    out.push("");
    characters.push({
      key: character.key,
      display: character.display,
      bullets: ordered.length,
      firstChapter: first ? first.established_chapter : null,
    });
  }

  const unattached = store.db
    .prepare("SELECT COUNT(*) AS n FROM facts WHERE key IS NULL AND aspect = 'pov' AND source_stage != ?")
    .get(EXTRACTION_SOURCE_STAGE).n;

  return {
    markdown: out.join("\n").replace(/\n+$/, "") + "\n",
    opening,
    sections: characters.length,
    characters,
    unattached,
    truncated,
  };
}

/**
 * The preamble the rebuilt file carries: what it is, and what its bullets are.
 *
 * It is stored as document prose, so it round-trips verbatim and the file explains itself to whoever
 * reads it next. It is not a claim about the book, and the store's prose rule keeps it as text.
 *
 * @param {number} vol
 * @returns {string[]}
 */
function defaultRebuiltPreamble(vol) {
  return [
    `_Rebuilt by code from volume ${vol}'s extraction output (\`character-voice-new.json\`); no author agent wrote this file._`,
    `_Every bullet cites a line of this volume's own text, and the sections and bullets are in the order the chapters they cite appear._`,
  ];
}

/**
 * Whether this volume's record is missing the volumes that came before it.
 *
 * A rebuild files **this volume's** claims. It does not carry the previous volume's record forward —
 * that is `openVolumeRecord`'s job, and it belongs to the pipeline's ordering, not to a command a
 * person runs once. For volume 1 there is nothing to carry. For volume 5, rebuilding into a record
 * that holds only volume 5's rows would produce a reference that has silently forgotten volumes 1–4,
 * and the coverage query would answer a question about five volumes as if it were a question about
 * one. So the rebuild refuses, and names the step to run first.
 *
 * @param {ReferenceStore} store
 * @param {number} vol
 * @param {string} seriesDir
 * @returns {boolean} True when an earlier volume exists in the plan of record and nothing from it is in this record.
 */
function rebuildRecordIsMissingItsEarlierVolumes(store, vol, seriesDir) {
  if (!planHasEarlierVolumes(seriesDir, vol)) return false;
  const carriedFacts = store.db.prepare("SELECT COUNT(*) AS n FROM facts WHERE owner_volume < ?").get(vol).n;
  const provenance = store.db.prepare("SELECT COUNT(*) AS n FROM copy_provenance WHERE volume < ?").get(vol).n;
  return carriedFacts === 0 && provenance === 0;
}

/**
 * Whether the plan of record has a volume before this one.
 *
 * Split out because the answer is needed **before a store is opened**: opening creates the file, and a
 * refusal that leaves an empty record behind would then block the very copy-forward the refusal is
 * telling the operator to run.
 *
 * @param {string} seriesDir
 * @param {number} vol
 * @returns {boolean}
 */
function planHasEarlierVolumes(seriesDir, vol) {
  const plan = readPlanOfRecord(seriesDir) || [];
  const mine = Number(installmentKey(vol));
  return plan.some((entry) => {
    const key = Number(installmentKey(entry && entry.installmentNumber));
    return Number.isFinite(key) && key < mine;
  });
}

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
      useInstead: ["openVolumeRecord({ volume, folder, seriesDir }) — or run the character-voice stage once with VOICE_STORE_VALIDATORS on, which carries the previous volume's record first", "rebuild volume 1 first, then work forward"],
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

    const aliasResult = applyAliasDeclarations(opened, aliases);

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
  REBUILD_SOURCE_STAGE,
  REBUILT_VOICE_TITLE,
  REBUILT_VOICE_SECTION,
  QUIRK_TYPE_TO_VOICE_LABEL,
  POV_VOICE_LABEL,
  MAX_REBUILD_BULLET_CHARS,
  REBUILT_EXAMPLES_PER_BULLET,
  applyAliasDeclarations,
  rebuildClaimAlreadyStored,
  inspectVoiceMirrorForRebuild,
  rebuildVoiceFromExtraction,
  renderRebuiltVoice,
  writeRebuiltVoiceFile,
  publishRebuiltVolume,
  rebuildVoiceVolume,
  rebuildRecordIsMissingItsEarlierVolumes,
  planHasEarlierVolumes,
};
