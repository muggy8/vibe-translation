/**
 * utils/diagnostics.js — the read-only support team: the role that CAN see the code,
 * answering a ticket the delivery manager wrote, one model call per ticket.
 *
 * It is the mirror image of the manager's: it reads the code, the prompts and the .logs/
 * transcripts — the three things the manager may never see — and it may not write anywhere at
 * all. That guarantee is built TWICE: the tool set hands over only readFile / listFiles /
 * grep, and the composed approve gate denies every mutating call AND records each refusal.
 * Both layers are needed, and the record is the hard part: when the tool set is what refuses,
 * the gate is never consulted at all, so a naive `writeAttempts: gate.refusals` reports "the
 * team did not try" for the common case where it tried and the tool set said no.
 *
 * What it may not do is decide. It offers options and says which it recommends; the manager
 * chooses among the ones the filter allowed, and only the account owner may un-check a guard.
 *
 * This file is the public face of the layer: apart from the declarations noted
 * below it holds no logic, only re-exports. The implementation lives in
 * ./diagnostics/ — open the module that owns the behaviour you are changing
 * instead of reading all of them.
 */

const __contract = require("./diagnostics/contract");
const __tools = require("./diagnostics/tools");
const __brief = require("./diagnostics/brief");
const __shape = require("./diagnostics/shape");
const __reading = require("./diagnostics/reading");
const __turn = require("./diagnostics/turn");
const __render = require("./diagnostics/render");

module.exports = {
  ...__contract,
  ...__tools,
  ...__brief,
  ...__shape,
  ...__reading,
  ...__turn,
  ...__render,
};
