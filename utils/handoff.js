/**
 * utils/handoff.js — Deterministic per-volume translation handoff artifacts.
 *
 * After the four pre-production tasks have written their per-volume snapshots
 * (glossary.md, character-voice.md, style-guide.md, wiki.md, pov-map.md —
 * each reflecting the series state THROUGH this volume), a translator
 * starting volume N still has to assemble the context themselves. This module
 * renders the missing glue, with NO AI call:
 *
 *   <volume folder>/chapters.json          the volume's chapter list (segment
 *                                          id, file, title, char count) — the
 *                                          canonical machine-readable TOC the
 *                                          translation stage names its outputs by.
 *   <volume folder>/translation-brief.md   a one-page brief: what's NEW in this
 *                                          volume (persisted extraction JSONs
 *                                          from the three cumulative tasks),
 *                                          the chapter list, and pointers to
 *                                          every per-volume + series-level
 *                                          reference artifact.
 *
 * Called from jump-in-wiki.js (the last per-volume task in the pipeline) on
 * both the processed and skipped paths. Best-effort: a failure is logged as a
 * warning and never fails an already-accepted volume.
 *
 * @example
 * const { writeVolumeHandoff } = require("./utils/handoff");
 * await writeVolumeHandoff({ seriesDir, seriesName, volume, volumeDir, bundle,
 *   installmentNumber, sourceLanguage, targetLanguage });
 */

const fs = require("fs").promises;
const path = require("path");
const { fileExists } = require("./fs");
require("../types"); // JSDoc type definitions

// The per-volume reference artifacts the brief points at (file, one-liner).
const VOLUME_REFERENCES = [
  ["glossary.md", "canonical target-language renderings (state through this volume)"],
  ["character-voice.md", "character voice reference (state through this volume)"],
  ["style-guide.md", "house-style rendering policies (state through this volume)"],
  ["wiki.md", "this volume's plot/lore article"],
  ["pov-map.md", "this volume's chapter-by-chapter POV map"],
  ["glossary-coverage.md", "deterministic term-coverage audit (terms used in this volume)"],
  ["glossary-research.md", "web research notes for this volume's new terms"],
];

// The series-level references at SERIES_LOCATION (file, one-liner).
const SERIES_REFERENCES = [
  ["glossary.md", "latest cumulative glossary"],
  ["character-voice.md", "latest cumulative character voice reference"],
  ["style-guide.md", "latest cumulative style guide"],
  ["shared-wiki.md", "living shared wiki (current series state)"],
  ["consistency-report.md", "cross-artifact consistency audit (pre-translation sign-off)"],
];

/**
 * Build the machine-readable chapter list for a volume (pure).
 *
 * @param {SourceBundle} bundle - The resolved source bundle.
 * @returns {Array<{id: string, file: string, title: string, chars: number}>}
 *   One entry per segment, in reading order (the bundle's authoritative order).
 */
function buildChaptersJson(bundle) {
  return (bundle.segments || []).map((s) => ({
    id: s.id,
    file: s.file,
    title: s.title,
    chars: s.chars,
    // Carried through from the extraction so a section that converted to nothing
    // is visible in every downstream list (the translation stage skips it, the
    // report labels it, the brief shows it) instead of looking like a chapter
    // nobody bothered to translate.
    bodyChars: s.bodyChars,
    empty: s.empty === true,
  }));
}

/**
 * Render one "new in this volume" list line (pure, defensive — the extraction
 * JSONs are model output, so every field may be missing).
 *
 * @param {Object} entry - A parsed extraction entry (term/quirk/construct).
 * @returns {string} A single Markdown list line.
 */
function renderNewEntry(entry) {
  if (!entry || typeof entry !== "object") return "- (unparseable entry)";
  if (entry.term && entry.type) {
    // glossary-new-terms.json: { term, type, query }
    return `- ${entry.term} (${entry.type})`;
  }
  if (entry.type === "voice" && entry.character) {
    // character-voice-new.json voice entry:
    // { type: "voice", character, quirkType, description, ... }
    return `- ${entry.character}${entry.quirkType ? ` — ${entry.quirkType}` : ""}${entry.description ? `: ${entry.description}` : ""}`;
  }
  if (entry.type && entry.description) {
    // POV entries and anything else typed: { type, description, ... }
    return `- [${entry.type}] ${entry.description}`;
  }
  if (entry.category && entry.pattern) {
    // style-guide-new.json: { category, pattern, description, ... }
    return `- [${entry.category}] ${entry.pattern}${entry.description ? ` — ${entry.description}` : ""}`;
  }
  return `- ${JSON.stringify(entry).slice(0, 200)}`;
}
/**
 * Build the translation brief Markdown (pure — testable without the
 * filesystem).
 *
 * @param {{
 *   seriesName: string,
 *   installmentNumber: string,
 *   sourceLanguage: string,
 *   targetLanguage: string,
 *   chapters: Array<{id: string, file: string, title: string, chars: number}>,
 *   newTerms: Array<Object>|null,
 *   newQuirks: Array<Object>|null,
 *   newStyle: Array<Object>|null,
 *   presentVolumeFiles: string[],
 *   presentSeriesFiles: string[],
 * }} p
 * @returns {string} The Markdown brief.
 */
function buildTranslationBriefMarkdown(p) {
  const lines = [];
  lines.push(`# Translation Brief — ${p.seriesName}, Volume ${p.installmentNumber}`);
  lines.push("");
  lines.push(
    `_${p.sourceLanguage} → ${p.targetLanguage}. Read this first, then the reference material ` +
      `listed below. "New in this volume" is what THIS volume adds on top of the ` +
      `cumulative references (which already carry everything from earlier volumes). ` +
      `Generated deterministically by the pipeline (no AI)._`
  );
  lines.push("");

  // ── New in this volume ─────────────────────────────────────────────────
  lines.push("## New in this volume");
  lines.push("");
  if (p.newTerms && p.newTerms.length > 0) {
    lines.push(`### New glossary terms (${p.newTerms.length})`);
    lines.push("");
    for (const e of p.newTerms) lines.push(renderNewEntry(e));
    lines.push("");
  }
  if (p.newQuirks && p.newQuirks.length > 0) {
    lines.push(`### New character voices & POV entries (${p.newQuirks.length})`);
    lines.push("");
    for (const e of p.newQuirks) lines.push(renderNewEntry(e));
    lines.push("");
  }
  if (p.newStyle && p.newStyle.length > 0) {
    lines.push(`### New style rules (${p.newStyle.length})`);
    lines.push("");
    for (const e of p.newStyle) lines.push(renderNewEntry(e));
    lines.push("");
  }
  if (
    !(p.newTerms && p.newTerms.length) &&
    !(p.newQuirks && p.newQuirks.length) &&
    !(p.newStyle && p.newStyle.length)
  ) {
    lines.push(
      "(no persisted extraction data for this volume — it was skipped by a " +
        "previous run before extraction persistence existed, or the extraction " +
        "output was unparseable; the cumulative references remain authoritative.)"
    );
    lines.push("");
  }

  // ── Chapters ───────────────────────────────────────────────────────────
  lines.push(`## Chapters (${p.chapters.length})`);
  lines.push("");
  lines.push("| Segment | Title | Chars | Source file |");
  lines.push("|---|---|---|---|");
  for (const c of p.chapters) {
    // A section that converted to nothing is called out here too: the brief is
    // what a human reads before translation, and a hole in the book belongs in
    // the first page they see, not buried in an extraction log line.
    lines.push(
      `| ${c.id} | ${c.empty === true ? `${c.title} **(EMPTY IN SOURCE)**` : c.title} | ` +
        `${c.chars} | ${c.file} |`
    );
  }
  lines.push("");

  // ── Reference material ─────────────────────────────────────────────────
  lines.push("## Reference material — this volume folder");
  lines.push("");
  for (const [file, note] of VOLUME_REFERENCES) {
    if (p.presentVolumeFiles.includes(file)) {
      lines.push(`- **${file}** — ${note}`);
    } else {
      lines.push(`- ~~${file}~~ — ${note} (missing — run the corresponding task)`);
    }
  }
  lines.push("");
  lines.push("## Reference material — series root");
  lines.push("");
  for (const [file, note] of SERIES_REFERENCES) {
    if (p.presentSeriesFiles.includes(file)) {
      lines.push(`- **${file}** — ${note}`);
    } else {
      lines.push(`- ~~${file}~~ — ${note} (missing — run the corresponding task)`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Write the per-volume handoff artifacts (chapters.json + translation-brief.md).
 *
 * Best-effort: any failure (missing extraction files, unreadable artifacts,
 * disk errors) is logged as a warning and swallowed — the handoff is
 * supplementary and must never fail an already-accepted volume.
 *
 * @param {{
 *   seriesDir: string,
 *   seriesName: string,
 *   volume: TranslationTargetVolume,
 *   volumeDir: string,
 *   bundle: SourceBundle,
 *   installmentNumber: string,
 *   sourceLanguage: string,
 *   targetLanguage: string,
 * }} p
 * @returns {Promise<void>}
 */
async function writeVolumeHandoff(p) {
  const { seriesDir, volumeDir, bundle, installmentNumber } = p;
  try {
    const chapters = buildChaptersJson(bundle);
    await fs.writeFile(
      path.join(volumeDir, "chapters.json"),
      JSON.stringify({ seriesName: p.seriesName, volume: installmentNumber, chapters }, null, 2) + "\n",
      "utf8"
    );

    // Persisted extraction JSONs (written by the three cumulative tasks when
    // the volume was (re)generated; absent on the skip path of an old run).
    const readJsonOrNullLocal = async (file) => {
      try {
        const raw = await fs.readFile(path.join(volumeDir, file), "utf8");
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : null;
      } catch {
        return null;
      }
    };
    const newTerms = await readJsonOrNullLocal("glossary-new-terms.json");
    const newQuirks = await readJsonOrNullLocal("character-voice-new.json");
    const newStyle = await readJsonOrNullLocal("style-guide-new.json");

    const presentVolumeFiles = (await Promise.all(
      VOLUME_REFERENCES.map(async ([file]) => ((await fileExists(path.join(volumeDir, file))) ? file : null))
    )).filter(Boolean);
    const presentSeriesFiles = (await Promise.all(
      SERIES_REFERENCES.map(async ([file]) => ((await fileExists(path.join(seriesDir, file))) ? file : null))
    )).filter(Boolean);

    const brief = buildTranslationBriefMarkdown({
      seriesName: p.seriesName,
      installmentNumber,
      sourceLanguage: p.sourceLanguage,
      targetLanguage: p.targetLanguage,
      chapters,
      newTerms,
      newQuirks,
      newStyle,
      presentVolumeFiles,
      presentSeriesFiles,
    });
    await fs.writeFile(path.join(volumeDir, "translation-brief.md"), brief, "utf8");
    console.log(
      `Volume ${installmentNumber}: translation handoff written ` +
        `(chapters.json: ${chapters.length} chapter(s), translation-brief.md) → ${volumeDir}`
    );
  } catch (err) {
    console.warn(
      `Volume ${installmentNumber}: could not write the translation handoff ` +
        `(${err.message}) — continuing.`
    );
  }
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  buildChaptersJson,
  renderNewEntry,
  buildTranslationBriefMarkdown,
  writeVolumeHandoff,
  VOLUME_REFERENCES,
  SERIES_REFERENCES,
};
