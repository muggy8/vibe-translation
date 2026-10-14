/**
 * utils/reference-store/integrity/roster.js — the roster questions: one person in two
 * entries, an entry headed by the word for "I", and claims filed under nobody.
 *
 * The cast table is where a character's claims live, so this is where the store asks
 * whether the roster describes the same person twice (`splitCharacters`), whether it holds
 * an entry keyed by a bare first-person pronoun (`pronounKeyedRosterEntries`, gotcha 115),
 * and whether it holds claims with no roster entry at all (`claimsFiledWithoutARosterEntry`,
 * gotcha 117). All three are **reports, never merges**: deciding that two names are one
 * person is a decision about a person, and the door for that decision in this layer is
 * `castAlias`, asked by somebody who has read the book.
 *
 * @module utils/reference-store/integrity/roster
 */

const { isBareFirstPersonPronoun, spanTokens, voicePrimaryName } = require("../name-resolution");

require("../../../types"); // JSDoc type definitions

/**
 * Cast rows that are the same character twice.
 *
 * Two shapes, both observed as the risk doc 03 §5 names: two rows with the same display,
 * and a row whose key is listed as another row's alias — which means the alias was merged
 * in one direction and never the other.
 *
 * @param {{db: Object}} ctx
 * @returns {Array<{keys: string[], problem: string}>}
 */
function splitCharacters(ctx) {
  const rows = ctx.db.prepare("SELECT key, display, aliases, merged_into AS mergedInto FROM cast ORDER BY key").all();
  const out = [];
  // A merged entry is not a character of its own: it is a marked trail saying these two names are one
  // person. Judging it as a second entry would report every merge this store has ever made as the defect
  // the merge was performed to fix.
  const live = rows.filter((row) => !row.mergedInto);

  const byDisplay = new Map();
  for (const row of live) {
    const display = String(row.display || "").trim().toLowerCase();
    if (!display) continue;
    if (!byDisplay.has(display)) byDisplay.set(display, []);
    byDisplay.get(display).push(row.key);
  }
  for (const [display, keys] of byDisplay) {
    if (keys.length > 1) {
      out.push({ keys, problem: `two cast entries render as the same character "${display}"` });
    }
  }

  for (const row of live) {
    let aliases = [];
    try {
      aliases = JSON.parse(row.aliases || "[]");
    } catch {
      continue;
    }
    for (const alias of aliases) {
      if (alias === row.key) continue;
      const other = ctx.db.prepare("SELECT key, merged_into AS mergedInto FROM cast WHERE key = ?").get(alias);
      if (!other) continue;
      // The alias being its own entry is the defect only while it is an entry in its own right. Once it
      // is marked as merged into this one, that IS the merged state this check asks for.
      if (other.mergedInto === row.key) continue;
      out.push({
        keys: [row.key, alias],
        problem:
          `"${alias}" is listed as an alias of "${row.key}" and is ALSO its own cast entry — ` +
          "the identity was never merged (cast_alias is the verb that merges it).",
      });
    }
  }
  return out;
}

/**
 * Roster entries that are keyed by a bare first-person pronoun and carry claims.
 *
 * Why this is a question the store has to ask. The extraction names a character however the book names
 * them in the passage it is reading, and in a first-person novel that is often just the pronoun: the real
 * volume 01 reading pass wrote `俺（主人公）` for ten claims and `如月雨露（ジョーロ／俺）` for sixteen, and
 * the name door kept the base of each label — so the roster ended up with `俺` (15 claims) beside
 * `如月雨露` (215), and volume 02's copy carries the split forward with 262 claims on the pronoun side.
 *
 * The fold that is supposed to close this cannot see it. `rosterIdentityConflicts` asks whether an entry's
 * **own heading** names another entry's key, and that heading used to come from an authored artifact whose
 * author wrote `### 俺（如月雨露・第二章終盤）` — a heading that names 如月雨露 outright. On the
 * read-then-assemble route the heading is the key, verbatim, so the signal the fold reads no longer exists
 * anywhere in the record. The guard is intact; the fact it was written to notice stopped being written.
 *
 * This is therefore a **report, not a merge**. Deciding that `俺` is 如月雨露 is a decision about a person,
 * and the door for a decision in this layer is `castAlias`, asked by somebody who has read the book. What
 * this adds is that the split is named — with the claim counts on each side — in the report a human reads,
 * instead of surfacing only as a reference whose protagonist is in two places at once.
 *
 * @param {{db: Object, volume: number}} ctx
 * @returns {Array<{key: string, claims: number, establishedVolumes: number[], candidates: string[]}>}
 */
function pronounKeyedRosterEntries(ctx) {
  const out = [];
  for (const row of ctx.db.prepare("SELECT key, display, merged_into AS mergedInto FROM cast ORDER BY key").all()) {
    if (row.mergedInto) continue;
    if (!isBareFirstPersonPronoun(row.key)) continue;
    const claims = ctx.db
      .prepare("SELECT COUNT(*) AS n, COUNT(DISTINCT established_volume) AS vols FROM facts WHERE key = ? AND aspect != 'term_usage' AND status != 'retracted'")
      .get(row.key);
    if (!claims || claims.n === 0) continue;
    // Who else on this roster could be the same person: an entry whose key or alias contains the pronoun
    // as a whole token. Reported as candidates, never acted on.
    /** @type {string[]} */
    const candidates = [];
    for (const other of ctx.db.prepare("SELECT key, display, aliases, merged_into AS mergedInto FROM cast WHERE key != ? ORDER BY key").all(row.key)) {
      if (other.mergedInto) continue;
      let aliases = [];
      try {
        aliases = JSON.parse(other.aliases || "[]");
      } catch {
        aliases = [];
      }
      const tokens = [other.key, other.display, ...aliases].flatMap((label) => spanTokens(String(label || "")));
      if (tokens.includes(row.key)) candidates.push(other.key);
    }
    const vols = ctx.db
      .prepare("SELECT DISTINCT established_volume AS v FROM facts WHERE key = ? AND aspect != 'term_usage' AND status != 'retracted' ORDER BY v")
      .all(row.key)
      .map((r) => r.v);
    out.push({ key: row.key, claims: claims.n, establishedVolumes: vols, candidates });
  }
  return out;
}

/**
 * Claims the store filed with no roster entry, grouped by the name the extraction gave them.
 *
 * The record has always been able to hold a claim about nobody: a point-of-view observation the
 * extraction could not assign is stored with a null key, and the POV map publishes it under the chapter
 * it describes. What it could not do until migration 6 was say **what the extraction called it** — a null
 * key with nothing beside it is a claim that lost its subject, and "the store could not tell who narrates
 * this" was invisible unless somebody remembered which run said so in a log.
 *
 * This is the other half of the pronoun rule. `resolveExtractionName` refuses to make a roster entry out
 * of the word for "I"; this is where those claims are found again, so the refusal is a named gap in a
 * report rather than a quiet hole in a record. A row whose `extracted_as` is a bare pronoun is the shape
 * that says *the book narrates in the first person and this record has never been told whose first person
 * it is* — which a human closes with `castAlias(key, "俺", reason)`, not with a flag.
 *
 * @param {{db: Object}} ctx
 * @returns {Array<{extractedAs: string, claims: number, aspects: string[], pronoun: boolean}>}
 */
function claimsFiledWithoutARosterEntry(ctx) {
  const rows = ctx.db
    .prepare(
      "SELECT extracted_as AS extractedAs, aspect, COUNT(*) AS n FROM facts " +
        "WHERE key IS NULL AND extracted_as IS NOT NULL AND status != 'retracted' " +
        "GROUP BY extracted_as, aspect ORDER BY n DESC, extracted_as"
    )
    .all();
  /** @type {Map<string, {extractedAs: string, claims: number, aspects: string[], pronoun: boolean}>} */
  const grouped = new Map();
  for (const row of rows) {
    const name = String(row.extractedAs);
    if (!grouped.has(name)) {
      grouped.set(name, { extractedAs: name, claims: 0, aspects: [], pronoun: isBareFirstPersonPronoun(voicePrimaryName(name) || name) });
    }
    const entry = grouped.get(name);
    entry.claims += row.n;
    entry.aspects.push(row.aspect);
  }
  return [...grouped.values()].sort((a, b) => b.claims - a.claims || a.extractedAs.localeCompare(b.extractedAs, "ja"));
}

module.exports = {
  splitCharacters,
  pronounKeyedRosterEntries,
  claimsFiledWithoutARosterEntry,
};
