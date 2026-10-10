/**
 * utils/reference-store/refusals.js — how this layer says no.
 *
 * Doc 03 §3.2 and §3.4 both state the rule, and it is the same rule `utils/tickets` and
 * `utils/patches` already follow: **a refusal that only says "not allowed" cannot be acted
 * on.** The caller — an agent in slice 7, or a human reading a report — has to be told
 * which rule fired, what the actual state is, and which verb IS available.
 *
 * So every refusal here is data with the same five parts:
 *
 *   `verb`     the operation that was refused
 *   `rule`     the stable name of the rule that refused it (a report can group on it)
 *   `because`  the state as this layer sees it, with the values that decided it
 *   `useInstead` the verb that WOULD work, named
 *   `fix`      the concrete edit that would make the call legal
 *
 * A refusal is returned, not thrown. A refused write is an ordinary outcome of an
 * ordinary call — an agent that mislabels a row must get an answer it can act on, not a
 * crashed turn — whereas a store that cannot be opened is not an outcome at all, and
 * `storeError` is thrown for that.
 *
 * @module utils/reference-store/refusals
 */

require("../../types"); // JSDoc type definitions

/**
 * Build one refusal.
 *
 * @param {Object} parts
 * @param {string} parts.verb - The operation that was refused.
 * @param {string} parts.rule - The stable rule name.
 * @param {string} parts.because - The state that caused the refusal, with its values.
 * @param {string[]} [parts.useInstead] - The verb(s) that are available instead.
 * @param {string} [parts.fix] - The concrete change that would make the call legal.
 * @param {Object} [parts.detail] - Machine-readable context (ids, owners, counts).
 * @returns {ReferenceRefusal}
 */
function refusal({ verb, rule, because, useInstead = [], fix = "", detail = {} }) {
  return { refused: true, verb, rule, because, useInstead, fix, detail };
}

/**
 * Render a refusal as the sentence a reader (or a model) gets back.
 *
 * @param {ReferenceRefusal} ref
 * @returns {string}
 */
function refusalText(ref) {
  if (!ref) return "refused";
  const parts = [`refused: ${ref.verb} — ${ref.because}`];
  if (ref.fix) parts.push(`to do this instead: ${ref.fix}`);
  if (ref.useInstead && ref.useInstead.length) {
    parts.push(`the verb that IS available here: ${ref.useInstead.join(", ")}`);
  }
  return parts.join(".\n");
}

/**
 * A store that cannot be opened, read, or written is not a refused call — it is a run
 * that cannot continue, and it fails loudly with the file it failed on.
 *
 * @param {string} message
 * @returns {Error}
 */
function storeError(message) {
  return new Error(`[reference-store] ${message}`);
}

/**
 * The refusal every guard that protects another volume's row shares.
 *
 * It names the row's REAL owner — the value the harness stamped, not the value the caller
 * claimed — and it names `challenge_fact`, because "you may not edit it" without "you may
 * contradict it" leaves a later volume with nowhere to put a correction (doc 03 §3.2).
 *
 * @param {Object} opts
 * @param {string} opts.verb
 * @param {Object} opts.row - The facts row that was targeted.
 * @param {{volume: number, stage: string}} opts.scope - The caller's write scope.
 * @param {string} opts.rule
 * @param {string} opts.because
 * @returns {ReferenceRefusal}
 */
function ownershipRefusal({ verb, row, scope, rule, because }) {
  return refusal({
    verb,
    rule,
    because,
    useInstead: ["challenge_fact"],
    fix:
      `insert your own fact with supersedes="${row.id}" (challenge_fact does this for you), ` +
      `or write to a row owned by volume ${scope.volume} stage "${scope.stage}".`,
    detail: {
      id: row.id,
      ownerVolume: row.owner_volume,
      ownerStage: row.owner_stage,
      sealed: row.sealed === 1,
      yourVolume: scope.volume,
      yourStage: scope.stage,
    },
  });
}

module.exports = { refusal, refusalText, storeError, ownershipRefusal };
