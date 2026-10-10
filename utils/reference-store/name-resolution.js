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
  const cast = ctx.db.prepare("SELECT key, display, aliases FROM cast").all();

  const exact = cast.find((row) => row.key === raw);
  if (exact) return { key: exact.key, display: exact.display, resolved: true, how: "the roster already has this name" };

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
      return { key: row.key, display: row.display, resolved: true, how: `${primary} is an alias recorded on ${row.key}` };
    }
  }

  const byKey = cast.find((row) => row.key === primary);
  if (byKey) return { key: byKey.key, display: byKey.display, resolved: true, how: `its primary name ${primary} is a roster entry` };

  for (const row of cast) {
    if (displayAliasSpans(row.display).some((span) => span === raw || span === primary)) {
      return { key: row.key, display: row.display, resolved: true, how: `${primary} is an alias in the heading of ${row.key}` };
    }
  }

  return { key: primary, display: raw, resolved: false, how: "nothing in the roster carries this name" };
}

module.exports = {
  displayAliasSpans,
  resolveExtractionName,
};
