/**
 * utils/reference-store/rebuild/render.js — render the volume's character-voice reference out of its
 * record, in chapter order.
 *
 * Sections come in the order the volume's chapters come, keyed on the earliest chapter any of that
 * character's claims cites; bullets within a section the same way. Each bullet carries the claim's own
 * verified quotes inline, so the file is self-citing, and a line over the read limit is capped **and
 * named as truncated** rather than becoming the 54,341-character line that destroyed volume 01.
 *
 * @module utils/reference-store/rebuild/render
 */

const { EXTRACTION_SOURCE_STAGE } = require("../schema");
const { currentClaimSql } = require("../facts");

const {
  REBUILT_VOICE_TITLE,
  REBUILT_VOICE_SECTION,
  MAX_REBUILD_BULLET_CHARS,
  REBUILT_EXAMPLES_PER_BULLET,
  TRUNCATION_NOTE,
} = require("./labels");
require("../../../types"); // JSDoc type definitions

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
        `WHERE f.key IS NOT NULL AND f.source_stage != ? AND ${currentClaimSql("f")} AND c.merged_into IS NULL ` +
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

module.exports = {
  renderRebuiltVoice,
};
