/**
 * The stage's on-disk paperwork: the artifact file names every chapter's outputs
 * are written under, the per-volume idempotency state, and the verification /
 * consistency sidecars.
 *
 * State and sidecar load/save are fail-open (a corrupt state file means
 * regenerate, not crash), and every save serializes the whole shared object so a
 * concurrent chapter loop cannot write a partial file.
 *
 * Part of the translate.js layer (split out of the original single file).
 */

const fs = require("fs").promises;
const path = require("path");

const { readFileOrEmpty } = require("./internal");

/**
 * Load the per-volume translation state file (translation-state.json).
 *
 * Shape (per segment id):
 *   sourceHash        sha256 of the chapter source content
 *   contextHash       sha256 of the injected references (glossary + style
 *                     rules + background) the draft was built from
 *   draftHash         sha256 of the current draft file content
 *   retranslated      whether a retranslate pass has run for the findings
 *   findingsHash      sha256 of the verification findings the last
 *                     retranslate was based on (or null)
 *   polishedDraftHash sha256 of the draft the last polish pass polished
 *                     (or null when not polished)
 *
 * Fail-open: a missing/corrupt file loads as an empty state (the volume is
 * reprocessed once — the idempotency skip-checks simply find nothing).
 *
 * @param {string} filePath - Absolute path to the state file.
 * @returns {Promise<{schema: number, chapters: Object}>}
 */
async function loadTranslationState(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    if (!raw.trim()) return { schema: 1, chapters: {} };
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || typeof data.chapters !== "object" || data.chapters === null) {
      return { schema: 1, chapters: {} };
    }
    return { schema: 1, chapters: data.chapters };
  } catch {
    return { schema: 1, chapters: {} };
  }
}


/**
 * Persist the per-volume translation state (a plain overwrite — the file is
 * small and a torn write just costs one reprocessed volume on the next run).
 *
 * @param {string} filePath - Absolute path to the state file.
 * @param {{chapters: Object}} state
 */
async function saveTranslationState(filePath, state) {
  await fs.writeFile(
    filePath,
    JSON.stringify({ schema: 1, chapters: state.chapters || {} }, null, 2) + "\n",
    "utf8"
  );
}


/** Per-volume translation state file (per-chapter idempotency). */
const STATE_FILE = "translation-state.json";

/** Deterministic QA report written by the translate task. */
const QA_REPORT_FILE = "translation-qa.md";

/** The merged volume translation (the deliverable). */
const MERGED_FILE = "translation.md";

/** Verification sidecar written by verify-translate (machine-readable). */
const VERIFICATION_FILE = "translation-verification.json";

/** Verification report written by verify-translate (human-readable). */
const VERIFICATION_REPORT = "translation-verification.md";

/** Polish QA report. */
const POLISH_QA_REPORT = "polish-qa.md";

/** Polish drift-audit sidecar. */
const POLISH_VERIFICATION_FILE = "polish-verification.json";

const VOLUME_CONSISTENCY_FILE = "volume-consistency.json";

const VOLUME_CONSISTENCY_REPORT = "volume-consistency.md";


/**
 * Per-chapter draft / polished / state / report file names (inside the volume
 * folder). The segment id is unique per volume, so the files are unambiguous
 * without a bundle-base prefix.
 *
 * @param {string} segmentId - The bundle segment id (whole / ch0 / chN / chN.K / part-NN).
 * @returns {{draftFile: string, polishedFile: string, rejectedFile: string, bestFile: string}}
 */
function chapterArtifactNames(segmentId) {
  return {
    draftFile: `translation-${segmentId}.md`,
    polishedFile: `polished-${segmentId}.md`,
    // A draft that failed the deterministic QA is kept (not thrown away) so the
    // QA loop has something to correct; the reason is recorded in the state.
    rejectedFile: `translation-${segmentId}.rejected.md`,
    // The best-scoring draft seen so far — the ratchet's restore point.
    bestFile: `translation-${segmentId}.best.md`,
  };
}


/**
 * Load a verification sidecar (fail-open: missing/corrupt → `{ chapters: {} }`).
 *
 * @param {string} filePath
 * @returns {Promise<{chapters: Object}>}
 */
async function loadVerificationSidecar(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || typeof data.chapters !== "object" || data.chapters === null) {
      return { chapters: {} };
    }
    return data;
  } catch {
    return { chapters: {} };
  }
}


/**
 * Persist a verification sidecar.
 *
 * @param {string} filePath
 * @param {Object} sidecar
 */
async function saveVerificationSidecar(filePath, sidecar) {
  await fs.writeFile(filePath, JSON.stringify(sidecar, null, 2) + "\n", "utf8");
}


/**
 * Extract the findings from a grader's reply for the sidecar's `findings` field
 * (the retranslate / re-polish prompt's "fix these problems" task). The
 * score-line prefix is dropped — it is meaningless to a corrector — keeping the
 * reply from the "## Findings" marker on. When the marker is absent (off-format
 * reply) the whole trimmed reply is kept.
 *
 * Truncation drops WHOLE findings and never cuts one in half, and says how many
 * were dropped: the prompt tells the model "you MUST fix all of them", so a
 * silently shortened list is a lie.
 *
 * @param {string} raw - The grader's full reply.
 * @param {number} [maxChars] - Character budget (default 6000).
 * @returns {string} The findings text.
 */
function findingsOf(raw, maxChars = 6000) {
  const text = (raw || "").trim();
  const idx = text.indexOf("## Findings");
  const findings = idx >= 0 ? text.slice(idx) : text;
  if (findings.length <= maxChars) return findings;
  // Cut at finding boundaries (numbered list items) so no finding is truncated
  // mid-sentence.
  const kept = findings.slice(0, maxChars);
  const lastBoundary = Math.max(
    kept.lastIndexOf("\n1."),
    kept.lastIndexOf("\n2."),
    kept.lastIndexOf("\n3."),
    kept.lastIndexOf("\n4."),
    kept.lastIndexOf("\n5."),
    kept.lastIndexOf("\n6."),
    kept.lastIndexOf("\n7."),
    kept.lastIndexOf("\n8."),
    kept.lastIndexOf("\n9.")
  );
  const cut = lastBoundary > 0 ? kept.slice(0, lastBoundary) : kept;
  const totalNumbered = (findings.match(/^\s*\d+\.\s/gm) || []).length;
  const keptNumbered = (cut.match(/^\s*\d+\.\s/gm) || []).length;
  const omitted = totalNumbered - keptNumbered;
  return (
    cut +
    (omitted > 0
      ? `\n\n(showing ${keptNumbered} of ${totalNumbered} findings — ${omitted} omitted by the ${maxChars}-character budget)`
      : `\n\n(truncated at the ${maxChars}-character budget)`)
  );
}


/**
 * Read the volume-consistency sidecar (fail-open: a missing or corrupt file is
 * "no findings", never a crash — the pass is an extra pair of eyes, not a gate).
 *
 * @param {string} volumeDir
 * @returns {Promise<Object>}
 */
async function loadVolumeConsistency(volumeDir) {
  const raw = await readFileOrEmpty(path.join(volumeDir, VOLUME_CONSISTENCY_FILE));
  if (!raw) return { schema: 1, findings: [], windows: [] };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { schema: 1, findings: [], windows: [] };
    if (!Array.isArray(parsed.findings)) parsed.findings = [];
    if (!Array.isArray(parsed.windows)) parsed.windows = [];
    return parsed;
  } catch {
    return { schema: 1, findings: [], windows: [] };
  }
}


/**
 * Write the volume-consistency sidecar.
 *
 * @param {string} volumeDir
 * @param {Object} data
 * @returns {Promise<void>}
 */
async function saveVolumeConsistency(volumeDir, data) {
  await fs.writeFile(
    path.join(volumeDir, VOLUME_CONSISTENCY_FILE),
    JSON.stringify(data, null, 2) + "\n",
    "utf8"
  );
}

// ─── Verification verdicts & the draft ratchet ──────────────────────────────


module.exports = {
  loadTranslationState,
  saveTranslationState,
  STATE_FILE,
  QA_REPORT_FILE,
  MERGED_FILE,
  VERIFICATION_FILE,
  VERIFICATION_REPORT,
  POLISH_QA_REPORT,
  POLISH_VERIFICATION_FILE,
  VOLUME_CONSISTENCY_FILE,
  VOLUME_CONSISTENCY_REPORT,
  chapterArtifactNames,
  loadVerificationSidecar,
  saveVerificationSidecar,
  findingsOf,
  loadVolumeConsistency,
  saveVolumeConsistency,
};
