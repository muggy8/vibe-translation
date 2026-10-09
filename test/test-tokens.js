/**
 * test/test-tokens.js — the token accounting layer (utils/tokens.js), the
 * whole-installment vs chapter-by-chapter decision (utils/source.js), the
 * "did not fit in one pass" error class (configs/shared.js), and the
 * wipe-then-fallback path (utils/qa-loop.js).
 *
 * Pure + real temp files. No AI, no network: the calibration PROBE is stubbed,
 * but the code that decides what to do with a measurement is the production
 * code running on real files (AGENTS.md gotcha 49 — a live-only path that no
 * test runs is a path nobody has seen work).
 */

require("./test-home"); // the run's records get a throwaway home (gotcha 69)
require("dotenv").config();
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-client-tokens-"));
process.env.TOKEN_CALIBRATION_FILE = path.join(tmp, "calibration.json");
// The calibration key now includes "which container the hooks last started" (see
// calibrationKey below). Without this pin the suite would read THIS machine's
// real hooks/.model-switch-state and assert a key that depends on which model
// happens to be up — the gotcha-69 rule that a test must not read live machine
// state. An empty hooks dir means "no switch hook on this machine".
const HOOKS_DIR_ENV = "AI_CLIENT_HOOKS_DIR";
const realHooksDir = process.env[HOOKS_DIR_ENV];
process.env[HOOKS_DIR_ENV] = path.join(tmp, "hooks-none");

const { dropModuleLayer } = require("./module-layer");
const tokens = require("../utils/tokens");
const {
  scriptMixOf,
  estimateTokens,
  estimateMix,
  deriveCoefficients,
  tokenBudgetFor,
  tokenEstimateMargin,
  activeCoefficients,
  setCalibration,
  readCalibrationCache,
  writeCalibrationEntry,
  calibrationKey,
  ensureTokenCalibration,
} = tokens;

const {
  planProcessingMode,
  bundleTokenEstimate,
  chunkSafetyFraction,
  BUNDLE_SCHEMA_VERSION,
} = require("../utils/source");

const {
  structuralError,
  tooBigForOnePassError,
  isTooBigForOnePassError,
  structuredOutputError,
  isStructuredOutputError,
  isStructuredOutputMessage,
  isStructuralError,
} = require("../configs/shared");

const { wipeAttemptOutputs } = require("../utils/fs");
const { runVolumeWithModeFallback } = require("../utils/qa-loop");

// ─── 1. script mix and the estimate ──────────────────────────────────────────

{
  const mix = scriptMixOf("日本語です hello, world! 123");
  assert.strictEqual(mix.cjk, 5, "kana counted");
  assert.strictEqual(mix.total, mix.cjk + mix.other, "the mix partitions the text");
  assert.strictEqual(scriptMixOf("").total, 0);
  assert.strictEqual(scriptMixOf(null).total, 0, "null is not a crash");

  // Hangul and Han are in the same class as kana for this purpose.
  assert.strictEqual(scriptMixOf("한국어").cjk, 3, "Hangul counts as CJK");
  assert.strictEqual(scriptMixOf("中文").cjk, 2, "Han counts as CJK");

  const margin = tokenEstimateMargin();
  assert.ok(margin >= 1, "the margin can only widen the estimate");

  // The guarantee: above the highest tokens-per-character the live series
  // measured (0.622), for both scripts.
  const ja = "俺を好きなのはお前だけかよ".repeat(50);
  assert.ok(
    estimateTokens(ja) >= Math.ceil(ja.length * 0.622),
    "Japanese is never under-estimated"
  );
  const en = "The quick brown fox jumps over the lazy dog. ".repeat(50);
  assert.ok(
    estimateTokens(en) >= Math.ceil(en.length * 0.25),
    "Latin text is never under-estimated"
  );

  // The chat template is a per-REQUEST constant: estimateTokens must NOT bill it,
  // because fitPromptBudget calls estimateTokens once per BLOCK and would charge
  // the same overhead five times.
  assert.strictEqual(estimateTokens(""), 0, "empty text costs nothing, template included or not");
  assert.strictEqual(
    estimateTokens("a".repeat(1000)),
    estimateMix(scriptMixOf("a".repeat(1000)), { includeOverhead: false }),
    "estimateTokens is the no-overhead form"
  );

  // The calibration probe samples the MIDDLE, not the head: the head of a whole
  // volume is the title page + contents + a chapter opening, which measures
  // denser than the running prose (observed: 0.63 tok/char for the first 8,000
  // chars of a real volume against 0.60 for the whole book).
  const long = "H".repeat(11000) + "M".repeat(8000) + "T".repeat(11000);
  const mid = tokens.calibrationSample(long, 8000);
  assert.strictEqual(mid.length, 8000, "the sample is bounded");
  assert.ok(!mid.includes("H") && !mid.includes("T"), "it is not the head (or the tail) of the document");
  assert.strictEqual(mid, "M".repeat(8000), "it is the middle");
  assert.strictEqual(tokens.calibrationSample("short", 8000), "short", "a short text is used whole");
}

// ─── 2. deriving coefficients from one measurement ───────────────────────────

{
  // A CJK-heavy sample: solve the CJK weight, keep the fitted Latin weight.
  const jaMix = scriptMixOf("あ".repeat(10000) + "hello world".repeat(200));
  // What a server whose CJK tokenizer costs 0.6 tok/char would report for it
  // (the template overhead included, because usage.prompt_tokens includes it).
  const measured = jaMix.cjk * 0.6 + jaMix.other * tokens.DEFAULT_OTHER_WEIGHT + 52;
  const derived = deriveCoefficients(jaMix, measured);
  assert.ok(derived, "a CJK-heavy measurement is usable");
  assert.ok(Math.abs(derived.cjkWeight - 0.6) < 0.01, `solved the CJK weight (got ${derived.cjkWeight})`);
  assert.strictEqual(derived.otherWeight, tokens.DEFAULT_OTHER_WEIGHT, "the Latin weight stays at its fitted value");
  assert.strictEqual(derived.templateOverhead, 52);

  // A Latin-only sample (a French or Spanish series): one measurement cannot
  // solve two unknowns, so BOTH weights scale.
  const frMix = scriptMixOf("Le renard brun rapide saute par-dessus le chien paresseux. ".repeat(400));
  assert.strictEqual(frMix.cjk, 0);
  const frMeasured = Math.round(frMix.total * 0.22) + 52;
  const frDerived = deriveCoefficients(frMix, frMeasured);
  assert.ok(frDerived, "a Latin-only measurement is still usable");
  assert.ok(frDerived.otherWeight < tokens.DEFAULT_OTHER_WEIGHT, "the Latin weight scaled DOWN for a denser tokenizer");
  assert.ok(frDerived.cjkWeight < tokens.DEFAULT_CJK_WEIGHT, "the CJK weight scaled with it");

  // Unusable measurements are rejected, not trusted.
  assert.strictEqual(deriveCoefficients(scriptMixOf("abc"), 0), null, "zero tokens");
  assert.strictEqual(deriveCoefficients(scriptMixOf("abc"), 40), null, "smaller than the template overhead alone");
  assert.strictEqual(deriveCoefficients(scriptMixOf(""), 5000), null, "an empty sample");

  // A derived coefficient is clamped: a server that reports nonsense must not
  // make every later request too small to fit.
  const wild = deriveCoefficients(scriptMixOf("あ".repeat(1000)), 1000000);
  assert.ok(wild.cjkWeight <= 1.5, `the CJK weight is clamped (got ${wild.cjkWeight})`);
}

// ─── 3. the calibration cache ────────────────────────────────────────────────

{
  const key = calibrationKey({ baseUrl: "http://localhost:9200/v1/", model: "local" });
  assert.strictEqual(key, "http://localhost:9200/v1|local", "trailing slash normalized, model appended");
  assert.notStrictEqual(calibrationKey({ baseUrl: "http://a/v1", model: "x" }), key, "a different model is a different entry");

  // A machine with a model-switch hook gets the container IN the key.
  // Every container on such a machine advertises the same alias at the same URL
  // (gotcha 22), so `baseUrl|model` alone is one entry shared by several models —
  // and the only thing that ever re-measured the swapped one was the age guard.
  const switchDir = path.join(tmp, "hooks-switch");
  fs.mkdirSync(switchDir, { recursive: true });
  process.env[HOOKS_DIR_ENV] = switchDir;
  fs.writeFileSync(path.join(switchDir, ".model-switch-state"), "Qwen3.8-flash-next\n", "utf8");
  const withFlash = calibrationKey({ baseUrl: "http://localhost:9200/v1", model: "local" });
  assert.strictEqual(withFlash, "http://localhost:9200/v1|local|Qwen3.8-flash-next", "the container the hooks last started is part of the identity");
  assert.notStrictEqual(withFlash, key, "a machine that switches containers cannot share one entry between them");

  fs.writeFileSync(path.join(switchDir, ".model-switch-state"), "index-translate", "utf8");
  const withTranslator = calibrationKey({ baseUrl: "http://localhost:9200/v1", model: "local" });
  assert.notStrictEqual(withTranslator, withFlash, "a container switch mid-process invalidates the measurement taken for the previous one");

  // …and a container that comes BACK reuses its own measurement, which is what
  // keeps polish's re-polish (the EDIT endpoint, after the audit batch) from
  // paying for a third probe. The marker names a container, not an event counter.
  fs.writeFileSync(path.join(switchDir, ".model-switch-state"), "Qwen3.8-flash-next", "utf8");
  assert.strictEqual(calibrationKey({ baseUrl: "http://localhost:9200/v1", model: "local" }), withFlash, "the same container coming back reuses its own entry");

  // No marker file is not an error and does not change the key: a machine with no
  // switch hook keeps exactly the behaviour it had before.
  fs.rmSync(path.join(switchDir, ".model-switch-state"));
  assert.strictEqual(calibrationKey({ baseUrl: "http://localhost:9200/v1", model: "local" }), key, "no marker means no extra key segment (fail-open)");
  process.env[HOOKS_DIR_ENV] = path.join(tmp, "hooks-none");

  assert.deepStrictEqual(readCalibrationCache(), {}, "no cache file yet is not an error");
  assert.ok(writeCalibrationEntry(key, { cjkWeight: 0.61, otherWeight: 0.25, templateOverhead: 52, calibratedAt: new Date().toISOString() }));
  const cache = readCalibrationCache();
  assert.ok(cache[key] && cache[key].cjkWeight === 0.61, "the entry round-trips");

  // A corrupt cache degrades to "no calibrations" (fail-open), like every other
  // persisted state file in this pipeline.
  fs.writeFileSync(process.env.TOKEN_CALIBRATION_FILE, "{ not json");
  assert.deepStrictEqual(readCalibrationCache(), {}, "a corrupt cache is treated as empty");
  fs.rmSync(process.env.TOKEN_CALIBRATION_FILE);
}

// ─── 4. ensureTokenCalibration: the probe, the reuse, and the failure path ───

(async function () {
  fs.rmSync(process.env.TOKEN_CALIBRATION_FILE, { force: true });
  setCalibration(null);

  const endpoint = { baseUrl: "http://127.0.0.1:1/v1", apiKey: "none", model: "stub" };
  const sample = "あ".repeat(4000) + "latin text ".repeat(200);
  const expected = Math.round(scriptMixOf(sample).cjk * 0.6 + scriptMixOf(sample).other * 0.25) + 52;

  // Stub the probe the way the other orchestration tests stub the harness.
  const harness = require("../harness");
  const realMeasure = harness.measurePromptTokens;
  let probeCalls = 0;
  harness.measurePromptTokens = async ({ text }) => {
    probeCalls++;
    return expected + (text.length - text.trimEnd().length);
  };

  const logs = [];
  const first = await ensureTokenCalibration(endpoint, { sampleText: sample, label: "stub", log: (l) => logs.push(l) });
  assert.strictEqual(probeCalls, 1, "the first stage run probes once");
  assert.ok(Math.abs(first.cjkWeight - 0.6) < 0.02, `calibrated from the measurement (got ${first.cjkWeight})`);
  assert.ok(logs.some((l) => l.includes("measured")), "the calibration is announced, not silent");

  // The persisted cache is what makes a 17-volume run probe once, not 17 times.
  const second = await ensureTokenCalibration(endpoint, { sampleText: sample, label: "stub", log: (l) => logs.push(l) });
  assert.strictEqual(probeCalls, 1, "the same endpoint is not probed twice in one process");
  assert.ok(second.cjkWeight === first.cjkWeight);

  // A fresh process reuses the persisted entry instead of re-probing.
  dropModuleLayer(__dirname, "../utils/tokens.js");
  const tokens2 = require("../utils/tokens");
  const reused = await tokens2.ensureTokenCalibration(endpoint, { sampleText: sample, label: "stub", log: () => {} });
  assert.ok(Math.abs(reused.cjkWeight - first.cjkWeight) < 1e-9, "the persisted calibration is reused");
  assert.ok(tokens2.activeCoefficients().source.includes("calibrated"), "the log says where the coefficients came from");
  tokens2.setCalibration(null);

  // A probe that cannot run must NOT fail the run: it degrades to the
  // built-in coefficients, which over-count (the safe direction).
  harness.measurePromptTokens = async () => {
    throw new Error("endpoint unreachable");
  };
  dropModuleLayer(__dirname, "../utils/tokens.js");
  const tokens3 = require("../utils/tokens");
  fs.rmSync(process.env.TOKEN_CALIBRATION_FILE, { force: true });
  const fellBack = await tokens3.ensureTokenCalibration(
    { baseUrl: "http://127.0.0.1:2/v1", model: "unreachable" },
    { sampleText: sample, label: "unreachable" }
  );
  assert.strictEqual(fellBack.cjkWeight, tokens3.DEFAULT_CJK_WEIGHT, "a failed probe falls back to the built-in coefficients");

  // --dry-run makes no model call at all.
  harness.measurePromptTokens = async () => {
    throw new Error("--dry-run must not probe");
  };
  dropModuleLayer(__dirname, "../utils/tokens.js");
  const tokens4 = require("../utils/tokens");
  const dry = await tokens4.ensureTokenCalibration(endpoint, { sampleText: sample, label: "dry", dryRun: true, log: () => {} });
  assert.strictEqual(dry.cjkWeight, tokens4.DEFAULT_CJK_WEIGHT, "--dry-run calibrates nothing");

  harness.measurePromptTokens = realMeasure;
  setCalibration(null);

  // ─── 5. the budget ────────────────────────────────────────────────────────

  {
    const b = tokenBudgetFor({ roleWindow: 262144, outputReserve: 65536, referenceTokens: 20000, promptTokens: 2000, templateOverhead: 52, safetyFraction: 0.75 });
    assert.strictEqual(b.budget, Math.floor(262144 * 0.75) - 65536 - 20000 - 2000 - 52, "window × fraction, minus reply room, references, instructions and the template");

    // The reply reserve is not optional: a whole-volume pass has to WRITE a
    // whole artifact.
    const noRoom = tokenBudgetFor({ roleWindow: 10000, outputReserve: 9000, safetyFraction: 0.9 });
    assert.ok(noRoom.budget < 1000, "a stage with no room for its answer gets almost no source allowance");

    // A budget can never go negative and pretend there is room.
    assert.strictEqual(tokenBudgetFor({ roleWindow: 1000, outputReserve: 5000 }).budget, 0);
  }

  // ─── 6. the whole-vs-chapter decision ─────────────────────────────────────

  {
    const mixJa = scriptMixOf("あ".repeat(100000));
    const bundle = { format: "epub", segments: [{ id: "ch1" }, { id: "ch2" }], wholeChars: 100000, scriptMix: mixJa };
    const sourceTokens = bundleTokenEstimate(bundle);
    assert.ok(sourceTokens > 60000 && sourceTokens < 80000, `the bundle estimate tracks the mix (${sourceTokens})`);

    // Fits comfortably → whole.
    const whole = planProcessingMode(bundle, { roleWindow: 262144, outputReserve: 65536, safetyFraction: 0.75 });
    assert.strictEqual(whole.chunked, false, "a volume that fits is processed whole");
    assert.strictEqual(whole.basis, "tokens", "the decision was made on tokens");
    assert.ok(whole.usedFraction < 1);

    // Does not fit → chunked, and the reason names the numbers.
    const tight = planProcessingMode(bundle, { roleWindow: 120000, outputReserve: 60000, safetyFraction: 0.75 });
    assert.strictEqual(tight.chunked, true, "a volume that does not fit falls back");
    assert.ok(tight.reason.includes("tokens against"), `the reason carries the numbers: ${tight.reason}`);

    // The references count: the same volume is whole at volume 1 and chunked by
    // volume 17, because the cumulative glossary grew.
    const smallRefs = planProcessingMode(bundle, { roleWindow: 262144, outputReserve: 65536, referenceTokens: 1000, safetyFraction: 0.75 });
    const bigRefs = planProcessingMode(bundle, { roleWindow: 262144, outputReserve: 65536, referenceTokens: 120000, safetyFraction: 0.75 });
    assert.strictEqual(smallRefs.chunked, false, "with a small cumulative reference it fits");
    assert.strictEqual(bigRefs.chunked, true, "with a grown cumulative reference it does not");

    // Overrides still win, and say why.
    assert.strictEqual(planProcessingMode(bundle, { roleWindow: 262144, outputReserve: 0, forceChunked: true }).chunked, true, "--chunked forces the fallback");
    assert.strictEqual(planProcessingMode(bundle, { roleWindow: 262144, outputReserve: 0, thresholdChars: 0 }).chunked, true, "SOURCE_CHUNK_THRESHOLD_CHARS=0 still means always chunk");

    // A single-segment source has no chapter-by-chapter path to fall back to.
    const single = planProcessingMode({ format: "text", segments: [{ id: "whole" }], wholeChars: 999999, scriptMix: mixJa }, { roleWindow: 1000, outputReserve: 0 });
    assert.strictEqual(single.chunked, false, "a single-segment bundle is always whole");

    // No script mix (a cache written before schema 6) → the legacy character
    // rule, and the reason SAYS the token rule was unavailable rather than
    // pretending it ran.
    const legacy = planProcessingMode({ format: "epub", segments: [{}, {}], wholeChars: 200000 }, { roleWindow: 262144, outputReserve: 65536 });
    assert.strictEqual(legacy.basis, "characters");
    assert.strictEqual(legacy.chunked, true, "the legacy 120,000-character rule still applies");
    assert.ok(legacy.reason.includes("schema 6"), `the missing half is named: ${legacy.reason}`);

    // No known window → same honest fallback.
    const noWindow = planProcessingMode(bundle, { roleWindow: 0, outputReserve: 0 });
    assert.strictEqual(noWindow.basis, "characters");
    assert.ok(noWindow.reason.includes("no context window"), `the missing half is named: ${noWindow.reason}`);

    // The safety fraction is a knob.
    assert.strictEqual(chunkSafetyFraction(), 0.75, "default fraction");
    process.env.SOURCE_CHUNK_SAFETY_FRACTION = "0.5";
    assert.strictEqual(chunkSafetyFraction(), 0.5);
    const stricter = planProcessingMode(bundle, { roleWindow: 262144, outputReserve: 65536, safetyFraction: 0.5 });
    assert.strictEqual(stricter.chunked, true, "a stricter fraction sends the same volume chunked");
    delete process.env.SOURCE_CHUNK_SAFETY_FRACTION;

    assert.strictEqual(BUNDLE_SCHEMA_VERSION, 6, "schema 6 carries the script mix, so old caches re-extract");
  }

  // ─── 7. the "did not fit in one pass" error class ──────────────────────────

  {
    const sizeErr = tooBigForOnePassError("too large");
    assert.ok(isTooBigForOnePassError(sizeErr));
    assert.ok(!isStructuralError(sizeErr), "it is not structural — a missing file is not a size problem");
    assert.ok(!isTooBigForOnePassError(new Error("ordinary")), "an ordinary error is not a size error");
    assert.ok(!isTooBigForOnePassError(structuralError("source gone")), "a structural error is never a size error");
    assert.ok(!isTooBigForOnePassError(null), "null is not an error class");

    const { tagSizeOverflowError } = require("../harness");
    // The signature this pipeline actually saw (gotcha 36).
    const seen = new Error("prompt (4337 tokens) + max tokens (262144) exceeds the context; requests are never truncated");
    assert.ok(isTooBigForOnePassError(tagSizeOverflowError(seen, "t")), "the observed llama.cpp phrasing is tagged");
    assert.ok(isTooBigForOnePassError(tagSizeOverflowError(new Error("This model's maximum context length is 8192 tokens"), "t")));
    assert.ok(isTooBigForOnePassError(tagSizeOverflowError(new Error("the request exceeds the available context size, try increasing it"), "t")));
    // And the ones that must NOT be tagged.
    assert.ok(!isTooBigForOnePassError(tagSizeOverflowError(new Error("fetch failed"), "t")), "a network error is not a size error");
    assert.ok(!isTooBigForOnePassError(tagSizeOverflowError(new Error("the model returned no content"), "t")), "an empty reply is not a size error");
    assert.ok(!isTooBigForOnePassError(tagSizeOverflowError(new Error("the turn made no progress for 60 min"), "t")), "a hang is not a size error");
  }

  // ─── 7b. the "could not answer in the shape it was asked for" error class ────

  {
    const { tagSizeOverflowError, tagStructuredOutputError } = require("../harness");

    const shapeErr = structuredOutputError("refused shape");
    assert.ok(isStructuredOutputError(shapeErr));
    assert.ok(
      !isTooBigForOnePassError(shapeErr),
      "a refused shape is NOT a size failure — splitting the request cannot fix a request that was refused whole"
    );
    assert.ok(!isStructuralError(shapeErr), "and it is not structural either");
    assert.ok(!isStructuredOutputError(new Error("ordinary")), "an ordinary error is not a shape error");

    // The wording this machine's endpoint actually answers with (probed live).
    assert.ok(
      isStructuredOutputError(
        tagStructuredOutputError(
          new Error("HTTP 502: failed to generate structured output: answer does not match the schema code=structured_output_failed"),
          "t"
        )
      ),
      "the observed refusal is tagged"
    );
    assert.ok(
      isStructuredOutputError(
        tagStructuredOutputError(new Error("structured output was incomplete (finish_reason=length)"), "t")
      ),
      "a shape cut off at the output cap is the same class of failure"
    );

    // And the ones that must NOT be tagged, for the same reason the size patterns are kept
    // narrow: a false match relabels the failure and the wrong recovery runs.
    assert.ok(
      !isStructuredOutputError(
        tagStructuredOutputError(new Error("prompt (4337 tokens) + max tokens (262144) exceeds the context"), "t")
      ),
      "a size refusal is not a shape refusal"
    );
    assert.ok(!isStructuredOutputError(tagStructuredOutputError(new Error("model container died"), "t")), "a dead container is not a shape problem");
    assert.ok(!isStructuredOutputError(tagStructuredOutputError(new Error("the model returned no content"), "t")), "an empty reply is not a shape problem");

    // One tag per error. A tagged size error must stay a size error, or the whole→chaptered
    // fallback starts acting on a failure it cannot repair.
    const sized = tagSizeOverflowError(new Error("This model's maximum context length is 8192 tokens"), "t");
    assert.ok(isTooBigForOnePassError(sized));
    assert.ok(!isStructuredOutputError(tagStructuredOutputError(sized, "t")), "tagging is not cumulative");

    // The transport layer (which decides when NOT to re-ask) and the tagger (which decides what
    // class to report) read ONE list of patterns, so they cannot drift apart.
    assert.ok(isStructuredOutputMessage("structured_output_failed"));
    assert.ok(isStructuredOutputMessage("failed to generate structured output"));
    assert.ok(!isStructuredOutputMessage("fetch failed"));
    assert.ok(!isStructuredOutputMessage(""), "no text is no signature");
  }

  // ─── 8. wipe, then fall back — once ────────────────────────────────────────

  {
    const dir = fs.mkdtempSync(path.join(tmp, "volume-"));
    fs.writeFileSync(path.join(dir, "glossary.md"), "half-written attempt");
    fs.writeFileSync(path.join(dir, "glossary-validation-rolling-state.json"), "{}");
    fs.writeFileSync(path.join(dir, "glossary-ch1-validation.md"), "per-chapter stray");
    fs.writeFileSync(path.join(dir, "glossary.md.keep"), "not in the list — must survive");

    const removed = await wipeAttemptOutputs(dir, ["glossary.md", "glossary-validation-rolling-state.json", "nope.md"], { glob: /^glossary-.*-validation\.md$/ });
    assert.ok(!fs.existsSync(path.join(dir, "glossary.md")), "the partial artifact is gone");
    assert.ok(!fs.existsSync(path.join(dir, "glossary-ch1-validation.md")), "the glob catches the per-chapter strays");
    assert.ok(fs.existsSync(path.join(dir, "glossary.md.keep")), "it deletes ONLY what it is told to");
    assert.ok(removed.includes("glossary.md"));
    assert.ok(!removed.includes("nope.md"), "a file that was never written is not an error");

    // Fallback fires on the tagged error, once, after the wipe.
    const dir2 = fs.mkdtempSync(path.join(tmp, "volume-"));
    fs.writeFileSync(path.join(dir2, "glossary.md"), "attempt one");
    const ctx = { chunked: false };
    let runs = 0;
    const result = await runVolumeWithModeFallback({
      label: "Volume 01",
      ctx,
      volumeDir: dir2,
      attemptFiles: ["glossary.md"],
      run: async () => {
        runs++;
        if (runs === 1) throw tooBigForOnePassError("the turn was truncated (finish_reason=length) while writing");
      },
    });
    assert.strictEqual(runs, 2, "the volume ran again, chapter by chapter");
    assert.strictEqual(ctx.chunked, true, "the retry ran in the fallback mode");
    assert.strictEqual(result.fellBack, true);
    assert.ok(!fs.existsSync(path.join(dir2, "glossary.md")), "the first attempt's output was wiped before the retry");

    // An ordinary failure does NOT trigger it.
    let runs2 = 0;
    await assert.rejects(
      () =>
        runVolumeWithModeFallback({
          label: "Volume 02",
          ctx: { chunked: false },
          volumeDir: dir2,
          attemptFiles: [],
          run: async () => {
            runs2++;
            throw new Error("the model returned no content");
          },
        }),
      /no content/
    );
    assert.strictEqual(runs2, 1, "a flaky model call is not retried chunked");

    // Neither is a structural one.
    let runs3 = 0;
    await assert.rejects(
      () =>
        runVolumeWithModeFallback({
          label: "Volume 03",
          ctx: { chunked: false },
          volumeDir: dir2,
          attemptFiles: [],
          run: async () => {
            runs3++;
            throw structuralError("Required source file not found");
          },
        }),
      /source file not found/
    );
    assert.strictEqual(runs3, 1, "a structural failure is never papered over by chunking");

    // Already in fallback mode → no second fallback.
    let runs4 = 0;
    await assert.rejects(
      () =>
        runVolumeWithModeFallback({
          label: "Volume 04",
          ctx: { chunked: true },
          volumeDir: dir2,
          attemptFiles: [],
          run: async () => {
            runs4++;
            throw tooBigForOnePassError("still too large");
          },
        }),
      /still too large/
    );
    assert.strictEqual(runs4, 1, "the fallback is one attempt, not a loop");

    // Both attempts failing reports BOTH, rather than only the second.
    let runs5 = 0;
    await assert.rejects(
      () =>
        runVolumeWithModeFallback({
          label: "Volume 05",
          ctx: { chunked: false },
          volumeDir: dir2,
          attemptFiles: [],
          run: async () => {
            runs5++;
            throw tooBigForOnePassError(runs5 === 1 ? "whole pass too large" : "chunked pass also failed");
          },
        }),
      /whole pass too large.*chunked pass also failed/s,
      "the report names both attempts"
    );
  }

  // ─── 8. The ANSWER side: growth, room, and the cap that actually binds ─────
  {
    // One knob for both size decisions (the whole-installment one and the
    // chapter-part one) — it moved to utils/tokens.js, and utils/source.js
    // re-exports it so the existing callers are unchanged.
    assert.strictEqual(chunkSafetyFraction(), tokens.chunkSafetyFraction(), "one implementation, not two");
    process.env.SOURCE_CHUNK_SAFETY_FRACTION = "0.6";
    assert.strictEqual(tokens.chunkSafetyFraction(), 0.6, "the knob still reads the env var");
    assert.strictEqual(chunkSafetyFraction(), 0.6, "and the re-export follows it");
    delete process.env.SOURCE_CHUNK_SAFETY_FRACTION;

    assert.strictEqual(tokens.artifactGrowthFactor(), 1.25, "the default growth factor");
    process.env.ARTIFACT_GROWTH_FACTOR = "1.5";
    assert.strictEqual(tokens.artifactGrowthFactor(), 1.5);
    process.env.ARTIFACT_GROWTH_FACTOR = "0.5";
    assert.strictEqual(tokens.artifactGrowthFactor(), 1.25, "a factor below 1 is rejected (a cumulative reference does not shrink)");
    delete process.env.ARTIFACT_GROWTH_FACTOR;

    const room = tokens.answerRoom({ expectedTokens: 10000, outputReserve: 65536 });
    assert.strictEqual(room.expectedTokens, 10000);
    assert.strictEqual(room.guardedTokens, 11500, "the estimate margin is applied to the answer too");
    assert.ok(room.fits, "a 10,000-token answer fits a 65,536-token cap");

    // The failure this exists to catch: a cumulative reference that outgrows the
    // output cap. Reported, because chapter-by-chapter mode cannot fix it.
    const cramped = tokens.answerRoom({ expectedTokens: 60000, outputReserve: 65536 });
    assert.strictEqual(cramped.fits, false, "an answer the cap cannot hold is reported, not ignored");
    assert.ok(cramped.headroom < 0, "and the shortfall is a number, not a mood");

    assert.strictEqual(
      tokens.answerRoom({ expectedTokens: 99999, outputReserve: 0 }).fits,
      true,
      "no output cap configured — nothing to compare against, so no invented limit"
    );
  }

  // ─── 9. decideProcessingMode reports the answer it expects to write ────────
  {
    const dir = path.join(tmp, "answer-room");
    fs.mkdirSync(dir, { recursive: true });
    const bundleDir = path.join(dir, "Book(01)");
    fs.mkdirSync(bundleDir, { recursive: true });
    const wholeFile = path.join(bundleDir, "vol-whole.md");
    fs.writeFileSync(wholeFile, "これは日本語です".repeat(2000), "utf8");
    const metaFile = path.join(bundleDir, "vol-bundle.meta.json");
    fs.writeFileSync(
      metaFile,
      JSON.stringify({
        schema: BUNDLE_SCHEMA_VERSION,
        wholePath: wholeFile,
        scriptMix: scriptMixOf(fs.readFileSync(wholeFile, "utf8")),
        segments: [
          { id: "ch1", file: "vol-ch1.md", scriptMix: scriptMixOf("これは日本語です".repeat(1000)) },
          { id: "ch2", file: "vol-ch2.md", scriptMix: scriptMixOf("これは日本語です".repeat(1000)) },
        ],
      }),
      "utf8"
    );
    fs.writeFileSync(path.join(bundleDir, "vol-ch1.md"), "これは日本語です".repeat(1000), "utf8");
    fs.writeFileSync(path.join(bundleDir, "vol-ch2.md"), "これは日本語です".repeat(1000), "utf8");
    const bundle = {
      format: "epub",
      wholePath: wholeFile,
      segments: [
        { id: "ch1", file: "vol-ch1.md", scriptMix: scriptMixOf("これは日本語です".repeat(1000)) },
        { id: "ch2", file: "vol-ch2.md", scriptMix: scriptMixOf("これは日本語です".repeat(1000)) },
      ],
      scriptMix: scriptMixOf(fs.readFileSync(wholeFile, "utf8")),
    };

    // A previous artifact on disk is the measurement: the stage must write at
    // least what the last volume's copy holds, plus the additions.
    const previous = path.join(dir, "previous-glossary.md");
    fs.writeFileSync(previous, "x".repeat(40000), "utf8");
    const logs = [];
    const realLog = console.log;
    const realWarn = console.warn;
    console.log = (l) => logs.push(String(l));
    console.warn = (l) => logs.push(String(l));
    let plan;
    try {
      plan = await require("../utils/source").decideProcessingMode({
        bundle,
        label: "answer-room",
        previousArtifactFiles: [previous],
        dryRun: true,
        role: { contextWindow: 262144, maxTokens: 65536 },
      });
    } finally {
      console.log = realLog;
      console.warn = realWarn;
    }
    assert.ok(plan.answerRoom, "the answer side is measured, not assumed");
    assert.ok(
      plan.answerRoom.expectedTokens >= estimateTokens(fs.readFileSync(previous, "utf8")),
      "the previous artifact is the floor for the expected answer"
    );
    assert.ok(
      logs.some((l) => /answer is expected to be about/.test(l)),
      "and the number is printed, so a mode choice can be read out of the run log"
    );

    // An artifact bigger than the cap produces the warning that names the fix
    // (and does NOT silently switch the mode — chunking cannot repair it).
    fs.writeFileSync(previous, "x".repeat(400000), "utf8");
    const logs2 = [];
    console.log = (l) => logs2.push(String(l));
    console.warn = (l) => logs2.push(String(l));
    let plan2;
    try {
      plan2 = await require("../utils/source").decideProcessingMode({
        bundle,
        label: "answer-room-tight",
        previousArtifactFiles: [previous],
        dryRun: true,
        role: { contextWindow: 262144, maxTokens: 65536 },
      });
    } finally {
      console.log = realLog;
      console.warn = realWarn;
    }
    assert.strictEqual(plan2.answerRoom.fits, false);
    assert.ok(
      logs2.some((l) => /does not fit the output cap/.test(l) && /MAX_TOKENS/.test(l)),
      "the warning names what to change"
    );
    assert.ok(
      !/answer/i.test(plan2.reason),
      "the mode decision's own reason never cites the answer size — chunking cannot repair it"
    );
  }

  if (realHooksDir === undefined) delete process.env[HOOKS_DIR_ENV];
  else process.env[HOOKS_DIR_ENV] = realHooksDir;

  console.log("tokens: all checks passed.");
})().catch((err) => {
  console.error("tokens: FAILED");
  console.error(err);
  process.exit(1);
});
