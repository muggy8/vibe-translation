/**
 * utils/prereqs/gap-wording.js — the short half of a file verdict: the phrase a refusal is made of.
 *
 * `assessFile` answers with the post-mortem's full finding, whose message carries the expectation's
 * whole `why` paragraph — right in a report, unreadable in a refusal. This file keeps the half a
 * refusal can carry: the file's name and what is wrong with it, and nothing else, in the one shape
 * that reads correctly after "volume 03" and after "the series root".
 *
 * @module utils/prereqs/gap-wording
 */

/** @typedef {import("../postmortem").PostMortemFinding} PostMortemFinding */

/**
 * The short, actionable half of a file verdict.
 *
 * `assessFile` returns the post-mortem's full finding, whose message carries the expectation's whole
 * `why` paragraph — right in a report, unreadable in a refusal. The refusal needs the file and what
 * is wrong with it, and nothing else.
 *
 * @param {PostMortemFinding} verdict - The finding `assessFile` produced.
 * @param {import("../artifacts").ArtifactExpectation} expectation
 * @returns {string} A phrase beginning with "has" / "has no", ready to follow "volume 03".
 */
function gapPhrase(verdict, expectation) {
  const name = expectation.name.replace("{installment}", "");
  switch (verdict.kind) {
    case "missing-required":
    case "missing-expected":
      return `has no ${name}`;
    case "empty-or-stub":
      return `has ${name}, which is empty or still holds a scaffold stub`;
    case "bad-json":
      return `has ${name}, which is not parseable JSON`;
    case "wrong-shape":
      return `has ${name}, which is not the ${expectation.shape || "document"} shape this step declares`;
    default:
      return `has ${name}, which this step did not produce as declared (${verdict.kind})`;
  }
}

module.exports = {
  gapPhrase,
};
