/**
 * The one prompt this task builds in code: the block that tells a chapter's extraction pass what this
 * volume's own earlier chapters have already produced.
 *
 * The prompt *files* stay mode-agnostic; what is assembled here is the running tally the reading pass
 * keeps. The author turn, the validator turn, the feedback turn and the findings-merge turn went with
 * the route that sent them (git history at commit 75e59a7).
 *
 * Part of the character-voice.js layer (split out of the original single file).
 */

require("dotenv").config();
require("../types");

/**
 * The block that tells a chapter's extraction pass what this volume's own earlier chapters have
 * already produced.
 *
 * Why it exists. `chapterSegmentNote` tells every chapter of a volume that "the cumulative reference
 * material already covers the chapters before it". That is only true of a pass that has been compiling
 * as it went. In the reading-only route (`character-voice/reading.js` → the record → the render) there
 * is no such file, so the same sentence would be a lie and the extractor would re-claim what chapter 2
 * already found. This block is the honest substitute: it names the chapters already read and the claims
 * they produced, in a shape smaller than the duplicate output it prevents.
 *
 * It lists **who and what kind**, not the claim text: the extractor needs to know a claim exists, not
 * to read it, and the claim text is already in the record.
 *
 * @param {{installmentNumber: string|number, segmentsTotal: number, doneSegments: string[], entries: Array<Object>}} opts
 * @returns {string|null} The block, or null when this is the first chapter (there is nothing yet).
 */
function buildAlreadyExtractedNote({ installmentNumber, segmentsTotal, doneSegments, entries }) {
  if (!Array.isArray(doneSegments) || doneSegments.length === 0) return null;

  /** @type {Map<string, Map<string, number>>} character → quirk label → how many claims */
  const byCharacter = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== "object") continue;
    // A POV claim names its character in `assignedCharacter`, not `character`. Reading only
    // `character` puts every POV claim under a heading that says nobody was named, which is noise
    // shown to the model.
    const named = entry.type === "pov" && typeof entry.assignedCharacter === "string" && entry.assignedCharacter.trim()
      ? entry.assignedCharacter.trim()
      : (typeof entry.character === "string" ? entry.character.trim() : "");
    const name = named || (entry.type === "pov" ? "(POV, unassigned)" : "(no character named)");
    const kind = entry.type === "pov"
      ? (typeof entry.marker === "string" && entry.marker.trim() ? `POV ${entry.marker.trim()}` : "POV")
      : (typeof entry.quirkType === "string" && entry.quirkType.trim() ? entry.quirkType.trim() : "voice");
    const kinds = byCharacter.get(name) || new Map();
    kinds.set(kind, (kinds.get(kind) || 0) + 1);
    byCharacter.set(name, kinds);
  }

  const lines = [...byCharacter.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, kinds]) => {
      const total = [...kinds.values()].reduce((sum, n) => sum + n, 0);
      return `- ${name}: ${[...kinds.entries()].map(([kind, n]) => `${kind} x${n}`).join(", ")} (${total} claim(s))`;
    });

  return (
    `## Already extracted in volume ${installmentNumber}\n\n` +
    `The chapters already read in this pass, in reading order: ${doneSegments.join(", ")} ` +
    `(${doneSegments.length} of ${segmentsTotal}). What they have already recorded:\n\n` +
    (lines.length ? lines.join("\n") : "- nothing yet") +
    `\n\nThe reference above covers the volumes BEFORE volume ${installmentNumber}; the list above is ` +
    `what this volume's own earlier chapters produced. Do not repeat a claim that is already recorded — ` +
    `extract only what this chapter adds or changes.`
  );
}


module.exports = {
  buildAlreadyExtractedNote,
};
