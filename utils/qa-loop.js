/**
 * utils/qa-loop.js — the validator → grader → feedback QA loop used by all four
 * volume tasks (glossary, character-voice, style-guide, jump-in-wiki).
 *
 * This file is the barrel; the code is in utils/qa-loop/:
 *   turn.js      — the one agent-turn protocol every QA stage uses (send the
 *                  turn, refuse a tool call emitted as text, rescue a missing
 *                  file from the chat reply, re-send the task once, refuse to
 *                  continue over a file that is still a stub)
 *   acceptance.js — the grading half of an iteration: the rolling window, the
 *                  per-iteration persistence, and the three ways out
 *   consensus.js — the two cheap acceptances (exceptional score, passing score)
 *   whole.js     — the whole-installment loop (one validator, one feedback pass)
 *   chunked.js   — the chapter-by-chapter loop (per-chapter validators, a
 *                  findings merge, per-chapter feedback)
 *   fallback.js  — the whole → chapter-by-chapter retry
 *
 * The loop is identical across tasks except for task-specific pieces, which are
 * injected via the config: which agents to open and what they say, the
 * acceptance check (each task's acceptanceCheck), and the log lines. Everything
 * else — fail-closed unparseable scores, the acceptance criterion, the
 * recovery-turn gating, the stalled-round detection and the ON_QA_LIMIT policy —
 * lives here so the four tasks cannot drift apart.
 *
 * Pure orchestration: no prompt building, no knowledge of any one artifact.
 */

const { runSharedQaLoop } = require("./qa-loop/whole");
const { runPerChapterQaLoop } = require("./qa-loop/chunked");
const { scoreAndConfirm } = require("./qa-loop/acceptance");
const { confirmExceptionalScore, confirmPassingScore } = require("./qa-loop/consensus");
const {
  runWriteTurn,
  runQaAgentStage,
  runAuthorStage,
  defaultRecoveryPrompt,
  validationReportRecoveryPrompt,
} = require("./qa-loop/turn");
const { runVolumeWithModeFallback } = require("./qa-loop/fallback");

module.exports = {
  runSharedQaLoop,
  runPerChapterQaLoop,
  scoreAndConfirm,
  confirmExceptionalScore,
  confirmPassingScore,
  runWriteTurn,
  runQaAgentStage,
  runAuthorStage,
  defaultRecoveryPrompt,
  validationReportRecoveryPrompt,
  runVolumeWithModeFallback,
};
