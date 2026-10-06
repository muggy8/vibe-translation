/**
 * test/fixture-series.js — the throwaway series the delivery-layer suites run against.
 *
 * Extracted from `test/test-resume.js` when `test/test-autopilot.js` needed the same fixture, because
 * the whole value of these builders is that they lay the fixture out from `utils/artifacts.js` itself:
 * a fixture seeded from the declaration cannot drift from it, and a fixture written by hand drifts
 * the first time an expectation changes.
 *
 * Two rules these builders exist to enforce, both from live incidents:
 *
 * - **A fixture is a series, not whatever `.env` says.** Every builder returns a folder with a
 *   committed schema-2 plan of record, and points `POSTMORTEM_DIR` at its own `.postmortem`. A test
 *   that reads "the" ledger is reading the live 17-volume series' history, and a finding recorded
 *   there changes what the test asserts (gotcha 69, gotcha 71). Blanking `AI_API_KEY` is not enough:
 *   most tasks never reach the check that needs it.
 * - **The plan of record is laid out here, never seeded from the declaration.** `discover` declares
 *   `translation-target.json` as one of its outputs, so a generic seeder overwrites the fixture's
 *   committed plan with a copy that has no `discovery` block — and the triage correctly reports that
 *   there is no usable plan (gotcha 33).
 *
 * `integrity.basis` is ≥ 20 characters and `discovery.confidence` is an object of 0–1 numbers on
 * purpose: `validateVolumeIntegrity` and `validateDiscoveryBlock` reject anything thinner, and a
 * fixture whose plan silently fails validation is a fixture with no plan at all — which shows up as
 * the intake agent running, offline, retrying three times with 10 s sleeps.
 */

const fs = require("fs");
const path = require("path");

const { STEP_ARTIFACT_SPECS } = require("../utils/artifacts");
const { PIPELINE_STEPS } = require("../gulpfile");

/** Where the throwaway series live. Each suite passes its own label, so they cannot collide. */
const FIXTURES_ROOT = path.resolve("/tmp/opencode/series-fixtures");

/** A Markdown table — the shape the glossary's whole contract IS. */
const TABLE = `# Glossary

| Term | Rendering | Notes |
|---|---|---|
| 主人公 | protagonist | fixture |
`;

/** A headed Markdown document. */
const DOC = `# Report

## Findings

- nothing wrong here
`;

/** The audit's own sign-off, which `utils/postmortem.js` reads out of the report. */
const PASS_DOC = `${DOC}

**PASS**
`;

/**
 * Content that satisfies an expectation's declared `shape`, so a fixture built from
 * `utils/artifacts.js` is a fixture the post-mortem agrees is complete.
 *
 * @param {string} name
 * @param {string} shape
 * @returns {string}
 */
function contentFor(name, shape) {
  if (name === "consistency-report.md") return PASS_DOC;
  if (name.endsWith("-rolling-state.json")) {
    // `isAcceptedState` reads `results` through the same criterion the QA loop used.
    return JSON.stringify({ results: [80, 85], acceptedBy: "rolling-window", lastCheckedAt: new Date().toISOString() }, null, 2);
  }
  if (name === "chapters.json") return "[]\n";
  if (shape === "table") return TABLE;
  if (shape === "json") return JSON.stringify({ fixture: true }, null, 2) + "\n";
  if (shape === "document") return DOC;
  return "fixture\n";
}

/**
 * Lay out a two-volume series with a committed schema-2 plan of record, and point `POSTMORTEM_DIR`
 * at the fixture's own machine-state folder.
 *
 * @param {string} label - Scenario name, so fixtures do not collide.
 * @param {string} [root] - Where to put it. Defaults to `FIXTURES_ROOT`.
 * @returns {Promise<{dir: string, ledgerDir: string, volumes: Array<{folder: string, installmentNumber: string}>}>}
 */
async function fixtureSeries(label, root = FIXTURES_ROOT) {
  const dir = path.join(root, label);
  await fs.promises.rm(dir, { recursive: true, force: true });
  await fs.promises.mkdir(dir, { recursive: true });
  // The ledger, the tickets, the patches, the delivery plan and the run lock all live in
  // `postMortemDir()`, which defaults to the repo's own `.postmortem` — the live series' history.
  // A test that reads that file is reading the wrong series (gotcha 69, gotcha 71).
  process.env.POSTMORTEM_DIR = path.join(dir, ".postmortem");
  await fs.promises.mkdir(process.env.POSTMORTEM_DIR, { recursive: true });

  const volumes = [
    { folder: "Test Story(01)", installmentNumber: "01" },
    { folder: "Test Story(02)", installmentNumber: "02" },
  ];
  for (const v of volumes) {
    const volDir = path.join(dir, v.folder);
    await fs.promises.mkdir(volDir, { recursive: true });
    await fs.promises.writeFile(path.join(volDir, "book.epub"), "not really an epub", "utf8");
  }

  await fs.promises.writeFile(
    path.join(dir, "translation-target.json"),
    JSON.stringify(
      {
        schema: 2,
        seriesLocation: dir,
        seriesName: "Test Story",
        sourceLanguage: "Japanese",
        targetLanguage: "English",
        generator: "test/fixture-series.js",
        generatedAt: new Date().toISOString(),
        // `discovery.confidence` is a per-dimension object of 0-1 numbers, not one number —
        // `validateDiscoveryBlock` rejects the flatter shape (gotcha 33).
        discovery: {
          summary: "fixture",
          confidence: { volumes: 0.9, order: 0.9, sourceLanguage: 0.9 },
          evidence: ["two books"],
          excluded: [],
        },
        volumes: volumes.map((v) => ({
          folder: v.folder,
          sourceFile: `${v.folder}/book.epub`,
          installmentNumber: v.installmentNumber,
          title: "Test Story",
          integrity: {
            isNarrative: true,
            confidence: 0.9,
            basis: "fixture: continuous prose in one headed section, no packaging pages",
          },
        })),
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
  return { dir, ledgerDir: process.env.POSTMORTEM_DIR, volumes };
}

/**
 * Write every file one step is declared to leave in one volume folder.
 * @param {string} seriesDir
 * @param {{folder: string, installmentNumber: string}} volume
 * @param {string} step
 */
async function writeVolumeOutputs(seriesDir, volume, step) {
  const spec = STEP_ARTIFACT_SPECS[step];
  if (!spec || !spec.perVolume) return;
  const volDir = path.join(seriesDir, volume.folder);
  await fs.promises.mkdir(volDir, { recursive: true });
  for (const e of spec.volume) {
    const name = e.name.replace("{installment}", volume.installmentNumber);
    await fs.promises.writeFile(path.join(volDir, name), contentFor(name, e.shape), "utf8");
  }
}

/**
 * Write every file one step is declared to publish at the series root. The plan of record is
 * deliberately skipped — see the header.
 * @param {string} seriesDir
 * @param {string} step
 */
async function writeSeriesOutputs(seriesDir, step) {
  const spec = STEP_ARTIFACT_SPECS[step];
  if (!spec) return;
  for (const e of spec.series || []) {
    if (e.name === "translation-target.json") continue;
    await fs.promises.writeFile(path.join(seriesDir, e.name), contentFor(e.name, e.shape), "utf8");
  }
}

/**
 * Remove one step's declared outputs from one volume, so the post-mortem reports the work as missing.
 *
 * @param {string} seriesDir
 * @param {string} step
 * @param {string} folder
 * @param {string} installment
 */
async function removeStepOutputs(seriesDir, step, folder, installment) {
  for (const e of STEP_ARTIFACT_SPECS[step].volume) {
    await fs.promises.rm(path.join(seriesDir, folder, e.name.replace("{installment}", installment)), { force: true });
  }
}

/**
 * The volume-15 shape: the step's output is gone AND its own gate evidence sits in the same folder.
 * Re-running the step rebuilds the file and the same deterministic check refuses it again, which is
 * why the triage turns this into a question rather than a wipe (gotcha 68).
 *
 * @param {string} seriesDir
 * @param {string} folder
 * @param {string} installment
 * @param {string} [step]
 */
async function leaveGateEvidenceBesideTheGap(seriesDir, folder, installment, step = "glossary") {
  await removeStepOutputs(seriesDir, step, folder, installment);
  await fs.promises.writeFile(
    path.join(seriesDir, folder, `${step}.md.rejected`),
    "the gate's own account\n",
    "utf8"
  );
}

/**
 * A series where every pipeline step finished what it claims to have, including a clean publish
 * report — so `endIsProvable` has something to prove.
 *
 * @param {string} label
 * @param {string} [root]
 */
async function completeSeries(label, root = FIXTURES_ROOT) {
  const fx = await fixtureSeries(label, root);
  for (const { name } of PIPELINE_STEPS) {
    for (const v of fx.volumes) await writeVolumeOutputs(fx.dir, v, name);
    await writeSeriesOutputs(fx.dir, name);
  }
  // The deliverable, so the triage and the acceptance test read the goal function rather than guess it.
  await fs.promises.writeFile(
    path.join(fx.dir, "translation-report.json"),
    JSON.stringify(
      {
        schema: 1,
        generatedAt: new Date().toISOString(),
        seriesName: "Test Story",
        chapters: [
          { volume: "01", folder: "Test Story(01)", id: "whole", outcome: "PUBLISHED (verified)" },
          { volume: "02", folder: "Test Story(02)", id: "whole", outcome: "PUBLISHED (verified)" },
        ],
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
  return fx;
}

/**
 * Write one of the manager's two channels into the fixture's own `POSTMORTEM_DIR`.
 *
 * The records are written in the shape `utils/tickets.js` / `utils/patches.js` store them, because the
 * point of these suites is the delivery layer READING a real channel, not its reading of a
 * hand-picked object.
 *
 * @param {string} dir - The fixture series dir.
 * @param {string} name - `tickets.json` or `patches.json`.
 * @param {Object} payload
 */
async function writeChannel(dir, name, payload) {
  await fs.promises.writeFile(path.join(dir, ".postmortem", name), JSON.stringify(payload, null, 2) + "\n", "utf8");
}

module.exports = {
  FIXTURES_ROOT,
  TABLE,
  DOC,
  PASS_DOC,
  contentFor,
  fixtureSeries,
  writeVolumeOutputs,
  writeSeriesOutputs,
  removeStepOutputs,
  leaveGateEvidenceBesideTheGap,
  completeSeries,
  writeChannel,
};
