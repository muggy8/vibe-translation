/**
 * utils/artifacts/delivery.js — what the four delivery commands owe the folder a run remembers itself in.
 *
 * The other two spec files describe work the pipeline publishes into a series folder. These are the
 * records the delivery layer writes about its own decisions, and they all live in one place:
 * `<POSTMORTEM_DIR>/` — the plan of record, the ticket channel, the patch channel, the ledger, the run
 * lock. Until this file existed, none of them was declared anywhere, so the after-run check that
 * catches a half-built glossary asked nothing when a delivery command half-wrote its own records.
 * That is the asymmetry this closes: a pipeline step that fails is assessed and reaches the triage;
 * a delivery command that fails left a record nobody was going to look at.
 *
 * `run` is a third scope beside `volume` and `series`: expectations resolved against the run folder
 * rather than the corpus. It is only consulted for a step that declares it, so the nine pipeline
 * steps are assessed exactly as before.
 *
 * The `level` of an expectation here reads differently from the corpus half, and deliberately so.
 * A pipeline output is `required` because the step writes it on every path it can reach. A delivery
 * record is written on *some* paths — `--no-write`, `--open-ticket`, `--status` legitimately write
 * nothing — so the expectation is gated by a `when` predicate that asks the command what it claims it
 * did. `required` then means: **you said you wrote it, and it is not there.** That is the same rule
 * as rule 1 in utils/artifacts.js (never fire on healthy output), applied to a claim instead of a path.
 *
 * The cross-record questions — a patch naming a ticket that does not exist, a ticket marked answered
 * with no diagnosis behind it, a lock left by a process that is gone — are not file expectations and
 * do not belong in a table. They are in utils/delivery-audit.js, which asks them of every delivery
 * command regardless of which one wrote the file.
 */

/** @typedef {import("../artifacts").ArtifactExpectation} ArtifactExpectation */
/** @typedef {import("../artifacts").ArtifactContext} ArtifactContext */

// ─── `when` predicates ────────────────────────────────────────────────────────

/**
 * The command reported that it wrote the plan of record (`npm run delivery` on its normal path,
 * write allowed, exit 0). The verbs that answer one thing — a patch, a choice, a ticket — are
 * complete questions in themselves and legitimately write no plan, so they claim nothing here.
 * @param {ArtifactContext} ctx
 * @returns {boolean}
 */
function planRecordClaimed(ctx) {
  return Boolean(ctx.planRecordClaimed);
}

/**
 * The command reported that it wrote the ticket channel (`diagnose` answered a ticket, or `delivery`
 * opened one). Listing tickets reads the channel and writes nothing, so it claims nothing.
 * @param {ArtifactContext} ctx
 * @returns {boolean}
 */
function ticketRecordClaimed(ctx) {
  return Boolean(ctx.ticketRecordClaimed);
}

/**
 * The command reported that it wrote the patch channel (a dev turn produced a proposal, a patch was
 * judged, committed, or reverted). `--status` and `--show` read it and claim nothing.
 * @param {ArtifactContext} ctx
 * @returns {boolean}
 */
function patchRecordClaimed(ctx) {
  return Boolean(ctx.patchRecordClaimed);
}

// ─── The commands ─────────────────────────────────────────────────────────────

/**
 * The delivery layer's own commands. These are NOT gulp tasks and are deliberately not in
 * `TASKS` (utils/hooks.js says why: it would make `--stages=delivery` look runnable). They are
 * the names `package.json` exposes, and the names the after-run check files its report under.
 *
 * @type {string[]}
 */
const DELIVERY_COMMANDS = ["delivery", "diagnose", "fix", "autopilot"];

const DELIVERY_SPECS = {
  delivery: {
    step: "delivery",
    perVolume: false,
    volume: [],
    series: [],
    quarantines: [],
    run: [
      {
        name: "delivery-plan.md",
        level: "required",
        shape: "document",
        when: planRecordClaimed,
        why: "the triage's answer in the form a human reads — the only record of why this run " +
          "stopped where it stopped and what it proposed to do about it",
      },
      {
        name: "delivery-plan.json",
        level: "required",
        shape: "json",
        when: planRecordClaimed,
        why: "the same plan in the form the NEXT run reads. A plan the ledger cannot re-read is how " +
          "a run forgets what it already tried, which is the spin the ledger exists to prevent",
      },
    ],
  },

  diagnose: {
    step: "diagnose",
    perVolume: false,
    volume: [],
    series: [],
    quarantines: [],
    run: [
      {
        name: "tickets.json",
        level: "required",
        shape: "json",
        when: ticketRecordClaimed,
        why: "the answer lives ON the ticket. A diagnosis that exists only in the console is a " +
          "diagnosis the manager cannot act on and the next run cannot find",
      },
      {
        name: "tickets.md",
        level: "required",
        shape: "document",
        when: ticketRecordClaimed,
        why: "the half the account owner reads. It is re-rendered from the JSON on every write, so " +
          "its absence means the write did not finish",
      },
    ],
  },

  fix: {
    step: "fix",
    perVolume: false,
    volume: [],
    series: [],
    quarantines: [],
    run: [
      {
        name: "patches.json",
        level: "required",
        shape: "json",
        when: patchRecordClaimed,
        why: "the only record of code that changed in this repository on the pipeline's authority. " +
          "It is what `--verify` grades and what the manager accepts or rejects",
      },
      {
        name: "patches.md",
        level: "required",
        shape: "document",
        when: patchRecordClaimed,
        why: "the proposal as the account owner reads it: what it touches, what it could break, and " +
          "what the machine ran to prove it",
      },
    ],
  },

  autopilot: {
    step: "autopilot",
    perVolume: false,
    volume: [],
    series: [],
    quarantines: [],
    // The loop writes nothing itself: every move is the account owner's own command, run as its own
    // process (autopilot/commands.js), and each of those files its own record. Watch mode touches
    // nothing by design. So autopilot declares no file of its own and is assessed against the
    // channel it drove instead — which is what utils/delivery-audit.js asks of all four commands.
    run: [],
  },
};

module.exports = { DELIVERY_SPECS, DELIVERY_COMMANDS, planRecordClaimed, ticketRecordClaimed, patchRecordClaimed };
