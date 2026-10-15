/**
 * utils/postmortem/levels.js — what a finding MEANS to the delivery layer, as data.
 *
 * Severity answers "should the run stop?". The level answers a different question: **how far does the
 * damage travel, and therefore how big a fix should the investigator look for?** The two come apart in
 * real cases — a wedged process blocks everything and needs one command, while a reference file with
 * the wrong shape blocks nothing today and corrupts every volume after it. Collapsing both into one
 * word is why four finding kinds the triage calls damage are emitted at MEDIUM and can never reach its
 * decision (`utils/postmortem/plan/01-finding-levels.md` §1).
 *
 * The four levels, from §3 of that plan:
 *
 * | level | meaning | the fix it expects |
 * |---|---|---|
 * | `STOP` | the deliverable is missing, unreadable or empty — nothing downstream can be built on it | anything; the run is already halted |
 * | `MAJOR` | the deliverable exists and is usable, but it is wrong in a way **every later volume inherits** | major: a rule, a converter, a stage's code |
 * | `MINOR` | wrong in one file of one volume, or in the run's own records; nothing downstream inherits it | minor: one file, one volume, a re-run |
 * | `NOTE` | a measurement, or a leftover that is doing its job | none |
 *
 * **Why this is a table and not a judgement.** The role being investigated must not be the one that
 * grades the finding it is investigated for (§6). So the level is declared here, in code, beside the
 * kind, and `test/test-finding-levels.js` fails the suite when a kind exists with no row. There is no
 * environment variable in this file and there must not be one: a guard the role can switch off is not a
 * guard (AGENTS.md rule 3, gotcha 70).
 *
 * **`level` and `severity` are different axes, and that is not a contradiction.**
 * `reference-evidence-does-not-verify` is emitted at HIGH and is MAJOR: HIGH says "stop now", MAJOR says
 * "the fix is a rule, not a file". `closed-without-outcome` is emitted at HIGH and is MINOR: HIGH says
 * "this record is wrong", MINOR says "one record of one run, and nothing after it inherits it".
 *
 * **The default is MINOR, and it is meant to be unreachable.** An unknown kind gets MINOR — investigated,
 * batched, never a halt — and its finding's own message says the level was undeclared, so an
 * unclassified kind is visible in the report rather than quietly downgraded. The completeness test is
 * what keeps the default from ever being used.
 *
 * This file requires nothing. It is read by `finding()` in ./rules.js, which stamps the level onto every
 * finding at the moment the finding is built, so the level travels with the finding into the report, the
 * JSON sidecar and (from slice 2) the triage.
 *
 * @module utils/postmortem/levels
 */

/**
 * One of the four levels.
 *
 * @typedef {"STOP"|"MAJOR"|"MINOR"|"NOTE"} FindingLevel
 */

/**
 * One row of the table: a finding kind, how far its damage travels, and why in one line.
 *
 * @typedef {Object} FindingLevelRow
 * @property {string} kind - The stable machine-readable finding kind.
 * @property {FindingLevel} level
 * @property {string} why - How far the damage travels, in plain words.
 */

/**
 * The four level names, in the plan's order: halt, pause at the volume boundary, investigate batched,
 * report.
 *
 * @type {FindingLevel[]}
 */
const LEVELS = ["STOP", "MAJOR", "MINOR", "NOTE"];

/**
 * Every finding kind this repository emits, with its level.
 *
 * 70 rows: 68 kinds built by `finding()` plus `missing-required` / `missing-expected`, which
 * ./file.js builds from the expectation's own `level`. `test/test-finding-levels.js` enumerates the
 * kinds from the source text and fails if this table and that list ever differ.
 *
 * @type {FindingLevelRow[]}
 */
const FINDING_LEVEL_ROWS = [
  // ─── STOP — the deliverable is missing, unreadable or empty ────────────────────
  {
    kind: "missing-required",
    level: "STOP",
    why: "the file this step promised is not on disk, so the step that reads it has nothing to read.",
  },
  {
    kind: "missing-volume-folder",
    level: "STOP",
    why: "the plan of record lists a volume with nowhere to write, so every artifact of that book is absent.",
  },
  {
    kind: "empty-or-stub",
    level: "STOP",
    why: "the file is there but holds scaffolding, so a downstream reader gets an empty document.",
  },
  {
    kind: "bad-json",
    level: "STOP",
    why: "every reader of this file parses it, so a half-written one breaks all of them at once.",
  },
  {
    kind: "audit-verdict-fail",
    level: "STOP",
    why: "the cross-artifact sign-off says do not build on this, and the translation stage is what comes next.",
  },
  {
    kind: "record-unreadable",
    level: "STOP",
    why: "the run's own memory cannot be read, so the next run starts without knowing what this one tried.",
  },
  {
    kind: "source-not-archive",
    level: "STOP",
    why: "the book was read from a different file from the one this volume is, so everything built from it came from the wrong text.",
  },
  {
    kind: "no-usable-chapter",
    level: "STOP",
    why: "the extraction produced no chapters, so every stage that walks this volume has nothing to walk.",
  },
  {
    kind: "chapter-extracted-empty",
    level: "STOP",
    why: "a chapter of the book converted to no text, so there is nothing downstream to translate.",
  },
  {
    kind: "guide-split-in-text",
    level: "STOP",
    why: "the book's own text is corrupted in the exact shape every later artifact is built from, and `extract` has no volume-boundary pause to catch it with.",
  },
  {
    kind: "reference-copy-path-undecided",
    level: "STOP",
    why: "the copy could not even be attempted, so this volume's reference record was never made.",
  },
  {
    kind: "reference-copy-missing-source",
    level: "STOP",
    why: "the earlier volume's record this one is built from does not exist, so this volume is not built.",
  },
  {
    kind: "reference-copy-overwrites-a-volume",
    level: "STOP",
    why: "the copy was refused, so the record this volume was supposed to work from was never made.",
  },
  {
    kind: "reference-source-unreadable",
    level: "STOP",
    why: "the earlier volume's record exists but cannot be opened, so this volume is not built.",
  },
  {
    kind: "reference-copy-failed",
    level: "STOP",
    why: "the write failed, so this volume has no reference record and the stage says so out loud.",
  },
  {
    kind: "reference-copy-unreadable-after-copy",
    level: "STOP",
    why: "the record written for this volume is not a readable store, so this volume has nothing to work from.",
  },
  {
    kind: "reference-top-up-failed",
    level: "STOP",
    why: "the record this volume works from could not be completed, so it is missing the earlier volumes' claims.",
  },
  {
    kind: "loop-crashed",
    level: "STOP",
    why: "the loop threw before it recorded what it decided, so the next run inherits no memory of this one.",
  },

  // ─── MAJOR — usable now, wrong in a way every later volume inherits ────────────
  {
    kind: "wrong-shape",
    level: "MAJOR",
    why: "the file is there with real content but is not the document it claims to be, and the next volume is amended from it.",
  },
  {
    kind: "chapter-without-draft",
    level: "MAJOR",
    why: "a chapter of the book was never translated while the volume published as complete, and the later volumes read that volume as finished.",
  },
  {
    kind: "chapter-extraction-never-answered",
    level: "MAJOR",
    why: "a read this volume's glossary was built from produced no term list at all, so the terms it was owed are missing from this volume and from every later volume's copy-forward.",
  },
  {
    kind: "voice-chapter-never-answered",
    level: "MAJOR",
    why: "a chapter this volume's character-voice reference was read from answered nothing on either paid read, so the record every later volume's reference is copied from holds nothing for that chapter.",
  },
  {
    kind: "accepted-without-acceptance",
    level: "MAJOR",
    why: "the volume published on a window no grader signed off, and the next volume copies that record forward.",
  },
  {
    kind: "audit-verdict-missing",
    level: "MAJOR",
    why: "the sign-off prints no verdict, so every later reader of it reads nothing.",
  },
  {
    kind: "grade-failures",
    level: "MAJOR",
    why: "the grade that let this volume through could not be read, so the cumulative artifact it published rests on a signature nobody can check.",
  },
  {
    kind: "step-undeclared",
    level: "MAJOR",
    why: "a whole step has no declared output, so no volume's work from it is checked at all.",
  },
  {
    kind: "record-orphan",
    level: "MAJOR",
    why: "a record the next run reads points at something that is gone, so the plan of record cannot be re-derived.",
  },
  {
    kind: "patch-unjudged",
    level: "MAJOR",
    why: "unjudged code sits in the working tree, and act mode refuses the whole plan for every step after it.",
  },
  {
    kind: "manager-refused",
    level: "MAJOR",
    why: "the loop stopped with no move to make, so every step after it waits for an answer that has not arrived.",
  },
  {
    kind: "reference-character-lost-in-copy",
    level: "MAJOR",
    why: "a character the earlier volume held is gone from the copy, and every later volume is built from that copy.",
  },
  {
    kind: "reference-copy-row-count-mismatch",
    level: "MAJOR",
    why: "the copy is short of rows the source held, and every later volume inherits the shortfall.",
  },
  {
    kind: "reference-volume-unsealed",
    level: "MAJOR",
    why: "the record exists but is still editable, so copy-forward refuses to build any later volume on it.",
  },
  {
    kind: "reference-fact-without-evidence",
    level: "MAJOR",
    why: "a published claim has no evidence behind it, and every later volume inherits it as fact.",
  },
  {
    kind: "reference-evidence-does-not-verify",
    level: "MAJOR",
    why: "a published claim quotes a line the book does not print, and the claim travels into every later volume's copy.",
  },
  {
    kind: "reference-impossible-provenance",
    level: "MAJOR",
    why: "a claim says it was established in a volume its own evidence cannot reach, so the record's history is wrong for every volume after it.",
  },
  {
    kind: "reference-voice-covers-fewer-characters",
    level: "MAJOR",
    why: "the reference covers fewer characters than the roster, and importing it faithfully reproduces the damage in every later volume.",
  },
  {
    kind: "reference-narrator-counted-as-a-character",
    level: "MAJOR",
    why: "the roster counts the narration as a person, so the coverage rule asks every later volume to cover the narration.",
  },
  {
    kind: "reference-attribution-contested-unresolved",
    level: "MAJOR",
    why: "the published reference attributes these words one way and this record's own reading says another, and the published wording carries forward.",
  },
  {
    kind: "reference-claim-attribution-in-doubt",
    level: "MAJOR",
    why: "the record cannot say who speaks these claims, and the doubt is inherited by every volume copied from it.",
  },
  {
    kind: "reference-character-split-in-two",
    level: "MAJOR",
    why: "one person is filed under two names, and every later volume inherits the split.",
  },
  {
    kind: "reference-character-keyed-by-a-pronoun",
    level: "MAJOR",
    why: "a character's section is headed with the word for \"I\", and that heading is rendered into every later volume.",
  },
  {
    kind: "reference-claim-filed-without-a-roster-entry",
    level: "MAJOR",
    why: "claims sit in the record with no character over them, and the next volume copies them forward unowned.",
  },
  {
    kind: "reference-claim-carries-unfinished-prose",
    level: "MAJOR",
    why: "a published claim carries the writer's own drafting note, and the render repeats it in every later volume.",
  },
  {
    kind: "reference-broken-supersession",
    level: "MAJOR",
    why: "a claim replaces one that is not there, and the broken chain is copied into every later volume.",
  },
  {
    kind: "reference-facts-unclassified",
    level: "MAJOR",
    why: "facts landed in the fallback bucket, so every later volume inherits a record it cannot query.",
  },
  {
    kind: "reference-top-up-schema-mismatch",
    level: "MAJOR",
    why: "rows are not copied between records of different shapes, so this volume's record is missing the earlier volumes' claims.",
  },
  {
    kind: "reference-artifact-line-unreadable",
    level: "MAJOR",
    why: "the published reference holds a line nothing can read, and the render reproduces that line in every later volume.",
  },
  {
    kind: "reference-artifact-has-no-sections",
    level: "MAJOR",
    why: "the published reference has no addressable entries, and the same shape is rendered for every later volume.",
  },

  // ─── MINOR — one file of one volume, or one record of one run ──────────────────
  {
    kind: "missing-expected",
    level: "MINOR",
    why: "an optional file is absent from one volume, and nothing downstream is built on it.",
  },
  {
    kind: "unexpected-file",
    level: "MINOR",
    why: "a file the pipeline does not recognise sits in one volume folder, so what that folder was measured against is wrong.",
  },
  {
    kind: "record-incomplete",
    level: "MINOR",
    why: "one run record is missing the half the next run reads, and the next run re-derives it from the disk anyway.",
  },
  {
    kind: "record-shape",
    level: "MINOR",
    why: "one record holds a field this layer never writes, which misleads whoever reads that record, not the book.",
  },
  {
    kind: "duplicate-record-id",
    level: "MINOR",
    why: "one id appears twice in one record file, so half of that record is unreachable to whoever looks it up.",
  },
  {
    kind: "menu-without-options",
    level: "MINOR",
    why: "one answered ticket offers no options and does not say so, so the next run waits on a move that does not exist.",
  },
  {
    kind: "answer-without-diagnosis",
    level: "MINOR",
    why: "one ticket is marked answered with no explanation behind it, so the manager picks blind for that one ticket.",
  },
  {
    kind: "closed-without-outcome",
    level: "MINOR",
    why: "one ticket closed without a measured outcome, so this run's ledger counts a move as tried-and-failed.",
  },
  {
    kind: "claim-unsupported",
    level: "MINOR",
    why: "a command claimed an output the disk does not show; the missing file is reported by its own finding, so this one is about the record.",
  },
  {
    kind: "run-lock-stale",
    level: "MINOR",
    why: "a lock left by a process that is gone sits in the run's records; act mode replaces it, so nothing downstream inherits it.",
  },
  {
    kind: "run-lock-unverifiable",
    level: "MINOR",
    why: "a lock this machine cannot check blocks act mode until one file is deleted — one file, in the run's own folder.",
  },
  {
    kind: "run-lock-stalled",
    level: "MINOR",
    why: "a live run has stopped making progress; the answer is one command and no artifact is involved.",
  },
  {
    kind: "reference-record-reattached-to-its-source",
    level: "MINOR",
    why: "a reopened volume arrived as an empty shell and was repaired before it published, so the hole was closed before anything inherited it.",
  },
  {
    kind: "title-is-filename",
    level: "MINOR",
    why: "one chapter is titled with a file name, so the reports about that chapter read wrong.",
  },
  {
    kind: "ruby-harvest-missing",
    level: "MINOR",
    why: "one volume's pronunciation-guide cache is absent, so a later \"how is this word read?\" question has no answer for that volume.",
  },
  {
    kind: "voice-chapter-kept-cut-off",
    level: "MINOR",
    why: "the chapter's answer stopped before its closing bracket and whatever it had not written yet is missing from the record — real damage, but the one real volume this repository read needed a second paid read on 2 of its 7 chapters and a MAJOR here would pause a 17-volume run over something routine.",
  },

  // ─── NOTE — a measurement, or a leftover that is doing its job ─────────────────
  {
    // Demoted from MAJOR by plan 06 slice 9 (2026-10-15). The old `why` claimed this gap "carries into
    // every later volume's copy", which is true of the roster and was never the decision being made: the
    // decision was *whether a character nobody wrote about is worth stopping a 17-volume run for*, and on
    // this corpus the guard fired on names a shop clerk drops once. The carrying-forward is still caught —
    // `reference-voice-covers-fewer-characters` (MAJOR, untouched) stops a reference that lost a character
    // the volume's own text puts on a page and the extraction noticed. What is left here is the tail, and
    // the tail is now decided once, at the end of the series, by the closing cast reconciliation.
    kind: "reference-voice-mention-not-covered",
    level: "NOTE",
    why:
      "the reference says nothing about a character this volume's text names, and the per-book stop is no " +
      "longer this finding's job: the name is printed per book in the volume's validation report the grader " +
      "reads, and the decision — is this character interchangeable? — is taken once for the whole series by " +
      "the closing cast reconciliation (character-voice/reconcile.js), which names every one of them. The " +
      "half that does carry forward is still a stop: reference-voice-covers-fewer-characters.",
  },
  {
    kind: "quarantine-present",
    level: "NOTE",
    why: "a gate fired and kept its evidence; the deliverable beside it is checked by its own finding, so this line is context rather than damage.",
  },
  {
    kind: "reference-document-rebuilt-from-extraction",
    level: "NOTE",
    why: "a measurement of how this reference was made — every bullet in it cites a line of the volume's text, and nothing is wrong.",
  },
  {
    kind: "reference-source-schema-upgraded",
    level: "NOTE",
    why: "the copy brought an older record up to the current schema, and the upgrade succeeded.",
  },
  {
    kind: "manager-corrected",
    level: "NOTE",
    why: "the manager's first answer was refused and its second was a move the state supports: the design working once.",
  },
  {
    kind: "nothing-executed",
    level: "NOTE",
    why: "act mode ran and executed nothing, which is one of the legitimate answers a plan can give.",
  },
];

/**
 * The table, keyed by kind. Built from the rows above so a row can never be added without a kind.
 *
 * @type {Object<string, FindingLevelRow>}
 */
const FINDING_LEVELS = {};
for (const row of FINDING_LEVEL_ROWS) {
  FINDING_LEVELS[row.kind] = row;
}

/**
 * The level declared for one finding kind.
 *
 * An unknown kind returns `"MINOR"` — investigated, batched, never a halt — because the safe default
 * for something nobody classified is to look into it without stopping a run. The caller (`finding()` in
 * ./rules.js) adds a note to the finding's own message so the missing row is visible in the report, and
 * `test/test-finding-levels.js` fails the suite while any kind the repository emits is missing from the
 * table, which is what makes this default unreachable in practice.
 *
 * @param {string} kind
 * @returns {FindingLevel}
 */
function levelFor(kind) {
  const row = FINDING_LEVELS[kind];
  return row ? row.level : "MINOR";
}

module.exports = { LEVELS, FINDING_LEVELS, FINDING_LEVEL_ROWS, levelFor };
