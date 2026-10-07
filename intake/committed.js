/**
 * What the pipeline already built, and the rule that a re-run may not rename it.
 *
 * readCommittedLayout records every existing folder under the series dir and whether it
 * holds pipeline output; applyCommittedLayout forces the agent to keep such a folder's
 * name (and its staged source) even when it proposes a nicer one, and even under
 * --force. A disagreement warns and the corrected plan is kept, or fails immediately
 * when DISCOVER_STRICT=true — a retry cannot make an agent respect a policy.
 *
 * Part of the get-translation-target.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("../types"); // JSDoc type definitions
const { sha256OfFile } = require("../utils/source");

const { isVolumeArtifact } = require("./config");

/**
 * Snapshot the folders that already exist under the series location: which of
 * them already hold pipeline output, and the content hash of every source file
 * staged inside them.
 *
 * This is what makes the plan of record stable. An agent that named folders
 * afresh on every run would otherwise rename "Series(03)" to something prettier
 * and orphan the glossary, wiki, and translation already written inside it.
 *
 * @param {string} seriesDir - The SERIES_LOCATION path.
 * @returns {Promise<CommittedVolumeDir[]>} One entry per existing folder.
 */
async function readCommittedLayout(seriesDir) {
  const out = [];
  const entries = await fs.readdir(seriesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "images") continue;
    const dir = path.join(seriesDir, entry.name);
    let names;
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    const sources = [];
    let hasPipelineOutput = false;
    for (const name of names) {
      if (isVolumeArtifact(name)) {
        hasPipelineOutput = true;
        continue;
      }
      if (!/\.(epub|txt|md)$/i.test(name)) continue;
      const abs = path.join(dir, name);
      try {
        const st = await fs.stat(abs);
        if (!st.isFile()) continue;
        sources.push({ file: name, sha256: await sha256OfFile(abs) });
      } catch {
        /* unreadable — ignore it in the snapshot */
      }
    }
    out.push({ folder: entry.name, hasPipelineOutput, sources });
  }
  return out;
}


/**
 * Keep the plan of record stable: when the intake agent planned a NEW folder
 * name for a book that is already staged in a folder holding pipeline output,
 * keep the old name (and point the manifest at the copy already there) instead
 * of orphaning that work.
 *
 * @param {string} seriesDir - The SERIES_LOCATION path.
 * @param {TranslationTargetManifest} manifest - The agent's plan.
 * @param {CommittedVolumeDir[]} committed - The snapshot from readCommittedLayout.
 * @returns {Promise<string[]>} The warnings it produced (empty when the plan matched).
 */
async function applyCommittedLayout(seriesDir, manifest, committed) {
  const warnings = [];
  const byHash = new Map();
  for (const dir of committed) {
    if (!dir.hasPipelineOutput) continue;
    for (const src of dir.sources) {
      if (!byHash.has(src.sha256)) byHash.set(src.sha256, { folder: dir.folder, src });
    }
  }
  for (const vol of manifest.volumes) {
    const planned = committed.find((c) => c.folder === vol.folder);
    if (planned && planned.hasPipelineOutput) continue; // reusing a committed name — good
    let hash;
    try {
      hash = await sha256OfFile(path.resolve(seriesDir, vol.sourceFile));
    } catch {
      continue; // the source is missing; manifestSourcesExist fails loudly
    }
    const owner = byHash.get(hash);
    if (!owner || owner.folder === vol.folder) continue;
    warnings.push(
      `volume ${vol.installmentNumber}: "${owner.folder}" already holds this book's ` +
        `pipeline output — keeping that folder name instead of the planned ` +
        `"${vol.folder}". The folder the agent planned stays behind with a staged ` +
        `book in it; remove it by hand if you want it gone.`
    );
    vol.folder = owner.folder;
    vol.sourceFile = `${owner.folder}/${owner.src.file}`;
    vol.notes = [vol.notes, `folder kept for existing pipeline output: ${owner.folder}`]
      .filter(Boolean)
      .join("; ");
  }
  return warnings;
}

module.exports = {
  readCommittedLayout,
  applyCommittedLayout,
};
