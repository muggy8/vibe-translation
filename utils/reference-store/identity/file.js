/**
 * utils/reference-store/identity/file.js — the door that fills the identity tables, and the only door
 * that empties one link.
 *
 * **What this door does is add a fact about names. It never moves one.** No `cast` row changes its key,
 * its `merged_into`, its display or its aliases. No `facts` row changes its `key`. No `cast_merges` row
 * is written. A claim filed for 三色院菫子 lands under 三色院菫子 whether or not an identity says it is
 * the same person as パンジー, because the two doors that decide where a claim lands —
 * `name-resolution.js`'s `resolveExtractionName` and `presence.js`'s name matching — do not read these
 * tables, and `test/test-identity-table-isolation.js` is what keeps that from drifting. That is not a
 * side effect of this design, it is the design: the account owner's decision (plan 06 §10.8) is that the
 * roster gets an identity **by reference rather than by merging**, because a merge is the one operation
 * in this folder that can make a character's claims vanish from a query, it is irreversible on a sealed
 * record, and the narrowest-looking rule for reading the prose that states most of these links was
 * measured producing **5 pairs, all 5 wrong**.
 *
 * ## Where the guide half reads from, since plan 07 slice 2
 *
 * It used to open the volume folder and read `<base>-ruby-guides.json`. **It does not read files any
 * more.** The forms it groups are the record's own written-form rows, reached through
 * `written-forms/rows.js`'s `candidateGroupsInRecord` — the shipped grouping read, not a second grouping
 * implementation — and the question "which of those groups states a character" is answered by
 * `written-forms/shapes.js`'s `identityBearingGroups`, plan 07 §2.9's rule, measured at 18 of the 97
 * candidate groups with zero false positives. The door therefore reads **the record it is filing into**
 * and nothing else: it cannot open a volume folder, it cannot open a later volume's book, and the forms
 * it groups are the ones copy-forward carried to it. `written-forms/file.js` is the only door in this
 * store that reads a harvest file, and the direction of the require is one-way — `identity/` reaches
 * `written-forms/`, never the reverse (`test/test-written-forms.js` pins that the written-forms layer
 * requires nothing under `identity/`).
 *
 * **Which groups produce links, and which produce a named limit.** §2.9's rule selects the group; the
 * link table's `a` / `b` are foreign keys to `cast(key)` with `PRAGMA foreign_keys` ON, so a link can
 * only join two names the record publishes. A selected group whose roster holds exactly one name —
 * すみれこ ← 菫子 / 董子, なでしこ ← 撫子 / 赤井撫子, サンちやん, ツバキ, ミント on the real corpus — is
 * reported in `guideUnlinkedGroups` with the reason, and files nothing. Making those fileable means
 * putting a name the glossary never entered into the roster, which changes what every later volume's
 * coverage guard counts; that is a decision, and it is written up in
 * `/tmp/opencode/plan07-slice2-questions.md` rather than taken here.
 *
 * **No seal guard, and that is deliberate.** `castAlias` refuses to merge on a sealed record because a
 * merge re-points rows that record already published. Filing a link re-points nothing: the published
 * artifacts are rendered by doors that do not read these tables. So a link can be filed into a record
 * that is sealed without rewriting anything the seal protects. (Which act files it, and when, is the open
 * decision plan 07 §6.3 and plan 06 §10.9; nothing in a run calls this door yet.)
 *
 * **A link is withdrawn, never deleted.** `withdrawn_at` / `withdrawn_reason`, the same shape
 * `cast.merged_into` and `challenges.outcome` use. "Removable" and "traceable to its source" are both
 * requirements, and a deleted row answers only the first.
 *
 * @module utils/reference-store/identity/file
 */

const { refusal } = require("../refusals");
const { IDENTITY_LINK_SOURCES } = require("../schema");
const { candidateGroupsInRecord, writtenFormsInRecord } = require("../written-forms/rows");
const { splitGroupsByRoster } = require("../written-forms/shapes");
const { guideLinksFromGroups, guideNearMisses, guideSoloRosterPairs, characterRowsInRecord, characterRowStatedLinks } = require("./sources");
require("../../../types"); // JSDoc type definitions

/**
 * How long a reason for withdrawing a link has to be.
 *
 * A withdrawal is the record saying "this stated link is wrong, and here is why". A reason short enough
 * to be a word answers nothing a later reader could act on, and the store already draws this line
 * elsewhere — `MIN_REOPEN_REASON_CHARS` in `reopen.js` is 20 for the same argument. It is a constant
 * with no environment knob (AGENTS.md rule 3): a withdrawal you can explain in four characters is a
 * withdrawal you can do without explaining.
 *
 * @type {number}
 */
const MIN_LINK_WITHDRAWAL_REASON_CHARS = 20;

/**
 * The roster this record holds, as a set.
 *
 * A link is only filed between entries **this record** holds — the link table's `a` / `b` are foreign keys
 * to `cast(key)` and `PRAGMA foreign_keys` is ON, so this is not only a rule, it is what the schema allows.
 * It is also what keeps the guide's unanswered question — which of the names is the character — out of the
 * record: the door never needs the answer, because it files a group.
 *
 * @param {{db: Object}} ctx
 * @returns {Set<string>}
 */
function castKeysInRecord(ctx) {
  return new Set(ctx.db.prepare("SELECT key FROM cast").all().map((row) => row.key));
}

/**
 * The live identities one roster name currently belongs to.
 *
 * Withdrawn links are excluded: "is this name linked" has to mean "linked by something still standing".
 *
 * @param {{db: Object}} ctx
 * @param {string} key
 * @returns {number[]}
 */
function liveIdentitiesOf(ctx, key) {
  return ctx.db
    .prepare(
      "SELECT DISTINCT identity FROM cast_identity_links WHERE withdrawn_at IS NULL AND (a = ? OR b = ?) ORDER BY identity"
    )
    .all(key, key)
    .map((row) => Number(row.identity));
}

/**
 * Recompute one identity's stored member and link counts from the links still standing.
 *
 * Stored rather than derived at read time for the same reason `cast_presence` stores `chapters` and
 * `matches`: a reader of the group should see how big it is without knowing the detail table exists.
 *
 * @param {{db: Object}} ctx
 * @param {number} identity
 * @returns {{members: number, links: number}}
 */
function recountIdentity(ctx, identity) {
  const links = ctx.db
    .prepare("SELECT COUNT(*) AS n FROM cast_identity_links WHERE identity = ? AND withdrawn_at IS NULL")
    .get(Number(identity)).n;
  const members = ctx.db
    .prepare(
      "SELECT COUNT(*) AS n FROM (" +
        "SELECT a AS key FROM cast_identity_links WHERE identity = ? AND withdrawn_at IS NULL " +
        "UNION SELECT b AS key FROM cast_identity_links WHERE identity = ? AND withdrawn_at IS NULL)"
    )
    .get(Number(identity), Number(identity)).n;
  ctx.db.prepare("UPDATE cast_identities SET members = ?, links = ? WHERE identity = ?").run(members, links, Number(identity));
  return { members, links };
}

/**
 * Open a new identity row.
 *
 * @param {{db: Object}} ctx
 * @param {number} volume - The volume whose sources created it.
 * @param {string} note - What created it, in one line.
 * @returns {number} The new identity id.
 */
function createIdentity(ctx, volume, note) {
  const info = ctx.db
    .prepare("INSERT INTO cast_identities (created_by_volume, created_at, members, links, note) VALUES (?,?,0,0,?)")
    .run(Number(volume), new Date().toISOString(), String(note || ""));
  return Number(info.lastInsertRowid);
}

/**
 * Fold one identity row into another, because a newly stated link connects them.
 *
 * This is **not** a cast merge and it moves no claim. It re-points `cast_identity_links` rows — rows
 * this door wrote, describing names — and the absorbed identity row stays, marked `absorbed_into`, so the
 * history is readable. `cast` and `facts` are not touched, and `cast_merges` is not written.
 *
 * @param {{db: Object}} ctx
 * @param {number} survivor - The identity that stays.
 * @param {number} absorbed - The identity folded in.
 * @param {string} reason - The link that made them one.
 * @returns {void}
 */
function absorbIdentity(ctx, survivor, absorbed, reason) {
  ctx.db.prepare("UPDATE cast_identity_links SET identity = ? WHERE identity = ?").run(Number(survivor), Number(absorbed));
  ctx.db
    .prepare("UPDATE cast_identities SET absorbed_into = ?, absorbed_reason = ? WHERE identity = ?")
    .run(Number(survivor), String(reason), Number(absorbed));
}

/**
 * File every link this record's sources state.
 *
 * Two sources, both read as they are, neither of them a guess:
 *
 *   1. the record's own written-form rows, folded into candidate groups by the shipped read
 *      (`written-forms/rows.js`'s `candidateGroupsInRecord`) and filtered by plan 07 §2.9's roster-or-reading
 *      rule (`written-forms/shapes.js`'s `identityBearingGroups`, reached here through `splitGroupsByRoster`)
 *      — the book's own markup, transcribed by the door that files it;
 *   2. the record's own published Characters rows, read through the pinned shape table in `shapes.js`.
 *
 * A link whose two names are already in different identities **joins those identities** (see
 * `absorbIdentity`). A link already filed by the same source in the same volume is counted, not
 * duplicated, which is what makes a second pass over the same record cost nothing.
 *
 * **It reads the record, not the books.** The grouping is bounded at the volume being filed, so it can
 * only ever see that volume's rows and the ones copy-forward carried to it — the same no-forward rule
 * `written-forms/file.js` enforces at filing, enforced here at reading. Asking this door for a volume
 * later than the record's own is refused before anything is read.
 *
 * @param {Object} ctx - The store context.
 * @param {Object} [opts]
 * @param {number} [opts.volume] - The volume whose sources are being read. Defaults to this store's volume.
 * @returns {{ok: boolean, volume: number, identitiesCreated: number, identitiesAbsorbed: number, linksFiled: number, linksAlreadyFiled: number, linksWithdrawn: number, guideRows: number, guideCandidateGroups: number, guideIdentityBearingGroups: number, guideIdentityBearingRows: number, guideIdentityBearingOccurrences: number, guideUnselectedGroups: number, guideLinks: number, guideNamesLinked: number, guideUnlinkedGroups: Array<Object>, guideNearMisses: Array<Object>, guideAmbiguousReadings: Array<Object>, guideSoloPairs: Array<Object>, characterRows: number, characterRowLinks: number, proseShapesExcluded: Array<Object>, identities: Array<Object>, refusal: ReferenceRefusal|null}}
 */
function fileIdentityLinks(ctx, { volume } = {}) {
  const vol = Number(volume === undefined ? ctx.volume : volume);
  const empty = {
    identitiesCreated: 0,
    identitiesAbsorbed: 0,
    linksFiled: 0,
    linksAlreadyFiled: 0,
    linksWithdrawn: 0,
    guideRows: 0,
    guideCandidateGroups: 0,
    guideIdentityBearingGroups: 0,
    guideIdentityBearingRows: 0,
    guideIdentityBearingOccurrences: 0,
    guideUnselectedGroups: 0,
    guideLinks: 0,
    guideNamesLinked: 0,
    guideUnlinkedGroups: [],
    guideNearMisses: [],
    guideAmbiguousReadings: [],
    guideSoloPairs: [],
    characterRows: 0,
    characterRowLinks: 0,
    proseShapesExcluded: [],
    identities: [],
  };
  if (!Number.isInteger(vol) || vol < 1) {
    return {
      ok: false,
      volume: vol,
      ...empty,
      refusal: refusal({
        verb: "file_identity_links",
        rule: "identity-volume-undecided",
        because: `"${volume}" is not a volume number, and a link has to be filed under the volume whose source stated it.`,
        fix: "fileIdentityLinks(ctx, { volume: 3 })",
      }),
    };
  }
  // The no-forward rule, asked before anything is read. The guide half groups the written forms this record
  // carries, and a record carries its own volume and the volumes before it (plan 07 §4.4). A volume later
  // than the record's own has not been read by it, so its forms are not here to group.
  if (Number.isInteger(ctx.volume) && vol > Number(ctx.volume)) {
    return {
      ok: false,
      volume: vol,
      ...empty,
      refusal: refusal({
        verb: "file_identity_links",
        rule: "identity-cannot-look-forward",
        because:
          `this record is volume ${ctx.volume}, and volume ${vol}'s book has not been read by it. The guide half of this door ` +
          "groups the written forms this record carries, and a record carries its own volume and the ones before it " +
          "(plan 07 §4.4): filing a link from a later volume's forms would change what an earlier volume already published.",
        fix: `open the record for volume ${vol} and file its links there, or ask this record for a volume up to ${ctx.volume}.`,
        detail: { recordVolume: Number(ctx.volume), askedVolume: vol },
      }),
    };
  }

  const castKeys = castKeysInRecord(ctx);

  // ── The guide half: the record's own written forms, grouped by the shipped read. ─────────────────
  const built = candidateGroupsInRecord(ctx, { upToVolume: vol });
  const split = splitGroupsByRoster(built.groups, castKeys);
  const guide = guideLinksFromGroups(split.identityBearing, castKeys);
  // Near misses are asked over EVERY candidate group, not only the selected ones: ジヨーロ is not selected
  // by §2.9's rule and plan 07 §2.9 still names it. Reporting costs nothing and filing does.
  const misses = guideNearMisses(built.groups, castKeys);
  // The shape §2.9's group rule structurally cannot see: one written form guided into another roster name.
  // Reported, never filed — widening the candidate set is plan 07 §2.2's decision, not this door's.
  const soloPairs = guideSoloRosterPairs(
    writtenFormsInRecord(ctx).filter((row) => Number(row.volume) <= vol),
    castKeys,
    new Set(built.groups.map((group) => group.reading))
  );

  const rows = characterRowsInRecord(ctx);
  const prose = characterRowStatedLinks(rows, castKeys);

  /** @type {Array<{a: string, b: string, statedBy: string, statedByVolume: number, sourceFile: string, reason: string}>} */
  const candidates = [];
  for (const link of guide.links) {
    candidates.push({
      a: link.a,
      b: link.b,
      statedBy: "ruby-guide",
      statedByVolume: Number.isInteger(link.volume) ? link.volume : vol,
      sourceFile: link.sourceFile,
      reason: link.reason,
    });
  }
  for (const link of prose.links) {
    candidates.push({
      a: link.a,
      b: link.b,
      statedBy: "glossary-character-row",
      statedByVolume: Number.isInteger(link.volume) ? link.volume : vol,
      sourceFile: `series.db facts(${link.factId})`,
      reason: link.reason,
    });
  }

  let identitiesCreated = 0;
  let identitiesAbsorbed = 0;
  let linksFiled = 0;
  let linksAlreadyFiled = 0;
  /** @type {Set<number>} */
  const touched = new Set();

  const findLink = ctx.db.prepare(
    "SELECT link_id, identity FROM cast_identity_links WHERE a = ? AND b = ? AND stated_by = ? AND stated_by_volume = ?"
  );
  const insertLink = ctx.db.prepare(
    "INSERT INTO cast_identity_links (identity, a, b, stated_by, stated_by_volume, source_file, reason, added_at) VALUES (?,?,?,?,?,?,?,?)"
  );

  ctx.db.exec("BEGIN");
  try {
    for (const candidate of candidates) {
      if (!IDENTITY_LINK_SOURCES.includes(candidate.statedBy)) {
        throw new Error(
          `[reference-store] fileIdentityLinks: "${candidate.statedBy}" is not a source this store lets state a link ` +
            `(${IDENTITY_LINK_SOURCES.join(", ")}). Add it to IDENTITY_LINK_SOURCES with the measurement that justifies it.`
        );
      }
      const existing = findLink.get(candidate.a, candidate.b, candidate.statedBy, candidate.statedByVolume);
      if (existing) {
        linksAlreadyFiled += 1;
        touched.add(Number(existing.identity));
        continue;
      }

      const idsA = liveIdentitiesOf(ctx, candidate.a);
      const idsB = liveIdentitiesOf(ctx, candidate.b);
      const ids = [...new Set([...idsA, ...idsB])];
      let identity;
      if (ids.length === 0) {
        identity = createIdentity(ctx, vol, `stated by ${candidate.statedBy}: ${candidate.a} / ${candidate.b}`);
        identitiesCreated += 1;
      } else {
        identity = ids[0];
        for (const other of ids.slice(1)) {
          absorbIdentity(ctx, identity, other, `the link ${candidate.a} / ${candidate.b} stated by ${candidate.statedBy} connects them`);
          identitiesAbsorbed += 1;
          touched.add(other);
        }
      }

      insertLink.run(
        identity,
        candidate.a,
        candidate.b,
        candidate.statedBy,
        candidate.statedByVolume,
        candidate.sourceFile,
        candidate.reason,
        new Date().toISOString()
      );
      linksFiled += 1;
      touched.add(identity);
    }
    for (const identity of touched) recountIdentity(ctx, identity);
    ctx.db.exec("COMMIT");
  } catch (err) {
    ctx.db.exec("ROLLBACK");
    throw err;
  }

  const identities = ctx.db
    .prepare(
      "SELECT identity, created_by_volume, created_at, members, links, absorbed_into, absorbed_reason, note " +
        "FROM cast_identities WHERE absorbed_into IS NULL ORDER BY identity"
    )
    .all();

  return {
    ok: true,
    volume: vol,
    identitiesCreated,
    identitiesAbsorbed,
    linksFiled,
    linksAlreadyFiled,
    linksWithdrawn: ctx.db.prepare("SELECT COUNT(*) AS n FROM cast_identity_links WHERE withdrawn_at IS NOT NULL").get().n,
    guideRows: built.totals.harvestRows,
    guideCandidateGroups: built.totals.candidateGroups,
    guideIdentityBearingGroups: split.totals.identityBearing,
    guideIdentityBearingRows: split.totals.identityBearingRows,
    guideIdentityBearingOccurrences: split.totals.identityBearingOccurrences,
    guideUnselectedGroups: split.totals.unselected,
    guideLinks: guide.links.length,
    guideNamesLinked: guide.namesLinked,
    guideUnlinkedGroups: guide.unlinkedGroups,
    guideNearMisses: misses.nearMisses,
    guideAmbiguousReadings: misses.ambiguous,
    guideSoloPairs: soloPairs,
    characterRows: rows.length,
    characterRowLinks: prose.links.length,
    proseShapesExcluded: prose.excluded,
    identities,
    refusal: null,
  };
}

/**
 * Withdraw one stated link.
 *
 * The link row stays, marked, and the identity's counts are recomputed from the links still standing —
 * so a name whose only link was withdrawn stops being a member, and a name still held by another source
 * stays. Nothing outside these two tables changes, and that is the point of the whole slice: **removing a
 * wrong link cannot move a claim, because a claim was never filed by a link.**
 *
 * @param {{db: Object}} ctx
 * @param {number} linkId
 * @param {string} reason - Why the link is wrong. At least `MIN_LINK_WITHDRAWAL_REASON_CHARS` characters.
 * @returns {{ok: boolean, link: Object|null, identity: Object|null, alreadyWithdrawn: boolean, refusal: ReferenceRefusal|null}}
 */
function withdrawIdentityLink(ctx, linkId, reason) {
  const id = Number(linkId);
  const text = typeof reason === "string" ? reason.trim() : "";
  const link = ctx.db.prepare("SELECT * FROM cast_identity_links WHERE link_id = ?").get(id);
  if (!link) {
    return {
      ok: false,
      link: null,
      identity: null,
      alreadyWithdrawn: false,
      refusal: refusal({
        verb: "withdraw_identity_link",
        rule: "identity-link-unknown",
        because: `there is no identity link with link_id ${linkId}.`,
        fix: "castIdentityLinks(ctx) lists every link this record holds, withdrawn ones included.",
      }),
    };
  }
  if (text.length < MIN_LINK_WITHDRAWAL_REASON_CHARS) {
    return {
      ok: false,
      link,
      identity: null,
      alreadyWithdrawn: false,
      refusal: refusal({
        verb: "withdraw_identity_link",
        rule: "identity-link-withdrawal-needs-reason",
        because:
          `withdrawing the link ${link.a} / ${link.b} (stated by ${link.stated_by} in volume ${link.stated_by_volume}) ` +
          `needs a reason of at least ${MIN_LINK_WITHDRAWAL_REASON_CHARS} characters. A link is filed because a source ` +
          "stated it; saying it was wrong is a claim of its own, and it has to be readable afterwards.",
        fix: `withdrawIdentityLink(ctx, ${id}, "why this stated link is wrong")`,
        detail: { linkId: id, a: link.a, b: link.b, statedBy: link.stated_by },
      }),
    };
  }
  if (link.withdrawn_at) {
    return { ok: true, link, identity: null, alreadyWithdrawn: true, refusal: null };
  }

  ctx.db
    .prepare("UPDATE cast_identity_links SET withdrawn_at = ?, withdrawn_reason = ? WHERE link_id = ?")
    .run(new Date().toISOString(), text, id);
  recountIdentity(ctx, Number(link.identity));
  const identity = ctx.db.prepare("SELECT * FROM cast_identities WHERE identity = ?").get(Number(link.identity));
  return { ok: true, link: ctx.db.prepare("SELECT * FROM cast_identity_links WHERE link_id = ?").get(id), identity, alreadyWithdrawn: false, refusal: null };
}

module.exports = {
  MIN_LINK_WITHDRAWAL_REASON_CHARS,
  castKeysInRecord,
  liveIdentitiesOf,
  recountIdentity,
  fileIdentityLinks,
  withdrawIdentityLink,
};
