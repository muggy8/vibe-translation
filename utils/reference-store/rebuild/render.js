/**
 * utils/reference-store/rebuild/render.js — render the volume's character-voice reference out of its
 * record, in chapter order.
 *
 * Sections come in the order the volume's chapters come, keyed on the earliest chapter any of that
 * character's claims cites; bullets within a section the same way. Each bullet carries the claim's own
 * verified quotes inline, so the file is self-citing, and a line over the read limit is capped **and
 * named as truncated** rather than becoming the 54,341-character line that destroyed volume 01.
 *
 * ## The arc line (plan 06 slice 6)
 *
 * A superseded claim is already absent from every *current* answer — `currentClaimSql` excludes a row a
 * live row supersedes, and that is what the render's bullets, the chapter's known-facts block and the axis
 * queries all read. What the record had to gain was the other half: **what it used to stand behind, and
 * from which volume**. Without it a character who changed is rendered as a character who was described
 * wrongly, and the file gives a translator no way to tell those two apart.
 *
 * So each section carries its replaced answers as one italic line each, under its heading and **before**
 * its bullets. The position is not cosmetic. `parseVoiceMarkdown` treats a non-bullet line after the first
 * bullet as a *continuation of that bullet* and glues it onto the claim's body; the same line before the
 * first bullet is the section's own prose and is stored as document prose. Placing the arc after the
 * bullets would corrupt a published claim on the way back in, which is the one thing this file must not do
 * to a file it also re-imports.
 *
 * It is therefore **not a bullet and not a claim**: it files no row, it is not evidence for anything, and
 * it is capped and named like every other cap here.
 *
 * ## The confirmation line (plan 06 slice 7)
 *
 * The other non-bullet line a section carries. `claim_confirmations` records that a later volume's own text
 * contained the character a claim is about — the observation that turns "this claim still holds" from an
 * assumption into a list — and the line prints it as `Confirmed in volumes 2, 3 and 5 — **Label**: "…"`.
 *
 * Same position rule as the arc, same reason: **before the first bullet**, because a non-bullet line after
 * the first bullet is glued onto that bullet's body by `parseVoiceMarkdown` and the next re-import would
 * rewrite a published claim with nothing announcing it (gotcha 157). Same cap, same named remainder.
 *
 * It quotes a **fragment** of the claim rather than the claim, because the bullet carrying the whole claim
 * is printed directly below it and the plan's reason for making a confirmation its own row was that copying
 * a body once per volume that saw it is the defect (§5). A confirmation is never a bullet, never reaches
 * `facts`, and never reaches the chapter block a reading pass is shown — the render is the only place it
 * becomes visible, and the render reads it out of its own table.
 *
 * @module utils/reference-store/rebuild/render
 */

const { EXTRACTION_SOURCE_STAGE } = require("../schema");
const { currentClaimSql } = require("../facts");
const { supersededVoiceClaims } = require("../voice-revision/rows");
// The confirmations read (plan 06 slice 7). Read-only, and the same read the stage's log line asks, so
// "which volumes saw this claim again" has one answer.
const { confirmationsForCharacter } = require("../confirmations/rows");

const {
  REBUILT_VOICE_TITLE,
  REBUILT_VOICE_SECTION,
  MAX_REBUILD_BULLET_CHARS,
  REBUILT_EXAMPLES_PER_BULLET,
  MAX_REBUILD_ARC_LINES_PER_CHARACTER,
  MAX_REBUILD_CONFIRMATION_LINES_PER_CHARACTER,
  MAX_REBUILD_CONFIRMATION_BODY_CHARS,
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
 * Keep one rendered line inside the read limit, and say out loud when it had to.
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
 * One answer this record replaced, as the line its character's section prints for it.
 *
 * The wording is the whole design, so it is stated here rather than guessed at by a reader:
 *
 *   - **It quotes the replaced claim in straight double quotes.** `drafting.js`'s repeated-token shape
 *     reads `'…'` and `“…”`; a double-quoted span is not one of its token patterns, so reproducing an
 *     older claim's wording here cannot manufacture the "quotes the same span three times beside its own
 *     correction" defect. The claim's own words are reproduced, not paraphrased, because the point of the
 *     line is that a reader can see what changed.
 *   - **It carries no parentheses and no self-correction phrase.** `no longer`, `not present`, a bracketed
 *     aside: every one of those is a marker `drafting.js` reports at MEDIUM when it appears in the
 *     artifact, and an arc line is not a defect. "was the answer from volume X until volume Y" says the
 *     same thing in a shape the audit does not flag.
 *   - **It names both volumes.** Which volume the answer held from, and which volume replaced it, are the
 *     two facts a translator needs in order to know which chapters the old description was written for.
 *
 * @param {{body: string, label: string|null, appliesFromVolume: number, replacedBy: Array<{appliesFromVolume: number}>}} row
 * @returns {string}
 */
function renderArcLine(row) {
  const label = row.label || "Notes";
  const replacedBy = row.replacedBy[0];
  const body = String(row.body || "").replace(/\s*\n\s*/g, " ").trim();
  const line =
    `_Earlier in this record — **${label}**: "${body}" was the answer from volume ${row.appliesFromVolume} ` +
    `until volume ${Number(replacedBy.appliesFromVolume)}._`;
  return fitBullet(line, MAX_REBUILD_BULLET_CHARS);
}

/**
 * "Volumes 2, 3 and 5", or "volume 2" — the list a confirmation line names.
 *
 * @param {Array<number>} volumes - Ascending, because {@link confirmationsForCharacter} returns them in the
 *   order the volumes confirmed the claim.
 * @returns {string}
 */
function renderVolumeList(volumes) {
  const list = volumes.map((volume) => Number(volume));
  if (list.length === 1) return `volume ${list[0]}`;
  return `volumes ${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

/**
 * One claim this record has seen again, as the line its character's section prints for it.
 *
 * The wording is chosen against `drafting.js`, the same way the arc line's was, because this file writes an
 * artifact the store reads back and the audit scans line by line:
 *
 *   - **The claim is quoted in straight double quotes.** `drafting.js`'s repeated-token shape reads `'…'`
 *     and `“…”`; a double-quoted span is not one of its token patterns.
 *   - **No parentheses and no self-correction phrase.** Every marker `drafting.js` reports at MEDIUM lives
 *     in one or the other, and a confirmation is not a defect.
 *   - **It quotes a fragment, not the body.** The bullet carrying the full claim is three lines below; the
 *     line's job is to say *which* bullet was seen again and *where*. Copying the body once per confirming
 *     volume is the shape plan 06 §5 rejected for the record, and printing it is the same mistake in the
 *     artifact.
 *
 * @param {{label: string|null, body: string, volumes: Array<number>}} group
 * @returns {string}
 */
function renderConfirmationLine(group) {
  const label = group.label || "Notes";
  const body = String(group.body || "").replace(/\s*\n\s*/g, " ").trim();
  const fragment = body.length > MAX_REBUILD_CONFIRMATION_BODY_CHARS ? `${body.slice(0, MAX_REBUILD_CONFIRMATION_BODY_CHARS - 1)}…` : body;
  const line = `_Confirmed in ${renderVolumeList(group.volumes)} — **${label}**: "${fragment}"._`;
  return fitBullet(line, MAX_REBUILD_BULLET_CHARS);
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
 * @returns {{markdown: string, opening: string[], sections: number, characters: Array<{key: string, display: string, bullets: number, arc: number, arcOmitted: number, confirmed: number, confirmedOmitted: number, firstChapter: string|null}>, unattached: number, truncated: number}}
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

  /**
   * The arc, read once for the whole record and grouped by character.
   *
   * Read through `voice-revision/rows.js` rather than by walking `supersedes` here, so there is one
   * answer to "what did this record used to stand behind" — the same answer the revision door asks.
   * Bounded by the same volume the bullets are bounded by: a replacement that has not happened yet at
   * this volume is not part of this volume's history.
   *
   * @type {Map<string, Array<Object>>}
   */
  const arcByKey = new Map();
  for (const row of supersededVoiceClaims(store, { volume: vol })) {
    if (row.key === null || row.key === undefined) continue;
    if (!arcByKey.has(row.key)) arcByKey.set(row.key, []);
    arcByKey.get(row.key).push(row);
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

    // The replaced answers, under the heading and **before** the bullets: after the first bullet a
    // non-bullet line is a continuation of that bullet, and `importVoice` would glue this line onto a
    // published claim's body on the way back in. Before the bullets it is the section's own prose.
    const arc = arcByKey.get(character.key) || [];
    const shown = arc.slice(0, MAX_REBUILD_ARC_LINES_PER_CHARACTER);
    for (const replaced of shown) out.push(renderArcLine(replaced));
    const arcOmitted = arc.length - shown.length;
    if (arcOmitted > 0) {
      out.push(`_${arcOmitted} more earlier answer(s) for this character are in this volume's reference record._`);
    }

    // The confirmations, also **before** the bullets and for the same reason the arc lines are: after the
    // first bullet a non-bullet line is a continuation of that bullet, and `importVoice` would glue this
    // line onto a published claim's body on the way back in. They come after the arc lines and before the
    // bullets because they describe the bullets: this is the claim, and these are the volumes that saw it
    // again.
    //
    // They are read through `confirmations/rows.js`, which filters on `currentClaimSql` and the span, so a
    // confirmation of a claim this record has since replaced is not printed — it is a true fact about the
    // past, and this file renders what the record stands behind at this volume.
    const confirmed = confirmationsForCharacter(store, { key: character.key, volume: vol });
    const confirmedShown = confirmed.slice(0, MAX_REBUILD_CONFIRMATION_LINES_PER_CHARACTER);
    for (const group of confirmedShown) out.push(renderConfirmationLine(group));
    const confirmedOmitted = confirmed.length - confirmedShown.length;
    if (confirmedOmitted > 0) {
      out.push(`_${confirmedOmitted} more claim(s) about this character were confirmed in another volume; they are in this volume's reference record._`);
    }
    if (shown.length || arcOmitted > 0 || confirmedShown.length || confirmedOmitted > 0) out.push("");

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
      arc: shown.length,
      arcOmitted,
      confirmed: confirmedShown.length,
      confirmedOmitted,
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
