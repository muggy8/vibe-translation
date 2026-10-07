/**
 * utils/manager.js — the delivery manager's own decision, as one tool-less call.
 *
 * This is the only part of the delivery layer that needs a model, and the only part where
 * the "never sees the code" guarantee has to be a CAPABILITY rather than a sentence: the
 * call is runOneShot with no tools, because an agent handle WOULD be the code access this
 * role is defined by not having.
 *
 * Two claims this module refuses to take on faith: `end` (endIsProvable checks the triage's
 * verdict, open tickets, unjudged patches, and the deliverable's missing / unverified
 * counts, because "I think we are done" is the claim a loop would otherwise exit on) and an
 * unattended accept (safeToAcceptAutomatically, because in an unattended loop EVERY accept is
 * unattended).
 *
 * This file is the public face of the layer: apart from the declarations noted
 * below it holds no logic, only re-exports. The implementation lives in
 * ./manager/ — open the module that owns the behaviour you are changing
 * instead of reading all of them.
 */

require("../types"); // JSDoc type definitions

const __rules = require("./manager/rules");
const __brief = require("./manager/brief");
const __parse = require("./manager/parse");
const __gate = require("./manager/gate");
const __accept = require("./manager/accept");
const __decision = require("./manager/decision");

module.exports = {
  ...__rules,
  ...__brief,
  ...__parse,
  ...__gate,
  ...__accept,
  ...__decision,
};
