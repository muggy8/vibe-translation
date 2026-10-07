/**
 * configs/shared.js — the barrel for the run's shared configuration.
 *
 * The code lives in configs/shared/: env.js (the two knob readers),
 * failures.js (how a failure is classified), acceptance.js (the grading
 * contract), settings.js (the run's shape). This file is the public surface:
 * every consumer requires "configs/shared" and gets the same names it always
 * did, including the ones that used to be duplicated per task.
 *
 * It exists to break circular dependencies and eliminate duplication — both
 * glossary.js and jump-in-wiki.js import AGENT_TOOLS_NOTE from here so the
 * prompt-injection text lives in exactly one place.
 *
 * Reading order for a newcomer: settings.js first (what the operator controls),
 * then acceptance.js (what a grade means), then failures.js (what may be skipped
 * and what may not), then env.js (how a knob is read).
 */

const env = require("./shared/env");
const failures = require("./shared/failures");
const acceptance = require("./shared/acceptance");
const settings = require("./shared/settings");

module.exports = {
  ...env,
  ...failures,
  ...acceptance,
  ...settings,
};
