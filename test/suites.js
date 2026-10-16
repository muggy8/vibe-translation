/**
 * test/suites.js — the manifest of everything `npm test` runs, as data.
 *
 * `package.json`'s `test` script used to be a serial `&&` chain of 86 `node test/test-x.js` commands.
 * The chain was the manifest and the scheduler at once, which meant three things: adding a suite meant
 * editing a 6,000-character string (gotcha 169: a suite that never joined it was invisible and the gate
 * stayed green); the order was fixed whether or not a suite needed it; and nothing could run two suites
 * at once. This file is the manifest on its own, `test/runner.js` is the scheduler, and `package.json`'s
 * `test` script is now just `node test/runner.js`.
 *
 * Every entry is one `node` process, exactly the way the chain ran it: the same file, the same arguments,
 * the same count. Nothing here changes what a suite does — only when the runner is allowed to start it.
 *
 * Two phases:
 *
 *   `concurrent`  — the runner may start these side by side, up to MAX_PARALLEL_SUITES, in any order.
 *   `serial`      — the runner runs these one at a time, in the order they appear here, AFTER every
 *                   concurrent suite has finished. The offline pipeline loop is here and it is last,
 *                   which is what keeps AGENTS.md rule 11 literally true: the last act of `npm test` is
 *                   the pipeline loop and the prompt audit it runs inside itself.
 *
 * A suite joins the serial phase only with a written `reason` naming what it shares. "This one is slow"
 * is not a reason; "this one deletes a folder another one is writing into" is.
 *
 * @module test/suites
 */

/** The runner may start these side by side. */
const PHASE_CONCURRENT = "concurrent";

/** The runner runs these one at a time, in this order, after every concurrent suite has finished. */
const PHASE_SERIAL = "serial";

/**
 * One entry of the manifest.
 *
 * @param {string} id - Unique name: used for the suite's captured output file and its own fixture root.
 * @param {string} file - Path to the suite, relative to the repository root.
 * @param {string[]} args - Arguments passed to it verbatim, exactly as the old chain passed them.
 * @param {string} [phase] - `PHASE_CONCURRENT` (default) or `PHASE_SERIAL`.
 * @param {string} [reason] - Required for a serial entry: what it shares that a neighbour would fight over.
 * @returns {{id: string, file: string, args: string[], phase: string, reason: string|null}}
 */
function suite(id, file, args = [], phase = PHASE_CONCURRENT, reason = null) {
  return { id, file, args, phase, reason };
}

/**
 * The `test/test-*.js` files that are NOT suites, each with the reason it is not one.
 *
 * `test/runner.js` fails the run when a file matching `test/test-*.js` exists on disk and no entry of this
 * manifest names it (gotcha 169). This list is the only way a file that matches the pattern without being
 * a suite can sit in `test/` without failing the gate, so every entry has to say what it is.
 *
 * @type {Object<string, string>}
 */
const SUITE_HELPERS = {
  "test/test-home.js":
    "Not a suite: the first thing every suite requires. It gives the process a throwaway records folder " +
    "(RUN_DIR) and refuses one that would land inside SERIES_LOCATION. It asserts nothing and prints " +
    "nothing, and 82 suites require it before anything else in them is loaded.",
};

/**
 * The manifest, in the order the old `&&` chain ran it.
 *
 * @type {Array<{id: string, file: string, args: string[], phase: string, reason: string|null}>}
 */
const SUITES = [
  suite("test-glossary-load", "test/test-glossary-load.js", []),
  suite("test-hooks", "test/test-hooks.js", []),
  suite("test-config", "test/test-config.js", []),
  suite("test-env-defaults", "test/test-env-defaults.js", []),
  suite("test-translate", "test/test-translate.js", []),
  suite("test-tokens", "test/test-tokens.js", []),
  suite("test-module-layer", "test/test-module-layer.js", []),
  suite("test-source-ruby", "test/test-source-ruby.js", []),
  suite("test-source-audit", "test/test-source-audit.js", []),
  suite("test-guide-groups", "test/test-guide-groups.js", []),
  suite("test-extract-step", "test/test-extract-step.js", []),
  suite("test-context", "test/test-context.js", []),
  suite("test-fake-backend", "test/test-fake-backend.js", []),
  suite("test-intake", "test/test-intake.js", []),
  suite("test-qa-orchestration", "test/test-qa-orchestration.js", []),
  suite("test-task-failure", "test/test-task-failure.js", []),
  suite("test-translation-loop", "test/test-translation-loop.js", []),
  suite("test-translate-stage", "test/test-translate-stage.js", []),
  suite("test-disputes", "test/test-disputes.js", []),
  suite("test-translation-terminology-source", "test/test-translation-terminology-source.js", []),
  suite("test-wiki-orchestration", "test/test-wiki-orchestration.js", []),
  suite("test-chunked-preproduction", "test/test-chunked-preproduction.js", []),
  suite("test-artifact-integrity", "test/test-artifact-integrity.js", []),
  suite("test-reference-store", "test/test-reference-store.js", []),
  suite("test-reference-store-copy", "test/test-reference-store-copy.js", []),
  suite("test-reference-store-artifacts", "test/test-reference-store-artifacts.js", []),
  suite("test-reference-store-ownership", "test/test-reference-store-ownership.js", []),
  suite("test-reference-store-pipeline", "test/test-reference-store-pipeline.js", []),
  suite("test-reference-store-rebuild", "test/test-reference-store-rebuild.js", []),
  suite("test-reference-store-reopen", "test/test-reference-store-reopen.js", []),
  suite("test-reference-store-attribution", "test/test-reference-store-attribution.js", []),
  suite("test-identity-table", "test/test-identity-table.js", []),
  suite("test-identity-table-isolation", "test/test-identity-table-isolation.js", []),
  suite("test-written-forms", "test/test-written-forms.js", []),
  suite("test-source-quality-reports", "test/test-source-quality-reports.js", []),
  suite("test-relations-table", "test/test-relations-table.js", []),
  suite("test-relations-isolation", "test/test-relations-isolation.js", []),
  suite("test-relation-contract", "test/test-relation-contract.js", []),
  suite("test-annotated-view", "test/test-annotated-view.js", []),
  suite("test-register-declaration", "test/test-register-declaration.js", []),
  suite("test-axis-answers", "test/test-axis-answers.js", []),
  suite("test-no-language-axis-list", "test/test-no-language-axis-list.js", []),
  suite("test-voice-prompt-declaration", "test/test-voice-prompt-declaration.js", []),
  suite("test-extract-voice", "test/test-extract-voice.js", []),
  suite("test-voice-readpass-query", "test/test-voice-readpass-query.js", []),
  suite("test-voice-revisions", "test/test-voice-revisions.js", []),
  suite("test-voice-confirmations", "test/test-voice-confirmations.js", []),
  suite("test-cast-reconciliation", "test/test-cast-reconciliation.js", []),
  suite("test-finding-levels", "test/test-finding-levels.js", []),
  suite("test-finding-routing", "test/test-finding-routing.js", []),
  suite("test-postmortem", "test/test-postmortem.js", []),
  suite("test-delivery-audit", "test/test-delivery-audit.js", []),
  suite("test-extract-run-scope", "test/test-extract-run-scope.js", []),
  suite("test-volume-halt-gate", "test/test-volume-halt-gate.js", []),
  suite("test-pause-resume", "test/test-pause-resume.js", []),
  suite("test-finding-channel", "test/test-finding-channel.js", []),
  suite("test-voice-reading-findings", "test/test-voice-reading-findings.js", []),
  suite("test-ledger", "test/test-ledger.js", []),
  suite("test-tickets", "test/test-tickets.js", []),
  suite("test-resume", "test/test-resume.js", []),
  suite("test-delivery-verify", "test/test-delivery-verify.js", []),
  suite("test-delivery-act", "test/test-delivery-act.js", []),
  suite("test-shutdown", "test/test-shutdown.js", []),
  suite("test-stop-run", "test/test-stop-run.js", []),
  suite("test-diagnostics", "test/test-diagnostics.js", []),
  suite("test-patches", "test/test-patches.js", []),
  suite("test-prerequisite-gate", "test/test-prerequisite-gate.js", []),
  suite("test-quarantine-semantics", "test/test-quarantine-semantics.js", []),
  suite("test-freeze-gate", "test/test-freeze-gate.js", []),
  suite("test-devteam", "test/test-devteam.js", []),
  suite("test-manager", "test/test-manager.js", []),
  suite("test-autopilot", "test/test-autopilot.js", []),
  suite("test-investigation-bound", "test/test-investigation-bound.js", []),
  suite("test-glossary-store-unconditional", "test/test-glossary-store-unconditional.js", []),
  suite("test-glossary-render-route", "test/test-glossary-render-route.js", []),
  suite("test-glossary-research-bound", "test/test-glossary-research-bound.js", []),
  suite("test-glossary-re-render", "test/test-glossary-re-render.js", []),
  suite("test-lookup-reliability", "test/test-lookup-reliability.js", []),
  suite("test-glossary-extraction-reads", "test/test-glossary-extraction-reads.js", []),
  suite("test-glossary-reading-block", "test/test-glossary-reading-block.js", []),
  suite("test-glossary-revisions", "test/test-glossary-revisions.js", []),
  suite("test-glossary-settlement", "test/test-glossary-settlement.js", []),
  suite("test-settlement-agenda-coverage", "test/test-settlement-agenda-coverage.js", []),
  suite("test-answer-envelopes", "test/test-answer-envelopes.js", []),
  suite("test-suite-runner", "test/test-suite-runner.js", []),
  suite("pipeline-loop-audit-selftest", "test/test-pipeline-loop.js", ["--audit-selftest"], PHASE_SERIAL, "Writes its planted fixtures into <loop dir>/selftest-series, and the full loop run below rm -rf's the whole loop folder on entry. Today they share /tmp/opencode/pipeline-loop."),
  suite("pipeline-loop-full", "test/test-pipeline-loop.js", [], PHASE_SERIAL, "rm -rf's /tmp/opencode/pipeline-loop on entry, which is the folder the audit self-test above writes into and the folder this run's own series and wire log live in."),
  suite("pipeline-loop-chunked-glossary", "test/test-pipeline-loop.js", ["--stages=discover,extract,glossary,character-voice","--chunked=glossary","--dir=/tmp/opencode/pipeline-loop-chunked-glossary"], PHASE_SERIAL, "The last act of the gate (AGENTS.md rule 11), and a second whole-pipeline run over the same scripted model server; it is kept next to the other two so the loop's three invocations stay in the order the chain ran them."),
];

/**
 * The manifest rendered back into the text shape `utils/patches/checks.js` compares before and after a
 * dev turn (`testChainIsIntact`). That guard asks one question — did a suite stop being run? — and it
 * answers it by diffing a list of `node <file>.js` commands. The list moved out of `package.json` and
 * into this file; the shape it is compared in has not changed, so the guard is unchanged too.
 *
 * @param {Array<{file: string, args: string[]}>} [entries] - Defaults to SUITES.
 * @returns {string} e.g. `node test/test-x.js && node test/test-y.js --flag`
 */
function renderTestChain(entries = SUITES) {
  return entries.map((e) => ["node", e.file, ...e.args].join(" ")).join(" && ");
}

module.exports = {
  PHASE_CONCURRENT,
  PHASE_SERIAL,
  SUITES,
  SUITE_HELPERS,
  renderTestChain,
};
