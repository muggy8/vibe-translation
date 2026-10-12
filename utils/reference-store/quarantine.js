/**
 * utils/reference-store/quarantine.js — moving a replaced artifact aside, and keeping every rejection.
 *
 * A leaf on purpose. Both the rebuilt reference (`rebuild.js`) and the rendered POV map (`pov-map.js`)
 * replace a file that may already be there, and both must keep the file they replace. `rebuild.js` already
 * requires `pov-map.js` to render the map, so a shared door that lived in either of them would close a
 * require cycle and hand one of them a half-built module — the same trap as gotcha 85, one folder down.
 *
 * ## Why the rejects are numbered
 *
 * The first rejection of a volume's reference goes to `character-voice.md.rejected`; the second goes to
 * `character-voice.md.rejected.2`, and so on. The rule used to be "refuse when `.rejected` is already
 * there", which sounds like caution and behaves like amnesia. Volume 01's published reference was itself
 * rebuilt from a quarantined file, so its folder already holds `character-voice.md.rejected` — the original
 * damaged document, the one whose 54,341-character line is why this project measures line lengths at all.
 * Under the old rule, redoing volume 01 refused to move its *current* reference aside because the slot was
 * occupied by the evidence of the *first* failure. The only two outcomes were "destroy the evidence" and
 * "stop", and a guard with those two outcomes gets worked around.
 *
 * Numbering keeps both files, in the order they happened.
 *
 * @module utils/reference-store/quarantine
 */

const fs = require("fs");
const path = require("path");

const { refusal } = require("./refusals");

require("../../types"); // JSDoc type definitions

/**
 * The ignore rule that keeps the quarantine family out of git, written into the folder that holds it.
 *
 * There was no such rule. Volume 01's `character-voice.md.rejected` sits in the series repository as an
 * untracked file and nothing ignores it: that repository's `.gitignore` has one entry (`ai-client/`), and
 * the rule the pipeline does write lives in `<SERIES_LOCATION>/.run/.gitignore`, which git applies only
 * inside `.run/`. A `.gitignore` in the folder holding the rejects is the only place a rule can go that
 * travels with the books and is written by the pipeline rather than by a person remembering to — the same
 * reasoning as `configs/run-state.js`'s rule for the run's transcripts.
 *
 * One pattern covers the whole family precisely because the family is a suffix series rather than a folder.
 * The retired reference records are deliberately **not** ignored: a retired `series.db` is the published
 * record a translation was built on, and a record that cannot be committed is a record that is lost the
 * next time the folder is copied somewhere else.
 *
 * @param {string} volumeDir
 * @returns {{written: boolean, file: string, error: string|null}}
 */
function ensureArtifactRejectIgnoreRule(volumeDir) {
  const file = path.join(volumeDir, ".gitignore");
  let existing = "";
  if (fs.existsSync(file)) {
    try {
      existing = fs.readFileSync(file, "utf8");
    } catch {
      return { written: false, file, error: null };
    }
    if (existing.includes("*.rejected*")) return { written: false, file, error: null };
  }
  const block = [
    "# Written by ai-client when it moved a rejected artifact aside in this folder.",
    "#",
    "# A quarantined artifact is evidence of a failure. It is kept on disk so a later run can see what went",
    "# wrong, and it is not a deliverable: the numbered family (`glossary.md.rejected`,",
    "# `character-voice.md.rejected.2`, …) is what this rule keeps out of the repository.",
    "#",
    "# What is NOT ignored here, on purpose: the volume's reference record (`series.db`) and the records it",
    "# was retired into (`series.db.retired-…`). Those are the run's memory, and memory you cannot commit is",
    "# memory you lose the next time this folder is copied somewhere else.",
    "",
    "*.rejected*",
    "",
  ].join("\n");
  try {
    fs.writeFileSync(file, existing ? `${existing.replace(/\n*$/, "")}\n\n${block}` : block, "utf8");
    return { written: true, file, error: null };
  } catch (err) {
    return { written: false, file, error: String(err && err.message ? err.message : err) };
  }
}

/**
 * Move a replaced artifact aside: kept as evidence, and out of reach of the next volume.
 *
 * Never overwrites, and never refuses because a slot is taken — it moves to the next one. See the module
 * header for why refusing was the wrong caution.
 *
 * @param {string} volumeDir
 * @param {string} file - The artifact's file name, e.g. `character-voice.md`.
 * @param {{rejectedFile?: string}} [opts] - Override the base name. Without it the family is
 *   `<file>.rejected`, `<file>.rejected.2`, `<file>.rejected.3`, …
 * @returns {{ok: boolean, moved: string|null, slot: number, keptAside: string[], refusal: ReferenceRefusal|null}}
 */
function moveArtifactAside(volumeDir, file, { rejectedFile } = {}) {
  const from = path.join(volumeDir, file);
  if (!fs.existsSync(from)) {
    return { ok: true, moved: null, slot: 0, keptAside: [], refusal: null };
  }

  const base = rejectedFile || `${file}.rejected`;
  /** @type {string[]} */
  const alreadyAside = [];
  let target = path.join(volumeDir, base);
  let slot = 1;
  while (fs.existsSync(target)) {
    alreadyAside.push(target);
    slot += 1;
    target = path.join(volumeDir, `${base}.${slot}`);
  }

  try {
    fs.renameSync(from, target);
  } catch (err) {
    return {
      ok: false,
      moved: null,
      slot: 0,
      keptAside: alreadyAside,
      refusal: refusal({
        verb: "move_artifact_aside",
        rule: "rejected-artifact-move-failed",
        because: `could not move ${path.basename(from)} to ${path.basename(target)}: ${err.message}`,
        fix: "close whatever is holding the file open, then run the volume again.",
      }),
    };
  }

  ensureArtifactRejectIgnoreRule(volumeDir);
  return { ok: true, moved: target, slot, keptAside: alreadyAside, refusal: null };
}

module.exports = {
  moveArtifactAside,
  ensureArtifactRejectIgnoreRule,
};
