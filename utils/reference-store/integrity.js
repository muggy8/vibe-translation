/**
 * utils/reference-store/integrity.js — the deterministic audit as queries (doc 03 §5).
 *
 * Every query here corresponds to something that actually went wrong in the run that
 * stopped, and every one of them is free. They are the checks copy-forward runs before a
 * volume's file is allowed to become the next volume's starting point (doc 03 §7.3):
 * **a corrupt volume does not get to infect the next one.**
 *
 * The findings are `PostMortemFinding` objects built by `utils/postmortem`'s own
 * constructor, so a copy that fails is a HIGH finding in the same report the step runner
 * already writes — not a warning in a log file nobody reads.
 *
 * Fail-closed rule, stated because it is the interesting one: when the source text a fact
 * cites is not on disk, that is reported as a HIGH finding rather than skipped. "Could not
 * check" and "checked and clean" must not mean the same thing here (the same rule
 * `utils/delivery-verify` states about unreadable artifacts, gotcha 73). There is no
 * switch that turns the evidence check off.
 *
 * ## Where the code lives
 *
 * The code is in `utils/reference-store/integrity/`, one kind of job per file: `rows.js` (the
 * rows that cannot be true — no evidence, evidence from a volume the fact could not have seen,
 * and how much landed in the catch-all), `roster.js` (the roster questions — one person in two
 * entries, an entry headed by the word for "I", claims filed under nobody; all three reported,
 * never merged), `supersession.js` (a `supersedes` chain that comes back around to itself, and a
 * retraction with nothing replacing it), `sealing.js` (the volumes this store represents that were
 * never sealed, which is what makes copy-forward refuse), `coverage.js` (the coverage measurement
 * and `COVERAGE_SIGNIFICANCE_CHAPTERS`, the pinned line between a loss and a mention),
 * `coverage-report.js` (the two findings that measurement produces), `rebuilt.js` (which volumes'
 * documents code rebuilt rather than an author wrote) and `audit.js` (the aggregate: every question
 * in order, each answer turned into a finding). This file is the public surface of the audit and the
 * only thing another module should require; the coverage line and the order the checks run in stay
 * inside this folder, which is a banned patch path for the dev team (AGENTS.md §3).
 *
 * @module utils/reference-store/integrity
 */

const rows = require("./integrity/rows");
const roster = require("./integrity/roster");
const supersession = require("./integrity/supersession");
const sealing = require("./integrity/sealing");
const coverage = require("./integrity/coverage");
const coverageReport = require("./integrity/coverage-report");
const rebuilt = require("./integrity/rebuilt");
const audit = require("./integrity/audit");

// The public surface, unchanged from the single file.
module.exports = {
  INTEGRITY_STEP: audit.INTEGRITY_STEP,
  COVERAGE_SIGNIFICANCE_CHAPTERS: coverage.COVERAGE_SIGNIFICANCE_CHAPTERS,
  factsWithoutEvidence: rows.factsWithoutEvidence,
  impossibleProvenance: rows.impossibleProvenance,
  splitCharacters: roster.splitCharacters,
  brokenSupersession: supersession.brokenSupersession,
  unsealedVolumes: sealing.unsealedVolumes,
  unclassifiedFacts: rows.unclassifiedFacts,
  uncoveredCharacters: coverage.uncoveredCharacters,
  coverageFindings: coverageReport.coverageFindings,
  pronounKeyedRosterEntries: roster.pronounKeyedRosterEntries,
  claimsFiledWithoutARosterEntry: roster.claimsFiledWithoutARosterEntry,
  rebuiltDocuments: rebuilt.rebuiltDocuments,
  integrityFindings: audit.integrityFindings,
};
