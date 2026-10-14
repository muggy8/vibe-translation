/**
 * utils/prereqs/freeze/frozen-state.js — which volumes this run is about to touch, and whether a
 * published translation already stands on top of each one.
 *
 * The answer is a folder listing, never a memory of the current process: a volume is frozen when the
 * `translate` step's own `required` per-volume artifacts are in its folder (the names come from
 * `declared-artifacts.js`, not from a list written here). That is what makes a resumed run answer the
 * same question a fresh run does. `--volume NN` narrows the question to that volume, exactly as the
 * prerequisite gate narrows its own, by the same `readVolumesInScope` — one rule, not two.
 *
 * @module utils/prereqs/freeze/frozen-state
 */

const fs = require("fs");
const path = require("path");

const { readVolumesInScope } = require("../../prereqs");
const { requiredTranslationArtifacts } = require("./declared-artifacts");

/** @typedef {import("../../types").TranslationTargetVolume} TranslationTargetVolume */

/**
 * One volume folder: has a translation been published on top of this volume's reference artifacts?
 *
 * @param {Object} opts
 * @param {string} opts.volumeDir - The volume folder.
 * @param {string} opts.installment - The volume's installment number.
 * @returns {Promise<{frozen: boolean, artifacts: Array<{name: string, bytes: number}>}>} The verdict
 *   and the translation files that produced it, with their sizes so a refusal can name what is at
 *   stake rather than assert it.
 */
async function readFrozenState({ volumeDir, installment }) {
  const names = requiredTranslationArtifacts(installment);
  if (names.length === 0) return { frozen: false, artifacts: [] };
  /** @type {Array<{name: string, bytes: number}>} */
  const present = [];
  for (const name of names) {
    try {
      const st = await fs.promises.stat(path.join(volumeDir, name));
      if (st.isFile()) present.push({ name, bytes: st.size });
    } catch {
      return { frozen: false, artifacts: [] };
    }
  }
  return { frozen: present.length === names.length, artifacts: present };
}

/**
 * The volumes this invocation is about to touch, each with its freeze verdict.
 *
 * `--volume NN` narrows the question to that volume, exactly as the prerequisite gate narrows its
 * own — a legal `--volume 03` must not be blocked by a frozen volume 01 this run does not touch.
 *
 * @param {Object} opts
 * @param {string} opts.seriesDir
 * @param {string|null} [opts.volumeArg] - The `--volume` filter.
 * @param {TranslationTargetVolume[]} [opts.volumes] - Pass the volumes the caller already resolved
 *   (the per-volume gate inside a stage walk has them in hand) instead of reading the plan again.
 * @returns {Promise<{volumes: Array<{installment: string, folder: string, frozen: boolean, artifacts: Array<{name: string, bytes: number}>}>, error: string|null}>}
 */
async function readFreezeScope({ seriesDir, volumeArg = null, volumes = null }) {
  let entries;
  if (volumes) {
    entries = volumes;
  } else {
    const read = readVolumesInScope(seriesDir, volumeArg);
    if (read.error) return { volumes: [], error: read.error };
    entries = read.volumes;
  }
  /** @type {Array<{installment: string, folder: string, frozen: boolean, artifacts: Array<{name: string, bytes: number}>}>} */
  const out = [];
  for (const entry of entries) {
    const installment = String(entry.installmentNumber || entry.folder);
    const state = await readFrozenState({ volumeDir: path.join(seriesDir, entry.folder), installment });
    out.push({ installment, folder: entry.folder, ...state });
  }
  return { volumes: out, error: null };
}

module.exports = {
  readFrozenState,
  readFreezeScope,
};
