/**
 * utils/reference-store/pov-map.js — render one volume's POV map **from its reference record**.
 *
 * Why this file exists. `character-voice/qa.js`'s acceptance check hands the grader three files:
 * the character-voice reference, the validation report, and `pov-map.md`. The harness refuses a
 * named file message whose file is not there, so a route that publishes the reference but not the
 * POV map cannot be graded by the stage's own gate at all — and the fix that was proposed for that
 * (drop the POV map from the grader's message list) would have lowered the rubric to fit the route.
 * This file closes the gap from the other side: the claims the record already holds are rendered
 * into the artifact the gate expects, with no model call.
 *
 * ## What is rendered, and what is not
 *
 * The rows are the same ones `renderRebuiltVoice` renders, filtered the same way: `aspect = 'pov'`,
 * `source_stage != 'extract'`, and a key that has not been folded into another roster entry. The
 * candidate rule is untouched — extraction-only rows are still not published. What is different is
 * the **unattached** rows: a POV claim with no character cannot live in a character section, so
 * `renderVoice` drops it and reports how many it dropped. A POV map is organised by chapter, not by
 * character, so those claims have a home here. They are rendered, and they are named as what they
 * are — an observation about a chapter, not about a person.
 *
 * ## Cumulative, in the same sense the character reference is
 *
 * The record this volume was opened with already carries every earlier volume's sealed rows in it
 * (`copy-forward.js`), so rendering the record renders the accumulated map: volume 1's chapters
 * first, then this volume's, each in the order its own source prints them. That is a change to the
 * artifact's contract — the route this one replaced said `pov-map.md` describes **only this volume**
 * (that route is gone; its wording is in git history at commit 75e59a7) — and it is a deliberate one:
 * the claims being carried
 * are sealed rows of the same record the cumulative reference is rendered from, and a per-volume map
 * would silently drop the point-of-view history the reference keeps. The translation stage is not
 * flooded by it: `utils/translate/references.js` injects at most 2,000 characters of this file,
 * chosen by which sections the chapter being translated actually matches.
 *
 * ## What this file does NOT do
 *
 * It files nothing, seals nothing, and updates nothing. Every function here reads the record and
 * writes one file. That is what makes it legal to run against a **sealed** volume: publishing a map
 * the record's own published rows describe edits no row, and `renderPovMapFromRecord` opens the
 * store with `create: false` so it cannot even make an empty record on the way past.
 *
 * @module utils/reference-store/pov-map
 */

const fs = require("fs");
const path = require("path");

const { openReferenceStore } = require("./open");
const { EXTRACTION_SOURCE_STAGE } = require("./schema");
const { currentClaimSql } = require("./facts");
const { refusal } = require("./refusals");
const { moveArtifactAside } = require("./quarantine");
require("../../types"); // JSDoc type definitions

/** The artifact this file renders, and the name the acceptance check asks the harness for. */
const POV_MAP_FILE = "pov-map.md";

/** The heading the rendered file opens with. The series name is appended when the caller knows it. */
const POV_MAP_TITLE = "# POV Map";

/**
 * How the record's unattached POV claims are labelled.
 *
 * It is a label, not a character: a claim the extractor never attached to anybody is an observation
 * about the chapter, and printing it under a made-up name would invent a person.
 */
const POV_UNATTACHED_LABEL = "chapter-level observation";

/**
 * How long one rendered **line** may be — the same shape rule `renderRebuiltVoice` enforces.
 *
 * The artifact-shape check reports a line longer than an agent's file tools can read as HIGH, and a
 * POV claim's body is exactly the kind of text that gets long: it is a paragraph about who is seeing
 * what. Kept separate from the reference's own cap because the two files are read differently.
 */
const MAX_POV_BULLET_CHARS = 1200;

/** The note a bullet carries when it had to be cut. */
const POV_TRUNCATION_NOTE = "…[truncated: the record's full claim text is longer than one line]";

/**
 * The punctuation the renderer reports on.
 *
 * Japanese light novels mark scene and viewpoint breaks with a small family of symbols, and the
 * record's own claims quote them. This is not a claim that these are the only markers: it is the
 * list of symbols this renderer is willing to count, so the map says which ones its claims name.
 */
const POV_MARKER_SYMBOLS = ["※", "☆", "★", "◇", "○", "●", "△", "▽", "▲", "◆", "■"];

/**
 * The order key of one row: the volume it was established in, then where its chapter sits in that
 * volume's own source, then the row's own insertion order.
 *
 * @param {{established_volume: number, established_chapter: string|null, ord: number}} row
 * @param {Map<string, number>} chapterOrder - `volume:chapter` → its position in that volume's source.
 * @returns {[number, number, number]}
 */
function povRowOrderKey(row, chapterOrder) {
  const ord = chapterOrder.get(`${row.established_volume}:${row.established_chapter}`);
  return [
    Number(row.established_volume),
    ord === undefined ? Number.MAX_SAFE_INTEGER : ord,
    Number(row.ord),
  ];
}

/**
 * Every point-of-view claim this volume's record has adopted, in reading order.
 *
 * The filter is `renderRebuiltVoice`'s filter, spelled the same way: adopted rows only, and a key
 * that has been folded into another roster entry does not produce its own bullets. Unattached rows
 * are included, because a chapter section does not need a character to hang a claim on.
 *
 * @param {ReferenceStore} store
 * @param {{volume?: number}} [opts]
 * @returns {Array<{id: number, key: string|null, display: string, label: string|null, body: string, examples: Array<string>, established_volume: number, established_chapter: string|null, source_stage: string}>}
 */
function povClaimsInRecord(store, { volume } = {}) {
  const vol = Number(volume === undefined ? store.volume : volume);
  /** @type {Map<string, number>} */
  const chapterOrder = new Map();
  /** @type {Map<string, string|null>} */
  const chapterTitles = new Map();
  for (const row of store.db.prepare("SELECT volume, chapter_id, ord, title FROM chapters").all()) {
    const key = `${row.volume}:${row.chapter_id}`;
    chapterOrder.set(key, row.ord);
    chapterTitles.set(key, row.title === null || row.title === undefined || row.title === "" ? null : String(row.title));
  }

  const rows = store.db
    .prepare(
      "SELECT f.id, f.key, f.label, f.body, f.examples, f.ord, f.established_volume, f.established_chapter, " +
        "f.source_stage, c.display AS display " +
        "FROM facts f LEFT JOIN cast c ON c.key = f.key " +
        `WHERE f.aspect = 'pov' AND f.source_stage != ? AND ${currentClaimSql("f")} ` +
        "AND (f.key IS NULL OR c.merged_into IS NULL) " +
        "AND f.established_volume <= ? " +
        "ORDER BY f.established_volume, f.ord, f.id"
    )
    .all(EXTRACTION_SOURCE_STAGE, vol);

  return rows
    .map((row) => ({
      id: Number(row.id),
      key: row.key === null ? null : String(row.key),
      display: row.display || row.key || POV_UNATTACHED_LABEL,
      label: row.label || "Point of view",
      body: String(row.body || ""),
      examples: (() => {
        try {
          const parsed = JSON.parse(row.examples || "[]");
          return Array.isArray(parsed) ? parsed.map(String) : [];
        } catch {
          return [];
        }
      })(),
      established_volume: Number(row.established_volume),
      established_chapter: row.established_chapter === null ? null : String(row.established_chapter),
      chapter_title: chapterTitles.get(`${row.established_volume}:${row.established_chapter}`) || null,
      source_stage: String(row.source_stage),
      _order: povRowOrderKey(row, chapterOrder),
    }))
    .sort((a, b) => {
      const ka = a._order;
      const kb = b._order;
      return ka[0] !== kb[0] ? ka[0] - kb[0] : ka[1] !== kb[1] ? ka[1] - kb[1] : ka[2] - kb[2];
    });
}

/**
 * One claim as a line: its body, then up to three of the quoted spans it cites.
 *
 * @param {{body: string, examples: Array<string>}} claim
 * @returns {string}
 */
function renderPovClaimText(claim) {
  const spans = [];
  for (const example of claim.examples || []) {
    const span = String(example).replace(/^「|」$|^“|”$/g, "").trim();
    if (!span) continue;
    spans.push(span.startsWith("「") || span.startsWith("“") ? span : `「${span}」`);
    if (spans.length >= 3) break;
  }
  return `${claim.body}${spans.length ? ` — e.g. ${spans.join(" / ")}` : ""}`;
}

/**
 * Keep one bullet inside the line budget, and say out loud when it had to.
 *
 * @param {string} text
 * @param {number} budget - How many characters the body may use once the `- **Name** — label: ` prefix is counted.
 * @returns {{text: string, truncated: boolean}}
 */
function fitPovBullet(text, budget) {
  const clean = String(text || "").replace(/\s*\n\s*/g, " ").trim();
  if (clean.length <= budget) return { text: clean, truncated: false };
  return { text: `${clean.slice(0, Math.max(0, budget - POV_TRUNCATION_NOTE.length - 1))}${POV_TRUNCATION_NOTE}`, truncated: true };
}

/**
 * Which of the marker symbols the record's own claims name, and how many claims name each.
 *
 * This is a count over the claims, not a census of the book: it answers "which symbols do these
 * claims talk about", and the rendered file says that in as many words rather than pretending to be
 * the per-chapter marker tally an author agent would have written.
 *
 * @param {Array<{body: string, examples: Array<string>}>} claims
 * @returns {Array<{marker: string, claims: number}>}
 */
function povMarkersNamed(claims) {
  const counts = new Map();
  for (const claim of claims) {
    const haystack = `${claim.body}\n${(claim.examples || []).join("\n")}`;
    for (const marker of POV_MARKER_SYMBOLS) {
      if (!haystack.includes(marker)) continue;
      counts.set(marker, (counts.get(marker) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([marker, n]) => ({ marker, claims: n }))
    .sort((a, b) => b.claims - a.claims || a.marker.localeCompare(b.marker));
}

/**
 * One chapter's heading in the rendered map.
 *
 * The chapter's own title when the record has one — `第二章 僕と俺のバトンタッチ` is what the book
 * calls it, and a reader tracing a viewpoint break is looking for that, not for a filename. The id is
 * kept beside it because it is the handle every evidence citation uses, and a map that dropped it
 * would be easier to read and impossible to check.
 *
 * @param {{volume: number, chapterId: string|null, title?: string|null}} chapter
 * @returns {string}
 */
function povChapterHeading(chapter) {
  const volume = `Volume ${String(chapter.volume).padStart(2, "0")}`;
  if (chapter.chapterId === null) return `## ${volume} · (no chapter recorded)`;
  const title = String(chapter.title || "").replace(/\s+/g, " ").trim();
  const base = `## ${volume} · chapter ${chapter.chapterId}`;
  return title ? `${base} — ${title}` : base;
}

/**
 * Render this volume's POV map from its record: every adopted point-of-view claim, grouped by the
 * chapter it cites, chapters in reading order, earlier volumes first.
 *
 * @param {ReferenceStore} store
 * @param {{volume?: number, seriesName?: string|null, preamble?: string[]}} [opts]
 * @returns {{markdown: string, claims: number, attached: number, unattached: number, carriedClaims: number, ownClaims: number, chapters: Array<{volume: number, chapterId: string|null, title: string|null, claims: number, characters: number}>, volumes: number[], markers: Array<{marker: string, claims: number}>, truncated: number}}
 */
function renderPovMap(store, { volume, seriesName = null, preamble = null } = {}) {
  const vol = Number(volume === undefined ? store.volume : volume);
  const claims = povClaimsInRecord(store, { volume: vol });

  /** @type {Array<{volume: number, chapterId: string|null, claims: Array<Object>}>} */
  const chapters = [];
  /** @type {Map<string, Object>} */
  const byChapter = new Map();
  for (const claim of claims) {
    const id = `${claim.established_volume}:${claim.established_chapter}`;
    if (!byChapter.has(id)) {
      const entry = {
        volume: claim.established_volume,
        chapterId: claim.established_chapter,
        title: claim.chapter_title,
        claims: [],
      };
      byChapter.set(id, entry);
      chapters.push(entry);
    }
    byChapter.get(id).claims.push(claim);
  }

  const title = seriesName ? `${POV_MAP_TITLE} — ${seriesName}, Volume ${vol}` : `${POV_MAP_TITLE} — Volume ${vol}`;
  const out = [title, ""];
  for (const line of preamble || defaultPovPreamble(vol)) out.push(line, "");

  const markers = povMarkersNamed(claims);
  const carriedVolumes = [...new Set(claims.map((c) => c.established_volume))].filter((v) => v !== vol).sort((a, b) => a - b);
  out.push(
    `**What is in this map:** ${claims.length} point-of-view claim(s) over ${chapters.length} chapter(s) — ` +
      `${claims.filter((c) => c.established_volume === vol).length} established in volume ${vol}, ` +
      (carriedVolumes.length
        ? `${claims.length - claims.filter((c) => c.established_volume === vol).length} carried forward from volume${carriedVolumes.length > 1 ? "s" : ""} ${carriedVolumes.map((v) => String(v).padStart(2, "0")).join(" and ")}.`
        : "none carried from an earlier volume.")
  );
  out.push("");
  out.push(
    markers.length
      ? `**Markers these claims name:** ${markers.map((m) => `\`${m.marker}\` (${m.claims} claim${m.claims === 1 ? "" : "s"})`).join(", ")}.`
      : `**Markers these claims name:** none — no claim in this map quotes a section or viewpoint marker symbol.`
  );
  out.push("", `_The marker line counts the claims in this map, not the book: it says which markers the record talks about, not how many times each appears in the text._`, "");

  let truncated = 0;
  /** @type {Array<{volume: number, chapterId: string|null, claims: number, characters: number}>} */
  const chapterReports = [];
  for (const chapter of chapters) {
    const heading = povChapterHeading(chapter);
    out.push(heading, "");
    const names = new Set();
    for (const claim of chapter.claims) {
      const prefix = `- **${claim.display}** — ${claim.label}: `;
      const fitted = fitPovBullet(renderPovClaimText(claim), MAX_POV_BULLET_CHARS - prefix.length);
      if (fitted.truncated) truncated += 1;
      out.push(`${prefix}${fitted.text}`);
      if (claim.key) names.add(claim.key);
    }
    out.push("");
    chapterReports.push({
      volume: chapter.volume,
      chapterId: chapter.chapterId,
      title: chapter.title || null,
      claims: chapter.claims.length,
      characters: names.size,
    });
  }

  const attached = claims.filter((c) => c.key !== null).length;
  return {
    markdown: out.join("\n").replace(/\n+$/, "") + "\n",
    claims: claims.length,
    attached,
    unattached: claims.length - attached,
    carriedClaims: claims.filter((c) => c.established_volume !== vol).length,
    ownClaims: claims.filter((c) => c.established_volume === vol).length,
    chapters: chapterReports,
    volumes: [...new Set(claims.map((c) => c.established_volume))].sort((a, b) => a - b),
    markers,
    truncated,
  };
}

/**
 * The preamble the rendered map carries: what it is, and what its bullets are.
 *
 * @param {number} vol
 * @returns {string[]}
 */
function defaultPovPreamble(vol) {
  return [
    `_Rendered by code from volume ${vol}'s reference record; no author agent wrote this file._`,
    `_It carries every earlier volume's sealed point-of-view claims forward, in the order the chapters they cite appear. Each bullet is a claim the record adopted — one that cites a line of the volume it was established in._`,
  ];
}

/**
 * Write the rendered map into a volume folder.
 *
 * An existing `pov-map.md` that is not what this record renders is somebody else's work — an author
 * agent wrote it — so it is moved aside as evidence rather than overwritten, and only when the
 * caller says so. Same rule, same refusal, as the rebuilt reference.
 *
 * @param {string} volumeDir
 * @param {{markdown: string}} rendered
 * @param {{file?: string, moveAside?: boolean}} [opts]
 * @returns {{ok: boolean, written: string|null, moved: string|null, unchanged: boolean, asideSlot: number, keptAside: string[], refusal: ReferenceRefusal|null}}
 */
function writePovMapFile(volumeDir, rendered, { file = POV_MAP_FILE, moveAside = false } = {}) {
  const target = path.join(volumeDir, file);
  let unchanged = false;
  if (fs.existsSync(target)) {
    try {
      unchanged = fs.readFileSync(target, "utf8") === rendered.markdown;
    } catch {
      unchanged = false;
    }
  }
  if (fs.existsSync(target) && !unchanged && !moveAside) {
    return {
      ok: false,
      written: null,
      moved: null,
      unchanged: false,
      refusal: refusal({
        verb: "write_pov_map",
        rule: "pov-map-will-not-overwrite-an-artifact",
        because: `${target} already exists and is not what this record renders. A rendered map replaces an authored one only when somebody says so; the authored file is kept as \`${file}.rejected\`, never silently overwritten.`,
        useInstead: ["moveArtifactAside(volumeDir, file) — keep the authored map as evidence, then write", "keep the authored map and do not render one"],
        fix: "say what to do with the existing POV map before rendering one over it.",
      }),
    };
  }

  let moved = null;
  /** @type {{slot: number, keptAside: string[]}} */
  let asideReport = { slot: 0, keptAside: [] };
  // The shared door: "move the old file aside" is not a statement that an old file exists (on a volume's
  // first run it does not), and a second rejection must not spend the first one.
  if (moveAside && !unchanged && fs.existsSync(target)) {
    const aside = moveArtifactAside(volumeDir, file);
    if (!aside.ok) {
      return { ok: false, written: null, moved: null, unchanged: false, asideSlot: 0, keptAside: [], refusal: aside.refusal };
    }
    moved = aside.moved;
    asideReport = { slot: aside.slot, keptAside: aside.keptAside.map((p) => path.basename(p)) };
  }

  const temp = `${target}.writing`;
  fs.writeFileSync(temp, rendered.markdown, "utf8");
  fs.renameSync(temp, target);
  return { ok: true, written: target, moved, unchanged, asideSlot: asideReport.slot, keptAside: asideReport.keptAside, refusal: null };
}

/**
 * Render one volume's POV map **from the record as it stands**, filing nothing and sealing nothing.
 *
 * This is the door that makes publishing a map for a sealed volume legitimate rather than a
 * workaround: the store is opened with `create: false` (so a missing record is a refusal, not a
 * freshly created empty one), the render is a read, and the only write is the artifact file. No row
 * is added, changed, or deleted, and the volume's sealed state is reported, not altered.
 *
 * @param {Object} opts
 * @param {number|string} opts.volume
 * @param {string} [opts.folder]
 * @param {string} [opts.seriesDir]
 * @param {{volume?: number, seriesName?: string|null}} [opts.render]
 * @returns {{ok: boolean, refusal: ReferenceRefusal|null, rendered: Object|null, sealed: boolean, file: string}}
 */
function renderPovMapFromRecord({ volume, folder, seriesDir, render = {} }) {
  const resolvedFile = (() => {
    try {
      return openReferenceStore({ volume, folder, seriesDir, stage: "render", create: false });
    } catch (err) {
      return null;
    }
  })();
  if (!resolvedFile) {
    return {
      ok: false,
      refusal: refusal({
        verb: "render_pov_map",
        rule: "pov-map-needs-a-record",
        because: `volume ${volume} has no reference record to render a POV map from. The map is rendered from the claims the record holds; with no record there is nothing to render.`,
        useInstead: ["extract-voice.js --volume=<NN> then rebuild-voice.js --volume=<NN> --apply", "run the character-voice stage, which opens and carries the record"],
        fix: "point the command at the volume folder whose series.db already holds its record.",
      }),
      rendered: null,
      sealed: false,
      file: POV_MAP_FILE,
    };
  }
  try {
    const rendered = renderPovMap(resolvedFile, { volume, ...render });
    return {
      ok: true,
      refusal: null,
      rendered,
      sealed: resolvedFile.isVolumeSealed(resolvedFile.volume),
      file: POV_MAP_FILE,
    };
  } finally {
    resolvedFile.close();
  }
}

module.exports = {
  POV_MAP_FILE,
  POV_MAP_TITLE,
  POV_UNATTACHED_LABEL,
  MAX_POV_BULLET_CHARS,
  POV_MARKER_SYMBOLS,
  povChapterHeading,
  povClaimsInRecord,
  renderPovMap,
  writePovMapFile,
  renderPovMapFromRecord,
};
