/**
 * The bound on investigations: how many questions one run may pay a diagnostics turn for, which ones it
 * may not pay for twice, and what it says about the ones it did not pay for.
 *
 * This is slice 3 of `utils/postmortem/plan/01-finding-levels.md` §5. Slice 2 built the batching — one
 * investigation per (finding kind, step), whatever number of volumes it fired in — and stopped before
 * the bound: nothing capped how many the run could act on, nothing consumed the list, and the ticket key
 * is per volume, so "has this already been asked?" could not be answered across volumes.
 *
 * **Why a ceiling at all, and why that number.** The assessment is free by design: 170 volume
 * assessments per full run cost under 100 ms and no model call. An investigation is the first part of
 * this layer that is not free. The one real diagnosis turn this repository measured ran **702 seconds,
 * 7.2M prompt tokens, 73 tool calls** (`docs/delivery-layer.md`), and the character-voice stage's whole
 * chapter-by-chapter reading pass for one volume is ~1.14M prompt tokens (measured on the real volume
 * 02). So:
 *
 *   - **one diagnosis turn ≈ six volumes' worth of reading** (7.2M ÷ 1.14M);
 *   - **three ≈ eighteen volumes ≈ the entire 17-book series read once** — enough to get an answer to
 *     the run's questions at a cost the run itself already pays;
 *   - **four ≈ twenty-three volumes — more than reading the whole series is worth**, which is the point
 *     where investigating costs more than the work it is investigating.
 *
 * Three is therefore the number at which the investigating half of this layer stops being cheaper than
 * the pipeline it audits. It is a **constant in a closed path with no environment knob** (`AGENTS.md`
 * rule 3): the ceiling exists to stop the layer spending money it cannot account for, and a ceiling the
 * spending role can raise is not a ceiling. `DELIVERY_MAX_INTERVENTIONS` is a different dial entirely —
 * it bounds **re-runs of one step** (a step run costs model calls on the pipeline's own work), this one
 * bounds **diagnostics turns** (a reading role opening the code to explain a finding). Neither substitutes
 * for the other: a step with four attempts left can still spend three diagnoses, and a step with none
 * left can still be explained by one.
 *
 * What the ceiling does NOT do is drop anything. A question it will not pay for is reported as
 * unanswered, with its name and its reason — the same shape `DETECTIVE_TOKEN_BUDGET` uses for the
 * attribution pass (gotcha 121): the run says "these were not paid for" rather than pretending they did
 * not exist.
 *
 * Part of the resume.js layer (split out of the original single file).
 */

const { PIPELINE_STEPS } = require("../../gulpfile");
const { investigationAnswerFrom } = require("../tickets");

/** @typedef {import("../postmortem/levels").FindingLevel} FindingLevel */

/**
 * The bound, as data. Frozen for the same reason `LEVEL_ROUTES` is: a number any module can reassign at
 * runtime is a dial whoever imports it can turn (`AGENTS.md` rule 3).
 *
 * @type {{maxPerRun: number, why: string}}
 */
const INVESTIGATION_BOUND = Object.freeze({
  maxPerRun: 3,
  why:
    "one real diagnosis turn measured 7.2M prompt tokens / 702 s / 73 tool calls; one volume's whole " +
    "reading pass is ~1.14M. Three answers cost about as much as reading the entire series once; a " +
    "fourth costs more than reading the series is worth.",
});

/**
 * The four states an investigation can be in, and what each one costs.
 *
 * `actionable` — nobody has asked it, the run has ceiling left, and acting on it means one diagnostics
 * turn. `answered` — a ticket for it already carries a diagnosis, so it costs 0 and does not touch the
 * ceiling. `pending` — somebody already asked it and nobody has answered it yet: no second ticket, no
 * second question, no turn spent, and no ceiling spent. `deferred` — nobody has asked it and the ceiling
 * is gone: reported as unanswered.
 *
 * @type {readonly string[]}
 */
const INVESTIGATION_STATUSES = Object.freeze(["actionable", "answered", "pending", "deferred"]);

/**
 * Which question gets a ceiling slot first.
 *
 * A step that HALTED is the more urgent question by construction: the pause exists precisely to get that
 * answer before the next volume is built on the broken thing (`utils/postmortem/halt.js`), and a batched
 * MINOR gap is the kind of question nothing downstream inherits. Within that, the level rank (STOP →
 * MAJOR → MINOR → NOTE) and then the pipeline's own step order, so two runs over the same state spend
 * their three slots on the same three questions instead of on whatever order the filesystem produced.
 *
 * @type {Record<string, number>}
 */
const ROUTE_RANK = Object.freeze({ "volume-halt": 0, "batched-minor": 1 });

/** @type {Record<FindingLevel, number>} */
const LEVEL_RANK = Object.freeze({ STOP: 0, MAJOR: 1, MINOR: 2, NOTE: 3 });

const STEP_ORDER = PIPELINE_STEPS.map((s) => s.name);

/**
 * One comparison, for the deterministic order the ceiling is spent in.
 * @param {Object} a
 * @param {Object} b
 * @returns {number}
 */
function investigationOrder(a, b) {
  const byRoute = (ROUTE_RANK[a.route] ?? 9) - (ROUTE_RANK[b.route] ?? 9);
  if (byRoute) return byRoute;
  const byLevel = (LEVEL_RANK[a.level] ?? 9) - (LEVEL_RANK[b.level] ?? 9);
  if (byLevel) return byLevel;
  const byStep = STEP_ORDER.indexOf(a.step) - STEP_ORDER.indexOf(b.step);
  if (byStep) return byStep;
  return String(a.kind).localeCompare(String(b.kind));
}

/**
 * Attach the ticket channel's answer and the ceiling to one investigation.
 *
 * The three questions are asked in this order, and the order is the whole design:
 *   1. **Is it already answered?** A ticket for this (step, kind) carries a diagnosis. It costs 0, it is
 *      not asked again, and it does NOT count against the ceiling — otherwise three answered questions
 *      would starve the one live question the run actually needs an answer to.
 *   2. **Is it already asked and unanswered?** A ticket exists. The run works that ticket; it does not
 *      open a second one and does not write a second version of the question. It also does not spend a
 *      ceiling slot, because the slot it would have spent is already spent on the open ticket.
 *   3. **Otherwise it is fresh**, and the ceiling decides: within `maxPerRun` it is actionable; past it
 *      it is deferred, named, and reported as not paid for.
 *
 * @param {Object} investigation - The batched entry, before the bound.
 * @param {{run: string|null, tickets: Object[]}} ctx - The run and the tickets the state already holds.
 * @returns {Object} The entry with `status`, `ticketId`, `ticketStatus`, `ticketRun`, `inRun`,
 *   `costsTurn`, `deferredBecause`. `inRun` says whether the ticket it points at belongs to the run
 *   being planned: an answer the series already paid for is still worth reading for free, and the plan
 *   says which run wrote it rather than implying this one did.
 */
function boundInvestigation(investigation, { run, tickets }) {
  const answer = investigationAnswerFrom(tickets, { run, step: investigation.step, kind: investigation.kind });
  if (answer.answered) {
    return {
      ...investigation,
      status: "answered",
      ticketId: answer.ticket ? answer.ticket.id : null,
      ticketStatus: answer.ticket ? answer.ticket.status : null,
      ticketRun: answer.ticket ? answer.ticket.run ?? null : null,
      inRun: answer.inRun,
      costsTurn: false,
      deferredBecause: null,
    };
  }
  if (answer.pending) {
    return {
      ...investigation,
      status: "pending",
      ticketId: answer.ticket ? answer.ticket.id : null,
      ticketStatus: answer.ticket ? answer.ticket.status : null,
      ticketRun: answer.ticket ? answer.ticket.run ?? null : null,
      inRun: answer.inRun,
      costsTurn: false,
      deferredBecause: null,
    };
  }
  return { ...investigation };
}

/**
 * Bound one run's investigations.
 *
 * @param {Object[]} investigations - The batched entries from `investigationsFor`, before the bound.
 * @param {{run?: string|null, tickets?: Object[]}} [ctx] - The run id and the tickets the state holds.
 *   The tickets arrive through the state snapshot for the reason gotcha 71 gives: `planResume` is a pure
 *   function of a state, and a bound that opened `tickets.json` itself would make a hand-built test state
 *   read the live series' correspondence.
 * @returns {{investigations: Object[], ceiling: {maxPerRun: number, why: string, total: number, actionable:
 *   number, answered: number, pending: number, deferred: number, run: string|null}}}
 */
function boundInvestigations(investigations, { run = null, tickets = [] } = {}) {
  const ordered = [...(investigations || [])].sort(investigationOrder);
  /** @type {Object[]} */
  const out = [];
  let freshUsed = 0;
  for (const raw of ordered) {
    const entry = boundInvestigation(raw, { run, tickets });
    if (entry.status === "answered" || entry.status === "pending") {
      out.push(entry);
      continue;
    }
    if (freshUsed < INVESTIGATION_BOUND.maxPerRun) {
      freshUsed += 1;
      out.push({
        ...entry,
        status: "actionable",
        ticketId: null,
        ticketStatus: null,
        ticketRun: null,
        inRun: false,
        costsTurn: true,
        deferredBecause: null,
      });
      continue;
    }
    out.push({
      ...entry,
      status: "deferred",
      ticketId: null,
      ticketStatus: null,
      ticketRun: null,
      inRun: false,
      costsTurn: false,
      deferredBecause:
        `this run investigates at most ${INVESTIGATION_BOUND.maxPerRun} question(s) and they are already ` +
        `taken (${INVESTIGATION_BOUND.why}) The question is reported, not answered.`,
    });
  }
  const count = (status) => out.filter((i) => i.status === status).length;
  return {
    investigations: out,
    ceiling: {
      maxPerRun: INVESTIGATION_BOUND.maxPerRun,
      why: INVESTIGATION_BOUND.why,
      total: out.length,
      actionable: count("actionable"),
      answered: count("answered"),
      pending: count("pending"),
      deferred: count("deferred"),
      run: run || null,
    },
  };
}

module.exports = {
  INVESTIGATION_BOUND,
  INVESTIGATION_STATUSES,
  investigationOrder,
  boundInvestigation,
  boundInvestigations,
};
