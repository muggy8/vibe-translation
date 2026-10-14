/**
 * utils/reference-store/facts/challenge.js — a dispute, from opening it to closing it.
 *
 * challengeFact contradicts a row this scope does NOT own by filing a row of its own;
 * listChallenges reads them back; resolveChallenge closes one as uphold or accept. The
 * status-only UPDATEs here are the deliberate exceptions to the ownership clause, and each one
 * carries the comment saying why — the whole point of the verb is to affect a row the caller
 * does not own, and the column list is what keeps that safe.
 *
 * currentClaimSql is the store's one answer to "is this row the record's current claim",
 * written in the module that owns challenges because voice-adapter.js, rebuild.js and pov-map.js
 * all have to ask it and a third answer to one question is how a published artifact starts
 * carrying a claim nobody adopted (gotcha 121).
 *
 * @module utils/reference-store/facts/challenge
 */

const { refusal } = require("../refusals");
const { getFact } = require("./read");
const { insertFact } = require("./insert");
require("../../../types"); // JSDoc type definitions

/**
 * Contradict a fact you do not own, without editing it.
 *
 * The verb ownership alone is missing (doc 03 §3.2): a later book that corrects an earlier
 * one has nowhere to go otherwise. It writes a row of its own — owned by this scope, with
 * its own verified evidence — marks the target `disputed`, and records the claim in
 * `challenges` so "who said this was wrong, and when" is answerable afterwards.
 *
 * **Supersession is a choice, not a side effect** (review 05 §3.5). `supersede: true` says
 * "this book replaces that one", and the challenger is filed against the target so the target
 * drops out of the guidance. The default is `false`: the challenger is filed with
 * `supersedes = null`, the target stays showable and marked `disputed`, and the translator sees
 * a **contested** claim rather than a silently replaced one. A challenge that automatically
 * replaced its target would make every disagreement a decision nobody made.
 *
 * Either way the challenge is open until someone closes it — see `resolveChallenge`.
 *
 * @param {{db: Object, scope: {volume: number, stage: string}, resolveVolume: Function}} ctx
 * @param {string} id - The fact being challenged.
 * @param {{reason: string, evidence: Array<Object>, body?: string, aspect?: string, label?: string, section?: string, key?: string|null, extractedAs?: string|null, supersede?: boolean}} proposal
 * @returns {{ok: boolean, fact: Object|null, target: Object|null, challengeId: number|null, supersede: boolean, refusal: ReferenceRefusal|null}}
 */
function challengeFact(ctx, id, proposal) {
  const target = getFact(ctx, id);
  if (!target) {
    return {
      ok: false,
      fact: null,
      target: null,
      challengeId: null,
      supersede: false,
      refusal: refusal({
        verb: "challenge_fact",
        rule: "unknown-fact",
        because: `there is no fact "${id}" to challenge.`,
      }),
    };
  }
  const reason = proposal && typeof proposal.reason === "string" ? proposal.reason.trim() : "";
  if (!reason) {
    return {
      ok: false,
      fact: null,
      target,
      challengeId: null,
      supersede: false,
      refusal: refusal({
        verb: "challenge_fact",
        rule: "challenge-needs-reason",
        because: "a challenge has to say what is wrong with the fact it answers.",
        fix: "challenge_fact(id, {reason, evidence}) — the evidence is the argument.",
      }),
    };
  }
  // `supersede` is read as a boolean and defaults to false. Anything that is not exactly
  // `true` means "contest it, do not replace it", so a caller that passes a truthy string
  // cannot accidentally make the stronger claim.
  const supersede = proposal.supersedes === true || proposal.supersede === true;

  // **The challenger's roster key defaults to the target's, and `key` says otherwise.** A challenge about
  // *what a claim says* belongs under the same character, and that used to be the only thing this verb
  // could file. A challenge about *who is speaking* is the case that cannot: its whole point is that the
  // claim belongs somewhere else — under another roster entry, or under none at all when the words are the
  // narrator's prose rather than anybody's speech. `key: null` files the challenger unattached, which is
  // the record's existing shape for a claim with no subject (migration 6), and `extractedAs` is what names
  // the answer afterwards. Omitting `key` keeps the old behaviour exactly.
  const key = proposal.key === undefined ? target.key : proposal.key === null ? null : String(proposal.key).trim() || null;
  const extractedAs =
    proposal.extractedAs === undefined ? (key === null ? target.extracted_as || null : null) : proposal.extractedAs;

  const inserted = insertFact(ctx, {
    key,
    extractedAs,
    aspect: proposal.aspect || target.aspect,
    label: proposal.label === undefined ? target.label : proposal.label,
    section: proposal.section === undefined ? target.section : proposal.section,
    body: proposal.body || `Challenges ${target.id}: ${reason}`,
    evidence: proposal.evidence,
    establishedVolume: ctx.scope.volume,
    appliesFromVolume: target.applies_from_volume,
    supersedes: supersede ? target.id : null,
  });
  if (!inserted.ok) {
    return { ok: false, fact: null, target, challengeId: null, supersede, refusal: inserted.refusal };
  }

  // **This UPDATE is deliberately unguarded, and that is the only place in this layer where
  // one is.** Everywhere else the rule lives in the WHERE clause — `owner_volume = ? AND
  // owner_stage = ? AND sealed = 0` — because a stage may only touch its own rows. Here the
  // whole point of the verb is to affect a row the caller does NOT own: flagging an earlier
  // volume's claim as disputed is the sanctioned consequence of a challenge (doc 03 §3.2).
  // What keeps it safe is the column list: it sets `status` and nothing else. Body, evidence,
  // key, aspect and owner are untouched, so the target's claim survives being disputed — which
  // is exactly what "contested, not replaced" has to mean. Do not add an ownership predicate
  // to this statement: it would make challenging another volume's fact impossible, which is
  // the reason this verb exists.
  ctx.db
    .prepare("UPDATE facts SET status = 'disputed', updated_at = ? WHERE id = ?")
    .run(new Date().toISOString(), target.id);

  const challenge = ctx.db
    .prepare(
      "INSERT INTO challenges (fact_id, challenger_id, reason, evidence, created_at) VALUES (?,?,?,?,?)"
    )
    .run(target.id, inserted.fact.id, reason, JSON.stringify(proposal.evidence || []), new Date().toISOString());

  return {
    ok: true,
    fact: inserted.fact,
    target: getFact(ctx, target.id),
    challengeId: Number(challenge.lastInsertRowid),
    supersede,
    refusal: null,
  };
}

/**
 * The challenges in this store, open ones first.
 *
 * The read that makes the open-disputes signal reachable: a count of rows with
 * `outcome IS NULL` is the number the pipeline wants to drive to zero, and without this verb
 * a challenge is something only the database knows about.
 *
 * @param {{db: Object}} ctx
 * @param {{openOnly?: boolean}} [opts] - Defaults to open only; pass `openOnly: false` for the whole history.
 * @returns {Array<Object>} `{id, fact_id, challenger_id, reason, created_at, outcome, resolved_at, resolved_by_volume, target_body, challenger_body}`
 */
function listChallenges(ctx, { openOnly = true } = {}) {
  const where = openOnly ? "WHERE c.outcome IS NULL" : "";
  return ctx.db
    .prepare(
      "SELECT c.*, t.body AS target_body, k.body AS challenger_body, t.status AS target_status, " +
        "k.status AS challenger_status, t.owner_volume AS target_owner_volume " +
        `FROM challenges c JOIN facts t ON t.id = c.fact_id JOIN facts k ON k.id = c.challenger_id ${where} ` +
        "ORDER BY c.outcome IS NOT NULL, c.id"
    )
    .all();
}

/**
 * The SQL predicate that says "this facts row is the record's current claim".
 *
 * Written once, in the module that owns `challenges` and the status vocabulary, because two renderers
 * (`voice-adapter.js` and `pov-map.js`) have to ask it and a third would be a third answer to one question.
 * It is the store's own `showable_facts` view plus one rule that view does not have:
 *
 *   - **not retracted** — a withdrawn claim is not published content;
 *   - **not superseded by a live row** — when a dispute is accepted, the row that replaced the old claim
 *     is the record's claim, and publishing both is publishing the argument rather than its outcome;
 *   - **not the challenger side of an open dispute** — this is the one the attribution feature needs. An
 *     answer to "who is speaking these words?" that names a different character files its challenger
 *     *under that character*. Without this clause the published reference grows a new bullet about
 *     somebody, written by a bounded reading pass that has no authority to add claims to the record. With
 *     it, the dispute stays where it belongs — in `challenges`, and in the audit report at HIGH — and the
 *     reference keeps saying what it says until `resolve_challenge` decides otherwise.
 *
 * A `disputed` row is **kept**: the record still claims it, and the dispute is reported separately. That
 * is what "a sealed row is never edited" costs, and it is paid on purpose.
 *
 * @param {string} alias - The alias the caller's query gives the `facts` table.
 * @returns {string} A SQL fragment to AND into a `FROM facts <alias>` query.
 */
function currentClaimSql(alias) {
  return (
    `${alias}.status <> 'retracted' AND ` +
    `NOT EXISTS (SELECT 1 FROM facts g WHERE g.supersedes = ${alias}.id AND g.status <> 'retracted') AND ` +
    `NOT EXISTS (SELECT 1 FROM challenges c WHERE c.challenger_id = ${alias}.id AND c.outcome IS NULL)`
  );
}

/**
 * Close a challenge (review 05 §3.5).
 *
 * A challenge that cannot be closed is a permanent warning nobody can clear, and the pipeline
 * already counts open disputes as a signal that has to be able to reach zero.
 *
 *   - `uphold` — the target stands. The challenger is retracted and the target's `disputed`
 *     mark is cleared, so the guidance goes back to what it was.
 *   - `accept` — the challenger stands. Its `supersedes` is set to the target (which is what
 *     removes the target from the guidance) and the target is marked `superseded`.
 *
 * Like `challenge_fact`, this changes **status and `supersedes` only**. It may act on a
 * challenge an earlier volume opened — judging a dispute is the current volume's job — but it
 * never edits the body or evidence of a row it does not own, and the resolution is attributed
 * to the volume and stage that made it.
 *
 * @param {{db: Object, scope: {volume: number, stage: string}}} ctx
 * @param {number|string} id - The `challenges.id`, or the challenger fact's id.
 * @param {"uphold"|"accept"} outcome
 * @returns {{ok: boolean, challenge: Object|null, outcome: string|null, refusal: ReferenceRefusal|null}}
 */
function resolveChallenge(ctx, id, outcome) {
  const wanted = String(id === undefined || id === null ? "" : id).trim();
  // Either identifier is accepted, because the one a caller has in hand depends on which verb
  // produced the dispute. The numeric lookup is only tried for something that IS a number, so a
  // fact id like `v02-…` cannot be coerced into NaN and matched against nothing.
  const asNumber = Number(wanted);
  const challenge =
    (Number.isSafeInteger(asNumber) ? ctx.db.prepare("SELECT * FROM challenges WHERE id = ?").get(asNumber) : null) ||
    ctx.db.prepare("SELECT * FROM challenges WHERE challenger_id = ?").get(wanted) ||
    null;
  if (!challenge) {
    return {
      ok: false,
      challenge: null,
      outcome: null,
      refusal: refusal({
        verb: "resolve_challenge",
        rule: "unknown-challenge",
        because: `there is no challenge "${wanted}" — pass the challenge id, or the challenger fact's id.`,
        fix: "list_challenges() answers both.",
      }),
    };
  }
  // The argument is checked before the state, because a malformed call should read as a
  // malformed call even when the challenge it names happens to be closed already.
  const outcomeValue = String(outcome || "").trim();
  if (outcomeValue !== "uphold" && outcomeValue !== "accept") {
    return {
      ok: false,
      challenge,
      outcome: null,
      refusal: refusal({
        verb: "resolve_challenge",
        rule: "challenge-outcome-unknown",
        because: `resolve_challenge(id, outcome) takes "uphold" or "accept"; got ${JSON.stringify(outcome)}.`,
      }),
    };
  }
  if (challenge.outcome !== null) {
    return {
      ok: false,
      challenge,
      outcome: challenge.outcome,
      refusal: refusal({
        verb: "resolve_challenge",
        rule: "challenge-already-resolved",
        because:
          `challenge ${challenge.id} was already resolved as "${challenge.outcome}" at ${challenge.resolved_at} ` +
          `(by volume ${challenge.resolved_by_volume}). A resolution is not re-decided; open a new challenge instead.`,
        useInstead: ["challenge_fact"],
      }),
    };
  }

  const target = getFact(ctx, challenge.fact_id);
  const challenger = getFact(ctx, challenge.challenger_id);
  if (!target || !challenger) {
    return {
      ok: false,
      challenge,
      outcome: null,
      refusal: refusal({
        verb: "resolve_challenge",
        rule: "challenge-row-missing",
        because:
          `challenge ${challenge.id} names a fact that is no longer in this store ` +
          `("${challenge.fact_id}" / "${challenge.challenger_id}"). A dispute is closed against a record, not a memory.`,
      }),
    };
  }

  const now = new Date().toISOString();
  ctx.db.exec("BEGIN");
  try {
    if (outcomeValue === "uphold") {
      // The challenger was wrong: it is retracted, so it stops being showable, and the target
      // is un-flagged. A retracted row is never deleted — the wrong claim stays auditable.
      ctx.db
        .prepare("UPDATE facts SET status = 'retracted', updated_at = ? WHERE id = ?")
        .run(now, challenger.id);
      if (target.status === "disputed") {
        ctx.db.prepare("UPDATE facts SET status = 'active', updated_at = ? WHERE id = ?").run(now, target.id);
      }
    } else {
      // The challenger was right: it now supersedes the target, which is the mechanism that
      // takes the target out of the guidance (the showable_facts view excludes a fact another
      // live fact supersedes).
      ctx.db
        .prepare("UPDATE facts SET supersedes = ?, status = 'active', updated_at = ? WHERE id = ?")
        .run(target.id, now, challenger.id);
      ctx.db.prepare("UPDATE facts SET status = 'superseded', updated_at = ? WHERE id = ?").run(now, target.id);
    }
    ctx.db
      .prepare("UPDATE challenges SET outcome = ?, resolved_at = ?, resolved_by_volume = ?, resolved_by_stage = ? WHERE id = ?")
      .run(outcomeValue, now, ctx.scope.volume, ctx.scope.stage, challenge.id);
    ctx.db.exec("COMMIT");
  } catch (err) {
    ctx.db.exec("ROLLBACK");
    throw err;
  }

  return {
    ok: true,
    challenge: ctx.db.prepare("SELECT * FROM challenges WHERE id = ?").get(challenge.id),
    outcome: outcomeValue,
    refusal: null,
  };
}

module.exports = {
  challengeFact,
  listChallenges,
  currentClaimSql,
  resolveChallenge,
};
