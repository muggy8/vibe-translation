/**
 * utils/reference-store/relations/file.js — the door that files one act of address, and the door that
 * closes the span it held *with the reason it closed*.
 *
 * Plan 07 slice 3. Two doors, one table, and neither of them decides who is speaking.
 *
 * ## What this layer is for
 *
 * Plan 07 §4.3: "one row per observed act of address, keyed on identities rather than on name strings".
 * The roster is 196 names for roughly 35 people, and every question the record asks about *people* is
 * today asked about *names* (plan 07 §1). A relation is the row that finally names the act — who addressed
 * whom, over what channel, in which written form, from which volume to which one, and how sure the record
 * is about the who.
 *
 * ## What this slice is, and what it deliberately is not
 *
 * The door **accepts a certainty level and checks that the record can show what that level promises**. It
 * does not compute the level. Deciding, from a line of a book, whether the name in it is the speaker or
 * the person being spoken to is plan 07 slice 4 — the extraction contract — and a door that computed it
 * would be a door that guessed who speaks. The one thing this repository has measured about that guess is
 * that the obvious rule is wrong every time it fires: 0 hits in volume 1, 10 in volume 2, **all ten of them
 * the addressee** (gotcha 121). So the ladder's vocabulary and its preconditions live here, and the
 * reading that fills them lives elsewhere.
 *
 * ## The two non-negotiable rules, and where each is enforced
 *
 * **1. A row is never edited after the volume that filed it published.** The filing door writes content
 * columns and nothing else; the closing door writes `RELATION_CLOSE_COLUMNS` and nothing else, through the
 * single `UPDATE` in `rows.js`, which is generated from that list. A close is asked of **the closing
 * volume's own handle**, so it lands in the copy that volume is working in and the earlier volume's file is
 * never opened for writing. `test/test-relations-table.js` builds two records the way `copyForwardStore`
 * does, closes a span in the later one, and hashes the earlier file.
 *
 * **2. A volume's translation reads that volume's record.** The filing door refuses to establish a
 * relation in a volume later than its own handle. The read (`rows.js`'s `relationsInRecord`) bounds every
 * answer by a volume and refuses to be asked past the record's own. A relation filed at volume 3 is
 * therefore absent from volume 1's file *and* invisible to a read of volume 3's record asked "as of
 * volume 2" — the same fact from both sides, and both are pinned.
 *
 * ## A span closes only with a reason, and the reason is a line the closing volume prints
 *
 * Plan 07 §0 decision 8: "`valid_to` without a reason is a quiet rewrite". The door requires all three of
 * §4.3's closing columns — **which volume, which chapter, which line** — and then checks the line against
 * that volume's own source text through `findQuoteEvidence`, the same half both revision doors use. A close
 * that names no chapter, or quotes a line the book does not print, is refused and stores nothing.
 *
 * **Why the quote is the reason, and why there is no free-text reason sentence.** The store already has a
 * 20-character reason floor (`MIN_LINK_WITHDRAWAL_REASON_CHARS`, `MIN_REOPEN_REASON_CHARS`) and this door
 * could have borrowed it. It does not, for one reason: those floors exist because a withdrawn link and a
 * reopened record have **nothing else to point at**, so the sentence is the whole record of the act. A span
 * close has a line of a book, and a line of a book is the only thing in this repository that can be
 * *checked*. A sentence beside it would be an unchecked assertion in a table whose entire point is measured
 * evidence (migration 3's own words: "the store's own rule (no claim without a checkable citation) has no
 * exemption"), and a minimum length is a guard on length, not on truth. The quote is the reason.
 *
 * ## Why `narrator` and `withheld` are a null party plus a named kind
 *
 * See `shapes.js`'s header at length. The short version: `addresser` is a foreign key to
 * `cast_identities(identity)`, and the narration is not an identity. Creating one would put the word for
 * the narration into a table the coverage rule counts, which is gotcha 121's defect reappearing in a new
 * table. So the row carries `addresser = NULL` and `addresser_kind`, and the door refuses a *name* that
 * means the narration before it resolves anything, through `narrator.js` — the same leaf `cast.js` uses to
 * refuse a roster entry keyed by it. `withheld` is a fact with instruction attached (plan 07 §0 decision
 * 9) and files normally; nothing in this layer or its reads treats it as missing data.
 *
 * ## The wall this door hits, and why it is named rather than climbed
 *
 * A relation is keyed on an identity, and an identity exists only where a link was filed. On the real
 * corpus the identity door links **88 of 196** roster entries into 34 groups, so **108 roster entries have
 * no identity to key a relation against**. A relation naming one of them is refused with
 * `relation-party-not-in-an-identity` and reported in the door's own `namedLimits`, and the door invents no
 * roster entry, no alias and no identity to make it fileable. That is the same wall plan 07 slice 2 hit with
 * `guideUnlinkedGroups`, it is plan 07 §6.8 (the owner's), and climbing it is a decision about what the
 * roster means rather than a decision about this door.
 *
 * ## What this door never does
 *
 * It files no claim, no candidate, no `facts` row, no `cast` entry, no `cast_alias`, no `cast_merges` row,
 * no identity, no identity link, no confirmation and no challenge. It marks nothing and seals nothing. It
 * adds **no verb to the store's handle** (the door is a function reached through the cover and the barrel,
 * the way `fileVolumeWrittenForms` is), **no finding kind** (the level table stays at 70), **no level**, no
 * freeze door, no declared artifact, no command, no setting, no npm script and no environment knob. It
 * makes **no model call** and reads no prompt. **Plan 07 slice 4 is now wired to it**:
 * `relations/contract.js` turns one `type: "relation"` entry from the chapter call that already runs into
 * one proposal, computes the certainty level from what the record can measure, and files it here — and
 * `rebuild/filing.js` is the one module outside this layer that calls it, which is the caller
 * `test/test-relations-table.js` pins by name and `test/test-relations-isolation.js` allows by name. Nothing
 * downstream reads the table yet: no renderer, no audit rule, no chapter block and no translator prompt asks
 * a relation a question, and §6.3 (whether the stage gets wired further, and who runs the identity door) is
 * still the owner's.
 *
 * @module utils/reference-store/relations/file
 */

const { EXTRACTION_SOURCE_STAGE, IDENTITY_LINK_SOURCES } = require("../schema");
const { refusal } = require("../refusals");
const { isNarratorAnswer, NARRATOR } = require("../narrator");
const { identityOfCastKey, castIdentityLinks } = require("../identity");
const { findQuoteEvidence } = require("../glossary-adapter/quote-evidence");
const {
  RELATION_CHANNELS,
  RELATION_CERTAINTY_LEVELS,
  ADDRESSER_KINDS,
  ADDRESSEE_KINDS,
  GUIDE_LINK_SOURCE,
  RELATION_CERTAINTY_PRECONDITIONS,
  channelAcceptsPartyKind,
  certaintyAcceptsPartyKind,
  partyKindsAllowedByChannel,
  partyKindsAllowedByCertainty,
  isRelationValue,
} = require("./shapes");
const {
  insertRelationRow,
  relationAlreadyFiled,
  relationById,
  closeRelationSpanRow,
} = require("./rows");
require("../../../types"); // JSDoc type definitions

/**
 * The identity numbers one roster name currently belongs to.
 *
 * Read through `identity/read.js`'s `identityOfCastKey`, which already excludes withdrawn links and
 * absorbed identity rows — "is this name inside an identity" has to mean "inside one that is still
 * standing", and a second implementation of that filter is a second answer to the question.
 *
 * @param {{db: Object}} store
 * @param {string} name - A roster key or written form, exactly as the record spells it.
 * @returns {{identities: Array<{identity: number, members: number, createdByVolume: number}>, inRoster: boolean}}
 */
function identitiesOfParty(store, name) {
  const key = String(name === undefined || name === null ? "" : name).trim();
  if (!key) return { identities: [], inRoster: false };
  const inRoster = Boolean(store.db.prepare("SELECT 1 FROM cast WHERE key = ?").get(key));
  return { identities: identityOfCastKey(store, key), inRoster };
}

/**
 * Whether an identity's membership is stated by the book's own pronunciation markup.
 *
 * This is the whole of what `reading-resolved` is allowed to rest on: the level says "this identity is
 * known only because the author guided these forms with one reading", and the only row in this record that
 * can show that is a live `cast_identity_links` row whose `stated_by` is the guide source. A group joined
 * only by the glossary's model-written prose does **not** satisfy it, and that distinction is the point of
 * the level.
 *
 * @param {{db: Object}} store
 * @param {number} identity
 * @returns {boolean}
 */
function identityStatedByGuide(store, identity) {
  const id = Number(identity);
  if (!Number.isInteger(id)) return false;
  return castIdentityLinks(store, { identity: id }).some((link) => link.statedBy === GUIDE_LINK_SOURCE);
}

/**
 * The chapters this record knows for one volume, as ids.
 *
 * A relation names a chapter, and a chapter the record has never registered is a name nothing can check.
 * The chapters arrive in the record from the volume's own extraction (`registerChaptersFromSource`) or from
 * the copy it was built from, which is what makes "this record knows chapter ch2" a fact about the book
 * rather than about a caller's string.
 *
 * @param {{db: Object, volume: number}} store
 * @param {number} volume
 * @returns {string[]}
 */
function registeredChapterIds(store, volume) {
  return store.db
    .prepare("SELECT chapter_id FROM chapters WHERE volume = ? ORDER BY ord, chapter_id")
    .all(Number(volume))
    .map((row) => String(row.chapter_id));
}

/**
 * Check a quoted line against the volume that established the relation, and cite the line it was found on.
 *
 * Reached through `store.resolveVolume`, which is the same door `facts` uses for the late-discovery case:
 * a volume may cite an **earlier** book, and never a later one.
 *
 * @param {{resolveVolume: Function, volumeDir: string, volume: number}} store
 * @param {number} volume - The volume whose text the quote has to be in.
 * @param {string} quote
 * @returns {{ok: boolean, citation: Object|null, error: string|null}}
 */
function citationForQuote(store, volume, quote) {
  const span = String(quote || "").trim();
  if (!span) return { ok: false, citation: null, error: "no line was offered" };
  const resolved = store.resolveVolume(Number(volume));
  if (resolved.error) return { ok: false, citation: null, error: resolved.error };
  const hit = findQuoteEvidence(resolved.volumeDir || store.volumeDir, resolved.chapters, Number(volume), span);
  if (!hit.evidence || !hit.evidence.length) return { ok: false, citation: null, error: `the line is not in volume ${volume}'s source text` };
  return { ok: true, citation: hit.evidence[0], error: null };
}

/**
 * File one act of address.
 *
 * @param {ReferenceStore} store - A handle that is not the extraction stage's.
 * @param {Object} proposal - `{addresser, addresserKind, addressee, channel, certainty, formUsed,
 *   formReading?, statement, chapter?, quote?, establishedVolume?}`.
 * @param {{volume?: number}} [opts] - `volume` defaults to the handle's own, and a proposal naming a later
 *   one is refused: a volume records what its own reading pass read.
 * @returns {{ok: boolean, filed: Object|null, already: Object|null, namedLimit: Object|null, refusal: ReferenceRefusal|null}}
 */
function fileRelation(store, proposal = {}, { volume } = {}) {
  const text = (value) => (typeof value === "string" ? value.trim() : "");
  const vol = Number(volume === undefined ? store.volume : volume);

  /**
   * The one shape every outcome that is not a filed relation returns.
   * @param {string} rule @param {string} because @param {string[]} [useInstead] @param {Object} [detail]
   */
  const refused = (rule, because, useInstead = [], detail = {}) => ({
    ok: false,
    filed: null,
    already: null,
    namedLimit: null,
    refusal: refusal({ verb: "file_relation", rule, because, useInstead, fix: detail.fix || "", detail }),
  });

  // Guard 1 — the extraction handle files candidates, and a relation is record content.
  if (store.scope.stage === EXTRACTION_SOURCE_STAGE) {
    return refused(
      "relation-needs-a-record-handle",
      `this handle writes as stage "${EXTRACTION_SOURCE_STAGE}". A relation is a conclusion the record ` +
        "stands behind, and the extraction pass files candidates it has not decided about.",
      ['openReferenceStore({ volume, stage: "rebuild" }) — the handle the claims are filed through']
    );
  }

  // Guard 2 — no forward look. A volume files what its own reading pass read.
  const established = Number(proposal.establishedVolume === undefined ? vol : proposal.establishedVolume);
  if (!Number.isInteger(established) || established < 1) {
    return refused("relation-volume-undecided", `"${proposal.establishedVolume}" is not a volume number`, ["name the volume whose text first showed the act"]);
  }
  if (established > vol) {
    return refused(
      "relations-cannot-look-forward",
      `this handle is volume ${vol}'s and the relation is established in volume ${established}. A volume may ` +
        "file an act its own text showed, or one an earlier volume's text showed and it has just noticed " +
        "(the late-discovery case `facts` already allows), and never one from a book it has not read.",
      [`file it from volume ${established}'s own record`, `or establish it at volume ${vol} or earlier`],
      { handleVolume: vol, establishedVolume: established }
    );
  }

  // Guard 3 — the closed vocabularies, each named in the refusal that fires.
  const channel = text(proposal.channel);
  const certainty = text(proposal.certainty);
  const addresserKind = text(proposal.addresserKind);
  if (!isRelationValue(RELATION_CHANNELS, channel)) {
    return refused("relation-channel-unknown", `"${proposal.channel}" is not one of the channels this record can hold (${RELATION_CHANNELS.join(", ")}).`, ["name one of those channels"], { channel: proposal.channel });
  }
  if (!isRelationValue(RELATION_CERTAINTY_LEVELS, certainty)) {
    return refused(
      "relation-certainty-unknown",
      `"${proposal.certainty}" is not a certainty level. Plan 07 §4.4: certainty is a ladder built from what ` +
        `the record can measure (${RELATION_CERTAINTY_LEVELS.join(", ")}), never a number a model reports about itself.`,
      ["name one of the six levels"],
      { certainty: proposal.certainty }
    );
  }
  if (!isRelationValue(ADDRESSER_KINDS, addresserKind)) {
    return refused("relation-addresser-kind-unknown", `"${proposal.addresserKind}" is not one of ${ADDRESSER_KINDS.join(", ")}.`, ["name the kind of party the record is claiming"], { addresserKind: proposal.addresserKind });
  }

  // Guard 4 — the channel and the party kind have to agree, and the pairing table decides, not a default.
  if (!channelAcceptsPartyKind(channel, addresserKind)) {
    return refused(
      "relation-channel-and-party-disagree",
      `a "${channel}" relation cannot have an addresser of kind "${addresserKind}". ${channel} allows ` +
        `${partyKindsAllowedByChannel(channel).join(" or ")}.`,
      ["change the channel or the kind — the table decides which one is wrong"],
      { channel, addresserKind }
    );
  }

  // Guard 5 — the certainty level and the party kind have to agree.
  if (!certaintyAcceptsPartyKind(certainty, addresserKind)) {
    return refused(
      "relation-certainty-and-party-disagree",
      `the certainty "${certainty}" claims a ${partyKindsAllowedByCertainty(certainty).join(" or ")} addresser, ` +
        `and this relation names "${addresserKind}". Plan 07 §4.4's \`${certainty}\` is ` +
        `${RELATION_CERTAINTY_PRECONDITIONS[certainty].because}.`,
      ["name the certainty the party actually supports"],
      { certainty, addresserKind }
    );
  }

  // Guard 6 — the word for the narration is never a party name, and never becomes a roster entry.
  const addresserName = text(proposal.addresser);
  const addresseeName = text(proposal.addressee);
  for (const [side, name] of [["addresser", addresserName], ["addressee", addresseeName]]) {
    if (name && isNarratorAnswer(name)) {
      return refused(
        "narrator-is-not-a-party",
        `"${name}" is the word for the narration, not a name this book gives anybody. Filed as a party it ` +
          "would be resolved against the roster, and a roster entry keyed by it is refused by `cast.js` for " +
          "the same reason: the coverage rule counts rows in `cast`, so it would become a character the " +
          "reference is required to cover.",
        [`file the relation with addresserKind: "narrator" and no addresser, which is where the narration already lives (${NARRATOR})`],
        { side, name }
      );
    }
  }

  // Guard 7 — a name and a kind cannot both be offered for a side that is not claiming a person.
  //
  // Silently dropping the name would be the worst available answer: the caller said who spoke, the row
  // would say the record does not know, and nothing would report the difference. `unknown` and `withheld`
  // are claims about the *absence* of a party, so a name beside one of them is a contradiction the door
  // has to name.
  if (addresserKind !== "identity" && addresserName) {
    return refused(
      "relation-names-a-party-it-is-not-claiming",
      `the addresser kind is "${addresserKind}" and an addresser name ("${addresserName}") was also given. ` +
        `"${addresserKind}" is a claim that this record does not name a person, so the name cannot be filed ` +
        "and it is not quietly thrown away either.",
      ['drop the name and file the gap', 'or use addresserKind: "identity", which resolves the name against an identity']
      , { addresserKind, addresser: addresserName }
    );
  }

  // Guard 8 — a party named as a person must be an identity this record holds. Nothing is invented here.
  /** @type {number|null} */
  let addresserId = null;
  /** @type {number|null} */
  let addresseeId = null;
  /** @type {string|null} */
  let addresseeKind = "none";

  if (addresserKind === "identity") {
    if (!addresserName) {
      return refused("relation-names-no-addresser", "the addresser kind is \"identity\" and no name was given, so there is nobody to resolve.", ["name the roster entry, or name the kind the record is actually claiming"]);
    }
    const who = identitiesOfParty(store, addresserName);
    if (who.identities.length === 0) {
      return {
        ok: false,
        filed: null,
        already: null,
        namedLimit: {
          side: "addresser",
          name: addresserName,
          inRoster: who.inRoster,
          rule: "relation-party-not-in-an-identity",
          because: who.inRoster
            ? `${addresserName} is a roster entry this record publishes, but no identity link still standing puts it in a group, and a relation is keyed on an identity.`
            : `${addresserName} is not a roster entry this record publishes and no identity holds it.`,
        },
        refusal: refusal({
          verb: "file_relation",
          rule: "relation-party-not-in-an-identity",
          because:
            `the addresser "${addresserName}" has no identity in this record (${who.inRoster ? "it is on the roster, unlinked" : "it is not on the roster"}). ` +
            "Plan 07 §6.8 is the open decision about what to do about these; this door names the limit and " +
            "invents no roster entry, no alias and no identity to get past it.",
          useInstead: ["file the identity link first (fileIdentityLinks)", "name a party an identity already groups"],
          detail: { side: "addresser", name: addresserName, inRoster: who.inRoster },
        }),
      };
    }
    if (who.identities.length > 1) {
      return refused(
        "relation-party-is-in-two-identities",
        `"${addresserName}" is currently inside ${who.identities.length} identities (${who.identities.map((i) => i.identity).join(", ")}). ` +
          "The door does not pick one by id: gotcha 117's rule is that an ambiguity is reported, never settled by table order.",
        ["withdraw the link that is wrong (withdrawIdentityLink)"],
        { name: addresserName, identities: who.identities.map((i) => i.identity) }
      );
    }
    addresserId = who.identities[0].identity;
  }

  if (addresseeName) {
    const who = identitiesOfParty(store, addresseeName);
    if (who.identities.length === 0) {
      return {
        ok: false,
        filed: null,
        already: null,
        namedLimit: {
          side: "addressee",
          name: addresseeName,
          inRoster: who.inRoster,
          rule: "relation-party-not-in-an-identity",
          because: who.inRoster
            ? `${addresseeName} is a roster entry this record publishes, but no identity link still standing puts it in a group.`
            : `${addresseeName} is not a roster entry this record publishes and no identity holds it.`,
        },
        refusal: refusal({
          verb: "file_relation",
          rule: "relation-party-not-in-an-identity",
          because:
            `the addressee "${addresseeName}" has no identity in this record (${who.inRoster ? "it is on the roster, unlinked" : "it is not on the roster"}). ` +
            "Nothing is invented to make it fileable.",
          useInstead: ["file the identity link first (fileIdentityLinks)", "name a party an identity already groups"],
          detail: { side: "addressee", name: addresseeName, inRoster: who.inRoster },
        }),
      };
    }
    if (who.identities.length > 1) {
      return refused(
        "relation-party-is-in-two-identities",
        `"${addresseeName}" is currently inside ${who.identities.length} identities (${who.identities.map((i) => i.identity).join(", ")}), and the door does not pick one by id.`,
        ["withdraw the link that is wrong (withdrawIdentityLink)"],
        { name: addresseeName, identities: who.identities.map((i) => i.identity) }
      );
    }
    addresseeId = who.identities[0].identity;
    addresseeKind = "identity";
  }

  // Guard 9 — self-address is the channel where both sides are the same person, and that is checkable.
  if (channel === "self-address") {
    if (addresseeId === null) addresseeId = addresserId;
    if (addresseeId !== addresserId) {
      return refused(
        "relation-self-address-has-two-parties",
        `a self-address whose addressee (identity ${addresseeId ?? "none"}) is not its addresser (identity ${addresserId ?? "none"}) is not a self-address.`,
        ["name the same party on both sides", "or use the channel that fits the act you observed"],
        { addresser: addresserId, addressee: addresseeId }
      );
    }
    if (addresseeId !== null) addresseeKind = "identity";
  }

  // Guard 10 — the form and the statement are the row's own content, and both are required.
  const formUsed = text(proposal.formUsed);
  if (!formUsed) {
    return refused("relation-names-no-form", "the relation names no written form, so it is an assertion about an act nobody can point at in the book.", ["name the form as the book prints it"]);
  }
  const statement = text(proposal.statement);
  if (!statement) {
    return refused(
      "relation-states-nothing",
      "the relation carries no statement. Plan 07 §4.8: what the record asserts is written in the source language, and an empty cell asserts nothing.",
      ["write what the record asserts, in the language of the book"]
    );
  }
  const formReading = text(proposal.formReading) || null;

  // Guard 11 — the chapter has to be one this record knows for the volume that showed the act.
  const chapter = text(proposal.chapter) || null;
  if (chapter !== null) {
    const known = registeredChapterIds(store, established);
    if (!known.includes(chapter)) {
      return refused(
        "relation-chapter-not-in-this-record",
        `volume ${established}'s record knows ${known.length} chapter(s) (${known.slice(0, 8).join(", ")}${known.length > 8 ? ", …" : ""}) and "${chapter}" is not one of them.`,
        ["name a chapter the volume's own extraction registered", "or name no chapter and let the row say it has none"],
        { chapter, establishedVolume: established, known }
      );
    }
  }

  // Guard 12 — an offered line has to be a line that volume prints, and the citation is the found one.
  /** @type {Array<Object>} */
  const evidence = [];
  const offeredQuote = text(proposal.quote);
  if (offeredQuote) {
    const found = citationForQuote(store, established, offeredQuote);
    if (!found.ok) {
      return refused(
        "relation-quote-not-in-this-volume",
        `the line this relation quoted does not verify against volume ${established}'s source text (${found.error}), so the act is not backed by the book it claims to come from.`,
        ["quote a line that volume actually prints", "or name no line — the softer certainty levels do not require one"],
        { quote: offeredQuote, establishedVolume: established }
      );
    }
    evidence.push(found.citation);
  }

  // Guard 13 — the ladder's own preconditions, as far as the record can show them.
  const preconditions = RELATION_CERTAINTY_PRECONDITIONS[certainty];
  if (preconditions.requiresQuote && !evidence.length) {
    return refused(
      "relation-certainty-has-no-line-to-point-at",
      `the certainty "${certainty}" promises a line, and this relation has none: ${preconditions.because}.`,
      ["quote a line this volume prints", `or name a certainty that does not promise one (${RELATION_CERTAINTY_LEVELS.filter((level) => !RELATION_CERTAINTY_PRECONDITIONS[level].requiresQuote).join(", ")})`],
      { certainty }
    );
  }
  if (preconditions.requiresAddressee && addresseeId === null) {
    return refused(
      "relation-certainty-names-no-addressee",
      `the certainty "${certainty}" is about the person being spoken to, and this relation names none: ${preconditions.because}.`,
      ["name the addressee", `or name a certainty that does not require one (${RELATION_CERTAINTY_LEVELS.filter((level) => !RELATION_CERTAINTY_PRECONDITIONS[level].requiresAddressee).join(", ")})`],
      { certainty }
    );
  }
  if (preconditions.requiresGuideStatedIdentity && !identityStatedByGuide(store, addresserId)) {
    return refused(
      "relation-certainty-has-no-guide-stated-identity",
      `the certainty "${certainty}" says the identity is known only because the author's guided reading says so, and identity ${addresserId} has no live link stated by the book's own markup (${preconditions.because}). A group joined only by the glossary's prose is not this level.`,
      ["file the guide link first (fileIdentityLinks)", "or name `measured` / `addressee-risk`, which rest on the line rather than the markup"],
      { certainty, identity: addresserId }
    );
  }

  // Guard 14 — one row per (book, channel, form, addresser, addressee).
  const key = { establishedVolume: established, channel, formUsed, addresser: addresserId, addressee: addresseeId };
  const already = relationAlreadyFiled(store, key);
  if (already) return { ok: true, filed: null, already, namedLimit: null, refusal: null };

  const note =
    `filed by volume ${vol} stage "${store.scope.stage}" from volume ${established}'s text` +
    (chapter ? ` in chapter ${chapter}` : " with no chapter named") +
    (evidence.length ? " — the line it quotes was found in that volume" : " — no line was offered, so the certainty level is the whole guard") +
    (addresserId === null ? `; the addresser is ${addresserKind}, which has no identity and no roster entry` : `; addresser identity ${addresserId}`);

  const relationId = insertRelationRow(store, {
    addresser: addresserId,
    addressee: addresseeId,
    addresserKind,
    addresseeKind,
    channel,
    certainty,
    formUsed,
    formReading,
    statement,
    evidence,
    establishedVolume: established,
    validFromVolume: established,
    validFromChapter: chapter,
    filedByVolume: vol,
    filedByStage: store.scope.stage,
    filedAt: new Date().toISOString(),
    note,
  });

  return { ok: true, filed: relationById(store, relationId), already: null, namedLimit: null, refusal: null };
}

/**
 * Close the span one relation held, **in the copy the closing volume is working in**.
 *
 * The row is found by the same five columns the unique index is built on, so "which row does this
 * development close?" and "has this relation already been filed" are one question rather than two.
 *
 * @param {ReferenceStore} store - A handle on the volume doing the closing.
 * @param {Object} close - `{establishedVolume, channel, formUsed, addresser, addressee, closedByChapter, closedByQuote, closedByVolume?}`
 *   `addresser` / `addressee` are identity numbers or null, exactly as the row stores them.
 * @param {{volume?: number}} [opts] - `closedByVolume` defaults to the handle's own volume, and a different one is refused.
 * @returns {{ok: boolean, closed: Object|null, alreadyClosed: Object|null, columns: string[], refusal: ReferenceRefusal|null}}
 */
function closeRelationSpan(store, close = {}, { volume } = {}) {
  const text = (value) => (typeof value === "string" ? value.trim() : "");
  const closingVolume = Number(close.closedByVolume === undefined ? (volume === undefined ? store.volume : volume) : close.closedByVolume);

  /**
   * @param {string} rule @param {string} because @param {string[]} [useInstead] @param {Object} [detail]
   */
  const refused = (rule, because, useInstead = [], detail = {}) => ({
    ok: false,
    closed: null,
    alreadyClosed: null,
    columns: [],
    refusal: refusal({ verb: "close_relation_span", rule, because, useInstead, fix: detail.fix || "", detail }),
  });

  if (store.scope.stage === EXTRACTION_SOURCE_STAGE) {
    return refused(
      "relation-needs-a-record-handle",
      `this handle writes as stage "${EXTRACTION_SOURCE_STAGE}". Closing a span is an act on the record.`
    );
  }

  // Guard 1 — the close happens in the closing volume's own copy, or not at all.
  if (closingVolume !== Number(store.volume)) {
    return refused(
      "relation-close-is-not-in-its-own-copy",
      `the close names volume ${closingVolume} and this handle is volume ${store.volume}'s. Plan 07 §4.3: a span ` +
        "closes in the copy the later volume is working in, and the earlier volume's snapshot never changes. " +
        "A door that could close a span from any handle is the forward leak this rule exists to stop.",
      [`open volume ${closingVolume}'s own record and close it there`],
      { handleVolume: Number(store.volume), closedByVolume: closingVolume }
    );
  }

  // Guard 2 — the reason is three columns, and all three are required.
  const closedByChapter = text(close.closedByChapter);
  const closedByQuote = text(close.closedByQuote);
  if (!closedByChapter || !closedByQuote) {
    return refused(
      "relation-span-closes-without-a-reason",
      `a span close has to name the chapter it was seen in and the line that showed it, and this one named ${closedByChapter ? "a chapter but no line" : closedByQuote ? "a line but no chapter" : "neither"}. Plan 07 §0 decision 8: \`valid_to\` without a reason is a quiet rewrite.`,
      ["name the closing volume's chapter and quote a line that volume's own book prints"],
      { closedByVolume: closingVolume }
    );
  }

  // Guard 3 — the row exists, and the development is not earlier than the act it closes.
  const key = {
    establishedVolume: close.establishedVolume,
    channel: text(close.channel),
    formUsed: text(close.formUsed),
    addresser: close.addresser,
    addressee: close.addressee,
  };
  const establishedVolume = Number(key.establishedVolume);
  if (!Number.isInteger(establishedVolume) || establishedVolume < 1) {
    return refused("relation-volume-undecided", `"${close.establishedVolume}" is not a volume number`, ["name the volume the relation was established in"]);
  }
  if (establishedVolume > closingVolume) {
    return refused(
      "relation-closes-before-it-opens",
      `the relation was established in volume ${establishedVolume} and the close is volume ${closingVolume}'s. A span cannot end in a book written before the act it covers.`,
      ["close it from the later volume's record"],
      { establishedVolume, closingVolume }
    );
  }
  const row = relationAlreadyFiled(store, key);
  if (!row) {
    return refused(
      "relation-row-not-found",
      `this record holds no relation filed as volume ${establishedVolume}'s ${key.channel} act using "${key.formUsed}" between the parties named. A close names a row; it does not create one.`,
      ["file the relation first (fileRelation)", "or name the row the development closes"],
      { key }
    );
  }

  // Guard 4 — the closing chapter is one this record knows, and the closing line is in this volume's book.
  const known = registeredChapterIds(store, closingVolume);
  if (!known.includes(closedByChapter)) {
    return refused(
      "relation-chapter-not-in-this-record",
      `volume ${closingVolume}'s record knows ${known.length} chapter(s) (${known.slice(0, 8).join(", ")}${known.length > 8 ? ", …" : ""}) and "${closedByChapter}" is not one of them.`,
      ["name a chapter this volume's own extraction registered"],
      { chapter: closedByChapter, known }
    );
  }
  const found = citationForQuote(store, closingVolume, closedByQuote);
  if (!found.ok) {
    return refused(
      "relation-close-quote-not-in-this-volume",
      `the line this close quoted does not verify against volume ${closingVolume}'s source text (${found.error}). The reason a span closed is a line the closing volume prints, and this one is not.`,
      ["quote a line volume ${closingVolume} actually prints"],
      { quote: closedByQuote, closingVolume }
    );
  }

  // Guard 5 — one close per span (the row-level check is in `rows.js`).
  const result = closeRelationSpanRow(store, row.relationId, {
    validToVolume: closingVolume,
    validToChapter: closedByChapter,
    closedByVolume: closingVolume,
    closedByChapter,
    closedByQuote,
    closedByLine: Number.isFinite(Number(found.citation.line)) ? Number(found.citation.line) : null,
    closedAt: new Date().toISOString(),
  });
  if (!result.ok) return { ok: false, closed: null, alreadyClosed: null, columns: result.columns, refusal: result.refusal };
  if (result.changed === 0) {
    const now = relationById(store, row.relationId);
    return { ok: true, closed: null, alreadyClosed: now, columns: result.columns, refusal: null };
  }
  return { ok: true, closed: relationById(store, row.relationId), alreadyClosed: null, columns: result.columns, refusal: null };
}

/**
 * File every relation one volume's reading produced, and report the rest rather than throwing on it.
 *
 * The named limits are returned in their own array, because plan 07 §6.8's whole point is that the loss is
 * **on the record and re-measurable**: a door that buried 108 unkeyable names inside a `refused` list would
 * be a door that made the decision harder to see, not easier.
 *
 * @param {ReferenceStore} store
 * @param {Array<Object>} proposals
 * @param {{volume?: number}} [opts]
 * @returns {{ok: boolean, volume: number, filed: Array<Object>, alreadyFiled: Array<Object>, refused: Array<Object>, namedLimits: Array<Object>, filedCount: number, refusedCount: number}}
 */
function fileRelations(store, proposals, { volume } = {}) {
  const vol = Number(volume === undefined ? store.volume : volume);
  /** @type {Array<Object>} */
  const filed = [];
  /** @type {Array<Object>} */
  const alreadyFiled = [];
  /** @type {Array<Object>} */
  const refused = [];
  /** @type {Array<Object>} */
  const namedLimits = [];
  for (const proposal of Array.isArray(proposals) ? proposals : []) {
    const result = fileRelation(store, proposal, { volume: vol });
    if (result.filed) filed.push(result.filed);
    else if (result.already) alreadyFiled.push({ relationId: result.already.relationId, formUsed: result.already.formUsed, channel: result.already.channel });
    else if (result.namedLimit) namedLimits.push(result.namedLimit);
    else if (result.refusal) refused.push({ rule: result.refusal.rule, because: result.refusal.because, detail: result.refusal.detail });
  }
  return {
    ok: true,
    volume: vol,
    filed,
    alreadyFiled,
    refused,
    namedLimits,
    filedCount: filed.length,
    refusedCount: refused.length,
  };
}

module.exports = {
  identitiesOfParty,
  identityStatedByGuide,
  registeredChapterIds,
  citationForQuote,
  fileRelation,
  closeRelationSpan,
  fileRelations,
};
