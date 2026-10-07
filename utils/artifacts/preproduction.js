/**
 * utils/artifacts/preproduction.js — what the six pre-production steps owe each volume and the series root.
 *
 * The cumulative tasks (glossary, character voice, style guide, wiki) owe a volume copy AND a
 * series-root copy, because the translation stage reads the root copies; the audit owes the
 * report nobody else carries. `required` is only set where the pipeline writes the file on
 * EVERY path it can reach — over-declaring is worse than under-declaring, because a check that
 * fires on healthy output trains everyone to ignore the check.
 */

const { researchEnabled, QUARANTINED_CUMULATIVE } = require("./rules");

/** @typedef {import("../artifacts").ArtifactExpectation} ArtifactExpectation */
/** @typedef {import("../artifacts").QuarantineExpectation} QuarantineExpectation */
/** @typedef {import("../artifacts").ArtifactContext} ArtifactContext */

const PREPRODUCTION_SPECS = {
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
