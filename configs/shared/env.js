/**
 * configs/shared/env.js — the two readers every other knob is built from.
 *
 * One semantics for a boolean knob and one for a named-choice knob, so the
 * policies and the acceptance settings cannot disagree about what
 * "OFF" means. Nothing here knows about acceptance or policies: it is the
 * bottom of the stack and both of them stand on it.
 */

/**
 * Read a boolean env var with one consistent semantics: ON by default, OFF only
 * for an explicit falsy value. The two historical readers disagreed (the
 * harness treated any non-true/1 value as OFF, the stage helper treated only
 * "false" as OFF — so AI_THINKING=0 meant "off" in one place and "on" in the
 * other). This is the single reader both use now.
 *
 * @param {string} name - The env var name.
 * @param {boolean} [defaultValue=true] - The value when the var is absent/empty/unrecognized.
 * @returns {boolean}
 */
function readBoolEnv(name, defaultValue = true) {
  const v = process.env[name];
  if (v === undefined || v === "") return defaultValue;
  const s = String(v).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(s)) return true;
  if (["false", "0", "no", "off"].includes(s)) return false;
  return defaultValue;
}

// ── Named-choice knobs ───────────────────────────────────────────────────────
// The other kind of knob is a choice between named behaviours (ON_VOLUME_ERROR,
// ON_MISSING_PREVIOUS, ON_QA_LIMIT — declared in settings.js). They front-load
// decisions that would otherwise require a human during a long, un-monitored
// run, and every one of them defaults to the pre-knob behavior (fail loudly) so
// a typo in .env degrades to the safe default instead of crashing the run or,
// worse, silently continuing.

/**
 * Normalize a policy-style env var value to one of the allowed values.
 * Unknown/empty values fall back to the default (never throws, so a typo in
 * .env degrades to the safe default instead of crashing the run).
 *
 * @param {string | undefined} raw - The raw env value.
 * @param {string[]} allowed - The accepted values (compared case-insensitively).
 * @param {string} defaultValue - The value used when `raw` is absent/unknown.
 * @returns {string} One of `allowed` (or `defaultValue` when it is not).
 */
function normalizePolicy(raw, allowed, defaultValue) {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "") return defaultValue;
  return allowed.includes(v) ? v : defaultValue;
}

module.exports = { readBoolEnv, normalizePolicy };
