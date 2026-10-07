/**
 * utils/artifacts/translation.js — what the six translation-stage steps owe each volume and the series root.
 *
 * The draft, the verification sidecars, the retranslation repairs, the polished text and the
 * series report. A rejected draft is kept deliberately (gotcha 39) so `retranslate` has
 * something to repair, which is why its quarantine is MEDIUM and not HIGH.
 */

const { volumeConsistencyEnabled, polishVerifyEnabled, QUARANTINED_DRAFT } = require("./rules");

/** @typedef {import("../artifacts").ArtifactExpectation} ArtifactExpectation */
/** @typedef {import("../artifacts").QuarantineExpectation} QuarantineExpectation */
/** @typedef {import("../artifacts").ArtifactContext} ArtifactContext */

const TRANSLATION_SPECS = {
  translate: {
    step: "translate",
    perVolume: true,
    volume: [
      {
        name: "translation.md",
        level: "required",
        shape: "document",
        why: "the merged volume — what the pipeline publishes",
      },
      {
        name: "translation-state.json",
        level: "required",
        shape: "json",
        why: "the per-chapter idempotency state",
      },
      {
        name: "translation-qa.md",
        level: "expected",
        shape: "document",
        why: "the deterministic QA report, including the reference material the model did NOT see",
      },
    ],
    series: [],
    quarantines: [QUARANTINED_DRAFT],
  },

  "verify-translate": {
    step: "verify-translate",
    perVolume: true,
    volume: [
      {
        name: "translation-verification.json",
        level: "required",
        shape: "json",
        why: "the per-chapter verdicts `retranslate` and the publish gate read",
      },
      {
        name: "translation-verification.md",
        level: "expected",
        shape: "document",
        why: "the human-readable verification report",
      },
      {
        name: "volume-consistency.md",
        level: "expected",
        shape: "document",
        why: "the cross-chapter audit — the drift a per-chapter check cannot see",
        when: volumeConsistencyEnabled,
      },
      {
        name: "volume-consistency.json",
        level: "expected",
        shape: "json",
        why: "the machine-readable half of the cross-chapter audit",
        when: volumeConsistencyEnabled,
      },
    ],
    series: [
      {
        name: "glossary-disputes.md",
        level: "expected",
        shape: "document",
        why: "the terminology challenges the verifier raised — the glossary task must settle them",
      },
    ],
    quarantines: [QUARANTINED_DRAFT],
  },

  retranslate: {
    step: "retranslate",
    perVolume: true,
    volume: [
      {
        name: "translation.md",
        level: "required",
        shape: "document",
        why: "retranslate re-merges the volume after every repair",
      },
      {
        name: "translation-state.json",
        level: "required",
        shape: "json",
        why: "a retranslate bumps draftHash and clears the polish marks",
      },
    ],
    series: [],
    quarantines: [QUARANTINED_DRAFT],
  },

  "translate-qa": {
    step: "translate-qa",
    perVolume: true,
    volume: [
      {
        name: "translation-verification.json",
        level: "required",
        shape: "json",
        why: "the loop's verdicts (its verify half writes them)",
      },
      {
        name: "translation.md",
        level: "required",
        shape: "document",
        why: "the loop re-merges after every retranslate batch",
      },
      {
        name: "translation-state.json",
        level: "required",
        shape: "json",
        why: "the ratchet baseline lives here",
      },
    ],
    series: [],
    quarantines: [QUARANTINED_DRAFT],
  },

  polish: {
    step: "polish",
    perVolume: true,
    volume: [
      {
        name: "translation.md",
        level: "required",
        shape: "document",
        why: "polish re-merges the volume (polished text wins when it was accepted)",
      },
      {
        name: "translation-state.json",
        level: "required",
        shape: "json",
        why: "the polish marks (polishedDraftHash / polishVerifiedDraftHash) live here",
      },
      {
        name: "polish-verification.json",
        level: "expected",
        shape: "json",
        why: "the drift inspector's verdicts",
        when: polishVerifyEnabled,
      },
      {
        name: "polish-qa.md",
        level: "expected",
        shape: "document",
        why: "the polish regression-guard report",
      },
    ],
    series: [],
    quarantines: [QUARANTINED_DRAFT],
  },

  "translation-report": {
    step: "translation-report",
    perVolume: false,
    volume: [],
    series: [
      {
        name: "translation-report.md",
        level: "required",
        shape: "document",
        why: "the deterministic roll-up of what the pipeline actually published",
      },
      {
        name: "translation-report.json",
        level: "required",
        shape: "json",
        why: "the machine-readable half",
      },
      {
        name: "translation-report.md.provenance.json",
        level: "expected",
        shape: "json",
        why: "the sidecar every other series-root copy carries",
      },
    ],
    quarantines: [],
  },
};

module.exports = { TRANSLATION_SPECS };
