/**
 * test-glossary-load.js — self-checks for the pure parsing helpers in
 * glossary.js and jump-in-wiki.js. Run with `npm test`.
 */
const assert = require("assert");

const { parseTerms } = require("./glossary");
const {
  transformUserPrompt,
  splitJumpInWikiGenerationOutput,
  isPassingVerdict,
  installmentNumberFromDir,
} = require("./jump-in-wiki");

// ─── parseTerms ─────────────────────────────────────────────────────────────
assert.deepStrictEqual(parseTerms(""), []);
assert.deepStrictEqual(parseTerms(null), []);
assert.deepStrictEqual(
  parseTerms('```json\n[{"term":"如月雨露","type":"character","query":"如月雨露"}]```'),
  [{ term: "如月雨露", type: "character", query: "如月雨露" }]
);
assert.deepStrictEqual(
  parseTerms('[{"term":"A"}]'),
  [{ term: "A", type: "concept", query: "A" }]
);
assert.deepStrictEqual(
  parseTerms('Here are the terms:\n[{"term":"B","type":"item","query":"B"}]\nDone.'),
  [{ term: "B", type: "item", query: "B" }]
);
assert.deepStrictEqual(
  parseTerms('[{"term":"  "},{"term":"C","type":"place"}]'),
  [{ term: "C", type: "place", query: "C" }]
);
assert.throws(() => parseTerms("no json here"), /No JSON array/);
assert.throws(() => parseTerms('{"term":"A"}'), /No JSON array/);

// ─── transformUserPrompt ────────────────────────────────────────────────────
assert.strictEqual(
  transformUserPrompt("Hi {{NAME}}, vol {{NUM}}", { NAME: "X", NUM: "01" }),
  "Hi X, vol 01"
);
assert.throws(() => transformUserPrompt("{{A}}", { A: "" }), /Missing value/);
assert.throws(() => transformUserPrompt("{{A}} {{B}}", { A: "1" }), /Unfilled placeholder/);

// ─── splitJumpInWikiGenerationOutput ────────────────────────────────────────
const full = [
  "---- jump-in-wiki-01.md ----",
  "",
  "Wiki content",
  "",
  "---- jump-in-wiki-shared.md ----",
  "",
  "Shared content",
  "",
  "---- end ----",
].join("\n");
assert.deepStrictEqual(splitJumpInWikiGenerationOutput(full), ["Wiki content", "Shared content"]);

// Tolerates a missing "---- end ----" marker.
const noEnd = full.replace("---- end ----\n", "");
assert.deepStrictEqual(splitJumpInWikiGenerationOutput(noEnd), ["Wiki content", "Shared content"]);

// A missing shared marker must not drop the wiki's last lines.
const noSharedMarker = "---- jump-in-wiki-01.md ----\n\nOnly wiki\n---- end ----\n";
assert.deepStrictEqual(splitJumpInWikiGenerationOutput(noSharedMarker), ["Only wiki", ""]);

// ─── isPassingVerdict ───────────────────────────────────────────────────────
assert.strictEqual(isPassingVerdict("PASS"), true);
assert.strictEqual(isPassingVerdict("  pass\n"), true);
assert.strictEqual(isPassingVerdict("PASS with minor edits"), true);
assert.strictEqual(isPassingVerdict("Verdict: PASS"), true);
assert.strictEqual(isPassingVerdict("FAIL"), false);
assert.strictEqual(isPassingVerdict("The glossary does not pass."), false);
assert.strictEqual(isPassingVerdict("FAIL — it does not pass the check."), false);
assert.strictEqual(isPassingVerdict(""), false);
assert.strictEqual(isPassingVerdict(undefined), false);

// ─── installmentNumberFromDir ───────────────────────────────────────────────
assert.strictEqual(installmentNumberFromDir("Series(1)"), "01");
assert.strictEqual(installmentNumberFromDir("Series(12)"), "12");
assert.throws(() => installmentNumberFromDir("Series"), /Cannot derive/);

console.log("All parse-helper tests passed.");
