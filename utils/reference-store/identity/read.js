/**
 * utils/reference-store/identity/read.js — asking the record who is the same character, without asking
 * anything to merge them.
 *
 * Every query here answers a question **about names**. None of them is on the path a claim takes: filing
 * a claim asks `name-resolution.js`, measuring presence asks `presence.js`, and neither reads these
 * tables (plan 06 §10.8, and `test/test-identity-table-isolation.js`). That is what makes it safe for a
 * link to be wrong: a wrong link makes a wrong *group*, and a wrong group cannot move a sentence from one
 * character to another, because nothing here is consulted when a sentence is filed.
 *
 * "Live" means **not withdrawn**. Every read excludes withdrawn links unless the caller asks for
 * everything, because "is this name linked to anything" has to mean "linked by something still standing"
 * — and the whole reason a link is marked rather than deleted is that a person has to be able to see the
 * one that was wrong.
 *
 * @module utils/reference-store/identity/read
 */

require("../../../types"); // JSDoc type definitions

/**
 * The identity rows, with the members the links still standing give them.
 *
 * @param {{db: Object}} ctx
 * @param {{includeAbsorbed?: boolean}} [opts] - Absorbed identity rows are history; they are excluded unless asked for.
 * @returns {Array<{identity: number, createdByVolume: number, createdAt: string, members: number, links: number, absorbedInto: number|null, absorbedReason: string|null, note: string|null, memberKeys: string[]}>}
 */
function castIdentities(ctx, { includeAbsorbed = false } = {}) {
  const rows = includeAbsorbed
    ? ctx.db.prepare("SELECT * FROM cast_identities ORDER BY identity").all()
    : ctx.db.prepare("SELECT * FROM cast_identities WHERE absorbed_into IS NULL ORDER BY identity").all();
  return rows.map((row) => ({
    identity: Number(row.identity),
    createdByVolume: Number(row.created_by_volume),
    createdAt: row.created_at,
    members: Number(row.members),
    links: Number(row.links),
    absorbedInto: row.absorbed_into === null || row.absorbed_into === undefined ? null : Number(row.absorbed_into),
    absorbedReason: row.absorbed_reason ?? null,
    note: row.note ?? null,
    memberKeys: identityMemberKeys(ctx, Number(row.identity)),
  }));
}

/**
 * The links this record holds.
 *
 * @param {{db: Object}} ctx
 * @param {{identity?: number, includeWithdrawn?: boolean}} [opts]
 * @returns {Array<{linkId: number, identity: number, a: string, b: string, statedBy: string, statedByVolume: number, sourceFile: string|null, reason: string, addedAt: string, withdrawnAt: string|null, withdrawnReason: string|null}>}
 */
function castIdentityLinks(ctx, { identity, includeWithdrawn = false } = {}) {
  const where = [];
  /** @type {Array<string|number>} */
  const args = [];
  if (identity !== undefined && identity !== null) {
    where.push("identity = ?");
    args.push(Number(identity));
  }
  if (!includeWithdrawn) where.push("withdrawn_at IS NULL");
  const sql = `SELECT * FROM cast_identity_links ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY link_id`;
  return ctx.db
    .prepare(sql)
    .all(...args)
    .map((row) => ({
      linkId: Number(row.link_id),
      identity: Number(row.identity),
      a: row.a,
      b: row.b,
      statedBy: row.stated_by,
      statedByVolume: Number(row.stated_by_volume),
      sourceFile: row.source_file ?? null,
      reason: row.reason,
      addedAt: row.added_at,
      withdrawnAt: row.withdrawn_at ?? null,
      withdrawnReason: row.withdrawn_reason ?? null,
    }));
}

/**
 * The roster names one identity holds, through the links still standing.
 *
 * @param {{db: Object}} ctx
 * @param {number} identity
 * @returns {string[]}
 */
function identityMemberKeys(ctx, identity) {
  const rows = ctx.db
    .prepare(
      "SELECT a AS key FROM cast_identity_links WHERE identity = ? AND withdrawn_at IS NULL " +
        "UNION SELECT b AS key FROM cast_identity_links WHERE identity = ? AND withdrawn_at IS NULL ORDER BY key"
    )
    .all(Number(identity), Number(identity));
  return rows.map((row) => row.key);
}

/**
 * One identity's members, with the link that put each name there.
 *
 * A name held by two sources appears twice, once per statement, because "which source said this name
 * belongs here" is the question a wrong link has to be found by.
 *
 * @param {{db: Object}} ctx
 * @param {number} identity
 * @returns {Array<{key: string, joinedVia: string, linkId: number, statedBy: string, statedByVolume: number, sourceFile: string|null, reason: string}>}
 */
function castIdentityMembers(ctx, identity) {
  const links = castIdentityLinks(ctx, { identity });
  const out = [];
  for (const link of links) {
    out.push({
      key: link.a,
      joinedVia: link.b,
      linkId: link.linkId,
      statedBy: link.statedBy,
      statedByVolume: link.statedByVolume,
      sourceFile: link.sourceFile,
      reason: link.reason,
    });
    out.push({
      key: link.b,
      joinedVia: link.a,
      linkId: link.linkId,
      statedBy: link.statedBy,
      statedByVolume: link.statedByVolume,
      sourceFile: link.sourceFile,
      reason: link.reason,
    });
  }
  return out.sort((x, y) => (x.key === y.key ? x.linkId - y.linkId : x.key < y.key ? -1 : 1));
}

/**
 * Which identities this roster name currently belongs to.
 *
 * Normally zero or one. More than one is reported rather than resolved: it would mean the record holds
 * two groups this door has not joined, and picking one by id is the kind of silent choice this layer
 * refuses.
 *
 * @param {{db: Object}} ctx
 * @param {string} key
 * @returns {Array<{identity: number, members: number, createdByVolume: number}>}
 */
function identityOfCastKey(ctx, key) {
  const rows = ctx.db
    .prepare(
      "SELECT DISTINCT l.identity AS identity, i.created_by_volume AS createdByVolume " +
        "FROM cast_identity_links l JOIN cast_identities i ON i.identity = l.identity " +
        "WHERE l.withdrawn_at IS NULL AND i.absorbed_into IS NULL AND (l.a = ? OR l.b = ?) ORDER BY l.identity"
    )
    .all(String(key), String(key));
  return rows.map((row) => ({
    identity: Number(row.identity),
    members: identityMemberKeys(ctx, Number(row.identity)).length,
    createdByVolume: Number(row.createdByVolume),
  }));
}

/**
 * The roster entries no link still standing connects to anything.
 *
 * This is the number the coverage guard eventually has to know the difference between: an entry that is
 * one name for one person, and an entry that is the fourth name for somebody already counted.
 *
 * @param {{db: Object}} ctx
 * @returns {string[]}
 */
function unlinkedCastKeys(ctx) {
  const linked = ctx.db
    .prepare(
      "SELECT DISTINCT key FROM (" +
        "SELECT a AS key FROM cast_identity_links WHERE withdrawn_at IS NULL UNION SELECT b AS key FROM cast_identity_links WHERE withdrawn_at IS NULL)"
    )
    .all();
  const linkedKeys = new Set(linked.map((row) => row.key));
  return ctx.db
    .prepare("SELECT key FROM cast ORDER BY key")
    .all()
    .map((row) => row.key)
    .filter((key) => !linkedKeys.has(key));
}

/**
 * The shape of the roster once the links are taken into account.
 *
 * This is the number plan 06 §8 slice 1b predicts — "35 groups instead of 196 names" — and it is the
 * question slice 9 would ask the coverage guard. **It is reported here and asked by nobody yet**: the
 * guard still counts roster entries, because switching it over is slice 9, not this slice.
 *
 * @param {{db: Object}} ctx
 * @returns {{rosterEntries: number, identities: number, groupsOfTwoOrMore: number, linkedEntries: number, duplicateEntries: number, unlinkedEntries: number, largestGroup: number, membersPerIdentity: Array<{identity: number, members: number, keys: string[]}>}}
 */
function identityCoverageSummary(ctx) {
  const roster = ctx.db.prepare("SELECT key FROM cast").all().map((row) => row.key);
  const groups = castIdentities(ctx)
    .map((identity) => ({ identity: identity.identity, members: identity.memberKeys.length, keys: identity.memberKeys }))
    .filter((group) => group.members > 0)
    .sort((a, b) => b.members - a.members || a.identity - b.identity);
  const linked = new Set();
  for (const group of groups) for (const key of group.keys) linked.add(key);
  return {
    rosterEntries: roster.length,
    identities: groups.length,
    groupsOfTwoOrMore: groups.filter((group) => group.members >= 2).length,
    linkedEntries: linked.size,
    duplicateEntries: [...linked].length - groups.length,
    unlinkedEntries: roster.filter((key) => !linked.has(key)).length,
    largestGroup: groups.length ? groups[0].members : 0,
    membersPerIdentity: groups,
  };
}

module.exports = {
  castIdentities,
  castIdentityLinks,
  identityMemberKeys,
  castIdentityMembers,
  identityOfCastKey,
  unlinkedCastKeys,
  identityCoverageSummary,
};
