/**
 * utils/reference-store/facts/supersede.js — replacing a published row by status alone.
 *
 * markSuperseded is the narrow door onto another volume's row, narrow in three ways: the column
 * list is the guard, the supersession must already be attributed to a live successor row owned
 * by the volume and stage named, and the act is idempotent. supersededBy is the read the
 * renderers use instead of walking the supersedes links themselves.
 *
 * @module utils/reference-store/facts/supersede
 */

const { refusal } = require("../refusals");
const { getFact } = require("./read");
require("../../../types"); // JSDoc type definitions

/**
 * Mark a row this record holds as superseded — **status only**, and only when the record already holds
 * a live row that replaces it.
 *
 * `update_own_fact` cannot do this: its `WHERE … sealed = 0` is the guard that makes "a sealed row is
 * never edited" a fact rather than a policy, and the row being superseded is published. `challenge_fact`
 * does not do it either: it marks the target `disputed`, which is the right mark for a claim somebody
 * disagrees with and the wrong mark for a claim a later volume replaced. `resolve_challenge(…, "accept")`
 * does exactly this — sets `status = 'superseded'` and nothing else — but only as the closing half of a
 * dispute that was opened as a challenge, and a glossary revision is not a dispute about who is right:
 * it is a later volume's decision about a rendering, filed with its own evidence.
 *
 * So this is the narrow door, and it is narrow in three ways:
 *
 *   - **the column list is the guard.** `status` and `updated_at` and nothing else. Body, evidence,
 *     examples, key, aspect and owner are untouched, so the replaced row survives being replaced — which
 *     is what "the earlier decision is still in the record, and the render says so" has to mean.
 *   - **it refuses to act on an unattributed supersession.** A live row must already exist that
 *     `supersedes` this one AND is owned by the volume and stage named. That is the attribution: the act
 *     is not a timestamp and not a claim in a message, it is a row in the record that says which volume
 *     and which stage replaced which row. A caller that has not filed the replacement gets a refusal, so
 *     this verb can never mark a published row superseded out of nowhere.
 *   - **it is idempotent.** A row already marked `superseded` is reported as such and zero rows change.
 *
 * @param {{db: Object, scope: {volume: number, stage: string}}} ctx - The store the act is filed in.
 * @param {string} id - The row being replaced.
 * @param {{byVolume: number|string, byStage: string}} attribution - Who is doing it, which must match the
 *   successor row's own `owner_volume` / `owner_stage`.
 * @returns {{ok: boolean, changed: number, fact: Object|null, successor: Object|null, alreadySuperseded: boolean, refusal: ReferenceRefusal|null}}
 */
function markSuperseded(ctx, id, { byVolume, byStage } = {}) {
  const target = getFact(ctx, id);
  if (!target) {
    return {
      ok: false,
      changed: 0,
      fact: null,
      successor: null,
      alreadySuperseded: false,
      refusal: refusal({
        verb: "mark_superseded",
        rule: "unknown-fact",
        because: `there is no fact "${id}" to supersede.`,
      }),
    };
  }
  const volume = Number(byVolume);
  const stage = String(byStage || "").trim();
  if (!Number.isInteger(volume) || volume < 1 || !stage) {
    return {
      ok: false,
      changed: 0,
      fact: target,
      successor: null,
      alreadySuperseded: false,
      refusal: refusal({
        verb: "mark_superseded",
        rule: "supersede-needs-attribution",
        because:
          `markSuperseded(id, {byVolume, byStage}) names the volume and stage making the change, and got ` +
          `${JSON.stringify(byVolume)} / ${JSON.stringify(byStage)}. A published row is only replaced by an ` +
          "act somebody can be asked about.",
        fix: "pass the volume and stage the replacement row was filed under.",
      }),
    };
  }

  // The attribution IS the successor row. Asked before anything changes, so a supersession nobody filed
  // is a refusal rather than a status mark with no record behind it.
  const successor = ctx.db
    .prepare(
      "SELECT id, owner_volume, owner_stage, status FROM facts WHERE supersedes = ? AND status <> 'retracted' " +
        "AND owner_volume = ? AND owner_stage = ? ORDER BY ord, id"
    )
    .get(target.id, volume, stage);
  if (!successor) {
    return {
      ok: false,
      changed: 0,
      fact: target,
      successor: null,
      alreadySuperseded: false,
      refusal: refusal({
        verb: "mark_superseded",
        rule: "supersede-needs-a-successor",
        because:
          `no live row in this record supersedes "${target.id}" as volume ${volume} at stage "${stage}", so ` +
          "there is no act to attribute this to. A row is marked superseded by the replacement row that " +
          "supersedes it — file the replacement first.",
        useInstead: ["insert_fact", "challenge_fact"],
      }),
    };
  }
  if (target.status === "superseded") {
    return { ok: true, changed: 0, fact: target, successor, alreadySuperseded: true, refusal: null };
  }
  if (target.status === "retracted") {
    return {
      ok: false,
      changed: 0,
      fact: target,
      successor,
      alreadySuperseded: false,
      refusal: refusal({
        verb: "mark_superseded",
        rule: "supersede-a-retracted-fact",
        because:
          `"${target.id}" is already retracted. A withdrawn claim is not replaced; it stays withdrawn, and ` +
          "the row that withdrew it is already the record's answer.",
      }),
    };
  }

  // **This UPDATE is deliberately unguarded by ownership, and the column list is what keeps it safe** —
  // the same shape `challenge_fact` and `resolve_challenge` use, for the same reason: the whole point of
  // the verb is to affect a row the caller does NOT own, because a later volume replacing an earlier
  // volume's published row is the act that exists to happen. Adding an `owner_volume = ?` predicate here
  // would make it impossible, which is the reason this door exists.
  const now = new Date().toISOString();
  const result = ctx.db
    .prepare("UPDATE facts SET status = 'superseded', updated_at = ? WHERE id = ?")
    .run(now, target.id);
  return {
    ok: true,
    changed: result.changes,
    fact: getFact(ctx, target.id),
    successor,
    alreadySuperseded: false,
    refusal: null,
  };
}

/**
 * The rows one row was superseded by, oldest replacement first.
 *
 * The read the renderers need: "what did this term's row used to say, and from which volume?" is a
 * question about the chain, and a renderer that walked `supersedes` links itself would be a second
 * answer to it.
 *
 * @param {{db: Object}} ctx
 * @param {string} id - The row being replaced.
 * @returns {Array<Object>} The live rows whose `supersedes` points at this one, in filing order.
 */
function supersededBy(ctx, id) {
  return ctx.db
    .prepare(
      "SELECT * FROM facts WHERE supersedes = ? AND status <> 'retracted' ORDER BY applies_from_volume, ord, id"
    )
    .all(String(id === undefined || id === null ? "" : id));
}

module.exports = {
  markSuperseded,
  supersededBy,
};
