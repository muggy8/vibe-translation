/**
 *
 *
 * This file is the public face of the layer: apart from the declarations noted
 * below it holds no logic, only re-exports. The implementation lives in
 * ./resume/ — open the module that owns the behaviour you are changing
 * instead of reading all of them.
 */

const __menu = require("./resume/menu");
const __state = require("./resume/state");
const __plan = require("./resume/plan");
const __report = require("./resume/report");

module.exports = {
  ...__menu,
  ...__state,
  ...__plan,
  ...__report,
};
