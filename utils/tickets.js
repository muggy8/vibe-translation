/**
 *
 *
 * This file is the public face of the layer: apart from the declarations noted
 * below it holds no logic, only re-exports. The implementation lives in
 * ./tickets/ — open the module that owns the behaviour you are changing
 * instead of reading all of them.
 */

const __settings = require("./tickets/settings");
const __banned_options = require("./tickets/banned-options");
const __manager_eyes = require("./tickets/manager-eyes");
const __shape = require("./tickets/shape");
const __record = require("./tickets/record");
const __render = require("./tickets/render");

module.exports = {
  ...__settings,
  ...__banned_options,
  ...__manager_eyes,
  ...__shape,
  ...__record,
  ...__render,
  renderTicketsMarkdown: (tickets) => __render.renderTicketsMarkdown(tickets === undefined ? __record.readTickets().tickets : tickets),
};
