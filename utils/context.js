/**
 * utils/context.js — the delivery layer's working memory: the two ideas that let a turn be
 * uncapped without losing what it read (AGENTS.md gotcha 78).
 *
 * OFFLOAD moves the bulky results of earlier lookups to a folder on disk, leaving a map in
 * the conversation so the agent knows what it saw and where the text went. RECALL is plain
 * case-insensitive search over what THIS turn moved, returning the text verbatim.
 *
 * The load-bearing piece is not the tools, it is the PRESSURE LINE stamped on every tool
 * result: the paper this design came from (arXiv:2607.23809) measured a model calling tools
 * like these about ZERO times unless it is told to. A memory tool the agent is never prompted
 * to reach for is a memory tool that does not exist.
 *
 * Pipeline stage agents are deliberately NOT in CONTEXT_MANAGED_ROLES: their whole job is to
 * hold the artifact they are amending and the text they are amending in front of them at the
 * same time, and handing them manage_context would let them set aside the very text they are
 * required to preserve — gotcha 64 rebuilt out of good intentions.
 *
 * This file is the public face of the layer: apart from the declarations noted
 * below it holds no logic, only re-exports. The implementation lives in
 * ./context/ — open the module that owns the behaviour you are changing
 * instead of reading all of them.
 */

const __limits = require("./context/limits");
const __measure = require("./context/measure");
const __pressure = require("./context/pressure");
const __offload = require("./context/offload");
const __recall = require("./context/recall");
const __tools = require("./context/tools");

module.exports = {
  ...__limits,
  ...__measure,
  ...__pressure,
  ...__offload,
  ...__recall,
  ...__tools,
};
