/**
 * utils/postmortem/volume.js — one volume folder, everything the step owed it.
 *
 * The declared outputs, the artifacts that are NOT declared (a stray file is a finding too),
 * the acceptance state the volume claims to have earned, and — for the translation stage —
 * whether every chapter the source has actually has a draft and a verdict.
 */

const fs = require("fs");
const path = require("path");

const { fileExists } = require("../fs");
const { finding } = require("./rules");
const { assessFile } = require("./file");
const { isKnownVolumeFile } = require("../artifacts");
const { loadRollingState, isAcceptedState } = require("../../configs/shared");
const { isVolumeArtifact } = require("../../get-translation-target");

/** @typedef {import("../postmortem").PostMortemFinding} PostMortemFinding */

// ─── One volume ───────────────────────────────────────────────────────────────

/**
 * List the regular files in a folder (directories excluded — `images/` and the
 * epub extraction cache's image manifest are legitimate).
 *
 * A SHORTCUT counts as a file when it resolves to one, and does not when it
 * resolves to a folder or to nothing. `Dirent.isFile()` answers no for a shortcut,
 * and a staged book is now usually a shortcut: without this, a stray shortcut in a
 * volume folder would be invisible to the check that exists to report stale
 * leftovers, and "the folder holds exactly what the pipeline writes" would stop
 * being a question anyone could answer.
 *
 * @param {string} dir
 * @returns {Promise<string[]>} Sorted file names, or null when the folder is absent.
 */
async function listFiles(dir) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const names = [];
  for (const e of entries) {
    if (e.isFile()) {
      names.push(e.name);
      continue;
    }
    if (!e.isSymbolicLink()) continue;
    try {
      if ((await fs.promises.stat(path.join(dir, e.name))).isFile()) names.push(e.name);
    } catch {
      /* a broken shortcut is not a file — reported by the source-existence check, not here */
    }
  }
  return names.sort();
}

/**
 * Assess every expectation for one volume folder.
 *
 * @param {Object} opts
 * @param {import("./artifacts").StepArtifactSpec} opts.spec
 * @param {string} opts.step
 * @param {string} opts.seriesDir
 * @param {import("../types").TranslationTargetVolume} opts.volumeEntry
 * @param {import("./artifacts").ArtifactContext} opts.ctx
 * @returns {Promise<PostMortemFinding[]>}
 */
async function assessVolume({ spec, step, seriesDir, volumeEntry, ctx }) {
  const findings = [];
  const installment = volumeEntry.installmentNumber;
  const volumeDir = path.join(seriesDir, volumeEntry.folder);
  const names = await listFiles(volumeDir);

  if (names === null) {
    findings.push(
      finding(
        "HIGH",
        "missing-volume-folder",
        step,
        installment,
        volumeEntry.folder,
        `the volume folder ${volumeEntry.folder} does not exist — the plan of record ` +
          `lists a volume the pipeline has nowhere to write`
      )
    );
    return findings;
  }

  // 1–4: the declared expectations.
  const volumeCtx = { ...ctx, installment };
  for (const expectation of spec.volume) {
    if (expectation.when && !expectation.when(volumeCtx)) continue;
    const name = expectation.name.replace("{installment}", installment);
    const res = await assessFile(
      path.join(volumeDir, name),
      { ...expectation, name },
      step,
      installment,
      `${volumeEntry.folder}/${name}`
    );
    if (res) findings.push(res);
  }

  // 5: quarantine files a gate left behind.
  for (const q of spec.quarantines) {
    for (const name of names) {
      if (q.pattern.test(name)) {
        findings.push(
          finding(
            q.severity,
            "quarantine-present",
            step,
            installment,
            `${volumeEntry.folder}/${name}`,
            `${name} is present: ${q.meaning}`
          )
        );
      }
    }
  }

  // 6: files the pipeline's own vocabulary does not recognise.
  const sourceName = path.basename(String(volumeEntry.sourceFile || ""));
  for (const name of names) {
    if (name === sourceName) continue; // the staged book itself
    if (isVolumeArtifact(name)) continue; // known pipeline output
    if (isKnownVolumeFile(name)) continue; // source parts, cache, kept evidence
    findings.push(
      finding(
        "LOW",
        "unexpected-file",
        step,
        installment,
        `${volumeEntry.folder}/${name}`,
        `${name} is in the volume folder but is not a file this pipeline writes and ` +
          `is not this volume's source. Stale output gets audited as if it were current.`
      )
    );
  }

  // 7: an acceptance state that was never accepted, and the grades that never arrived.
  for (const expectation of spec.volume) {
    if (expectation.shape !== "json" || !expectation.name.endsWith("-rolling-state.json")) continue;
    const name = expectation.name.replace("{installment}", installment);
    const state = await loadRollingState(path.join(volumeDir, name));
    if (state && !isAcceptedState(state)) {
      const scores = (state.results || []).join(", ");
      findings.push(
        finding(
          "MEDIUM",
          "accepted-without-acceptance",
          step,
          installment,
          `${volumeEntry.folder}/${name}`,
          `the rolling window [${scores}] never met the acceptance criterion, and the ` +
            `volume was published anyway (ON_QA_LIMIT=accept). No grader signed this off.`
        )
      );
    }
    if (state && state.gradeFailures > 0) {
      // Every grade that came back unusable is a failed check: it is dropped from the window
      // (fail-closed) and costs the loop a full feedback rewrite of an artifact that may be fine.
      // The window cannot show this on its own — an empty window looks identical whether the
      // grader refused to answer or was never called — which is why the count is persisted
      // beside the scores (see saveRollingState).
      const every = state.gradeAttempts > 0 && state.gradeFailures >= state.gradeAttempts;
      findings.push(
        finding(
          every ? "HIGH" : "MEDIUM",
          "grade-failures",
          step,
          installment,
          `${volumeEntry.folder}/${name}`,
          `the grader was asked ${state.gradeAttempts} time(s) for this artifact and ` +
            `${state.gradeFailures} answer(s) were unusable${every ? " — every single one" : ""}. ` +
            `An unreadable grade is a failed check: it spends a QA iteration and rewrites an ` +
            `artifact that may already be fine. Check the grader's one-shot in the run's log folder for the reply ` +
            `it actually produced.`
        )
      );
    }
  }

  // 8: a chapter the handoff listed has no draft.
  if (spec.volume.some((e) => e.name === "translation-state.json")) {
    findings.push(...(await assessChapterCoverage(volumeDir, volumeEntry.folder, installment, step)));
  }

  return findings;
}

/**
 * Cross-check the handoff's chapter list against what the translation stage produced.
 *
 * A chapter the book has and the pipeline skipped is the difference between "a
 * hole in the book" (EMPTY IN SOURCE — fine) and "a hole in the run" (MISSING —
 * not fine). The reports already label both; nothing checked them against each
 * other at the volume level.
 *
 * @param {string} volumeDir
 * @param {string} folder
 * @param {string} installment
 * @param {string} step
 * @returns {Promise<PostMortemFinding[]>}
 */
async function assessChapterCoverage(volumeDir, folder, installment, step) {
  const findings = [];
  let chapters;
  try {
    chapters = JSON.parse(await fs.promises.readFile(path.join(volumeDir, "chapters.json"), "utf8"));
  } catch {
    return findings; // no handoff list — already reported by the expectation that wants it
  }
  if (!Array.isArray(chapters) || chapters.length === 0) return findings;

  let state = {};
  try {
    state = JSON.parse(await fs.promises.readFile(path.join(volumeDir, "translation-state.json"), "utf8")) || {};
  } catch {
    return findings; // already reported as missing-required / bad-json
  }

  for (const chapter of chapters) {
    if (!chapter || !chapter.id) continue;
    if (chapter.empty === true) continue; // a hole in the BOOK, reported as EMPTY IN SOURCE
    const draft = `translation-${chapter.id}.md`;
    if (await fileExists(path.join(volumeDir, draft))) continue;
    const entry = state[chapter.id];
    if (entry && (entry.draftHash || entry.qaFailed)) continue; // repaired, or kept as a repair target
    findings.push(
      finding(
        "MEDIUM",
        "chapter-without-draft",
        step,
        installment,
        `${folder}/translation-${chapter.id}.md`,
        `the handoff lists chapter ${chapter.id}${chapter.title ? ` ("${chapter.title}")` : ""} ` +
          `with ${chapter.bodyChars ?? chapter.chars ?? "?"} characters of source, and the ` +
          `translation stage produced no draft and recorded no state for it.`
      )
    );
  }
  return findings;
}

module.exports = { listFiles, assessVolume, assessChapterCoverage };
