/**
 * utils/reference-store/rebuild/names.js — who a claim is filed under, decided before any claim
 * is filed.
 *
 * The human half of name resolution (an alias declared through the store's own `castAlias`, which
 * refuses a link with no reason) and the half read out of the volume's own published glossary. Both
 * run **before** filing, because `castAlias` treats an alias that is already its own roster entry as a
 * merge, and a rebuild that files first and declares afterwards ends up merging a roster it just built.
 *
 * @module utils/reference-store/rebuild/names
 */

const fs = require("fs");
const path = require("path");

const { parseGlossaryMarkdown, firstPersonAliasDeclarations } = require("../glossary-adapter");
require("../../../types"); // JSDoc type definitions

// `displayAliasSpans` and `resolveExtractionName` live in `name-resolution.js`, the leaf both this
// module and `extraction-adapter.js` require so the two doors that file extraction names into the
// record cannot drift into two different answers about the same name.

/**
 * Declare an alias the artifacts do not record, through the store's own verb.
 *
 * This is the human-supplied half of name resolution, and it goes through `castAlias` because that is
 * the door that records a reason. When the alias is already its own cast entry `castAlias` treats it
 * as a merge, which is why declarations are applied **before** any claim is filed: the alias should be
 * an alias of a roster entry, not a second roster entry that then has to be merged away.
 *
 * @param {ReferenceStore} store
 * @param {Array<{key: string, alias: string, reason: string}>} aliases
 * @returns {{applied: Array<{key: string, alias: string}>, refused: Array<{key: string, alias: string, because: string}>}}
 */
function applyAliasDeclarations(store, aliases = []) {
  const applied = [];
  const refused = [];
  for (const entry of Array.isArray(aliases) ? aliases : []) {
    const key = typeof entry?.key === "string" ? entry.key.trim() : "";
    const alias = typeof entry?.alias === "string" ? entry.alias.trim() : "";
    const reason = typeof entry?.reason === "string" ? entry.reason.trim() : "";
    if (!key || !alias) {
      refused.push({ key, alias, because: "an alias declaration needs both the roster entry and the alias." });
      continue;
    }
    if (!reason) {
      refused.push({ key, alias, because: `the alias ${alias} → ${key} needs a reason: the store records why a name was linked, not just that it was.` });
      continue;
    }
    const result = store.castAlias(key, alias, reason);
    if (result.ok) applied.push({ key, alias });
    else refused.push({ key, alias, because: result.refusal.because });
  }
  return { applied, refused };
}

/**
 * The first-person declarations this volume's own published glossary carries.
 *
 * `importGlossary` applies these when the stage imports the glossary; `rebuildVoiceVolume` never imports
 * it, so the same rule is read from the same file here. One rule, two doors, one answer.
 *
 * A glossary that is not there is not a failure: a volume may be rebuilt before its glossary exists, and
 * the pronoun rule then simply has nothing to say, which is what `resolveExtractionName` reports.
 *
 * @param {string} volumeDir - The volume folder.
 * @returns {{declarations: Array<{key: string, alias: string, reason: string}>, ambiguous: Array<{alias: string, keys: string[]}>}}
 */
function declarationsFromVolumeGlossary(volumeDir) {
  const file = path.join(volumeDir, "glossary.md");
  let markdown;
  try {
    markdown = fs.readFileSync(file, "utf8");
  } catch {
    return { declarations: [], ambiguous: [] };
  }
  return firstPersonAliasDeclarations(parseGlossaryMarkdown(markdown));
}

module.exports = {
  applyAliasDeclarations,
  declarationsFromVolumeGlossary,
};
