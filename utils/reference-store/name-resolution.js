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
 * @returns {{key: string, display: string, resolved: boolean, how: string}}
 *   `resolved: false` means the roster does not carry this name: `key` is then the name's primary
 *   form, and the caller is filing a NEW roster entry rather than attaching to an existing one.
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
    };
  }

  // A recorded alias before a primary-name inference, on purpose. The alias is something an operator
  // declared with a reason; "the primary name happens to be a key" is a guess, and it is a guess whose
  // answer changes between the first run and the second, because the first run may have created the key
  // it then matches. See this module's header for the volume-01 measurement.
  for (const row of cast) {
    let aliases = [];
    try {
      aliases = JSON.parse(row.aliases || "[]");
    } catch {
      aliases = [];
    }
    if (aliases.some((alias) => alias === raw || alias === primary)) {
      const survivor = survivorOf(row);
      return {
        key: survivor.key,
        display: survivor.display,
        resolved: true,
        how: `${primary} is an alias recorded on ${survivor.key}`,
      };
    }
  }

  const byKey = cast.find((row) => row.key === primary);
  if (byKey) {
    const survivor = survivorOf(byKey);
    return {
      key: survivor.key,
      display: survivor.display,
      resolved: true,
      how: `its primary name ${primary} is a roster entry${survivor.key === byKey.key ? "" : `, which ${byKey.key} is merged into`}`,
    };
  }

  for (const row of cast) {
    if (displayAliasSpans(row.display).some((span) => span === raw || span === primary)) {
      const survivor = survivorOf(row);
      return {
        key: survivor.key,
        display: survivor.display,
        resolved: true,
        how: `${primary} is an alias in the heading of ${survivor.key}`,
      };
    }
  }

  // Last, and only after every explicit link has failed: the name's own bracketed label contains a
  // roster key as a whole token, and the name itself is the word for "I". This is the volume-01 shape —
  // 俺（如月雨露・第二章終盤） resolves to nothing under the four rules above, and the entry it creates is
  // the phantom this module's header describes. Asked last, it cannot capture a name an operator already
  // linked somewhere else; gated on the pronoun, it cannot fold a character into their own nickname.
  if (isBareFirstPersonPronoun(primary)) {
    const spans = displayAliasSpans(raw);
    for (const row of cast) {
      if (row.key === primary || row.key === raw) continue;
      if (spans.some((span) => spanTokens(span).includes(row.key))) {
        const survivor = survivorOf(row);
        return {
          key: survivor.key,
          display: survivor.display,
          resolved: true,
          how: `its own label names ${row.key}, which is a roster entry`,
        };
      }
    }
  }

  return { key: primary, display: raw, resolved: false, how: "nothing in the roster carries this name" };
}

module.exports = {
  BARE_FIRST_PERSON_PRONOUNS,
  isBareFirstPersonPronoun,
  displayAliasSpans,
  spanTokens,
  rosterIdentityConflicts,
  resolveExtractionName,
};
