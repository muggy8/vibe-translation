/**
 * extract/bundle-state.js — which of the two things happened to a volume's bundle.
 *
 * The extraction step owes the operator one answer per volume: **did it verify what was already on
 * disk, or did it extract the book again?** `utils/source/plan/01-extraction-step.md` §2 is explicit
 * that a step which re-extracts 17 books on every run is a step people skip, so the answer has to be
 * printed, per volume, and it has to be true.
 *
 * THE RULE IS A READ OF WHAT THE BUNDLE LAYER ALREADY ANSWERS. `resolveSourceBundle` compares the
 * archive's mtime + size + sha256 against the cached `<base>-bundle.meta.json`, compares the cache's
 * `schema` against `BUNDLE_SCHEMA_VERSION`, and checks that every segment file and the pronunciation
 * harvest are still on disk; when all of that holds it returns `cacheHit: true` and reuses the bundle,
 * and when any of it fails it re-extracts and returns `cacheHit: false`. That is the freshness rule.
 * This file does not re-implement it — a second copy of "is this cache current" is how two modules end
 * up disagreeing about whether a volume is extracted (gotcha 40's shape). It reads the answer, plus
 * one fact the bundle layer cannot report after the fact: whether a cache was there BEFORE the call.
 *
 * The fourth state is the plain-text volume. A `.txt` / `.md` book has no bundle cache to verify or
 * re-extract — `resolveSourceBundle` reads it and hands back a bundle built in memory, with
 * `cacheHit: false` because no cache was consulted. Calling that "re-extracted" would be a lie about
 * work that did not happen, so it gets its own word: READ. (An oversized plain-text source IS cut into
 * cached part files, and there `cacheHit` means what it always means.)
 *
 * Part of the extract step (extract.js).
 */

const fs = require("fs").promises;

require("../types"); // JSDoc type definitions

const { BUNDLE_SCHEMA_VERSION } = require("../utils/source/config");

/**
 * The extraction cache's own file name shape (`<source base>-bundle.meta.json`, written by
 * `utils/source/bundle.js`). Matched rather than rebuilt from the source name so this file never has
 * to recompute the bundle's `base` — the same "read the extraction's own record, do not re-derive it"
 * rule `utils/source/audit/rules.js` follows.
 *
 * @type {RegExp}
 */
const BUNDLE_META_RE = /-bundle\.meta\.json$/;

/**
 * Whether a volume folder already holds an extraction cache, read BEFORE the bundle is resolved.
 *
 * This is the one fact `resolveSourceBundle` cannot report afterwards: `cacheHit: false` says the
 * bundle was produced now, not whether it replaced a stale cache or was produced for the first time.
 * Those two are different sentences — "this book was never extracted" and "this book's extraction is
 * out of date" — and the second is the one an operator needs to see after a converter change.
 *
 * @param {string} volumeDir - The volume folder.
 * @returns {Promise<boolean>} True when a `<base>-bundle.meta.json` is in the folder.
 */
async function bundleCachePresent(volumeDir) {
  let names;
  try {
    names = await fs.readdir(volumeDir);
  } catch {
    return false;
  }
  return names.some((name) => BUNDLE_META_RE.test(name));
}

/**
 * @typedef {Object} BundleState
 * What the step did to one volume's bundle, and the sentence that says so.
 * @property {"verified"|"re-extracted"|"extracted"|"read"} state - The machine-readable answer.
 * @property {string} label - The word printed in the log line: VERIFIED / RE-EXTRACTED / EXTRACTED / READ.
 * @property {string} reason - Why that state, in one clause.
 * @property {string} line - The whole log line, already prefixed with `[extract]`.
 */

/**
 * Decide which of the two the step did — verify or extract — from what the bundle layer reported.
 *
 * @param {Object} p
 * @param {SourceBundle} p.bundle - The bundle `resolveSourceBundle` returned.
 * @param {boolean} p.cacheWasThere - Whether a bundle cache existed in the folder before the call.
 * @param {TranslationTargetVolume} p.volume - The plan of record's volume entry.
 * @returns {BundleState}
 */
function bundleStateOf({ bundle, cacheWasThere, volume }) {
  const sourceName = String(bundle.base || "") + (bundle.format === "epub" ? ".epub" : "");
  const segments = `${bundle.segments.length} segment(s)`;

  if (bundle.format === "text" && !bundle.cacheHit) {
    return {
      state: "read",
      label: "READ",
      reason: "a plain-text source has no bundle cache to verify",
      line:
        `[extract] Volume ${volume.installmentNumber || volume.folder} · READ — "${sourceName}" is a ` +
        `plain-text source: no bundle cache to verify and nothing written, ${segments} read as-is.`,
    };
  }

  if (bundle.cacheHit) {
    return {
      state: "verified",
      label: "VERIFIED",
      reason: `the bundle on disk matches the archive and schema ${BUNDLE_SCHEMA_VERSION}`,
      line:
        `[extract] Volume ${volume.installmentNumber || volume.folder} · VERIFIED — "${sourceName}" is ` +
        `unchanged and its bundle is current (schema ${BUNDLE_SCHEMA_VERSION}, sha256 ` +
        `${String(bundle.sourceFingerprint || "unknown").slice(0, 12)}…): ${segments} reused, ` +
        `nothing re-extracted.`,
    };
  }

  if (cacheWasThere) {
    return {
      state: "re-extracted",
      label: "RE-EXTRACTED",
      reason: "a cached bundle was already in the folder and is no longer current",
      line:
        `[extract] Volume ${volume.installmentNumber || volume.folder} · RE-EXTRACTED — the folder ` +
        `already held a bundle for "${sourceName}" and it is no longer current (the archive changed, a ` +
        `bundle file is gone, or the cache predates schema ${BUNDLE_SCHEMA_VERSION} — the [source] line ` +
        `above names which). ${segments} written.`,
    };
  }

  return {
    state: "extracted",
    label: "EXTRACTED",
    reason: "no bundle existed for this volume yet",
    line:
      `[extract] Volume ${volume.installmentNumber || volume.folder} · EXTRACTED — no bundle existed ` +
      `for "${sourceName}" yet: ${segments} written.`,
  };
}

module.exports = {
  BUNDLE_META_RE,
  bundleCachePresent,
  bundleStateOf,
};
