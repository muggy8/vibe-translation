/**
 * utils/reference-store/cast.js — who is in the story, and which name is the same person.
 *
 * The cast table is the one the two artifacts disagree about most: the voice reference
 * heads a section `如月雨露（ジョーロ）【俺人格】`, the glossary has a row for 如月雨露 and
 * a separate row for ジョーロ, and doc 03 §5 lists "two `cast` rows whose `key` differs
 * only by alias, with no alias link" as a defect — **a character split in two**.
 *
 * `castAlias` is the verb that fixes it, and it is the one write in this layer that
 * touches rows its caller does not own: re-pointing a fact from a duplicate key onto the
 * surviving key is not editing anyone's claim, it is putting the claim back on the
 * character it was always about. It is therefore recorded (`cast_merges`), because a
 * character merged into the WRONG character is the one operation here that makes a set of
 * facts vanish from a query.
 *
 * Two rules keep that one operation from being the way facts disappear (review 05 §3.3):
 *
 *   - **a merge is supersession, never deletion.** The merged row stays with `merged_into`
 *     pointing at the entry it joined. A deleted row cannot be audited; a marked row can, and
 *     it answers "where did this character's claims go" without anyone having to remember the
 *     merge.
 *   - **a sealed volume's cast is frozen.** Linking an alias is allowed after sealing (it adds
 *     a spelling and re-points nobody's claims); merging two cast entries is refused, because
 *     re-pointing sealed rows rewrites the published record a translation was already built on.
 *
 * @module utils/reference-store/cast
 */

const { refusal } = require("./refusals");
const { FACT_CHARACTER_ROLES, isInVocabulary } = require("./schema");
require("../../types"); // JSDoc type definitions

/**
 * Read one cast row.
 *
 * @param {{db: Object}} ctx - The store context.
 * @param {string} key
 * @returns {Object|null}
 */
function getCast(ctx, key) {
  return ctx.db.prepare("SELECT * FROM cast WHERE key = ?").get(String(key)) || null;
}

/**
 * The cast as of a volume: everyone introduced by then, plus anyone this volume's own
 * reading introduced.
 *
 * @param {{db: Object}} ctx
 * @param {number} [volume] - Omit for the whole cast this file knows about.
 * @returns {Array<Object>}
 */
function listCast(ctx, volume) {
  if (volume === undefined || volume === null) {
    return ctx.db.prepare("SELECT * FROM cast ORDER BY first_seen_volume IS NULL, first_seen_volume, key").all();
  }
  return ctx.db
    .prepare(
      "SELECT * FROM cast WHERE first_seen_volume IS NULL OR first_seen_volume <= ? " +
        "ORDER BY first_seen_volume IS NULL, first_seen_volume, key"
    )
    .all(Number(volume));
}

/**
 * Add or amend a cast entry.
 *
 * Amending is deliberately narrow: `display`, `persona` and `notes` may be updated, and
 * `first_seen_volume` only ever moves EARLIER, because "this character was already here in
 * volume 2" is a correction while "this character was not here in volume 2" is the loss the
 * carry-forward guard exists to catch.
 *
 * @param {{db: Object}} ctx
 * @param {Object} entry - `{key, display, persona, aliases, notes, firstSeenVolume}`.
 * @returns {{ok: boolean, cast: Object|null, created: boolean, refusal: ReferenceRefusal|null}}
 */
function upsertCast(ctx, entry) {
  const key = entry && typeof entry.key === "string" ? entry.key.trim() : "";
  if (!key) {
    return {
      ok: false,
      cast: null,
      created: false,
      refusal: refusal({
        verb: "cast_upsert",
        rule: "cast-key-required",
        because: "a cast entry needs a key: the one name the store treats as this character's identity.",
        fix: "use the primary name, with the aliases and persona tag in `aliases` / `persona`.",
      }),
    };
  }
  const display = typeof entry.display === "string" && entry.display.trim() ? entry.display.trim() : key;
  const existing = getCast(ctx, key);
  const aliases = mergeLists(existing ? parseAliases(existing.aliases) : [], entry.aliases);
  const firstSeen = earliestVolume(existing ? existing.first_seen_volume : null, entry.firstSeenVolume);

  if (existing) {
    // A display the entry does not supply is not a request to erase the one on the row. The
    // glossary registers cast entries without one (its rendering is a translation, not the
    // heading the voice artifact uses), so an import order must not decide how a character is
    // named.
    const keptDisplay = typeof entry.display === "string" && entry.display.trim() ? entry.display.trim() : existing.display;
    ctx.db
      .prepare(
        "UPDATE cast SET display = ?, persona = ?, aliases = ?, notes = ?, first_seen_volume = ? WHERE key = ?"
      )
      .run(
        keptDisplay,
        entry.persona === undefined ? existing.persona : nullableText(entry.persona),
        JSON.stringify(aliases),
        entry.notes === undefined ? existing.notes : nullableText(entry.notes),
        firstSeen,
        key
      );
    return { ok: true, cast: getCast(ctx, key), created: false, refusal: null };
  }

  ctx.db
    .prepare("INSERT INTO cast (key, display, persona, aliases, first_seen_volume, notes) VALUES (?,?,?,?,?,?)")
    .run(
      key,
      display,
      nullableText(entry.persona),
      JSON.stringify(aliases),
      firstSeen,
      nullableText(entry.notes)
    );
  return { ok: true, cast: getCast(ctx, key), created: true, refusal: null };
}

/**
 * Link an alias to a character — and merge a duplicate cast entry if the alias IS one.
 *
 * @param {{db: Object}} ctx
 * @param {string} key - The character that survives.
 * @param {string} alias - The spelling that joins it (or the duplicate key to merge in).
 * @param {string} [reason] - Why these are the same character.
 * @returns {{ok: boolean, cast: Object|null, merged: string|null, movedFacts: number, refusal: ReferenceRefusal|null}}
 */
function castAlias(ctx, key, alias, reason) {
  const survivorKey = typeof key === "string" ? key.trim() : "";
  const aliasKey = typeof alias === "string" ? alias.trim() : "";
  if (!survivorKey || !aliasKey) {
    return {
      ok: false,
      cast: null,
      merged: null,
      movedFacts: 0,
      refusal: refusal({
        verb: "cast_alias",
        rule: "cast-alias-needs-both-names",
        because: "cast_alias(key, alias) needs both the character and the spelling that joins it.",
      }),
    };
  }
  if (survivorKey === aliasKey) {
    return {
      ok: false,
      cast: getCast(ctx, survivorKey),
      merged: null,
      movedFacts: 0,
      refusal: refusal({
        verb: "cast_alias",
        rule: "cast-alias-is-self",
        because: `"${survivorKey}" is being aliased to itself.`,
      }),
    };
  }

  const survivor = getCast(ctx, survivorKey);
  if (!survivor) {
    return {
      ok: false,
      cast: null,
      merged: null,
      movedFacts: 0,
      refusal: refusal({
        verb: "cast_alias",
        rule: "cast-unknown-key",
        because: `there is no cast entry keyed "${survivorKey}".`,
        fix: `create it first with cast_upsert({key: "${survivorKey}", display: …}).`,
      }),
    };
  }

  const duplicate = getCast(ctx, aliasKey);
  if (!duplicate) {
    ctx.db
      .prepare("UPDATE cast SET aliases = ? WHERE key = ?")
      .run(JSON.stringify(mergeLists(parseAliases(survivor.aliases), [aliasKey])), survivorKey);
    return { ok: true, cast: getCast(ctx, survivorKey), merged: null, movedFacts: 0, refusal: null };
  }

  // The alias is its own cast row: merge it — as **supersession**, never as deletion
  // (review 05 §3.3). The duplicate stays in the table with `merged_into` pointing at the
  // entry it joined, its facts are re-pointed to the survivor, and the re-pointing is recorded
  // in `cast_merges`. The reason is the one doc 01 §4 names: a merge is the only operation in
  // this layer that can make published facts quietly disappear, and a row that was deleted
  // cannot be audited. Keeping the row means a later volume can always answer "where did this
  // character's claims go".
  //
  // A merge is also the branch that has to say WHY. A plain alias (no duplicate row) only adds
  // a spelling, so it is not destructive and needs no reason; a merge rewrites other rows'
  // keys, so it does.
  if (!nullableText(reason)) {
    return {
      ok: false,
      cast: survivor,
      merged: null,
      movedFacts: 0,
      refusal: refusal({
        verb: "cast_alias",
        rule: "cast-merge-needs-reason",
        because:
          `"${aliasKey}" is its own cast entry, so linking it merges two characters and moves their ` +
          "facts. A merge that cannot say why is the one doc 01 §4 says produces a wrong merge nobody can undo.",
        useInstead: ["cast_upsert"],
        fix: `cast_alias("${survivorKey}", "${aliasKey}", "why these are the same character")`,
        detail: { survivor: survivorKey, merged: aliasKey },
      }),
    };
  }

  // A sealed volume's cast is frozen (review 05 §3.3). Re-pointing a sealed row's key rewrites
  // the published record the translation was already built on, which is the same thing sealing
  // exists to prevent. Linking an alias to a character is still allowed after sealing — it adds
  // a spelling and changes nobody's claims — but merging two cast entries is not.
  const sealedFacts = ctx.db
    .prepare("SELECT COUNT(*) AS n FROM facts WHERE key = ? AND sealed = 1")
    .get(aliasKey).n;
  if (sealedFacts > 0) {
    return {
      ok: false,
      cast: duplicate,
      merged: null,
      movedFacts: 0,
      refusal: refusal({
        verb: "cast_alias",
        rule: "cast-merge-has-sealed-facts",
        because:
          `"${aliasKey}" carries ${sealedFacts} sealed fact(s) from a published volume. Merging it would ` +
          "re-point those rows to another character, which rewrites a record a translation was already " +
          "made from. A sealed cast entry is not merged.",
        useInstead: ["cast_alias on the unsealed volume", "challenge_fact"],
        detail: { survivor: survivorKey, merged: aliasKey, sealedFacts },
      }),
    };
  }

  // Already merged somewhere else: say where, rather than silently re-pointing it a second time
  // and leaving a chain nobody can read.
  if (duplicate.merged_into && duplicate.merged_into !== survivorKey) {
    return {
      ok: false,
      cast: duplicate,
      merged: null,
      movedFacts: 0,
      refusal: refusal({
        verb: "cast_alias",
        rule: "cast-entry-already-merged",
        because:
          `"${aliasKey}" is already merged into "${duplicate.merged_into}". Merging it into ` +
          `"${survivorKey}" as well would leave two rows claiming the same character.`,
        useInstead: ["cast_alias"],
        fix: `cast_alias("${duplicate.merged_into}", "${survivorKey}", "why these are the same character")`,
        detail: { survivor: survivorKey, merged: aliasKey, alreadyMergedInto: duplicate.merged_into },
      }),
    };
  }

  const mergedAliases = mergeLists(parseAliases(survivor.aliases), [aliasKey, ...parseAliases(duplicate.aliases)]);
  const moved = ctx.db.prepare("SELECT COUNT(*) AS n FROM facts WHERE key = ?").get(aliasKey).n;

  ctx.db.exec("BEGIN");
  try {
    // The facts move to the survivor…
    ctx.db.prepare("UPDATE facts SET key = ? WHERE key = ?").run(survivorKey, aliasKey);
    ctx.db
      .prepare("UPDATE cast SET display = ?, persona = ?, aliases = ?, notes = ?, first_seen_volume = ? WHERE key = ?")
      .run(
        survivor.display,
        survivor.persona,
        JSON.stringify(mergedAliases),
        survivor.notes || duplicate.notes,
        earliestVolume(survivor.first_seen_volume, duplicate.first_seen_volume),
        survivorKey
      );
    // …and the merged entry stays, marked. `merged_into` is what makes the move visible to a
    // later volume instead of invisible.
    ctx.db.prepare("UPDATE cast SET merged_into = ? WHERE key = ?").run(survivorKey, aliasKey);
    ctx.db
      .prepare(
        "INSERT INTO cast_merges (survivor, merged, reason, moved_facts, created_at) VALUES (?,?,?,?,?) " +
          "ON CONFLICT(survivor, merged) DO UPDATE SET moved_facts = cast_merges.moved_facts + excluded.moved_facts"
      )
      .run(survivorKey, aliasKey, nullableText(reason), moved, new Date().toISOString());
    ctx.db.exec("COMMIT");
  } catch (err) {
    ctx.db.exec("ROLLBACK");
    throw err;
  }
  return { ok: true, cast: getCast(ctx, survivorKey), merged: aliasKey, movedFacts: moved, refusal: null };
}

/**
 * Attach characters to a fact with the role each one plays (doc 03 §2's
 * `fact_characters`): the case a naive per-character split loses.
 *
 * @param {{db: Object}} ctx
 * @param {string} factId
 * @param {Array<{key: string, role?: string}>} characters
 * @returns {{ok: boolean, problems: string[]}}
 */
function linkFactCharacters(ctx, factId, characters) {
  const problems = [];
  const insert = ctx.db.prepare(
    "INSERT INTO fact_characters (fact_id, key, role) VALUES (?,?,?) ON CONFLICT(fact_id, key, role) DO NOTHING"
  );
  for (const entry of characters || []) {
    const key = entry && typeof entry.key === "string" ? entry.key.trim() : "";
    const role = entry && entry.role ? entry.role : "subject";
    if (!key) {
      problems.push("a fact character needs a key");
      continue;
    }
    if (!isInVocabulary(FACT_CHARACTER_ROLES, role)) {
      problems.push(`fact character role must be one of: ${FACT_CHARACTER_ROLES.join(", ")}`);
      continue;
    }
    if (!getCast(ctx, key)) {
      problems.push(`there is no cast entry keyed "${key}"`);
      continue;
    }
    insert.run(factId, key, role);
  }
  return { ok: problems.length === 0, problems };
}

/**
 * The characters attached to a fact.
 *
 * @param {{db: Object}} ctx
 * @param {string} factId
 * @returns {Array<{key: string, role: string}>}
 */
function factCharacters(ctx, factId) {
  return ctx.db.prepare("SELECT key, role FROM fact_characters WHERE fact_id = ? ORDER BY role, key").all(factId);
}

/**
 * The aliases column is JSON; read it defensively.
 * @param {string} raw
 * @returns {string[]}
 */
function parseAliases(raw) {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Union two string lists, order-preserving, no duplicates, no blanks.
 * @param {string[]} a
 * @param {string[]} b
 * @returns {string[]}
 */
function mergeLists(a, b) {
  const out = [];
  for (const value of [...(a || []), ...(b || [])]) {
    const text = String(value || "").trim();
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

/**
 * The earlier of two volume numbers — the only direction `first_seen_volume` may move.
 * @param {number|null} current
 * @param {number|null|undefined} next
 * @returns {number|null}
 */
function earliestVolume(current, next) {
  if (next === undefined) return current === undefined ? null : current;
  const a = Number.isInteger(current) ? current : null;
  const b = Number.isInteger(next) ? next : null;
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

/**
 * `null` for null-ish input, otherwise the trimmed string.
 * @param {*} value
 * @returns {string|null}
 */
function nullableText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

/**
 * The merges this store has made, oldest first.
 *
 * `cast_alias` can make a whole set of facts disappear from a query if it merges the wrong
 * two characters, so the merge is written down (doc 03 §3.2) and this is how a later reader —
 * or the integrity pass — finds it.
 *
 * @param {{db: Object}} ctx
 * @returns {Array<Object>}
 */
function castMerges(ctx) {
  return ctx.db.prepare("SELECT * FROM cast_merges ORDER BY created_at, survivor, merged").all();
}

module.exports = {
  getCast,
  listCast,
  upsertCast,
  castAlias,
  castMerges,
  linkFactCharacters,
  factCharacters,
  parseAliases,
};
