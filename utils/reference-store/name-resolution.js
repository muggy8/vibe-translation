/**
 * utils/reference-store/name-resolution.js — which roster entry a name belongs to.
 *
 * The pipeline names characters its own way in three places, and none of them agree: the glossary's
 * Characters rows (如月雨露), the character-voice headings (如月雨露（ジョーロ）【俺人格】), and the
 * per-chapter extraction (俺（主人公）, 三色院菫子（パンジー）, 如月雨露（ジョーロ）／俺). File a claim
 * under the spelling the source happened to use and the roster splits: 如月雨露 ends up with no
 * claims because its claims landed under 俺（主人公）, and every question the store asks about
 * coverage, adoption, or "what does the record say about her" answers about a name nobody published.
 *
 * So this is one module, used by both doors that put extraction names into the record
 * (`extraction-adapter.js` and `rebuild.js`), so the two cannot drift into two different answers to
 * the same name.
 *
 * It is a **leaf**: it requires `voice-adapter.js` for the primary-name rule and nothing else, and it
 * takes a `{db}` rather than a store, so neither adapter has to require the other (gotcha 85 —
 * `rebuild.js` already requires `extraction-adapter.js`, and a name resolver living in either one
 * would close a require cycle and hand the other a half-built module).
 *
 * Resolution is deterministic and deliberately **narrow**, in this order: exact key, then a **recorded
 * alias**, then primary name against a key, then primary name against a display's bracketed span. The
 * alias is checked before the primary-name inference because an alias is an explicit, reasoned decision
 * somebody made about this character (`castAlias` refuses one without a reason) while "the primary name
 * happens to be a key" is an inference — and because the inference is **run-order-dependent**: a roster
 * entry created by an earlier pass can capture a name that the operator had already linked somewhere
 * else. Volume 01 measured it. 俺（主人公） is a recorded alias of 如月雨露, and the extraction also
 * names a character 俺（如月雨露・第二章終盤）, which resolves to nothing and becomes its own entry keyed
 * 俺. On the first run 俺（主人公）'s 48 claims landed on 如月雨露; on a second run the entry keyed 俺
 * already existed, the primary-name rule fired first, and the same 48 claims landed on 俺. Same file,
 * same rules, different record.
 *
 * It is not a substring search — 女 would match 一人の女子生徒 on a substring, and a false match makes a
 * character look covered when nothing was written about them. A name that resolves to nothing stays
 * unresolved and is **reported**: inventing the link is a translation decision, and the store's door for
 * that decision is `castAlias`, which requires a reason.
 *
 * The last rule is the narrowest one, and it is here because of what volume 01 actually left behind. The
 * extraction named a character `俺（如月雨露・第二章終盤）` — a label that contains the real name inside
 * it — and none of the four rules above can read it, so it became its own roster entry keyed `俺` with
 * 14 of the protagonist's claims under it. Two conditions have to hold before this rule acts, in both
 * directions (the resolver, and `rosterIdentityConflicts` which reads the whole roster):
 *
 *   - the name's primary form is a **bare first-person pronoun** — one of the closed list below; and
 *   - the name's bracketed label contains another entry's **key** as a whole token.
 *
 * The first condition is what keeps the rule from doing the damage a name-containment rule would do on
 * its own. `如月雨露（ジョーロ）【俺人格】` contains ジョーロ, which is a roster entry; a rule that merged
 * on containment alone would fold the protagonist into his own nickname and orphan every glossary row
 * keyed with his name. A pronoun is different in kind: 俺 is not a name this book gives a character, it
 * is the grammar of the narration, and an entry keyed by one is not a second character — it is somebody's
 * claims filed under the word for "I".
 *
 * `女（図書委員）` names nothing on the roster and stays unresolved, reported. So does
 * `俺（如月雨露の友人）`: a label that mentions a character in prose is a translation decision, and
 * `castAlias` is the door for a decision.
 *
 * **And a bare first-person pronoun is never a roster entry.** The rule above reads a pronoun's label, and
 * when the label names nothing the name used to fall through and *become* an entry. Volume 02 measured
 * what that costs: its extractor wrote `俺（ジョーロ）` for the protagonist, the primary form of that name
 * is the pronoun, and 282 of his claims landed under an entry keyed `俺` while 190 landed under 如月雨露 —
 * one person, two roster entries, and a published reference whose protagonist section is headed with the
 * word for "I" (gotcha 115). Now such a claim is filed **unattached**: no roster entry, the name it was
 * written under kept in `facts.extracted_as`, and the audit prints it. The claim is not lost and the
 * record does not pretend to know something it does not.
 *
 * The pronoun is resolved rather than refused whenever the record does know whose "I" it is, and the only
 * thing that counts as knowing is a **declared alias**: `如月雨露` carries `俺` in its `aliases`, so
 * `俺（ジョーロ）` resolves onto him. Volume 1's glossary says so in its own Characters row — "Narrator:
 * switches between 僕 and 俺" — and `importGlossary` now reads that declaration out of the glossary it is
 * already importing (see `glossary-adapter.js`). Two entries declaring the same pronoun is not a tie to
 * break: the name is reported as ambiguous and the claims stay unattached until somebody says whose it is.
 *
 * @module utils/reference-store/name-resolution
 */

const { voicePrimaryName } = require("./voice-adapter");
require("../../types"); // JSDoc type definitions

/**
 * The bracketed spans inside a heading or a glossary name: `如月雨露（ジョーロ）【俺人格】` →
 * `["ジョーロ", "俺人格"]`.
 *
 * These are where the artifacts record an alias without using the store's alias column, and they are
 * the only place a nickname the book uses can be read back out of a published file.
 *
 * @param {string} display
 * @returns {string[]}
 */
function displayAliasSpans(display) {
  const spans = [];
  const text = String(display || "");
  const openers = [
    ["（", "）"],
    ["(", ")"],
    ["【", "】"],
  ];
  for (const [open, close] of openers) {
    let from = 0;
    for (;;) {
      const start = text.indexOf(open, from);
      if (start < 0) break;
      const end = text.indexOf(close, start + open.length);
      if (end < 0) break;
      const span = text.slice(start + open.length, end).trim();
      if (span) spans.push(span);
      from = end + close.length;
    }
  }
  return spans;
}

/**
 * The bare first-person pronouns, as a closed list.
 *
 * This is a vocabulary, not a heuristic, for the reason AGENTS.md rule 3 gives: a rule that decides which
 * character a set of claims belongs to cannot be tuned by whoever is running it. It is also short enough
 * to read and argue with, which a threshold like "this word occurs in every chapter" is not.
 *
 * Only the bare forms. 俺様 and うちの子 are not in it because they are not the word for "I" on its own,
 * and the rule is only ever about that word.
 *
 * @type {string[]}
 */
const BARE_FIRST_PERSON_PRONOUNS = Object.freeze([
  "俺",
  "おれ",
  "僕",
  "ぼく",
  "私",
  "わたし",
  "あたし",
  "あたくし",
  "うち",
  "自分",
  "我",
  "吾",
  "余",
]);

/**
 * Is this name the word for "I", rather than a name?
 *
 * @param {string} name
 * @returns {boolean}
 */
function isBareFirstPersonPronoun(name) {
  return BARE_FIRST_PERSON_PRONOUNS.includes(String(name || "").trim());
}

/**
 * The words inside one bracketed span, split on the separators the artifacts use to stack a label.
 *
 * `如月雨露・第二章終盤` is not one alias: the extraction wrote a character name and a place in the
 * book in the same bracket, joined by the ideographic middle dot. Splitting the span is what lets a
 * rule compare a *name* against the roster instead of comparing a whole label against it — and it is
 * still exact-token matching, not a substring search, so 女 still does not match 一人の女子生徒.
 *
 * @param {string} span - One bracketed span, as `displayAliasSpans` extracted it.
 * @returns {string[]}
 */
function spanTokens(span) {
  return String(span || "")
    .split(/[・／/|｜、,，\s]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

/**
 * Roster entries that name another roster entry inside their own heading.
 *
 * This is the shape volume 01 left behind: an entry keyed `俺` whose heading is
 * `俺（如月雨露・第二章終盤）`. The extraction did not invent a new character and hope nobody noticed —
 * it wrote the real name inside the label it gave the claims. So the link is not a guess the store is
 * making on somebody's behalf: it is a statement the artifact itself already contains, and the reason a
 * merge has to carry is literally the heading that produced it.
 *
 * Deliberately narrow, in two ways. The entry's key has to be a bare first-person pronoun, and a token of
 * its bracketed label must equal another entry's **key** exactly. Containment alone would fold
 * `如月雨露（ジョーロ）【俺人格】` into ジョーロ. A heading that mentions a character in prose
 * (`俺（如月雨露の友人）`) resolves to nothing, and it stays unresolved and reported, because that link is
 * a translation decision and `castAlias` is the door for a decision.
 *
 * @param {{db: Object}} ctx - Anything with a `db` holding the `cast` table.
 * @returns {Array<{merged: string, survivor: string, heading: string, span: string, token: string, ambiguous: boolean}>}
 *   One row per entry whose heading names a roster key. `ambiguous: true` means the entry names TWO
 *   different roster entries, which is reported and never merged: picking between them is a decision,
 *   and a rule that picks is a rule that can be wrong in silence.
 */
function rosterIdentityConflicts(ctx) {
  const rows = ctx.db
    .prepare("SELECT key, display FROM cast WHERE merged_into IS NULL ORDER BY first_seen_volume IS NULL, first_seen_volume, key")
    .all();
  const keys = new Set(rows.map((row) => row.key));
  const out = [];
  for (const row of rows) {
    if (!isBareFirstPersonPronoun(row.key)) continue;
    /** @type {Map<string, {span: string, token: string}>} */
    const named = new Map();
    for (const span of displayAliasSpans(row.display || "")) {
      for (const token of spanTokens(span)) {
        if (token === row.key) continue;
        if (!keys.has(token)) continue;
        if (!named.has(token)) named.set(token, { span, token });
      }
    }
    for (const [survivor, where] of named) {
      out.push({
        merged: row.key,
        survivor,
        heading: row.display || row.key,
        span: where.span,
        token: where.token,
        ambiguous: named.size > 1,
      });
    }
  }
  return out;
}

/**
 * Which cast entry a name the pipeline produced belongs to.
 *
 * @param {{db: Object}} ctx - Anything with a `db` holding the `cast` table.
 * @param {string} name - The name as the extraction or the document wrote it.
 * @returns {{key: string|null, display: string, resolved: boolean, how: string, unattached: boolean, ambiguous: boolean}}
 *   `resolved: false` means the roster does not carry this name. Then `key` is where the claim goes:
 *   the name's primary form when the store may create a new roster entry for it, or **null** when it may
 *   not — which is the case `unattached: true` reports, and it happens when the name is the word for "I"
 *   (see this module's header) or when two entries both claim it (`ambiguous: true`). A null key is not a
 *   lost claim: the claim is stored with the name it was written under in `extracted_as`, and the audit
 *   prints it.
 */
function resolveExtractionName(ctx, name) {
  const raw = String(name || "").trim();
  const primary = voicePrimaryName(raw) || raw;
  const cast = ctx.db.prepare("SELECT key, display, aliases, merged_into AS mergedInto FROM cast").all();

  /**
   * A merged entry is not an answer. Volume 02's seeded reference still carries volume 01's heading
   * `俺（如月雨露・第二章終盤）`, and volume 02's record has that entry marked as merged into 如月雨露.
   * Resolving onto the merged row would file new claims under a name the roster has already said is the
   * same person as another one — which is how a merged character splits in two again.
   *
   * @param {Object} row
   * @returns {Object} The entry to file under, following one merge hop.
   */
  const survivorOf = (row) => {
    if (!row.mergedInto) return row;
    return cast.find((candidate) => candidate.key === row.mergedInto) || row;
  };

  /**
   * One answer, or none, from a set of roster rows the rule matched.
   *
   * Two entries matching the same name is not a tie to break. It is the record saying two different
   * people go by this name, and picking one by table order would file the claims under a person the
   * evidence does not single out. It is reported instead, and the claims wait where a human can see them.
   *
   * @param {Object[]} matches - Roster rows the rule matched.
   * @param {string} because - How the rule matched, for the report.
   * @returns {{key: string, display: string, resolved: true, how: string, unattached: false, ambiguous: false}|{key: null, display: string, resolved: false, how: string, unattached: true, ambiguous: true}}
   */
  const oneOrNeither = (matches, because) => {
    const survivors = [];
    for (const row of matches) {
      const survivor = survivorOf(row);
      if (!survivors.some((seen) => seen.key === survivor.key)) survivors.push(survivor);
    }
    if (survivors.length === 1) {
      return { key: survivors[0].key, display: survivors[0].display, resolved: true, how: because, unattached: false, ambiguous: false };
    }
    return {
      key: null,
      display: raw,
      resolved: false,
      how: `${because}, and that names ${survivors.length} different roster entries (${survivors.map((row) => row.key).join(", ")}), so the record does not know whose name this is`,
      unattached: true,
      ambiguous: true,
    };
  };

  const exact = cast.find((row) => row.key === raw);
  if (exact) {
    const survivor = survivorOf(exact);
    return {
      key: survivor.key,
      display: survivor.display,
      resolved: true,
      how:
        survivor.key === exact.key
          ? "the roster already has this name"
          : `the roster has this name, and that entry is merged into ${survivor.key}`,
      unattached: false,
      ambiguous: false,
    };
  }

  // A recorded alias before a primary-name inference, on purpose. The alias is something an operator
  // declared with a reason; "the primary name happens to be a key" is a guess, and it is a guess whose
  // answer changes between the first run and the second, because the first run may have created the key
  // it then matches. See this module's header for the volume-01 measurement.
  const aliasMatches = cast.filter((row) => {
    let aliases = [];
    try {
      aliases = JSON.parse(row.aliases || "[]");
    } catch {
      aliases = [];
    }
    return aliases.some((alias) => alias === raw || alias === primary);
  });
  if (aliasMatches.length) {
    return oneOrNeither(aliasMatches, `${primary} is an alias recorded on ${aliasMatches.map((row) => survivorOf(row).key).join(", ")}`);
  }

  const byKey = cast.filter((row) => row.key === primary);
  if (byKey.length) {
    return oneOrNeither(byKey, `its primary name ${primary} is a roster entry`);
  }

  const headingMatches = cast.filter(
    (row) => displayAliasSpans(row.display).some((span) => span === raw || span === primary)
  );
  if (headingMatches.length) {
    return oneOrNeither(
      headingMatches,
      `${primary} is an alias in the heading of ${headingMatches.map((row) => survivorOf(row).key).join(", ")}`
    );
  }

  // Last, and only after every explicit link has failed: the name's own bracketed label contains a
  // roster key as a whole token, and the name itself is the word for "I". This is the volume-01 shape —
  // 俺（如月雨露・第二章終盤） resolves to nothing under the four rules above, and the entry it creates is
  // the phantom this module's header describes. Asked last, it cannot capture a name an operator already
  // linked somewhere else; gated on the pronoun, it cannot fold a character into their own nickname.
  if (isBareFirstPersonPronoun(primary)) {
    const spans = displayAliasSpans(raw);
    const labelMatches = cast.filter((row) => {
      if (row.key === primary || row.key === raw) return false;
      return spans.some((span) => spanTokens(span).includes(row.key));
    });
    if (labelMatches.length) {
      return oneOrNeither(labelMatches, `its own label names ${labelMatches.map((row) => row.key).join(", ")}, which is a roster entry`);
    }

    // **A bare first-person pronoun is never a roster key.** It used to fall through to the last line of
    // this function and become one, and that is how volume 02 ended up with 282 of the protagonist's
    // claims under `俺` and 190 under 如月雨露: the extractor wrote `俺（ジョーロ）`, whose primary form is
    // the pronoun, and the store made a character out of the word for "I" (gotcha 115).
    //
    // The rule is not "refuse the claim", it is "refuse to invent a person". The claim is filed with no
    // roster entry, carrying the name it was written under, and the audit prints it. That is the same
    // shape the record already uses for a point-of-view claim that names nobody, and it is the shape a
    // human can act on: `castAlias(key, "俺", reason)` is the door that says whose "I" this is, and it
    // requires the reason the record is missing.
    return {
      key: null,
      display: raw,
      resolved: false,
      how:
        `"${primary}" is the word for "I", not a name this book gives anybody, and nothing in the record says whose "I" it is. ` +
        "The claim is filed unattached rather than under a pronoun dressed as a character name.",
      unattached: true,
      ambiguous: false,
    };
  }

  return { key: primary, display: raw, resolved: false, how: "nothing in the roster carries this name", unattached: false, ambiguous: false };
}

module.exports = {
  BARE_FIRST_PERSON_PRONOUNS,
  isBareFirstPersonPronoun,
  voicePrimaryName,
  displayAliasSpans,
  spanTokens,
  rosterIdentityConflicts,
  resolveExtractionName,
};
