/**
 * The whole-installment vs chapter-by-chapter decision, asked per volume and per
 * stage, IN TOKENS:
 *
 *   source + injected references + instructions <= safetyFraction x roleWindow - reply reserve
 *
 * The old rule was one character constant applied to every stage, language and
 * model; measured against the live series it said all 17 volumes needed chaptering
 * while every one of them fitted the window comfortably. A character count is
 * language-blind and says nothing about the reference material a stage injects (which
 * GROWS every volume) or the room the answer needs (the server rejects a request
 * whose prompt + max_tokens exceed its context, so the output cap is part of the sum
 * whether or not the model uses it).
 *
 * The decision is re-asked, never cached across volumes, and it prints the numbers
 * it used.
 *
 * Part of the source.js layer (split out of the original single file).
 */

const fs = require("fs").promises;
const tokens = require("../tokens");
const { scriptMixOf } = tokens;
require("../../types"); // JSDoc type definitions

const { DEFAULT_CHUNK_THRESHOLD_CHARS } = require("./config");

/**
 * How much of the window a whole-installment pass may claim. The knob now lives
 * in utils/tokens.js because the chapter-part decision asks the same question
 * (a window that is exactly full is a window with no room for the tail of a long
 * generation); re-exported here so the existing callers and tests keep working.
 * @returns {number} SOURCE_CHUNK_SAFETY_FRACTION (default 0.75).
 */
const chunkSafetyFraction = tokens.chunkSafetyFraction;


/**
 * Read the chapter-fallback size threshold from the environment.
 *
 * @returns {number} The threshold in characters (0 = always chunk).
 */
function chunkThresholdChars() {
  const n = parseInt(process.env.SOURCE_CHUNK_THRESHOLD_CHARS, 10);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_CHUNK_THRESHOLD_CHARS;
}


/**
 * Split a plain-text source into chapter-sized segments (the chunked fallback
 * for a plain-text volume that is too big to process whole).
 *
 * Paragraph-aware: the text is split on blank lines, and whole paragraphs are
 * greedily packed into segments of at most `targetChars`. A single paragraph
 * longer than the target becomes a segment of its own (splitting mid-paragraph
 * would break a sentence). Every paragraph lands in exactly one segment, so
 * the content is preserved — only blank-line runs are normalised to one.
 *
 * @param {string} text - The full source text.
 * @param {number} targetChars - The approximate size of each segment.
 * @returns {string[]} The segments in reading order (empty array for empty input).
 */
function splitPlainTextSegments(text, targetChars) {
  const target = Math.max(1000, targetChars || 0);
  const paragraphs = (text || "").split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 0);
  const segments = [];
  let current = [];
  let currentLen = 0;
  for (const para of paragraphs) {
    if (para.length > target) {
      if (current.length) {
        segments.push(current.join("\n\n"));
        current = [];
        currentLen = 0;
      }
      segments.push(para);
      continue;
    }
    if (currentLen + para.length + 2 > target && current.length) {
      segments.push(current.join("\n\n"));
      current = [];
      currentLen = 0;
    }
    current.push(para);
    currentLen += para.length + 2;
  }
  if (current.length) segments.push(current.join("\n\n"));
  return segments;
}


/**
 * Decide whether a volume must be processed chapter by chapter (the fallback)
 * instead of as one whole installment (the default).
 *
 * The fallback applies to epub bundles with more than one chapter, and to
 * plain-text sources that were split into parts because they exceed the
 * threshold — in both cases only when the whole text exceeds the threshold or
 * chunking is forced with --chunked. Everything else — every small plain-text
 * source and every small epub — is processed whole.
 *
 * @param {SourceBundle} bundle - The resolved source bundle.
 * @param {{forceChunked?: boolean, thresholdChars?: number}} [opts]
 * @returns {boolean} True when the chapter-by-chapter fallback applies.
 */
function shouldProcessChunked(bundle, opts = {}) {
  const forceChunked = !!opts.forceChunked;
  const threshold =
    opts.thresholdChars !== undefined ? opts.thresholdChars : chunkThresholdChars();
  // Both epubs and split plain-text volumes can have multiple segments; a
  // single-segment bundle (a small plain-text file, or an epub with one
  // section) is always processed whole.
  if (
    !bundle ||
    (bundle.format !== "epub" && bundle.format !== "text") ||
    !Array.isArray(bundle.segments) ||
    bundle.segments.length < 2
  ) {
    return false;
  }
  if (forceChunked) return true;
  return (bundle.wholeChars || 0) > threshold;
}


/**
 * The token estimate for a bundle's whole-installment text, from the script mix
 * the extraction persisted.
 *
 * The bundle stores the MIX (a property of the text) and not the token count (a
 * property of the text AND the model), so the same cached extraction can be
 * re-estimated after a container switch puts a different model behind the
 * endpoint — with no re-read of the book.
 *
 * @param {SourceBundle} bundle
 * @param {{includeOverhead?: boolean}} [opts] - overhead (the chat template) is billed once per request in tokenBudgetFor, so it is excluded here by default.
 * @returns {number|null} null when the bundle carries no script mix (a cache written before schema 6).
 */
function bundleTokenEstimate(bundle, { includeOverhead = false } = {}) {
  if (!bundle || !bundle.scriptMix) return null;
  return tokens.estimateMix(bundle.scriptMix, { includeOverhead });
}


/**
 * Decide how a volume should be processed: as one whole installment (the cheap,
 * cache-friendly default) or chapter by chapter (the fallback).
 *
 * The old rule was one character constant for every stage, every language and
 * every model. This one asks the question the decision actually depends on:
 * does this volume's text, together with the reference material this stage
 * injects and the answer this stage has to write, fit inside a safe fraction of
 * the window of the model this stage is about to run on?
 *
 *   source + references + instructions  <=  safety fraction × window − reply reserve
 *
 * Two things it deliberately does NOT do:
 *   - It does not decide once per series. The cumulative references grow every
 *     volume, so a volume that fits at volume 3 may not fit at volume 17. The
 *     caller re-asks per volume.
 *   - It does not gate on the estimate alone when the estimate is unavailable. A
 *     bundle cached before schema 6 has no script mix, and a stage with no known
 *     role window has no budget; both fall back to the legacy character rule
 *     rather than guessing.
 *
 * Pure — unit-tested.
 *
 * @param {SourceBundle} bundle
 * @param {{
 *   roleWindow?: number,
 *   outputReserve?: number,
 *   referenceTokens?: number,
 *   promptTokens?: number,
 *   forceChunked?: boolean,
 *   safetyFraction?: number,
 *   thresholdChars?: number,
 * }} [opts] - The stage's window, the room kept for the reply, the size of the reference material this stage injects, the size of its fixed instructions, and the overrides.
 * @returns {{
 *   chunked: boolean,
 *   basis: "tokens"|"characters",
 *   reason: string,
 *   sourceTokens: number|null,
 *   budget: number|null,
 *   usedFraction: number|null,
 *   sessionWarning: string|null,
 * }}
 */
function planProcessingMode(bundle, opts = {}) {
  const forceChunked = !!opts.forceChunked;
  const threshold =
    opts.thresholdChars !== undefined ? opts.thresholdChars : chunkThresholdChars();
  const safetyFraction =
    opts.safetyFraction !== undefined ? opts.safetyFraction : chunkSafetyFraction();

  // A single-segment bundle (a small plain-text file, an epub with one section)
  // has no chapter-by-chapter path to fall back to.
  if (
    !bundle ||
    (bundle.format !== "epub" && bundle.format !== "text") ||
    !Array.isArray(bundle.segments) ||
    bundle.segments.length < 2
  ) {
    return {
      chunked: false,
      basis: "characters",
      reason: "single-segment source — there is no chapter-by-chapter path",
      sourceTokens: bundleTokenEstimate(bundle),
      budget: null,
      usedFraction: null,
      sessionWarning: null,
    };
  }

  if (forceChunked) {
    return {
      chunked: true,
      basis: "characters",
      reason: "--chunked was passed",
      sourceTokens: bundleTokenEstimate(bundle),
      budget: null,
      usedFraction: null,
      sessionWarning: null,
    };
  }

  // SOURCE_CHUNK_THRESHOLD_CHARS=0 is the legacy "always chunk" override.
  if (threshold === 0) {
    return {
      chunked: true,
      basis: "characters",
      reason: "SOURCE_CHUNK_THRESHOLD_CHARS=0",
      sourceTokens: bundleTokenEstimate(bundle),
      budget: null,
      usedFraction: null,
      sessionWarning: null,
    };
  }

  const sourceTokens = bundleTokenEstimate(bundle);
  const roleWindow = opts.roleWindow || 0;

  if (sourceTokens === null || roleWindow <= 0) {
    // Not enough information for the token rule: fall back to the character
    // rule (shouldProcessChunked — the one implementation of it) rather than
    // inventing a budget. The reason says which half was missing, because "we
    // guessed" is the thing a reader of the run needs to know.
    const chunked = shouldProcessChunked(bundle, { thresholdChars: threshold });
    return {
      chunked,
      basis: "characters",
      reason:
        sourceTokens === null
          ? `no script mix recorded (bundle cached before schema 6) — used the legacy ${threshold}-character rule`
          : `no context window known for this stage — used the legacy ${threshold}-character rule`,
      sourceTokens,
      budget: null,
      usedFraction: null,
      sessionWarning: null,
    };
  }

  const { budget } = tokenBudgetForBundle(opts, safetyFraction);
  const usedFraction = budget > 0 ? sourceTokens / budget : 1;
  const chunked = sourceTokens > budget;

  // The constraint the window arithmetic cannot see: in whole mode the author
  // agent reads the WHOLE volume through one readFile call, and that text then
  // sits in its own session alongside the system prompt, the previous volume's
  // cumulative reference and the file it writes. A session that grows past the
  // server's window is compacted — lossily. Reporting it is the point: it is the
  // thing to watch as the cumulative references accumulate, and a silent pass is
  // how it would first show up as a worse artifact rather than a failure.
  let sessionWarning = null;
  if (!chunked && sourceTokens > roleWindow * 0.5) {
    sessionWarning =
      `the whole volume is ${Math.round((sourceTokens / roleWindow) * 100)}% of the model's window on its ` +
      `own, before the agent's own reads and writes — watch for session compaction in this volume`;
  }

  return {
    chunked,
    basis: "tokens",
    reason: chunked
      ? `whole installment is ${sourceTokens.toLocaleString()} tokens against a ${budget.toLocaleString()}-token allowance`
      : `whole installment is ${sourceTokens.toLocaleString()} tokens against a ${budget.toLocaleString()}-token allowance`,
    sourceTokens,
    budget,
    usedFraction,
    sessionWarning,
  };
}


/** Shared budget arithmetic for planProcessingMode. */
function tokenBudgetForBundle(opts, safetyFraction) {
  return tokens.tokenBudgetFor({
    roleWindow: opts.roleWindow || 0,
    outputReserve: opts.outputReserve || 0,
    referenceTokens: opts.referenceTokens || 0,
    promptTokens: opts.promptTokens || 0,
    safetyFraction,
  });
}


/**
 * The whole decision, end to end, for one volume of one stage: calibrate the
 * estimate against the model this stage is about to run on, measure the reference
 * material this stage injects, and decide whole-installment vs chapter-by-
 * chapter — then SAY the decision and its numbers.
 *
 * Shared by the four volume tasks so they cannot drift into four slightly
 * different size rules, and so the numbers behind a mode choice are in the run
 * log rather than inferable afterwards.
 *
 * @param {{
 *   bundle: SourceBundle,
 *   label: string,
 *   previousArtifactFiles?: string[],
 *   forceChunked?: boolean,
 *   dryRun?: boolean,
 *   role?: {contextWindow?: number|null, maxTokens?: number|null},
 * }} p
 * @returns {Promise<Object>} The planProcessingMode result, plus `referenceTokens`.
 */
async function decideProcessingMode({
  bundle,
  label,
  previousArtifactFiles = [],
  forceChunked = false,
  dryRun = false,
  role = {},
}) {
  // Calibrate first: the coefficients must describe the model this stage is
  // about to use, and the volume's own text is the sample (a representative
  // slice of the real book, not a synthetic one).
  const coefficients = await tokens.ensureTokenCalibration(tokens.globalEndpoint(), {
    sampleText: bundle && bundle.wholePath ? await fs.readFile(bundle.wholePath, "utf8") : "",
    label,
    dryRun,
  });

  // The reference material this stage injects: the previous volume's cumulative
  // artifact. It grows every volume, which is why this is measured per volume
  // rather than once per series.
  let referenceTokens = 0;
  let largestArtifactTokens = 0;
  for (const file of previousArtifactFiles) {
    if (!file) continue;
    try {
      const size = tokens.estimateMix(scriptMixOf(await fs.readFile(file, "utf8")), {
        includeOverhead: false,
      });
      referenceTokens += size;
      largestArtifactTokens = Math.max(largestArtifactTokens, size);
    } catch {
      // Missing (the first volume, or a skipped predecessor) — nothing to inject.
    }
  }

  const { roleWindow, outputReserve } = tokens.budgetFor(role);
  const plan = planProcessingMode(bundle, {
    roleWindow,
    outputReserve,
    referenceTokens,
    forceChunked,
  });
  plan.referenceTokens = referenceTokens;
  plan.coefficients = coefficients;

  const pct =
    plan.budget && plan.sourceTokens != null
      ? ` (${Math.round((plan.sourceTokens / plan.budget) * 100)}% of the allowance)`
      : "";
  console.log(
    `${label}: ${plan.chunked ? "chapter by chapter" : "whole installment"} — ` +
      `basis: ${plan.basis}; source ${plan.sourceTokens != null ? plan.sourceTokens.toLocaleString() + " tokens" : "tokens unavailable"} ` +
      `vs a ${plan.budget != null ? plan.budget.toLocaleString() + "-token allowance" : "no computable allowance"}` +
      `${plan.referenceTokens ? ` after ${plan.referenceTokens.toLocaleString()} tokens of injected reference` : ""}` +
      `${pct}. ${plan.reason}.`
  );
  if (plan.sessionWarning) console.warn(`${label}: ${plan.sessionWarning}.`);

  // The other half of the size question, and the one a window budget cannot see:
  // fitting the REQUEST is not the same as being able to GENERATE the answer.
  // A cumulative stage's answer is everything the previous volume's artifact
  // holds plus this volume's additions, and the output cap is the hard limit on
  // emitting it in one call. Reported, not acted on: chapter-by-chapter mode
  // does not repair it (a cumulative reference is still written whole at the
  // last chapter), so the honest response is the number and what to change.
  if (largestArtifactTokens > 0) {
    const answer = tokens.answerRoom({
      expectedTokens: largestArtifactTokens * tokens.artifactGrowthFactor(),
      outputReserve,
    });
    plan.answerRoom = answer;
    const pct = answer.outputCap > 0 ? Math.round((answer.guardedTokens / answer.outputCap) * 100) : 0;
    console.log(
      `${label}: the answer is expected to be about ${answer.expectedTokens.toLocaleString()} tokens ` +
        `(${pct}% of the ${answer.outputCap.toLocaleString()}-token output cap, measured from the previous ` +
        `volume's artifact × ${tokens.artifactGrowthFactor()}).`
    );
    if (!answer.fits) {
      console.warn(
        `${label}: that answer does not fit the output cap. Chapter-by-chapter processing does NOT fix it ` +
          `(a cumulative reference is still written whole at the final chapter) — raise AI_MAX_TOKENS / ` +
          `<PREFIX>_MAX_TOKENS, or expect the write to be cut off mid-document.`
      );
    }
  }

  return plan;
}

// ─── Chapter identification (pure) ──────────────────────────────────────────


module.exports = {
  chunkSafetyFraction,
  chunkThresholdChars,
  splitPlainTextSegments,
  shouldProcessChunked,
  bundleTokenEstimate,
  planProcessingMode,
  tokenBudgetForBundle,
  decideProcessingMode,
};
