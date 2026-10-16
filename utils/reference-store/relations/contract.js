/**
 * utils/reference-store/relations/contract.js — plan 07 slice 4: the extraction contract, and the ladder
 * that decides how sure this record is about **who is speaking the words a relation quotes**.
 *
 * Plan 07 slice 3 built the table and the door, and said in its own header that the door does not compute
 * the certainty level: "a door that computed the ladder would be a door that guessed who speaks". This is
 * the other half — the reading of one extraction entry into one proposal, and the code that decides which
 * level the record can actually show.
 *
 * ## Where the entry comes from, and why it costs nothing
 *
 * The chapter call already runs: `character-voice/reading.js` pays one read per chapter and gets back an
 * array of entries. A relation is a **fourth kind in that same array** (`type: "relation"`), the way
 * `type: "confirm"` became the third one (plan 06 slice 7). This slice adds no call, no prompt file, no
 * stage, no command and no setting. The kind is routed out of the claim path in
 * `rebuild/filing.js` — `fileVoice` would file it as a claim with aspect `unclassified` and a bullet in the
 * published reference — and filed here, after the claims, from the same place the confirmations are filed,
 * so the stage route and `rebuild-voice.js` cannot disagree about what an act of address is.
 *
 * ## The ladder is computed here and nowhere else
 *
 * Plan 07 §4.4 lists six levels and one rule: **never a number a model reported about itself**. So the
 * entry names the act — who spoke, whom they addressed, which form they used, which line shows it — and
 * this file decides the level from what the record can measure:
 *
 *   1. **`narration` and `withheld` come straight from the channel**, and so does **`unknown`** — the entry
 *      names no addresser and the channel allows an admitted gap. For all three the level *is* the shape of
 *      the entry, so the ladder is not asked. None of them needs a name, and none gets one: the row carries
 *      a null party beside a named kind, which is the shape `attribution_answers` already uses (gotcha 121)
 *      and the reason the narration never becomes a roster entry the coverage rule has to find in the text.
 *   2. **`measured`** — the line the entry quotes verifies against this volume's own text, the store's name
 *      rule finds **exactly one** cast form in that line, that form resolves to **one** identity, that
 *      identity is the addresser's, and the addressee is a **different** identity. Every part of that is a
 *      read, not a judgement: `citationForQuote` for the line, `chapter-facts`'s matcher for the form,
 *      `identitiesOfParty` for the person.
 *   3. **`addressee-risk`** — the same line names exactly one cast form and that form resolves only to the
 *      **addressee's** identity. This is the measured failure mode, not a hypothetical one: the obvious rule
 *      ("a cast name inside the quote is the speaker") fired 0 times in volume 1 and 10 times in volume 2,
 *      and **all ten of them named the person being spoken to** (gotcha 121). A level that exists to catch
 *      that is worth filing even when it fires. The second shape is the form itself: the form the speaker
 *      used to address somebody resolves to the addressee's identity and not the addresser's — a nickname
 *      that is the other person's name.
 *   4. **`reading-resolved`** — the addresser's identity is one the record holds **only because the author's
 *      own pronunciation markup stated the link** (`identityStatedByGuide`, a live `cast_identity_links` row
 *      stated by the guide source). A group joined only by the glossary's model-written prose is not this
 *      level, and the door already refuses it when the link is not there.
 *      gap. This is not the same row as `withheld`, and `shapes.js` explains why at length: "the author
 *      refused to say" and "we could not place it" are different facts. A channel that does **not** allow an
 *      admitted gap (`self-address`, whose whole content is that the speaker is the person addressed) gets
 *      no level and is reported, because an unnamed self-address is not a self-address.
 *   6. **Nothing above fires → the entry is not filed.** It is reported as an unlevelled observation, with
 *      the rung that failed. There is no fallback level, because a fallback level is a guess wearing a
 *      vocabulary.
 *
 * ## What the ladder does NOT read
 *
 * It resolves a party through the **identity tables** only. It does not read the written-forms rows: the
 * guide signal the ladder cares about is already recorded as a `cast_identity_links` row stated by the
 * book's own markup, which is what `reading-resolved` is defined on and what the door already checks. A
 * written form the record has no identity for is a **named limit**, not a resolved person — the same wall
 * plan 07 §6.8 measures (88 of 196 roster names keyable, 108 not), reached from the other side.
 *
 * ## What this file never does
 *
 * It files no claim, no candidate, no `facts` row, no `cast` entry, no `cast_alias`, no `cast_merges` row,
 * no identity, no identity link, no confirmation and no challenge; it marks nothing and seals nothing. It
 * **creates no roster entry and no identity** to make an entry fileable — a party the record has no
 * identity for is reported, which is §6.8 (the owner's), not this door's call. It adds **no finding kind**
 * (the level table stays at 70), **no level**, no freeze door, no declared artifact, no command, no npm
 * script, no setting, no environment knob and **no verb on the store's handle**: like
 * `fileVolumeWrittenForms`, it is a function reached through the cover. It makes **no model call** and
 * reads no prompt. It publishes nothing: no renderer, no audit rule, no chapter block and no translator
 * prompt reads a relation, so nothing this door files reaches a published file or a chapter call.
 *
 * A relation the door refuses does not fail the volume. `rebuildVoiceFromExtraction`'s `ok` means "no claim
 * was refused", and an act of address the record cannot key is a limit, not a broken book.
 *
 * @module utils/reference-store/relations/contract
 */

const { EXTRACTION_SOURCE_STAGE } = require("../schema");
const { rosterForChapterQuery, castNamedInChapterText } = require("../chapter-facts");
const { readChapterLines } = require("../source-chapters");
const { refusal } = require("../refusals");
const { RELATION_CHANNELS, RELATION_CERTAINTY_LEVELS, partyKindsAllowedByChannel } = require("./shapes");
const { identitiesOfParty, identityStatedByGuide, citationForQuote, fileRelation } = require("./file");
require("../../../types"); // JSDoc type definitions

/**
 * The fourth kind in the chapter call's own answer array.
 *
 * Named here rather than in `shapes.js` because it is a **wire** kind, not a column vocabulary: the table's
 * own `CHECK` constraints do not mention it, and `shapes.js` is the file that mirrors those constraints name
 * for name. `confirmations/shapes.js` carries its kind for the same reason — that file is the pure leaf this
 * layer's answer-shape constant belongs beside — but the relations layer's pure leaf is pinned against the
 * schema, and this slice was told not to touch it.
 *
 * @type {string}
 */
const RELATION_ENTRY_TYPE = "relation";

/**
 * The channels whose whole content is a person doing an act, and which therefore need the ladder.
 *
 * Derived from `RELATION_CHANNEL_PARTY_KINDS` rather than written out again: a channel that allows an
 * `identity` addresser is a person channel, and adding a channel to the table is a migration that must
 * change this list automatically rather than need a second edit in a second file.
 *
 * @param {string} channel
 * @returns {boolean}
 */
function isPersonChannel(channel) {
  return partyKindsAllowedByChannel(channel).includes("identity");
}

/**
 * The channel that names the act without naming a person, and the kind it names.
 *
 * `narration` → `narrator`, `withheld` → `withheld`. Both file a null party beside a named kind, and both
 * skip the ladder entirely: the level *is* the channel, which is what `RELATION_CERTAINTY_PARTY_KINDS`
 * already encodes.
 *
 * @param {string} channel
 * @returns {string|null} The addresser kind, or null when the channel is a person channel (or unknown).
 */
function kindOfNamelessChannel(channel) {
  const allowed = partyKindsAllowedByChannel(channel);
  if (allowed.length === 1 && allowed[0] !== "identity" && allowed[0] !== "unknown") return allowed[0];
  return null;
}

/**
 * The certainty level a nameless channel carries, which is the channel's own name.
 *
 * `narration` and `withheld` are in both vocabularies — the party kind and the level are the same word for
 * `withheld` and one letter apart for `narration` (the kind is `narrator`, the level is `narration`), which
 * is exactly the place a "the kind is the level" shortcut would break. So the level is looked up in the
 * level vocabulary rather than copied from the kind, and a channel whose name is not a level gets nothing.
 *
 * @param {string} channel
 * @returns {string|null}
 */
function levelOfNamelessChannel(channel) {
  return RELATION_CERTAINTY_LEVELS.includes(channel) ? channel : null;
}

/**
 * One name's identity, as far as this record can say it.
 *
 * @param {{db: Object}} store
 * @param {string} name - A roster key or written form, exactly as the record spells it.
 * @returns {{id: number|null, count: number, inRoster: boolean, identities: Array<Object>}}
 */
function identityForName(store, name) {
  const key = String(name === undefined || name === null ? "" : name).trim();
  if (!key) return { id: null, count: 0, inRoster: false, identities: [] };
  const who = identitiesOfParty(store, key);
  return {
    id: who.identities.length === 1 ? who.identities[0].identity : null,
    count: who.identities.length,
    inRoster: who.inRoster,
    identities: who.identities,
  };
}

/**
 * The cast forms one line of this volume's text names, and the identity each one resolves to.
 *
 * The matcher is `chapter-facts`'s — `presence.js`'s search names and `evidence.js`'s verbatim-then-Han-skeleton
 * rule — reached through the same helper the coverage audit and the chapter block use, so this ladder and the
 * audit cannot disagree about who a line names. Reused rather than copied, which is the rule plan 06 slice 2
 * pinned when it replaced a document with a query.
 *
 * @param {{db: Object}} store
 * @param {Object} roster - {@link rosterForChapterQuery}'s answer, read once per volume.
 * @param {string} line - One line of the volume's own source text.
 * @returns {Array<{key: string, identity: number|null, identities: number}>}
 */
function castFormsNamedInLine(store, roster, line) {
  const text = String(line || "").trim();
  if (!text) return [];
  const measured = castNamedInChapterText(store, text, { roster });
  return measured.named.map((entry) => {
    const who = identityForName(store, entry.key);
    return { key: entry.key, identity: who.id, identities: who.count };
  });
}

/**
 * The lines of one chapter, read once and cached for the whole filing pass.
 *
 * The ladder asks about a line, and a volume's filing pass quotes the same chapter several times. Re-reading
 * the file per entry is the only cost this guard has, and it is a file read, not a model call.
 *
 * @param {string} volumeDir
 * @param {Array<{id: string, file: string}>} chapters
 * @returns {Map<string, Array<string>>}
 */
function chapterLineCache(volumeDir, chapters) {
  /** @type {Map<string, Array<string>>} */
  const cache = new Map();
  for (const chapter of Array.isArray(chapters) ? chapters : []) {
    if (!chapter || !chapter.id || !chapter.file) continue;
    if (cache.has(String(chapter.id))) continue;
    cache.set(String(chapter.id), readChapterLines(volumeDir, chapter.file) || []);
  }
  return cache;
}

/**
 * The certainty level one observation supports, and the rung that produced it.
 *
 * The order is the ladder's own strength order, and it matters: the addressee risk is checked before the
 * guide-stated identity, because a line whose only cast form is the person being spoken to is the failure
 * this level exists to name, and a record that reported `reading-resolved` about it would be reporting the
 * weaker fact about a line it had already misread.
 *
 * @param {{db: Object}} store
 * @param {Object} observation - `{addresserId, addresseeId, formUsedId, lineForms, lineVerified}`.
 * @returns {{certainty: string|null, via: string|null, because: string}}
 */
function certaintyOfObservation(store, { addresserId, addresseeId, formUsedId, lineForms, lineVerified } = {}) {
  /** @type {Array<{key: string, identity: number|null, identities: number}>} */
  const forms = Array.isArray(lineForms) ? lineForms : [];

  if (lineVerified && forms.length === 1 && forms[0].identity !== null) {
    const named = forms[0];
    if (addresseeId !== null && named.identity === addresseeId && named.identity !== addresserId) {
      return {
        certainty: "addressee-risk",
        via: "line",
        because:
          `the only cast form this line names is ${named.key}, and that form belongs to the addressee's identity, ` +
          "not the addresser's — the shape plan 07 §2.9 measured 10 times in one volume",
      };
    }
    if (named.identity === addresserId && addresseeId !== null && addresseeId !== addresserId) {
      return {
        certainty: "measured",
        via: "line",
        because:
          `the line names exactly one cast form (${named.key}), it resolves to one identity, that identity is the ` +
          "addresser's, and the addressee is a different one",
      };
    }
    if (addresseeId !== null && named.identity === addresseeId && named.identity === addresserId) {
      return {
        certainty: null,
        via: null,
        because:
          `the addresser and the addressee are already the same identity (${named.identity}), so nothing in this ` +
          "line separates the one speaking from the one being spoken to, and `measured` is the level that separates them",
      };
    }
    return {
      certainty: null,
      via: null,
      because:
        `the only cast form this line names (${named.key}) belongs to neither party's identity, so the line does ` +
        "not say who is speaking it",
    };
  }

  if (formUsedId !== null && addresseeId !== null && formUsedId === addresseeId && formUsedId !== addresserId) {
    return {
      certainty: "addressee-risk",
      via: "form",
      because:
        "the written form this act used is itself a form of the addressee, and not a form of the addresser — " +
        "the form somebody is addressed with is often the other person's own name",
    };
  }

  if (addresserId !== null && identityStatedByGuide(store, addresserId)) {
    return {
      certainty: "reading-resolved",
      via: "guide",
      because:
        `identity ${addresserId} is one this record holds because the book's own pronunciation markup stated the ` +
        "link, which is the only thing `reading-resolved` is allowed to rest on",
    };
  }

  const missing = [];
  if (!lineVerified) missing.push("no line of this volume's text was verified");
  else if (forms.length !== 1) missing.push(`the verified line names ${forms.length} cast form(s), not exactly one`);
  else missing.push(`the one cast form the line names (${forms[0].key}) resolves to ${forms[0].identities} identity/ies`);
  if (addresserId === null) missing.push("the addresser is not inside an identity this record holds");
  else if (!identityStatedByGuide(store, addresserId)) missing.push("that identity is not one the book's own markup stated");
  if (formUsedId === null) missing.push("the form used resolves to no identity");
  return { certainty: null, via: null, because: missing.join("; ") };
}

/**
 * Turn one extraction entry into one proposal the door can check, or name why it cannot become one.
 *
 * @param {ReferenceStore} store
 * @param {Object} entry - The extraction's `type: "relation"` record.
 * @param {{volume: number, roster: Object, lines: Map<string, Array<string>>, volumeDir: string, chapters: Array<{id: string, file: string}>}} ctx
 * @returns {{proposal: Object|null, certainty: string|null, via: string|null, because: string, quote: string|null}}
 */
function relationProposalFromEntry(store, entry, { volume, roster, lines, volumeDir, chapters } = {}) {
  const text = (value) => (typeof value === "string" ? value.trim() : "");
  const vol = Number(volume);

  const channel = text(entry.channel);
  const addresserName = text(entry.addresser);
  const addresseeName = text(entry.addressee);
  const formUsed = text(entry.formUsed);
  const statement = text(entry.statement);
  const offered = (Array.isArray(entry.examples) ? entry.examples : []).filter((s) => typeof s === "string" && s.trim());

  // An entry whose channel is not in the vocabulary is handed to the door unchanged, so the refusal that
  // reaches the report is the door's own — the one that names the five channels — and not a paraphrase of it.
  if (!RELATION_CHANNELS.includes(channel)) {
    return {
      proposal: { channel, addresser: addresserName, addressee: addresseeName, formUsed, statement, quote: offered[0] || null, chapter: text(entry.chapter) || null },
      certainty: null,
      via: null,
      because: `"${entry.channel}" is not a channel this record can hold`,
      quote: offered[0] || null,
    };
  }

  const nameless = kindOfNamelessChannel(channel);
  const addresserKind = nameless
    ? nameless
    : addresserName
      ? "identity"
      : partyKindsAllowedByChannel(channel).includes("unknown")
        ? "unknown"
        : null;

  if (!addresserKind) {
    return {
      proposal: null,
      certainty: null,
      via: null,
      because: `a "${channel}" act names no addresser, and this channel does not allow an admitted gap: ${partyKindsAllowedByChannel(channel).join(" or ")}`,
      quote: offered[0] || null,
    };
  }

  // A gap is its own level, and the ladder is not asked about it. A name beside one is not quietly dropped
  // either — it is handed to the door, which refuses it with `relation-names-a-party-it-is-not-claiming`,
  // because "the record does not name a person" and "the person is X" cannot both be filed.
  if (nameless || addresserKind === "unknown") {
    const level = nameless ? levelOfNamelessChannel(channel) : "unknown";
    if (!level) {
      return {
        proposal: null,
        certainty: null,
        via: null,
        because: `a "${channel}" act names no addresser, and "${channel}" is not a certainty level either, so there is nothing this record could stand behind`,
        quote: offered[0] || null,
      };
    }
    return {
      proposal: {
        channel,
        addresser: addresserName,
        addresserKind,
        addressee: addresseeName,
        certainty: level,
        formUsed,
        statement,
        quote: offered[0] || null,
        chapter: text(entry.chapter) || null,
      },
      certainty: level,
      via: "channel",
      because: nameless
        ? `the channel itself is the level: a "${channel}" act has a ${addresserKind} addresser and no identity`
        : `the entry names no addresser and "${channel}" allows an admitted gap, which is what "${level}" means`,
      quote: offered[0] || null,
    };
  }

  const addresser = addresserKind === "identity" ? identityForName(store, addresserName) : { id: null, count: 0, inRoster: false, identities: [] };
  const addressee = identityForName(store, addresseeName);
  const form = identityForName(store, formUsed);

  // The line the entry quotes, verified through the door's own citation half, and the cast forms that line
  // names. Verified first, because `measured` is the one level that promises a line and the door refuses it
  // without one.
  let quote = offered[0] || null;
  let lineVerified = false;
  /** @type {Array<{key: string, identity: number|null, identities: number}>} */
  let lineForms = [];
  for (const span of offered) {
    const found = citationForQuote(store, vol, span);
    if (!found.ok) continue;
    quote = span;
    lineVerified = true;
    const chapterId = String(found.citation.chapter);
    let chapterLines = lines.get(chapterId);
    if (!chapterLines) {
      const listed = (Array.isArray(chapters) ? chapters : []).find((c) => String(c.id) === chapterId);
      chapterLines = listed ? readChapterLines(volumeDir, listed.file) || [] : [];
      lines.set(chapterId, chapterLines);
    }
    const line = chapterLines[Number(found.citation.line) - 1];
    lineForms = castFormsNamedInLine(store, roster, line);
    break;
  }

  const ladder = certaintyOfObservation(store, {
    addresserId: addresser.id,
    addresseeId: addressee.id,
    formUsedId: form.id,
    lineForms,
    lineVerified,
  });

  if (!ladder.certainty) {
    return { proposal: null, certainty: null, via: null, because: ladder.because, quote };
  }

  return {
    proposal: {
      channel,
      addresser: addresserName,
      addresserKind,
      addressee: addresseeName,
      certainty: ladder.certainty,
      formUsed,
      statement,
      quote,
      chapter: text(entry.chapter) || null,
    },
    certainty: ladder.certainty,
    via: ladder.via,
    because: ladder.because,
    quote,
  };
}

/**
 * File every act of address one volume's reading pass reported, and report the rest of them by name.
 *
 * Three things this reports that a `fileRelations` call alone cannot: **which chapter** each outcome came
 * from (a limit is worth nothing if a volume cannot say where it happened), **which chapters reported no act
 * of address at all** and **which chapters' own text names no roster entry** — both named, neither punished,
 * because a book whose cast does not address anybody in a form the record can place is a fact about that
 * book, not a defect (and no finding kind is added for it: the level table stays at 70).
 *
 * @param {ReferenceStore} store - A handle that is not the extraction stage's.
 * @param {Array<Object>} entries - The parsed notebook, mixed kinds.
 * @param {{volume?: number, volumeDir?: string, chapters?: Array<{id: string, file: string}>}} [opts]
 * @returns {{ok: boolean, volume: number, refusal: ReferenceRefusal|null, relations: number, nonRelations: number, filed: Array<Object>, alreadyFiled: Array<Object>, refused: Array<Object>, namedLimits: Array<Object>, unlevelled: Array<Object>, chapters: Array<Object>, chaptersWithoutRelations: string[], chaptersNamingNobody: string[], filedCount: number, alreadyFiledCount: number, refusedCount: number, namedLimitCount: number, unlevelledCount: number}}
 */
function fileRelationsFromExtraction(store, entries, { volume, volumeDir, chapters = [] } = {}) {
  const vol = Number(volume === undefined ? (store && store.volume) : volume);
  const list = Array.isArray(entries) ? entries : [];
  const relations = list.filter((entry) => entry && typeof entry === "object" && String(entry.type || "").trim() === RELATION_ENTRY_TYPE);
  const listed = Array.isArray(chapters) ? chapters : [];

  /** @type {Array<Object>} */
  const filed = [];
  /** @type {Array<Object>} */
  const alreadyFiled = [];
  /** @type {Array<Object>} */
  const refused = [];
  /** @type {Array<Object>} */
  const namedLimits = [];
  /** @type {Array<Object>} */
  const unlevelled = [];
  /** @type {Map<string, Object>} */
  const byChapter = new Map();

  /**
   * One row of the per-chapter report, created on first use.
   * @param {string|null} chapterId
   * @returns {Object}
   */
  const chapterRow = (chapterId) => {
    const key = String(chapterId === null || chapterId === undefined ? "" : chapterId);
    if (!byChapter.has(key)) {
      byChapter.set(key, {
        chapter: key || null,
        relations: 0,
        filed: 0,
        alreadyFiled: 0,
        refused: 0,
        namedLimits: 0,
        unlevelled: 0,
        castNamed: null,
      });
    }
    return byChapter.get(key);
  };

  if (!store || !store.db || !store.scope) {
    return {
      ok: false,
      volume: vol,
      refusal: refusal({
        verb: "file_relations",
        rule: "relation-needs-a-record-handle",
        because: "there is no reference record open to file an act of address into.",
        fix: "open the volume's record first (openReferenceStore / openVolumeRecord), the way the claims are filed.",
      }),
      relations: relations.length,
      nonRelations: list.length - relations.length,
      filed, alreadyFiled, refused, namedLimits, unlevelled,
      chapters: [], chaptersWithoutRelations: [], chaptersNamingNobody: [], unstampedRelations: 0,
      filedCount: 0, alreadyFiledCount: 0, refusedCount: 0, namedLimitCount: 0, unlevelledCount: 0,
    };
  }

  if (store.scope.stage === EXTRACTION_SOURCE_STAGE) {
    const ref = refusal({
      verb: "file_relations",
      rule: "relation-needs-a-record-handle",
      because: `this handle writes as stage "${EXTRACTION_SOURCE_STAGE}". An act of address is a conclusion the record stands behind, and the extraction pass files candidates it has not decided about.`,
      useInstead: ['openReferenceStore({ volume, stage: "rebuild" }) — the handle the claims are filed through'],
    });
    return {
      ok: false,
      volume: vol,
      refusal: ref,
      relations: relations.length,
      nonRelations: list.length - relations.length,
      filed, alreadyFiled, refused, namedLimits, unlevelled,
      chapters: [], chaptersWithoutRelations: [], chaptersNamingNobody: [], unstampedRelations: 0,
      filedCount: 0, alreadyFiledCount: 0, refusedCount: 0, namedLimitCount: 0, unlevelledCount: 0,
    };
  }

  const bookDir = volumeDir || store.volumeDir;
  const roster = rosterForChapterQuery(store);
  const lines = chapterLineCache(bookDir, listed);

  /** @type {Set<string>} Chapters whose answer carried at least one relation entry. */
  const chaptersWithRelations = new Set();
  /** @type {string[]} Chapters the volume listed whose answer carried no act of address. Named, not punished. */
  const chaptersWithoutRelations = [];
  /** @type {string[]} Chapters that reported an act and whose own text names no roster entry. Named, not punished. */
  const chaptersNamingNobody = [];
  /** How many acts of address arrived with no chapter stamped on them — named, never guessed at. */
  let unstampedRelations = 0;

  for (const entry of relations) {
    const chapterId = typeof entry.chapter === "string" ? entry.chapter.trim() : "";
    if (chapterId) chaptersWithRelations.add(chapterId);
    else unstampedRelations += 1;
    const row = chapterRow(chapterId);
    row.relations += 1;

    const built = relationProposalFromEntry(store, entry, { volume: vol, roster, lines, volumeDir: bookDir, chapters: listed });
    if (!built.proposal) {
      unlevelled.push({
        chapter: chapterId || null,
        channel: String(entry.channel || "").trim() || null,
        addresser: typeof entry.addresser === "string" ? entry.addresser.trim() : null,
        addressee: typeof entry.addressee === "string" ? entry.addressee.trim() : null,
        formUsed: typeof entry.formUsed === "string" ? entry.formUsed.trim() : null,
        because: built.because,
      });
      row.unlevelled += 1;
      continue;
    }

    const result = fileRelation(store, built.proposal, { volume: vol });
    if (result.filed) {
      filed.push({ relationId: result.filed.relationId, certainty: result.filed.certainty, via: built.via, chapter: chapterId || null, formUsed: result.filed.formUsed, channel: result.filed.channel });
      row.filed += 1;
      continue;
    }
    if (result.already) {
      alreadyFiled.push({ relationId: result.already.relationId, certainty: result.already.certainty, chapter: chapterId || null, formUsed: result.already.formUsed, channel: result.already.channel });
      row.alreadyFiled += 1;
      continue;
    }
    if (result.namedLimit) {
      namedLimits.push({ chapter: chapterId || null, certainty: built.certainty, ...result.namedLimit });
      row.namedLimits += 1;
      continue;
    }
    if (result.refusal) {
      refused.push({
        chapter: chapterId || null,
        certainty: built.certainty,
        channel: built.proposal.channel,
        addresser: built.proposal.addresser || null,
        addressee: built.proposal.addressee || null,
        rule: result.refusal.rule,
        because: result.refusal.because,
      });
      row.refused += 1;
    }
  }

  // Which chapters the volume's own text names, measured with the store's one name rule — asked only of the
  // chapters that reported an act, because a chapter that reported nothing has already been named below and
  // scanning every chapter of a 17-book corpus to say "nothing happened here" is a cost with no answer behind
  // it. `castNamed: null` means "not measured", never "measured and empty".
  for (const [chapterId, row] of byChapter) {
    if (!chapterId) continue;
    const chapterFile = listed.find((c) => String(c.id) === chapterId);
    if (!chapterFile) continue;
    let chapterLines = lines.get(chapterId);
    if (!chapterLines) {
      chapterLines = readChapterLines(bookDir, chapterFile.file) || [];
      lines.set(chapterId, chapterLines);
    }
    const measured = castNamedInChapterText(store, chapterLines.join("\n"), { roster });
    row.castNamed = measured.named.length;
    if (measured.named.length === 0) chaptersNamingNobody.push(chapterId);
  }

  for (const chapter of listed) {
    const id = String(chapter.id);
    if (!chaptersWithRelations.has(id)) chaptersWithoutRelations.push(id);
  }

  const report = {
    ok: true,
    volume: vol,
    refusal: null,
    relations: relations.length,
    nonRelations: list.length - relations.length,
    filed,
    alreadyFiled,
    refused,
    namedLimits,
    unlevelled,
    chapters: [...byChapter.values()].sort((a, b) => String(a.chapter).localeCompare(String(b.chapter), "en")),
    chaptersWithoutRelations,
    chaptersNamingNobody,
    unstampedRelations,
    filedCount: filed.length,
    alreadyFiledCount: alreadyFiled.length,
    refusedCount: refused.length,
    namedLimitCount: namedLimits.length,
    unlevelledCount: unlevelled.length,
  };
  return report;
}

module.exports = {
  RELATION_ENTRY_TYPE,
  isPersonChannel,
  kindOfNamelessChannel,
  identityForName,
  castFormsNamedInLine,
  chapterLineCache,
  certaintyOfObservation,
  relationProposalFromEntry,
  fileRelationsFromExtraction,
};
