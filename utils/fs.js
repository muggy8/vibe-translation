/**
 * utils/fs.js — Filesystem utility functions shared across the ai-client modules.
 *
 * The code lives in utils/fs/: exists.js (what a path is, and whether anything is behind
 * it), output-checks.js (never let a stage persist nothing), provenance.js (what a
 * published copy came from, and what a set of files currently is), stage.js (put a source
 * file into a volume folder without duplicating the book), wipe.js (remove what a failed
 * attempt left, and only that). This file is the public surface: every consumer requires
 * "utils/fs" and gets the same names it always did.
 *
 * @example
 * const { fileExists, assertWrote } = require("../utils/fs");
 */

const exists = require("./fs/exists");
const outputChecks = require("./fs/output-checks");
const provenance = require("./fs/provenance");
const stage = require("./fs/stage");
const wipe = require("./fs/wipe");

// The public surface, unchanged from the single file.
module.exports = {
  fileExists: exists.fileExists,
  shortcutTarget: exists.shortcutTarget,
  STUB_MARKER: outputChecks.STUB_MARKER,
  FALLBACK_MIN_CONTENT_CHARS: outputChecks.FALLBACK_MIN_CONTENT_CHARS,
  scaffoldStub: outputChecks.scaffoldStub,
  assertWrote: outputChecks.assertWrote,
  assertRealOutput: outputChecks.assertRealOutput,
  assertWroteWithFallback: outputChecks.assertWroteWithFallback,
  isPlaceholderContent: outputChecks.isPlaceholderContent,
  hasDocumentShape: outputChecks.hasDocumentShape,
  looksLikeArtifact: outputChecks.looksLikeArtifact,
  hasRealOutput: outputChecks.hasRealOutput,
  isPublishableArtifact: outputChecks.isPublishableArtifact,
  inlineReferenceMessage: provenance.inlineReferenceMessage,
  writeProvenanceSidecar: provenance.writeProvenanceSidecar,
  fingerprintFiles: provenance.fingerprintFiles,
  stageSourceFile: stage.stageSourceFile,
  wipeAttemptOutputs: wipe.wipeAttemptOutputs,
};
