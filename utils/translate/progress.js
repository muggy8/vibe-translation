/**
 * Telling a human what an un-monitored run is doing: the run estimate read from
 * the previous run's measured generation rate, the progress heartbeats, and the
 * chapter-list cross-check that refuses to let the paperwork describe a different
 * book than the one being translated.
 *
 * Part of the translate.js layer (split out of the original single file).
 */

const fs = require("fs").promises;
const path = require("path");
const { logsDir } = require("../../configs/run-state");

/**
 * Check the published `chapters.json` against the chapter list this run actually
 * extracted, and say loudly when they disagree.
 *
 * `bundle.segments` stays the source of truth for reading order (AGENTS.md
 * gotcha 20 — a filename sort misorders `chN` vs `chN.1`). But `chapters.json` is
 * what the per-volume handoff published, what `translation-brief.md` table is
 * built from, and what the series-level translation report reads to decide which
 * chapters exist. If the two disagree, the documents describing the book are
 * describing a DIFFERENT book than the one being translated — usually because the
 * source changed and the wiki task (which writes chapters.json) has not re-run.
 *
 * A warning, not an error: the pipeline can still translate the book it opened.
 * It just must not let the paperwork silently disagree about it.
 *
 * @param {string} volumeDir
 * @param {{segments: Array<{id: string, file: string, title?: string}>}} bundle
 * @returns {Promise<{ok: boolean, missing: string[], extra: string[], reason: string}>}
 */
async function checkChapterListConsistency(volumeDir, bundle) {
  let chaptersJson;
  try {
    chaptersJson = JSON.parse(await fs.readFile(path.join(volumeDir, "chapters.json"), "utf8"));
  } catch {
    return { ok: true, missing: [], extra: [], reason: "no chapters.json yet (the wiki task writes it)" };
  }
  const listed = Array.isArray(chaptersJson.chapters) ? chaptersJson.chapters : [];
  if (listed.length === 0) return { ok: true, missing: [], extra: [], reason: "chapters.json lists no chapters" };
  const listedIds = new Set(listed.map((c) => c && c.id));
  const bundleIds = new Set((bundle.segments || []).map((seg) => seg.id));
  const missing = [...bundleIds].filter((id) => !listedIds.has(id));
  const extra = [...listedIds].filter((id) => !bundleIds.has(id));
  if (missing.length === 0 && extra.length === 0) return { ok: true, missing: [], extra: [], reason: "" };
  const detail = [
    missing.length > 0 ? `this run has chapters the handoff does not list: ${missing.join(", ")}` : "",
    extra.length > 0 ? `the handoff lists chapters this run cannot find: ${extra.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("; ");
  console.warn(
    `[chapters] ${volumeDir}: chapters.json DISAGREES with the extracted chapter list — ${detail}. ` +
      `The extracted list is used. Re-run the jump-in-wiki task to refresh chapters.json and ` +
      `translation-brief.md (a changed source is the usual cause).`
  );
  return { ok: false, missing, extra, reason: detail };
}

// ─── Run estimate & progress ────────────────────────────────────────────────


/**
 * What the previous run of this pipeline actually achieved, measured from its
 * log: the average generation speed and how many calls it made.
 *
 * An overnight run needs to answer "is this healthy or stuck?" from the log
 * alone. The honest way to estimate how long a stage will take is the speed this
 * machine and this model already demonstrated — not a guessed constant. Returns
 * null when there is no previous run to measure (the first run of a series).
 *
 * @returns {Promise<{genTokPerSec: number, calls: number, logFile: string}|null>}
 */
async function previousRunThroughput() {
  const logsRoot = logsDir();
  let entries;
  try {
    entries = await fs.readdir(logsRoot);
  } catch {
    return null;
  }
  const dirs = entries.filter((e) => !e.startsWith(".")).sort().reverse();
  for (const dir of dirs) {
    const file = path.join(logsRoot, dir, "summary.log");
    let text;
    try {
      text = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    const speeds = [...text.matchAll(/\bgen=([0-9.]+) tok\/s/g)].map((m) => parseFloat(m[1]));
    const usable = speeds.filter((n) => Number.isFinite(n) && n > 0);
    if (usable.length === 0) continue;
    return {
      genTokPerSec: usable.reduce((a, b) => a + b, 0) / usable.length,
      calls: usable.length,
      logFile: file,
    };
  }
  return null;
}


/**
 * Print what a translation stage is about to do, before it starts doing it.
 *
 * The point is the number of model calls: a stage that will make 1,900 calls on
 * a local model is a decision the operator should be able to see at the start of
 * a run, not discover at 4am. When a previous run exists the estimate is
 * measured from it; otherwise the log says plainly that nothing is known yet.
 *
 * @param {{
 *   stage: string,
 *   volumes: number,
 *   chapters: number,
 *   callsPerChapter?: number,
 *   endpoint: {model: string, baseUrl: string},
 *   extra?: string,
 * }} p
 * @returns {Promise<string>} The estimate line that was printed.
 */
async function logRunEstimate({ stage, volumes, chapters, callsPerChapter = 1, endpoint, extra = "" }) {
  const calls = chapters * callsPerChapter;
  const measured = await previousRunThroughput();
  let line =
    `[${stage}] estimate: ${volumes} volume(s), ${chapters} chapter(s), ~${calls} model call(s) on ` +
    `${endpoint.model} @ ${endpoint.baseUrl}`;
  if (measured) {
    const outTokens = calls * 1200; // a chapter-length answer, roughly
    const minutes = outTokens / measured.genTokPerSec / 60;
    line +=
      `; measured ${measured.genTokPerSec.toFixed(1)} tok/s from ${measured.calls} call(s) of a previous ` +
      `run (${measured.logFile}) → roughly ${minutes < 1 ? "<1" : Math.round(minutes)} min of generation`;
  } else {
    line += "; no previous run log to measure against yet";
  }
  if (extra) line += `; ${extra}`;
  console.log(line);
  harnessLogLine(line);
  return line;
}


/** A log line that survives into the run's log folder (the harness's own summary log). */
let harnessLogLine = (line) => console.error(line);
try {
  const h = require("../../harness");
  if (typeof h.logLine === "function") harnessLogLine = h.logLine;
} catch {
  // utils/ must not hard-depend on the AI layer; the console line is enough.
}


/**
 * A running counter for a batch, so a long stage can be read from the log:
 * "chapter 14/380" answers "is it moving?" without waiting for the volume to end.
 *
 * @param {number} total
 * @param {string} [unit] - What is being counted ("chapter", "volume", "candidate").
 * @returns {(label: string) => void} Call it once per completed unit.
 */
function progressCounter(total, unit = "chapter") {
  let done = 0;
  return function progress(label) {
    done += 1;
    const line = `[progress] ${unit} ${done}/${total}${label ? ` — ${label}` : ""}`;
    console.log(line);
    harnessLogLine(line);
  };
}

/**
 * The per-volume heartbeat a long stage writes into the run log: every 10 chapters, and once at the
 * end, a greppable "N/M" line naming the last chapter.
 *
 * It exists so a reader of an un-monitored run can tell a slow stage from a stuck one without waiting
 * for the volume to finish. The stage name and the volume are in the line because a log with three
 * stages running is not a log that says which one is moving.
 *
 * @param {string} stage - What the line is measuring ("translate", "verify", "retranslate").
 * @param {string} installmentNumber
 * @param {number} total - How many chapters the stage is about to walk.
 * @returns {(id: string) => void} Call it once per finished chapter.
 */
function chapterHeartbeat(stage, installmentNumber, total) {
  let done = 0;
  return function heartbeat(id) {
    done += 1;
    if (done % 10 === 0 || done === total) {
      harnessLogLine(
        `[progress] ${stage} Volume ${installmentNumber}: ${done}/${total} chapter(s) (last: ${id})`
      );
    }
  };
}


/**
 * How many chapters a stage is about to walk, without doing the stage's work.
 *
 * Read from `chapters.json` (the handoff the wiki task writes for exactly this
 * purpose) when it exists; otherwise the source bundle is resolved, which is the
 * same cached extraction the stage itself will use. The number is printed before
 * the stage starts, because "1,900 model calls" is a decision the operator should
 * see at the start of a run, not discover halfway through one.
 *
 * @param {{seriesDir: string, volumes: Array<{folder: string, sourceFile: string, installmentNumber: string}>, force?: boolean}} p
 * @returns {Promise<{chapters: number, perVolume: Array<{folder: string, chapters: number}>, unresolved: string[]}>}
 */
async function countStageChapters({ seriesDir, volumes, force = false }) {
  const perVolume = [];
  const unresolved = [];
  let chapters = 0;
  for (const volume of volumes) {
    const volumeDir = path.join(seriesDir, volume.folder);
    let count = null;
    try {
      const chaptersJson = JSON.parse(await fs.readFile(path.join(volumeDir, "chapters.json"), "utf8"));
      if (Array.isArray(chaptersJson.chapters)) count = chaptersJson.chapters.length;
    } catch {
      count = null;
    }
    if (count === null) {
      try {
        const { resolveSourceBundle } = require("../source");
        const bundle = await resolveSourceBundle({ seriesDir, volume, volumeDir, force: false });
        count = bundle.segments.length;
      } catch {
        unresolved.push(volume.folder);
        continue;
      }
    }
    perVolume.push({ folder: volume.folder, chapters: count });
    chapters += count;
  }
  return { chapters, perVolume, unresolved };
}

// ─── Rendering variant scan (deterministic, no model) ────────────────────────


module.exports = {
  checkChapterListConsistency,
  previousRunThroughput,
  logRunEstimate,
  harnessLogLine,
  progressCounter,
  chapterHeartbeat,
  countStageChapters,
};
