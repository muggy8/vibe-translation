/**
 * utils/artifacts/preproduction.js — what the seven pre-production steps owe each volume, the series
 * root, and (for `extract`) the run's own records.
 *
 * The cumulative tasks (glossary, character voice, style guide, wiki) owe a volume copy AND a
 * series-root copy, because the translation stage reads the root copies; the audit owes the
 * report nobody else carries. `required` is only set where the pipeline writes the file on
 * EVERY path it can reach — over-declaring is worse than under-declaring, because a check that
 * fires on healthy output trains everyone to ignore the check.
 *
 * `extract` is the one pre-production step whose deliverable is a RECORD rather than a corpus
 * artifact, so it is the one step that declares `run` expectations, and the only pipeline step
 * allowed to. That permission is the account owner's decision of 2026-10-12
 * (`utils/postmortem/plan/01-finding-levels.md` §10) and it reversed the earlier pinned invariant —
 * read gotcha 127 before adding a second one.
 */

const { researchEnabled, QUARANTINED_CUMULATIVE } = require("./rules");

/** @typedef {import("../artifacts").ArtifactExpectation} ArtifactExpectation */
/** @typedef {import("../artifacts").QuarantineExpectation} QuarantineExpectation */
/** @typedef {import("../artifacts").ArtifactContext} ArtifactContext */

const PREPRODUCTION_SPECS = {
  extract: {
    step: "extract",
    // The extraction step's deliverable is not a file in the corpus. It is the bundle inside each volume
    // folder (names the intake already knows: `-bundle.meta.json`, `-whole.md`, `-chN.md`,
    // `-ruby-guides.json`) and the record of what the extraction produced, which the step writes into
    // the run's own folder (`postMortemDir()`) and proves it wrote with `assertWrote`
    // (`extract/reports.js`).
    //
    // IT DECLARES ITS OWN RECORDS NOW, and that is a decision, not a step's own business. Until
    // 2026-10-12 this entry was empty and `test/test-delivery-audit.js` pinned that no pipeline step
    // may declare a run scope (gotcha 127). The account owner reversed it in
    // `utils/postmortem/plan/01-finding-levels.md` §10 for one reason: `extract` writes 17 reports and
    // a crash part-way through leaves some written and some not, and a check that only looks at the
    // summary cannot tell "the step ran and found nothing" from "the step stopped after book 9". The
    // guard is amended, not deleted — the other twelve pipeline steps are still pinned to declare
    // nothing, and the exception is named in the test with its reason.
    //
    // WHY `required` AND NOT `expected`, against rule 1 (a `required` file is one the writer produces
    // on EVERY path it can reach). Checked against `extract/run.js`, not assumed:
    //   - a volume whose archive would not open still gets its report pair — `extractOneVolume`
    //     catches the failure, builds a `FAILED` record, and `writeVolumeReport` runs after the
    //     catch, so the report exists for a volume the step could not read;
    //   - the summary pair is written before the step throws, on the HIGH path and on the
    //     could-not-be-read path (`extractVolumes` calls `writeSeriesSummary` before it counts or
    //     fails), so a run that stops on a bad book still leaves its account of what is wrong;
    //   - the step audits every volume before it fails, so no volume is skipped because a neighbour
    //     broke.
    // The one path that writes nothing is `--dry-run`, and the runner never assesses a dry run
    // (`index/steps.js`: `runAssessment = parsed.postMortem && !dryRun`, with no knob that can force
    // it back on), so there is no path where the step exits clean and the check fires on it. A step
    // that died before writing anything — killed mid-series, or a source it could not open at all —
    // is exactly the case this declaration exists to name, and HIGH is what makes the triage see it:
    // a MEDIUM here would be reported and dropped, which is the gap
    // `utils/postmortem/plan/01-finding-levels.md` §1 exists to close.
    //
    // `perInstallment` is the shape that makes the per-book half expressible at all: a flat list of
    // run file names can say "the summary is missing" but cannot say which book lost its report.
    // The names are `extraction-<key>.md` where `<key>` is the volume's report key — the same rule
    // `extract/reports.js` uses, pinned against it in `test/test-extract-run-scope.js` because two
    // implementations of one naming rule is a pair that drifts.
    perVolume: false,
    volume: [],
    series: [],
    quarantines: [],
    run: [
      {
        name: "extraction-{installment}.md",
        perInstallment: true,
        level: "required",
        shape: "document",
        why: "the account of one book — what was extracted or verified, its chapters, the pages left " +
          "out as packaging, the guide totals and every finding the audit raised. It is written for a " +
          "volume the step could NOT read as well as for one it could, so its absence means the step " +
          "never reached this volume, not that the volume is broken",
      },
      {
        name: "extraction-{installment}.json",
        perInstallment: true,
        level: "required",
        shape: "json",
        why: "the same account in the form a later slice queries — the glossary plan is built on these " +
          "numbers, and a plan that has to re-parse a Markdown table to get them re-derives them by hand",
      },
      {
        name: "extraction-summary.md",
        level: "required",
        shape: "document",
        why: "the one table across the volumes, which is what makes \"this change hit one book\" visible " +
          "as a difference instead of a rumour. Written before the step throws, on every failing path",
      },
      {
        name: "extraction-summary.json",
        level: "required",
        shape: "json",
        why: "the totals a later run compares against this one — the only way to tell a series whose " +
          "chapter count moved from one whose reports were simply never written",
      },
    ],
  },

  discover: {
    step: "discover",
    perVolume: false,
    volume: [],
    series: [
      {
        name: "translation-target.json",
        level: "required",
        shape: "json",
        why: "the plan of record every other step reads",
      },
      {
        name: "translation-plan.md",
        level: "expected",
        shape: "document",
        why: "the human-readable version of the plan",
      },
    ],
    quarantines: [],
  },

  glossary: {
    step: "glossary",
    perVolume: true,
    volume: [
      {
        name: "glossary.md",
        level: "required",
        shape: "table",
        why: "the volume's glossary snapshot — terminology law for the translator",
      },
      {
        name: "glossary-validation.md",
        level: "required",
        shape: "document",
        why: "the validator's report (chunked mode assembles it from per-chapter partials)",
      },
      {
        name: "glossary-validation-rolling-state.json",
        level: "required",
        shape: "json",
        why: "the acceptance window this volume was accepted on — the skip-check reads it",
      },
      {
        name: "glossary-new-terms.json",
        level: "expected",
        shape: "json",
        why: "the new-terms extraction snapshot the handoff summarizes",
      },
      {
        name: "glossary-coverage.md",
        level: "expected",
        shape: "document",
        why: "the deterministic coverage audit (no AI) — the hallucinated-entry check",
      },
      {
        name: "glossary-coverage.json",
        level: "expected",
        shape: "json",
        why: "the machine-readable half of the coverage audit",
      },
      {
        name: "glossary-research.md",
        level: "expected",
        shape: "document",
        why: "the per-term research notes",
        when: researchEnabled,
      },
    ],
    series: [
      {
        name: "glossary.md",
        level: "required",
        shape: "table",
        why: "the newest per-volume snapshot, published as the series' canonical glossary",
      },
      {
        name: "glossary.md.provenance.json",
        level: "expected",
        shape: "json",
        why: "which volume snapshot the root copy came from",
      },
    ],
    quarantines: [QUARANTINED_CUMULATIVE],
  },

  "character-voice": {
    step: "character-voice",
    perVolume: true,
    volume: [
      {
        name: "character-voice.md",
        level: "required",
        shape: "document",
        why: "the cumulative character voice reference",
      },
      {
        name: "pov-map.md",
        level: "required",
        shape: "document",
        why: "this volume's POV map (per-volume, so it is the one file the seed does not copy)",
      },
      {
        name: "character-voice-validation.md",
        level: "required",
        shape: "document",
        why: "the validator's report",
      },
      {
        name: "character-voice-validation-rolling-state.json",
        level: "required",
        shape: "json",
        why: "the acceptance window this volume was accepted on",
      },
      {
        name: "character-voice-new.json",
        level: "expected",
        shape: "json",
        why: "the quirk/POV extraction snapshot the handoff summarizes",
      },
    ],
    series: [
      {
        name: "character-voice.md",
        level: "required",
        shape: "document",
        why: "the newest per-volume snapshot, published at the series root",
      },
      {
        name: "character-voice.md.provenance.json",
        level: "expected",
        shape: "json",
        why: "which volume snapshot the root copy came from",
      },
    ],
    quarantines: [QUARANTINED_CUMULATIVE],
  },

  "style-guide": {
    step: "style-guide",
    perVolume: true,
    volume: [
      {
        name: "style-guide.md",
        level: "required",
        shape: "document",
        why: "the cumulative style guide — how source constructs are rendered",
      },
      {
        name: "style-guide-validation.md",
        level: "required",
        shape: "document",
        why: "the validator's report",
      },
      {
        name: "style-guide-validation-rolling-state.json",
        level: "required",
        shape: "json",
        why: "the acceptance window this volume was accepted on",
      },
      {
        name: "style-guide-new.json",
        level: "expected",
        shape: "json",
        why: "the style-observation extraction snapshot the handoff summarizes",
      },
    ],
    series: [
      {
        name: "style-guide.md",
        level: "required",
        shape: "document",
        why: "the newest per-volume snapshot, published at the series root",
      },
      {
        name: "style-guide.md.provenance.json",
        level: "expected",
        shape: "json",
        why: "which volume snapshot the root copy came from",
      },
    ],
    quarantines: [QUARANTINED_CUMULATIVE],
  },

  "jump-in-wiki": {
    step: "jump-in-wiki",
    perVolume: true,
    volume: [
      {
        name: "wiki.md",
        level: "required",
        shape: "document",
        why: "this volume's wiki",
      },
      {
        name: "shared-wiki.md",
        level: "required",
        shape: "document",
        why: "series state through this volume — the story background the translator reads",
      },
      {
        name: "jump-in-wiki-validation-{installment}.md",
        level: "required",
        shape: "document",
        why: "the validator's report for this volume",
      },
      {
        name: "jump-in-wiki-validation-{installment}-rolling-state.json",
        level: "required",
        shape: "json",
        why: "the acceptance window this volume was accepted on",
      },
      {
        name: "chapters.json",
        level: "required",
        shape: "json",
        why: "the deterministic translation handoff's chapter list",
      },
      {
        name: "translation-brief.md",
        level: "required",
        shape: "document",
        why: "the one-page brief — what is new in this volume, and a completeness check",
      },
    ],
    series: [
      {
        name: "shared-wiki.md",
        level: "required",
        shape: "document",
        why: "the last publishable per-volume copy, published at the series root",
      },
      {
        name: "shared-wiki.md.provenance.json",
        level: "expected",
        shape: "json",
        why: "which volume snapshot the root copy came from",
      },
    ],
    quarantines: [],
  },

  "consistency-audit": {
    step: "consistency-audit",
    perVolume: false,
    volume: [],
    series: [
      {
        name: "consistency-report.md",
        level: "required",
        shape: "document",
        why: "the pre-translation sign-off",
      },
      {
        name: "consistency-report.md.provenance.json",
        level: "expected",
        shape: "json",
        why: "the fingerprint of the four audited artifacts — what makes the report re-runnable",
      },
    ],
    quarantines: [],
  },
};

module.exports = { PREPRODUCTION_SPECS };
